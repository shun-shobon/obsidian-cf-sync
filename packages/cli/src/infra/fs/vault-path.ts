import { lstat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { metadataName } from "./vault-binding";

export async function resolveVaultPath(root: string, path: string): Promise<string> {
  const parts = path.split("/");
  const hasUnsafePart = parts.some((part) => !part || part === "." || part === "..");
  const isMetadata = parts[0] === metadataName;

  if (path.includes("\\") || hasUnsafePart || isMetadata) {
    throw new Error(`Unsafe Vault path: ${path}`);
  }

  const full = resolve(root, path);

  if (!full.startsWith(root + sep)) {
    throw new Error(`Unsafe Vault path: ${path}`);
  }

  let current = root;

  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    });

    if (stat?.isSymbolicLink()) {
      throw new Error(`Symbolic link is not supported: ${path}`);
    }
  }

  return full;
}
