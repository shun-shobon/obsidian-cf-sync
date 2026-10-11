import { describe, expect, it, vi } from "vitest";

import { AccountApi, ConnectionError, DocumentNotFoundError, VaultApi } from "../src";
import type { HttpRequest, HttpResponse, ServerConnection } from "../src";

const origin = "https://sync.example.com";
const vaultId = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
type Send = (request: HttpRequest) => Promise<HttpResponse>;

const snapshot = { revision: 1, r2Revision: 1, files: [], exclusions: [] };

function jsonResponse(status: number, value: unknown = {}): HttpResponse {
	const bytes = new TextEncoder().encode(JSON.stringify(value));

	return { status, bytes: new Uint8Array(bytes).buffer };
}

function connection(send: Send): ServerConnection {
	return {
		origin,
		send,
		authorize: () => Promise.resolve({ Authorization: "Bearer token" }),
	};
}

function vaultApi(response: () => Promise<HttpResponse>) {
	const send = vi.fn<Send>(response);

	return { api: new VaultApi(connection(send), deviceId, vaultId), send };
}

describe("shared REST API", () => {
	it("sends Vault requests with authorization and the device", async () => {
		const { api, send } = vaultApi(() => Promise.resolve(jsonResponse(200, snapshot)));

		await expect(api.snapshot()).resolves.toEqual(snapshot);

		expect(send).toHaveBeenCalledWith({
			url: `${origin}/api/vaults/${vaultId}/snapshot`,
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				"X-Device-Id": deviceId,
				Authorization: "Bearer token",
			},
		});
	});

	it("encodes path parameters", async () => {
		const { api, send } = vaultApi(() => Promise.resolve(jsonResponse(200)));

		await api.download({ key: "a/b", size: 0, digest: "" });

		expect(send.mock.calls[0]![0].url).toBe(`${origin}/api/vaults/${vaultId}/blobs/a%2Fb`);
	});

	it("sends account requests without a device", async () => {
		const send = vi.fn<Send>(() => Promise.resolve(jsonResponse(200, [])));
		const account = new AccountApi(connection(send));

		await expect(account.vaults()).resolves.toEqual([]);

		expect(send.mock.calls[0]![0]).toMatchObject({ url: `${origin}/api/vaults` });
		expect(send.mock.calls[0]![0].headers).not.toHaveProperty("X-Device-Id");
	});

	it("treats unreachable servers, server errors and rate limits as retryable", async () => {
		const unreachable = vaultApi(() => Promise.reject(new TypeError("fetch failed")));
		const unavailable = vaultApi(() => Promise.resolve(jsonResponse(503)));
		const limited = vaultApi(() => Promise.resolve(jsonResponse(429)));

		await expect(unreachable.api.snapshot()).rejects.toBeInstanceOf(ConnectionError);
		await expect(unavailable.api.snapshot()).rejects.toBeInstanceOf(ConnectionError);
		await expect(limited.api.snapshot()).rejects.toBeInstanceOf(ConnectionError);
	});

	it.each([400, 401, 403, 404])("treats HTTP %s as fatal", async (status) => {
		const { api } = vaultApi(() => Promise.resolve(jsonResponse(status)));
		const error: unknown = await api.snapshot().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ConnectionError);
		expect(error).not.toBeInstanceOf(DocumentNotFoundError);
	});

	it("reports a missing document separately", async () => {
		const { api } = vaultApi(() => Promise.resolve(jsonResponse(404)));

		await expect(api.document(vaultId)).rejects.toBeInstanceOf(DocumentNotFoundError);
	});
});
