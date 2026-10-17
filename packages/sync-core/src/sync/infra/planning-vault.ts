import { equalFlat } from "lib0/array";

import type { VaultPort } from "../ports/vault-port";

export class PlanningVault implements VaultPort {
	readonly changed = new Map<string, Uint8Array | undefined>();

	constructor(private readonly source: VaultPort) {}

	async list(): Promise<string[]> {
		const paths = new Set(await this.source.list());

		for (const [path, bytes] of this.changed) {
			if (bytes === undefined) {
				paths.delete(path);
			} else {
				paths.add(path);
			}
		}

		return [...paths];
	}

	async exists(path: string): Promise<boolean> {
		if (this.changed.has(path)) {
			return this.changed.get(path) !== undefined;
		}

		return await this.source.exists(path);
	}

	async read(path: string): Promise<Uint8Array> {
		if (!this.changed.has(path)) {
			return await this.source.read(path);
		}

		const bytes = this.changed.get(path);

		if (bytes === undefined) {
			throw new Error(`File missing: ${path}`);
		}

		return bytes.slice();
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		const present = await this.exists(path);

		if (present && equalFlat(await this.read(path), bytes)) {
			return;
		}

		this.changed.set(path, bytes.slice());
	}

	async writeIfUnchanged(
		path: string,
		expected: Uint8Array | undefined,
		bytes: Uint8Array,
	): Promise<boolean> {
		const present = await this.exists(path);
		const expectedPresent = expected !== undefined;

		if (present !== expectedPresent) {
			return false;
		}

		if (expected !== undefined && !equalFlat(await this.read(path), expected)) {
			return false;
		}

		await this.write(path, bytes);

		return true;
	}

	remove(path: string): Promise<void> {
		this.changed.set(path, undefined);

		return Promise.resolve();
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const bytes = await this.read(oldPath);
		await this.write(newPath, bytes);
		await this.remove(oldPath);
	}
}
