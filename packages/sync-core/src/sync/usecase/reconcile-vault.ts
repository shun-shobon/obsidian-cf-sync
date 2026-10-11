import { digest, isExcluded } from "@cf-sync/protocol";
import type { FileRecord, Snapshot } from "@cf-sync/protocol";

import { documentKey } from "../domain/storage-keys";
import type { LocalFile } from "../domain/sync-state";
import type { VaultPort } from "../ports/vault-port";
import type { Documents } from "../service/documents";
import { adoptReceived } from "../service/snapshot-state";
import type { SyncState } from "../service/sync-state";
import type { LocalChanges } from "./local-changes";
import type { ReceiveFile } from "./receive-file";

export class ReconcileVault {
	constructor(
		private readonly state: SyncState,
		private readonly vault: VaultPort,
		private readonly documents: Documents,
		private readonly changes: LocalChanges,
		private readonly receive: ReceiveFile,
		private readonly serialize: <T>(work: () => T | Promise<T>) => Promise<T>,
		private readonly confirmInitial: (paths: string[]) => Promise<boolean>,
	) {}

	async initialize(snapshot: Snapshot): Promise<boolean> {
		this.state.data.exclusions = snapshot.exclusions;
		if (this.state.data.initialized) {
			return true;
		}

		const remoteByPath = new Map(snapshot.files.map((file) => [file.path, file]));
		const collisions = this.state.data.files.filter((local) => {
			const remote = remoteByPath.get(local.path);

			return remote !== undefined && remote.digest !== local.digest;
		});
		if (collisions.length > 0) {
			const conflictingPaths = collisions.map((file) => file.path);
			const confirmed = await this.confirmInitial(conflictingPaths);
			if (!confirmed) {
				return false;
			}
		}

		for (const local of this.state.data.files) {
			const remote = remoteByPath.get(local.path);
			if (!remote || remote.digest !== local.digest) {
				continue;
			}

			this.state.data.pending = this.state.data.pending.filter((op) => op.fileId !== local.id);
			this.state.data.files = this.state.data.files.filter((file) => file.id !== local.id);
			this.documents.remove(local.id);
			await this.receive.run(await this.receive.fetch(remote.id));
		}

		this.state.data.initialized = true;
		await this.state.persist();

		return true;
	}

	async run(snapshot: Snapshot, isActive: () => boolean): Promise<void> {
		await this.serialize(() => {
			this.state.data.exclusions = snapshot.exclusions;
		});

		for (const remote of snapshot.files) {
			if (!isActive()) {
				return;
			}

			const needed = await this.serialize(() => this.needsFetch(remote, snapshot));
			if (!needed) {
				continue;
			}

			// Fetch attachments outside the state queue so active editors keep working.
			const fetched = await this.receive.fetch(remote.id);
			await this.serialize(async () => {
				if (!isActive() || this.hasPending(remote.id)) {
					return;
				}

				await this.receive.run(fetched);
			});
		}

		await this.serialize(async () => {
			if (!isActive()) {
				return;
			}

			await this.removeDeletedFiles(snapshot);
			this.state.data.revision = Math.max(this.state.data.revision, snapshot.revision);
			this.state.data.r2Revision = Math.max(this.state.data.r2Revision, snapshot.r2Revision);
			await this.state.persist();
		});
	}

	private needsFetch(remote: FileRecord, snapshot: Snapshot): boolean {
		if (isExcluded(remote.path, snapshot.exclusions) || this.hasPending(remote.id)) {
			return false;
		}

		const local = this.state.data.files.find((file) => file.id === remote.id);

		return !adoptReceived(local, remote);
	}

	private hasPending(fileId: string): boolean {
		return this.state.data.pending.some((op) => op.fileId === fileId);
	}

	private async removeDeletedFiles(snapshot: Snapshot): Promise<void> {
		const paths = new Set(await this.vault.list());
		const remoteIds = new Set(snapshot.files.map((file) => file.id));

		for (const local of this.state.data.files) {
			const existsRemotely = remoteIds.has(local.id);
			const excluded = isExcluded(local.path, snapshot.exclusions);
			// A socket update or acknowledgment may already be newer than this snapshot.
			const newerThanSnapshot = local.revision > snapshot.revision;
			if (existsRemotely || excluded || this.hasPending(local.id) || newerThanSnapshot) {
				continue;
			}

			await this.removeDeleted(local, paths);
		}
	}

	private async removeDeleted(local: LocalFile, paths: Set<string>): Promise<void> {
		if (paths.has(local.path)) {
			const diskBytes = await this.vault.read(local.path);
			const diskDigest = await digest(diskBytes);
			if (diskDigest !== local.digest) {
				await this.changes.capture(local.path);

				return;
			}

			await this.vault.remove(local.path);
		}

		this.state.data.files = this.state.data.files.filter((file) => file.id !== local.id);
		this.documents.remove(local.id);
		await this.state.store.delete(documentKey(local.id));
	}
}
