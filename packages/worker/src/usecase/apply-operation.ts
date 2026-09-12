import { isExcluded, type Operation, type OperationResult } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";
import type { OperationChanges, StoredFile, VaultMeta } from "../domain/vault-state";

import { applyContentChange } from "./operation/content-change";
import { applyDeletion } from "./operation/deletion";
import { applyMove } from "./operation/move";
import type { VaultStore, VaultNotifications, BlobVerifier } from "./ports";

export class ApplyOperation {
  constructor(
    private readonly repository: VaultStore,
    private readonly sockets: VaultNotifications,
    private readonly blobs: BlobVerifier,
  ) {}

  async execute(operation: Operation): Promise<OperationResult> {
    const previous = await this.repository.operationResult(operation.opId);
    if (previous) return previous;

    const meta = await this.repository.meta();
    const files = await this.repository.files();
    const current = files.find((item) => item.file.id === operation.fileId);
    this.assertIncluded(operation, current, meta);
    const changes = await this.prepare(operation, current, files, meta);

    await this.repository.commit(meta, files, changes);
    await this.repository.schedule();
    this.broadcast(operation, changes.result);
    return changes.result;
  }

  private assertIncluded(
    operation: Operation,
    current: StoredFile | undefined,
    meta: VaultMeta,
  ): void {
    const currentExcluded = current && isExcluded(current.file.path, meta.exclusions);
    const targetExcluded = "path" in operation && isExcluded(operation.path, meta.exclusions);
    if (currentExcluded || targetExcluded)
      throw new ApplicationError("conflict", "Path is excluded");
  }

  private async prepare(
    operation: Operation,
    current: StoredFile | undefined,
    files: StoredFile[],
    meta: VaultMeta,
  ): Promise<OperationChanges> {
    const changes: OperationChanges = {
      result: {
        opId: operation.opId,
        revision: meta.revision,
        previousRevision: current?.file.revision ?? null,
        previousPathRevision: current?.file.pathRevision ?? null,
        file: null,
        conflict: false,
      },
      writes: [],
      dirty: new Set(),
    };

    switch (operation.type) {
      case "move":
        applyMove(operation, current, files, meta, changes);
        break;
      case "delete":
        await applyDeletion(operation, current, files, meta, changes, this.repository);
        break;
      case "create":
      case "edit":
        await applyContentChange(
          operation,
          current,
          files,
          meta,
          changes,
          this.repository,
          this.blobs,
        );
        break;
    }

    changes.result.revision = meta.revision;
    return changes;
  }

  private broadcast(operation: Operation, result: OperationResult): void {
    // Full document state travels over HTTP; notifications remain small for large notes.
    this.sockets.broadcast({
      type: "changed",
      revision: result.revision,
      fileId: operation.fileId,
    });
    if (result.file && result.file.id !== operation.fileId) {
      this.sockets.broadcast({
        type: "changed",
        revision: result.revision,
        fileId: result.file.id,
      });
    }
  }
}
