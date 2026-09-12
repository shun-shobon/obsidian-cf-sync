import * as v from "valibot";

import type { AuthState } from "../../domain/auth-state";
import { AuthenticationError } from "../../domain/authentication-error";
import { ConnectionError } from "../../domain/connection-error";
import { serverOrigin } from "../../domain/server-origin";
import type { Transport } from "../http/transport";

import { registerClient, tokenResponseSchema } from "./oauth-provider";
import { challenge, random } from "./pkce";

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
    const registration = await registerClient(this.origin, this.transport);
    this.state.registration = registration;
    this.state.pending = { state: random(), verifier: random(), createdAt: Date.now() };
    await this.save();

    const url = new URL(registration.metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.clientId,
      redirect_uri: `${this.origin}/oauth/callback`,
      state: this.state.pending.state,
      code_challenge: await challenge(this.state.pending.verifier),
      code_challenge_method: "S256",
      resource: registration.resource,
    }).toString();

    return url.href;
  }

  async finish(params: Record<string, string>): Promise<void> {
    const pending = this.state.pending;

    if (!pending || !params["state"]) {
      throw new AuthenticationError("ログイン要求が無効または期限切れです");
    }

    const stateMatches = params["state"] === pending.state;
    const isExpired = Date.now() - pending.createdAt > 10 * 60_000;

    if (!stateMatches || isExpired) {
      throw new AuthenticationError("ログイン要求が無効または期限切れです");
    }

    delete this.state.pending;
    await this.save();

    if (params["error"] || !params["code"]) {
      throw new AuthenticationError("ログインが許可されませんでした");
    }

    await this.exchange({
      grant_type: "authorization_code",
      code: params["code"],
      redirect_uri: `${this.origin}/oauth/callback`,
      code_verifier: pending.verifier,
    });
  }

  async token(): Promise<string> {
    const tokens = this.state.tokens;

    if (!tokens) {
      throw new AuthenticationError("ログインが必要です");
    }

    if (tokens.expiresAt > Date.now() + 60_000) {
      return tokens.accessToken;
    }

    if (!this.refreshing) {
      this.refreshing = this.exchange({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }).finally(() => {
        this.refreshing = undefined;
      });
    }

    return this.refreshing;
  }

  async logout(): Promise<void> {
    this.generation++;
    delete this.state.tokens;
    delete this.state.pending;
    await this.save();
  }

  private async requestToken(parameters: Record<string, string>) {
    const registration = this.state.registration;

    if (!registration) {
      throw new AuthenticationError("ログインを開始してください");
    }

    return this.transport({
      url: registration.metadata.token_endpoint,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...parameters,
        client_id: registration.clientId,
        resource: registration.resource,
      }).toString(),
    });
  }

  private async exchange(parameters: Record<string, string>): Promise<string> {
    const generation = this.generation;
    const response = await this.requestToken(parameters).catch((cause: unknown) => {
      if (cause instanceof AuthenticationError) {
        throw cause;
      }

      throw new ConnectionError("認証サーバーに接続できません", { cause });
    });

    if (generation !== this.generation) {
      throw new AuthenticationError("ログイン状態が変更されました");
    }

    if (response.status !== 200) {
      if (response.status === 400 || response.status === 401) {
        await this.logout();
        throw new AuthenticationError("認証の有効期限が切れました。再ログインしてください");
      }

      throw new ConnectionError(`トークン取得に失敗しました (${response.status})`);
    }

    const result = v.parse(tokenResponseSchema, JSON.parse(response.text));
    const refreshToken = result.refresh_token ?? this.state.tokens?.refreshToken;

    if (!refreshToken) {
      throw new AuthenticationError("リフレッシュトークンが発行されませんでした");
    }

    if (generation !== this.generation) {
      throw new AuthenticationError("ログイン状態が変更されました");
    }

    this.state.tokens = {
      accessToken: result.access_token,
      refreshToken,
      expiresAt: Date.now() + result.expires_in * 1000,
    };
    await this.save();

    return result.access_token;
  }
}
