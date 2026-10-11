import type {
	BlobRef,
	DocumentResponse,
	OperationResult,
	ServerMessage,
	Snapshot,
} from "@cf-sync/protocol";
import type { ApiPort } from "@cf-sync/sync-core/sync/ports/api-port";
import type { Miniflare } from "miniflare";

import { parseJson, readJson } from "./json";
import { vaultId } from "./runtime-api";

export function createRuntimeApi(mf: Miniflare, deviceId: string): ApiPort {
	const request = (path: string, body?: unknown) => {
		let method = "GET";
		let serialized: string | undefined;
		if (body !== undefined) {
			method = "POST";
			serialized = JSON.stringify(body);
		}
		return mf.dispatchFetch(`https://test${path}`, {
			method,
			headers: {
				"X-Vault-Id": vaultId,
				"X-Device-Id": deviceId,
				"Content-Type": "application/json",
			},
			body: serialized,
		});
	};
	return {
		async snapshot() {
			const response = await request("/snapshot");

			return await readJson<Snapshot>(response);
		},

		async document(id) {
			return await readJson<DocumentResponse>(await request(`/files/${id}`));
		},

		async operate(op) {
			return await readJson<OperationResult>(await request("/operations", op));
		},

		async upload(key, bytes, hash) {
			const result = await mf.dispatchFetch(`https://test/blobs/${key}`, {
				method: "PUT",
				headers: {
					"X-Vault-Id": vaultId,
					"X-Device-Id": deviceId,
					"X-Content-Digest": hash,
					"X-Content-Size": String(bytes.length),
				},
				body: bytes,
			});
			if (!result.ok) {
				throw new Error(await result.text());
			}
			return await readJson<BlobRef>(result);
		},

		async download(ref) {
			const response = await request(`/blobs/${ref.key}`);
			const bytes = await response.arrayBuffer();

			return new Uint8Array(bytes);
		},

		async connect(onMessage, onClose) {
			const ticketResponse = await request("/tickets", {});
			const ticket = await readJson<{ ticket: string }>(ticketResponse);
			const response = await mf.dispatchFetch(`https://test/ws?ticket=${ticket.ticket}`, {
				headers: { "X-Vault-Id": vaultId, Upgrade: "websocket" },
			});
			const socket = response.webSocket!;
			socket.accept();
			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string") {
					throw new TypeError("Expected JSON message");
				}
				onMessage(parseJson<ServerMessage>(event.data));
			});
			socket.addEventListener("close", onClose);
			return {
				close: () => socket.close(),
				send: (message) => socket.send(JSON.stringify(message)),
			};
		},
	};
}
