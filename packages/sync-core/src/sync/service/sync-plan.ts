import { isExcluded, type FileRecord, type Operation, type Snapshot } from "@cf-sync/protocol";

import type { SyncPlan } from "../domain/sync-plan";
import type { LocalFile, LocalState } from "../domain/sync-state";

export function buildSyncPlan(
  data: LocalState,
  snapshot: Snapshot,
  changed: ReadonlyMap<string, Uint8Array | undefined>,
): SyncPlan {
  const uploads = planUploads(data, snapshot);
  const downloads = planDownloads(data, snapshot);

  appendRemoteDeletions(downloads, data, snapshot);
  appendVirtualChanges(downloads, changed);

  return { uploads, downloads };
}

function planUploads(data: LocalState, snapshot: Snapshot): SyncPlan["uploads"] {
  const uploads: SyncPlan["uploads"] = [];

  for (const operation of data.pending) {
    const path = operationPath(operation, data.files);
    if (!isExcluded(path, snapshot.exclusions)) {
      uploads.push({ path, action: operation.type });
    }
  }

  return uploads;
}

function operationPath(operation: Operation, files: LocalFile[]): string {
  if ("path" in operation) {
    return operation.path;
  }

  const local = files.find((file) => file.id === operation.fileId);
  if (!local) {
    throw new Error("Pending operation has no file path");
  }

  return local.path;
}

function planDownloads(data: LocalState, snapshot: Snapshot): SyncPlan["downloads"] {
  const downloads: SyncPlan["downloads"] = [];
  const pendingDeletions = new Set(
    data.pending
      .filter((operation) => operation.type === "delete")
      .map((operation) => operation.fileId),
  );

  for (const remote of snapshot.files) {
    if (isExcluded(remote.path, snapshot.exclusions) || pendingDeletions.has(remote.id)) {
      continue;
    }

    const local = data.files.find((file) => file.id === remote.id);
    if (!needsDownload(local, remote)) {
      continue;
    }

    downloads.push({ path: remote.path, action: "write" });
    if (local && local.path !== remote.path) {
      downloads.push({ path: local.path, action: "delete" });
    }
  }

  return downloads;
}

function needsDownload(local: LocalFile | undefined, remote: FileRecord): boolean {
  if (!local || local.digest !== remote.digest || local.path !== remote.path) {
    return true;
  }

  return remote.kind === "text" && local.documentRevision < remote.revision;
}

function appendRemoteDeletions(
  downloads: SyncPlan["downloads"],
  data: LocalState,
  snapshot: Snapshot,
): void {
  const remoteIds = new Set(snapshot.files.map((file) => file.id));
  const pendingIds = new Set(data.pending.map((operation) => operation.fileId));

  for (const local of data.files) {
    if (remoteIds.has(local.id) || pendingIds.has(local.id)) {
      continue;
    }

    if (!isExcluded(local.path, snapshot.exclusions)) {
      downloads.push({ path: local.path, action: "delete" });
    }
  }
}

function appendVirtualChanges(
  downloads: SyncPlan["downloads"],
  changed: ReadonlyMap<string, Uint8Array | undefined>,
): void {
  for (const [path, bytes] of changed) {
    let action: "delete" | "write" = "write";

    if (bytes === undefined) {
      action = "delete";
    }

    const alreadyPlanned = downloads.some(
      (entry) => entry.path === path && entry.action === action,
    );

    if (!alreadyPlanned) {
      downloads.push({ path, action });
    }
  }
}
