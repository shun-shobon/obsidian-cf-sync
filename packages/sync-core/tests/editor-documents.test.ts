import { digest } from "@cf-sync/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncEngine } from "../src/sync/usecase/sync-engine";
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

function client(server: Server, vault: Vault, store = new Store()) {
	const engine = new SyncEngine({
		deviceId: crypto.randomUUID(),
		deviceName: "Test device",
		vault,
		api: server.api,
		store,
		onStatus() {},
		onConflict() {},
		confirmInitial: async () => true,
	});
	engines.push(engine);

	return engine;
}

async function stop(engine: SyncEngine) {
	engines.splice(engines.indexOf(engine), 1);
	await engine.dispose();
}

async function started() {
	const server = new Server();
	const vault = new Vault();
	const store = new Store();
	await vault.write("note.md", encode("base"));
	const engine = client(server, vault, store);
	await engine.start();
	const remote = [...server.docs.values()][0]!;

	return { server, vault, store, engine, remote };
}

async function editRemotely(server: Server, index: number, text: string) {
	const remote = [...server.docs.values()][0]!;
	remote.doc.getText("content").insert(index, text);
	remote.file.digest = await digest(encode(remote.doc.getText("content").toString()));
	remote.file.revision = ++server.revision;
}

describe("documents held by an editor", () => {
	it("leaves writing the file to the editor when the editor changes the document", async () => {
		const { server, vault, store, engine, remote } = await started();
		const write = vi.spyOn(vault, "write");
		const doc = (await engine.ensureDoc("note.md", () => true))!;

		doc.getText("content").insert(4, " typed");

		await vi.waitFor(async () => {
			expect(remote.doc.getText("content").toString()).toBe("base typed");
			expect(store.state!.pending).toHaveLength(0);
		});
		expect(write).not.toHaveBeenCalled();
		expect(vault.text("note.md")).toBe("base");
		expect(server.operations.at(-1)).toMatchObject({ type: "edit" });
	});

	it("keeps newer editor text when the editor saves an older buffer", async () => {
		const { vault, store, engine, remote } = await started();
		const doc = (await engine.ensureDoc("note.md", () => true))!;

		doc.getText("content").insert(4, " one");
		doc.getText("content").insert(8, " two");
		await vault.write("note.md", encode("base one"));
		await engine.capture("note.md");

		expect(doc.getText("content").toString()).toBe("base one two");

		await vi.waitFor(async () => {
			expect(remote.doc.getText("content").toString()).toBe("base one two");
			expect(store.state!.pending).toHaveLength(0);
		});

		await vault.write("note.md", encode("base one two"));
		await engine.capture("note.md");

		expect(store.state!.pending).toHaveLength(0);
		expect(store.state!.files[0]!.diskDigest).toBe(await digest(encode("base one two")));
	});

	it("applies a remote update to the editor document without writing the file", async () => {
		const { server, vault, store, engine, remote } = await started();
		const doc = (await engine.ensureDoc("note.md", () => true))!;
		// An unsaved editor edit leaves the file behind the document.
		doc.getText("content").insert(0, "local ");
		await vi.waitFor(() => {
			expect(remote.doc.getText("content").toString()).toBe("local base");
			expect(store.state!.pending).toHaveLength(0);
		});

		await editRemotely(server, 10, " remote");
		await vi.waitFor(async () => {
			await engine.syncNow();
			expect(doc.getText("content").toString()).toBe("local base remote");
		});

		expect(vault.text("note.md")).toBe("base");
	});

	it("writes a remote update to the file once the editor releases the document", async () => {
		const { server, vault, engine } = await started();
		const doc = (await engine.ensureDoc("note.md", () => true))!;
		engine.releaseDoc(doc);

		await editRemotely(server, 4, " remote");
		await vi.waitFor(async () => {
			await engine.syncNow();
			expect(vault.text("note.md")).toBe("base remote");
		});
	});

	it("does not hold a document the editor could not attach", async () => {
		const { vault, store, engine, remote } = await started();

		expect(await engine.ensureDoc("note.md", () => false)).toBeUndefined();

		await vault.write("note.md", encode("base edited"));
		await engine.capture("note.md");

		await vi.waitFor(() => {
			expect(remote.doc.getText("content").toString()).toBe("base edited");
			expect(store.state!.pending).toHaveLength(0);
		});
	});

	it("removes a remotely deleted file whose editor has not saved its sent text", async () => {
		const { server, vault, store, engine, remote } = await started();
		const doc = (await engine.ensureDoc("note.md", () => true))!;
		doc.getText("content").insert(4, " sent");
		await vi.waitFor(() => {
			expect(remote.doc.getText("content").toString()).toBe("base sent");
			expect(store.state!.pending).toHaveLength(0);
		});

		server.docs.delete(remote.file.id);
		server.revision++;
		await vi.waitFor(async () => {
			await engine.syncNow();
			expect(await vault.exists("note.md")).toBe(false);
		});
	});

	it("restores sent editor text that was never saved before a restart", async () => {
		const { server, vault, store, engine, remote } = await started();
		const doc = (await engine.ensureDoc("note.md", () => true))!;
		doc.getText("content").insert(4, " unsaved");
		await vi.waitFor(() => {
			expect(remote.doc.getText("content").toString()).toBe("base unsaved");
			expect(store.state!.pending).toHaveLength(0);
		});
		await stop(engine);

		expect(vault.text("note.md")).toBe("base");

		const next = client(server, vault, store);
		await next.start();

		expect(vault.text("note.md")).toBe("base unsaved");
		expect(remote.doc.getText("content").toString()).toBe("base unsaved");
		expect(store.state!.pending).toHaveLength(0);
	});
});
