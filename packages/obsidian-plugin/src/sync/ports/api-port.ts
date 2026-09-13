import type {
  BlobRef,
  ClientMessage,
  DocumentResponse,
  Operation,
  OperationResult,
  ServerMessage,
  Snapshot,
} from "@cf-sync/protocol";

export interface SyncSocket {
  send(message: ClientMessage): void;
  close(): void;
}

export interface ApiPort {
  snapshot(): Promise<Snapshot>;
  document(id: string): Promise<DocumentResponse>;
  operate(operation: Operation): Promise<OperationResult>;
  upload(key: string, bytes: Uint8Array, digest: string): Promise<BlobRef>;
  download(ref: BlobRef): Promise<Uint8Array>;
  connect(message: (message: ServerMessage) => void, close: () => void): Promise<SyncSocket>;
}
