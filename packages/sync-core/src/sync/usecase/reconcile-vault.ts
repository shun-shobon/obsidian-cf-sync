import { digest, isExcluded } from "@cf-sync/protocol";
import type { FileRecord, Snapshot } from "@cf-sync/protocol";

import { documentKey } from "../domain/storage-keys";
import type { LocalFile } from "../domain/sync-state";
import type { VaultPort } from "../ports/vault-port";
import type { Documents } from "../service/documents";
import { adoptReceived } from "../service/snapshot-state";
import type { SyncState } from "../service/sync-state";
import type { LocalChanges } from "./local-changes";
import type { FetchedFile, ReceiveFile } from "./receive-file";

const encoder = new TextEncoder();

interface IdenticalFile {
	localId: string;
	remote: FileRecord;
}

interface InitialPlan {
	collisions: string[];
	identical: IdenticalFile[];
}

export class ReconcileVault {
	private readonly confirmedPaths = new Set<string>();

	constructor(
		private readonly state: SyncState,
		private readonly vault: VaultPort,
		private readonly documents: Documents,
		private readonly changes: LocalChanges,
		private readonly receive: ReceiveFile,
		private readonly serialize: <T>(work: () => T | Promise<T>) => Promise<T>,
		private readonly confirmInitial: (paths: string[]) => Promise<boolean>,
	) {}

	/**
	 * The confirmation and downloads run outside the state queue so editors and captures keep working,
	 * which means every queued step must recheck what it planned against the current state.
	 */
	async initialize(snapshot: Snapshot, isActive: () => boolean): Promise<boolean> {
		const plan = await this.serialize(() => this.planInitial(snapshot, isActive));
		if (plan === "initialized") {
			return true;
		}

		if (plan === "inactive" || !(await this.confirmCollisions(plan.collisions))) {
			return false;
		}

		for (const identical of plan.identical) {
			if (!isActive()) {
				return false;
			}

			const fetched = await this.receive.fetch(identical.remote.id);
			await this.serialize(() => this.adoptIdentical(identical, fetched, isActive));
		}

		return await this.serialize(async () => {
			if (!isActive()) {
				return false;
			}

			this.state.data.initialized = true;
			await this.state.persist();

			return true;
		});
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

	private planInitial(
		snapshot: Snapshot,
		isActive: () => boolean,
	): InitialPlan | "initialized" | "inactive" {
		if (!isActive()) {
			return "inactive";
		}

		this.state.data.exclusions = snapshot.exclusions;
		if (this.state.data.initialized) {
			return "initialized";
		}

		const remoteByPath = new Map(snapshot.files.map((file) => [file.path, file]));
		const plan: InitialPlan = { collisions: [], identical: [] };
		for (const local of this.state.data.files) {
			const remote = remoteByPath.get(local.path);
			// A file adopted by an interrupted earlier attempt already has the remote identity.
			if (!remote || remote.id === local.id) {
				continue;
			}

			if (remote.digest === local.digest) {
				plan.identical.push({ localId: local.id, remote });
			} else {
				plan.collisions.push(local.path);
			}
		}

		return plan;
	}

	private async confirmCollisions(paths: string[]): Promise<boolean> {
		// A reconnect while the dialog is open restarts initialization, which must not ask again.
		const unconfirmed = paths.filter((path) => !this.confirmedPaths.has(path));
		if (unconfirmed.length === 0) {
			return true;
		}

		const confirmed = await this.confirmInitial(paths);
		if (confirmed) {
			for (const path of paths) {
				this.confirmedPaths.add(path);
			}
		}

		return confirmed;
	}

	private async adoptIdentical(
		identical: IdenticalFile,
		fetched: FetchedFile,
		isActive: () => boolean,
	): Promise<void> {
		if (!isActive() || this.state.data.initialized) {
			return;
		}

		const local = this.state.data.files.find((file) => file.id === identical.localId);
		// A local file changed since planning is kept as a local change and preserved as a separate copy.
		if (!local || !(await this.isStillIdentical(local, identical.remote))) {
			return;
		}

		this.state.data.pending = this.state.data.pending.filter((op) => op.fileId !== local.id);
		this.state.data.files = this.state.data.files.filter((file) => file.id !== local.id);
		this.documents.remove(local.id);
		await this.receive.run(fetched);
	}

	private async isStillIdentical(local: LocalFile, remote: FileRecord): Promise<boolean> {
		if (local.path !== remote.path || local.digest !== remote.digest) {
			return false;
		}

		const deleting = this.state.data.pending.some(
			(op) => op.fileId === local.id && op.type === "delete",
		);
		if (deleting) {
			return false;
		}

		if (!this.documents.isRetained(local.id)) {
			return true;
		}

		// The editor's change may still wait in the queue behind this step.
		const text = this.documents.get(local.id)!.getText("content").toString();

		return (await digest(encoder.encode(text))) === remote.digest;
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
			// An editor's unsaved text is already in the document, so a lagging disk is not a local change.
			const inEditor = local.kind === "text" && this.documents.isRetained(local.id);
			if (!inEditor && (await this.hasDiskChange(local))) {
				await this.changes.capture(local.path);

				return;
			}

			await this.vault.remove(local.path);
		}

		this.state.data.files = this.state.data.files.filter((file) => file.id !== local.id);
		this.state.forgetConflict(local.id);
		this.documents.remove(local.id);
		await this.state.store.delete(documentKey(local.id));
	}

	private async hasDiskChange(local: LocalFile): Promise<boolean> {
		const bytes = await this.vault.read(local.path);

		return (await digest(bytes)) !== local.digest;
	}
}
