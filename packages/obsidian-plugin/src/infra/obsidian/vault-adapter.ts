import { digest } from "@cf-sync/protocol";
import { TFile, type Vault } from "obsidian";

import type { VaultPort } from "../../sync/ports/vault-port";

import { OwnFileEvents, type ExpectedEvent, type FileEvent } from "./own-file-events";

export class ObsidianVault implements VaultPort {
  private readonly events: OwnFileEvents;

  constructor(private readonly vault: Vault) {
    this.events = new OwnFileEvents(vault);
  }

  isOwnEvent(event: FileEvent): Promise<boolean> {
    return this.events.isOwnEvent(event);
  }

  async list() {
    return this.vault.getFiles().map((file) => file.path);
  }

  async read(path: string) {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`ファイルが見つかりません: ${path}`);
    return new Uint8Array(await this.vault.readBinary(file));
  }

  private async parents(path: string) {
    const parts = path.split("/");
    parts.pop();
    let parent = "";
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      if (!this.vault.getAbstractFileByPath(parent)) await this.vault.createFolder(parent);
    }
  }

  async write(path: string, bytes: Uint8Array) {
    await this.parents(path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing && !(existing instanceof TFile))
      throw new Error(`フォルダーとファイルが衝突しています: ${path}`);
    const buffer = new Uint8Array(bytes).buffer;
    const hash = await digest(bytes);
    if (existing)
      await this.events.run({ type: "modify", path, digest: hash }, () =>
        this.vault.modifyBinary(existing, buffer),
      );
    else
      await this.events.run({ type: "create", path, digest: hash }, () =>
        this.vault.createBinary(path, buffer),
      );
  }

  async writeIfUnchanged(
    path: string,
    expected: Uint8Array | undefined,
    bytes: Uint8Array,
  ): Promise<boolean> {
    await this.parents(path);
    const file = this.vault.getAbstractFileByPath(path);
    if (expected === undefined) {
      if (file) return false;
      await this.events.run({ type: "create", path, digest: await digest(bytes) }, () =>
        this.vault.createBinary(path, new Uint8Array(bytes).buffer),
      );
      return true;
    }
    if (!(file instanceof TFile)) return false;
    const event: ExpectedEvent = { type: "modify", path, digest: await digest(bytes) };
    if (path.toLowerCase().endsWith(".md")) {
      return this.writeTextIfUnchanged(file, event, expected, bytes);
    }
    return this.writeBinaryIfUnchanged(file, event, expected, bytes);
  }

  private async writeTextIfUnchanged(
    file: TFile,
    event: ExpectedEvent,
    expected: Uint8Array,
    bytes: Uint8Array,
  ): Promise<boolean> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const before = decoder.decode(expected);
    const after = decoder.decode(bytes);
    let changed = false;
    await this.events.run(event, () =>
      this.vault.process(file, (current) => {
        if (current !== before) return current;
        changed = true;
        return after;
      }),
    );
    if (!changed) this.events.discard(event);
    return changed;
  }

  private async writeBinaryIfUnchanged(
    file: TFile,
    event: ExpectedEvent,
    expected: Uint8Array,
    bytes: Uint8Array,
  ): Promise<boolean> {
    // Vault exposes no atomic binary compare-and-write API. Keep this check next
    // to modifyBinary; an external writer can still race between these two calls.
    const current = new Uint8Array(await this.vault.readBinary(file));
    if (
      current.length !== expected.length ||
      current.some((byte, index) => byte !== expected[index])
    )
      return false;
    await this.events.run(event, () => this.vault.modifyBinary(file, new Uint8Array(bytes).buffer));
    return true;
  }

  async remove(path: string) {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return;
    if (!(file instanceof TFile)) throw new Error(`ファイルではありません: ${path}`);
    await this.events.run({ type: "delete", file, path }, () => this.vault.trash(file, true));
  }

  async rename(oldPath: string, newPath: string) {
    const file = this.vault.getAbstractFileByPath(oldPath);
    if (!(file instanceof TFile)) throw new Error(`ファイルが見つかりません: ${oldPath}`);
    await this.parents(newPath);
    await this.events.run({ type: "rename", file, oldPath, path: newPath }, () =>
      this.vault.rename(file, newPath),
    );
  }
}
