import * as v from "valibot";

export const idSchema = v.pipe(v.string(), v.uuid());

export const deviceSchema = v.object({
	id: idSchema,
	name: v.string(),
});

export type Device = v.InferOutput<typeof deviceSchema>;

export const vaultInfoSchema = v.object({
	id: idSchema,
	name: v.string(),
});

export type VaultInfo = v.InferOutput<typeof vaultInfoSchema>;
