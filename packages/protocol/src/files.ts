import * as v from "valibot";

import { contentSchema } from "./content";
import { idSchema } from "./identity";
import { integerSchema } from "./numbers";
import { pathSchema } from "./paths";

export const fileRecordSchema = v.object({
  id: idSchema,
  path: pathSchema,
  kind: v.picklist(["text", "blob"]),
  revision: integerSchema,
  pathRevision: integerSchema,
  digest: v.string(),
  size: integerSchema,
  conflict: v.boolean(),
});

export type FileRecord = v.InferOutput<typeof fileRecordSchema>;

export const snapshotSchema = v.object({
  revision: integerSchema,
  r2Revision: integerSchema,
  files: v.array(fileRecordSchema),
  exclusions: v.array(v.string()),
});

export type Snapshot = v.InferOutput<typeof snapshotSchema>;

export const documentSchema = v.object({
  file: fileRecordSchema,
  content: contentSchema,
});

export type DocumentResponse = v.InferOutput<typeof documentSchema>;
