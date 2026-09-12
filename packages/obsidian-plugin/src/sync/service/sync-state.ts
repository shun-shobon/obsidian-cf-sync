import type { FileRecord } from "@cf-sync/protocol";

import type { LocalState, SyncStatus } from "../domain/sync-state";
import type { SyncStore } from "../ports/sync-store";

export class SyncState {
  data: LocalState = {
    initialized: false,
    incoming: null,
    attempted: [],
    files: [],
    pending: [],
    exclusions: [],
    revision: 0,
    r2Revision: 0,
    conflicts: [],
  };

  constructor(
    readonly store: SyncStore,
    private readonly onStatus: (status: SyncStatus) => void,
    private readonly onConflict: (file: FileRecord, message: string) => void,
  ) {}

  async load(): Promise<void> {
    const stored = await this.store.load();
    if (stored) this.data = stored;
  }

  emit(phase: SyncStatus["phase"], error?: unknown): void {
    this.onStatus({
      phase,
      pending: this.data.pending.length,
      revision: this.data.revision,
      r2Revision: this.data.r2Revision,
      ...(error === undefined
        ? {}
        : {
            error:
              error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : "同期処理に失敗しました",
          }),
    });
  }

  emitProgress(): void {
    this.emit(
      this.data.pending.length
        ? "syncing"
        : this.data.r2Revision < this.data.revision
          ? "r2-pending"
          : "synced",
    );
  }

  persist(): Promise<void> {
    return this.store.save(this.data);
  }

  reportConflict(file: FileRecord, message: string): void {
    if (!this.data.conflicts.some((entry) => entry.id === file.id)) {
      this.data.conflicts.push(file);
      this.onConflict(file, message);
    }
  }
}
