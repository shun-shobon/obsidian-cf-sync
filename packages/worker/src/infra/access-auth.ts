import { createRemoteJWKSet, jwtVerify } from "jose";

import { ApplicationError } from "../domain/errors";
import type { Env } from "./env";

let keys: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function authenticate(request: Request, env: Env): Promise<void> {
	if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
		throw new ApplicationError("unavailable", "Access is not configured");
	}

	const assertion = request.headers.get("Cf-Access-Jwt-Assertion");

	if (assertion == null || assertion === "") {
		throw new ApplicationError("unauthenticated", "Access assertion required");
	}

	const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
	keys ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

	try {
		await jwtVerify(assertion, keys, {
			issuer,
			audience: env.ACCESS_AUD,
			algorithms: ["RS256"],
			requiredClaims: ["exp", "sub"],
		});
	} catch {
		throw new ApplicationError("unauthenticated", "Invalid Access identity");
	}
}
