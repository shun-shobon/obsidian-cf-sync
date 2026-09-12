import * as Y from "yjs";

import type { LocalFile } from "../domain/sync-state";
import type { StoredData, SyncStore } from "../ports/sync-store";

export class Documents {
  private readonly docs = new Map<string, Y.Doc>();
  private readonly references = new Map<Y.Doc, number>();

  constructor(
    private readonly store: SyncStore,
    private readonly onEdit: (file: LocalFile, doc: Y.Doc) => void,
  ) {}

  get(id: string): Y.Doc | undefined {
    return this.docs.get(id);
  }

  async open(file: LocalFile): Promise<Y.Doc> {
    const existing = this.docs.get(file.id);
    if (existing) return existing;

    const doc = new Y.Doc();
    const stored = await this.store.get(`doc:${file.id}`);
    if (stored) Y.applyUpdate(doc, stored, "remote");
    this.docs.set(file.id, doc);
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== "remote" && origin !== "capture") this.onEdit(file, doc);
    });
    return doc;
  }

  async retain(file: LocalFile): Promise<Y.Doc> {
    const doc = await this.open(file);
    this.references.set(doc, (this.references.get(doc) ?? 0) + 1);
    return doc;
  }

  release(doc: Y.Doc): void {
    const count = this.references.get(doc);
    if (count === undefined) return;
    if (count > 1) {
      this.references.set(doc, count - 1);
      return;
    }
    this.references.delete(doc);
    for (const [id, current] of this.docs) {
      if (current === doc) {
        this.remove(id);
        return;
      }
    }
  }

  remove(id: string): void {
    this.docs.get(id)?.destroy();
    this.docs.delete(id);
  }

  async remap(oldId: string, file: LocalFile): Promise<StoredData | undefined> {
    const doc = this.docs.get(oldId);
    if (doc) {
      this.docs.delete(oldId);
      this.docs.set(file.id, doc);
      return { key: `doc:${file.id}`, value: Y.encodeStateAsUpdate(doc) };
    }
    if (file.kind !== "text") return undefined;

    const stored = await this.store.get(`doc:${oldId}`);
    if (!stored) throw new Error("競合ノートのローカル CRDT 状態がありません");
    return { key: `doc:${file.id}`, value: stored };
  }

  dispose(): void {
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
    this.references.clear();
  }
}
