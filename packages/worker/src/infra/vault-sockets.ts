import { digest, type ServerMessage } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";

interface Ticket {
  deviceId: string;
  expiresAt: number;
}

export class VaultSockets {
  constructor(private readonly state: DurableObjectState) {}

  async assertDeviceActive(deviceId: string): Promise<void> {
    if (await this.state.storage.get(`revoked:${deviceId}`)) {
      throw new ApplicationError("forbidden", "Device revoked");
    }
  }

  async revoke(deviceId: string): Promise<void> {
    await this.state.storage.put(`revoked:${deviceId}`, true);

    for (const ws of this.state.getWebSockets(deviceId)) {
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

    if (!secret || secret.length > 200) {
      throw new ApplicationError("unauthenticated", "Invalid ticket");
    }

    const key = await this.ticketKey(secret);
    const ticket = await this.state.storage.get<Ticket>(key);
    await this.state.storage.delete(key);

    if (!ticket || ticket.expiresAt <= Date.now()) {
      throw new ApplicationError("unauthenticated", "Expired or consumed ticket");
    }

    const revoked = await this.state.storage.get(`revoked:${ticket.deviceId}`);

    if (revoked) {
      throw new ApplicationError("unauthenticated", "Expired or consumed ticket");
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [ticket.deviceId]);
    console.info({ event: "websocket.connected", deviceId: ticket.deviceId });

    return new Response(null, { status: 101, webSocket: pair[0] });
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

  private async ticketKey(secret: string): Promise<string> {
    return `ticket:${await digest(new TextEncoder().encode(secret))}`;
  }
}
