import type { Content, Operation } from "@cf-sync/protocol";

import { ApplicationError } from "../../domain/errors";
import {
  TEXT_CHUNK_SIZE,
  type FileWrite,
  type OperationChanges,
  type StoredFile,
  type VaultMeta,
} from "../../domain/vault-state";
import { allocateConflictPath, hasPathCollision } from "../../service/path-conflicts";
import { mergeText } from "../../service/text-content";
import type { VaultStore, BlobVerifier } from "../ports";

type ContentOperation = Extract<Operation, { type: "create" | "edit" }>;

interface ContentTarget {
  id: string;
  path: string;
  merge: boolean;
  conflict: boolean;
}

export async function applyContentChange(
  operation: ContentOperation,
  current: StoredFile | undefined,
  files: StoredFile[],
  meta: VaultMeta,
  changes: OperationChanges,
  repository: VaultStore,
  blobs: BlobVerifier,
): Promise<void> {
  const target = resolveTarget(operation, current, files);
  meta.revision++;
  const previous = target.merge && current ? await repository.content(current) : undefined;
  const write = await prepareContent(operation.content, previous, blobs);
  const file = {
    id: target.id,
    path: target.path,
    kind: operation.content.kind,
    revision: meta.revision,
    pathRevision: target.merge && current ? current.file.pathRevision : meta.revision,
    digest: write.digest,
    size: write.size,
    conflict: target.conflict || (target.merge && !!current?.file.conflict),
  };

  changes.result.file = file;
  changes.result.conflict = target.conflict;
  if (target.conflict) changes.result.message = "Concurrent contents preserved as conflict copy";
  changes.writes.push({
    stored: { file, ...write.stored },
    ...(write.update ? { update: write.update } : {}),
  });
  changes.dirty.add(target.path);
}

function resolveTarget(
  operation: ContentOperation,
  current: StoredFile | undefined,
  files: StoredFile[],
): ContentTarget {
  if (operation.type === "create" && current)
    throw new ApplicationError("conflict", "File id already exists");
  const path = current ? current.file.path : operation.path;
  const deleted = operation.type === "edit" && !current;
  const changedKind = current && current.file.kind !== operation.content.kind;
  const changedBlob =
    current &&
    operation.type === "edit" &&
    operation.content.kind === "blob" &&
    operation.baseRevision !== current.file.revision;
  const occupied = !current && hasPathCollision(path, files);

  if (deleted || changedKind || changedBlob || occupied) {
    const id = crypto.randomUUID();
    return { id, path: allocateConflictPath(path, files, id), merge: false, conflict: true };
  }

  return {
    id: operation.fileId,
    path,
    merge: operation.type === "edit" && !!current,
    conflict: false,
  };
}

async function prepareContent(
  content: Content,
  previous: Content | undefined,
  blobs: BlobVerifier,
): Promise<{
  stored: Omit<StoredFile, "file">;
  update?: FileWrite["update"];
  size: number;
  digest: string;
}> {
  if (content.kind === "blob") {
    await blobs.validate(content.blob);
    return {
      stored: { chunks: 0, blob: content.blob },
      size: content.blob.size,
      digest: content.blob.digest,
    };
  }

  if (previous && previous.kind !== "text") throw new Error("Kind mismatch");
  const merged = await mergeText(content.update, previous?.update);
  return { stored: { chunks: Math.ceil(merged.update.length / TEXT_CHUNK_SIZE) }, ...merged };
}
