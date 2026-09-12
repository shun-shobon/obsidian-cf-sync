import { isExcluded } from "@cf-sync/protocol";

import type { StoredFile, VaultMeta } from "../domain/vault-state";

import type { VaultStore, VaultNotifications, VaultArchive } from "./ports";

export class FlushVault {
  constructor(
    private readonly repository: VaultStore,
    private readonly sockets: VaultNotifications,
    private readonly archive: VaultArchive,
  ) {}

  async execute(): Promise<void> {
    try {
      await this.sockets.expire();
      const meta = await this.repository.meta();
      const files = await this.repository.files();
      const paths = await this.repository.dirtyPaths();

      await this.writeFiles(meta, files, paths);
      await this.deleteFiles(meta, files, paths);
      await this.repository.markFlushed(meta, paths);
      this.sockets.broadcast({ type: "r2", revision: meta.r2Revision });
      await this.archive.collectUnreferenced(
        meta.vaultId,
        new Set(files.flatMap((item) => (item.blob ? [item.blob.key] : []))),
      );
    } finally {
      await this.repository.scheduleMaintenance(this.sockets.hasConnections);
    }
  }

  private async writeFiles(meta: VaultMeta, files: StoredFile[], paths: string[]): Promise<void> {
    // Complete writes before deletes so a failed rename retains the previous R2 copy.
    for (const path of paths) {
      const stored = files.find((item) => item.file.path === path);
      if (!stored || isExcluded(path, meta.exclusions)) continue;
      const content = await this.repository.content(stored);
      await this.archive.write(meta.vaultId, path, content);
    }
  }

  private async deleteFiles(meta: VaultMeta, files: StoredFile[], paths: string[]): Promise<void> {
    for (const path of paths) {
      if (!files.some((item) => item.file.path === path) && !isExcluded(path, meta.exclusions)) {
        await this.archive.delete(meta.vaultId, path);
      }
    }
  }
}
