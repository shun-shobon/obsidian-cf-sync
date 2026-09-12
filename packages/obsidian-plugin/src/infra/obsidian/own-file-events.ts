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
      return this.consumeContentEvent(event);
    }

    for (const entry of this.expected) {
      if (!matchesFileOperation(entry, event)) {
        continue;
      }

      this.expected.delete(entry);

      return true;
    }

    return false;
  }

  private async consumeContentEvent(event: FileEvent): Promise<boolean> {
    const candidates = [...this.expected].filter(
      (entry) => entry.type === event.type && entry.path === event.path,
    );

    if (!candidates.length) {
      return false;
    }

    if (this.vault.getAbstractFileByPath(event.path) !== event.file) {
      return false;
    }

    const content = new Uint8Array(await this.vault.readBinary(event.file));
    const hash = await digest(content);

    for (const entry of candidates) {
      if (!("digest" in entry)) {
        continue;
      }

      if (entry.digest !== hash) {
        continue;
      }

      if (this.expected.delete(entry)) {
        return true;
      }
    }

    // Different content means an external edit. Remove old markers so a later
    // external edit back to the previous content is not mistaken for our write.
    for (const entry of candidates) {
      this.expected.delete(entry);
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

function matchesFileOperation(entry: ExpectedEvent, event: FileEvent): boolean {
  if (entry.type !== event.type) {
    return false;
  }

  if (!("file" in entry)) {
    return false;
  }

  if (entry.file !== event.file) {
    return false;
  }

  if (event.type === "rename") {
    return entry.type === "rename" && entry.oldPath === event.oldPath;
  }

  return entry.path === event.path;
}
