import * as v from "valibot";

import { idSchema } from "./identity";
import { nonNegativeIntegerSchema } from "./numbers";

export const blobSchema = v.object({
  key: idSchema,
  size: nonNegativeIntegerSchema,
  digest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

const textContentSchema = v.object({
  kind: v.literal("text"),
  update: v.string(),
});

const blobContentSchema = v.object({
  kind: v.literal("blob"),
  blob: blobSchema,
});

export const contentSchema = v.variant("kind", [textContentSchema, blobContentSchema]);

export type Content = v.InferOutput<typeof contentSchema>;

export type BlobRef = v.InferOutput<typeof blobSchema>;
