import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateMetadataFiles } from "../fs/metadata-files";

export async function lockVault(directory: string): Promise<() => Promise<void>> {
  await validateMetadataFiles(directory, [
    "lock.sqlite",
    "lock.sqlite-journal",
    "lock.sqlite-wal",
    "lock.sqlite-shm",
  ]);

  const db = new DatabaseSync(join(directory, "lock.sqlite"));

  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    throw new Error("Another process is using this Vault", { cause: error });
  }

  return async () => {
    db.exec("ROLLBACK");
    db.close();
  };
}
