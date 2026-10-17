import type { FileRecord, Snapshot } from "@cf-sync/protocol";
import type * as Y from "yjs";

import type { LocalFile, SyncStatus } from "../domain/sync-state";
import { Documents } from "../service/documents";
import { SyncState } from "../service/sync-state";
import { LocalChanges } from "./local-changes";
import { ReceiveFile } from "./receive-file";
import { ReconcileVault } from "./reconcile-vault";
import { RecoverIncoming } from "./recover-incoming";
import type { SyncOnceOptions } from "./sync-once-options";

export interface SyncSessionHooks {
	onStatus: (status: SyncStatus) => void;
	onConflict: (file: FileRecord, message: string) => void;
	onEdit: (file: LocalFile, doc: Y.Doc) => void;
	onRemap: (doc: Y.Doc, fileId: string) => void;
	onQueued: () => void;
	confirmInitial: (paths: string[]) => Promise<boolean>;
}

/** Hooks for a single HTTP run, which has no editor and reports failures from `run()` itself. */
export function batchHooks(conflicts: FileRecord[]): SyncSessionHooks {
	return {
		onStatus: () => {},
		onConflict: (file) => conflicts.push(file),
		onEdit: () => {},
		onRemap: () => {},
		onQueued: () => {},
		confirmInitial: () => Promise.resolve(true),
	};
}

export class SyncSession {
	readonly state: SyncState;
	readonly documents: Documents;
	readonly changes: LocalChanges;
	readonly receive: ReceiveFile;
	readonly reconcile: ReconcileVault;
	readonly recovery: RecoverIncoming;
	private serial: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly options: SyncOnceOptions,
		hooks: SyncSessionHooks,
	) {
		const { vault, store, api } = options;

		this.state = new SyncState(store, hooks.onStatus, hooks.onConflict);
		this.documents = new Documents(store, hooks.onEdit, hooks.onRemap);
		this.changes = new LocalChanges(this.state, vault, this.documents, hooks.onQueued);
		this.receive = new ReceiveFile(this.state, vault, api, this.documents, this.changes);
		this.reconcile = new ReconcileVault(
			this.state,
			vault,
			this.documents,
			this.changes,
			this.receive,
			(work) => this.enqueue(work),
			hooks.confirmInitial,
		);
		this.recovery = new RecoverIncoming(this.state, vault, this.documents, this.changes);
	}

	enqueue<T>(work: () => T | Promise<T>): Promise<T> {
		const result = this.serial.then(work);
		// The caller receives the failure; later work must still run.
		this.serial = result.catch(() => {});

		return result;
	}

	idle(): Promise<unknown> {
		return this.serial;
	}

	/** Recovery must run before scanning so an interrupted incoming write is not captured as a local edit. */
	async recoverLocalChanges(): Promise<void> {
		await this.recovery.run();
		await this.changes.scan();
	}

	async prepare(): Promise<Snapshot> {
		await this.state.load();

		const snapshot = await this.options.api.snapshot();
		// The scan below must already skip paths excluded on the server.
		this.state.data.exclusions = snapshot.exclusions;

		await this.recoverLocalChanges();
		await this.reconcile.initialize(snapshot);

		return snapshot;
	}

	dispose(): void {
		this.documents.dispose();
	}
}
