import { z } from "zod";

const https = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:");

export const metadataSchema = z.object({
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
