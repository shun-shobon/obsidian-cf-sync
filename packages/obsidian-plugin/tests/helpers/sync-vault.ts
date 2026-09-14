import type { VaultPort } from "@cf-sync/sync-core/sync/ports/vault-port";

export class Vault implements VaultPort {
  files = new Map<string, Uint8Array>();

  async list() {
    return [...this.files.keys()];
  }

  async read(path: string) {
    const value = this.files.get(path);
    if (!value) {
      throw Error("Missing file");
    }

    return value;
  }

  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes);
  }

  async writeIfUnchanged(path: string, expected: Uint8Array | undefined, bytes: Uint8Array) {
    const current = this.files.get(path);
    if (current?.length !== expected?.length) {
      return false;
    }

    if (current && expected) {
      const matchesBaseline = current.every((byte, index) => byte === expected[index]);
      if (!matchesBaseline) {
        return false;
      }
    }

    this.files.set(path, bytes);

    return true;
  }

  async remove(path: string) {
    this.files.delete(path);
  }

  async rename(oldPath: string, path: string) {
    this.files.set(path, await this.read(oldPath));
    this.files.delete(oldPath);
  }

  text(path: string) {
    return new TextDecoder().decode(this.files.get(path));
  }
}
