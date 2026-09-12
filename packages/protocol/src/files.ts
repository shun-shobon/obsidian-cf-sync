import { z } from "zod";

import { contentSchema } from "./content";
import { idSchema } from "./identity";
import { pathSchema } from "./paths";

export const fileRecordSchema = z.object({
  id: idSchema,
  path: pathSchema,
  kind: z.enum(["text", "blob"]),
  revision: z.number().int(),
  pathRevision: z.number().int(),
  digest: z.string(),
  size: z.number().int(),
  conflict: z.boolean(),
});

export type FileRecord = z.infer<typeof fileRecordSchema>;

export const snapshotSchema = z.object({
  revision: z.number().int(),
  r2Revision: z.number().int(),
  files: z.array(fileRecordSchema),
  exclusions: z.array(z.string()),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

export const documentSchema = z.object({ file: fileRecordSchema, content: contentSchema });

export type DocumentResponse = z.infer<typeof documentSchema>;
