import { digest, isExcluded, pathSchema, type Content } from "@cf-sync/protocol";
import { fromUint8Array } from "js-base64";
import * as v from "valibot";
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
    for (const path of paths) {
      await this.capture(path, byPath);
    }

    if (!this.state.data.initialized) {
      return;
    }

    const present = new Set(paths);
    for (const file of this.state.data.files) {
      if (!present.has(file.path)) {
        await this.delete(file.path, file);
      }
    }
  }

  async rename(oldPath: string, path: string): Promise<boolean> {
    const file = this.state.data.files.find((file) => file.path === oldPath);
    if (!file) {
      await this.capture(path);

      return false;
    }

    if (isExcluded(path, this.state.data.exclusions)) {
      return false;
    }

    v.parse(pathSchema, path);
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
    if (!file || isExcluded(path, this.state.data.exclusions)) {
      return;
    }

    const alreadyQueued = this.state.data.pending.some(
      (operation) => operation.fileId === file.id && operation.type === "delete",
    );
    if (alreadyQueued) {
      return;
    }

    this.state.data.pending.push({
      type: "delete",
      opId: crypto.randomUUID(),
      fileId: file.id,
      baseRevision: file.revision,
    });
    await this.state.persist();
  }

  async capture(path: string, byPath?: Map<string, LocalFile>): Promise<void> {
    if (isExcluded(path, this.state.data.exclusions)) {
      return;
    }

    v.parse(pathSchema, path);

    const bytes = await this.vault.read(path);
    const hash = await digest(bytes);
    let known: LocalFile | undefined;
    if (byPath) {
      known = byPath.get(path);
    } else {
      known = this.state.data.files.find((file) => file.path === path);
    }

    if (known && (await this.reconcileDiskBaseline(known, hash))) {
      return;
    }

    const file = known ?? this.addFile(path, hash);
    if (!known) {
      byPath?.set(path, file);
    }

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

    const hasPendingText =
      file.kind === "text" &&
      this.state.data.pending.some((op) => op.fileId === file.id && "content" in op);
    const diskMatchesBaseline = hash === file.diskDigest;
    if (!diskMatchesBaseline || !hasPendingText) {
      return false;
    }

    const doc = await this.documents.open(file);
    const pendingTextBytes = encoder.encode(doc.getText("content").toString());
    await this.vault.write(file.path, pendingTextBytes);
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
      kind: fileKind(path),
      revision: 0,
      pathRevision: 0,
    };
    this.state.data.files.push(file);

    return file;
  }

  private async captureContent(file: LocalFile, bytes: Uint8Array, hash: string): Promise<void> {
    const wasOpen = this.documents.get(file.id) !== undefined;
    let doc: Y.Doc | undefined;
    if (file.kind === "text") {
      doc = await this.documents.open(file);
    }

    if (doc) {
      replaceText(doc, decoder.decode(bytes), "capture");
    }

    file.diskDigest = hash;
    await this.queueContent(file, bytes, doc);
    if (doc && !wasOpen) {
      this.documents.remove(file.id);
    }
  }

  private async queueContent(file: LocalFile, bytes: Uint8Array, doc?: Y.Doc): Promise<void> {
    const hash = await digest(bytes);
    if (file.digest === hash) {
      return;
    }

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
        content: { kind: "text", update: fromUint8Array(update) },
      };
    }

    const key = crypto.randomUUID();

    return {
      savedData: { key: `blob:${key}`, value: bytes },
      content: { kind: "blob", blob: { key, size: bytes.length, digest: hash } },
    };
  }
}

function fileKind(path: string): LocalFile["kind"] {
  if (path.toLowerCase().endsWith(".md")) {
    return "text";
  }

  return "blob";
}
