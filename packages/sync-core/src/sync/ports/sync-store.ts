import type { LocalState } from "../domain/sync-state";

export interface StoredData {
  key: string;
  value: Uint8Array;
}

export interface SyncStore {
  load(): Promise<LocalState | undefined>;
  save(state: LocalState, data?: StoredData): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  close(): void;
}
