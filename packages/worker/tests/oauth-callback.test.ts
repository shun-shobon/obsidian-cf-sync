import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/infra/env";
import { oauthCallback } from "../src/infra/http/oauth-callback";

const app = new Hono<{ Bindings: Env }>();

app.get("/oauth/callback", jsxRenderer(), oauthCallback);

describe("OAuth callback", () => {
  it("認可コードとstateをObsidianへ渡し、キャッシュとリファラーを禁止する", async () => {
    const response = await app.request("/oauth/callback?code=auth-code&state=request-state");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('href="obsidian://cf-sync-auth?code=auth-code&amp;state=request-state"');
  });

  it("OAuthエラーの詳細をURLエンコードして渡す", async () => {
    const query = new URLSearchParams({
      state: "request-state",
      error: "access_denied",
      error_description: '拒否 & "<script>alert(1)</script>',
      redirect_uri: "https://untrusted.invalid",
    });
    const response = await app.request(`/oauth/callback?${query.toString()}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("error=access_denied&amp;error_description=");
    expect(html).toContain(
      new URLSearchParams({ error_description: '拒否 & "<script>alert(1)</script>' }).toString(),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("redirect_uri");
    expect(html).not.toContain("untrusted.invalid");
  });

  it.each(["code=auth-code", "state=request-state", "state=&error=access_denied"])(
    "不足したcallbackパラメーターを拒否する: %s",
    async (query) => {
      const response = await app.request(`/oauth/callback?${query.toString()}`);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid OAuth callback");
    },
  );
});
