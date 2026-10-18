import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileRecord } from "@cf-sync/protocol";
import { SyncState } from "@cf-sync/sync-core/sync/service/sync-state";
import { afterEach, expect, it, vi } from "vitest";

import { SqliteStore } from "../src/infra/storage/sqlite-store";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

it("rewrites legacy conflict records into IDs when the state loads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "cf-sync-sqlite-"));
	directories.push(directory);
	const path = join(directory, "state.sqlite");
	const conflict: FileRecord = {
		id: crypto.randomUUID(),
		path: "note.conflict.md",
		kind: "text",
		revision: 1,
		pathRevision: 1,
		digest: "",
		size: 0,
		conflict: true,
	};
	const legacyStore = new SqliteStore(path);
	const legacy = new SyncState(
		legacyStore,
		() => {},
		() => {},
	).data;
	Reflect.deleteProperty(legacy, "conflictIds");
	Reflect.set(legacy, "conflicts", [conflict]);
	await legacyStore.save(legacy);
	legacyStore.close();

	const store = new SqliteStore(path);
	const onConflict = vi.fn();
	const state = new SyncState(store, () => {}, onConflict);
	await state.load();
	state.reportConflict(conflict, "conflict");
	const loaded = await store.load();
	store.close();

	expect(onConflict).not.toHaveBeenCalled();
	expect(loaded).not.toHaveProperty("conflicts");
	expect(loaded?.conflictIds).toEqual([conflict.id]);
});
