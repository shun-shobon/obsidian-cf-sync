import { idSchema } from "@cf-sync/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import type { Env } from "../env";
import { unwrapRpcResult } from "../rpc-result";

const namedSchema = v.object({
  id: idSchema,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});

export const accountApiRoutes = new Hono<{ Bindings: Env }>();

accountApiRoutes.get("/devices", async (c) => {
  const account = c.env.ACCOUNT.getByName("owner");
  const result = await account.devices();

  return c.json(unwrapRpcResult(result));
});

accountApiRoutes.post("/devices", async (c) => {
  const input = v.parse(namedSchema, await c.req.json());
  const account = c.env.ACCOUNT.getByName("owner");
  const result = await account.registerDevice(input);

  return c.json(unwrapRpcResult(result));
});

accountApiRoutes.get("/devices/:id", async (c) => {
  const id = v.parse(idSchema, c.req.param("id"));
  const account = c.env.ACCOUNT.getByName("owner");
  const result = await account.device(id);

  return c.json(unwrapRpcResult(result));
});

accountApiRoutes.delete("/devices/:id", async (c) => {
  const id = v.parse(idSchema, c.req.param("id"));
  const account = c.env.ACCOUNT.getByName("owner");
  const result = await account.revokeDevice(id);
  unwrapRpcResult(result);

  return c.json({ ok: true });
});

accountApiRoutes.get("/vaults", async (c) => {
  const account = c.env.ACCOUNT.getByName("owner");
  const result = await account.vaults();

  return c.json(unwrapRpcResult(result));
});

accountApiRoutes.post("/vaults", async (c) => {
  const input = v.parse(namedSchema, await c.req.json());
  const account = c.env.ACCOUNT.getByName("owner");
  const result = await account.createVault(input);

  return c.json(unwrapRpcResult(result));
});
