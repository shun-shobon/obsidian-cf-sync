import { serverMessageSchema, type ServerMessage } from "@cf-sync/protocol";
import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import type { SyncSocket } from "@cf-sync/sync-core/sync/ports/api-port";
import * as v from "valibot";

import { t } from "../../i18n";

interface ConnectionTicket {
  url: string;
  expiresAt: number;
}

export async function connectSocket(
  ticket: ConnectionTicket,
  origin: string,
  onMessage: (message: ServerMessage) => void,
  onClose: () => void,
): Promise<SyncSocket> {
  const url = new URL(ticket.url);
  const isTrustedUrl = url.protocol === "wss:" && url.host === new URL(origin).host;
  const isExpired = ticket.expiresAt <= Date.now();

  if (!isTrustedUrl || isExpired) {
    throw new Error(t(($) => $.errors.invalidConnectionUrl));
  }

  const socket = new WebSocket(url);
  receiveMessages(socket, onMessage);
  await waitUntilOpen(socket);
  socket.onclose = (event) => {
    if (event.code === 1008 || event.code === 1009) {
      onMessage({
        type: "error",
        message: t(($) => $.errors.websocketRejected, { reason: event.reason }),
      });
      return;
    }
    onClose();
  };

  return {
    send: (message) => {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new ConnectionError(t(($) => $.errors.websocketDisconnected));
      }
      socket.send(JSON.stringify(message));
    },
    close: () => {
      socket.onclose = null;
      socket.close();
    },
  };
}

function receiveMessages(socket: WebSocket, onMessage: (message: ServerMessage) => void) {
  socket.onmessage = (event) => {
    try {
      const parsed = v.safeParse(serverMessageSchema, JSON.parse(String(event.data)));

      if (parsed.success) {
        onMessage(parsed.output);
      } else {
        socket.close(1002, "Invalid message");
      }
    } catch {
      socket.close(1002, "Invalid message");
    }
  };
}

async function waitUntilOpen(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new ConnectionError(t(($) => $.errors.websocketTimeout)));
    }, 15_000);
    socket.onopen = () => {
      window.clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      window.clearTimeout(timer);
      reject(new ConnectionError(t(($) => $.errors.websocketFailed)));
    };
    socket.onclose = () => {
      window.clearTimeout(timer);
      reject(new ConnectionError(t(($) => $.errors.websocketClosed)));
    };
  });
}
