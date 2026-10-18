import type { ServerMessage } from "@cf-sync/protocol";
import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import type { ServerConnection } from "@cf-sync/sync-core/infra/http/http-client";
import { VaultApi } from "@cf-sync/sync-core/infra/http/server-api";
import type { ApiPort, SyncSocket } from "@cf-sync/sync-core/sync/ports/api-port";
import type { Miniflare } from "miniflare";

import { accessHeaders, openWebSocket, origin, registerDevice, vaultId } from "./runtime-api";

function runtimeServer(mf: Miniflare): ServerConnection {
	return {
		origin,
		authorize: () => Promise.resolve(accessHeaders),
		async send(request) {
			const response = await mf.dispatchFetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
			});

			return { status: response.status, bytes: await response.arrayBuffer() };
		},
	};
}

class RuntimeApi extends VaultApi implements ApiPort {
	constructor(
		private readonly mf: Miniflare,
		deviceId: string,
	) {
		super(runtimeServer(mf), deviceId, vaultId);
	}

	async connect(
		onMessage: (message: ServerMessage) => void,
		onClose: (error: Error) => void,
	): Promise<SyncSocket> {
		const { url } = await this.ticket();
		const response = await openWebSocket(this.mf, url);
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
	}
}

export async function createRuntimeApi(mf: Miniflare, deviceId: string): Promise<ApiPort> {
	await registerDevice(mf, deviceId);

	return new RuntimeApi(mf, deviceId);
}
