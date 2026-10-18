import "fake-indexeddb/auto";
import { digest } from "@cf-sync/protocol";
import type {
	Operation,
	Snapshot,
	DocumentResponse,
	BlobRef,
	ServerMessage,
} from "@cf-sync/protocol";
import { toUint8Array, fromUint8Array } from "js-base64";
import { assert, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
	apply,
	deleteDevice,
	deviceId,
	document,
	echoJson,
	flush,
	issueTicket,
	openWebSocket,
	registerDevice,
	registerVault,
	request,
	requestAsDevice,
	runtimeState,
	uploadAsDevice,
	vaultId,
} from "./helpers/runtime-api";
import { createRuntimeClient } from "./helpers/runtime-client";
import { createRuntimeApi } from "./helpers/runtime-transport";
import { useWorkerRuntime } from "./helpers/worker-runtime";

const runtime = useWorkerRuntime();

async function start(folder?: string) {
	const storage = folder ?? (await runtime.temporaryDirectory());
	const mf = runtime.start(storage);

	if (folder === undefined) {
		await registerVault(mf);
		await registerDevice(mf, deviceId);
	}

	return { mf, storage };
}

function textUpdate(text: string) {
	const doc = new Y.Doc();
	doc.getText("content").insert(0, text);
	const update = fromUint8Array(Y.encodeStateAsUpdate(doc));
	doc.destroy();
	return update;
}

function plain(content: DocumentResponse) {
	if (content.content.kind !== "text") {
		throw new Error("not text");
	}
	const doc = new Y.Doc();
	Y.applyUpdate(doc, toUint8Array(content.content.update));
	const text = doc.getText("content").toString();
	doc.destroy();
	return text;
}

describe("Durable Object and R2 runtime integration", () => {
	it("persists accepted operations across restart and flushes ordinary files", async () => {
		const { mf, storage } = await start();
		const id = crypto.randomUUID();
		const op: Operation = {
			type: "create",
			opId: crypto.randomUUID(),
			fileId: id,
			path: "日記/ノート.md",
			content: { kind: "text", update: textUpdate("日本語のノート") },
		};
		const first = await apply(mf, op);
		expect((await apply(mf, op)).revision).toBe(first.revision);
		expect(plain(await document(mf, id))).toBe("日本語のノート");
		await flush(mf);
		const bucket = await mf.getR2Bucket("BUCKET");
		expect(await (await bucket.get(`vaults/${vaultId}/files/日記/ノート.md`))!.text()).toBe(
			"日本語のノート",
		);
		await runtime.dispose(mf);
		const restarted = (await start(storage)).mf;
		expect((await apply(restarted, op)).revision).toBe(first.revision);
		expect(plain(await document(restarted, id))).toBe("日本語のノート");
	});

	it("merges concurrent edits, protects deletion races and preserves colliding files", async () => {
		const { mf } = await start();
		const id = crypto.randomUUID();
		const base = await apply(mf, {
			type: "create",
			opId: crypto.randomUUID(),
			fileId: id,
			path: "note.md",
			content: { kind: "text", update: textUpdate("base") },
		});
		const current = await document(mf, id);
		if (current.content.kind !== "text") {
			throw new Error("not text");
		}
		const left = new Y.Doc();
		const right = new Y.Doc();
		for (const doc of [left, right]) {
			Y.applyUpdate(doc, toUint8Array(current.content.update));
		}
		left.getText("content").insert(0, "L");
		right.getText("content").insert(4, "R");
		for (const doc of [left, right]) {
			await apply(mf, {
				type: "edit",
				opId: crypto.randomUUID(),
				fileId: id,
				path: "note.md",
				baseRevision: base.revision,
				content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(doc)) },
			});
		}
		expect(plain(await document(mf, id))).toBe("LbaseR");
		const removed = await apply(mf, {
			type: "delete",
			opId: crypto.randomUUID(),
			fileId: id,
			baseRevision: base.revision,
		});
		expect(removed.conflict).toBe(true);
		expect(removed.file).not.toBeNull();
		expect(plain(await document(mf, removed.file!.id))).toBe("LbaseR");
		expect((await request(mf, `/files/${id}`)).status).toBe(404);
		const recovered = await apply(mf, {
			type: "edit",
			opId: crypto.randomUUID(),
			fileId: id,
			path: "note.md",
			baseRevision: base.revision,
			content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(left)) },
		});
		expect(recovered.conflict).toBe(true);
		await apply(mf, {
			type: "create",
			opId: crypto.randomUUID(),
			fileId: crypto.randomUUID(),
			path: "image.canvas",
			content: { kind: "text", update: textUpdate("one") },
		});
		const collision = await apply(mf, {
			type: "create",
			opId: crypto.randomUUID(),
			fileId: crypto.randomUUID(),
			path: "IMAGE.canvas",
			content: { kind: "text", update: textUpdate("two") },
		});
		expect(collision.conflict).toBe(true);
		left.destroy();
		right.destroy();
	});

	it("streams attachment bytes and retains excluded R2 files", async () => {
		const { mf } = await start();
		const bytes = new Uint8Array(20 * 1024 * 1024).fill(123);
		const key = crypto.randomUUID();
		const hash = await digest(bytes);
		const uploaded = await uploadAsDevice(mf, deviceId, key, bytes, hash);
		assert.strictEqual(uploaded.status, 200, await uploaded.clone().text());
		const blob = (await uploaded.json()) as BlobRef;
		const downloaded = await request(mf, `/blobs/${key}`);
		const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());

		expect(downloaded.status).toBe(200);
		expect(downloadedBytes.byteLength).toBe(bytes.byteLength);
		expect(await digest(downloadedBytes)).toBe(hash);

		await apply(mf, {
			type: "create",
			opId: crypto.randomUUID(),
			fileId: crypto.randomUUID(),
			path: "assets/image.png",
			content: { kind: "blob", blob },
		});
		await flush(mf);
		const excluded = await request(mf, "/exclusions", { exclusions: ["assets"] }, "PUT");
		expect(excluded.status).toBe(200);
		await flush(mf);
		const bucket = await mf.getR2Bucket("BUCKET");
		const saved = await (await bucket.get(
			`vaults/${vaultId}/files/assets/image.png`,
		))!.arrayBuffer();
		expect(saved.byteLength).toBe(bytes.byteLength);
		expect(await digest(new Uint8Array(saved))).toBe(hash);
		const snapshot = (await (await request(mf, "/snapshot")).json()) as Snapshot;
		expect(snapshot.exclusions).toEqual(["assets"]);
	});

	it("streams JSON larger than the RPC value limit in both directions", async () => {
		const { mf } = await start();
		const content = "x".repeat(33 * 1024 * 1024);
		const response = await echoJson(mf, { content });

		expect(response.status).toBe(200);

		const received = (await response.json()) as { content: string };

		expect(received.content).toBe(content);
	}, 30_000);

	it("authenticates, validates and authorizes requests through the public routes", async () => {
		const { mf } = await start();
		const unauthenticated = await mf.dispatchFetch(`https://test/api/vaults/${vaultId}/snapshot`, {
			headers: { "X-Device-Id": deviceId },
		});

		expect(unauthenticated.status).toBe(401);
		expect((await requestAsDevice(mf, crypto.randomUUID(), "/snapshot")).status).toBe(403);
		expect((await request(mf, "/files/not-an-id")).status).toBe(400);
		expect((await request(mf, `/blobs/${crypto.randomUUID()}`, {}, "PUT")).status).toBe(400);
	});

	it("preserves application errors across RPC and continues processing", async () => {
		const { mf } = await start();
		const missing = await request(mf, `/files/${crypto.randomUUID()}`);

		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: "File not found" });

		const snapshot = await request(mf, "/snapshot");

		expect(snapshot.status).toBe(200);
	});

	it("serializes simultaneous RPC mutations without losing revisions or path ownership", async () => {
		const { mf } = await start();
		const operations: Operation[] = Array.from({ length: 8 }, () => ({
			type: "create",
			opId: crypto.randomUUID(),
			fileId: crypto.randomUUID(),
			path: "same.md",
			content: { kind: "text", update: textUpdate("content") },
		}));
		const results = await Promise.all(operations.map((operation) => apply(mf, operation)));
		const snapshotResponse = await request(mf, "/snapshot");
		const snapshot = (await snapshotResponse.json()) as Snapshot;

		expect(snapshot.revision).toBe(operations.length);
		expect(snapshot.files).toHaveLength(operations.length);
		expect(new Set(snapshot.files.map((file) => file.path)).size).toBe(operations.length);
		expect(results.filter((result) => result.conflict)).toHaveLength(operations.length - 1);
	});

	it("hibernates an idle connected vault and delivers changes after waking", async () => {
		const { mf } = await start();
		const response = await openWebSocket(mf, await issueTicket(mf));
		expect(response.status).toBe(101);

		const socket = response.webSocket!;
		socket.accept();
		const messages: ServerMessage[] = [];
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				throw new TypeError("Expected a JSON text notification");
			}

			messages.push(JSON.parse(event.data) as ServerMessage);
		});

		try {
			const before = await runtimeState(mf);
			expect(before.alarm).toBeNull();
			expect(before.connections).toBe(1);

			await new Promise((resolve) => {
				setTimeout(resolve, 20_000);
			});

			expect(messages).toEqual([]);
			const after = await runtimeState(mf);
			expect(after.incarnation).not.toBe(before.incarnation);
			expect(after.alarm).toBeNull();
			expect(after.connections).toBe(1);

			const fileId = crypto.randomUUID();
			await apply(mf, {
				type: "create",
				opId: crypto.randomUUID(),
				fileId,
				path: "after-sleep.md",
				content: { kind: "text", update: textUpdate("wake up") },
			});
			await expect
				.poll(() =>
					messages.some((message) => {
						return message.type === "changed" && message.fileId === fileId;
					}),
				)
				.toBe(true);
		} finally {
			socket.close();
		}
	}, 30_000);

	it("consumes a ticket once and discards a deleted device's sockets and tickets", async () => {
		const { mf } = await start();
		const issue = async (device: string) => {
			const url = await issueTicket(mf, device);
			return () => openWebSocket(mf, url);
		};
		const otherDeviceId = crypto.randomUUID();
		await registerDevice(mf, otherDeviceId);
		const connect = await issue(deviceId);
		const response = await connect();
		expect(response.status).toBe(101);
		response.webSocket!.accept();
		expect((await connect()).status).toBe(401);
		const unused = await issue(deviceId);
		const otherDevice = await issue(otherDeviceId);
		const closed = new Promise<number>((resolve) => {
			response.webSocket!.addEventListener("close", (event) => resolve(event.code));
		});
		await deleteDevice(mf, deviceId);
		expect(await closed).toBe(4003);
		expect((await unused()).status).toBe(401);
		const other = await otherDevice();
		expect(other.status).toBe(101);
		other.webSocket!.accept();
		other.webSocket!.close();
	}, 30_000);
});

describe("client engine against the real DO", () => {
	it("converges offline edits through durable websocket operations", async () => {
		const { mf } = await start();
		const left = await createRuntimeClient(mf, { "note.md": "base" });
		const right = await createRuntimeClient(mf, {});

		try {
			await left.engine.start();
			await right.engine.start();
			expect(right.text("note.md")).toBe("base");
			left.engine.pause();
			right.engine.pause();
			const leftText = (await left.engine.ensureDoc("note.md", () => true))!.getText("content");
			const rightText = (await right.engine.ensureDoc("note.md", () => true))!.getText("content");
			leftText.insert(0, "LEFT ");
			rightText.insert(4, " RIGHT");
			await left.engine.resume();
			await right.engine.resume();
			await left.engine.syncNow();
			await right.engine.syncNow();
			expect(leftText.toString()).toBe("LEFT base RIGHT");
			expect(rightText.toString()).toBe(leftText.toString());
			await flush(mf);
			const bucket = await mf.getR2Bucket("BUCKET");
			expect(await (await bucket.get(`vaults/${vaultId}/files/note.md`))!.text()).toBe(
				"LEFT base RIGHT",
			);
		} finally {
			await left.engine.dispose();
			await right.engine.dispose();
		}
	}, 30_000);
});

describe("realtime websocket transport", () => {
	it("delivers durable text deltas, current presence on reconnect, and departure", async () => {
		const { mf } = await start();
		const leftId = crypto.randomUUID();
		const rightId = crypto.randomUUID();
		const leftMessages: ServerMessage[] = [];
		const rightMessages: ServerMessage[] = [];
		const left = await (
			await createRuntimeApi(mf, leftId)
		).connect(
			(message) => leftMessages.push(message),
			() => {},
		);
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "base");
		const fileId = crypto.randomUUID();
		const operation: Operation = {
			type: "create",
			opId: crypto.randomUUID(),
			fileId,
			path: "live.md",
			content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(doc)) },
		};
		left.send({ type: "operation", operation });
		await expect
			.poll(() =>
				leftMessages.some((m) => m.type === "operation-result" && m.result.opId === operation.opId),
			)
			.toBe(true);
		const position = fromUint8Array(
			Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText("content"), 2)),
		);
		left.send({
			type: "presence",
			fileId,
			clientId: doc.clientID,
			name: "Left",
			cursor: { anchor: position, head: position },
		});
		await expect.poll(() => leftMessages.some((m) => m.type === "presence")).toBe(true);
		let leftClosed = false;
		let right = await (
			await createRuntimeApi(mf, rightId)
		).connect(
			(message) => rightMessages.push(message),
			() => {},
		);
		try {
			await expect
				.poll(() =>
					rightMessages.some(
						(m) => m.type === "presence" && m.deviceId === leftId && m.fileId === fileId,
					),
				)
				.toBe(true);
			const vector = Y.encodeStateVector(doc);
			doc.getText("content").insert(4, " live");
			const update = fromUint8Array(Y.encodeStateAsUpdate(doc, vector));
			left.send({
				type: "operation",
				operation: {
					type: "edit",
					opId: crypto.randomUUID(),
					fileId,
					path: "live.md",
					baseRevision: 1,
					content: { kind: "text", update },
				},
			});
			await expect
				.poll(() =>
					rightMessages.some(
						(m) => m.type === "text" && m.update === update && m.deviceId === leftId,
					),
				)
				.toBe(true);
			expect(plain(await document(mf, fileId))).toBe("base live");
			right.close();
			rightMessages.length = 0;
			right = await (
				await createRuntimeApi(mf, rightId)
			).connect(
				(message) => rightMessages.push(message),
				() => {},
			);
			await expect
				.poll(() =>
					rightMessages.some(
						(m) => m.type === "presence" && m.deviceId === leftId && m.fileId === fileId,
					),
				)
				.toBe(true);
			left.close();
			leftClosed = true;
			await expect
				.poll(() =>
					rightMessages.some(
						(m) => m.type === "presence" && m.deviceId === leftId && m.fileId == null,
					),
				)
				.toBe(true);
		} finally {
			if (!leftClosed) {
				left.close();
			}
			right.close();
			doc.destroy();
		}
	});
});

it("does not replay expired presence to a new websocket connection", async () => {
	const { mf } = await start();
	const leftId = crypto.randomUUID();
	const messages: ServerMessage[] = [];
	const left = await (
		await createRuntimeApi(mf, leftId)
	).connect(
		(message) => messages.push(message),
		() => {},
	);
	const doc = new Y.Doc();
	const position = fromUint8Array(
		Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText("content"), 0)),
	);
	try {
		left.send({
			type: "presence",
			fileId: crypto.randomUUID(),
			clientId: doc.clientID,
			name: "Idle",
			cursor: { anchor: position, head: position },
		});
		await expect.poll(() => messages.some((message) => message.type === "presence")).toBe(true);
		await new Promise((resolve) => {
			setTimeout(resolve, 10_050);
		});
		const newcomerMessages: ServerMessage[] = [];
		const right = await (
			await createRuntimeApi(mf, crypto.randomUUID())
		).connect(
			(message) => newcomerMessages.push(message),
			() => {},
		);
		try {
			// A subsequent operation acknowledgement provides a delivery barrier.
			right.send({
				type: "operation",
				operation: {
					type: "create",
					opId: crypto.randomUUID(),
					fileId: crypto.randomUUID(),
					path: "barrier.md",
					content: { kind: "text", update: textUpdate("barrier") },
				},
			});
			await expect
				.poll(() => newcomerMessages.some((message) => message.type === "operation-result"))
				.toBe(true);
			expect(newcomerMessages.filter((message) => message.type === "presence")).toEqual([]);
		} finally {
			right.close();
		}
	} finally {
		left.close();
		doc.destroy();
	}
}, 15_000);
