import "fake-indexeddb/auto";
import { digest } from "@cf-sync/protocol";
import type { Operation, ServerMessage } from "@cf-sync/protocol";
import type { ApiPort } from "@cf-sync/sync-core/sync/ports/api-port";
import { SyncEngine } from "@cf-sync/sync-core/sync/usecase/sync-engine";
import { afterEach, expect, it, vi } from "vitest";

import { Server } from "../../sync-core/tests/helpers/sync-server";
import { Vault } from "../../sync-core/tests/helpers/sync-vault";
import { IndexedDbStore } from "../src/infra/storage/indexed-db-store";

const encode = (text: string) => new TextEncoder().encode(text);
const engines: SyncEngine[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
	for (const engine of engines) engine.pause();
	for (const release of releases.splice(0)) release();
	for (const engine of engines.splice(0)) await engine.dispose();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}

// The production DO serializes commits and broadcasts deltas before acknowledging.
class RealtimeServer {
	readonly server = new Server();
	readonly peers = new Map<string, (message: ServerMessage) => void>();
	private serial: Promise<unknown> = Promise.resolve();
	beforeEdit: (() => Promise<void>) | undefined;

	api(deviceId: string): ApiPort {
		const operate = async (operation: Operation) => {
			if (operation.type === "edit") await this.beforeEdit?.();
			const result = this.serial.then(async () => {
				const applied = await this.server.api.operate(operation);
				for (const peer of this.peers.values()) {
					if (operation.type === "edit" && operation.content.kind === "text" && applied.file) {
						peer({
							type: "text",
							fileId: applied.file.id,
							file: applied.file,
							update: operation.content.update,
							revision: applied.revision,
							deviceId,
						});
					} else {
						peer({ type: "changed", fileId: operation.fileId, revision: applied.revision });
					}
				}
				return applied;
			});
			this.serial = result.catch(() => {});
			return await result;
		};
		return {
			...this.server.api,
			operate,
			connect: async (onMessage) => {
				this.peers.set(deviceId, onMessage);
				return {
					close: () => {
						this.peers.delete(deviceId);
					},
					send: (message) => {
						if (message.type === "presence") {
							for (const [id, peer] of this.peers)
								if (id !== deviceId) peer({ ...message, deviceId });
						} else {
							void operate(message.operation).then((result) =>
								onMessage({ type: "operation-result", result }),
							);
						}
					},
				};
			},
		};
	}
}
function client(hub: RealtimeServer, deviceId: string, vault = new Vault()) {
	const api = hub.api(deviceId);
	const store = new IndexedDbStore(crypto.randomUUID());
	const engine = new SyncEngine({
		deviceId,
		deviceName: deviceId,
		vault,
		api,
		store,
		onStatus() {},
		onConflict() {},
		confirmInitial: async () => true,
	});
	engines.push(engine);
	return { engine, vault, api, store };
}

it("converges five continuously editing devices without manual synchronization", async () => {
	const hub = new RealtimeServer();
	const clients = Array.from({ length: 5 }, (_, index) => client(hub, `device-${index}`));
	await clients[0]!.vault.write("note.md", encode("base"));
	for (const { engine } of clients) await engine.start();
	const docs = await Promise.all(
		clients.map(({ engine }) => engine.ensureDoc("note.md", () => true)),
	);
	for (let round = 0; round < 4; round++) {
		docs.forEach((doc, index) => doc!.getText("content").insert(0, `[${index}:${round}]`));
		await new Promise((resolve) => {
			setTimeout(resolve, 70);
		});
	}
	await vi.waitFor(
		async () => {
			const expected = [...hub.server.docs.values()][0]!.doc.getText("content").toString();
			for (const [index, { store }] of clients.entries()) {
				expect(docs[index]!.getText("content").toString()).toBe(expected);
				expect((await store.load())!.pending).toHaveLength(0);
			}
			for (let device = 0; device < 5; device++)
				for (let round = 0; round < 4; round++) expect(expected).toContain(`[${device}:${round}]`);
		},
		{ timeout: 5_000 },
	);
});

it("persists new local edits while the previous operation is awaiting its response", async () => {
	const hub = new RealtimeServer();
	const { engine, vault, store } = client(hub, "writer");
	await vault.write("note.md", encode("base"));
	await engine.start();
	const doc = (await engine.ensureDoc("note.md", () => true))!;
	const entered = deferred(),
		release = deferred();
	hub.beforeEdit = async () => {
		entered.resolve();
		await release.promise;
	};
	doc.getText("content").insert(4, "A");
	await entered.promise;
	doc.getText("content").insert(5, "B");
	await vi.waitFor(async () => {
		expect((await store.load())!.pending.length).toBeGreaterThanOrEqual(2);
	});
	release.resolve();
	await vi.waitFor(async () => expect((await store.load())!.pending).toHaveLength(0));
});

it("keeps text and cursor updates moving while an attachment upload is held", async () => {
	const hub = new RealtimeServer();
	const first = client(hub, "first"),
		second = client(hub, "second");
	await first.vault.write("note.md", encode("base"));
	await first.engine.start();
	await second.engine.start();
	const doc = (await first.engine.ensureDoc("note.md", () => true))!;
	const remote = (await second.engine.ensureDoc("note.md", () => true))!;
	first.engine.getAwareness(doc);
	const awareness = second.engine.getAwareness(remote)!;
	const entered = deferred(),
		release = deferred();
	first.api.upload = async (key, bytes, hash) => {
		entered.resolve();
		await release.promise;
		return { key, size: bytes.length, digest: hash };
	};
	await first.vault.write("image.png", new Uint8Array([1, 2, 3]));
	await first.engine.capture("image.png");
	await entered.promise;
	doc.getText("content").insert(4, "live");
	first.engine.setSelection({}, doc, 2, 3);
	await vi.waitFor(() => {
		expect(remote.getText("content").toString()).toBe("baselive");
		expect((awareness.getStates().get(doc.clientID) as { user: { name: string } }).user.name).toBe(
			"first",
		);
	});
	first.engine.pause();
	release.resolve();
});

it("opens a new editing document and receives text while an attachment download is held", async () => {
	const hub = new RealtimeServer();
	const first = client(hub, "first"),
		second = client(hub, "second");
	await first.vault.write("note.md", encode("base"));
	await first.engine.start();
	await second.engine.start();
	const doc = (await first.engine.ensureDoc("note.md", () => true))!;
	const bytes = new Uint8Array([1, 2, 3]);
	const hash = await digest(bytes);
	const document = second.api.document.bind(second.api);
	second.api.document = async (id) =>
		id === "image"
			? {
					file: {
						id,
						path: "image.png",
						kind: "blob",
						revision: hub.server.revision + 1,
						pathRevision: 0,
						digest: hash,
						size: bytes.length,
						conflict: false,
					},
					content: { kind: "blob", blob: { key: "image", digest: hash, size: bytes.length } },
				}
			: await document(id);
	const entered = deferred(),
		release = deferred();
	second.api.download = async () => {
		entered.resolve();
		await release.promise;
		return bytes;
	};
	hub.peers.get("second")!({ type: "changed", fileId: "image", revision: hub.server.revision + 1 });
	await entered.promise;
	const newPane = second.engine.ensureDoc("note.md", () => true);
	let bound = false;
	void newPane.then(() => {
		bound = true;
	});
	await vi.waitFor(() => expect(bound).toBe(true), { timeout: 500 });
	doc.getText("content").insert(4, "live");
	const remote = (await newPane)!;
	await vi.waitFor(() => expect(remote.getText("content").toString()).toBe("baselive"));
	release.resolve();
});

it("reconnects after resuming while the previous generation is waiting for its snapshot", async () => {
	const hub = new RealtimeServer();
	const { engine, api } = client(hub, "device");
	const snapshot = api.snapshot.bind(api);
	const entered = deferred(),
		release = deferred();
	let first = true;
	api.snapshot = async () => {
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
		}
		return await snapshot();
	};
	const starting = engine.start();
	await entered.promise;
	engine.pause();
	const resuming = engine.resume();
	release.resolve();
	await Promise.all([starting, resuming]);
	expect(hub.peers.has("device")).toBe(true);
});

it("recovers a skipped text delta through full reconciliation after a disk write race", async () => {
	const hub = new RealtimeServer();
	const first = client(hub, "first");
	const second = client(hub, "second");
	await first.vault.write("note.md", encode("base"));
	await first.engine.start();
	await second.engine.start();
	const doc = (await first.engine.ensureDoc("note.md", () => true))!;
	const document = vi.spyOn(second.api, "document");
	const write = second.vault.writeIfUnchanged.bind(second.vault);
	let interrupted = false;
	second.vault.writeIfUnchanged = async (path, expected, bytes) => {
		if (path === "note.md" && !interrupted) {
			interrupted = true;
			await second.vault.write(path, encode("base-local"));
			return false;
		}
		return await write(path, expected, bytes);
	};
	doc.getText("content").insert(4, "remote");
	await vi.waitFor(
		async () => {
			expect(interrupted).toBe(true);
			expect(document).toHaveBeenCalled();
			expect(second.vault.text("note.md")).toContain("remote");
			expect(second.vault.text("note.md")).toContain("-local");
			expect(doc.getText("content").toString()).toBe(second.vault.text("note.md"));
			expect((await second.store.load())!.pending).toHaveLength(0);
		},
		{ timeout: 5_000 },
	);
});

it("delivers updates before continuous 20 ms typing stops without refetching documents", async () => {
	const hub = new RealtimeServer();
	const first = client(hub, "first");
	const second = client(hub, "second");
	await first.vault.write("note.md", encode("base"));
	await first.engine.start();
	await second.engine.start();
	const doc = (await first.engine.ensureDoc("note.md", () => true))!;
	const remote = (await second.engine.ensureDoc("note.md", () => true))!;
	// Drain the initial create notification's reconciliation reservation.
	await new Promise((resolve) => {
		setTimeout(resolve, 150);
	});
	await Promise.all([first.engine.syncNow(), second.engine.syncNow()]);
	const firstSnapshot = vi.spyOn(first.api, "snapshot");
	const secondSnapshot = vi.spyOn(second.api, "snapshot");
	const firstDocument = vi.spyOn(first.api, "document");
	const secondDocument = vi.spyOn(second.api, "document");
	let receivedDuringTyping = false;
	for (let index = 0; index < 20; index++) {
		doc.getText("content").insert(doc.getText("content").length, "x");
		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});
		if (index < 19 && remote.getText("content").toString() !== "base") receivedDuringTyping = true;
	}
	expect(receivedDuringTyping).toBe(true);
	await vi.waitFor(() =>
		expect(remote.getText("content").toString()).toBe(`base${"x".repeat(20)}`),
	);
	expect(firstSnapshot).not.toHaveBeenCalled();
	expect(secondSnapshot).not.toHaveBeenCalled();
	expect(firstDocument).not.toHaveBeenCalled();
	expect(secondDocument).not.toHaveBeenCalled();
});

it("sends a one-character edit to a 100 KB note as less than one percent of its full update", async () => {
	const hub = new RealtimeServer();
	const { engine, vault, store } = client(hub, "writer");
	await vault.write("note.md", encode("a".repeat(100_000)));
	await engine.start();
	const doc = (await engine.ensureDoc("note.md", () => true))!;
	const created = hub.server.operations.find((operation) => operation.type === "create");
	expect(created?.type).toBe("create");
	if (created?.type !== "create" || created.content.kind !== "text")
		throw new Error("Missing initial text update");
	const fullSize = created.content.update.length;
	doc.getText("content").insert(50_000, "日");
	await vi.waitFor(async () => {
		expect(hub.server.operations.some((operation) => operation.type === "edit")).toBe(true);
		expect((await store.load())!.pending).toHaveLength(0);
	});
	const edit = hub.server.operations.find((operation) => operation.type === "edit");
	if (edit?.type !== "edit" || edit.content.kind !== "text")
		throw new Error("Missing incremental text update");
	expect(edit.content.update.length).toBeLessThan(fullSize * 0.01);
	expect([...hub.server.docs.values()][0]!.doc.getText("content").toString()).toBe(
		`${"a".repeat(50_000)}日${"a".repeat(50_000)}`,
	);
});
