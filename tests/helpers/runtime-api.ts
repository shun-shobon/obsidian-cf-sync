import type { Operation, OperationResult, DocumentResponse } from "@cf-sync/protocol";
import type { Miniflare } from "miniflare";
import { assert } from "vitest";

import { readJson } from "./json";

export const vaultId = crypto.randomUUID();
export const deviceId = crypto.randomUUID();

export async function request(mf: Miniflare, path: string, body?: unknown, method?: string) {
	let requestMethod = method;
	let serializedBody: string | undefined;

	if (body !== undefined) {
		serializedBody = JSON.stringify(body);
	}

	if (requestMethod === undefined) {
		requestMethod = "GET";

		if (body !== undefined) {
			requestMethod = "POST";
		}
	}

	return await mf.dispatchFetch(`https://test${path}`, {
		method: requestMethod,
		headers: {
			"X-Vault-Id": vaultId,
			"X-Device-Id": deviceId,
			"Content-Type": "application/json",
		},
		body: serializedBody,
	});
}

export async function apply(mf: Miniflare, operation: Operation) {
	const response = await request(mf, "/operations", operation);
	const responseText = await response.clone().text();

	assert.strictEqual(response.status, 200, responseText);

	return await readJson<OperationResult>(response);
}

export async function document(mf: Miniflare, id: string) {
	const response = await request(mf, `/files/${id}`);
	return await readJson<DocumentResponse>(response);
}
