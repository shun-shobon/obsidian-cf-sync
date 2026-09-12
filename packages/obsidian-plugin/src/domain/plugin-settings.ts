import { z } from "zod";

import { authStateSchema } from "./auth-state";

export const settingsSchema = z.object({
  server: z.string(),
  deviceId: z.string().uuid(),
  deviceName: z.string(),
  localId: z.string().uuid(),
  vaultId: z.string(),
  paused: z.boolean(),
  auth: authStateSchema,
});

export type Settings = z.infer<typeof settingsSchema>;

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
