import type { Context } from "hono";

import type { Env } from "../env";

import { getOAuthCallbackMessages } from "./oauth-callback-messages";

export function oauthCallback(c: Context<{ Bindings: Env }>) {
  const { locale, t } = getOAuthCallbackMessages(c);
  const source = new URL(c.req.url);
  const target = new URL("obsidian://cf-sync-auth");

  for (const key of ["code", "state", "error", "error_description"]) {
    const value = source.searchParams.get(key);

    if (value) {
      target.searchParams.set(key, value);
    }
  }

  const hasState = target.searchParams.has("state");
  const hasResult = target.searchParams.has("code") || target.searchParams.has("error");

  if (!hasState || !hasResult) {
    return c.text(
      t(($) => $.invalidCallback),
      400,
    );
  }

  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );

  return c.render(
    <html lang={locale}>
      <head>
        <meta charset="utf-8" />
        <title>Obsidian CF Sync</title>
      </head>
      <body>
        <h1>{t(($) => $.heading)}</h1>
        <p>
          <a href={target.href}>{t(($) => $.openObsidian)}</a>
        </p>
      </body>
    </html>,
  );
}
