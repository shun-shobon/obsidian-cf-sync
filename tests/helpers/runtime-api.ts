import type { Operation, OperationResult, DocumentResponse } from "@cf-sync/protocol";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";

export const vaultId = crypto.randomUUID();
export const deviceId = crypto.randomUUID();

export async function request(
  mf: Miniflare,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  return mf.dispatchFetch(`https://test${path}`, {
    method,
    headers: { "X-Vault-Id": vaultId, "X-Device-Id": deviceId, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function apply(mf: Miniflare, operation: Operation) {
  const response = await request(mf, "/operations", operation);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as OperationResult;
}

export async function document(mf: Miniflare, id: string) {
  const response = await request(mf, `/files/${id}`);
  return (await response.json()) as DocumentResponse;
}
