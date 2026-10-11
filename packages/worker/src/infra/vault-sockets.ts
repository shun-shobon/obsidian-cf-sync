import { digest } from "@cf-sync/protocol";
import type { ClientMessage, ServerMessage } from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";
import { decodeRelativePosition } from "yjs";

import { ApplicationError } from "../domain/errors";
import type { AlarmStorage } from "./vault-maintenance";

interface Ticket {
	deviceId: string;
	expiresAt: number;
}

type Presence = Extract<ServerMessage, { type: "presence" }>;

interface Connection {
	deviceId: string;
	presence: Presence | null;
	updatedAt: number;
}

export class VaultSockets {
	constructor(private readonly state: DurableObjectState) {}

	async assertDeviceActive(deviceId: string): Promise<void> {
		if (await this.isRevoked(deviceId)) {
			throw new ApplicationError("forbidden", "Device revoked");
		}
	}

	async revoke(deviceId: string): Promise<void> {
		await this.state.storage.put(`revoked:${deviceId}`, true);

		for (const ws of this.state.getWebSockets(deviceId)) {
			this.leave(ws);
			ws.close(4003, "Device revoked");
		}
	}

	async issueTicket(deviceId: string): Promise<{ ticket: string; expiresAt: number }> {
		const secret = crypto.randomUUID() + crypto.randomUUID();
		const expiresAt = Date.now() + 30_000;
		await this.state.storage.put(await this.ticketKey(secret), {
			deviceId,
			expiresAt,
		} satisfies Ticket);

		return { ticket: secret, expiresAt };
	}

	async connect(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			throw new ApplicationError("upgrade-required", "WebSocket upgrade required");
		}

		const secret = new URL(request.url).searchParams.get("ticket");

		if (secret == null || secret === "" || secret.length > 200) {
			throw new ApplicationError("unauthenticated", "Invalid ticket");
		}

		const key = await this.ticketKey(secret);
		const ticket = await this.state.storage.get<Ticket>(key);
		await this.state.storage.delete(key);

		if (!ticket || ticket.expiresAt <= Date.now()) {
			throw new ApplicationError("unauthenticated", "Expired or consumed ticket");
		}

		if (await this.isRevoked(ticket.deviceId)) {
			throw new ApplicationError("unauthenticated", "Expired or consumed ticket");
		}

		for (const existing of this.state.getWebSockets(ticket.deviceId)) {
			this.leave(existing);
			existing.close(4000, "Connection replaced");
		}
		const pair = new WebSocketPair();
		this.state.acceptWebSocket(pair[1], [ticket.deviceId]);
		pair[1].serializeAttachment({
			deviceId: ticket.deviceId,
			presence: null,
			updatedAt: 0,
		} satisfies Connection);
		for (const ws of this.state.getWebSockets()) {
			const connection = readConnection(ws);
			if (
				ws.readyState === WebSocket.OPEN &&
				connection?.presence &&
				connection.updatedAt > Date.now() - 10_000
			) {
				pair[1].send(JSON.stringify(connection.presence));
			}
		}
		console.info({ event: "websocket.connected", deviceId: ticket.deviceId });

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async authenticate(ws: WebSocket): Promise<string> {
		const connection = readConnection(ws);
		if (!connection || ws.readyState !== WebSocket.OPEN) {
			throw new ApplicationError("unauthenticated", "WebSocket is not authenticated");
		}
		await this.assertDeviceActive(connection.deviceId);
		return connection.deviceId;
	}

	presence(
		ws: WebSocket,
		deviceId: string,
		value: Extract<ClientMessage, { type: "presence" }>,
	): void {
		if (value.cursor) {
			decodeRelativePosition(toUint8Array(value.cursor.anchor));
			decodeRelativePosition(toUint8Array(value.cursor.head));
		}
		const presence: Presence = { ...value, deviceId };
		ws.serializeAttachment({ deviceId, presence, updatedAt: Date.now() } satisfies Connection);
		this.broadcast(presence);
	}

	leave(ws: WebSocket): void {
		const connection = readConnection(ws);
		if (!connection?.presence) {
			return;
		}
		ws.serializeAttachment({ ...connection, presence: null });
		this.broadcast({ ...connection.presence, fileId: null, cursor: null });
	}

	broadcast(message: ServerMessage): void {
		const data = JSON.stringify(message);

		for (const ws of this.state.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) {
				continue;
			}

			try {
				ws.send(data);
			} catch {
				console.warn({ event: "websocket.notification.failed", messageType: message.type });
				ws.close(1011, "Notification failed");
			}
		}
	}

	async expire(): Promise<void> {
		const tickets = await this.state.storage.list<Ticket>({ prefix: "ticket:" });

		for (const [key, ticket] of tickets) {
			if (ticket.expiresAt <= Date.now()) {
				await this.state.storage.delete(key);
			}
		}
	}

	async ticketExpiries(storage: AlarmStorage): Promise<number[]> {
		const tickets = await storage.list<Ticket>({ prefix: "ticket:" });

		return [...tickets.values()].map((ticket) => ticket.expiresAt);
	}

	private async isRevoked(deviceId: string): Promise<boolean> {
		const revoked = await this.state.storage.get<boolean>(`revoked:${deviceId}`);

		return revoked === true;
	}

	private async ticketKey(secret: string): Promise<string> {
		return `ticket:${await digest(new TextEncoder().encode(secret))}`;
	}
}

function readConnection(ws: WebSocket): Connection | null {
	const attachment: unknown = ws.deserializeAttachment();

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- attachmentはこのクラスがConnectionとしてのみ保存する
	return attachment as Connection | null;
}
