import { TFile, type Vault } from "obsidian";

import { digest } from "../shared/protocol";

import type { VaultPort } from "./sync/types";

type FileEvent =
  | { type: "create" | "modify" | "delete"; file: TFile; path: string }
  | { type: "rename"; file: TFile; path: string; oldPath: string };
type ExpectedEvent =
  | { type: "create" | "modify"; path: string; digest: string }
  | { type: "delete"; file: TFile; path: string }
  | { type: "rename"; file: TFile; path: string; oldPath: string };

export class ObsidianVault implements VaultPort {
  private readonly expected = new Set<ExpectedEvent>();
  constructor(private readonly vault: Vault) {}

  /** Consume an expected event when it arrives, including after its API call resolves. */
  async isOwnEvent(event: FileEvent): Promise<boolean> {
    if (event.type === "create" || event.type === "modify") {
      const candidates = [...this.expected].filter(
        (entry) => entry.type === event.type && entry.path === event.path,
      );
      if (!candidates.length) return false;
      if (this.vault.getAbstractFileByPath(event.path) !== event.file) return false;
      const hash = await digest(new Uint8Array(await this.vault.readBinary(event.file)));
      for (const entry of candidates) {
        if ("digest" in entry && entry.digest === hash && this.expected.delete(entry)) return true;
      }
      // A different content version is an external edit. Do not keep an old marker
      // that could suppress a later edit back to the previously written contents.
      for (const entry of candidates) this.expected.delete(entry);
      return false;
    }
    for (const entry of this.expected) {
      if (
        entry.type === event.type &&
        "file" in entry &&
        entry.file === event.file &&
        (event.type === "rename"
          ? entry.type === "rename" && entry.oldPath === event.oldPath
          : entry.path === event.path)
      ) {
        this.expected.delete(entry);
        return true;
      }
    }
    return false;
  }
  private async mutate<T>(event: ExpectedEvent, operation: () => Promise<T>): Promise<T> {
    this.expected.add(event);
    try {
      return await operation();
    } catch (error) {
      this.expected.delete(event);
      throw error;
    }
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
      await this.mutate({ type: "modify", path, digest: hash }, () =>
        this.vault.modifyBinary(existing, buffer),
      );
    else
      await this.mutate({ type: "create", path, digest: hash }, () =>
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
      await this.mutate({ type: "create", path, digest: await digest(bytes) }, () =>
        this.vault.createBinary(path, new Uint8Array(bytes).buffer),
      );
      return true;
    }
    if (!(file instanceof TFile)) return false;
    const event: ExpectedEvent = { type: "modify", path, digest: await digest(bytes) };
    if (path.toLowerCase().endsWith(".md")) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const before = decoder.decode(expected);
      const after = decoder.decode(bytes);
      let changed = false;
      await this.mutate(event, () =>
        this.vault.process(file, (current) => {
          if (current !== before) return current;
          changed = true;
          return after;
        }),
      );
      if (!changed) this.expected.delete(event);
      return changed;
    }
    // Vault exposes no atomic binary compare-and-write API. Keep this check next
    // to modifyBinary; an external writer can still race between these two calls.
    const current = new Uint8Array(await this.vault.readBinary(file));
    if (
      current.length !== expected.length ||
      current.some((byte, index) => byte !== expected[index])
    )
      return false;
    await this.mutate(event, () => this.vault.modifyBinary(file, new Uint8Array(bytes).buffer));
    return true;
  }
  async remove(path: string) {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return;
    if (!(file instanceof TFile)) throw new Error(`ファイルではありません: ${path}`);
    await this.mutate({ type: "delete", file, path }, () => this.vault.trash(file, true));
  }
  async rename(oldPath: string, newPath: string) {
    const file = this.vault.getAbstractFileByPath(oldPath);
    if (!(file instanceof TFile)) throw new Error(`ファイルが見つかりません: ${oldPath}`);
    await this.parents(newPath);
    await this.mutate({ type: "rename", file, oldPath, path: newPath }, () =>
      this.vault.rename(file, newPath),
    );
  }
}
