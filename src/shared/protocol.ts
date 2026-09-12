import { z } from "zod";

export const idSchema = z.string().uuid();
export const pathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      new TextEncoder().encode(path).byteLength <= 974 &&
      !path.startsWith("/") &&
      !/[\\<>:"|?*]/.test(path) &&
      !/\p{Cc}/u.test(path) &&
      path
        .split("/")
        .every(
          (part) =>
            part.length > 0 &&
            !part.startsWith(".") &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    "Unsupported vault path",
  );
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
export const deviceSchema = z.object({ id: idSchema, name: z.string(), revoked: z.boolean() });
export type Device = z.infer<typeof deviceSchema>;
export const vaultInfoSchema = z.object({ id: idSchema, name: z.string() });
export type VaultInfo = z.infer<typeof vaultInfoSchema>;
export const documentSchema = z.object({ file: fileRecordSchema, content: contentSchema });
export type DocumentResponse = z.infer<typeof documentSchema>;

export function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return (
    path.split("/").some((part) => part.startsWith(".")) ||
    exclusions.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );
}
export function conflictPath(path: string, id: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const split = dot > slash ? dot : path.length;
  return `${path.slice(0, split)} (conflict ${id})${path.slice(split)}`;
}
export function toBase64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
