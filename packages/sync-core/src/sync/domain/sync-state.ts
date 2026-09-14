import type { FileRecord, Operation } from "@cf-sync/protocol";

export interface LocalFile {
  id: string;
  path: string;
  digest: string;
  diskDigest: string;
  documentRevision: number;
  revision: number;
  pathRevision: number;
  kind: "text" | "blob";
}

export interface IncomingWrite {
  file: FileRecord;
  digest: string;
  expectedDigest: string | null;
  update: string | null;
}

export interface LocalState {
  incoming: IncomingWrite | null;
  initialized: boolean;
  attempted: string[];
  files: LocalFile[];
  pending: Operation[];
  exclusions: string[];
  revision: number;
  r2Revision: number;
  conflicts: FileRecord[];
}

export interface SyncStatus {
  phase: "starting" | "syncing" | "synced" | "r2-pending" | "offline" | "paused" | "error";
  pending: number;
  revision: number;
  r2Revision: number;
  error?: string;
}
