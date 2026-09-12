import type { Miniflare } from "miniflare";

import { IndexedDbStore } from "../../packages/obsidian-plugin/src/sync/infra/storage/indexed-db-store";
import { SyncEngine } from "../../packages/obsidian-plugin/src/sync/usecase/sync-engine";

import { memoryVault } from "./memory-vault";
import { createRuntimeApi } from "./runtime-transport";

export function createRuntimeClient(mf: Miniflare, initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([path, text]) => [path, new TextEncoder().encode(text)]),
  );
  const engine = new SyncEngine({
    vault: memoryVault(files),
    api: createRuntimeApi(mf),
    store: new IndexedDbStore(`runtime-${crypto.randomUUID()}`),
    onStatus: () => {},
    onConflict: () => {},
    confirmInitial: async () => true,
  });

  return { engine, text: (path: string) => new TextDecoder().decode(files.get(path)) };
}
