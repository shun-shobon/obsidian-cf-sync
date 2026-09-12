import { idSchema } from "@cf-sync/protocol";
import type { Context } from "hono";
import * as v from "valibot";

import type { Env } from "../env";
import { unwrapRpcResult } from "../rpc-result";

export async function routeWebSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
  const vaultId = v.parse(idSchema, c.req.query("vault"));
  const account = c.env.ACCOUNT.getByName("owner");
  const result = await account.vault(vaultId);
  unwrapRpcResult(result);

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Vault-Id", vaultId);

  const target = c.env.VAULTS.getByName(vaultId);
  const request = new Request(c.req.raw, { headers });

  return target.fetch(request);
}
