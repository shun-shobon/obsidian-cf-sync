import { equalFlat } from "lib0/array";

import type { VaultPort } from "../../src/sync/ports/vault-port";

export class Vault implements VaultPort {
	files = new Map<string, Uint8Array>();

	list() {
		return Promise.resolve([...this.files.keys()]);
	}

	exists(path: string) {
		return Promise.resolve(this.files.has(path));
	}

	read(path: string) {
		const value = this.files.get(path);
		if (!value) {
			return Promise.reject(new Error("Missing file"));
		}

		return Promise.resolve(value);
	}

	write(path: string, bytes: Uint8Array) {
		this.files.set(path, bytes.slice());

		return Promise.resolve();
	}

	writeIfUnchanged(path: string, expected: Uint8Array | undefined, bytes: Uint8Array) {
		if (!matchesExpected(this.files.get(path), expected)) {
			return Promise.resolve(false);
		}

		this.files.set(path, bytes.slice());

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

function matchesExpected(current: Uint8Array | undefined, expected: Uint8Array | undefined) {
	if (current === undefined || expected === undefined) {
		return current === expected;
	}

	return equalFlat(current, expected);
}
