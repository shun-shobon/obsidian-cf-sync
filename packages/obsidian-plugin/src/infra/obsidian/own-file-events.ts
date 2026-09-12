import { digest } from "@cf-sync/protocol";
import { TFile, type Vault } from "obsidian";

export type FileEvent =
  | { type: "create" | "modify" | "delete"; file: TFile; path: string }
  | { type: "rename"; file: TFile; path: string; oldPath: string };

export type ExpectedEvent =
  | { type: "create" | "modify"; path: string; digest: string }
  | { type: "delete"; file: TFile; path: string }
  | { type: "rename"; file: TFile; path: string; oldPath: string };

export class OwnFileEvents {
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

  async run<T>(event: ExpectedEvent, operation: () => Promise<T>): Promise<T> {
    this.expected.add(event);
    try {
      return await operation();
    } catch (error) {
      this.expected.delete(event);
      throw error;
    }
  }

  discard(event: ExpectedEvent) {
    this.expected.delete(event);
  }
}
