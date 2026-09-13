import { isExcluded } from "@cf-sync/protocol";

import { FLUSH_INTERVAL_MS, type StoredFile, type VaultMeta } from "../domain/vault-state";

import type { VaultStore, VaultNotifications, VaultArchive, MaintenanceSchedule } from "./ports";

export class FlushVault {
  constructor(
    private readonly repository: VaultStore,
    private readonly sockets: VaultNotifications,
    private readonly archive: VaultArchive,
    private readonly maintenance: MaintenanceSchedule,
    private readonly serial: <T>(action: () => Promise<T>) => Promise<T>,
  ) {}

  async execute(): Promise<void> {
    try {
      const snapshot = await this.serial(async () => {
        await this.sockets.expire();
        if (!(await this.maintenance.due("flush"))) {
          return null;
        }
        const meta = await this.repository.meta();
        const files = await this.repository.files();
        const paths = await this.repository.dirtyPaths();
        const writes: StoredFile[] = [];
        for (const path of paths) {
          const stored = files.find((item) => item.file.path === path);
          if (stored && !isExcluded(path, meta.exclusions)) {
            writes.push(stored);
          }
        }
        return { meta, files, paths, writes };
      });
      if (snapshot) {
        const written = await this.writeFiles(snapshot.meta, snapshot.writes);
        if (written) {
          await this.deleteFiles(snapshot.meta, snapshot.files, snapshot.paths);
        }
        await this.serial(async () => {
          if (written) {
            await this.repository.markFlushed(snapshot.meta, snapshot.paths);
            this.sockets.broadcast({ type: "r2", revision: snapshot.meta.revision });
          }
          const latest = await this.repository.meta();
          if (written && latest.revision === snapshot.meta.revision) {
            await this.maintenance.complete("flush", null);
          } else {
            await this.maintenance.complete("flush", Date.now() + FLUSH_INTERVAL_MS);
          }
        });
      }
      await this.serial(async () => {
        if (await this.maintenance.due("blobs")) {
          await this.collectBlobs();
        }
        await this.maintenance.schedule();
      });
    } catch (error) {
      await this.serial(() => this.maintenance.retry());
      throw error;
    }
  }

  private async writeFiles(meta: VaultMeta, writes: StoredFile[]): Promise<boolean> {
    for (const stored of writes) {
      const content = await this.serial(async () => {
        const current = (await this.repository.files()).find(
          (item) => item.file.id === stored.file.id,
        );
        if (!current || current.file.revision !== stored.file.revision) {
          return null;
        }
        return this.repository.content(current);
      });
      if (!content) {
        return false;
      }
      await this.archive.write(meta.vaultId, stored.file.path, content);
    }
    return true;
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
