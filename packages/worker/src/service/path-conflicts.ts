import { conflictPath, pathSchema } from "@cf-sync/protocol";
import * as v from "valibot";

import { ApplicationError } from "../domain/errors";
import type { StoredFile } from "../domain/vault-state";

export function hasPathCollision(path: string, files: StoredFile[], except?: string): boolean {
  const key = path.normalize("NFC").toLowerCase();

  return files.some(({ file }) => {
    if (file.id === except) {
      return false;
    }

    const other = file.path.normalize("NFC").toLowerCase();

    const samePath = other === key;
    const containsExistingFile = other.startsWith(`${key}/`);
    const insideExistingFile = key.startsWith(`${other}/`);

    return samePath || containsExistingFile || insideExistingFile;
  });
}

export function allocateConflictPath(path: string, files: StoredFile[], id: string): string {
  let candidate = conflictPath(path, id);

  // A colliding parent file cannot become a directory; preserve the copy at vault root.

  if (hasPathCollision(candidate, files)) {
    candidate = conflictPath(path.slice(path.lastIndexOf("/") + 1), id);
  }

  const occupied = hasPathCollision(candidate, files);
  const validPath = v.is(pathSchema, candidate);

  if (occupied || !validPath) {
    throw new ApplicationError("conflict", "Cannot allocate conflict path");
  }

  return candidate;
}
