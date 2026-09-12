import { idSchema } from "@cf-sync/protocol";
import * as v from "valibot";

import { authStateSchema } from "./auth-state";

export const settingsSchema = v.object({
  server: v.string(),
  deviceId: idSchema,
  deviceName: v.string(),
  localId: idSchema,
  vaultId: v.string(),
  paused: v.boolean(),
  auth: authStateSchema,
});

export type Settings = v.InferOutput<typeof settingsSchema>;

export function initialSettings(deviceName: string): Settings {
  return {
    server: "",
    deviceId: crypto.randomUUID(),
    deviceName,
    localId: crypto.randomUUID(),
    vaultId: "",
    paused: false,
    auth: {},
  };
}
