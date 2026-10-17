import { isExcluded } from "@cf-sync/protocol";

import { FLUSH_INTERVAL_MS } from "../domain/vault-state";
import type { StoredFile, VaultMeta } from "../domain/vault-state";
import type { R2VaultArchive } from "../infra/r2-vault-archive";
import type { VaultMaintenance } from "../infra/vault-maintenance";
import type { VaultRepository } from "../infra/vault-repository";
import type { VaultSockets } from "../infra/vault-sockets";

interface FlushSnapshot {
	meta: VaultMeta;
	files: StoredFile[];
	paths: string[];
	writes: StoredFile[];
}

export class FlushVault {
	constructor(
		private readonly repository: VaultRepository,
		private readonly sockets: VaultSockets,
		private readonly archive: R2VaultArchive,
		private readonly maintenance: VaultMaintenance,
		private readonly serial: <T>(action: () => Promise<T>) => Promise<T>,
	) {}

	async execute(): Promise<void> {
		try {
			const snapshot = await this.serial(() => this.takeSnapshot());

			if (snapshot) {
				await this.flush(snapshot);
			}

			await this.serial(async () => {
				await this.collectBlobsIfDue();
				await this.maintenance.schedule();
			});
		} catch (error) {
			// Not rethrown: runtime alarm retries stop after six attempts and would race the alarm set by retry().
			console.error({ event: "vault.maintenance.failed", error: errorMessage(error) });
			await this.serial(() => this.maintenance.retry());
		}
	}

	private async takeSnapshot(): Promise<FlushSnapshot | null> {
		await this.sockets.expire();

		if (!(await this.maintenance.due("flush"))) {
			return null;
		}

		const meta = await this.repository.meta();
		const files = await this.repository.files();
		const paths = await this.repository.dirtyPaths();
		const writes: StoredFile[] = [];

		for (const path of paths) {
			const stored = files.find((item) => item.file.path === path);

			if (stored && !isExcluded(path, meta.exclusions)) {
				writes.push(stored);
			}
		}

		return { meta, files, paths, writes };
	}

	private async flush(snapshot: FlushSnapshot): Promise<void> {
		const written = await this.writeFiles(snapshot.meta, snapshot.writes);

		if (written) {
			await this.deleteFiles(snapshot.meta, snapshot.files, snapshot.paths);
		}

		await this.serial(() => this.finish(snapshot, written));
	}

	private async finish(snapshot: FlushSnapshot, written: boolean): Promise<void> {
		const { revision } = snapshot.meta;

		if (written) {
			await this.repository.markFlushed(revision, snapshot.paths);
			this.sockets.broadcast({ type: "r2", revision });
		}

		const latest = await this.repository.meta();

		if (written && latest.revision === revision) {
			await this.maintenance.complete("flush", null);
			return;
		}

		await this.maintenance.complete("flush", Date.now() + FLUSH_INTERVAL_MS);
	}

	private async writeFiles(meta: VaultMeta, writes: StoredFile[]): Promise<boolean> {
		for (const stored of writes) {
			const content = await this.serial(async () => {
				const current = await this.repository.findFile(stored.file.id);

				if (!current || current.file.revision !== stored.file.revision) {
					return null;
				}

				return await this.repository.content(current);
			});

			if (!content) {
				return false;
			}

			await this.archive.write(meta.vaultId, stored.file.path, content);
		}

		return true;
	}

	private async collectBlobsIfDue(): Promise<void> {
		if (!(await this.maintenance.due("blobs"))) {
			return;
		}

		const meta = await this.repository.meta();
		const files = await this.repository.files();
		const referenced = new Set<string>();

		for (const item of files) {
			if ("blob" in item) {
				referenced.add(item.blob.key);
			}
		}

		const nextExpiry = await this.archive.collectUnreferenced(meta.vaultId, referenced);
		await this.maintenance.complete("blobs", nextExpiry);
	}

	private async deleteFiles(meta: VaultMeta, files: StoredFile[], paths: string[]): Promise<void> {
		for (const path of paths) {
			const exists = files.some((item) => item.file.path === path);
			const excluded = isExcluded(path, meta.exclusions);

			if (!exists && !excluded) {
				await this.archive.delete(meta.vaultId, path);
			}
		}
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
