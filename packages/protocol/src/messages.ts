import * as v from "valibot";

import { idSchema } from "./identity";
import { integerSchema } from "./numbers";

const changedMessageSchema = v.object({
  type: v.literal("changed"),
  revision: integerSchema,
  fileId: idSchema,
});

const textMessageSchema = v.object({
  type: v.literal("text"),
  fileId: idSchema,
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

export const serverMessageSchema = v.variant("type", [
  changedMessageSchema,
  textMessageSchema,
  r2MessageSchema,
  settingsMessageSchema,
  errorMessageSchema,
]);

export type ServerMessage = v.InferOutput<typeof serverMessageSchema>;
