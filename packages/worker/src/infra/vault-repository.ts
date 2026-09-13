import { isExcluded, type Content, type OperationResult } from "@cf-sync/protocol";
import { fromUint8Array } from "js-base64";

import { ApplicationError } from "../domain/errors";
import {
  TEXT_CHUNK_SIZE,
  type FileWrite,
  type OperationChanges,
  type StoredFile,
  type VaultMeta,
} from "../domain/vault-state";

import { VaultMaintenance } from "./vault-maintenance";

export class VaultRepository {
  private readonly maintenance: VaultMaintenance;

  constructor(private readonly storage: DurableObjectStorage) {
    this.maintenance = new VaultMaintenance(storage);
  }

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

  async deletedContent(id: string): Promise<Content | undefined> {
    const stored = await this.storage.get<StoredFile>(`deleted:${id}`);
    if (!stored) {
      return undefined;
    }
    return this.content(stored);
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
      await this.maintenance.request("flush", tx);

      for (const item of await this.files()) {
        if (!isExcluded(item.file.path, exclusions)) {
          await tx.put(`dirty:${item.file.path}`, meta.revision);
        }
      }
    });
  }

  async commit(meta: VaultMeta, files: StoredFile[], changes: OperationChanges): Promise<void> {
    await this.storage.transaction(async (tx) => {
      await tx.put("meta", meta);
      await this.maintenance.request("flush", tx);

      if (changes.removed) {
        await this.deleteFile(tx, changes.removed);
      }

      for (const write of changes.writes) {
        await this.writeFile(tx, write, files);
      }

      for (const path of changes.dirty) {
        await tx.put(`dirty:${path}`, meta.revision);
      }

      await tx.put(`op:${changes.result.opId}`, changes.result);

      const touchesBlobs =
        changes.removed?.blob || changes.writes.some(({ stored }) => stored.blob);
      const replacesBlob = changes.writes.some(({ stored }) =>
        files.some((previous) => previous.file.id === stored.file.id && previous.blob),
      );

      if (touchesBlobs || replacesBlob) {
        await this.maintenance.request("blobs", tx);
      }
    });
  }

  async dirtyPaths(): Promise<string[]> {
    const paths = await this.storage.list<boolean>({ prefix: "dirty:" });

    return [...paths.keys()].map((key) => key.slice(6));
  }

  async markFlushed(meta: VaultMeta, paths: string[]): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const latest = await this.meta();
      latest.r2Revision = meta.revision;
      await tx.put("meta", latest);
      meta.r2Revision = meta.revision;
      for (const path of paths) {
        const revision = await tx.get<number>(`dirty:${path}`);
        if (revision !== undefined && revision <= meta.revision) {
          await tx.delete(`dirty:${path}`);
        }
      }
    });
  }

  private async deleteFile(tx: DurableObjectTransaction, stored: StoredFile): Promise<void> {
    await tx.delete(`file:${stored.file.id}`);
    if (stored.file.kind === "text") {
      await tx.put(`deleted:${stored.file.id}`, stored);
      return;
    }

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
