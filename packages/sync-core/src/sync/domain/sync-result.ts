import type { FileRecord } from "@cf-sync/protocol";

export interface SyncResult {
  revision: number;
  r2Revision: number;
  pending: number;
  conflicts: FileRecord[];
}
