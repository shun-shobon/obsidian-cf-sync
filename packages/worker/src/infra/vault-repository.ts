import { isExcluded } from "@cf-sync/protocol";
import type { Content, OperationResult } from "@cf-sync/protocol";
import { fromUint8Array } from "js-base64";

import { ApplicationError } from "../domain/errors";
import { TEXT_CHUNK_SIZE } from "../domain/vault-state";
import type {
	FileWrite,
	OperationChanges,
	StoredFile,
	StoredTextFile,
	VaultMeta,
} from "../domain/vault-state";
import type { VaultMaintenance } from "./vault-maintenance";

type StorageReader = DurableObjectStorage | DurableObjectTransaction;

export class VaultRepository {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly maintenance: VaultMaintenance,
	) {}

	async initialize(vaultId: string): Promise<VaultMeta> {
		const existing = await this.storage.get<VaultMeta>("meta");

		if (existing !== undefined) {
			return existing;
		}

		const meta: VaultMeta = { revision: 0, r2Revision: 0, exclusions: [], vaultId };
		await this.storage.put("meta", meta);

		return meta;
	}

	async meta(storage: StorageReader = this.storage): Promise<VaultMeta> {
		const meta = await storage.get<VaultMeta>("meta");

		if (!meta) {
			throw new ApplicationError("not-found", "Vault not initialized");
		}

		return meta;
	}

	async files(storage: StorageReader = this.storage): Promise<StoredFile[]> {
		const files = await storage.list<StoredFile>({ prefix: "file:" });

		return [...files.values()];
	}

	findFile(id: string): Promise<StoredFile | undefined> {
		return this.storage.get<StoredFile>(`file:${id}`);
	}

	async file(id: string): Promise<StoredFile> {
		const stored = await this.findFile(id);

		if (!stored) {
			throw new ApplicationError("not-found", "File not found");
		}

		return stored;
	}

	async deletedTextUpdate(id: string): Promise<string | undefined> {
		const stored = await this.storage.get<StoredTextFile>(`deleted:${id}`);

		if (!stored) {
			return undefined;
		}

		return await this.textUpdate(stored);
	}

	operationResult(id: string): Promise<OperationResult | undefined> {
		return this.storage.get<OperationResult>(`op:${id}`);
	}

	saveOperationResult(result: OperationResult): Promise<void> {
		return this.storage.put(`op:${result.opId}`, result);
	}

	async content(stored: StoredFile): Promise<Content> {
		if ("blob" in stored) {
			return { kind: "blob", blob: stored.blob };
		}

		return { kind: "text", update: await this.textUpdate(stored) };
	}

	async textUpdate(stored: StoredTextFile): Promise<string> {
		const chunks = await Promise.all(
			Array.from({ length: stored.chunks }, async (_, index) => {
				const chunk = await this.storage.get<Uint8Array>(`text:${stored.file.id}:${index}`);

				if (!chunk) {
					throw new Error("Missing CRDT chunk");
				}

				return chunk;
			}),
		);
		const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
		let offset = 0;

		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}

		return fromUint8Array(bytes);
	}

	async setExclusions(meta: VaultMeta, exclusions: string[]): Promise<void> {
		meta.exclusions = [...new Set(exclusions)];
		meta.revision++;

		await this.storage.transaction(async (tx) => {
			await tx.put("meta", meta);
			await this.maintenance.request("flush", tx);

			for (const item of await this.files(tx)) {
				if (!isExcluded(item.file.path, exclusions)) {
					await tx.put(`dirty:${item.file.path}`, meta.revision);
				}
			}
		});
	}

	async commit(meta: VaultMeta, files: StoredFile[], changes: OperationChanges): Promise<void> {
		await this.storage.transaction(async (tx) => {
			await tx.put("meta", meta);
			await this.maintenance.request("flush", tx);

			if (changes.removed) {
				await this.deleteFile(tx, changes.removed);
			}

			for (const write of changes.writes) {
				await this.writeFile(tx, write, files);
			}

			for (const path of changes.dirty) {
				await tx.put(`dirty:${path}`, meta.revision);
			}

			await tx.put(`op:${changes.result.opId}`, changes.result);

			if (touchesBlobs(changes)) {
				await this.maintenance.request("blobs", tx);
			}
		});
	}

	async dirtyPaths(): Promise<string[]> {
		const paths = await this.storage.list<boolean>({ prefix: "dirty:" });

		return [...paths.keys()].map((key) => key.slice(6));
	}

	async markFlushed(revision: number, paths: string[]): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const latest = await this.meta(tx);
			await tx.put("meta", { ...latest, r2Revision: revision });

			for (const path of paths) {
				const dirtyRevision = await tx.get<number>(`dirty:${path}`);

				if (dirtyRevision !== undefined && dirtyRevision <= revision) {
					await tx.delete(`dirty:${path}`);
				}
			}
		});
	}

	private async deleteFile(tx: DurableObjectTransaction, stored: StoredFile): Promise<void> {
		await tx.delete(`file:${stored.file.id}`);

		if (!("blob" in stored)) {
			await tx.put(`deleted:${stored.file.id}`, stored);
		}
	}

	private async writeFile(
		tx: DurableObjectTransaction,
		{ stored, update }: FileWrite,
		files: StoredFile[],
	): Promise<void> {
		await tx.put(`file:${stored.file.id}`, stored);

		if (!update || "blob" in stored) {
			return;
		}

		for (let index = 0; index < stored.chunks; index++) {
			const start = index * TEXT_CHUNK_SIZE;
			const chunk = update.slice(start, start + TEXT_CHUNK_SIZE);

			await tx.put(`text:${stored.file.id}:${index}`, chunk);
		}

		const old = files.find((entry) => entry.file.id === stored.file.id);

		if (!old || "blob" in old) {
			return;
		}

		for (let index = stored.chunks; index < old.chunks; index++) {
			await tx.delete(`text:${stored.file.id}:${index}`);
		}
	}
}

function touchesBlobs(changes: OperationChanges): boolean {
	const removesBlob = changes.removed !== undefined && "blob" in changes.removed;
	const writesBlob = changes.writes.some(({ stored }) => "blob" in stored);

	return removesBlob || writesBlob;
}
