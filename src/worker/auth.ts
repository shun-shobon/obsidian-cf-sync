import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Env } from "./env";
import { HttpError } from "./env";
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(request: Request, env: Env): Promise<void> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL)
    throw new HttpError(503, "Access is not configured");
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new HttpError(401, "Access assertion required");
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(assertion, keys, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "email"],
    });
    if (
      typeof payload["email"] !== "string" ||
      payload["email"].toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
    )
      throw new Error("Owner mismatch");
  } catch {
    throw new HttpError(401, "Invalid Access identity");
  }
}
