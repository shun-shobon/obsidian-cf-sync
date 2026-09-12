import { isExcluded, type FileRecord, type ServerMessage } from "@cf-sync/protocol";
import type * as Y from "yjs";

import type { LocalFile } from "../domain/sync-state";
import { Documents } from "../service/documents";
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
  private socket: { close(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SyncOptions) {
    const { store, vault, api } = options;
    this.state = new SyncState(
      store,
      (status) => options.onStatus(status),
      (file, message) => options.onConflict(file, message),
    );
    this.documents = new Documents(store, (file, doc) => this.editorChanged(file, doc));
    this.changes = new LocalChanges(this.state, vault, this.documents, () => {
      if (this.paused) {
        this.state.emit("paused");

        return;
      }

      this.state.emit("syncing");
    });
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
    this.sendPending = new SendPending(this.state, api, this.documents);
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
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
    this.state.emit("paused");
  }

  async resume(): Promise<void> {
    this.paused = false;
    await this.syncNow();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pause();
    await this.serial;
    this.documents.dispose();
    this.options.store.close();
  }

  getDoc(path: string): Y.Doc | undefined {
    const file = this.state.data.files.find((file) => file.path === path);
    if (!file) {
      return undefined;
    }

    return this.documents.get(file.id);
  }

  ensureDoc(path: string): Promise<Y.Doc | undefined> {
    return this.enqueue(async () => {
      const file = this.state.data.files.find((file) => file.path === path);
      if (file?.kind !== "text") {
        return undefined;
      }

      return this.documents.retain(file);
    });
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
    return this.enqueue(async () => {
      if (this.paused || this.disposed) {
        return;
      }

      clearTimeout(this.timer);
      this.state.emit("syncing");
      try {
        await this.recovery.run();
        await this.connect();

        const initialSnapshot = await this.options.api.snapshot();
        const initialized = await this.reconcile.initialize(initialSnapshot);
        if (!initialized) {
          this.pause();

          return;
        }

        await this.sendPending.run();

        const snapshot = await this.options.api.snapshot();
        await this.reconcile.run(snapshot);

        this.state.emitProgress();
        this.schedule(10_000);
      } catch (error) {
        this.state.emit("offline", error);
        this.schedule(5000);
      }
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch((error: unknown) => this.state.emit("error", error));

    return result;
  }

  private schedule(delay = 250): void {
    if (this.disposed || this.paused) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.syncNow();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    this.socket = await this.options.api.connect(
      (message) => this.receive(message),
      () => {
        this.socket = undefined;
        this.schedule(2000);
      },
    );
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
    if (message.type === "error") {
      this.state.emit("error", message.message);
    } else if (message.type === "changed" || message.type === "text") {
      void this.enqueue(() => this.receiveChange(message)).catch(() => {});
    } else if (message.type === "r2") {
      void this.enqueue(async () => {
        this.state.data.r2Revision = Math.max(this.state.data.r2Revision, message.revision);
        await this.state.persist();
        this.state.emitProgress();
      }).catch(() => {});
    } else {
      this.schedule(100);
    }
  }

  private async receiveChange(
    message: Extract<ServerMessage, { type: "changed" | "text" }>,
  ): Promise<void> {
    if (this.paused || this.disposed) {
      return;
    }

    const hasPendingChanges = this.state.data.pending.some(
      (operation) => operation.fileId === message.fileId,
    );
    if (hasPendingChanges) {
      this.schedule();

      return;
    }

    try {
      const document = await this.options.api.document(message.fileId);
      if (!isExcluded(document.file.path, this.state.data.exclusions)) {
        await this.receiveFile.run(document.file, document);
      }

      this.state.data.revision = Math.max(this.state.data.revision, message.revision);
      await this.state.persist();
      this.state.emit("r2-pending");
    } catch {
      this.schedule(100);
    }
  }
}
