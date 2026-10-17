import { conflictPath, digest } from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";
import * as Y from "yjs";

import { t } from "../../i18n";
import { documentKey, incomingKey } from "../domain/storage-keys";
import type { IncomingWrite } from "../domain/sync-state";
import type { StoredData } from "../ports/sync-store";
import type { VaultPort } from "../ports/vault-port";
import type { Documents } from "../service/documents";
import type { SyncState } from "../service/sync-state";
import type { LocalChanges } from "./local-changes";

export class RecoverIncoming {
	constructor(
		private readonly state: SyncState,
		private readonly vault: VaultPort,
		private readonly documents: Documents,
		private readonly changes: LocalChanges,
	) {}

	async run(): Promise<void> {
		const incoming = this.state.data.incoming;
		if (!incoming) {
			return;
		}

		let current: Uint8Array | undefined;
		let currentDigest: string | null = null;
		if (await this.vault.exists(incoming.file.path)) {
			current = await this.vault.read(incoming.file.path);
			currentDigest = await digest(current);
		}

		if (!current && incoming.expectedDigest != null) {
			await this.recoverDeletedFile(incoming);

			return;
		}

		if (currentDigest === incoming.expectedDigest) {
			await this.state.clearIncoming();

			return;
		}

		if (currentDigest !== incoming.digest) {
			await this.recoverChangedFile(incoming, current);
		}

		await this.commitRecovered(incoming);
	}

	private async receivedBytes(): Promise<Uint8Array> {
		const received = await this.state.store.get(incomingKey);
		if (!received) {
			throw new Error(t(($) => $.errors.missingIncoming));
		}

		return received;
	}

	private async preserveCopy(
		incoming: IncomingWrite,
		bytes: Uint8Array,
		message: string,
	): Promise<void> {
		const recoveryPath = conflictPath(incoming.file.path, crypto.randomUUID());
		await this.vault.write(recoveryPath, bytes);
		await this.changes.capture(recoveryPath);
		const recovered = this.state.data.files.find((file) => file.path === recoveryPath)!;
		this.state.reportConflict(
			{ ...incoming.file, ...recovered, size: bytes.length, conflict: true },
			message,
		);
	}

	private async recoverDeletedFile(incoming: IncomingWrite): Promise<void> {
		await this.preserveCopy(
			incoming,
			await this.receivedBytes(),
			t(($) => $.sync.deletedRecovered),
		);
		const deleting = this.state.data.pending.some(
			(operation) => operation.fileId === incoming.file.id && operation.type === "delete",
		);
		if (!deleting) {
			this.state.data.pending.push({
				type: "delete",
				opId: crypto.randomUUID(),
				fileId: incoming.file.id,
				baseRevision: incoming.file.revision,
			});
		}

		await this.state.clearIncoming();
	}

	private async recoverChangedFile(
		incoming: IncomingWrite,
		current: Uint8Array | undefined,
	): Promise<void> {
		if (current) {
			await this.preserveCopy(
				incoming,
				current,
				t(($) => $.sync.interruptedRecovered),
			);
		}

		const received = await this.receivedBytes();
		const written = await this.vault.writeIfUnchanged(incoming.file.path, current, received);
		if (!written) {
			throw new Error(t(($) => $.errors.recoveryChanged));
		}
	}

	private async commitRecovered(incoming: IncomingWrite): Promise<void> {
		let local = this.state.data.files.find((file) => file.id === incoming.file.id);
		const received = {
			...incoming.file,
			digest: incoming.digest,
			diskDigest: incoming.digest,
			documentRevision: incoming.file.revision,
		};
		if (!local) {
			local = received;
			this.state.data.files.push(local);
		} else {
			Object.assign(local, received);
		}

		let data: StoredData | undefined;
		if (incoming.update != null) {
			data = { key: documentKey(local.id), value: toUint8Array(incoming.update) };
		}

		await this.state.clearIncoming(data);
		const doc = this.documents.get(local.id);
		if (data && doc) {
			Y.applyUpdate(doc, data.value, "remote");
		}
	}
}
