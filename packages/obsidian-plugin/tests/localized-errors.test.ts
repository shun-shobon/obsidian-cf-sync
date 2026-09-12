import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "../src/domain/api-error";
import { serverOrigin } from "../src/domain/server-origin";
import { setLanguage } from "../src/i18n";
import { OAuthClient } from "../src/infra/auth/oauth-client";

afterEach(() => setLanguage("en"));

describe("localized errors", () => {
  it.each([
    ["ja", "同期 API エラー (503)"],
    ["ja-JP", "同期 API エラー (503)"],
    ["en", "Sync API error (503)"],
    ["fr", "Sync API error (503)"],
  ])("selects the language for %s without changing the HTTP status", (locale, expected) => {
    setLanguage(locale);
    const error = new ApiError(503);

    expect(error.message).toBe(expected);
    expect(error.status).toBe(503);
  });

  it.each([
    ["ja", "サーバーはパスを含まない HTTPS URL を指定してください"],
    ["en", "Enter an HTTPS server URL without a path."],
  ])("localizes malformed and unsupported server URLs in %s", (locale, expected) => {
    setLanguage(locale);
    expect(() => serverOrigin("not a URL")).toThrow(expected);
    expect(() => serverOrigin("http://sync.test/path")).toThrow(expected);
  });

  it.each([
    ["ja", "ログインが必要です"],
    ["en", "Login is required."],
  ])("localizes authentication errors before making requests in %s", async (locale, expected) => {
    setLanguage(locale);
    const client = new OAuthClient(
      "https://sync.test",
      {},
      async () => {
        throw new Error("Unexpected network request");
      },
      async () => {},
    );

    await expect(client.token()).rejects.toThrow(expected);
  });
});
