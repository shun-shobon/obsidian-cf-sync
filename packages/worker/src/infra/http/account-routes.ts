import { idSchema } from "@cf-sync/protocol";
import type { Device } from "@cf-sync/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { ownerAccount } from "../env";
import type { Env } from "../env";
import { unwrapRpcResult } from "../rpc-result";

const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));
const namedSchema = v.object({ id: idSchema, name: nameSchema });
const renameSchema = v.object({ name: nameSchema });

// Released plugins up to 0.3.1 reject a device without revoked.
function compatibleDevice(device: Device) {
	return { ...device, revoked: false };
}

export const accountApiRoutes = new Hono<{ Bindings: Env }>();

accountApiRoutes.get("/devices", async (c) => {
	const account = ownerAccount(c.env);
	const result = await account.devices();

	return c.json(unwrapRpcResult(result).map(compatibleDevice));
});

accountApiRoutes.post("/devices", async (c) => {
	const input = v.parse(namedSchema, await c.req.json());
	const account = ownerAccount(c.env);
	const result = await account.registerDevice(input);

	return c.json(compatibleDevice(unwrapRpcResult(result)));
});

accountApiRoutes.patch("/devices/:id", async (c) => {
	const id = v.parse(idSchema, c.req.param("id"));
	const { name } = v.parse(renameSchema, await c.req.json());
	const account = ownerAccount(c.env);
	const result = await account.renameDevice({ id, name });

	return c.json(compatibleDevice(unwrapRpcResult(result)));
});

accountApiRoutes.delete("/devices/:id", async (c) => {
	const id = v.parse(idSchema, c.req.param("id"));
	const account = ownerAccount(c.env);
	const result = await account.deleteDevice(id);
	unwrapRpcResult(result);

	return c.json({ ok: true });
});

accountApiRoutes.get("/vaults", async (c) => {
	const account = ownerAccount(c.env);
	const result = await account.vaults();

	return c.json(unwrapRpcResult(result));
});

accountApiRoutes.post("/vaults", async (c) => {
	const input = v.parse(namedSchema, await c.req.json());
	const account = ownerAccount(c.env);
	const result = await account.createVault(input);

	return c.json(unwrapRpcResult(result));
});
