import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/infra/env";
import { oauthCallback } from "../src/infra/http/oauth-callback";
import { getOAuthCallbackMessages } from "../src/infra/http/oauth-callback-messages";

const app = new Hono<{ Bindings: Env }>();

app.get("/oauth/callback", jsxRenderer(), oauthCallback);

describe("OAuth callback", () => {
  it.each([
    [undefined, "en", "Return to Obsidian", "Open Obsidian to finish signing in"],
    ["en-US", "en", "Return to Obsidian", "Open Obsidian to finish signing in"],
    ["fr-FR", "en", "Return to Obsidian", "Open Obsidian to finish signing in"],
    ["ja", "ja", "Obsidian に戻る", "Obsidian を開いてログインを完了する"],
    ["ja-JP", "ja", "Obsidian に戻る", "Obsidian を開いてログインを完了する"],
    ["JA-jp", "ja", "Obsidian に戻る", "Obsidian を開いてログインを完了する"],
    ["fr-FR,ja;q=0.8", "ja", "Obsidian に戻る", "Obsidian を開いてログインを完了する"],
    ["en;q=0.5,ja-JP;q=0.9", "ja", "Obsidian に戻る", "Obsidian を開いてログインを完了する"],
    ["ja;q=0.3,en-US;q=0.9", "en", "Return to Obsidian", "Open Obsidian to finish signing in"],
    ["ja;q=0,en;q=0.5", "en", "Return to Obsidian", "Open Obsidian to finish signing in"],
    ["ja;q=0", "en", "Return to Obsidian", "Open Obsidian to finish signing in"],
  ])("ブラウザの言語設定 %s で %s を表示する", async (language, locale, heading, link) => {
    const headers = new Headers();

    if (language !== undefined) {
      headers.set("Accept-Language", language);
    }

    const response = await app.request("/oauth/callback?code=auth-code&state=request-state", {
      headers,
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain(`<h1>${heading}</h1>`);
    expect(html).toContain(`>${link}</a>`);
    expect(html).toContain('href="obsidian://cf-sync-auth?code=auth-code&amp;state=request-state"');
  });

  it("日本語のブラウザでは不足した callback のエラーも日本語で表示する", async () => {
    const response = await app.request("/oauth/callback?code=auth-code", {
      headers: { "Accept-Language": "ja-JP,en-US;q=0.9" },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("無効な OAuth コールバックです");
  });

  it("並行するリクエストの言語が翻訳関数に混ざらない", async () => {
    const concurrentApp = new Hono();
    let releaseJapanese!: () => void;
    const englishStarted = new Promise<void>((resolve) => {
      releaseJapanese = resolve;
    });

    concurrentApp.get("/", async (c) => {
      const { locale, t } = getOAuthCallbackMessages(c);

      if (locale === "ja") {
        await englishStarted;
      } else {
        releaseJapanese();
      }

      return c.text(t(($) => $.heading));
    });

    const [japanese, english] = await Promise.all([
      concurrentApp.request("/", { headers: { "Accept-Language": "ja" } }),
      concurrentApp.request("/", { headers: { "Accept-Language": "en" } }),
    ]);

    expect(await japanese.text()).toBe("Obsidian に戻る");
    expect(await english.text()).toBe("Return to Obsidian");
  });

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
