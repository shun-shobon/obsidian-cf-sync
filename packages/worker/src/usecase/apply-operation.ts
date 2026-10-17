import { isExcluded } from "@cf-sync/protocol";
import type { Operation, OperationResult } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";
import type {
	OperationOutcome,
	OperationState,
	StoredFile,
	VaultMeta,
} from "../domain/vault-state";
import type { BlobStorage } from "../infra/blob-storage";
import type { VaultRepository } from "../infra/vault-repository";
import type { VaultSockets } from "../infra/vault-sockets";
import { applyContentChange } from "./operation/content-change";
import { applyDeletion } from "./operation/deletion";
import { applyMove } from "./operation/move";

export interface OperationContext {
	repository: VaultRepository;
	sockets: VaultSockets;
	blobs: BlobStorage;
}

export async function applyOperation(
	context: OperationContext,
	meta: VaultMeta,
	operation: Operation,
	deviceId: string,
): Promise<OperationResult> {
	const previous = await context.repository.operationResult(operation.opId);

	if (previous) {
		return previous;
	}

	const files = await context.repository.files();
	const current = files.find((item) => item.file.id === operation.fileId);
	assertIncluded(operation, current, meta);

	const state = { current, files, nextRevision: meta.revision + 1 };
	const outcome = await prepare(context, operation, state);

	// Rejected moves and deletions of missing files change nothing for other devices or R2.
	if (!outcome.changes) {
		const result = operationResult(operation, state, meta.revision, outcome);
		await context.repository.saveOperationResult(result);

		return result;
	}

	const result = operationResult(operation, state, state.nextRevision, outcome);
	const nextMeta = { ...meta, revision: state.nextRevision };
	await context.repository.commit(nextMeta, files, { ...outcome.changes, result });
	broadcast(context.sockets, operation, result, deviceId);

	return result;
}

function assertIncluded(
	operation: Operation,
	current: StoredFile | undefined,
	meta: VaultMeta,
): void {
	const currentExcluded = current !== undefined && isExcluded(current.file.path, meta.exclusions);
	const targetExcluded = "path" in operation && isExcluded(operation.path, meta.exclusions);

	if (currentExcluded || targetExcluded) {
		throw new ApplicationError("conflict", "Path is excluded");
	}
}

async function prepare(
	context: OperationContext,
	operation: Operation,
	state: OperationState,
): Promise<OperationOutcome> {
	if (operation.type === "move") {
		return applyMove(operation, state);
	}

	if (operation.type === "delete") {
		return await applyDeletion(operation, state, context.repository);
	}

	return await applyContentChange(operation, state, context.repository, context.blobs);
}

function operationResult(
	operation: Operation,
	{ current }: OperationState,
	revision: number,
	outcome: OperationOutcome,
): OperationResult {
	const result: OperationResult = {
		opId: operation.opId,
		revision,
		previousRevision: current?.file.revision ?? null,
		previousPathRevision: current?.file.pathRevision ?? null,
		file: outcome.file,
		conflict: outcome.conflictReason !== undefined,
	};

	if (outcome.conflictReason !== undefined) {
		result.conflictReason = outcome.conflictReason;
	}

	return result;
}

function broadcast(
	sockets: VaultSockets,
	operation: Operation,
	result: OperationResult,
	deviceId: string,
): void {
	if (
		operation.type === "edit" &&
		operation.content.kind === "text" &&
		!result.conflict &&
		result.file?.id === operation.fileId
	) {
		sockets.broadcast({
			type: "text",
			fileId: operation.fileId,
			file: result.file,
			update: operation.content.update,
			revision: result.revision,
			deviceId,
		});
		return;
	}
	sockets.broadcast({
		type: "changed",
		revision: result.revision,
		fileId: operation.fileId,
	});

	if (result.file && result.file.id !== operation.fileId) {
		sockets.broadcast({
			type: "changed",
			revision: result.revision,
			fileId: result.file.id,
		});
	}
}
