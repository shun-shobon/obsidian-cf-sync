import type { LocalState } from "../domain/sync-state";
import type { StoredData, SyncStore } from "../ports/sync-store";

export class PlanningStore implements SyncStore {
  private readonly data = new Map<string, Uint8Array | undefined>();

  constructor(private readonly source: SyncStore) {}

  async load(): Promise<LocalState | undefined> {
    return structuredClone(await this.source.load());
  }

  async save(_state: LocalState, data?: StoredData): Promise<void> {
    if (data) {
      await this.put(data.key, data.value);
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (this.data.has(key)) {
      return this.data.get(key)?.slice();
    }

    return (await this.source.get(key))?.slice();
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.data.set(key, value.slice());
  }

  async delete(key: string): Promise<void> {
    this.data.set(key, undefined);
  }

  close(): void {}
}
