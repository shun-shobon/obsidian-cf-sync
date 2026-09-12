import { Hono } from "hono";

import { idSchema } from "../shared/protocol";

import { authenticate } from "./auth";
import { handleErrors, HttpError, type Env } from "./env";
export { Account as AccountDO } from "./account";
export { Vault as VaultDO } from "./vault";
const app = new Hono<{ Bindings: Env }>();
app.get("/oauth/callback", (c) => {
  const source = new URL(c.req.url);
  const target = new URL("obsidian://cf-sync-auth");
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = source.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  if (
    !target.searchParams.get("state") ||
    (!target.searchParams.get("code") && !target.searchParams.get("error"))
  )
    return c.text("Invalid OAuth callback", 400);
  const href = target.href
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  return c.html(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Obsidian CF Sync</title><h1>Obsidian に戻る</h1><p><a href="${href}">Obsidian を開いてログインを完了する</a></p></html>`,
  );
});
app.all("/api/*", (c) =>
  handleErrors(async () => {
    await authenticate(c.req.raw, c.env);
    const account = c.env.ACCOUNT.get(c.env.ACCOUNT.idFromName("owner"));
    const path = new URL(c.req.url).pathname.slice(4);
    if (/^\/devices(?:\/[^/]+)?$/.test(path) || path === "/vaults")
      return account.fetch(new Request(`https://internal${path}`, c.req.raw));
    const match = /^\/vaults\/([^/]+)(\/.*)$/.exec(path);
    if (!match) throw new HttpError(404, "Not found");
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
  }),
);
app.get("/ws", (c) =>
  handleErrors(async () => {
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
  }),
);
export default app;
