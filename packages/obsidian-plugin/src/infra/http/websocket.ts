import { serverMessageSchema } from "@cf-sync/protocol";
import type { ServerMessage } from "@cf-sync/protocol";
import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import type { SyncSocket } from "@cf-sync/sync-core/sync/ports/api-port";
import * as v from "valibot";

import { t } from "../../i18n";

export async function connectSocket(
	ticketUrl: string,
	origin: string,
	onMessage: (message: ServerMessage) => void,
	onClose: (error: Error) => void,
): Promise<SyncSocket> {
	const url = new URL(ticketUrl);
	const isTrustedUrl = url.protocol === "wss:" && url.host === new URL(origin).host;

	if (!isTrustedUrl) {
		throw new Error(t(($) => $.errors.invalidConnectionUrl));
	}

	const socket = new WebSocket(url);
	receiveMessages(socket, onMessage);
	await waitUntilOpen(socket);

	const closeListener = new AbortController();
	socket.addEventListener("close", (event) => onClose(closeError(event)), {
		signal: closeListener.signal,
	});

	return {
		send: (message) => {
			if (socket.readyState !== WebSocket.OPEN) {
				throw new ConnectionError(t(($) => $.errors.websocketDisconnected));
			}
			socket.send(JSON.stringify(message));
		},
		close: () => {
			closeListener.abort();
			socket.close();
		},
	};
}

function closeError(event: CloseEvent): Error {
	const isRejected = event.code === 1008 || event.code === 1009;

	if (isRejected) {
		return new Error(t(($) => $.errors.websocketRejected, { reason: event.reason }));
	}

	return new ConnectionError(t(($) => $.errors.websocketDisconnected));
}

function receiveMessages(socket: WebSocket, onMessage: (message: ServerMessage) => void) {
	socket.addEventListener("message", (event) => {
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
	});
}

async function waitUntilOpen(socket: WebSocket) {
	const listeners = new AbortController();
	const { signal } = listeners;

	try {
		await new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				socket.close();
				reject(new ConnectionError(t(($) => $.errors.websocketTimeout)));
			}, 15_000);
			signal.addEventListener("abort", () => window.clearTimeout(timer));

			socket.addEventListener("open", () => resolve(), { signal });
			socket.addEventListener(
				"error",
				() => reject(new ConnectionError(t(($) => $.errors.websocketFailed))),
				{ signal },
			);
			socket.addEventListener(
				"close",
				() => reject(new ConnectionError(t(($) => $.errors.websocketClosed))),
				{ signal },
			);
		});
	} finally {
		listeners.abort();
	}
}
