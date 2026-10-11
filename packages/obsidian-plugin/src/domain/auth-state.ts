import * as v from "valibot";

import { urlSchema } from "./url-schema";

export const httpsUrlSchema = v.pipe(
	urlSchema,
	// v.url()が失敗してもpipeは後続の検証を実行するため、ここでも解析できるか確かめる
	v.check((value) => URL.canParse(value) && new URL(value).protocol === "https:"),
);

export const metadataSchema = v.object({
	issuer: httpsUrlSchema,
	authorization_endpoint: httpsUrlSchema,
	token_endpoint: httpsUrlSchema,
	registration_endpoint: httpsUrlSchema,
});

export type Metadata = v.InferOutput<typeof metadataSchema>;

const registrationSchema = v.object({
	clientId: v.pipe(v.string(), v.minLength(1)),
	resource: httpsUrlSchema,
	metadata: metadataSchema,
});

const pendingLoginSchema = v.object({
	state: v.pipe(v.string(), v.minLength(1)),
	verifier: v.pipe(v.string(), v.minLength(43)),
	createdAt: v.pipe(v.number(), v.finite()),
});

const tokensSchema = v.object({
	accessToken: v.pipe(v.string(), v.minLength(1)),
	refreshToken: v.pipe(v.string(), v.minLength(1)),
	expiresAt: v.pipe(v.number(), v.finite()),
});

export const authStateSchema = v.object({
	registration: v.optional(registrationSchema),
	pending: v.optional(pendingLoginSchema),
	tokens: v.optional(tokensSchema),
});

export type AuthState = v.InferOutput<typeof authStateSchema>;
