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
