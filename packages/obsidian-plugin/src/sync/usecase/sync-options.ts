import type { FileRecord } from "@cf-sync/protocol";

import type { SyncStatus } from "../domain/sync-state";
import type { ApiPort } from "../ports/api-port";
import type { SyncStore } from "../ports/sync-store";
import type { VaultPort } from "../ports/vault-port";

export interface SyncOptions {
  vault: VaultPort;
  api: ApiPort;
  store: SyncStore;
  onStatus(status: SyncStatus): void;
  onConflict(file: FileRecord, message: string): void;
  confirmInitial(paths: string[]): Promise<boolean>;
}
