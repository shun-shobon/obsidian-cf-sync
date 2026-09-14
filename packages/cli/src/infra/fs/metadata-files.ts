import { lstat } from "node:fs/promises";
import { join } from "node:path";

export async function validateMetadataFiles(directory: string, names: string[]): Promise<void> {
  for (const name of names) {
    const stat = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    });

    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new Error(`Invalid metadata file: ${name}`);
    }
  }
}
