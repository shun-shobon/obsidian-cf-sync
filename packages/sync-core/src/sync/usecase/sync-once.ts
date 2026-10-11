import type { FileRecord } from "@cf-sync/protocol";

import { DocumentNotFoundError } from "../../domain/document-not-found-error";
import type { SyncResult } from "../domain/sync-result";
import { needsReceive } from "../service/snapshot-state";
import { SendPending } from "./send-pending";
import type { SyncOnceOptions } from "./sync-once-options";
import { SyncSession, batchHooks } from "./sync-session";

export class SyncOnce {
	private readonly conflicts: FileRecord[] = [];
	private readonly session: SyncSession;
	private readonly sender: SendPending;
	private missingAtRevision: number | undefined;

	constructor(private readonly options: SyncOnceOptions) {
		this.session = new SyncSession(options, batchHooks(this.conflicts));
		this.sender = new SendPending(
			this.session.state,
			options.api,
			this.session.documents,
			(work) => this.session.enqueue(work),
			(operation) => options.api.operate(operation),
			() => {},
		);
	}

	async run(): Promise<SyncResult> {
		try {
			await this.session.prepare();

			let remaining = true;

			while (remaining) {
				remaining = await this.synchronize();
			}

			const { data } = this.session.state;

			return {
				revision: data.revision,
				r2Revision: data.r2Revision,
				pending: data.pending.length,
				conflicts: structuredClone(this.conflicts),
			};
		} finally {
			this.session.dispose();
		}
	}

	private async synchronize(): Promise<boolean> {
		const { state, reconcile } = this.session;

		await this.sender.run(() => true);

		const snapshot = await this.options.api.snapshot();
		const filesBefore = JSON.stringify(state.data.files);

		try {
			await reconcile.run(snapshot, () => true);
		} catch (error) {
			if (this.retriesWithNewSnapshot(error, snapshot.revision)) {
				return true;
			}

			throw error;
		}

		const pending = state.hasPending();
		const remaining = pending || needsReceive(state.data, snapshot);
		const unchanged = filesBefore === JSON.stringify(state.data.files);

		if (remaining && !pending && unchanged) {
			throw new Error("Could not apply the server snapshot");
		}

		return remaining;
	}

	private retriesWithNewSnapshot(error: unknown, revision: number): boolean {
		// 同じrevisionで再び見つからなければ一覧と本文が食い違っており、再取得しても解消しない
		if (!(error instanceof DocumentNotFoundError) || this.missingAtRevision === revision) {
			return false;
		}

		this.missingAtRevision = revision;

		return true;
	}
}
