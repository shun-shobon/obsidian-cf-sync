import { Hono } from "hono";

import { authenticate } from "../access-auth";
import type { Env } from "../env";

import { accountApiRoutes } from "./account-routes";
import { notFound, onError } from "./responses";
import { vaultApiRoutes } from "./vault-routes";

export const apiRoutes = new Hono<{ Bindings: Env }>();

apiRoutes.onError(onError);

apiRoutes.notFound(notFound);

apiRoutes.use("*", async (c, next) => {
  await authenticate(c.req.raw, c.env);
  await next();
});

apiRoutes.route("/", accountApiRoutes);

apiRoutes.route("/vaults/:vaultId", vaultApiRoutes);
