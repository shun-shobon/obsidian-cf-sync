import { afterEach, describe, expect, it } from "vitest";

import { serverOrigin } from "../src/domain/server-origin";
import { setLanguage } from "../src/i18n";
import { OAuthClient } from "../src/infra/auth/oauth-client";
import { SyncApi, serverConnection } from "../src/infra/http/api-client";

afterEach(() => setLanguage("en"));

describe("localized errors", () => {
	it.each([
		["ja", "同期 API エラー (503)"],
		["ja-JP", "同期 API エラー (503)"],
		["en", "Sync API error (503)"],
		["fr", "Sync API error (503)"],
	])("selects the language of sync API errors for %s", async (locale, expected) => {
		setLanguage(locale);
		const auth = new OAuthClient(
			"https://sync.test",
			{
				tokens: {
					accessToken: "access",
					refreshToken: "refresh",
					expiresAt: Date.now() + 3_600_000,
				},
			},
			async () => {
				throw new Error("Unexpected token request");
			},
			async () => {},
		);
		const transport = async () => ({
			status: 503,
			headers: {},
			text: "",
			bytes: new ArrayBuffer(0),
		});
		const api = new SyncApi(serverConnection(auth, transport), "device", "vault");

		await expect(api.snapshot()).rejects.toThrow(expected);
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
