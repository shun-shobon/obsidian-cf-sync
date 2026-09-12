import { conflictPath, pathSchema } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";
import type { StoredFile } from "../domain/vault-state";

export function hasPathCollision(path: string, files: StoredFile[], except?: string): boolean {
  const key = path.normalize("NFC").toLowerCase();

  return files.some(({ file }) => {
    if (file.id === except) return false;
    const other = file.path.normalize("NFC").toLowerCase();

    return other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`);
  });
}

export function allocateConflictPath(path: string, files: StoredFile[], id: string): string {
  let candidate = conflictPath(path, id);

  // A colliding parent file cannot become a directory; preserve the copy at vault root.
  if (hasPathCollision(candidate, files)) {
    candidate = conflictPath(path.slice(path.lastIndexOf("/") + 1), id);
  }

  if (hasPathCollision(candidate, files) || !pathSchema.safeParse(candidate).success) {
    throw new ApplicationError("conflict", "Cannot allocate conflict path");
  }

  return candidate;
}
