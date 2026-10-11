import type { VaultPort } from "@cf-sync/sync-core/sync/ports/vault-port";

export class Vault implements VaultPort {
	files = new Map<string, Uint8Array>();

	list() {
		return Promise.resolve([...this.files.keys()]);
	}

	read(path: string) {
		const value = this.files.get(path);
		if (!value) {
			return Promise.reject(new Error("Missing file"));
		}

		return Promise.resolve(value);
	}

	write(path: string, bytes: Uint8Array) {
		this.files.set(path, bytes);

		return Promise.resolve();
	}

	writeIfUnchanged(path: string, expected: Uint8Array | undefined, bytes: Uint8Array) {
		const current = this.files.get(path);
		if (current?.length !== expected?.length) {
			return Promise.resolve(false);
		}

		if (current && expected) {
			const matchesBaseline = current.every((byte, index) => byte === expected[index]);
			if (!matchesBaseline) {
				return Promise.resolve(false);
			}
		}

		this.files.set(path, bytes);

		return Promise.resolve(true);
	}

	remove(path: string) {
		this.files.delete(path);

		return Promise.resolve();
	}

	async rename(oldPath: string, path: string) {
		this.files.set(path, await this.read(oldPath));
		this.files.delete(oldPath);
	}

	text(path: string) {
		return new TextDecoder().decode(this.files.get(path));
	}
}
