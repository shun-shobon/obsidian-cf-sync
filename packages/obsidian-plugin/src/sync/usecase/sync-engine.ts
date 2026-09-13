import { isExcluded, type FileRecord, type ServerMessage } from "@cf-sync/protocol";
import type * as Y from "yjs";

import { ConnectionError } from "../../domain/connection-error";
import { DocumentNotFoundError } from "../../domain/document-not-found-error";
import { t } from "../../i18n";
import type { LocalFile } from "../domain/sync-state";
import { Documents } from "../service/documents";
import { Presence } from "../service/presence";
import { SyncConnection } from "../service/sync-connection";
import { SyncScheduler } from "../service/sync-scheduler";
import { SyncState } from "../service/sync-state";

import { LocalChanges } from "./local-changes";
import { ReceiveFile } from "./receive-file";
import { ReconcileVault } from "./reconcile-vault";
import { RecoverIncoming } from "./recover-incoming";
import { SendPending } from "./send-pending";
import type { SyncOptions } from "./sync-options";

export class SyncEngine {
  private readonly state: SyncState;
  private readonly documents: Documents;
  private readonly changes: LocalChanges;
  private readonly receiveFile: ReceiveFile;
  private readonly reconcile: ReconcileVault;
  private readonly recovery: RecoverIncoming;
  private readonly sendPending: SendPending;
  private serial: Promise<unknown> = Promise.resolve();
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
    const { store, vault, api } = options;
    this.connection = new SyncConnection(
      api,
      (message) => this.receive(message),
      () => this.failed(new ConnectionError(t(($) => $.errors.websocketDisconnected))),
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
    this.state = new SyncState(
      store,
      (status) => options.onStatus(status),
      (file, message) => options.onConflict(file, message),
    );
    this.documents = new Documents(
      store,
      (file, doc) => this.editorChanged(file, doc),
      (doc, fileId) => this.presence.remapDoc(doc, fileId),
    );
    this.changes = new LocalChanges(this.state, vault, this.documents, () => this.queued());
    this.receiveFile = new ReceiveFile(this.state, vault, api, this.documents, this.changes);
    this.reconcile = new ReconcileVault(
      this.state,
      vault,
      this.documents,
      this.changes,
      this.receiveFile,
      (paths) => options.confirmInitial(paths),
    );
    this.recovery = new RecoverIncoming(this.state, vault, this.documents, this.changes);
    this.sendPending = new SendPending(
      this.state,
      api,
      this.documents,
      (work) => this.enqueue(work),
      (operation) => {
        if (operation.type === "edit" && operation.content.kind === "text") {
          return this.connection.operate(operation);
        }
        return api.operate(operation);
      },
      (operation, result) => {
        if (result.conflict || operation.type !== "edit" || operation.content.kind !== "text") {
          this.requestedReconcile += 1;
          this.schedule();
        }
      },
    );
  }

  get conflicts(): readonly FileRecord[] {
    return this.state.data.conflicts;
  }

  get exclusions(): readonly string[] {
    return this.state.data.exclusions;
  }

  async start(): Promise<void> {
    await this.enqueue(async () => {
      this.state.emit("starting");
      await this.state.load();
      await this.recovery.run();
      await this.changes.scan();
    });
    await this.syncNow();
  }

  pause(): void {
    this.paused = true;
    this.scheduler.cancel();
    this.presence.disconnect();
    this.ready = false;
    this.connection.disconnect();
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
    this.presence.disconnect();
    this.ready = false;
    this.connection.disconnect();
    const generation = this.connection.generation;
    await this.enqueue(async () => {
      if (!this.isCurrent(generation)) {
        return;
      }

      await this.recovery.run();
      await this.changes.scan();
    });
    await this.syncNow();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pause();
    await this.synchronizing;
    await Promise.all(this.incomingTasks);
    await this.serial;
    this.presence.dispose();
    this.documents.dispose();
    this.options.store.close();
  }

  getDoc(path: string): Y.Doc | undefined {
    const file = this.state.data.files.find((file) => file.path === path);
    if (!file || isExcluded(file.path, this.state.data.exclusions)) {
      return undefined;
    }

    return this.documents.get(file.id);
  }

  async ensureDoc(path: string): Promise<Y.Doc | undefined> {
    return this.enqueue(async () => {
      const file = this.state.data.files.find((file) => file.path === path);
      if (file?.kind !== "text" || isExcluded(file.path, this.state.data.exclusions)) {
        return undefined;
      }

      return this.documents.retain(file);
    });
  }

  setDeviceName(name: string): void {
    this.presence.setName(name);
  }

  getAwareness(doc: Y.Doc) {
    const file = this.state.data.files.find((entry) => this.documents.get(entry.id) === doc);
    if (!file || isExcluded(file.path, this.state.data.exclusions)) {
      return undefined;
    }
    return this.presence.getAwareness(file.id, doc);
  }

  setSelection(owner: object, doc: Y.Doc, anchor: number, head: number): void {
    const file = this.state.data.files.find((entry) => this.documents.get(entry.id) === doc);
    if (!file || isExcluded(file.path, this.state.data.exclusions)) {
      this.presence.clearSelection(owner);
      return;
    }
    this.presence.setSelection(owner, doc, anchor, head);
  }

  clearSelection(owner: object): void {
    this.presence.clearSelection(owner);
  }

  releaseDoc(doc: Y.Doc): void {
    void this.enqueue(async () => this.documents.release(doc)).catch(() => {});
  }

  capture(path: string): Promise<void> {
    return this.enqueue(async () => {
      await this.changes.capture(path);
      this.schedule();
    });
  }

  captureDelete(path: string): Promise<void> {
    return this.enqueue(async () => {
      await this.changes.delete(path);
      this.schedule();
    });
  }

  captureRename(oldPath: string, path: string): Promise<void> {
    return this.enqueue(async () => {
      if (await this.changes.rename(oldPath, path)) {
        this.schedule();
      }
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
    if (this.paused || this.disposed || this.stopped) {
      return;
    }
    const generation = this.connection.generation;
    this.state.emit("syncing");
    try {
      await this.enqueue(() => this.recovery.run());
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
      await this.enqueue(async () => this.state.emitProgress());
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

    const initialized = await this.enqueue(async () => {
      if (!this.isCurrent(generation)) {
        return false;
      }
      const initialized = await this.reconcile.initialize(initialSnapshot);
      for (const file of this.state.data.files) {
        const doc = this.documents.get(file.id);
        if (doc && isExcluded(file.path, this.state.data.exclusions)) {
          this.presence.forgetDoc(doc);
        }
      }
      return initialized;
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

    await this.reconcile.run(
      snapshot,
      (work) => this.enqueue(work),
      (file) => this.fetchFile(file.id),
      () => this.isCurrent(generation),
    );
    if (!this.isCurrent(generation)) {
      return;
    }

    this.completedReconcile = requested;
    this.state.emitProgress();
    this.scheduler.succeeded();
    this.schedulePending();
  }

  private schedulePending(): void {
    const hasPending = this.state.data.pending.some((operation) => {
      const file = this.state.data.files.find((entry) => entry.id === operation.fileId);
      return !file || !isExcluded(file.path, this.state.data.exclusions);
    });
    if (hasPending || this.requestedReconcile > this.completedReconcile) {
      this.schedule();
    }
  }

  private failed(error: unknown): void {
    if (error instanceof DocumentNotFoundError) {
      this.requestedReconcile += 1;
      this.schedule(100);

      return;
    }

    this.presence.disconnect();
    this.ready = false;
    this.connection.disconnect();
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
    const active = !this.paused && !this.disposed && !this.stopped;

    return generation === this.connection.generation && active;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch((error: unknown) => this.state.emit("error", error));

    return result;
  }

  private schedule(delay = 50): void {
    if (this.disposed || this.paused || this.stopped) {
      return;
    }

    this.scheduler.schedule(delay);
  }

  private queued(): void {
    if (this.paused) {
      this.state.emit("paused");
      return;
    }
    this.state.emit("syncing");
  }

  private editorChanged(file: LocalFile, doc: Y.Doc): void {
    void this.enqueue(async () => {
      if (this.disposed || isExcluded(file.path, this.state.data.exclusions)) {
        return;
      }

      await this.changes.editorChanged(file, doc);
      this.schedule();
    }).catch(() => {});
  }

  private receive(message: ServerMessage): void {
    if (message.type === "presence") {
      try {
        this.presence.receive(message);
      } catch (error) {
        this.failed(error);
      }
    } else if (message.type === "error") {
      this.failed(new Error(message.message));
    } else if (message.type === "changed" || message.type === "text") {
      const task = this.receiveChange(message);
      this.incomingTasks.add(task);
      void task.finally(() => this.incomingTasks.delete(task));
    } else if (message.type === "r2") {
      void this.enqueue(async () => {
        this.state.data.r2Revision = Math.max(this.state.data.r2Revision, message.revision);
        await this.state.persist();
        this.state.emitProgress();
      }).catch((error: unknown) => this.failed(error));
    } else if (message.type === "settings") {
      this.requestedReconcile += 1;
      this.schedule(50);
    }
  }

  private async fetchFile(fileId: string) {
    const document = await this.options.api.document(fileId);
    let bytes: Uint8Array | undefined;
    if (document.content.kind === "blob") {
      bytes = await this.options.api.download(document.content.blob);
    }
    return { document, bytes };
  }

  private async receiveChange(
    message: Extract<ServerMessage, { type: "changed" | "text" }>,
  ): Promise<void> {
    if (this.paused || this.disposed || this.stopped) {
      return;
    }
    const generation = this.connection.generation;
    try {
      const local = this.state.data.files.find((file) => file.id === message.fileId);
      let fetched: Awaited<ReturnType<SyncEngine["fetchFile"]>>;
      if (message.type === "text" && local) {
        fetched = {
          document: { file: message.file, content: { kind: "text", update: message.update } },
          bytes: undefined,
        };
      } else {
        fetched = await this.fetchFile(message.fileId);
      }
      await this.enqueue(async () => {
        if (!this.isCurrent(generation)) {
          return;
        }
        const pending = this.state.data.pending.filter(
          (operation) => operation.fileId === message.fileId,
        );
        const textOnly = pending.every(
          (operation) => operation.type === "edit" && operation.content.kind === "text",
        );
        if (pending.length && (message.type !== "text" || !textOnly)) {
          this.requestedReconcile += 1;
          this.schedule();
          return;
        }
        if (!isExcluded(fetched.document.file.path, this.state.data.exclusions)) {
          const applied = await this.receiveFile.run(
            fetched.document.file,
            fetched.document,
            undefined,
            fetched.bytes,
          );
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
