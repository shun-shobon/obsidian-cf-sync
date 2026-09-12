import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";

import type { Env } from "./infra/env";
import { apiRoutes, routeWebSocket } from "./infra/http/api-routes";
import { oauthCallback } from "./infra/http/oauth-callback";
import { notFound, onError } from "./infra/http/responses";

export { Account as AccountDO } from "./infra/durable-objects/account";
export { Vault as VaultDO } from "./infra/durable-objects/vault";

const app = new Hono<{ Bindings: Env }>();

app.onError(onError);
app.notFound(notFound);

app.get("/oauth/callback", jsxRenderer(), oauthCallback);
app.route("/api", apiRoutes);

app.get("/ws", routeWebSocket);

export default app;
