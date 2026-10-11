import { isExcluded } from "@cf-sync/protocol";
import type { Operation, OperationResult } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";
import type { OperationChanges, StoredFile, VaultMeta } from "../domain/vault-state";
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
	const changes = await prepare(context, operation, current, files, meta);

	await context.repository.commit(meta, files, changes);
	broadcast(context.sockets, operation, changes.result, deviceId);

	return changes.result;
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
	current: StoredFile | undefined,
	files: StoredFile[],
	meta: VaultMeta,
): Promise<OperationChanges> {
	const changes: OperationChanges = {
		result: {
			opId: operation.opId,
			revision: meta.revision,
			previousRevision: current?.file.revision ?? null,
			previousPathRevision: current?.file.pathRevision ?? null,
			file: null,
			conflict: false,
		},
		writes: [],
		dirty: new Set(),
	};

	switch (operation.type) {
		case "move":
			applyMove(operation, current, files, meta, changes);
			break;
		case "delete":
			await applyDeletion(operation, current, files, meta, changes, context.repository);
			break;
		case "create":
		case "edit":
			await applyContentChange(
				operation,
				current,
				files,
				meta,
				changes,
				context.repository,
				context.blobs,
			);
			break;
	}

	changes.result.revision = meta.revision;

	return changes;
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
