import type { Operation, OperationResult, DocumentResponse } from "@cf-sync/protocol";
import type { Miniflare } from "miniflare";
import { assert } from "vitest";

export const vaultId = crypto.randomUUID();
export const deviceId = crypto.randomUUID();

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

	return await dispatchAsDevice(mf, device, path, {
		method: method ?? "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
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

async function dispatchAsDevice(
	mf: Miniflare,
	device: string,
	path: string,
	init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
) {
	return await mf.dispatchFetch(`https://test${path}`, {
		...init,
		headers: { "X-Vault-Id": vaultId, "X-Device-Id": device, ...init.headers },
	});
}

export async function apply(mf: Miniflare, operation: Operation) {
	const response = await request(mf, "/operations", operation);
	const responseText = await response.clone().text();

	assert.strictEqual(response.status, 200, responseText);

	return (await response.json()) as OperationResult;
}

export async function document(mf: Miniflare, id: string, device: string = deviceId) {
	const response = await requestAsDevice(mf, device, `/files/${id}`);

	return (await response.json()) as DocumentResponse;
}
