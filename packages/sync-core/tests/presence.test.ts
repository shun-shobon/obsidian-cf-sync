import "../../obsidian-plugin/tests/helpers/browser-window";
import type { ServerMessage } from "@cf-sync/protocol";
import { fromUint8Array } from "js-base64";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { Server } from "../../obsidian-plugin/tests/helpers/sync-server";
import { Vault } from "../../obsidian-plugin/tests/helpers/sync-vault";
import type { SyncStatus } from "../src";
import { Presence } from "../src/sync/service/presence";
import { SyncEngine } from "../src/sync/usecase/sync-engine";
import { Store } from "./helpers/memory-store";

type IncomingPresence = Extract<ServerMessage, { type: "presence" }>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
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

		const doc = (await engine.ensureDoc("note.md"))!;
		const fileId = [...server.docs.keys()][0]!;
		deliver!({ ...peerPresence(doc, fileId), cursor: brokenCursor });
		doc.getText("content").insert(4, " edited");

		await vi.waitFor(() => {
			expect(server.docs.get(fileId)!.doc.getText("content").toString()).toBe("base edited");
		});
		expect(statuses).not.toContain("error");
	});
});
