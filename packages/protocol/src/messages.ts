import * as v from "valibot";

import { fileRecordSchema } from "./files";
import { idSchema } from "./identity";
import { integerSchema } from "./numbers";
import { operationSchema, operationResultSchema } from "./operations";

const changedMessageSchema = v.object({
  type: v.literal("changed"),
  revision: integerSchema,
  fileId: idSchema,
});

const textMessageSchema = v.object({
  type: v.literal("text"),
  fileId: idSchema,
  file: fileRecordSchema,
  update: v.string(),
  revision: integerSchema,
  deviceId: idSchema,
});

const r2MessageSchema = v.object({
  type: v.literal("r2"),
  revision: integerSchema,
});

const settingsMessageSchema = v.object({
  type: v.literal("settings"),
  revision: integerSchema,
});

const errorMessageSchema = v.object({
  type: v.literal("error"),
  message: v.string(),
});

const presenceFields = {
  fileId: v.nullable(idSchema),
  clientId: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  name: v.string(),
  cursor: v.nullable(
    v.object({
      anchor: v.pipe(v.string(), v.maxLength(1024)),
      head: v.pipe(v.string(), v.maxLength(1024)),
    }),
  ),
};

export const clientMessageSchema = v.variant("type", [
  v.object({ type: v.literal("operation"), operation: operationSchema }),
  v.object({ type: v.literal("presence"), ...presenceFields }),
]);

export type ClientMessage = v.InferOutput<typeof clientMessageSchema>;

export const serverMessageSchema = v.variant("type", [
  v.object({
    type: v.literal("operation-error"),
    opId: idSchema,
    message: v.string(),
    retryable: v.boolean(),
  }),
  v.object({ type: v.literal("operation-result"), result: operationResultSchema }),
  v.object({ type: v.literal("presence"), deviceId: idSchema, ...presenceFields }),
  changedMessageSchema,
  textMessageSchema,
  r2MessageSchema,
  settingsMessageSchema,
  errorMessageSchema,
]);

export type ServerMessage = v.InferOutput<typeof serverMessageSchema>;
