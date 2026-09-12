import { serverMessageSchema, type ServerMessage } from "@cf-sync/protocol";
import * as v from "valibot";

interface ConnectionTicket {
  url: string;
  expiresAt: number;
}

export async function connectSocket(
  ticket: ConnectionTicket,
  origin: string,
  onMessage: (message: ServerMessage) => void,
  onClose: () => void,
): Promise<{ close(): void }> {
  const url = new URL(ticket.url);
  const isTrustedUrl = url.protocol === "wss:" && url.host === new URL(origin).host;
  const isExpired = ticket.expiresAt <= Date.now();

  if (!isTrustedUrl || isExpired) {
    throw new Error("接続 URL が無効です");
  }

  const socket = new WebSocket(url);
  receiveMessages(socket, onMessage);
  await waitUntilOpen(socket);
  socket.onclose = onClose;

  return {
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
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket 接続がタイムアウトしました"));
    }, 15_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket に接続できません"));
    };
    socket.onclose = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket が閉じられました"));
    };
  });
}
