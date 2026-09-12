import type { Context } from "hono";

import type { Env } from "../env";

export function oauthCallback(c: Context<{ Bindings: Env }>): Response {
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
}
