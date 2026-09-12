import { z } from "zod";

import { toBase64 } from "../../shared/protocol";

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}
export interface HttpResponse {
  status: number;
  text: string;
  bytes: ArrayBuffer;
}
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
const https = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:");
const metadataSchema = z.object({
  issuer: https,
  authorization_endpoint: https,
  token_endpoint: https,
  registration_endpoint: https,
});
export type Metadata = z.infer<typeof metadataSchema>;
export const authStateSchema = z.object({
  registration: z.object({ clientId: z.string().min(1), metadata: metadataSchema }).optional(),
  pending: z
    .object({ state: z.string().min(1), verifier: z.string().min(43), createdAt: z.number() })
    .optional(),
  tokens: z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      expiresAt: z.number(),
    })
    .optional(),
});
export type AuthState = z.infer<typeof authStateSchema>;
export class AuthenticationError extends Error {}
export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("サーバーはパスを含まない HTTPS URL を指定してください");
  return url.origin;
}
function random(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function challenge(verifier: string): Promise<string> {
  return toBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export class OAuthClient {
  private refreshing?: Promise<string>;
  private generation = 0;
  readonly origin: string;
  constructor(
    origin: string,
    readonly state: AuthState,
    private readonly transport: Transport,
    private readonly save: () => Promise<void>,
  ) {
    this.origin = serverOrigin(origin);
  }
  async begin(): Promise<string> {
    this.generation++;
    const metadata = metadataSchema.parse(
      await this.json({
        url: `${this.origin}/.well-known/oauth-authorization-server`,
        method: "GET",
      }),
    );
    const result = z.object({ client_id: z.string().min(1) }).parse(
      await this.json({
        url: metadata.registration_endpoint,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Obsidian CF Sync",
          redirect_uris: [`${this.origin}/oauth/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    this.state.registration = { clientId: result.client_id, metadata };
    this.state.pending = { state: random(), verifier: random(), createdAt: Date.now() };
    await this.save();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: result.client_id,
      redirect_uri: `${this.origin}/oauth/callback`,
      state: this.state.pending.state,
      code_challenge: await challenge(this.state.pending.verifier),
      code_challenge_method: "S256",
      resource: `${this.origin}/api`,
    }).toString();
    return url.href;
  }
  async finish(params: Record<string, string>): Promise<void> {
    const pending = this.state.pending;
    if (
      !pending ||
      !params["state"] ||
      params["state"] !== pending.state ||
      Date.now() - pending.createdAt > 10 * 60_000
    )
      throw new AuthenticationError("ログイン要求が無効または期限切れです");
    delete this.state.pending;
    await this.save();
    if (params["error"] || !params["code"])
      throw new AuthenticationError("ログインが許可されませんでした");
    await this.exchange({
      grant_type: "authorization_code",
      code: params["code"],
      redirect_uri: `${this.origin}/oauth/callback`,
      code_verifier: pending.verifier,
    });
  }
  async token(): Promise<string> {
    const tokens = this.state.tokens;
    if (!tokens) throw new AuthenticationError("ログインが必要です");
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    if (!this.refreshing)
      this.refreshing = this.exchange({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }).finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  async logout(): Promise<void> {
    this.generation++;
    delete this.state.tokens;
    delete this.state.pending;
    await this.save();
  }
  private async exchange(parameters: Record<string, string>): Promise<string> {
    const registration = this.state.registration;
    if (!registration) throw new AuthenticationError("ログインを開始してください");
    const generation = this.generation;
    const response = await this.transport({
      url: registration.metadata.token_endpoint,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...parameters,
        client_id: registration.clientId,
        resource: `${this.origin}/api`,
      }).toString(),
    });
    if (generation !== this.generation)
      throw new AuthenticationError("ログイン状態が変更されました");
    if (response.status !== 200) {
      if (response.status === 400 || response.status === 401) {
        await this.logout();
        throw new AuthenticationError("認証の有効期限が切れました。再ログインしてください");
      }
      throw new Error(`トークン取得に失敗しました (${response.status})`);
    }
    const result = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        expires_in: z.number().positive(),
        token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
      })
      .parse(JSON.parse(response.text));
    const refreshToken = result.refresh_token ?? this.state.tokens?.refreshToken;
    if (!refreshToken) throw new AuthenticationError("リフレッシュトークンが発行されませんでした");
    if (generation !== this.generation)
      throw new AuthenticationError("ログイン状態が変更されました");
    this.state.tokens = {
      accessToken: result.access_token,
      refreshToken,
      expiresAt: Date.now() + result.expires_in * 1000,
    };
    await this.save();
    return result.access_token;
  }
  private async json(request: HttpRequest): Promise<unknown> {
    const result = await this.transport(request);
    if (result.status < 200 || result.status >= 300)
      throw new Error(`認証設定の取得に失敗しました (${result.status})`);
    return JSON.parse(result.text) as unknown;
  }
}
