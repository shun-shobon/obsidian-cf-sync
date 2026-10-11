import { isExcluded } from "@cf-sync/protocol";
import type { FileRecord, Snapshot } from "@cf-sync/protocol";

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

export function hasReceived(local: LocalFile | undefined, remote: FileRecord): boolean {
	if (!local) {
		return false;
	}

	if (local.documentRevision > remote.revision) {
		return true;
	}

	const sameFile = local.path === remote.path && local.digest === remote.digest;
	// Attachments are identified by digest. Uploads from this device never set documentRevision.
	const needsTextUpdate = remote.kind === "text" && local.documentRevision < remote.revision;

	return sameFile && !needsTextUpdate;
}

/** Advances the base revisions of an already received file without fetching it again. */
export function adoptReceived(local: LocalFile | undefined, remote: FileRecord): boolean {
	if (!local || !hasReceived(local, remote)) {
		return false;
	}

	if (remote.revision > local.revision) {
		local.revision = remote.revision;
		local.pathRevision = remote.pathRevision;
	}

	return true;
}
