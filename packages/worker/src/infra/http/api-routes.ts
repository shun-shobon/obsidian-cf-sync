import { idSchema } from "@cf-sync/protocol";
import { Hono, type Context } from "hono";
import * as v from "valibot";

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

apiRoutes.get("/devices/:id", (c) => {
  const id = v.parse(idSchema, c.req.param("id"));

  return forwardAccount(c, `/devices/${id}`);
});

apiRoutes.delete("/devices/:id", (c) => {
  const id = v.parse(idSchema, c.req.param("id"));

  return forwardAccount(c, `/devices/${id}`);
});

apiRoutes.get("/vaults", (c) => forwardAccount(c, "/vaults"));

apiRoutes.post("/vaults", (c) => forwardAccount(c, "/vaults"));

apiRoutes.get("/vaults/:vaultId/snapshot", (c) => forwardVault(c, "/snapshot"));

apiRoutes.post("/vaults/:vaultId/operations", (c) => forwardVault(c, "/operations"));

apiRoutes.put("/vaults/:vaultId/exclusions", (c) => forwardVault(c, "/exclusions"));

apiRoutes.get("/vaults/:vaultId/files/:id", (c) => {
  const id = v.parse(idSchema, c.req.param("id"));

  return forwardVault(c, `/files/${id}`);
});

apiRoutes.get("/vaults/:vaultId/blobs/:id", (c) => {
  const id = v.parse(idSchema, c.req.param("id"));

  return forwardVault(c, `/blobs/${id}`);
});

apiRoutes.put("/vaults/:vaultId/blobs/:id", (c) => {
  const id = v.parse(idSchema, c.req.param("id"));

  return forwardVault(c, `/blobs/${id}`);
});

apiRoutes.post("/vaults/:vaultId/tickets", async (c) => {
  const response = await forwardVault(c, "/tickets");

  if (!response.ok) {
    return response;
  }

  const ticket = await response.json<{ ticket: string; expiresAt: number }>();
  const url = new URL("/ws", c.req.url);

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }

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
  const vaultId = v.parse(idSchema, c.req.param("vaultId"));
  const deviceId = v.parse(idSchema, c.req.header("X-Device-Id"));
  const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
  const [device, vault] = await Promise.all([
    account.fetch(`https://internal/devices/${deviceId}`),
    account.fetch(`https://internal/vaults/${vaultId}`),
  ]);

  if (!device.ok) {
    return device;
  }

  if (!vault.ok) {
    return vault;
  }

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
  const vaultId = v.parse(idSchema, c.req.query("vault"));
  const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
  const vault = await account.fetch(`https://internal/vaults/${vaultId}`);

  if (!vault.ok) {
    return vault;
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Vault-Id", vaultId);

  const target = c.env.VAULTS.get(c.env.VAULTS.idFromName(vaultId));
  const request = new Request(c.req.raw, { headers });

  return target.fetch(request);
}
