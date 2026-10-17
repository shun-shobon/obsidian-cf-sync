import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";

import { bindingSchema } from "../../domain/binding";
import type { Binding } from "../../domain/binding";
import { hasErrorCode, ifExists } from "./error-code";

export const metadataName = ".cf-sync";

const metadataFiles = [
	"vault.json",
	"state.sqlite",
	"state.sqlite-wal",
	"state.sqlite-shm",
	"lock.sqlite",
	"lock.sqlite-journal",
];

export async function ensureMetadataDirectory(root: string): Promise<string> {
	const directory = join(root, metadataName);

	await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
		if (!hasErrorCode(error, "EEXIST")) {
			throw error;
		}
	});
	await validateMetadata(directory);

	return directory;
}

export async function validateMetadata(metadata: string): Promise<void> {
	const stat = await lstat(metadata);

	if (!stat.isDirectory()) {
		throw new Error("Vault metadata must be a real directory");
	}

	for (const name of metadataFiles) {
		const file = await ifExists(lstat(join(metadata, name)));

		if (file && !file.isFile()) {
			throw new Error(`Invalid metadata file: ${name}`);
		}
	}
}

export async function assertUninitialized(metadata: string): Promise<void> {
	const existing = await ifExists(lstat(join(metadata, "vault.json")));

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
