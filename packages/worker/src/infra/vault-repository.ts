import { isExcluded, type Content, type OperationResult } from "@cf-sync/protocol";
import { fromUint8Array } from "js-base64";

import { ApplicationError } from "../domain/errors";
import {
  FLUSH_INTERVAL_MS,
  TEXT_CHUNK_SIZE,
  type FileWrite,
  type OperationChanges,
  type StoredFile,
  type VaultMeta,
} from "../domain/vault-state";

export class VaultRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  async initialize(vaultId: string): Promise<VaultMeta> {
    if (!(await this.storage.get("meta"))) {
      await this.storage.put("meta", {
        revision: 0,
        r2Revision: 0,
        exclusions: [],
        vaultId,
      } satisfies VaultMeta);
    }

    const meta = await this.meta();

    if (meta.vaultId !== vaultId) {
      throw new ApplicationError("forbidden", "Vault mismatch");
    }

    return meta;
  }

  async meta(): Promise<VaultMeta> {
    const meta = await this.storage.get<VaultMeta>("meta");

    if (!meta) {
      throw new ApplicationError("not-found", "Vault not initialized");
    }

    return meta;
  }

  async files(): Promise<StoredFile[]> {
    const files = await this.storage.list<StoredFile>({ prefix: "file:" });

    return [...files.values()];
  }

  async file(id: string): Promise<StoredFile> {
    const stored = await this.storage.get<StoredFile>(`file:${id}`);

    if (!stored) {
      throw new ApplicationError("not-found", "File not found");
    }

    return stored;
  }

  operationResult(id: string): Promise<OperationResult | undefined> {
    return this.storage.get<OperationResult>(`op:${id}`);
  }

  async content(stored: StoredFile): Promise<Content> {
    if (stored.file.kind === "blob") {
      if (!stored.blob) {
        throw new Error("Missing blob");
      }

      return { kind: "blob", blob: stored.blob };
    }

    const chunks = await Promise.all(
      Array.from({ length: stored.chunks }, (_, index) =>
        this.storage.get<Uint8Array>(`text:${stored.file.id}:${index}`),
      ),
    );
    const byteLength = chunks.reduce((size, chunk) => {
      if (!chunk) {
        throw new Error("Missing CRDT chunk");
      }

      return size + chunk.length;
    }, 0);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const chunk of chunks) {
      if (!chunk) {
        throw new Error("Missing CRDT chunk");
      }

      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return { kind: "text", update: fromUint8Array(bytes) };
  }

  async setExclusions(meta: VaultMeta, exclusions: string[]): Promise<void> {
    meta.exclusions = [...new Set(exclusions)];
    meta.revision++;

    await this.storage.transaction(async (tx) => {
      await tx.put("meta", meta);
      await this.ensureAlarm(tx);

      for (const item of await this.files()) {
        if (!isExcluded(item.file.path, exclusions)) {
          await tx.put(`dirty:${item.file.path}`, true);
        }
      }
    });
  }

  async commit(meta: VaultMeta, files: StoredFile[], changes: OperationChanges): Promise<void> {
    await this.storage.transaction(async (tx) => {
      await tx.put("meta", meta);
      await this.ensureAlarm(tx);

      if (changes.removed) {
        await this.deleteFile(tx, changes.removed);
      }

      for (const write of changes.writes) {
        await this.writeFile(tx, write, files);
      }

      for (const path of changes.dirty) {
        await tx.put(`dirty:${path}`, true);
      }

      await tx.put(`op:${changes.result.opId}`, changes.result);
    });
  }

  async dirtyPaths(): Promise<string[]> {
    const paths = await this.storage.list<boolean>({ prefix: "dirty:" });

    return [...paths.keys()].map((key) => key.slice(6));
  }

  async markFlushed(meta: VaultMeta, paths: string[]): Promise<void> {
    meta.r2Revision = meta.revision;
    await this.storage.transaction(async (tx) => {
      await tx.put("meta", meta);

      for (const path of paths) {
        await tx.delete(`dirty:${path}`);
      }
    });
  }

  async schedule(): Promise<void> {
    const alarm = await this.storage.getAlarm();

    if (alarm === null || alarm > Date.now() + FLUSH_INTERVAL_MS) {
      await this.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  async scheduleMaintenance(hasSockets: boolean): Promise<void> {
    const hasDirty = (await this.storage.list({ prefix: "dirty:", limit: 1 })).size > 0;
    const hasTickets = (await this.storage.list({ prefix: "ticket:", limit: 1 })).size > 0;
    const needsFrequentMaintenance = hasDirty || hasSockets || hasTickets;
    let interval = 86_400_000;

    if (needsFrequentMaintenance) {
      interval = FLUSH_INTERVAL_MS;
    }

    await this.storage.setAlarm(Date.now() + interval);
  }

  private async ensureAlarm(tx: DurableObjectTransaction): Promise<void> {
    if ((await tx.getAlarm()) === null) {
      await tx.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }

  private async deleteFile(tx: DurableObjectTransaction, stored: StoredFile): Promise<void> {
    await tx.delete(`file:${stored.file.id}`);

    for (let index = 0; index < stored.chunks; index++) {
      await tx.delete(`text:${stored.file.id}:${index}`);
    }
  }

  private async writeFile(
    tx: DurableObjectTransaction,
    { stored, update }: FileWrite,
    files: StoredFile[],
  ): Promise<void> {
    await tx.put(`file:${stored.file.id}`, stored);

    if (!update) {
      return;
    }

    for (let index = 0; index < stored.chunks; index++) {
      const start = index * TEXT_CHUNK_SIZE;
      const chunk = update.slice(start, start + TEXT_CHUNK_SIZE);

      await tx.put(`text:${stored.file.id}:${index}`, chunk);
    }

    const old = files.find((entry) => entry.file.id === stored.file.id);

    if (!old) {
      return;
    }

    for (let index = stored.chunks; index < old.chunks; index++) {
      await tx.delete(`text:${stored.file.id}:${index}`);
    }
  }
}
