import { digest, isExcluded, pathSchema, toBase64, type Content } from "@cf-sync/protocol";
import * as Y from "yjs";

import type { LocalFile } from "../domain/sync-state";
import type { StoredData } from "../ports/sync-store";
import type { VaultPort } from "../ports/vault-port";
import type { Documents } from "../service/documents";
import { appendContent, contentOperation } from "../service/pending-operations";
import type { SyncState } from "../service/sync-state";
import { replaceText } from "../service/text";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class LocalChanges {
  constructor(
    private readonly state: SyncState,
    private readonly vault: VaultPort,
    private readonly documents: Documents,
    private readonly onQueued: () => void,
  ) {}

  async scan(): Promise<void> {
    const paths = await this.vault.list();
    const byPath = new Map(this.state.data.files.map((file) => [file.path, file]));
    for (const path of paths) await this.capture(path, byPath);

    if (!this.state.data.initialized) return;
    const present = new Set(paths);
    for (const file of this.state.data.files) {
      if (!present.has(file.path)) await this.delete(file.path, file);
    }
  }

  async rename(oldPath: string, path: string): Promise<boolean> {
    const file = this.state.data.files.find((file) => file.path === oldPath);
    if (!file) {
      await this.capture(path);
      return false;
    }
    if (isExcluded(path, this.state.data.exclusions)) return false;

    pathSchema.parse(path);
    file.path = path;
    this.state.data.pending.push({
      type: "move",
      opId: crypto.randomUUID(),
      fileId: file.id,
      basePathRevision: file.pathRevision,
      path,
    });
    await this.state.persist();
    return true;
  }

  async delete(path: string, known?: LocalFile): Promise<void> {
    const file = known ?? this.state.data.files.find((file) => file.path === path);
    if (!file || isExcluded(path, this.state.data.exclusions)) return;
    if (this.state.data.pending.some((op) => op.fileId === file.id && op.type === "delete")) return;

    this.state.data.pending.push({
      type: "delete",
      opId: crypto.randomUUID(),
      fileId: file.id,
      baseRevision: file.revision,
    });
    await this.state.persist();
  }

  async capture(path: string, byPath?: Map<string, LocalFile>): Promise<void> {
    if (isExcluded(path, this.state.data.exclusions)) return;
    pathSchema.parse(path);

    const bytes = await this.vault.read(path);
    const hash = await digest(bytes);
    const known = byPath
      ? byPath.get(path)
      : this.state.data.files.find((file) => file.path === path);
    if (known && (await this.reconcileDiskBaseline(known, hash))) return;

    const file = known ?? this.addFile(path, hash);
    if (!known) byPath?.set(path, file);
    await this.captureContent(file, bytes, hash);
  }

  async editorChanged(file: LocalFile, doc: Y.Doc): Promise<void> {
    const bytes = encoder.encode(doc.getText("content").toString());
    await this.queueContent(file, bytes, doc);
    await this.vault.write(file.path, bytes);
    file.diskDigest = file.digest;
    await this.state.persist();
  }

  private async reconcileDiskBaseline(file: LocalFile, hash: string): Promise<boolean> {
    if (file.digest === hash) {
      if (file.diskDigest !== hash) {
        file.diskDigest = hash;
        await this.state.persist();
      }
      return true;
    }

    const pendingText =
      file.kind === "text" &&
      this.state.data.pending.some((op) => op.fileId === file.id && "content" in op);
    if (hash !== file.diskDigest || !pendingText) return false;

    const doc = await this.documents.open(file);
    await this.vault.write(file.path, encoder.encode(doc.getText("content").toString()));
    file.diskDigest = file.digest;
    await this.state.persist();
    return true;
  }

  private addFile(path: string, hash: string): LocalFile {
    const file: LocalFile = {
      id: crypto.randomUUID(),
      path,
      digest: "",
      diskDigest: hash,
      documentRevision: 0,
      kind: path.toLowerCase().endsWith(".md") ? "text" : "blob",
      revision: 0,
      pathRevision: 0,
    };
    this.state.data.files.push(file);
    return file;
  }

  private async captureContent(file: LocalFile, bytes: Uint8Array, hash: string): Promise<void> {
    const wasOpen = this.documents.get(file.id) !== undefined;
    const doc = file.kind === "text" ? await this.documents.open(file) : undefined;
    if (doc) replaceText(doc, decoder.decode(bytes), "capture");

    file.diskDigest = hash;
    await this.queueContent(file, bytes, doc);
    if (doc && !wasOpen) this.documents.remove(file.id);
  }

  private async queueContent(file: LocalFile, bytes: Uint8Array, doc?: Y.Doc): Promise<void> {
    const hash = await digest(bytes);
    if (file.digest === hash) return;

    const { content, savedData } = this.prepareContent(file, bytes, hash, doc);
    const operation = contentOperation(this.state.data, file, content);
    file.digest = hash;
    appendContent(this.state.data, operation);
    await this.state.store.save(this.state.data, savedData);
    this.onQueued();
  }

  private prepareContent(
    file: LocalFile,
    bytes: Uint8Array,
    hash: string,
    doc?: Y.Doc,
  ): { content: Content; savedData: StoredData } {
    if (doc) {
      const update = Y.encodeStateAsUpdate(doc);
      return {
        savedData: { key: `doc:${file.id}`, value: update },
        content: { kind: "text", update: toBase64(update) },
      };
    }

    const key = crypto.randomUUID();
    return {
      savedData: { key: `blob:${key}`, value: bytes },
      content: { kind: "blob", blob: { key, size: bytes.length, digest: hash } },
    };
  }
}
