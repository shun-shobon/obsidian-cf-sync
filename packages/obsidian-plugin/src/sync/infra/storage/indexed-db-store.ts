import type { Operation } from "@cf-sync/protocol";

import type { LocalFile, LocalState } from "../../domain/sync-state";
import type { StoredData, SyncStore } from "../../ports/sync-store";

function unchanged(a: object | undefined, b: object): boolean {
  if (!a) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return Object.keys(right).every((key) => left[key] === right[key]);
}

/** Baselines and outbox entries are separate records: saving an edit never rewrites all note bodies. */
export class IndexedDbStore implements SyncStore {
  private readonly database: Promise<IDBDatabase>;
  private files = new Map<string, LocalFile>();
  private pending = new Map<string, { order: number; operation: Operation }>();
  private nextOrder = 0;

  constructor(name: string) {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("sync");
        request.result.createObjectStore("files");
        request.result.createObjectStore("pending");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("同期データベースが別のウィンドウで使用されています"));
    });
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db.transaction("sync", "readonly").objectStore("sync").get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  private async write(key: string, value: unknown, remove = false): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("sync", "readwrite");
      const store = transaction.objectStore("sync");
      if (remove) store.delete(key);
      else store.put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("同期データの保存が中断しました"));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async load(): Promise<LocalState | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["sync", "files", "pending"], "readonly");
      const state = transaction.objectStore("sync").get("state");
      const files = transaction.objectStore("files").getAll();
      const pending = transaction.objectStore("pending").getAll();
      transaction.oncomplete = () => {
        if (!state.result) {
          resolve(undefined);
          return;
        }
        const entries = pending.result as { order: number; operation: Operation }[];
        entries.sort((a, b) => a.order - b.order);
        this.files = new Map((files.result as LocalFile[]).map((file) => [file.id, { ...file }]));
        this.pending = new Map(
          entries.map((entry) => [
            entry.operation.opId,
            { order: entry.order, operation: { ...entry.operation } },
          ]),
        );
        this.nextOrder = entries.length ? Math.max(...entries.map((entry) => entry.order)) + 1 : 0;
        resolve({
          ...state.result,
          files: files.result,
          pending: entries.map((entry) => entry.operation),
        } as LocalState);
      };
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async save(state: LocalState, data?: StoredData): Promise<void> {
    const db = await this.database;
    const nextFiles = new Map(state.files.map((file) => [file.id, { ...file }]));
    const nextPending = new Map(
      state.pending.map((operation) => [
        operation.opId,
        {
          order: this.pending.get(operation.opId)?.order ?? this.nextOrder++,
          operation: { ...operation },
        },
      ]),
    );
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["sync", "files", "pending"], "readwrite");
      const store = transaction.objectStore("sync");
      const { files: _files, pending: _pending, ...metadata } = state;
      store.put(metadata, "state");
      const files = transaction.objectStore("files");
      for (const [id, file] of nextFiles)
        if (!unchanged(this.files.get(id), file)) files.put(file, id);
      for (const id of this.files.keys()) if (!nextFiles.has(id)) files.delete(id);
      const pending = transaction.objectStore("pending");
      for (const [id, entry] of nextPending)
        if (!unchanged(this.pending.get(id)?.operation, entry.operation)) pending.put(entry, id);
      for (const id of this.pending.keys()) if (!nextPending.has(id)) pending.delete(id);
      if (data) store.put(data.value, `data:${data.key}`);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("同期データの保存が中断しました"));
      transaction.onerror = () => reject(transaction.error);
    });
    this.files = nextFiles;
    this.pending = nextPending;
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.read(`data:${key}`);
  }

  put(key: string, value: Uint8Array): Promise<void> {
    return this.write(`data:${key}`, value);
  }

  delete(key: string): Promise<void> {
    return this.write(`data:${key}`, undefined, true);
  }

  close(): void {
    void this.database.then((db) => db.close());
  }
}
