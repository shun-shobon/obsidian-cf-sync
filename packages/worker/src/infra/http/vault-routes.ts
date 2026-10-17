import { digestSchema, idSchema, pathSchema } from "@cf-sync/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import type { Vault } from "../durable-objects/vault";
import { ownerAccount } from "../env";
import type { Env } from "../env";
import { unwrapRpcResult } from "../rpc-result";
import type { RpcResult } from "../rpc-result";

const exclusionsSchema = v.object({
	exclusions: v.pipe(v.array(pathSchema), v.maxLength(1000)),
});

type VaultContext = {
	Bindings: Env;
	Variables: {
		vaultId: string;
		deviceId: string;
		vault: DurableObjectStub<Vault>;
	};
};

function jsonStreamResponse(result: RpcResult<ReadableStream<Uint8Array>>): Response {
	return new Response(unwrapRpcResult(result), { headers: { "Content-Type": "application/json" } });
}

export const vaultApiRoutes = new Hono<VaultContext>();

vaultApiRoutes.use("*", async (c, next) => {
	const vaultId = v.parse(idSchema, c.req.param("vaultId"));
	const deviceId = v.parse(idSchema, c.req.header("X-Device-Id"));
	const account = ownerAccount(c.env);
	unwrapRpcResult(await account.authorizeVaultAccess(deviceId, vaultId));

	c.set("vaultId", vaultId);
	c.set("deviceId", deviceId);
	c.set("vault", c.env.VAULTS.getByName(vaultId));
	await next();
});

vaultApiRoutes.get("/snapshot", async (c) => {
	const vault = c.get("vault");
	const result = await vault.snapshot(c.get("vaultId"), c.get("deviceId"));

	return jsonStreamResponse(result);
});

vaultApiRoutes.post("/operations", async (c) => {
	const vault = c.get("vault");
	const result = await vault.applyOperation(c.get("vaultId"), c.get("deviceId"), c.req.raw.body);

	return c.json(unwrapRpcResult(result));
});

vaultApiRoutes.get("/files/:id", async (c) => {
	const id = v.parse(idSchema, c.req.param("id"));
	const vault = c.get("vault");
	const result = await vault.document(c.get("vaultId"), c.get("deviceId"), id);

	return jsonStreamResponse(result);
});

vaultApiRoutes.put("/exclusions", async (c) => {
	const { exclusions } = v.parse(exclusionsSchema, await c.req.json());
	const vault = c.get("vault");
	const result = await vault.setExclusions(c.get("vaultId"), c.get("deviceId"), exclusions);

	return jsonStreamResponse(result);
});

vaultApiRoutes.post("/tickets", async (c) => {
	const vaultId = c.get("vaultId");
	const vault = c.get("vault");
	const result = await vault.issueTicket(vaultId, c.get("deviceId"));
	const ticket = unwrapRpcResult(result);
	const url = new URL("/ws", c.req.url);

	if (url.protocol === "https:") {
		url.protocol = "wss:";
	} else {
		url.protocol = "ws:";
	}

	url.searchParams.set("vault", vaultId);
	url.searchParams.set("ticket", ticket.ticket);
	c.header("Cache-Control", "no-store");

	return c.json({ url: url.href });
});

vaultApiRoutes.get("/blobs/:id", async (c) => {
	const id = v.parse(idSchema, c.req.param("id"));
	const vault = c.get("vault");
	const result = await vault.downloadBlob(c.get("vaultId"), c.get("deviceId"), id);
	const body = unwrapRpcResult(result);

	return new Response(body, { headers: { "Content-Type": "application/octet-stream" } });
});

vaultApiRoutes.put("/blobs/:id", async (c) => {
	const key = v.parse(idSchema, c.req.param("id"));
	const digest = v.parse(digestSchema, c.req.header("X-Content-Digest"));
	const size = c.req.raw.headers.get("X-Content-Size");
	const vault = c.get("vault");
	const result = await vault.uploadBlob(
		c.get("vaultId"),
		c.get("deviceId"),
		key,
		digest,
		c.req.raw.body,
		size,
	);

	return c.json(unwrapRpcResult(result));
});
