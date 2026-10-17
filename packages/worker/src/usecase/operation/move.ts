import type { Operation } from "@cf-sync/protocol";

import { ApplicationError } from "../../domain/errors";
import type { OperationOutcome, OperationState } from "../../domain/vault-state";
import { hasPathCollision } from "../../service/path-conflicts";

export function applyMove(
	operation: Extract<Operation, { type: "move" }>,
	{ current, files, nextRevision }: OperationState,
): OperationOutcome {
	if (!current) {
		throw new ApplicationError("not-found", "File not found");
	}

	const pathChanged = current.file.pathRevision !== operation.basePathRevision;
	const destinationOccupied = hasPathCollision(operation.path, files, operation.fileId);

	if (pathChanged || destinationOccupied) {
		return { file: current.file, conflictReason: "move-rejected" };
	}

	const file = {
		...current.file,
		path: operation.path,
		pathRevision: nextRevision,
		revision: nextRevision,
	};

	return {
		file,
		changes: {
			writes: [{ stored: { ...current, file } }],
			dirty: new Set([current.file.path, operation.path]),
		},
	};
}
