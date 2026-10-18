import { idSchema } from "@cf-sync/protocol";
import type { Context } from "hono";
import * as v from "valibot";

import { ownerAccount } from "../env";
import type { Env } from "../env";
import { unwrapRpcResult } from "../rpc-result";

export async function routeWebSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
	const vaultId = v.parse(idSchema, c.req.query("vault"));
	const account = ownerAccount(c.env);
	const result = await account.vault(vaultId);
	unwrapRpcResult(result);

	const target = c.env.VAULTS.getByName(vaultId);

	return await target.fetch(c.req.raw);
}
