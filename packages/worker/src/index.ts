import { Hono } from "hono";

import type { Env } from "./infra/env";
import { routeApi, routeWebSocket } from "./infra/http/api-routes";
import { oauthCallback } from "./infra/http/oauth-callback";

export { Account as AccountDO } from "./infra/durable-objects/account";
export { Vault as VaultDO } from "./infra/durable-objects/vault";

const app = new Hono<{ Bindings: Env }>();

app.get("/oauth/callback", oauthCallback);
app.all("/api/*", routeApi);
app.get("/ws", routeWebSocket);

export default app;
