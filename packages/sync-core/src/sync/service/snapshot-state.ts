import { isExcluded, type FileRecord, type Snapshot } from "@cf-sync/protocol";

import type { LocalFile, LocalState } from "../domain/sync-state";

export function needsReceive(state: LocalState, snapshot: Snapshot): boolean {
  return snapshot.files.some((remote) => {
    if (isExcluded(remote.path, snapshot.exclusions)) {
      return false;
    }

    const local = state.files.find((file) => file.id === remote.id);

    return !hasReceived(local, remote);
  });
}

function hasReceived(local: LocalFile | undefined, remote: FileRecord): boolean {
  if (!local) {
    return false;
  }

  if (local.documentRevision > remote.revision) {
    return true;
  }

  const sameFile = local.path === remote.path && local.digest === remote.digest;
  const needsTextUpdate = remote.kind === "text" && local.documentRevision < remote.revision;

  return sameFile && !needsTextUpdate;
}
