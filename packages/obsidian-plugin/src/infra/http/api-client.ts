import type { ServerMessage } from "@cf-sync/protocol";
import type { ServerConnection } from "@cf-sync/sync-core/infra/http/http-client";
import { VaultApi } from "@cf-sync/sync-core/infra/http/server-api";
import type { ApiPort, SyncSocket } from "@cf-sync/sync-core/sync/ports/api-port";

import type { OAuthClient } from "../auth/oauth-client";
import type { Transport } from "./transport";
import { connectSocket } from "./websocket";

export function serverConnection(auth: OAuthClient, transport: Transport): ServerConnection {
	return {
		origin: auth.origin,
		send: transport,
		authorize: async () => ({ Authorization: `Bearer ${await auth.token()}` }),
	};
}

export class SyncApi extends VaultApi implements ApiPort {
	constructor(
		private readonly server: ServerConnection,
		deviceId: string,
		vaultId: string,
	) {
		super(server, deviceId, vaultId);
	}

	async connect(
		onMessage: (message: ServerMessage) => void,
		onClose: (error: Error) => void,
	): Promise<SyncSocket> {
		const ticket = await this.ticket();

		return await connectSocket(ticket.url, this.server.origin, onMessage, onClose);
	}
}
