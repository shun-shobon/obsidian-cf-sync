import type { VaultPort } from "../../packages/obsidian-plugin/src/sync/ports/vault-port";

export function memoryVault(files: Map<string, Uint8Array>): VaultPort {
  return {
    async list() {
      return [...files.keys()];
    },

    async read(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Missing ${path}`);
      return bytes;
    },

    async write(path, bytes) {
      files.set(path, new Uint8Array(bytes));
    },

    async remove(path) {
      files.delete(path);
    },

    async rename(oldPath, newPath) {
      const value = files.get(oldPath);
      if (!value) throw new Error("Missing rename");
      files.set(newPath, value);
      files.delete(oldPath);
    },

    async writeIfUnchanged(path, expected, bytes) {
      const current = files.get(path);
      if (
        expected === undefined
          ? current !== undefined
          : !current ||
            current.length !== expected.length ||
            !current.every((byte, index) => byte === expected[index])
      )
        return false;
      files.set(path, new Uint8Array(bytes));
      return true;
    },
  };
}
