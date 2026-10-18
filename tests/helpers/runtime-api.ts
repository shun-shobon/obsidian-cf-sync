import type { Operation, OperationResult, DocumentResponse } from "@cf-sync/protocol";
import type { Miniflare, Response } from "miniflare";
import { assert } from "vitest";

import { TEST_ACCESS_ASSERTION } from "../fixtures/access-auth";

export const vaultId = crypto.randomUUID();
export const deviceId = crypto.randomUUID();

export const origin = "https://test";
export const accessHeaders = { "Cf-Access-Jwt-Assertion": TEST_ACCESS_ASSERTION };

interface DispatchInit {
	method: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
}

async function dispatch(mf: Miniflare, path: string, init: DispatchInit) {
	return await mf.dispatchFetch(`${origin}${path}`, {
		...init,
		headers: { ...accessHeaders, ...init.headers },
	});
}

async function expectOk(response: Response) {
	assert.strictEqual(response.status, 200, await response.clone().text());

	return response;
}

function jsonInit(method: string, body: unknown): DispatchInit {
	return {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

export async function registerVault(mf: Miniflare) {
	const body = { id: vaultId, name: "Runtime vault" };
	await expectOk(await dispatch(mf, "/api/vaults", jsonInit("POST", body)));
}

export async function registerDevice(mf: Miniflare, device: string) {
	const body = { id: device, name: "Runtime device" };
	await expectOk(await dispatch(mf, "/api/devices", jsonInit("POST", body)));
}

export async function deleteDevice(mf: Miniflare, device: string) {
	await expectOk(await dispatch(mf, `/api/devices/${device}`, { method: "DELETE" }));
}

export async function request(mf: Miniflare, path: string, body?: unknown, method?: string) {
	return await requestAsDevice(mf, deviceId, path, body, method);
}

export async function requestAsDevice(
	mf: Miniflare,
	device: string,
	path: string,
	body?: unknown,
	method?: string,
) {
	if (body === undefined) {
		return await dispatchAsDevice(mf, device, path, { method: method ?? "GET" });
	}

	return await dispatchAsDevice(mf, device, path, jsonInit(method ?? "POST", body));
}

export async function uploadAsDevice(
	mf: Miniflare,
	device: string,
	key: string,
	bytes: Uint8Array,
	hash: string,
) {
	return await dispatchAsDevice(mf, device, `/blobs/${key}`, {
		method: "PUT",
		headers: { "X-Content-Digest": hash, "X-Content-Size": String(bytes.length) },
		body: bytes,
	});
}

async function dispatchAsDevice(mf: Miniflare, device: string, path: string, init: DispatchInit) {
	return await dispatch(mf, `/api/vaults/${vaultId}${path}`, {
		...init,
		headers: { "X-Device-Id": device, ...init.headers },
	});
}

export async function apply(mf: Miniflare, operation: Operation) {
	const response = await expectOk(await request(mf, "/operations", operation));

	return (await response.json()) as OperationResult;
}

export async function document(mf: Miniflare, id: string, device: string = deviceId) {
	const response = await requestAsDevice(mf, device, `/files/${id}`);

	return (await response.json()) as DocumentResponse;
}

export async function issueTicket(mf: Miniflare, device: string = deviceId) {
	const response = await expectOk(await requestAsDevice(mf, device, "/tickets", undefined, "POST"));
	const { url } = (await response.json()) as { url: string };

	return url;
}

export async function openWebSocket(mf: Miniflare, ticketUrl: string) {
	const url = new URL(ticketUrl);
	url.protocol = url.protocol === "wss:" ? "https:" : "http:";

	return await mf.dispatchFetch(url.href, { headers: { Upgrade: "websocket" } });
}

export async function flush(mf: Miniflare) {
	await expectOk(await dispatch(mf, `/test/vaults/${vaultId}/flush`, { method: "POST" }));
}

export async function runtimeState(mf: Miniflare) {
	const response = await dispatch(mf, `/test/vaults/${vaultId}/runtime-state`, { method: "GET" });

	return (await (await expectOk(response)).json()) as {
		incarnation: string;
		alarm: number | null;
		connections: number;
	};
}

export async function echoJson(mf: Miniflare, value: unknown) {
	return await dispatch(mf, `/test/vaults/${vaultId}/echo-json`, jsonInit("POST", value));
}
