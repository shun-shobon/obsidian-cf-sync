import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthState } from "../src/domain/auth-state";
import { OAuthClient } from "../src/infra/auth/oauth-client";
import { SyncApi, serverConnection } from "../src/infra/http/api-client";
import type { Transport } from "../src/infra/http/transport";

const origin = "https://sync.example.com";

class FakeWebSocket extends EventTarget {
	static readonly OPEN = 1;
	static readonly urls: string[] = [];
	static readonly sockets: FakeWebSocket[] = [];
	readyState = 0;

	constructor(url: URL) {
		super();
		FakeWebSocket.urls.push(url.href);
		FakeWebSocket.sockets.push(this);
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.dispatchEvent(new Event("open"));
		});
	}

	send() {}

	close() {}

	closeWith(code: number, reason: string) {
		this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
	}
}

beforeEach(() => {
	FakeWebSocket.urls.length = 0;
	FakeWebSocket.sockets.length = 0;
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function apiClient(ticketUrl: string) {
	const state: AuthState = {
		tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 },
	};
	const ticket = { url: ticketUrl, expiresAt: Date.now() - 60_000 };
	const transport: Transport = async () => ({
		status: 200,
		headers: {},
		text: JSON.stringify(ticket),
		bytes: new Uint8Array(new TextEncoder().encode(JSON.stringify(ticket))).buffer,
	});
	const auth = new OAuthClient(origin, state, transport, async () => {});

	return new SyncApi(serverConnection(auth, transport), "device", "vault");
}

describe("WebSocket connection tickets", () => {
	it("connects even when the device clock is ahead of the ticket expiry", async () => {
		const url = "wss://sync.example.com/api/vaults/vault/socket?ticket=secret";

		await apiClient(url).connect(vi.fn(), vi.fn());

		expect(FakeWebSocket.urls).toEqual([url]);
	});

	it.each([
		"ws://sync.example.com/api/vaults/vault/socket?ticket=secret",
		"wss://other.example.com/api/vaults/vault/socket?ticket=secret",
	])("rejects a ticket URL outside the server origin: %s", async (url) => {
		await expect(apiClient(url).connect(vi.fn(), vi.fn())).rejects.toThrow(Error);
		expect(FakeWebSocket.urls).toEqual([]);
	});
});

describe("WebSocket close", () => {
	const url = "wss://sync.example.com/api/vaults/vault/socket?ticket=secret";

	it.each([1008, 1009])("reports a rejected message as a non-retryable error: %s", async (code) => {
		const onClose = vi.fn();
		await apiClient(url).connect(vi.fn(), onClose);

		FakeWebSocket.sockets[0]!.closeWith(code, "Invalid message");

		const error: unknown = onClose.mock.calls[0]![0];
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ConnectionError);
	});

	it.each([1000, 1006, 4000])("reports other closures as retryable: %s", async (code) => {
		const onClose = vi.fn();
		await apiClient(url).connect(vi.fn(), onClose);

		FakeWebSocket.sockets[0]!.closeWith(code, "");

		expect(onClose.mock.calls[0]![0]).toBeInstanceOf(ConnectionError);
	});
});
