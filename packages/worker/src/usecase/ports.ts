import type {
  BlobRef,
  Content,
  Device,
  OperationResult,
  ServerMessage,
  VaultInfo,
} from "@cf-sync/protocol";

import type { OperationChanges, StoredFile, VaultMeta } from "../domain/vault-state";

export interface VaultStore {
  meta(): Promise<VaultMeta>;
  files(): Promise<StoredFile[]>;
  content(stored: StoredFile): Promise<Content>;
  operationResult(id: string): Promise<OperationResult | undefined>;
  commit(meta: VaultMeta, files: StoredFile[], changes: OperationChanges): Promise<void>;
  dirtyPaths(): Promise<string[]>;
  markFlushed(meta: VaultMeta, paths: string[]): Promise<void>;
  schedule(): Promise<void>;
  scheduleMaintenance(hasSockets: boolean): Promise<void>;
}

export interface BlobVerifier {
  validate(blob: BlobRef): Promise<void>;
}

export interface VaultNotifications {
  broadcast(message: ServerMessage): void;
  expire(): Promise<void>;
  readonly hasConnections: boolean;
}

export interface VaultArchive {
  write(vaultId: string, path: string, content: Content): Promise<void>;
  delete(vaultId: string, path: string): Promise<void>;
  collectUnreferenced(vaultId: string, referenced: Set<string>): Promise<void>;
}

export interface DeviceRegistry {
  revoke(device: Device): Promise<void>;
  vaults(): Promise<VaultInfo[]>;
}

export interface DeviceConnections {
  revoke(vaultId: string, deviceId: string): Promise<void>;
}
