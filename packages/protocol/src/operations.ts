import { z } from "zod";

import { contentSchema } from "./content";
import { fileRecordSchema } from "./files";
import { idSchema } from "./identity";
import { pathSchema } from "./paths";

const base = { opId: idSchema, fileId: idSchema };
export const operationSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("create"), path: pathSchema, content: contentSchema }),
  z.object({
    ...base,
    type: z.literal("edit"),
    baseRevision: z.number().int().nonnegative(),
    path: pathSchema,
    content: contentSchema,
  }),
  z.object({
    ...base,
    type: z.literal("move"),
    basePathRevision: z.number().int().nonnegative(),
    path: pathSchema,
  }),
  z.object({ ...base, type: z.literal("delete"), baseRevision: z.number().int().nonnegative() }),
]);

export type Operation = z.infer<typeof operationSchema>;

export const operationResultSchema = z.object({
  opId: idSchema,
  revision: z.number().int(),
  previousRevision: z.number().int().nullable(),
  previousPathRevision: z.number().int().nullable(),
  file: fileRecordSchema.nullable(),
  conflict: z.boolean(),
  message: z.string().optional(),
});

export type OperationResult = z.infer<typeof operationResultSchema>;
