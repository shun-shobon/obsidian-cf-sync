import type { Content, Operation, OperationResult } from "@cf-sync/protocol";

import type { LocalFile, LocalState } from "../domain/sync-state";

export function contentOperation(state: LocalState, file: LocalFile, content: Content): Operation {
  const creating = state.pending.some((op) => op.fileId === file.id && op.type === "create");
  const identity = { opId: crypto.randomUUID(), fileId: file.id, path: file.path, content };

  return file.revision === 0 && !creating
    ? { type: "create", ...identity }
    : { type: "edit", ...identity, baseRevision: file.revision };
}

export function appendContent(state: LocalState, operation: Operation): void {
  let previous: Operation | undefined;
  for (let index = state.pending.length - 1; index >= 0; index--) {
    const candidate = state.pending[index];
    if (candidate?.fileId === operation.fileId) {
      previous = candidate;
      break;
    }
  }

  if (
    operation.type === "edit" &&
    operation.content.kind === "text" &&
    previous?.type === "edit" &&
    previous.content.kind === "text" &&
    !state.attempted.includes(previous.opId)
  ) {
    previous.content = operation.content;
    return;
  }

  state.pending.push(operation);
}

function followsRevision(base: number, previous: number | null, operation: Operation): boolean {
  return base === previous || (operation.type === "create" && previous === null && base === 0);
}

/** Advance only revisions produced by this device; preserve external edit and move conflicts. */
export function rebasePending(
  pending: Operation[],
  local: LocalFile,
  operation: Operation,
  result: OperationResult,
): void {
  if (!result.file) return;

  for (const entry of pending) {
    if (entry.fileId !== local.id) continue;
    if (
      "baseRevision" in entry &&
      followsRevision(entry.baseRevision, result.previousRevision, operation)
    ) {
      entry.baseRevision = result.file.revision;
    }
    if (
      (operation.type === "move" || operation.type === "create") &&
      !result.conflict &&
      "basePathRevision" in entry &&
      followsRevision(entry.basePathRevision, result.previousPathRevision, operation)
    ) {
      entry.basePathRevision = result.file.pathRevision;
    }
  }
}
