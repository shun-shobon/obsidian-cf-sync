import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { authenticate } from "../src/infra/access-auth";
import type { Env } from "../src/infra/env";

describe("Access authentication", () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let env: Env;
  let claims: JWTPayload;

  beforeAll(async () => {
    [keys, otherKeys] = await Promise.all([generateKeyPair("RS256"), generateKeyPair("RS256")]);
  });

  beforeEach(async () => {
    env = {
      ACCESS_TEAM_DOMAIN: `${crypto.randomUUID()}.cloudflareaccess.com`,
      ACCESS_AUD: "sync-app",
    } as Env;
    claims = {
      iss: `https://${env.ACCESS_TEAM_DOMAIN}`,
      aud: env.ACCESS_AUD,
      sub: "access-user",
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const jwk = await exportJWK(keys.publicKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "access-key", alg: "RS256" }] })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function request(payload: JWTPayload, signingKey = keys.privateKey) {
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "access-key" })
      .sign(signingKey);
    return new Request("https://sync.test/api/devices", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
  }

  it.each([{}, { email: "alice@example.com" }, { email: "bob@example.com" }])(
    "accepts a valid Access assertion with claims %j",
    async (identity) => {
      await expect(
        authenticate(await request({ ...claims, ...identity }), env),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["iss", "aud", "exp", "sub"])("rejects a missing %s claim", async (claim) => {
    delete claims[claim];
    await expect(authenticate(await request(claims), env)).rejects.toMatchObject({
      kind: "unauthenticated",
    });
  });

  it.each([{ iss: "https://other.cloudflareaccess.com" }, { aud: "other-app" }, { exp: 1 }])(
    "rejects invalid claims %j",
    async (invalid) => {
      await expect(
        authenticate(await request({ ...claims, ...invalid }), env),
      ).rejects.toMatchObject({
        kind: "unauthenticated",
      });
    },
  );

  it("rejects an assertion signed by a different key", async () => {
    await expect(
      authenticate(await request(claims, otherKeys.privateKey), env),
    ).rejects.toMatchObject({
      kind: "unauthenticated",
    });
  });

  it("rejects an assertion using an unapproved algorithm", async () => {
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .sign(crypto.getRandomValues(new Uint8Array(32)));
    await expect(
      authenticate(
        new Request("https://sync.test/api/devices", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        env,
      ),
    ).rejects.toMatchObject({ kind: "unauthenticated" });
  });
});
