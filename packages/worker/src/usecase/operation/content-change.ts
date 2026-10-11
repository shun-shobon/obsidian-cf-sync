import type { Content, FileRecord, Operation } from "@cf-sync/protocol";

import { ApplicationError } from "../../domain/errors";
import { TEXT_CHUNK_SIZE } from "../../domain/vault-state";
import type { FileWrite, OperationChanges, StoredFile, VaultMeta } from "../../domain/vault-state";
import type { BlobStorage } from "../../infra/blob-storage";
import type { VaultRepository } from "../../infra/vault-repository";
import { allocateConflictPath, hasPathCollision } from "../../service/path-conflicts";
import { mergeText } from "../../service/text-content";

type ContentOperation = Extract<Operation, { type: "create" | "edit" }>;

type FileBase = Omit<FileRecord, "kind" | "digest" | "size">;

interface ContentTarget {
	id: string;
	path: string;
	merge: boolean;
	conflict: boolean;
}

export async function applyContentChange(
	operation: ContentOperation,
	current: StoredFile | undefined,
	files: StoredFile[],
	meta: VaultMeta,
	changes: OperationChanges,
	repository: VaultRepository,
	blobs: BlobStorage,
): Promise<void> {
	const target = resolveTarget(operation, current, files);
	meta.revision++;
	let pathRevision = meta.revision;
	let conflict = target.conflict;

	if (target.merge && current) {
		pathRevision = current.file.pathRevision;
		conflict ||= current.file.conflict;
	}

	const previousText = await previousTextUpdate(operation, current, target, repository);
	const base = {
		id: target.id,
		path: target.path,
		revision: meta.revision,
		pathRevision,
		conflict,
	};
	const write = await prepareWrite(operation.content, previousText, blobs, base);

	changes.result.file = write.stored.file;
	changes.result.conflict = target.conflict;

	if (target.conflict) {
		changes.result.conflictReason = "content-preserved";
	}

	changes.writes.push(write);
	changes.dirty.add(target.path);
}

function resolveTarget(
	operation: ContentOperation,
	current: StoredFile | undefined,
	files: StoredFile[],
): ContentTarget {
	if (operation.type === "create" && current) {
		throw new ApplicationError("conflict", "File id already exists");
	}

	const path = current?.file.path ?? operation.path;
	const deleted = operation.type === "edit" && !current;
	const changedKind = current !== undefined && current.file.kind !== operation.content.kind;
	const changedBlob = hasStaleBlobEdit(operation, current);
	const occupied = !current && hasPathCollision(path, files);

	if (deleted || changedKind || changedBlob || occupied) {
		const id = crypto.randomUUID();

		return { id, path: allocateConflictPath(path, files, id), merge: false, conflict: true };
	}

	return {
		id: operation.fileId,
		path,
		merge: operation.type === "edit" && Boolean(current),
		conflict: false,
	};
}

function hasStaleBlobEdit(operation: ContentOperation, current: StoredFile | undefined): boolean {
	if (!current || operation.type !== "edit") {
		return false;
	}

	if (operation.content.kind !== "blob") {
		return false;
	}

	return operation.baseRevision !== current.file.revision;
}

async function previousTextUpdate(
	operation: ContentOperation,
	current: StoredFile | undefined,
	target: ContentTarget,
	repository: VaultRepository,
): Promise<string | undefined> {
	if (operation.content.kind !== "text") {
		return undefined;
	}

	if (!current) {
		if (operation.type !== "edit") {
			return undefined;
		}

		return await repository.deletedTextUpdate(operation.fileId);
	}

	if (!target.merge || "blob" in current) {
		return undefined;
	}

	return await repository.textUpdate(current);
}

async function prepareWrite(
	content: Content,
	previousText: string | undefined,
	blobs: BlobStorage,
	base: FileBase,
): Promise<FileWrite> {
	if (content.kind === "blob") {
		await blobs.validate(content.blob);
		const file = {
			...base,
			kind: "blob" as const,
			digest: content.blob.digest,
			size: content.blob.size,
		};

		return { stored: { file, blob: content.blob } };
	}

	const merged = await mergeText(content.update, previousText);
	const file = { ...base, kind: "text" as const, digest: merged.digest, size: merged.size };
	const chunks = Math.ceil(merged.update.length / TEXT_CHUNK_SIZE);

	return { stored: { file, chunks }, update: merged.update };
}
