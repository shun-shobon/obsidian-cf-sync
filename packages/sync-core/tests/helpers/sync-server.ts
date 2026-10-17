import { digest } from "@cf-sync/protocol";
import type { FileRecord, Operation, OperationResult } from "@cf-sync/protocol";
import { toUint8Array, fromUint8Array } from "js-base64";
import * as Y from "yjs";

import { ConnectionError } from "../../src/domain/connection-error";
import type { ApiPort } from "../../src/sync/ports/api-port";

interface ServerDocument {
	doc: Y.Doc;
	file: FileRecord;
}

export class Server {
	docs = new Map<string, ServerDocument>();
	results = new Map<string, OperationResult>();
	revision = 0;
	calls: string[] = [];
	operations: Operation[] = [];
	failAfterSave = false;
	offline = false;

	api: ApiPort = {
		snapshot: () => {
			if (this.offline) {
				return Promise.reject(new ConnectionError("offline"));
			}

			return Promise.resolve({
				revision: this.revision,
				r2Revision: this.revision,
				exclusions: [],
				files: [...this.docs.values()].map(({ file }) => structuredClone(file)),
			});
		},
		document: (id) => {
			const value = this.docs.get(id)!;

			return Promise.resolve({
				file: { ...value.file },
				content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(value.doc)) },
			});
		},
		operate: (operation) => this.operate(operation),
		upload: () => Promise.reject(new Error("unused")),
		download: () => Promise.reject(new Error("unused")),
		connect: (onMessage, onClose) =>
			Promise.resolve({
				close() {},
				send: (message) => {
					if (message.type !== "operation") {
						return;
					}
					void this.api.operate(message.operation).then(
						(result) => onMessage({ type: "operation-result", result }),
						(error: unknown) => {
							if (error instanceof ConnectionError) {
								onClose(error);
							} else {
								onMessage({
									type: "operation-error",
									opId: message.operation.opId,
									message: String(error),
									retryable: false,
								});
							}
						},
					);
				},
			}),
	};

	private async operate(operation: Operation): Promise<OperationResult> {
		if (this.offline) {
			throw new ConnectionError("offline");
		}

		this.calls.push(operation.opId);
		this.operations.push(structuredClone(operation));
		const saved = this.results.get(operation.opId);
		if (saved) {
			return saved;
		}

		const previous = this.docs.get(operation.fileId)?.file;
		const previousRevision = previous?.revision ?? null;
		const previousPathRevision = previous?.pathRevision ?? null;
		const { file, conflict } = await this.apply(operation);
		const result: OperationResult = {
			opId: operation.opId,
			previousRevision,
			previousPathRevision,
			revision: ++this.revision,
			file,
			conflict,
		};
		this.results.set(operation.opId, result);
		if (operation.type !== "delete" && this.failAfterSave) {
			this.failAfterSave = false;
			throw new ConnectionError("response lost");
		}

		return result;
	}

	private async apply(
		operation: Operation,
	): Promise<{ file: FileRecord | null; conflict: boolean }> {
		if (operation.type === "delete") {
			this.docs.delete(operation.fileId);

			return { file: null, conflict: false };
		}

		const value = this.docs.get(operation.fileId) ?? this.createDocument(operation);
		if ("content" in operation && operation.content.kind === "text") {
			Y.applyUpdate(value.doc, toUint8Array(operation.content.update));
		}

		const conflict =
			operation.type === "move" && operation.basePathRevision !== value.file.pathRevision;
		if (operation.type === "move" && !conflict) {
			value.file.path = operation.path;
			value.file.pathRevision = this.revision + 1;
		}

		const bytes = new TextEncoder().encode(value.doc.getText("content").toString());
		value.file.digest = await digest(bytes);
		value.file.size = bytes.length;
		value.file.revision = this.revision + 1;

		return { file: { ...value.file }, conflict };
	}

	private createDocument(operation: Exclude<Operation, { type: "delete" }>): ServerDocument {
		const value: ServerDocument = {
			doc: new Y.Doc(),
			file: {
				id: operation.fileId,
				path: operation.path,
				kind: "text",
				revision: 0,
				pathRevision: 0,
				digest: "",
				size: 0,
				conflict: false,
			},
		};
		this.docs.set(operation.fileId, value);

		return value;
	}
}
