import type { SyncPlan, SyncResult } from "@cf-sync/sync-core";

import type { CliContext } from "./context";

export function writeOutput(
  context: CliContext,
  json: boolean | undefined,
  value: unknown,
  text: string,
): void {
  if (json) {
    context.output(JSON.stringify(value));
    return;
  }

  context.output(text);
}

export function formatPlan(plan: SyncPlan): string {
  const uploads = plan.uploads.map((item) => `upload ${item.action} ${item.path}`);
  const downloads = plan.downloads.map((item) => `download ${item.action} ${item.path}`);
  const lines = [...uploads, ...downloads];

  if (lines.length === 0) {
    return "No changes";
  }

  return lines.join("\n");
}

export function formatSyncResult(result: SyncResult): string {
  return `Revision ${result.revision}; persisted ${result.r2Revision}; pending ${result.pending}; conflicts ${result.conflicts.length}`;
}

export function syncExitCode(result: SyncResult): number {
  if (result.conflicts.length > 0) {
    return 2;
  }

  if (result.pending > 0) {
    return 3;
  }

  return 0;
}
