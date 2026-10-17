import type { FileRecord } from "@cf-sync/protocol";
import { describe, expect, it, vi } from "vitest";

import type { LocalState } from "../src/sync/domain/sync-state";
import { SyncState } from "../src/sync/service/sync-state";
import { SyncOnce } from "../src/sync/usecase/sync-once";
import { Store } from "./helpers/memory-store";
import { Server } from "./helpers/sync-server";
import { Vault } from "./helpers/sync-vault";

function conflictFile(): FileRecord {
	return {
		id: crypto.randomUUID(),
		path: "note.conflict.md",
		kind: "text",
		revision: 1,
		pathRevision: 1,
		digest: "",
		size: 0,
		conflict: true,
	};
}

function legacyState(conflicts: FileRecord[]): LocalState {
	const state = new SyncState(
		new Store(),
		() => {},
		() => {},
	).data;
	Reflect.deleteProperty(state, "conflictIds");
	Reflect.set(state, "conflicts", conflicts);

	return state;
}

describe("conflict reports", () => {
	it("does not notify again for a conflict stored in the legacy format", async () => {
		const reported = conflictFile();
		const store = new Store();
		store.state = legacyState([reported]);
		const onConflict = vi.fn();
		const state = new SyncState(store, () => {}, onConflict);

		await state.load();
		state.reportConflict(reported, "conflict");

		expect(onConflict).not.toHaveBeenCalled();
		expect(store.state.conflictIds).toEqual([reported.id]);
		expect(store.state).not.toHaveProperty("conflicts");
	});

	it("notifies a new conflict only once, also after a restart", async () => {
		const store = new Store();
		store.state = legacyState([]);
		const onConflict = vi.fn();
		const first = new SyncState(store, () => {}, onConflict);
		await first.load();
		const file = conflictFile();

		first.reportConflict(file, "conflict");
		first.reportConflict(file, "conflict");
		await first.persist();
		const restarted = new SyncState(store, () => {}, onConflict);
		await restarted.load();
		restarted.reportConflict(file, "conflict");

		expect(onConflict).toHaveBeenCalledOnce();
		expect(store.state.conflictIds).toEqual([file.id]);
	});

	it("forgets the report of a file deleted on the server", async () => {
		const server = new Server();
		const options = { vault: new Vault(), store: new Store(), api: server.api };
		await options.vault.write("note.md", new TextEncoder().encode("hello"));
		await new SyncOnce(options).run();
		const [fileId] = server.docs.keys();
		options.store.state!.conflictIds = [fileId!];

		server.docs.delete(fileId!);
		server.revision++;
		await new SyncOnce(options).run();

		expect(options.store.state!.conflictIds).toEqual([]);
		expect(await options.vault.exists("note.md")).toBe(false);
	});
});
