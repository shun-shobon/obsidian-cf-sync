import { describe, expect, it } from "vitest";

import type { AuthState } from "../src/domain/auth-state";
import { serverOrigin } from "../src/domain/server-origin";
import { OAuthClient } from "../src/infra/auth/oauth-client";
import { challenge } from "../src/infra/auth/pkce";
import type { HttpRequest, Transport } from "../src/infra/http/transport";

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
  const transport: Transport = async (request) => {
    requests.push(request);
    let result: unknown = metadata;
    if (request.url === metadata.registration_endpoint) result = { client_id: "client" };
    if (request.url === metadata.token_endpoint)
      result = {
        access_token: "oauth:secret",
        refresh_token: "refresh",
        expires_in: 900,
        token_type: "Bearer",
      };
    return { status: 200, text: JSON.stringify(result), bytes: new ArrayBuffer(0) };
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
    expect(JSON.parse(requests[1]!.body as string)).toMatchObject({
      token_endpoint_auth_method: "none",
    });
    const params = { code: "code", state: state.pending!.state };
    await client.finish(params);
    expect(await client.token()).toBe("oauth:secret");
    await expect(client.finish(params)).rejects.toThrow("無効");
  });
  it("rejects a mismatching callback without consuming a valid login", async () => {
    const { client, state, requests } = setup();
    await client.begin();
    await expect(client.finish({ code: "evil", state: "bad" })).rejects.toThrow("無効");
    expect(state.pending).toBeDefined();
    expect(requests).toHaveLength(2);
  });
  it("refreshes concurrent requests once and retains rotated token on disk", async () => {
    const { client, state, requests } = setup();
    await client.begin();
    await client.finish({ code: "code", state: state.pending!.state });
    state.tokens!.expiresAt = 0;
    const tokens = await Promise.all([client.token(), client.token(), client.token()]);
    expect(tokens).toEqual(["oauth:secret", "oauth:secret", "oauth:secret"]);
    expect(requests.filter((r) => r.url === metadata.token_endpoint)).toHaveLength(2);
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
      registration: { metadata, clientId: "client" },
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
