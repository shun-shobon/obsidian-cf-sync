import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { VaultPort } from "@cf-sync/sync-core";

import { resolveVaultPath } from "./vault-path";

export class FileVault implements VaultPort {
  constructor(readonly root: string) {}

  async safePath(path: string): Promise<string> {
    return resolveVaultPath(this.root, path);
  }

  async list(): Promise<string[]> {
    const paths = await listFiles(this.root, "");

    return paths.sort();
  }

  async read(path: string): Promise<Uint8Array> {
    const full = await this.safePath(path);
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const full = await this.safePath(path);
    const directory = dirname(full);

    await mkdir(directory, { recursive: true });
    await writeAtomic(full, bytes);
  }

  async writeIfUnchanged(
    path: string,
    expected: Uint8Array | undefined,
    bytes: Uint8Array,
  ): Promise<boolean> {
    const current = await this.read(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    });

    if (!matchesExpected(current, expected)) {
      return false;
    }

    await this.write(path, bytes);

    return true;
  }

  async remove(path: string): Promise<void> {
    await rm(await this.safePath(path), { force: true });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const source = await this.safePath(oldPath);
    const target = await this.safePath(newPath);

    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }
}

async function listFiles(directory: string, prefix: string): Promise<string[]> {
  const paths: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const path = prefix + entry.name;

    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic link is not supported: ${path}`);
    }

    if (entry.isDirectory()) {
      paths.push(...(await listFiles(join(directory, entry.name), path + "/")));
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`Unsupported file type: ${path}`);
    }

    paths.push(path);
  }

  return paths;
}

function matchesExpected(
  current: Uint8Array | undefined,
  expected: Uint8Array | undefined,
): boolean {
  if (expected === undefined) {
    return current === undefined;
  }

  if (current === undefined) {
    return false;
  }

  return Buffer.from(expected).equals(current);
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.cf-sync-${crypto.randomUUID()}.tmp`);

  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );

    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
