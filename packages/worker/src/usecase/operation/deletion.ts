import type { Operation } from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";

import type { FileWrite, OperationOutcome, OperationState } from "../../domain/vault-state";
import type { VaultRepository } from "../../infra/vault-repository";
import { allocateConflictPath } from "../../service/path-conflicts";

export async function applyDeletion(
	operation: Extract<Operation, { type: "delete" }>,
	{ current, files, nextRevision }: OperationState,
	repository: VaultRepository,
): Promise<OperationOutcome> {
	if (!current) {
		return { file: null };
	}

	const dirty = new Set([current.file.path]);

	if (operation.baseRevision === current.file.revision) {
		return { file: null, changes: { writes: [], dirty, removed: current } };
	}

	const id = crypto.randomUUID();
	const file = {
		...current.file,
		id,
		path: allocateConflictPath(current.file.path, files, id),
		revision: nextRevision,
		pathRevision: nextRevision,
		conflict: true,
	};
	const write: FileWrite = { stored: { ...current, file } };

	if (!("blob" in current)) {
		write.update = toUint8Array(await repository.textUpdate(current));
	}

	dirty.add(file.path);

	return {
		file,
		conflictReason: "edit-preserved",
		changes: { writes: [write], dirty, removed: current },
	};
}
