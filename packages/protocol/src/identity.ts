import * as v from "valibot";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function hasRfcUuidLayout(value: string): boolean {
  const normalized = value.toLowerCase();

  if (normalized === NIL_UUID || normalized === MAX_UUID) {
    return true;
  }

  const version = normalized[14]!;
  const variant = normalized[19]!;
  const supportedVersion = "12345678".includes(version);
  const standardVariant = "89ab".includes(variant);

  return supportedVersion && standardVariant;
}

export const idSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.check(hasRfcUuidLayout, "Invalid UUID version or variant"),
);

export const deviceSchema = v.object({
  id: idSchema,
  name: v.string(),
  revoked: v.boolean(),
});

export type Device = v.InferOutput<typeof deviceSchema>;

export const vaultInfoSchema = v.object({
  id: idSchema,
  name: v.string(),
});

export type VaultInfo = v.InferOutput<typeof vaultInfoSchema>;
