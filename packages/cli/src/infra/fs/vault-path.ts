import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { ifExists } from "./error-code";
import { metadataName } from "./vault-binding";

export async function resolveVaultPath(root: string, path: string): Promise<string> {
	const parts = path.split("/");
	const hasUnsafePart = parts.some((part) => !part || part === "." || part === "..");
	const isMetadata = parts[0] === metadataName;

	if (hasUnsafePart || isMetadata) {
		throw new Error(`Unsafe Vault path: ${path}`);
	}

	let current = root;

	for (const part of parts) {
		current = join(current, part);
		const stat = await ifExists(lstat(current));

		if (stat?.isSymbolicLink() === true) {
			throw new Error(`Symbolic link is not supported: ${path}`);
		}
	}

	return current;
}
