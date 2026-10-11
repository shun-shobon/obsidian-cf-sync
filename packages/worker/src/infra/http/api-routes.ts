import { Hono } from "hono";

import { authenticate } from "../access-auth";
import type { Env } from "../env";
import { accountApiRoutes } from "./account-routes";
import { vaultApiRoutes } from "./vault-routes";

export const apiRoutes = new Hono<{ Bindings: Env }>();

apiRoutes.use("*", async (c, next) => {
	await authenticate(c.req.raw, c.env);
	console.info({ event: "access.authenticated" });

	await next();
});

apiRoutes.route("/", accountApiRoutes);

apiRoutes.route("/vaults/:vaultId", vaultApiRoutes);
