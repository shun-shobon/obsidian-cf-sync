import { type Operation } from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";

import type { FileWrite, OperationChanges, StoredFile, VaultMeta } from "../../domain/vault-state";
import { allocateConflictPath } from "../../service/path-conflicts";
import type { VaultStore } from "../ports";

export async function applyDeletion(
  operation: Extract<Operation, { type: "delete" }>,
  current: StoredFile | undefined,
  files: StoredFile[],
  meta: VaultMeta,
  changes: OperationChanges,
  repository: VaultStore,
): Promise<void> {
  if (!current) {
    return;
  }

  meta.revision++;
  changes.removed = current;
  changes.dirty.add(current.file.path);

  if (operation.baseRevision === current.file.revision) {
    return;
  }

  const id = crypto.randomUUID();
  const file = {
    ...current.file,
    id,
    path: allocateConflictPath(current.file.path, files, id),
    revision: meta.revision,
    pathRevision: meta.revision,
    conflict: true,
  };
  const content = await repository.content(current);
  const write: FileWrite = { stored: { ...current, file } };

  if (content.kind === "text") {
    write.update = toUint8Array(content.update);
  }

  changes.writes.push(write);
  changes.dirty.add(file.path);
  changes.result.file = file;
  changes.result.conflict = true;
  changes.result.message = "Concurrent edit preserved before deletion";
}
