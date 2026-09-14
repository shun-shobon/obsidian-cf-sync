import type { Content, Operation, OperationResult } from "@cf-sync/protocol";
import { fromUint8Array, toUint8Array } from "js-base64";
import * as Y from "yjs";

import type { LocalFile, LocalState } from "../domain/sync-state";

export function contentOperation(state: LocalState, file: LocalFile, content: Content): Operation {
  const creating = state.pending.some((op) => op.fileId === file.id && op.type === "create");
  const identity = { opId: crypto.randomUUID(), fileId: file.id, path: file.path, content };

  const needsCreation = file.revision === 0 && !creating;
  if (needsCreation) {
    return { type: "create", ...identity };
  }

  return { type: "edit", ...identity, baseRevision: file.revision };
}

export function appendContent(state: LocalState, operation: Operation): void {
  const previous = lastFileOperation(state.pending, operation.fileId);
  const replacesUnsentText =
    isTextEdit(operation) && isTextEdit(previous) && !state.attempted.includes(previous.opId);

  if (replacesUnsentText) {
    if (previous.content.kind === "text" && operation.content.kind === "text") {
      previous.content = {
        kind: "text",
        update: fromUint8Array(
          Y.mergeUpdates([
            toUint8Array(previous.content.update),
            toUint8Array(operation.content.update),
          ]),
        ),
      };
    }

    return;
  }

  state.pending.push(operation);
}

function lastFileOperation(pending: Operation[], fileId: string): Operation | undefined {
  for (let index = pending.length - 1; index >= 0; index--) {
    const candidate = pending[index];
    if (candidate?.fileId === fileId) {
      return candidate;
    }
  }

  return undefined;
}

function isTextEdit(
  operation: Operation | undefined,
): operation is Extract<Operation, { type: "edit" }> {
  return operation?.type === "edit" && operation.content.kind === "text";
}

function followsRevision(base: number, previous: number | null, operation: Operation): boolean {
  if (base === previous) {
    return true;
  }

  const followsCreation = operation.type === "create" && previous === null && base === 0;

  return followsCreation;
}

/** Advance only revisions produced by this device; preserve external edit and move conflicts. */
export function rebasePending(
  pending: Operation[],
  local: LocalFile,
  operation: Operation,
  result: OperationResult,
): void {
  if (!result.file) {
    return;
  }

  const changesPath = operation.type === "move" || operation.type === "create";
  const acceptsLocalPath = changesPath && !result.conflict;

  for (const entry of pending) {
    if (entry.fileId !== local.id) {
      continue;
    }

    if ("baseRevision" in entry) {
      const followsOwnEdit = followsRevision(
        entry.baseRevision,
        result.previousRevision,
        operation,
      );
      if (followsOwnEdit) {
        entry.baseRevision = result.file.revision;
      }
    }

    if (!acceptsLocalPath || !("basePathRevision" in entry)) {
      continue;
    }

    const followsOwnMove = followsRevision(
      entry.basePathRevision,
      result.previousPathRevision,
      operation,
    );
    if (followsOwnMove) {
      entry.basePathRevision = result.file.pathRevision;
    }
  }
}
