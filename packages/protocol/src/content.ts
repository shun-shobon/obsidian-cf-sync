import { z } from "zod";

import { idSchema } from "./identity";

export const blobSchema = z.object({
  key: idSchema,
  size: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const contentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), update: z.string() }),
  z.object({ kind: z.literal("blob"), blob: blobSchema }),
]);

export type Content = z.infer<typeof contentSchema>;
export type BlobRef = z.infer<typeof blobSchema>;
