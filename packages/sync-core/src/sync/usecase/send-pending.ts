import { isExcluded } from "@cf-sync/protocol";
import type { FileRecord, Operation, OperationResult } from "@cf-sync/protocol";

import { t } from "../../i18n";
import { blobKey } from "../domain/storage-keys";
import type { LocalFile } from "../domain/sync-state";
import type { RestApiPort } from "../ports/api-port";
import type { StoredData } from "../ports/sync-store";
import type { Documents } from "../service/documents";
import { rebasePending } from "../service/pending-operations";
import type { SyncState } from "../service/sync-state";

export class SendPending {
	private readonly inFlight = new Set<string>();
	private textRun: Promise<void> | undefined;
	private otherRun: Promise<void> | undefined;

	constructor(
		private readonly state: SyncState,
		private readonly api: RestApiPort,
		private readonly documents: Documents,
		private readonly serialize: <T>(work: () => Promise<T>) => Promise<T>,
		private readonly operate: (operation: Operation) => Promise<OperationResult>,
		private readonly onAcknowledged: (operation: Operation, result: OperationResult) => void,
	) {}

	async run(isActive: () => boolean): Promise<void> {
		while (isActive()) {
			const before = this.state.data.pending.map((op) => op.opId).join(",");
			const results = await Promise.allSettled([this.runText(isActive), this.runOther(isActive)]);
			for (const result of results) {
				if (result.status === "rejected") {
					throw result.reason;
				}
			}
			const after = this.state.data.pending.map((op) => op.opId).join(",");
			if (before === after || !after) {
				return;
			}
		}
	}

	private runText(isActive: () => boolean): Promise<void> {
		this.textRun ??= this.runLane(true, isActive).finally(() => {
			this.textRun = undefined;
		});
		return this.textRun;
	}

	private runOther(isActive: () => boolean): Promise<void> {
		this.otherRun ??= this.runLane(false, isActive).finally(() => {
			this.otherRun = undefined;
		});
		return this.otherRun;
	}

	private async runLane(text: boolean, isActive: () => boolean): Promise<void> {
		while (isActive()) {
			const next = await this.serialize(async () => {
				if (!isActive()) {
					return undefined;
				}
				const seen = new Set<string>();
				for (const operation of this.state.data.pending) {
					if (seen.has(operation.fileId)) {
						continue;
					}
					seen.add(operation.fileId);
					const isText = "content" in operation && operation.content.kind === "text";
					if (isText !== text || this.inFlight.has(operation.fileId)) {
						continue;
					}
					const local = this.state.data.files.find((file) => file.id === operation.fileId);
					if (local && isExcluded(local.path, this.state.data.exclusions)) {
						continue;
					}
					await this.markAttempted(operation);
					this.inFlight.add(operation.fileId);
					return { operation: structuredClone(operation), local };
				}
				return undefined;
			});
			if (!next) {
				return;
			}
			const { operation, local } = next;
			try {
				// Network and attachment transfers never hold the local state queue.
				await this.uploadContent(operation);
				if (!isActive()) {
					return;
				}
				const result = await this.operate(operation);
				if (!isActive()) {
					return;
				}
				await this.serialize(async () => {
					if (!isActive()) {
						return;
					}
					await this.acknowledge(operation, result, local);
					this.onAcknowledged(operation, result);
					if ("content" in operation && operation.content.kind === "blob") {
						await this.state.store.delete(blobKey(operation.content.blob.key));
					}
				});
			} finally {
				this.inFlight.delete(operation.fileId);
			}
		}
	}

	private async uploadContent(operation: Operation): Promise<void> {
		if (!("content" in operation) || operation.content.kind !== "blob") {
			return;
		}

		const blob = operation.content.blob;
		const bytes = await this.state.store.get(blobKey(blob.key));
		if (!bytes) {
			throw new Error(t(($) => $.errors.missingAttachment));
		}

		await this.api.upload(blob.key, bytes, blob.digest);
	}

	private async markAttempted(operation: Operation): Promise<void> {
		if (this.state.data.attempted.includes(operation.opId)) {
			return;
		}

		this.state.data.attempted.push(operation.opId);
		await this.state.persist();
	}

	private async acknowledge(
		operation: Operation,
		result: OperationResult,
		local: LocalFile | undefined,
	): Promise<void> {
		const state = this.state.data;
		state.pending = state.pending.filter((entry) => entry.opId !== operation.opId);
		state.attempted = state.attempted.filter((id) => id !== operation.opId);

		const file = result.file;
		let savedData: StoredData | undefined;

		if (file && result.conflict) {
			this.state.reportConflict(file, conflictMessage(result));
		}

		// A deletion conflict returns a separate preserved file, not a new identity for the deleted file.
		if (file && local && operation.type !== "delete") {
			savedData = await this.updateBaseline(local, operation, result, file);
		}

		await this.state.store.save(state, savedData);
	}

	private async updateBaseline(
		local: LocalFile,
		operation: Operation,
		result: OperationResult,
		file: FileRecord,
	): Promise<StoredData | undefined> {
		// Keep local content and path until the entire outbox has drained.
		rebasePending(this.state.data.pending, local, operation, result, file);
		local.revision = file.revision;
		local.pathRevision = file.pathRevision;
		if (file.id === local.id) {
			return undefined;
		}

		const oldId = local.id;
		local.id = file.id;
		for (const pending of this.state.data.pending) {
			if (pending.fileId === oldId) {
				pending.fileId = local.id;
			}
		}

		return await this.documents.remap(oldId, local);
	}
}

function conflictMessage(result: OperationResult): string {
	// Results persisted by the server before conflictReason existed can still be replayed for a retried opId.
	if (result.conflictReason === undefined) {
		return t(($) => $.sync.conflictPreserved);
	}

	const reasons: Record<NonNullable<OperationResult["conflictReason"]>, string> = {
		"move-rejected": t(($) => $.sync.moveRejected),
		"edit-preserved": t(($) => $.sync.editPreserved),
		"content-preserved": t(($) => $.sync.contentPreserved),
	};

	return reasons[result.conflictReason];
}
