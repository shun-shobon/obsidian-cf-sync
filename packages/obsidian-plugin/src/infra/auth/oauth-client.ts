import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import * as v from "valibot";

import type { AuthState } from "../../domain/auth-state";
import { AuthenticationError } from "../../domain/authentication-error";
import { t } from "../../i18n";
import type { Transport } from "../http/transport";
import { registerClient, tokenResponseSchema } from "./oauth-provider";
import { challenge, random } from "./pkce";

export class OAuthClient {
	private refreshing?: Promise<string>;
	private generation = 0;

	constructor(
		readonly origin: string,
		readonly state: AuthState,
		private readonly transport: Transport,
		private readonly save: () => Promise<void>,
	) {}

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
		const { state, code, error } = params;

		if (!pending) {
			throw new AuthenticationError(t(($) => $.errors.loginExpired));
		}

		const stateMatches = state === pending.state;
		const isExpired = Date.now() - pending.createdAt > 10 * 60_000;

		if (!stateMatches || isExpired) {
			throw new AuthenticationError(t(($) => $.errors.loginExpired));
		}

		delete this.state.pending;
		await this.save();

		const isDenied = error !== undefined && error !== "";

		if (isDenied || code === undefined || code === "") {
			throw new AuthenticationError(t(($) => $.errors.loginDenied));
		}

		await this.exchange({
			grant_type: "authorization_code",
			code,
			redirect_uri: `${this.origin}/oauth/callback`,
			code_verifier: pending.verifier,
		});
	}

	async token(): Promise<string> {
		const tokens = this.state.tokens;

		if (!tokens) {
			throw new AuthenticationError(t(($) => $.errors.loginRequired));
		}

		if (tokens.expiresAt > Date.now() + 60_000) {
			return tokens.accessToken;
		}

		this.refreshing ??= this.exchange({
			grant_type: "refresh_token",
			refresh_token: tokens.refreshToken,
		}).finally(() => {
			this.refreshing = undefined;
		});

		return await this.refreshing;
	}

	async logout(): Promise<void> {
		this.generation++;
		delete this.state.tokens;
		delete this.state.pending;
		await this.save();
	}

	private async exchange(parameters: Record<string, string>): Promise<string> {
		const registration = this.state.registration;

		if (!registration) {
			throw new AuthenticationError(t(($) => $.errors.startLogin));
		}

		const generation = this.generation;
		const response = await this.transport({
			url: registration.metadata.token_endpoint,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				...parameters,
				client_id: registration.clientId,
				resource: registration.resource,
			}).toString(),
		}).catch((cause: unknown) => {
			throw new ConnectionError(
				t(($) => $.errors.authUnavailable),
				{ cause },
			);
		});

		if (generation !== this.generation) {
			throw new AuthenticationError(t(($) => $.errors.loginChanged));
		}

		if (response.status !== 200) {
			if (response.status === 400 || response.status === 401) {
				await this.logout();
				throw new AuthenticationError(t(($) => $.errors.sessionExpired));
			}

			throw new ConnectionError(t(($) => $.errors.tokenFailed, { status: response.status }));
		}

		const result = v.parse(tokenResponseSchema, JSON.parse(response.text));
		const refreshToken = result.refresh_token ?? this.state.tokens?.refreshToken;

		if (refreshToken === undefined) {
			throw new AuthenticationError(t(($) => $.errors.missingRefreshToken));
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
