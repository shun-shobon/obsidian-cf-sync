import { idSchema } from "@cf-sync/protocol";
import type { Context } from "hono";

import { ApplicationError } from "../../domain/errors";
import { authenticate } from "../access-auth";
import type { Env } from "../env";

import { handleErrors } from "./responses";

export function routeApi(c: Context<{ Bindings: Env }>): Promise<Response> {
  return handleErrors(async () => {
    await authenticate(c.req.raw, c.env);
    const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
    const path = new URL(c.req.url).pathname.slice(4);
    if (/^\/devices(?:\/[^/]+)?$/.test(path) || path === "/vaults")
      return account.fetch(new Request(`https://internal${path}`, c.req.raw));
    const match = /^\/vaults\/([^/]+)(\/.*)$/.exec(path);
    if (!match) throw new ApplicationError("not-found", "Not found");
    const vaultId = idSchema.parse(match[1]);
    const deviceId = idSchema.parse(c.req.header("X-Device-Id"));
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
    const response = await target.fetch(
      new Request(`https://internal${match[2]}`, {
        method: c.req.method,
        headers,
        body: c.req.raw.body,
      }),
    );
    if (match[2] !== "/tickets" || !response.ok) return response;
    const ticket = await response.json<{ ticket: string; expiresAt: number }>();
    const url = new URL("/ws", c.req.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("vault", vaultId);
    url.searchParams.set("ticket", ticket.ticket);
    return Response.json(
      { url: url.href, expiresAt: ticket.expiresAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

export function routeWebSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
  return handleErrors(async () => {
    const url = new URL(c.req.url);
    const vaultId = idSchema.parse(url.searchParams.get("vault"));
    const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
    const vault = await account.fetch(`https://internal/vaults/${vaultId}`);
    if (!vault.ok) return vault;
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-Vault-Id", vaultId);
    return c.env.VAULTS.get(c.env.VAULTS.idFromName(vaultId)).fetch(
      new Request(c.req.raw, { headers }),
    );
  });
}
