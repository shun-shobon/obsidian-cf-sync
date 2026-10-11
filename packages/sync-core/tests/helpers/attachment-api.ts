import type { BlobRef, FileRecord, Operation, OperationResult } from "@cf-sync/protocol";

import type { Server } from "../../../obsidian-plugin/tests/helpers/sync-server";
import type { RestApiPort } from "../../src";

interface StoredAttachment {
	file: FileRecord;
	blob: BlobRef;
}

// The shared test server only models text documents, so attachments are tracked here on its revision counter.
export function withAttachments(server: Server) {
	const blobs = new Map<string, Uint8Array>();
	const attachments = new Map<string, StoredAttachment>();
	const downloads: string[] = [];

	const operateAttachment = (operation: Operation): OperationResult => {
		const previous = attachments.get(operation.fileId)?.file;
		const revision = ++server.revision;
		const result = {
			opId: operation.opId,
			revision,
			previousRevision: previous?.revision ?? null,
			previousPathRevision: previous?.pathRevision ?? null,
			conflict: false,
		};

		if (operation.type === "delete") {
			attachments.delete(operation.fileId);

			return { ...result, file: null };
		}

		const current = attachments.get(operation.fileId);
		const file: FileRecord = {
			id: operation.fileId,
			path: operation.path,
			kind: "blob",
			revision,
			pathRevision: previous?.pathRevision ?? 0,
			digest: current?.blob.digest ?? "",
			size: current?.blob.size ?? 0,
			conflict: false,
		};
		let blob = current?.blob;

		if (operation.type === "move") {
			file.pathRevision = revision;
		} else if (operation.content.kind === "blob") {
			blob = operation.content.blob;
			file.digest = blob.digest;
			file.size = blob.size;
		}

		attachments.set(operation.fileId, { file, blob: blob! });

		return { ...result, file: { ...file } };
	};

	const isAttachment = (operation: Operation) => {
		const hasBlob = "content" in operation && operation.content.kind === "blob";

		return hasBlob || attachments.has(operation.fileId);
	};

	const api: RestApiPort = {
		async snapshot() {
			const snapshot = await server.api.snapshot();
			const files = [...attachments.values()].map(({ file }) => structuredClone(file));

			return { ...snapshot, files: [...snapshot.files, ...files] };
		},
		async document(id) {
			const attachment = attachments.get(id);
			if (!attachment) {
				return await server.api.document(id);
			}

			return {
				file: { ...attachment.file },
				content: { kind: "blob", blob: { ...attachment.blob } },
			};
		},
		async operate(operation) {
			if (isAttachment(operation)) {
				return operateAttachment(operation);
			}

			return await server.api.operate(operation);
		},
		upload(key, bytes, digest) {
			blobs.set(key, bytes.slice());

			return Promise.resolve({ key, size: bytes.length, digest });
		},
		download(ref) {
			downloads.push(ref.key);

			return Promise.resolve(blobs.get(ref.key)!.slice());
		},
	};

	return { api, downloads };
}
