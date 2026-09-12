import type { BlobRef, FileRecord, OperationResult } from "@cf-sync/protocol";

export interface VaultMeta {
  revision: number;
  r2Revision: number;
  exclusions: string[];
  vaultId: string;
}

export interface StoredFile {
  file: FileRecord;
  blob?: BlobRef;
  chunks: number;
}

export interface FileWrite {
  stored: StoredFile;
  update?: Uint8Array;
}

export interface OperationChanges {
  result: OperationResult;
  writes: FileWrite[];
  dirty: Set<string>;
  removed?: StoredFile;
}

export const TEXT_CHUNK_SIZE = 64_000;
export const FLUSH_INTERVAL_MS = 10_000;
