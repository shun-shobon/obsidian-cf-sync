import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncStatus } from "../src/sync/domain/sync-state";
import type { ApiPort } from "../src/sync/ports/api-port";
import { SyncEngine } from "../src/sync/usecase/sync-engine";
import { SyncOnce } from "../src/sync/usecase/sync-once";
import { Store } from "./helpers/memory-store";
import { Server } from "./helpers/sync-server";
import { Vault } from "./helpers/sync-vault";

const encode = (text: string) => new TextEncoder().encode(text);
const engines: SyncEngine[] = [];

afterEach(async () => {
	for (const engine of engines.splice(0)) {
		await engine.dispose();
	}
});

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});

	return { promise, resolve };
}

async function remoteVault(files: Record<string, string>) {
	const server = new Server();
	const vault = new Vault();
	for (const [path, text] of Object.entries(files)) {
		await vault.write(path, encode(text));
	}
	await new SyncOnce({ vault, store: new Store(), api: server.api }).run();

	return server;
}

async function localVault(files: Record<string, string>) {
	const vault = new Vault();
	for (const [path, text] of Object.entries(files)) {
		await vault.write(path, encode(text));
	}

	return vault;
}

interface ClientOptions {
	api?: ApiPort;
	confirmInitial?: (paths: string[]) => Promise<boolean>;
}

function client(server: Server, vault: Vault, store: Store, options: ClientOptions = {}) {
	const statuses: SyncStatus[] = [];
	const engine = new SyncEngine({
		deviceId: crypto.randomUUID(),
		deviceName: "Test device",
		vault,
		api: options.api ?? server.api,
		store,
		onStatus: (status) => statuses.push(status),
		onConflict() {},
		confirmInitial: options.confirmInitial ?? (async () => true),
	});
	engines.push(engine);

	return { engine, statuses };
}

/** Holds the first document download until released. */
function gatedDownload(server: Server) {
	const started = deferred();
	const gate = deferred();
	let gated = true;
	const api: ApiPort = {
		...server.api,
		async document(id) {
			if (gated) {
				gated = false;
				started.resolve();
				await gate.promise;
			}

			return await server.api.document(id);
		},
	};

	return { api, started: started.promise, release: gate.resolve };
}

function serverTexts(server: Server) {
	const texts = [...server.docs.values()].map(({ doc }) => doc.getText("content").toString());
	texts.sort();

	return texts;
}

describe("initial reconciliation", () => {
	it("keeps editors and captures responsive while the confirmation is open", async () => {
		const server = await remoteVault({ "note.md": "remote" });
		const vault = await localVault({ "note.md": "local", "draft.md": "draft" });
		const store = new Store();
		const dialog = deferred<boolean>();
		const confirmInitial = vi.fn(() => dialog.promise);
		const { engine } = client(server, vault, store, { confirmInitial });

		const starting = engine.start();
		await vi.waitFor(() => expect(confirmInitial).toHaveBeenCalledWith(["note.md"]));

		const doc = await engine.ensureDoc("draft.md", () => true);
		doc!.getText("content").insert(5, " typed");
		await vault.write("new.md", encode("new"));
		await engine.capture("new.md");
		expect(store.state!.initialized).toBe(false);

		dialog.resolve(true);
		await starting;

		await vi.waitFor(() => {
			expect(store.state!.pending).toHaveLength(0);
			expect(serverTexts(server)).toEqual(["draft typed", "local", "new", "remote"]);
		});
		expect(confirmInitial).toHaveBeenCalledTimes(1);
	});

	it("pauses without sending anything when the confirmation is cancelled", async () => {
		const server = await remoteVault({ "note.md": "remote" });
		const vault = await localVault({ "note.md": "local" });
		const store = new Store();
		const dialog = deferred<boolean>();
		const confirmInitial = vi.fn(() => dialog.promise);
		const { engine, statuses } = client(server, vault, store, { confirmInitial });
		const before = server.operations.length;

		const starting = engine.start();
		await vi.waitFor(() => expect(confirmInitial).toHaveBeenCalledOnce());
		await vault.write("new.md", encode("new"));
		await engine.capture("new.md");
		dialog.resolve(false);
		await starting;

		expect(statuses.at(-1)?.phase).toBe("paused");
		expect(store.state!.initialized).toBe(false);
		expect(server.operations).toHaveLength(before);
		expect(vault.text("note.md")).toBe("local");

		confirmInitial.mockResolvedValue(true);
		await engine.resume();

		expect(confirmInitial).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => {
			expect(store.state!.pending).toHaveLength(0);
			expect(serverTexts(server)).toEqual(["local", "new", "remote"]);
		});
	});

	it("does not ask again when the connection restarts while the confirmation is open", async () => {
		const server = await remoteVault({ "note.md": "remote" });
		const vault = await localVault({ "note.md": "local" });
		const store = new Store();
		const dialog = deferred<boolean>();
		const confirmInitial = vi.fn(() => dialog.promise);
		const { engine } = client(server, vault, store, { confirmInitial });

		const starting = engine.start();
		await vi.waitFor(() => expect(confirmInitial).toHaveBeenCalledOnce());
		const refreshing = engine.refresh();
		dialog.resolve(true);
		await Promise.all([starting, refreshing]);

		expect(confirmInitial).toHaveBeenCalledOnce();
		expect(store.state!.initialized).toBe(true);
		await vi.waitFor(() => {
			expect(store.state!.pending).toHaveLength(0);
			expect(serverTexts(server)).toEqual(["local", "remote"]);
		});
	});

	it("opens and edits other notes while an identical file downloads", async () => {
		const server = await remoteVault({ "same.md": "same" });
		const remoteId = [...server.docs.keys()][0];
		const vault = await localVault({ "same.md": "same", "draft.md": "draft" });
		const store = new Store();
		const download = gatedDownload(server);
		const { engine } = client(server, vault, store, { api: download.api });

		const starting = engine.start();
		await download.started;

		const doc = await engine.ensureDoc("draft.md", () => true);
		doc!.getText("content").insert(5, " typed");
		download.release();
		await starting;

		await vi.waitFor(() => {
			expect(store.state!.pending).toHaveLength(0);
			expect(serverTexts(server)).toEqual(["draft typed", "same"]);
		});
		expect(store.state!.files.find((file) => file.path === "same.md")?.id).toBe(remoteId);
		expect(vault.text("same.md")).toBe("same");
	});

	it("keeps a change to an identical file made while it downloads", async () => {
		const server = await remoteVault({ "same.md": "same" });
		const vault = await localVault({ "same.md": "same" });
		const store = new Store();
		const download = gatedDownload(server);
		const { engine } = client(server, vault, store, { api: download.api });

		const starting = engine.start();
		await download.started;

		await vault.write("same.md", encode("same edited"));
		await engine.capture("same.md");
		download.release();
		await starting;

		await vi.waitFor(() => {
			expect(store.state!.pending).toHaveLength(0);
			expect(serverTexts(server)).toEqual(["same", "same edited"]);
		});
		expect(vault.text("same.md")).toBe("same edited");
	});

	it("keeps an editor change that waits in the queue behind the download's adoption", async () => {
		const server = await remoteVault({ "same.md": "same" });
		const vault = await localVault({ "same.md": "same", "block.md": "block" });
		const store = new Store();
		const download = gatedDownload(server);
		const { engine } = client(server, vault, store, { api: download.api });

		const starting = engine.start();
		await download.started;
		const doc = await engine.ensureDoc("same.md", () => true);

		// Hold the queue so the adoption is queued before the editor's change.
		const reading = deferred();
		const readStarted = deferred();
		const read = vault.read.bind(vault);
		vi.spyOn(vault, "read").mockImplementation(async (path) => {
			if (path === "block.md") {
				readStarted.resolve();
				await reading.promise;
			}

			return await read(path);
		});
		const blocking = engine.capture("block.md");
		await readStarted.promise;
		download.release();
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
		doc!.getText("content").insert(4, " typed");
		reading.resolve();
		await Promise.all([blocking, starting]);

		await vi.waitFor(() => {
			expect(store.state!.pending).toHaveLength(0);
			expect(serverTexts(server)).toEqual(["block", "same", "same typed"]);
		});
	});
});
