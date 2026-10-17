import { digest, fileKind } from "@cf-sync/protocol";
import type { VaultPort } from "@cf-sync/sync-core/sync/ports/vault-port";
import { TFile } from "obsidian";
import type { FileManager, Vault } from "obsidian";

import { t } from "../../i18n";
import { OwnFileEvents } from "./own-file-events";
import type { ContentEvent, FileEvent } from "./own-file-events";

export class ObsidianVault implements VaultPort {
	private readonly events: OwnFileEvents;

	constructor(
		private readonly vault: Vault,
		private readonly fileManager: FileManager,
	) {
		this.events = new OwnFileEvents(vault);
	}

	isOwnEvent(event: FileEvent): Promise<boolean> {
		return this.events.isOwnEvent(event);
	}

	list() {
		return Promise.resolve(this.vault.getFiles().map((file) => file.path));
	}

	exists(path: string) {
		return Promise.resolve(this.vault.getAbstractFileByPath(path) instanceof TFile);
	}

	async read(path: string) {
		const file = this.vault.getAbstractFileByPath(path);

		if (!(file instanceof TFile)) {
			throw new Error(t(($) => $.errors.fileMissing, { path: path }));
		}

		return new Uint8Array(await this.vault.readBinary(file));
	}

	private async parents(path: string) {
		const parts = path.split("/");
		parts.pop();
		const parentParts: string[] = [];

		for (const part of parts) {
			parentParts.push(part);
			const parentPath = parentParts.join("/");

			if (!this.vault.getAbstractFileByPath(parentPath)) {
				await this.vault.createFolder(parentPath);
			}
		}
	}

	private async create(path: string, bytes: Uint8Array) {
		await this.parents(path);
		await this.events.expectContent({ type: "create", path, digest: await digest(bytes) }, () =>
			this.vault.createBinary(path, new Uint8Array(bytes).buffer),
		);
	}

	async write(path: string, bytes: Uint8Array) {
		const existing = this.vault.getAbstractFileByPath(path);

		if (!existing) {
			await this.create(path, bytes);

			return;
		}

		if (!(existing instanceof TFile)) {
			throw new Error(t(($) => $.errors.folderCollision, { path: path }));
		}

		await this.events.expectContent({ type: "modify", path, digest: await digest(bytes) }, () =>
			this.vault.modifyBinary(existing, new Uint8Array(bytes).buffer),
		);
	}

	async writeIfUnchanged(
		path: string,
		expected: Uint8Array | undefined,
		bytes: Uint8Array,
	): Promise<boolean> {
		const file = this.vault.getAbstractFileByPath(path);

		if (expected === undefined) {
			if (file) {
				return false;
			}

			await this.create(path, bytes);

			return true;
		}

		if (!(file instanceof TFile)) {
			return false;
		}

		const event: ContentEvent = { type: "modify", path, digest: await digest(bytes) };

		if (fileKind(path) === "text") {
			return await this.writeTextIfUnchanged(file, event, expected, bytes);
		}

		return await this.writeBinaryIfUnchanged(file, event, expected, bytes);
	}

	private async writeTextIfUnchanged(
		file: TFile,
		event: ContentEvent,
		expected: Uint8Array,
		bytes: Uint8Array,
	): Promise<boolean> {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const before = decoder.decode(expected);
		const after = decoder.decode(bytes);
		// A mutable field: TypeScript would narrow a `let` to `false` across the callback.
		const result = { changed: false };
		await this.events.expectContent(event, () =>
			this.vault.process(file, (current) => {
				if (current !== before) {
					return current;
				}

				result.changed = true;

				return after;
			}),
		);

		if (!result.changed) {
			this.events.discardContent(event);
		}

		return result.changed;
	}

	private async writeBinaryIfUnchanged(
		file: TFile,
		event: ContentEvent,
		expected: Uint8Array,
		bytes: Uint8Array,
	): Promise<boolean> {
		// Vault exposes no atomic binary compare-and-write API. Keep this check next
		// to modifyBinary; an external writer can still race between these two calls.
		const current = new Uint8Array(await this.vault.readBinary(file));

		if (current.length !== expected.length) {
			return false;
		}

		const contentChanged = current.some((byte, index) => byte !== expected[index]);

		if (contentChanged) {
			return false;
		}

		await this.events.expectContent(event, () =>
			this.vault.modifyBinary(file, new Uint8Array(bytes).buffer),
		);

		return true;
	}

	async remove(path: string) {
		const file = this.vault.getAbstractFileByPath(path);

		if (!file) {
			return;
		}

		if (!(file instanceof TFile)) {
			throw new Error(t(($) => $.errors.notFile, { path: path }));
		}

		await this.events.expectFileOperation({ type: "delete", file, path }, () =>
			this.fileManager.trashFile(file),
		);
	}

	async rename(oldPath: string, newPath: string) {
		const file = this.vault.getAbstractFileByPath(oldPath);

		if (!(file instanceof TFile)) {
			throw new Error(t(($) => $.errors.fileMissing, { path: oldPath }));
		}

		await this.parents(newPath);
		await this.events.expectFileOperation({ type: "rename", file, oldPath, path: newPath }, () =>
			this.vault.rename(file, newPath),
		);
	}
}
