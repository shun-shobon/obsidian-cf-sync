import { isExcluded } from "@cf-sync/protocol";

import type { StoredFile, VaultMeta } from "../domain/vault-state";

import type { VaultStore, VaultNotifications, VaultArchive, MaintenanceSchedule } from "./ports";

export class FlushVault {
  constructor(
    private readonly repository: VaultStore,
    private readonly sockets: VaultNotifications,
    private readonly archive: VaultArchive,
    private readonly maintenance: MaintenanceSchedule,
  ) {}

  async execute(): Promise<void> {
    try {
      await this.sockets.expire();

      if (await this.maintenance.due("flush")) {
        await this.flushChanges();
        await this.maintenance.complete("flush", null);
      }

      if (await this.maintenance.due("blobs")) {
        await this.collectBlobs();
      }

      await this.maintenance.schedule();
    } catch (error) {
      await this.maintenance.retry();
      throw error;
    }
  }

  private async flushChanges(): Promise<void> {
    const meta = await this.repository.meta();

    if (meta.r2Revision === meta.revision) {
      return;
    }

    const files = await this.repository.files();
    const paths = await this.repository.dirtyPaths();

    await this.writeFiles(meta, files, paths);
    await this.deleteFiles(meta, files, paths);
    await this.repository.markFlushed(meta, paths);
    this.sockets.broadcast({ type: "r2", revision: meta.r2Revision });
  }

  private async collectBlobs(): Promise<void> {
    const meta = await this.repository.meta();
    const files = await this.repository.files();
    const referenced = new Set<string>();

    for (const item of files) {
      if (item.blob) {
        referenced.add(item.blob.key);
      }
    }

    const nextExpiry = await this.archive.collectUnreferenced(meta.vaultId, referenced);
    await this.maintenance.complete("blobs", nextExpiry);
  }

  private async writeFiles(meta: VaultMeta, files: StoredFile[], paths: string[]): Promise<void> {
    // Complete writes before deletes so a failed rename retains the previous R2 copy.

    for (const path of paths) {
      const stored = files.find((item) => item.file.path === path);

      if (!stored || isExcluded(path, meta.exclusions)) {
        continue;
      }

      const content = await this.repository.content(stored);
      await this.archive.write(meta.vaultId, path, content);
    }
  }

  private async deleteFiles(meta: VaultMeta, files: StoredFile[], paths: string[]): Promise<void> {
    for (const path of paths) {
      const exists = files.some((item) => item.file.path === path);
      const excluded = isExcluded(path, meta.exclusions);

      if (!exists && !excluded) {
        await this.archive.delete(meta.vaultId, path);
      }
    }
  }
}
