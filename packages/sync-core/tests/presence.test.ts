import type { ClientMessage, ServerMessage } from "@cf-sync/protocol";
import { fromUint8Array, toUint8Array } from "js-base64";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { SyncStatus } from "../src/sync/domain/sync-state";
import { Presence } from "../src/sync/service/presence";
import { SyncEngine } from "../src/sync/usecase/sync-engine";
import { Store } from "./helpers/memory-store";
import { Server } from "./helpers/sync-server";
import { Vault } from "./helpers/sync-vault";

type IncomingPresence = Extract<ServerMessage, { type: "presence" }>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}

	vi.useRealTimers();
});

function cursorAt(doc: Y.Doc, index: number) {
	const position = Y.createRelativePositionFromTypeIndex(doc.getText("content"), index);

	return fromUint8Array(Y.encodeRelativePosition(position));
}

function peerPresence(doc: Y.Doc, fileId: string): IncomingPresence {
	return {
		type: "presence",
		deviceId: crypto.randomUUID(),
		fileId,
		clientId: 123,
		name: "iPhone",
		cursor: { anchor: cursorAt(doc, 1), head: cursorAt(doc, 2) },
	};
}

const brokenCursor = { anchor: "AA==", head: "AA==" };

function setup() {
	const send = vi.fn<(message: Extract<ClientMessage, { type: "presence" }>) => void>();
	const client = new Presence({ deviceId: "local", name: "Mac", send });
	const doc = new Y.Doc();
	cleanups.push(() => {
		client.dispose();
		doc.destroy();
	});
	doc.getText("content").insert(0, "日本語のノート");
	const awareness = client.getAwareness("note", doc);
	const message: IncomingPresence = {
		type: "presence",
		deviceId: "peer",
		name: "iPhone",
		clientId: 123,
		fileId: "note",
		cursor: { anchor: cursorAt(doc, 1), head: cursorAt(doc, 3) },
	};

	return { client, doc, awareness, send, message };
}

describe("live cursor presence", () => {
	beforeEach(() => vi.useFakeTimers());

	it("throttles moving selections to 20 Hz and sends the latest position", () => {
		const { client, doc, send } = setup();
		const owner = {};
		client.connect();
		client.setSelection(owner, doc, 0, 0);
		for (let i = 1; i <= 5; i++) {
			vi.advanceTimersByTime(8);
			client.setSelection(owner, doc, i, i);
		}
		expect(send).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10);
		expect(send).toHaveBeenCalledTimes(2);
		const cursor = send.mock.lastCall![0].cursor!;
		const position = Y.createAbsolutePositionFromRelativePosition(
			Y.decodeRelativePosition(toUint8Array(cursor.head)),
			doc,
		);
		expect(position?.index).toBe(5);
	});

	it("does not let an old pane clear the new pane's cursor", () => {
		const { client, doc, send } = setup();
		const first = {},
			second = {};
		client.connect();
		client.setSelection(first, doc, 0, 0);
		client.setSelection(second, doc, 2, 3);
		client.clearSelection(first);
		vi.advanceTimersByTime(50);
		expect(send.mock.lastCall![0].cursor).not.toBeNull();
		client.clearSelection(second);
		expect(send.mock.lastCall![0]).toMatchObject({ fileId: null, cursor: null });
		vi.advanceTimersByTime(3_000);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("refreshes stationary cursors and expires a peer exactly ten seconds after its last heartbeat", () => {
		const { client, doc, awareness, send, message } = setup();
		client.connect();
		client.setSelection({}, doc, 1, 1);
		client.receive(message);
		vi.advanceTimersByTime(3_000);
		expect(send).toHaveBeenCalledTimes(2);
		client.receive(message);
		vi.advanceTimersByTime(9_999);
		expect(awareness.getStates().has(123)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(awareness.getStates().has(123)).toBe(false);
	});

	it("clears peers on disconnection and republishes the active selection on reconnection", () => {
		const { client, doc, awareness, send, message } = setup();
		client.connect();
		client.setSelection({}, doc, 2, 2);
		client.receive(message);
		client.disconnect();
		expect(awareness.getStates().size).toBe(0);
		vi.advanceTimersByTime(3_000);
		expect(send).toHaveBeenCalledTimes(1);
		client.connect();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("replaces a device's previous document and client ID without touching the local ID", () => {
		const { client, doc, awareness, message } = setup();
		client.receive(message);
		client.receive({ ...message, clientId: 456 });
		expect([...awareness.getStates().keys()]).toEqual([456]);
		client.receive({ ...message, clientId: doc.clientID });
		expect(awareness.getLocalState()).toBeNull();
		expect(awareness.getStates().size).toBe(0);
		client.receive(message);
		client.receive({ ...message, fileId: "other" });
		expect(awareness.getStates().size).toBe(0);
	});

	it("retains relative positions when text is inserted before a remote selection", () => {
		const { client, doc, awareness, message } = setup();
		client.receive(message);
		doc.getText("content").insert(0, "追記");
		const position = Y.createAbsolutePositionFromRelativePosition(
			(awareness.getStates().get(123) as { cursor: { head: Y.RelativePosition } }).cursor.head,
			doc,
		);
		expect(position?.index).toBe(5);
	});

	it("hydrates a newly opened editor and clears a removed document", () => {
		const { client, doc, message, send } = setup();
		client.forgetDoc(doc);
		client.receive(message);
		const awareness = client.getAwareness("note", doc);
		expect((awareness.getStates().get(123) as { user: { name: string } }).user.name).toBe("iPhone");
		client.connect();
		client.setSelection({}, doc, 0, 0);
		client.forgetDoc(doc);
		expect(send.mock.lastCall![0].cursor).toBeNull();
	});
	it("keeps the awareness instance when a document is remapped and publishes the new file ID", () => {
		const { client, doc, awareness, message, send } = setup();
		client.connect();
		client.setSelection({}, doc, 1, 2);
		client.receive(message);
		client.receive({ ...message, deviceId: "second-peer", clientId: 456, fileId: "new-note" });
		client.remapDoc(doc, "new-note");
		expect(client.getAwareness("new-note", doc)).toBe(awareness);
		expect([...awareness.getStates().keys()]).toEqual([456]);
		expect(send.mock.lastCall![0]).toMatchObject({
			fileId: "new-note",
			cursor: expect.any(Object),
		});
		client.setName("MacBook");
		expect(send.mock.lastCall![0].name).toBe("MacBook");
		vi.advanceTimersByTime(3_000);
		expect(send.mock.lastCall![0]).toMatchObject({ fileId: "new-note", name: "MacBook" });
	});
});

describe("presence with an invalid peer cursor", () => {
	it("drops the message and keeps the peer's last valid cursor", () => {
		const presence = new Presence({ deviceId: "local", name: "Mac", send: vi.fn() });
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "note");
		cleanups.push(() => {
			presence.dispose();
			doc.destroy();
		});
		const awareness = presence.getAwareness("note", doc);
		const valid = peerPresence(doc, "note");

		presence.receive(valid);
		const before = awareness.getStates().get(123);

		expect(() => presence.receive({ ...valid, cursor: brokenCursor })).not.toThrow();
		expect(awareness.getStates().get(123)).toEqual(before);
	});

	it("keeps the engine synchronizing after receiving the message", async () => {
		const server = new Server();
		const vault = new Vault();
		const statuses: SyncStatus["phase"][] = [];
		let deliver: ((message: ServerMessage) => void) | undefined;
		const engine = new SyncEngine({
			deviceId: crypto.randomUUID(),
			deviceName: "Test device",
			vault,
			api: {
				...server.api,
				connect: async (onMessage, onClose) => {
					deliver = onMessage;

					return await server.api.connect(onMessage, onClose);
				},
			},
			store: new Store(),
			onStatus: (status) => statuses.push(status.phase),
			onConflict() {},
			confirmInitial: async () => true,
		});
		cleanups.push(() => engine.dispose());
		await vault.write("note.md", new TextEncoder().encode("base"));
		await engine.start();

		const doc = (await engine.ensureDoc("note.md", () => true))!;
		const fileId = [...server.docs.keys()][0]!;
		deliver!({ ...peerPresence(doc, fileId), cursor: brokenCursor });
		doc.getText("content").insert(4, " edited");

		await vi.waitFor(() => {
			expect(server.docs.get(fileId)!.doc.getText("content").toString()).toBe("base edited");
		});
		expect(statuses).not.toContain("error");
	});
});
