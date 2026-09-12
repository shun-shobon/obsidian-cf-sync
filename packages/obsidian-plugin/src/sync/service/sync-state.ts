import type { FileRecord } from "@cf-sync/protocol";

import { t } from "../../i18n";
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
    if (stored) {
      this.data = stored;
    }
  }

  emit(phase: SyncStatus["phase"], error?: unknown): void {
    const status: SyncStatus = {
      phase,
      pending: this.data.pending.length,
      revision: this.data.revision,
      r2Revision: this.data.r2Revision,
    };

    if (error !== undefined) {
      status.error = errorMessage(error);
    }

    this.onStatus(status);
  }

  emitProgress(): void {
    if (this.data.pending.length > 0) {
      this.emit("syncing");

      return;
    }

    const awaitingR2 = this.data.r2Revision < this.data.revision;
    if (awaitingR2) {
      this.emit("r2-pending");

      return;
    }

    this.emit("synced");
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return t(($) => $.errors.syncFailed);
}
