import { SyncEngine } from "@cf-sync/sync-core/sync/usecase/sync-engine";
import type { Miniflare } from "miniflare";

import { IndexedDbStore } from "../../packages/obsidian-plugin/src/infra/storage/indexed-db-store";
import { Vault } from "../../packages/sync-core/tests/helpers/sync-vault";
import { createRuntimeApi } from "./runtime-transport";

export function createRuntimeClient(mf: Miniflare, initial: Record<string, string>) {
	const vault = new Vault();
	for (const [path, text] of Object.entries(initial)) {
		vault.files.set(path, new TextEncoder().encode(text));
	}

	const deviceId = crypto.randomUUID();
	const engine = new SyncEngine({
		deviceId,
		deviceName: "Runtime device",
		vault,
		api: createRuntimeApi(mf, deviceId),
		store: new IndexedDbStore(`runtime-${crypto.randomUUID()}`),
		onStatus: () => {},
		onConflict: () => {},
		confirmInitial: () => Promise.resolve(true),
	});

	return { engine, text: (path: string) => vault.text(path) };
}
