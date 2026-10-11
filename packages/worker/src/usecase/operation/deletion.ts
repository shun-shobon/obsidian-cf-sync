import type { Operation } from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";

import type { FileWrite, OperationChanges, StoredFile, VaultMeta } from "../../domain/vault-state";
import type { VaultRepository } from "../../infra/vault-repository";
import { allocateConflictPath } from "../../service/path-conflicts";

export async function applyDeletion(
	operation: Extract<Operation, { type: "delete" }>,
	current: StoredFile | undefined,
	files: StoredFile[],
	meta: VaultMeta,
	changes: OperationChanges,
	repository: VaultRepository,
): Promise<void> {
	if (!current) {
		return;
	}

	meta.revision++;
	changes.removed = current;
	changes.dirty.add(current.file.path);

	if (operation.baseRevision === current.file.revision) {
		return;
	}

	const id = crypto.randomUUID();
	const file = {
		...current.file,
		id,
		path: allocateConflictPath(current.file.path, files, id),
		revision: meta.revision,
		pathRevision: meta.revision,
		conflict: true,
	};
	const write: FileWrite = { stored: { ...current, file } };

	if (!("blob" in current)) {
		write.update = toUint8Array(await repository.textUpdate(current));
	}

	changes.writes.push(write);
	changes.dirty.add(file.path);
	changes.result.file = file;
	changes.result.conflict = true;
	changes.result.conflictReason = "edit-preserved";
}
