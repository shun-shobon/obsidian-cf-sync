import {
  conflictPath,
  digest,
  fromBase64,
  toBase64,
  type DocumentResponse,
  type FileRecord,
} from "@cf-sync/protocol";
import * as Y from "yjs";

import type { LocalFile } from "../domain/sync-state";
import type { ApiPort } from "../ports/api-port";
import type { VaultPort } from "../ports/vault-port";
import type { Documents } from "../service/documents";
import type { SyncState } from "../service/sync-state";

import type { LocalChanges } from "./local-changes";

export interface ReconcileContext {
  paths: Set<string>;
  byId: Map<string, LocalFile>;
  byPath: Map<string, LocalFile>;
}

interface PreparedContent {
  bytes: Uint8Array;
  update: string | null;
  doc: Y.Doc | undefined;
  wasOpen: boolean;
}

export class ReceiveFile {
  constructor(
    private readonly state: SyncState,
    private readonly vault: VaultPort,
    private readonly api: ApiPort,
    private readonly documents: Documents,
    private readonly changes: LocalChanges,
  ) {}

  async run(
    remote: FileRecord,
    fetched?: DocumentResponse,
    context?: ReconcileContext,
  ): Promise<void> {
    const existing = context
      ? context.byId.get(remote.id)
      : this.state.data.files.find((file) => file.id === remote.id);
    const paths = context?.paths ?? new Set(await this.vault.list());
    if (this.alreadyReceived(existing, remote)) return;
    if (existing && paths.has(existing.path) && (await this.captureChangedFile(existing))) return;

    const document = fetched ?? (await this.api.document(remote.id));
    const sourcePath = existing?.path ?? remote.path;
    const present = new Set(await this.vault.list());
    const expected = present.has(sourcePath) ? await this.vault.read(sourcePath) : undefined;
    if (await this.captureDuringFetch(existing, remote, expected)) return;

    const local = existing ?? { ...remote, diskDigest: remote.digest, documentRevision: 0 };
    const content = await this.prepareContent(local, document);
    const occupied = await this.preparePath(local, remote, paths, context);
    const expectedAtTarget = occupied ? undefined : expected;
    await this.saveIncoming(remote, document, content, expectedAtTarget);

    if (!(await this.vault.writeIfUnchanged(remote.path, expectedAtTarget, content.bytes))) {
      await this.captureInterruptedWrite(existing, local, remote, content);
      return;
    }

    await this.commitReceived(existing, local, remote, document, content, context);
    paths.add(remote.path);
    this.releaseContent(local, content);
  }

  private alreadyReceived(local: LocalFile | undefined, remote: FileRecord): boolean {
    if (
      local?.digest !== remote.digest ||
      local.path !== remote.path ||
      (remote.kind !== "blob" && local.documentRevision !== remote.revision)
    )
      return false;

    local.revision = remote.revision;
    local.pathRevision = remote.pathRevision;
    return true;
  }

  private async captureChangedFile(local: LocalFile): Promise<boolean> {
    const current = await this.vault.read(local.path);
    if ((await digest(current)) === local.digest) return false;
    await this.changes.capture(local.path);
    return true;
  }

  private async captureDuringFetch(
    local: LocalFile | undefined,
    remote: FileRecord,
    expected: Uint8Array | undefined,
  ): Promise<boolean> {
    if (local && (!expected || (await digest(expected)) !== local.digest)) {
      if (expected) await this.changes.capture(local.path);
      else await this.changes.delete(local.path);
      return true;
    }
    if (!local && expected && (await digest(expected)) !== remote.digest) {
      await this.changes.capture(remote.path);
      return true;
    }
    return false;
  }

  private async prepareContent(
    local: LocalFile,
    document: DocumentResponse,
  ): Promise<PreparedContent> {
    if (document.content.kind === "blob") {
      return {
        bytes: await this.api.download(document.content.blob),
        update: null,
        doc: undefined,
        wasOpen: false,
      };
    }

    const wasOpen = this.documents.get(local.id) !== undefined;
    const doc = await this.documents.open(local);
    const staged = new Y.Doc();
    Y.applyUpdate(staged, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(staged, fromBase64(document.content.update));
    const bytes = new TextEncoder().encode(staged.getText("content").toString());
    const update = toBase64(Y.encodeStateAsUpdate(staged));
    staged.destroy();
    return { bytes, update, doc, wasOpen };
  }

  private async preparePath(
    local: LocalFile,
    remote: FileRecord,
    paths: Set<string>,
    context?: ReconcileContext,
  ): Promise<boolean> {
    const candidate = context
      ? context.byPath.get(remote.path)
      : this.state.data.files.find((file) => file.path === remote.path);
    const occupant = candidate?.id !== local.id ? candidate : undefined;
    if (occupant && paths.has(remote.path)) {
      await this.protectOccupant(occupant, remote.path, paths, context);
    }
    if (local.path !== remote.path && paths.has(local.path)) {
      await this.vault.rename(local.path, remote.path);
      paths.delete(local.path);
      context?.byPath.delete(local.path);
    }
    return occupant !== undefined;
  }

  private async protectOccupant(
    occupant: LocalFile,
    path: string,
    paths: Set<string>,
    context?: ReconcileContext,
  ): Promise<void> {
    const protectedPath = conflictPath(path, crypto.randomUUID());
    await this.vault.rename(path, protectedPath);
    context?.byPath.delete(occupant.path);
    occupant.path = protectedPath;
    context?.byPath.set(protectedPath, occupant);
    paths.delete(path);
    paths.add(protectedPath);
    for (const pending of this.state.data.pending) {
      if (pending.fileId === occupant.id && "path" in pending) pending.path = protectedPath;
    }
  }

  private async saveIncoming(
    remote: FileRecord,
    document: DocumentResponse,
    content: PreparedContent,
    expected: Uint8Array | undefined,
  ): Promise<void> {
    this.state.data.incoming = {
      file: { ...remote, revision: document.file.revision },
      digest: await digest(content.bytes),
      expectedDigest: expected ? await digest(expected) : null,
      update: content.update,
    };
    await this.state.store.save(this.state.data, { key: "incoming", value: content.bytes });
  }

  private async captureInterruptedWrite(
    existing: LocalFile | undefined,
    local: LocalFile,
    remote: FileRecord,
    content: PreparedContent,
  ): Promise<void> {
    await this.state.store.save({ ...this.state.data, incoming: null });
    this.state.data.incoming = null;
    this.releaseContent(local, content);
    // The staged remote state was never applied; capture against the unchanged baseline.
    if (existing && existing.path !== remote.path) existing.path = remote.path;
    await this.changes.capture(remote.path);
  }

  private async commitReceived(
    existing: LocalFile | undefined,
    local: LocalFile,
    remote: FileRecord,
    document: DocumentResponse,
    content: PreparedContent,
    context?: ReconcileContext,
  ): Promise<void> {
    if (!existing) this.state.data.files.push(local);
    if (content.doc && document.content.kind === "text") {
      Y.applyUpdate(content.doc, fromBase64(document.content.update), "remote");
    }
    context?.byId.set(local.id, local);
    context?.byPath.set(remote.path, local);
    const materializedDigest = await digest(content.bytes);
    Object.assign(local, remote, {
      digest: materializedDigest,
      diskDigest: materializedDigest,
      documentRevision: document.file.revision,
    });
    if (remote.conflict) this.state.reportConflict(remote, "競合ファイルを同期しました");

    const receivedData = content.doc
      ? { key: `doc:${local.id}`, value: Y.encodeStateAsUpdate(content.doc) }
      : undefined;
    await this.state.store.save({ ...this.state.data, incoming: null }, receivedData);
    this.state.data.incoming = null;
  }

  private releaseContent(local: LocalFile, content: PreparedContent): void {
    if (content.doc && !content.wasOpen) this.documents.remove(local.id);
  }
}
