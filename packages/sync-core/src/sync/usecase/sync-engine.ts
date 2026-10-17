import { isExcluded } from "@cf-sync/protocol";
import type { ServerMessage } from "@cf-sync/protocol";
import type * as Y from "yjs";

import { ConnectionError } from "../../domain/connection-error";
import { DocumentNotFoundError } from "../../domain/document-not-found-error";
import type { LocalFile } from "../domain/sync-state";
import type { Documents } from "../service/documents";
import { isTextEdit } from "../service/pending-operations";
import { Presence } from "../service/presence";
import { SyncConnection } from "../service/sync-connection";
import { SyncScheduler } from "../service/sync-scheduler";
import type { SyncState } from "../service/sync-state";
import type { FetchedFile } from "./receive-file";
import { SendPending } from "./send-pending";
import type { SyncOptions } from "./sync-options";
import { SyncSession } from "./sync-session";

export class SyncEngine {
	private readonly session: SyncSession;
	private readonly sendPending: SendPending;
	private paused = false;
	private disposed = false;
	private readonly connection: SyncConnection;
	private stopped = false;
	private ready = false;
	private requestedReconcile = 0;
	private completedReconcile = 0;
	private synchronizing: Promise<void> | undefined;
	private syncGeneration = -1;
	private readonly incomingTasks = new Set<Promise<void>>();
	private readonly presence: Presence;
	private readonly scheduler = new SyncScheduler(() => {
		if (this.ready) {
			void this.flushPending();
			if (this.requestedReconcile > this.completedReconcile) {
				void this.syncNow();
			}
		} else {
			void this.syncNow();
		}
	});

	constructor(private readonly options: SyncOptions) {
		const { api } = options;
		this.connection = new SyncConnection(
			api,
			(message) => this.receive(message),
			(error) => this.failed(error),
		);
		this.presence = new Presence({
			deviceId: options.deviceId,
			name: options.deviceName,
			send: (message) => {
				try {
					this.connection.send(message);
				} catch (error) {
					this.failed(error);
				}
			},
		});
		this.session = new SyncSession(options, {
			onStatus: options.onStatus,
			onConflict: options.onConflict,
			onEdit: (file, doc) => this.editorChanged(file, doc),
			onRemap: (doc, fileId) => this.presence.remapDoc(doc, fileId),
			onQueued: () => this.queued(),
			confirmInitial: options.confirmInitial,
		});
		this.sendPending = new SendPending(
			this.state,
			api,
			this.documents,
			(work) => this.session.enqueue(work),
			(operation) => {
				if (isTextEdit(operation)) {
					return this.connection.operate(operation);
				}
				return api.operate(operation);
			},
			(operation, result) => {
				if (result.conflict || !isTextEdit(operation)) {
					this.requestReconcile();
				}
			},
		);
	}

	private get state(): SyncState {
		return this.session.state;
	}

	private get documents(): Documents {
		return this.session.documents;
	}

	private get active(): boolean {
		return !this.paused && !this.disposed && !this.stopped;
	}

	async start(): Promise<void> {
		await this.session.enqueue(async () => {
			this.state.emit("starting");
			await this.state.load();
			await this.session.recoverLocalChanges();
		});
		await this.syncNow();
	}

	pause(): void {
		this.paused = true;
		this.scheduler.cancel();
		this.disconnect();
		this.state.emit("paused");
	}

	async resume(): Promise<void> {
		this.paused = false;
		await this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.paused || this.disposed) {
			return;
		}

		this.stopped = false;
		this.scheduler.cancel();
		this.disconnect();
		const generation = this.connection.generation;
		await this.session.enqueue(async () => {
			if (!this.isCurrent(generation)) {
				return;
			}

			await this.session.recoverLocalChanges();
		});
		await this.syncNow();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.pause();
		await this.synchronizing;
		await Promise.all(this.incomingTasks);
		await this.session.idle();
		this.presence.dispose();
		this.session.dispose();
		this.options.store.close();
	}

	getDoc(path: string): Y.Doc | undefined {
		const file = this.syncedFileByPath(path);
		if (!file) {
			return undefined;
		}

		return this.documents.get(file.id);
	}

	async ensureDoc(path: string): Promise<Y.Doc | undefined> {
		return await this.session.enqueue(async () => {
			const file = this.syncedFileByPath(path);
			if (file?.kind !== "text") {
				return undefined;
			}

			return await this.documents.retain(file);
		});
	}

	setDeviceName(name: string): void {
		this.presence.setName(name);
	}

	getAwareness(doc: Y.Doc) {
		const file = this.syncedFileByDoc(doc);
		if (!file) {
			return undefined;
		}
		return this.presence.getAwareness(file.id, doc);
	}

	setSelection(owner: object, doc: Y.Doc, anchor: number, head: number): void {
		const file = this.syncedFileByDoc(doc);
		if (!file) {
			this.presence.clearSelection(owner);
			return;
		}
		this.presence.setSelection(owner, doc, anchor, head);
	}

	clearSelection(owner: object): void {
		this.presence.clearSelection(owner);
	}

	releaseDoc(doc: Y.Doc): void {
		void this.session
			.enqueue(() => this.documents.release(doc))
			.catch((error: unknown) => this.state.emit("error", error));
	}

	capture(path: string): Promise<void> {
		return this.session.enqueue(async () => {
			await this.session.changes.capture(path);
			this.schedule();
		});
	}

	captureDelete(path: string): Promise<void> {
		return this.session.enqueue(async () => {
			await this.session.changes.delete(path);
			this.schedule();
		});
	}

	captureRename(oldPath: string, path: string): Promise<void> {
		return this.session.enqueue(async () => {
			await this.session.changes.rename(oldPath, path);
			this.schedule();
		});
	}

	syncNow(): Promise<void> {
		if (this.synchronizing) {
			if (this.syncGeneration === this.connection.generation) {
				return this.synchronizing;
			}
			return this.synchronizing.then(() => this.syncNow());
		}
		this.syncGeneration = this.connection.generation;
		this.synchronizing = this.synchronizeNow().finally(() => {
			this.synchronizing = undefined;
		});
		return this.synchronizing;
	}

	private async synchronizeNow(): Promise<void> {
		if (!this.active) {
			return;
		}
		const generation = this.connection.generation;
		this.state.emit("syncing");
		try {
			await this.session.enqueue(() => this.session.recovery.run());
			if (!this.isCurrent(generation)) {
				return;
			}
			await this.connection.connect();
			if (!this.isCurrent(generation)) {
				return;
			}
			this.presence.connect();
			await this.synchronize(generation);
			await Promise.all(this.incomingTasks);
		} catch (error) {
			if (this.isCurrent(generation)) {
				this.failed(error);
			}
		}
	}

	private async flushPending(): Promise<void> {
		if (!this.ready || !this.connection.connected) {
			await this.syncNow();
			return;
		}
		const generation = this.connection.generation;
		try {
			await this.sendPending.run(() => this.isCurrent(generation));
			if (!this.isCurrent(generation)) {
				return;
			}
			await this.session.enqueue(() => this.state.emitProgress());
			this.schedulePending();
		} catch (error) {
			if (this.isCurrent(generation)) {
				this.failed(error);
			}
		}
	}

	private async synchronize(generation: number): Promise<void> {
		const requested = this.requestedReconcile;
		const initialSnapshot = await this.options.api.snapshot();
		if (!this.isCurrent(generation)) {
			return;
		}

		const initialized = await this.session.enqueue(async () => {
			if (!this.isCurrent(generation)) {
				return false;
			}
			const result = await this.session.reconcile.initialize(initialSnapshot);
			for (const file of this.state.data.files) {
				const doc = this.documents.get(file.id);
				if (doc && isExcluded(file.path, this.state.data.exclusions)) {
					this.presence.forgetDoc(doc);
				}
			}
			return result;
		});
		if (!this.isCurrent(generation)) {
			return;
		}
		if (!initialized) {
			this.pause();

			return;
		}

		this.ready = true;
		await this.sendPending.run(() => this.isCurrent(generation));
		if (!this.isCurrent(generation)) {
			return;
		}

		const snapshot = await this.options.api.snapshot();
		if (!this.isCurrent(generation)) {
			return;
		}

		await this.session.reconcile.run(snapshot, () => this.isCurrent(generation));
		if (!this.isCurrent(generation)) {
			return;
		}

		this.completedReconcile = requested;
		this.state.emitProgress();
		this.scheduler.succeeded();
		this.schedulePending();
	}

	private schedulePending(): void {
		const hasPending = this.state.hasPending();
		if (hasPending || this.requestedReconcile > this.completedReconcile) {
			this.schedule();
		}
	}

	private failed(error: unknown): void {
		if (error instanceof DocumentNotFoundError) {
			this.requestReconcile(100);

			return;
		}

		this.disconnect();
		if (!(error instanceof ConnectionError)) {
			this.stopped = true;
			this.scheduler.cancel();
			this.state.emit("error", error);

			return;
		}

		this.state.emit("offline", error);
		this.scheduler.retry();
	}

	private isCurrent(generation: number): boolean {
		return generation === this.connection.generation && this.active;
	}

	private schedule(delay?: number): void {
		if (!this.active) {
			return;
		}

		this.scheduler.schedule(delay);
	}

	private requestReconcile(delay?: number): void {
		this.requestedReconcile += 1;
		this.schedule(delay);
	}

	private disconnect(): void {
		this.presence.disconnect();
		this.ready = false;
		this.connection.disconnect();
	}

	private syncedFileByPath(path: string): LocalFile | undefined {
		const file = this.state.data.files.find((candidate) => candidate.path === path);

		return this.synced(file);
	}

	private syncedFileByDoc(doc: Y.Doc): LocalFile | undefined {
		const file = this.state.data.files.find(
			(candidate) => this.documents.get(candidate.id) === doc,
		);

		return this.synced(file);
	}

	private synced(file: LocalFile | undefined): LocalFile | undefined {
		if (!file || isExcluded(file.path, this.state.data.exclusions)) {
			return undefined;
		}

		return file;
	}

	private queued(): void {
		if (this.paused) {
			this.state.emit("paused");
			return;
		}
		this.state.emit("syncing");
	}

	private editorChanged(file: LocalFile, doc: Y.Doc): void {
		void this.session
			.enqueue(async () => {
				if (this.disposed || isExcluded(file.path, this.state.data.exclusions)) {
					return;
				}

				await this.session.changes.editorChanged(file, doc);
				this.schedule();
			})
			.catch((error: unknown) => this.state.emit("error", error));
	}

	private receive(message: ServerMessage): void {
		if (message.type === "presence") {
			try {
				this.presence.receive(message);
			} catch (error) {
				this.failed(error);
			}
		} else if (message.type === "changed" || message.type === "text") {
			const task = this.receiveChange(message);
			this.incomingTasks.add(task);
			void task.finally(() => this.incomingTasks.delete(task));
		} else if (message.type === "r2") {
			void this.session
				.enqueue(async () => {
					this.state.data.r2Revision = Math.max(this.state.data.r2Revision, message.revision);
					await this.state.persist();
					this.state.emitProgress();
				})
				.catch((error: unknown) => this.failed(error));
		} else if (message.type === "settings") {
			this.requestReconcile();
		}
	}

	private async receiveChange(
		message: Extract<ServerMessage, { type: "changed" | "text" }>,
	): Promise<void> {
		if (!this.active) {
			return;
		}
		const generation = this.connection.generation;
		try {
			const local = this.state.data.files.find((file) => file.id === message.fileId);
			let fetched: FetchedFile;
			if (message.type === "text" && local) {
				fetched = { file: message.file, content: { kind: "text", update: message.update } };
			} else {
				fetched = await this.session.receive.fetch(message.fileId);
			}
			await this.session.enqueue(async () => {
				if (!this.isCurrent(generation)) {
					return;
				}
				const pending = this.state.data.pending.filter(
					(operation) => operation.fileId === message.fileId,
				);
				const textOnly = pending.every(isTextEdit);
				if (pending.length > 0 && (message.type !== "text" || !textOnly)) {
					this.requestReconcile();
					return;
				}
				if (!isExcluded(fetched.file.path, this.state.data.exclusions)) {
					const applied = await this.session.receive.run(fetched);
					if (!applied) {
						this.requestedReconcile += 1;
					}
				}
				this.state.data.revision = Math.max(this.state.data.revision, message.revision);
				await this.state.persist();
				this.state.emitProgress();
				this.schedulePending();
			});
		} catch (error) {
			if (this.isCurrent(generation)) {
				this.failed(error);
			}
		}
	}
}
