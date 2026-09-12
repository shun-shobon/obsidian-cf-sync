import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { authStateSchema, metadataSchema, type AuthState } from "../src/domain/auth-state";
import { initialSettings, settingsSchema } from "../src/domain/plugin-settings";
import { serverOrigin } from "../src/domain/server-origin";
import { urlSchema } from "../src/domain/url-schema";
import { OAuthClient } from "../src/infra/auth/oauth-client";
import { tokenResponseSchema } from "../src/infra/auth/oauth-provider";
import { challenge } from "../src/infra/auth/pkce";
import type { HttpRequest, HttpResponse, Transport } from "../src/infra/http/transport";

const resource = "https://sync.example.com/api";
const resourceMetadataUrl =
  "https://sync.example.com/.well-known/cloudflare-access-protected-resource/api";

const metadata = {
  issuer: "https://team.cloudflareaccess.com",
  authorization_endpoint: "https://team.cloudflareaccess.com/authorize",
  token_endpoint: "https://team.cloudflareaccess.com/token",
  registration_endpoint: "https://team.cloudflareaccess.com/register",
};

function setup() {
  const requests: HttpRequest[] = [];
  let saves = 0;
  const state: AuthState = {};
  const transport: Transport = async (request): Promise<HttpResponse> => {
    requests.push(request);
    if (request.url === resource) {
      return {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
        text: "",
        bytes: new ArrayBuffer(0),
      };
    }

    let result: unknown = metadata;
    if (request.url === resourceMetadataUrl) {
      result = { resource, authorization_servers: [metadata.issuer] };
    }

    if (request.url === metadata.registration_endpoint) {
      result = { client_id: "client" };
    }
    if (request.url === metadata.token_endpoint) {
      result = {
        access_token: "oauth:secret",
        refresh_token: "refresh",
        expires_in: 900,
        token_type: "Bearer",
      };
    }

    return { status: 200, headers: {}, text: JSON.stringify(result), bytes: new ArrayBuffer(0) };
  };
  return {
    state,
    requests,
    client: new OAuthClient("https://sync.example.com", state, transport, async () => {
      saves++;
    }),
    saves: () => saves,
  };
}

describe("Managed OAuth", () => {
  it("persists public PKCE S256 login state before opening browser, exchanges once", async () => {
    const { client, state, requests, saves } = setup();
    const url = new URL(await client.begin());
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await challenge(state.pending!.verifier));
    expect(url.searchParams.get("resource")).toBe("https://sync.example.com/api");
    expect(saves()).toBe(1);
    expect(JSON.parse(requests[3]!.body as string)).toMatchObject({
      token_endpoint_auth_method: "none",
      resource,
    });
    const params = { code: "code", state: state.pending!.state };
    await client.finish(params);
    expect(await client.token()).toBe("oauth:secret");
    const exchangeRequest = requests.find((request) => request.url === metadata.token_endpoint);
    const exchangeBody = new URLSearchParams(exchangeRequest!.body as string);
    expect(exchangeBody.get("resource")).toBe(resource);
    await expect(client.finish(params)).rejects.toThrow("無効");
  });

  it("rejects a mismatching callback without consuming a valid login", async () => {
    const { client, state, requests } = setup();
    await client.begin();
    await expect(client.finish({ code: "evil", state: "bad" })).rejects.toThrow("無効");
    expect(state.pending).toBeDefined();
    expect(requests).toHaveLength(4);
  });

  it("refreshes concurrent requests once and retains rotated token on disk", async () => {
    const { client, state, requests } = setup();
    await client.begin();
    await client.finish({ code: "code", state: state.pending!.state });
    state.tokens!.expiresAt = 0;
    const tokens = await Promise.all([client.token(), client.token(), client.token()]);
    expect(tokens).toEqual(["oauth:secret", "oauth:secret", "oauth:secret"]);
    const tokenRequests = requests.filter((request) => request.url === metadata.token_endpoint);
    expect(tokenRequests).toHaveLength(2);

    for (const request of tokenRequests) {
      const body = new URLSearchParams(request.body as string);
      expect(body.get("resource")).toBe(resource);
    }
  });

  it("validates HTTPS server origins", () => {
    expect(serverOrigin("https://sync.example.com/")).toBe("https://sync.example.com");
    expect(() => serverOrigin("http://sync.example.com")).toThrow();
    expect(() => serverOrigin("https://sync.example.com/api")).toThrow();
    expect(() => serverOrigin("https://user:pass@sync.example.com")).toThrow();
  });

  it("refuses expired callbacks and keeps token secrets out of authorization URLs", async () => {
    const { client, state } = setup();
    const url = await client.begin();
    state.pending!.createdAt = Date.now() - 601_000;
    await expect(client.finish({ code: "code", state: state.pending!.state })).rejects.toThrow(
      "期限",
    );
    expect(url).not.toContain("verifier");
    expect(url).not.toContain("refresh_token");
  });

  it("logout during a refresh does not revive the login", async () => {
    const state: AuthState = {
      registration: { metadata, clientId: "client", resource },
      tokens: { accessToken: "old", refreshToken: "refresh", expiresAt: 0 },
    };
    let complete!: (value: Awaited<ReturnType<Transport>>) => void;
    const client = new OAuthClient(
      "https://sync.example.com",
      state,
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      async () => {},
    );
    const refresh = client.token();
    await client.logout();
    complete({
      status: 200,
      headers: {},
      text: JSON.stringify({
        access_token: "new",
        refresh_token: "next",
        expires_in: 900,
        token_type: "Bearer",
      }),
      bytes: new ArrayBuffer(0),
    });
    await expect(refresh).rejects.toThrow("変更");
    expect(state.tokens).toBeUndefined();
  });
});

describe("authentication validation", () => {
  it.each(["not a URL", "http://team.cloudflareaccess.com/token"])(
    "rejects invalid OAuth endpoints without throwing outside validation: %s",
    (tokenEndpoint) => {
      const result = v.safeParse(metadataSchema, {
        ...metadata,
        token_endpoint: tokenEndpoint,
      });

      expect(result.success).toBe(false);
    },
  );

  it.each([Infinity, -Infinity, NaN])(
    "rejects non-finite authentication timestamps: %s",
    (value) => {
      const state = {
        pending: { state: "login", verifier: "a".repeat(43), createdAt: value },
        tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: value },
      };

      expect(v.safeParse(authStateSchema, state).success).toBe(false);
      expect(
        v.safeParse(tokenResponseSchema, {
          access_token: "access",
          expires_in: value,
          token_type: "Bearer",
        }).success,
      ).toBe(false);
    },
  );

  it("preserves optional refresh responses and removes unknown stored fields", () => {
    const response = v.parse(tokenResponseSchema, {
      access_token: "access",
      expires_in: 900,
      token_type: "bEaReR",
      extra: "ignored",
    });
    const state = v.parse(authStateSchema, { extra: "ignored" });

    expect(response).toEqual({ access_token: "access", expires_in: 900, token_type: "bEaReR" });
    expect(state).toEqual({});
  });

  it.each(["00000000-0000-4000-0000-000000000000", "123e4567-e89b-92d3-a456-426614174000"])(
    "rejects non-RFC device identifiers in saved settings: %s",
    (deviceId) => {
      const settings = initialSettings("desktop");
      settings.deviceId = deviceId;

      expect(v.safeParse(settingsSchema, settings).success).toBe(false);
    },
  );
});

describe("URL validation", () => {
  it.each([
    ["  https://team.cloudflareaccess.com/token  ", "https://team.cloudflareaccess.com/token"],
    ["https://team.cloud\tflareaccess.com/to\nke\rn", "https://team.cloudflareaccess.com/token"],
    [" \twss://sync.example.com/w\ns?ticket=abc\r ", "wss://sync.example.com/ws?ticket=abc"],
    ["HTTPS://EXAMPLE.COM:443/Token", "HTTPS://EXAMPLE.COM:443/Token"],
  ])("normalizes URL whitespace without rewriting other components: %s", (input, expected) => {
    expect(v.parse(urlSchema, input)).toBe(expected);
  });

  it("normalizes OAuth metadata before storing endpoints for HTTP requests", () => {
    const parsed = v.parse(metadataSchema, {
      ...metadata,
      token_endpoint: "  https://team.cloudflareaccess.com/to\tken\n  ",
    });

    expect(parsed.token_endpoint).toBe(metadata.token_endpoint);
  });
});
