import * as v from "valibot";

import { contentSchema } from "./content";
import { fileRecordSchema } from "./files";
import { idSchema } from "./identity";
import { integerSchema, nonNegativeIntegerSchema } from "./numbers";
import { pathSchema } from "./paths";

const identityFields = {
  opId: idSchema,
  fileId: idSchema,
};

const createOperationSchema = v.object({
  ...identityFields,
  type: v.literal("create"),
  path: pathSchema,
  content: contentSchema,
});

const editOperationSchema = v.object({
  ...identityFields,
  type: v.literal("edit"),
  baseRevision: nonNegativeIntegerSchema,
  path: pathSchema,
  content: contentSchema,
});

const moveOperationSchema = v.object({
  ...identityFields,
  type: v.literal("move"),
  basePathRevision: nonNegativeIntegerSchema,
  path: pathSchema,
});

const deleteOperationSchema = v.object({
  ...identityFields,
  type: v.literal("delete"),
  baseRevision: nonNegativeIntegerSchema,
});

export const operationSchema = v.variant("type", [
  createOperationSchema,
  editOperationSchema,
  moveOperationSchema,
  deleteOperationSchema,
]);

export type Operation = v.InferOutput<typeof operationSchema>;

export const operationResultSchema = v.object({
  opId: idSchema,
  revision: integerSchema,
  previousRevision: v.nullable(integerSchema),
  previousPathRevision: v.nullable(integerSchema),
  file: v.nullable(fileRecordSchema),
  conflict: v.boolean(),
  message: v.optional(v.string()),
});

export type OperationResult = v.InferOutput<typeof operationResultSchema>;
