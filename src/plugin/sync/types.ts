import type {
  BlobRef,
  DocumentResponse,
  FileRecord,
  Operation,
  OperationResult,
  ServerMessage,
  Snapshot,
} from "../../shared/protocol";
export interface VaultPort {
  list(): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  writeIfUnchanged(
    path: string,
    expected: Uint8Array | undefined,
    bytes: Uint8Array,
  ): Promise<boolean>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}
export interface ApiPort {
  snapshot(): Promise<Snapshot>;
  document(id: string): Promise<DocumentResponse>;
  operate(operation: Operation): Promise<OperationResult>;
  upload(key: string, bytes: Uint8Array, digest: string): Promise<BlobRef>;
  download(ref: BlobRef): Promise<Uint8Array>;
  connect(message: (message: ServerMessage) => void, close: () => void): Promise<{ close(): void }>;
}
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
export interface SyncStore {
  load(): Promise<LocalState | undefined>;
  save(state: LocalState, data?: { key: string; value: Uint8Array }): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  close(): void;
}
export interface SyncStatus {
  phase: "starting" | "syncing" | "synced" | "r2-pending" | "offline" | "paused" | "error";
  pending: number;
  revision: number;
  r2Revision: number;
  error?: string;
}
export interface SyncOptions {
  vault: VaultPort;
  api: ApiPort;
  store: SyncStore;
  onStatus(status: SyncStatus): void;
  onConflict(file: FileRecord, message: string): void;
  confirmInitial(paths: string[]): Promise<boolean>;
}
