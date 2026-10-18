import { isExcluded } from "@cf-sync/protocol";
import type { FileRecord } from "@cf-sync/protocol";

import { t } from "../../i18n";
import type { LocalState, SyncStatus } from "../domain/sync-state";
import type { StoredData, SyncStore } from "../ports/sync-store";

export class SyncState {
	data: LocalState = {
		initialized: false,
		incoming: null,
		attempted: [],
		files: [],
		pending: [],
		exclusions: [],
		revision: 0,
		r2Revision: 0,
		conflictIds: [],
	};

	constructor(
		readonly store: SyncStore,
		private readonly onStatus: (status: SyncStatus) => void,
		private readonly onConflict: (file: FileRecord, message: string) => void,
	) {}

	async load(): Promise<void> {
		const stored: LocalState | LegacyLocalState | undefined = await this.store.load();
		if (!stored) {
			return;
		}

		if (!isLegacy(stored)) {
			this.data = stored;

			return;
		}

		this.data = upgradeLegacy(stored);
		await this.persist();
	}

	hasPending(): boolean {
		return this.data.pending.some((operation) => {
			const local = this.data.files.find((file) => file.id === operation.fileId);

			return !local || !isExcluded(local.path, this.data.exclusions);
		});
	}

	emit(phase: SyncStatus["phase"], error?: unknown): void {
		const status: SyncStatus = {
			phase,
			pending: this.data.pending.length,
			revision: this.data.revision,
			r2Revision: this.data.r2Revision,
		};

		if (error !== undefined) {
			status.error = errorMessage(error);
		}

		this.onStatus(status);
	}

	emitProgress(): void {
		if (this.data.pending.length > 0) {
			this.emit("syncing");

			return;
		}

		const awaitingR2 = this.data.r2Revision < this.data.revision;
		if (awaitingR2) {
			this.emit("r2-pending");

			return;
		}

		this.emit("synced");
	}

	persist(data?: StoredData): Promise<void> {
		return this.store.save(this.data, data);
	}

	async clearIncoming(data?: StoredData): Promise<void> {
		// Keep the in-memory record until the store confirms, so a failed save can still be recovered.
		await this.store.save({ ...this.data, incoming: null }, data);
		this.data.incoming = null;
	}

	reportConflict(file: FileRecord, message: string): void {
		if (this.data.conflictIds.includes(file.id)) {
			return;
		}

		this.data.conflictIds.push(file.id);
		this.onConflict(file, message);
	}

	/** A deleted file never returns under the same ID, so its report no longer needs suppressing. */
	forgetConflict(fileId: string): void {
		this.data.conflictIds = this.data.conflictIds.filter((id) => id !== fileId);
	}
}

// Releases up to 0.3.1 stored whole conflict records. Rewriting them on load keeps the old shape out of the rest of the code.
type LegacyLocalState = Omit<LocalState, "conflictIds"> & { conflicts: Pick<FileRecord, "id">[] };

function isLegacy(state: LocalState | LegacyLocalState): state is LegacyLocalState {
	return "conflicts" in state;
}

function upgradeLegacy(legacy: LegacyLocalState): LocalState {
	const { conflicts, ...state } = legacy;

	return { ...state, conflictIds: conflicts.map((file) => file.id) };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	return t(($) => $.errors.syncFailed);
}
