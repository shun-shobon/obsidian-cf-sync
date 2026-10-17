import type { BlobRef, FileRecord, OperationResult } from "@cf-sync/protocol";

export interface VaultMeta {
	revision: number;
	r2Revision: number;
	exclusions: string[];
	vaultId: string;
}

export interface StoredTextFile {
	file: FileRecord;
	chunks: number;
}

export interface StoredBlobFile {
	file: FileRecord;
	blob: BlobRef;
}

export type StoredFile = StoredTextFile | StoredBlobFile;

export interface FileWrite {
	stored: StoredFile;
	update?: Uint8Array;
}

export interface FileChanges {
	writes: FileWrite[];
	dirty: Set<string>;
	removed?: StoredFile;
}

export interface OperationChanges extends FileChanges {
	result: OperationResult;
}

export interface OperationState {
	current: StoredFile | undefined;
	files: StoredFile[];
	nextRevision: number;
}

export interface OperationOutcome {
	file: FileRecord | null;
	conflictReason?: NonNullable<OperationResult["conflictReason"]>;
	changes?: FileChanges;
}

export const TEXT_CHUNK_SIZE = 64_000;
export const FLUSH_INTERVAL_MS = 10_000;
