import type {
	BlobRef,
	DocumentResponse,
	OperationResult,
	ServerMessage,
	Snapshot,
} from "@cf-sync/protocol";
import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import type { ApiPort } from "@cf-sync/sync-core/sync/ports/api-port";
import type { Miniflare } from "miniflare";

import { requestAsDevice, vaultId } from "./runtime-api";

export function createRuntimeApi(mf: Miniflare, deviceId: string): ApiPort {
	const request = (path: string, body?: unknown) => requestAsDevice(mf, deviceId, path, body);

	return {
		async snapshot() {
			const response = await request("/snapshot");

			return (await response.json()) as Snapshot;
		},

		async document(id) {
			const response = await request(`/files/${id}`);

			return (await response.json()) as DocumentResponse;
		},

		async operate(op) {
			const response = await request("/operations", op);

			return (await response.json()) as OperationResult;
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
			return (await result.json()) as BlobRef;
		},

		async download(ref) {
			const response = await request(`/blobs/${ref.key}`);
			const bytes = await response.arrayBuffer();

			return new Uint8Array(bytes);
		},

		async connect(onMessage, onClose) {
			const ticketResponse = await request("/tickets", {});
			const ticket = (await ticketResponse.json()) as { ticket: string };
			const response = await mf.dispatchFetch(`https://test/ws?ticket=${ticket.ticket}`, {
				headers: { "X-Vault-Id": vaultId, Upgrade: "websocket" },
			});
			const socket = response.webSocket!;
			socket.accept();
			socket.addEventListener("message", (event) => {
				if (typeof event.data !== "string") {
					throw new TypeError("Expected JSON message");
				}
				onMessage(JSON.parse(event.data) as ServerMessage);
			});
			socket.addEventListener("close", () => onClose(new ConnectionError("closed")));
			return {
				close: () => socket.close(),
				send: (message) => socket.send(JSON.stringify(message)),
			};
		},
	};
}
