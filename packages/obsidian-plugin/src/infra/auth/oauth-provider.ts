import * as v from "valibot";

import { metadataSchema } from "../../domain/auth-state";
import type { HttpRequest, Transport } from "../http/transport";

export const tokenResponseSchema = v.object({
  access_token: v.pipe(v.string(), v.minLength(1)),
  refresh_token: v.optional(v.pipe(v.string(), v.minLength(1))),
  expires_in: v.pipe(v.number(), v.finite(), v.gtValue(0)),
  token_type: v.pipe(
    v.string(),
    v.check((value) => value.toLowerCase() === "bearer"),
  ),
});

const clientRegistrationSchema = v.object({
  client_id: v.pipe(v.string(), v.minLength(1)),
});

async function requestJson(transport: Transport, request: HttpRequest): Promise<unknown> {
  const result = await transport(request);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`認証設定の取得に失敗しました (${result.status})`);
  }

  return JSON.parse(result.text) as unknown;
}

export async function registerClient(origin: string, transport: Transport) {
  const metadataResponse = await requestJson(transport, {
    url: `${origin}/.well-known/oauth-authorization-server`,
    method: "GET",
  });
  const metadata = v.parse(metadataSchema, metadataResponse);

  const registrationResponse = await requestJson(transport, {
    url: metadata.registration_endpoint,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Obsidian CF Sync",
      redirect_uris: [`${origin}/oauth/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const registration = v.parse(clientRegistrationSchema, registrationResponse);

  return { clientId: registration.client_id, metadata };
}
