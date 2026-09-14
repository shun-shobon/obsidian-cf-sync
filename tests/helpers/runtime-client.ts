import { SyncEngine } from "@cf-sync/sync-core/sync/usecase/sync-engine";
import type { Miniflare } from "miniflare";

import { IndexedDbStore } from "../../packages/obsidian-plugin/src/sync/infra/storage/indexed-db-store";

import { memoryVault } from "./memory-vault";
import { createRuntimeApi } from "./runtime-transport";

export function createRuntimeClient(mf: Miniflare, initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([path, text]) => [path, new TextEncoder().encode(text)]),
  );
  const deviceId = crypto.randomUUID();
  const engine = new SyncEngine({
    deviceId,
    deviceName: "Runtime device",
    vault: memoryVault(files),
    api: createRuntimeApi(mf, deviceId),
    store: new IndexedDbStore(`runtime-${crypto.randomUUID()}`),
    onStatus: () => {},
    onConflict: () => {},
    confirmInitial: async () => true,
  });

  return { engine, text: (path: string) => new TextDecoder().decode(files.get(path)) };
}
