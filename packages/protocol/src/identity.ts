import { z } from "zod";

export const idSchema = z.string().uuid();

export const deviceSchema = z.object({ id: idSchema, name: z.string(), revoked: z.boolean() });

export type Device = z.infer<typeof deviceSchema>;

export const vaultInfoSchema = z.object({ id: idSchema, name: z.string() });

export type VaultInfo = z.infer<typeof vaultInfoSchema>;
