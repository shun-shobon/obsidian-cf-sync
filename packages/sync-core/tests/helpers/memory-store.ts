import type { LocalState, StoredData, SyncStore } from "../../src";

export class Store implements SyncStore {
	state: LocalState | undefined;
	data = new Map<string, Uint8Array>();

	load() {
		return Promise.resolve(structuredClone(this.state));
	}

	async save(state: LocalState, data?: StoredData) {
		this.state = structuredClone(state);
		if (data) await this.put(data.key, data.value);
	}

	get(key: string) {
		return Promise.resolve(this.data.get(key)?.slice());
	}

	put(key: string, value: Uint8Array) {
		this.data.set(key, value.slice());

		return Promise.resolve();
	}

	delete(key: string) {
		this.data.delete(key);

		return Promise.resolve();
	}

	close() {}
}
