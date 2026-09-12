import * as v from "valibot";

import { urlSchema } from "./url-schema";

const httpsUrlSchema = v.pipe(
  urlSchema,
  v.check((value) => {
    if (!URL.canParse(value)) {
      return false;
    }

    return new URL(value).protocol === "https:";
  }),
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
