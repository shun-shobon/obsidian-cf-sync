import type { VaultPort } from "@cf-sync/sync-core/sync/ports/vault-port";

export function memoryVault(files: Map<string, Uint8Array>): VaultPort {
	return {
		list() {
			return Promise.resolve([...files.keys()]);
		},

		exists(path) {
			return Promise.resolve(files.has(path));
		},

		read(path) {
			const bytes = files.get(path);
			if (!bytes) {
				return Promise.reject(new Error(`Missing ${path}`));
			}
			return Promise.resolve(bytes);
		},

		write(path, bytes) {
			files.set(path, new Uint8Array(bytes));
			return Promise.resolve();
		},

		remove(path) {
			files.delete(path);
			return Promise.resolve();
		},

		rename(oldPath, newPath) {
			const value = files.get(oldPath);
			if (!value) {
				return Promise.reject(new Error("Missing rename"));
			}
			files.set(newPath, value);
			files.delete(oldPath);
			return Promise.resolve();
		},

		writeIfUnchanged(path, expected, bytes) {
			const current = files.get(path);
			if (!matchesExpected(current, expected)) {
				return Promise.resolve(false);
			}

			files.set(path, new Uint8Array(bytes));
			return Promise.resolve(true);
		},
	};
}

function matchesExpected(
	current: Uint8Array | undefined,
	expected: Uint8Array | undefined,
): boolean {
	if (expected === undefined) {
		return current === undefined;
	}

	if (current === undefined || current.length !== expected.length) {
		return false;
	}

	return current.every((byte, index) => byte === expected[index]);
}
