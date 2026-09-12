import { idSchema } from "@cf-sync/protocol";
import { Hono, type Context } from "hono";

import { authenticate } from "../access-auth";
import type { Env } from "../env";

import { notFound, onError } from "./responses";

type ApiContext = { Bindings: Env };

export const apiRoutes = new Hono<ApiContext>();

apiRoutes.onError(onError);
apiRoutes.notFound(notFound);
apiRoutes.use("*", async (c, next) => {
  await authenticate(c.req.raw, c.env);
  await next();
});
apiRoutes.get("/devices", (c) => forwardAccount(c, "/devices"));
apiRoutes.post("/devices", (c) => forwardAccount(c, "/devices"));
apiRoutes.get("/devices/:id", (c) =>
  forwardAccount(c, `/devices/${idSchema.parse(c.req.param("id"))}`),
);
apiRoutes.delete("/devices/:id", (c) =>
  forwardAccount(c, `/devices/${idSchema.parse(c.req.param("id"))}`),
);
apiRoutes.get("/vaults", (c) => forwardAccount(c, "/vaults"));
apiRoutes.post("/vaults", (c) => forwardAccount(c, "/vaults"));
apiRoutes.get("/vaults/:vaultId/snapshot", (c) => forwardVault(c, "/snapshot"));
apiRoutes.post("/vaults/:vaultId/operations", (c) => forwardVault(c, "/operations"));
apiRoutes.put("/vaults/:vaultId/exclusions", (c) => forwardVault(c, "/exclusions"));
apiRoutes.get("/vaults/:vaultId/files/:id", (c) =>
  forwardVault(c, `/files/${idSchema.parse(c.req.param("id"))}`),
);
apiRoutes.get("/vaults/:vaultId/blobs/:id", (c) =>
  forwardVault(c, `/blobs/${idSchema.parse(c.req.param("id"))}`),
);
apiRoutes.put("/vaults/:vaultId/blobs/:id", (c) =>
  forwardVault(c, `/blobs/${idSchema.parse(c.req.param("id"))}`),
);
apiRoutes.post("/vaults/:vaultId/tickets", async (c) => {
  const response = await forwardVault(c, "/tickets");
  if (!response.ok) return response;
  const ticket = await response.json<{ ticket: string; expiresAt: number }>();
  const url = new URL("/ws", c.req.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("vault", c.req.param("vaultId"));
  url.searchParams.set("ticket", ticket.ticket);
  c.header("Cache-Control", "no-store");
  return c.json({ url: url.href, expiresAt: ticket.expiresAt });
});

function forwardAccount(c: Context<ApiContext>, path: string): Promise<Response> {
  const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
  return account.fetch(new Request(`https://internal${path}`, c.req.raw));
}

async function forwardVault(c: Context<ApiContext>, path: string): Promise<Response> {
  const vaultId = idSchema.parse(c.req.param("vaultId"));
  const deviceId = idSchema.parse(c.req.header("X-Device-Id"));
  const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
  const [device, vault] = await Promise.all([
    account.fetch(`https://internal/devices/${deviceId}`),
    account.fetch(`https://internal/vaults/${vaultId}`),
  ]);
  if (!device.ok) return device;
  if (!vault.ok) return vault;
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Vault-Id", vaultId);
  headers.set("X-Device-Id", deviceId);
  const target = c.env.VAULTS.get(c.env.VAULTS.idFromName(vaultId));
  return target.fetch(
    new Request(`https://internal${path}`, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
    }),
  );
}

export async function routeWebSocket(c: Context<ApiContext>): Promise<Response> {
  const vaultId = idSchema.parse(c.req.query("vault"));
  const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
  const vault = await account.fetch(`https://internal/vaults/${vaultId}`);
  if (!vault.ok) return vault;
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Vault-Id", vaultId);
  return c.env.VAULTS.get(c.env.VAULTS.idFromName(vaultId)).fetch(
    new Request(c.req.raw, { headers }),
  );
}
