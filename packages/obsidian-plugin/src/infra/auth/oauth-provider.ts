import { z } from "zod";

import { metadataSchema } from "../../domain/auth-state";
import type { HttpRequest, Transport } from "../http/transport";

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});

async function requestJson(transport: Transport, request: HttpRequest): Promise<unknown> {
  const result = await transport(request);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`認証設定の取得に失敗しました (${result.status})`);
  }

  return JSON.parse(result.text) as unknown;
}

export async function registerClient(origin: string, transport: Transport) {
  const metadata = metadataSchema.parse(
    await requestJson(transport, {
      url: `${origin}/.well-known/oauth-authorization-server`,
      method: "GET",
    }),
  );
  const result = z.object({ client_id: z.string().min(1) }).parse(
    await requestJson(transport, {
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
    }),
  );

  return { clientId: result.client_id, metadata };
}
