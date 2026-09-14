import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";

import { bindingSchema, type Binding } from "../../domain/connection";

import { validateMetadataFiles } from "./metadata-files";

export const metadataName = ".cf-sync";

async function validateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Vault metadata must be a real directory");
  }
}

export async function ensureMetadataDirectory(root: string): Promise<string> {
  const directory = join(await realpath(root), metadataName);

  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });
  await validateDirectory(directory);

  return directory;
}

export async function validateMetadata(metadata: string): Promise<void> {
  await validateDirectory(metadata);
  await validateMetadataFiles(metadata, [
    "vault.json",
    "state.sqlite",
    "lock.sqlite",
    "state.sqlite-wal",
    "state.sqlite-shm",
  ]);
}

export async function assertUninitialized(metadata: string): Promise<void> {
  const existing = await lstat(join(metadata, "vault.json")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    },
  );

  if (existing) {
    throw new Error("This directory is already initialized");
  }
}

export async function readBinding(metadata: string): Promise<Binding> {
  const text = await readFile(join(metadata, "vault.json"), "utf8");

  return v.parse(bindingSchema, JSON.parse(text));
}

export async function writeBinding(metadata: string, binding: Binding): Promise<void> {
  await writeFile(join(metadata, "vault.json"), JSON.stringify(binding, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
