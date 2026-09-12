import type { Operation } from "@cf-sync/protocol";

import { ApplicationError } from "../../domain/errors";
import type { OperationChanges, StoredFile, VaultMeta } from "../../domain/vault-state";
import { hasPathCollision } from "../../service/path-conflicts";

export function applyMove(
  operation: Extract<Operation, { type: "move" }>,
  current: StoredFile | undefined,
  files: StoredFile[],
  meta: VaultMeta,
  changes: OperationChanges,
): void {
  if (!current) {
    throw new ApplicationError("not-found", "File not found");
  }

  const pathChanged = current.file.pathRevision !== operation.basePathRevision;
  const destinationOccupied = hasPathCollision(operation.path, files, operation.fileId);

  if (pathChanged || destinationOccupied) {
    changes.result.conflict = true;
    changes.result.message = "Move rejected: path changed or destination occupied";
    changes.result.file = current.file;
    return;
  }

  meta.revision++;
  changes.dirty.add(current.file.path);
  changes.dirty.add(operation.path);
  const file = {
    ...current.file,
    path: operation.path,
    pathRevision: meta.revision,
    revision: meta.revision,
  };
  changes.result.file = file;
  changes.writes.push({ stored: { ...current, file } });
}
