import { z } from "zod";

import { idSchema } from "./identity";

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), revision: z.number().int(), fileId: idSchema }),
  z.object({
    type: z.literal("text"),
    fileId: idSchema,
    update: z.string(),
    revision: z.number().int(),
    deviceId: idSchema,
  }),
  z.object({ type: z.literal("r2"), revision: z.number().int() }),
  z.object({ type: z.literal("settings"), revision: z.number().int() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
