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
  let previous: Content | undefined;
  let pathRevision = meta.revision;
  let conflict = target.conflict;

  if (target.merge && current) {
    previous = await repository.content(current);
    pathRevision = current.file.pathRevision;
    conflict ||= current.file.conflict;
  }

  if (!current && operation.type === "edit" && operation.content.kind === "text") {
    previous = await repository.deletedContent(operation.fileId);
  }

  const write = await prepareContent(operation.content, previous, blobs);
  const file = {
    id: target.id,
    path: target.path,
    kind: operation.content.kind,
    revision: meta.revision,
    pathRevision,
    digest: write.digest,
    size: write.size,
    conflict,
  };

  changes.result.file = file;
  changes.result.conflict = target.conflict;

  if (target.conflict) {
    changes.result.conflictReason = "content-preserved";
  }

  const fileWrite: FileWrite = { stored: { file, ...write.stored } };

  if (write.update) {
    fileWrite.update = write.update;
  }

  changes.writes.push(fileWrite);
  changes.dirty.add(target.path);
}

function resolveTarget(
  operation: ContentOperation,
  current: StoredFile | undefined,
  files: StoredFile[],
): ContentTarget {
  if (operation.type === "create" && current) {
    throw new ApplicationError("conflict", "File id already exists");
  }

  const path = current?.file.path ?? operation.path;
  const deleted = operation.type === "edit" && !current;
  const changedKind = current && current.file.kind !== operation.content.kind;
  const changedBlob = hasStaleBlobEdit(operation, current);
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

function hasStaleBlobEdit(operation: ContentOperation, current: StoredFile | undefined): boolean {
  if (!current || operation.type !== "edit") {
    return false;
  }

  if (operation.content.kind !== "blob") {
    return false;
  }

  return operation.baseRevision !== current.file.revision;
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

  if (previous && previous.kind !== "text") {
    throw new Error("Kind mismatch");
  }

  const merged = await mergeText(content.update, previous?.update);

  return { stored: { chunks: Math.ceil(merged.update.length / TEXT_CHUNK_SIZE) }, ...merged };
}
