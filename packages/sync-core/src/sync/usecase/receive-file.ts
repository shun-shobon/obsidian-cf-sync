import { conflictPath, digest } from "@cf-sync/protocol";
import type { FileRecord } from "@cf-sync/protocol";
import { fromUint8Array, toUint8Array } from "js-base64";
import * as Y from "yjs";

import { t } from "../../i18n";
import { documentKey, incomingKey } from "../domain/storage-keys";
import type { LocalFile } from "../domain/sync-state";
import type { RestApiPort } from "../ports/api-port";
import type { StoredData } from "../ports/sync-store";
import type { VaultPort } from "../ports/vault-port";
import type { BorrowedDoc, Documents } from "../service/documents";
import { adoptReceived } from "../service/snapshot-state";
import type { SyncState } from "../service/sync-state";
import type { LocalChanges } from "./local-changes";

const encoder = new TextEncoder();

export interface FetchedFile {
	file: FileRecord;
	content: { kind: "text"; update: string } | { kind: "blob"; bytes: Uint8Array };
}

interface DiskFile {
	bytes: Uint8Array;
	digest: string;
}

interface PreparedContent {
	bytes: Uint8Array;
	digest: string;
	update: string | null;
	borrowed: BorrowedDoc | undefined;
}

export class ReceiveFile {
	constructor(
		private readonly state: SyncState,
		private readonly vault: VaultPort,
		private readonly api: RestApiPort,
		private readonly documents: Documents,
		private readonly changes: LocalChanges,
	) {}

	async fetch(fileId: string): Promise<FetchedFile> {
		const document = await this.api.document(fileId);

		if (document.content.kind === "text") {
			return { file: document.file, content: document.content };
		}

		const bytes = await this.api.download(document.content.blob);

		return { file: document.file, content: { kind: "blob", bytes } };
	}

	async run(fetched: FetchedFile): Promise<boolean> {
		const remote = fetched.file;
		const existing = this.state.data.files.find((file) => file.id === remote.id);

		if (adoptReceived(existing, remote)) {
			return true;
		}

		const disk = await this.readDisk(existing?.path ?? remote.path);

		if (await this.captureLocalChange(existing, remote, disk)) {
			return false;
		}

		const local = existing ?? { ...remote, diskDigest: remote.digest, documentRevision: 0 };
		const content = await this.prepareContent(local, fetched);
		if (!content) {
			return false;
		}

		const occupied = await this.preparePath(local, remote);
		let expected = disk;
		if (occupied) {
			expected = undefined;
		}

		await this.saveIncoming(remote, content, expected);

		const written = await this.vault.writeIfUnchanged(remote.path, expected?.bytes, content.bytes);
		if (!written) {
			await this.captureInterruptedWrite(existing, remote, content);

			return false;
		}

		await this.commitReceived(existing, local, fetched, content);
		content.borrowed?.release();

		return true;
	}

	private async readDisk(path: string): Promise<DiskFile | undefined> {
		if (!(await this.vault.exists(path))) {
			return undefined;
		}

		const bytes = await this.vault.read(path);

		return { bytes, digest: await digest(bytes) };
	}

	private async captureLocalChange(
		local: LocalFile | undefined,
		remote: FileRecord,
		disk: DiskFile | undefined,
	): Promise<boolean> {
		if (!disk) {
			if (!local) {
				return false;
			}

			await this.changes.delete(local.path);

			return true;
		}

		const baseline = local ?? remote;
		if (disk.digest === baseline.digest) {
			return false;
		}

		await this.changes.capture(baseline.path);

		return true;
	}

	private async prepareContent(
		local: LocalFile,
		fetched: FetchedFile,
	): Promise<PreparedContent | undefined> {
		if (fetched.content.kind === "blob") {
			const bytes = fetched.content.bytes;

			return { bytes, digest: await digest(bytes), update: null, borrowed: undefined };
		}

		const borrowed = await this.documents.borrow(local);
		const staged = new Y.Doc();
		Y.applyUpdate(staged, Y.encodeStateAsUpdate(borrowed.doc));
		Y.applyUpdate(staged, toUint8Array(fetched.content.update));

		if (staged.store.pendingStructs || staged.store.pendingDs) {
			staged.destroy();
			borrowed.release();

			return undefined;
		}

		const bytes = encoder.encode(staged.getText("content").toString());
		const update = fromUint8Array(Y.encodeStateAsUpdate(staged));
		staged.destroy();

		return { bytes, digest: await digest(bytes), update, borrowed };
	}

	private async preparePath(local: LocalFile, remote: FileRecord): Promise<boolean> {
		let occupant = this.state.data.files.find((file) => file.path === remote.path);
		if (occupant?.id === local.id) {
			occupant = undefined;
		}

		if (occupant && (await this.vault.exists(remote.path))) {
			await this.protectOccupant(occupant, remote.path);
		}

		const needsMove = local.path !== remote.path && (await this.vault.exists(local.path));
		if (needsMove) {
			await this.vault.rename(local.path, remote.path);
		}

		return occupant !== undefined;
	}

	private async protectOccupant(occupant: LocalFile, path: string): Promise<void> {
		const protectedPath = conflictPath(path, crypto.randomUUID());
		await this.vault.rename(path, protectedPath);
		occupant.path = protectedPath;

		for (const pending of this.state.data.pending) {
			if (pending.fileId === occupant.id && "path" in pending) {
				pending.path = protectedPath;
			}
		}
	}

	private async saveIncoming(
		remote: FileRecord,
		content: PreparedContent,
		expected: DiskFile | undefined,
	): Promise<void> {
		this.state.data.incoming = {
			file: remote,
			digest: content.digest,
			expectedDigest: expected?.digest ?? null,
			update: content.update,
		};
		await this.state.persist({ key: incomingKey, value: content.bytes });
	}

	private async captureInterruptedWrite(
		existing: LocalFile | undefined,
		remote: FileRecord,
		content: PreparedContent,
	): Promise<void> {
		await this.state.clearIncoming();
		content.borrowed?.release();
		// The staged remote state was never applied; capture against the unchanged baseline.
		if (existing) {
			existing.path = remote.path;
		}

		await this.changes.capture(remote.path);
	}

	private async commitReceived(
		existing: LocalFile | undefined,
		local: LocalFile,
		fetched: FetchedFile,
		content: PreparedContent,
	): Promise<void> {
		const remote = fetched.file;
		if (!existing) {
			this.state.data.files.push(local);
		}

		const doc = content.borrowed?.doc;
		if (doc && fetched.content.kind === "text") {
			Y.applyUpdate(doc, toUint8Array(fetched.content.update), "remote");
		}

		Object.assign(local, remote, {
			digest: content.digest,
			diskDigest: content.digest,
			documentRevision: remote.revision,
		});
		if (remote.conflict) {
			this.state.reportConflict(
				remote,
				t(($) => $.sync.conflictReceived),
			);
		}

		let receivedData: StoredData | undefined;
		if (doc) {
			receivedData = { key: documentKey(local.id), value: Y.encodeStateAsUpdate(doc) };
		}

		await this.state.clearIncoming(receivedData);
	}
}
