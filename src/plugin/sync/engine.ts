import * as Y from "yjs";

import {
  conflictPath,
  digest,
  fromBase64,
  isExcluded,
  pathSchema,
  toBase64,
  type Content,
  type DocumentResponse,
  type FileRecord,
  type Operation,
  type ServerMessage,
} from "../../shared/protocol";

import { replaceText } from "./text";
import type { LocalFile, LocalState, SyncOptions, SyncStatus } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
interface ReconcileContext {
  paths: Set<string>;
  byId: Map<string, LocalFile>;
  byPath: Map<string, LocalFile>;
}
export class SyncEngine {
  private state: LocalState = {
    initialized: false,
    incoming: null,
    attempted: [],
    files: [],
    pending: [],
    exclusions: [],
    revision: 0,
    r2Revision: 0,
    conflicts: [],
  };
  private readonly docs = new Map<string, Y.Doc>();
  private readonly references = new Map<Y.Doc, number>();
  private serial: Promise<unknown> = Promise.resolve();
  private paused = false;
  private disposed = false;
  private socket: { close(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: SyncOptions) {}
  get conflicts(): readonly FileRecord[] {
    return this.state.conflicts;
  }
  get exclusions(): readonly string[] {
    return this.state.exclusions;
  }
  private emit(phase: SyncStatus["phase"], error?: unknown): void {
    this.options.onStatus({
      phase,
      pending: this.state.pending.length,
      revision: this.state.revision,
      r2Revision: this.state.r2Revision,
      ...(error === undefined
        ? {}
        : {
            error:
              error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : "同期処理に失敗しました",
          }),
    });
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch((error: unknown) => this.emit("error", error));
    return result;
  }
  private persist(): Promise<void> {
    return this.options.store.save(this.state);
  }
  async start(): Promise<void> {
    await this.enqueue(async () => {
      this.emit("starting");
      const state = await this.options.store.load();
      if (state) this.state = state;
      await this.recoverIncoming();
      await this.scan();
    });
    await this.syncNow();
  }
  pause(): void {
    this.paused = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
    this.emit("paused");
  }
  async resume(): Promise<void> {
    this.paused = false;
    await this.syncNow();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pause();
    await this.serial;
    for (const doc of this.docs.values()) doc.destroy();
    this.options.store.close();
  }
  getDoc(path: string): Y.Doc | undefined {
    const file = this.state.files.find((file) => file.path === path);
    return file ? this.docs.get(file.id) : undefined;
  }
  ensureDoc(path: string): Promise<Y.Doc | undefined> {
    return this.enqueue(async () => {
      const file = this.state.files.find((file) => file.path === path);
      if (file?.kind !== "text") return undefined;
      const doc = await this.openDoc(file);
      this.references.set(doc, (this.references.get(doc) ?? 0) + 1);
      return doc;
    });
  }
  releaseDoc(doc: Y.Doc): void {
    void this.enqueue(async () => {
      const count = this.references.get(doc);
      if (count === undefined) return;
      if (count > 1) {
        this.references.set(doc, count - 1);
        return;
      }
      this.references.delete(doc);
      for (const [id, current] of this.docs)
        if (current === doc) {
          this.docs.delete(id);
          doc.destroy();
          break;
        }
    }).catch(() => {});
  }
  private async openDoc(file: LocalFile): Promise<Y.Doc> {
    const existing = this.docs.get(file.id);
    if (existing) return existing;
    const doc = new Y.Doc();
    const stored = await this.options.store.get(`doc:${file.id}`);
    if (stored) Y.applyUpdate(doc, stored, "remote");
    this.docs.set(file.id, doc);
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || origin === "capture") return;
      void this.enqueue(async () => {
        if (this.disposed || isExcluded(file.path, this.state.exclusions)) return;
        const bytes = encoder.encode(doc.getText("content").toString());
        await this.queueContent(file, bytes, doc);
        await this.options.vault.write(file.path, bytes);
        file.diskDigest = file.digest;
        await this.persist();
        this.schedule();
      }).catch(() => {});
    });
    return doc;
  }
  private schedule(delay = 250): void {
    if (this.disposed || this.paused) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.syncNow();
    }, delay);
  }
  capture(path: string): Promise<void> {
    return this.enqueue(async () => {
      await this.capturePath(path);
      this.schedule();
    });
  }
  captureDelete(path: string): Promise<void> {
    return this.enqueue(async () => {
      await this.deletePath(path);
      this.schedule();
    });
  }
  captureRename(oldPath: string, path: string): Promise<void> {
    return this.enqueue(async () => {
      const file = this.state.files.find((file) => file.path === oldPath);
      if (!file) {
        await this.capturePath(path);
        return;
      }
      if (isExcluded(path, this.state.exclusions)) return;
      pathSchema.parse(path);
      file.path = path;
      this.state.pending.push({
        type: "move",
        opId: crypto.randomUUID(),
        fileId: file.id,
        basePathRevision: file.pathRevision,
        path,
      });
      await this.persist();
      this.schedule();
    });
  }
  private async deletePath(path: string, known?: LocalFile): Promise<void> {
    const file = known ?? this.state.files.find((file) => file.path === path);
    if (!file || isExcluded(path, this.state.exclusions)) return;
    if (this.state.pending.some((op) => op.fileId === file.id && op.type === "delete")) return;
    this.state.pending.push({
      type: "delete",
      opId: crypto.randomUUID(),
      fileId: file.id,
      baseRevision: file.revision,
    });
    await this.persist();
  }
  private async scan(): Promise<void> {
    const paths = await this.options.vault.list();
    const byPath = new Map(this.state.files.map((file) => [file.path, file]));
    for (const path of paths) await this.capturePath(path, byPath);
    const present = new Set(paths);
    if (this.state.initialized)
      for (const file of this.state.files)
        if (!present.has(file.path)) await this.deletePath(file.path, file);
  }
  private async capturePath(path: string, byPath?: Map<string, LocalFile>): Promise<void> {
    if (isExcluded(path, this.state.exclusions)) return;
    pathSchema.parse(path);
    const bytes = await this.options.vault.read(path);
    const hash = await digest(bytes);
    let file = byPath ? byPath.get(path) : this.state.files.find((file) => file.path === path);
    if (file?.digest === hash) {
      if (file.diskDigest !== hash) {
        file.diskDigest = hash;
        await this.persist();
      }
      return;
    }
    if (
      file &&
      hash === file.diskDigest &&
      file.kind === "text" &&
      this.state.pending.some((op) => op.fileId === file?.id && "content" in op)
    ) {
      const pendingDoc = await this.openDoc(file);
      await this.options.vault.write(
        path,
        encoder.encode(pendingDoc.getText("content").toString()),
      );
      file.diskDigest = file.digest;
      await this.persist();
      return;
    }
    if (!file) {
      file = {
        id: crypto.randomUUID(),
        path,
        digest: "",
        diskDigest: hash,
        documentRevision: 0,
        kind: path.toLowerCase().endsWith(".md") ? "text" : "blob",
        revision: 0,
        pathRevision: 0,
      };
      this.state.files.push(file);
      byPath?.set(path, file);
    }
    const wasOpen = this.docs.has(file.id);
    const doc = file.kind === "text" ? await this.openDoc(file) : undefined;
    if (doc) replaceText(doc, decoder.decode(bytes), "capture");
    file.diskDigest = hash;
    await this.queueContent(file, bytes, doc);
    if (doc && !wasOpen) {
      doc.destroy();
      this.docs.delete(file.id);
    }
  }
  private async queueContent(file: LocalFile, bytes: Uint8Array, doc?: Y.Doc): Promise<void> {
    const hash = await digest(bytes);
    if (file.digest === hash) return;
    let content: Content;
    let savedData: { key: string; value: Uint8Array };
    if (doc) {
      const update = Y.encodeStateAsUpdate(doc);
      savedData = { key: `doc:${file.id}`, value: update };
      content = { kind: "text", update: toBase64(update) };
    } else {
      const key = crypto.randomUUID();
      savedData = { key: `blob:${key}`, value: bytes };
      content = { kind: "blob", blob: { key, size: bytes.length, digest: hash } };
    }
    const alreadyCreating = this.state.pending.some(
      (op) => op.fileId === file.id && op.type === "create",
    );
    const operation: Operation =
      file.revision === 0 && !alreadyCreating
        ? { type: "create", opId: crypto.randomUUID(), fileId: file.id, path: file.path, content }
        : {
            type: "edit",
            opId: crypto.randomUUID(),
            fileId: file.id,
            path: file.path,
            baseRevision: file.revision,
            content,
          };
    file.digest = hash;
    let previous: Operation | undefined;
    for (let index = this.state.pending.length - 1; index >= 0; index--) {
      const candidate = this.state.pending[index];
      if (candidate?.fileId === file.id) {
        previous = candidate;
        break;
      }
    }
    if (
      operation.type === "edit" &&
      operation.content.kind === "text" &&
      previous?.type === "edit" &&
      previous.content.kind === "text" &&
      !this.state.attempted.includes(previous.opId)
    ) {
      previous.content = operation.content;
    } else this.state.pending.push(operation);
    await this.options.store.save(this.state, savedData);
    this.emit(this.paused ? "paused" : "syncing");
  }
  syncNow(): Promise<void> {
    return this.enqueue(async () => {
      if (this.paused || this.disposed) return;
      clearTimeout(this.timer);
      this.emit("syncing");
      try {
        await this.recoverIncoming();
        if (!this.socket)
          this.socket = await this.options.api.connect(
            (message) => this.receive(message),
            () => {
              this.socket = undefined;
              this.schedule(2000);
            },
          );
        let snapshot = await this.options.api.snapshot();
        this.state.exclusions = snapshot.exclusions;
        if (!this.state.initialized) {
          const remoteByPath = new Map(snapshot.files.map((file) => [file.path, file]));
          const collisions = this.state.files.filter((local) => {
            const remote = remoteByPath.get(local.path);
            return remote && remote.digest !== local.digest;
          });
          if (
            collisions.length &&
            !(await this.options.confirmInitial(collisions.map((file) => file.path)))
          ) {
            this.pause();
            return;
          }
          for (const local of this.state.files) {
            const remote = remoteByPath.get(local.path);
            if (remote && remote.digest === local.digest) {
              this.state.pending = this.state.pending.filter(
                (operation) => operation.fileId !== local.id,
              );
              this.state.files = this.state.files.filter((file) => file.id !== local.id);
              this.docs.get(local.id)?.destroy();
              this.docs.delete(local.id);
              await this.acceptRemote(remote);
            }
          }
          this.state.initialized = true;
          await this.persist();
        }
        for (const operation of this.state.pending) {
          const local = this.state.files.find((file) => file.id === operation.fileId);
          if (local && isExcluded(local.path, this.state.exclusions)) continue;
          if ("content" in operation && operation.content.kind === "blob") {
            const blob = operation.content.blob;
            const bytes = await this.options.store.get(`blob:${blob.key}`);
            if (!bytes) throw new Error("未送信の添付データがありません");
            await this.options.api.upload(blob.key, bytes, blob.digest);
          }
          if (!this.state.attempted.includes(operation.opId)) {
            this.state.attempted.push(operation.opId);
            await this.persist();
          }
          const result = await this.options.api.operate(operation);
          if (result.opId !== operation.opId) throw new Error("操作応答の ID が一致しません");
          this.state.pending = this.state.pending.filter(
            (pending) => pending.opId !== operation.opId,
          );
          this.state.attempted = this.state.attempted.filter((id) => id !== operation.opId);
          if (result.conflict && result.file)
            this.reportConflict(result.file, result.message ?? "競合内容を別名で保護しました");
          let acknowledgedData: { key: string; value: Uint8Array } | undefined;
          if (result.file && local) {
            // Keep local content and path until the entire outbox has drained.
            for (const pending of this.state.pending) {
              if (pending.fileId !== local.id) continue;
              if (
                "baseRevision" in pending &&
                (pending.baseRevision === result.previousRevision ||
                  (operation.type === "create" &&
                    result.previousRevision === null &&
                    pending.baseRevision === 0))
              )
                pending.baseRevision = result.file.revision;
              if (
                (operation.type === "move" || operation.type === "create") &&
                !result.conflict &&
                "basePathRevision" in pending &&
                (pending.basePathRevision === result.previousPathRevision ||
                  (operation.type === "create" &&
                    result.previousPathRevision === null &&
                    pending.basePathRevision === 0))
              )
                pending.basePathRevision = result.file.pathRevision;
            }
            local.revision = result.file.revision;
            local.pathRevision = result.file.pathRevision;
            if (result.file.id !== local.id) {
              const oldId = local.id;
              local.id = result.file.id;
              for (const pending of this.state.pending)
                if (pending.fileId === oldId) pending.fileId = local.id;
              const doc = this.docs.get(oldId);
              if (doc) {
                this.docs.delete(oldId);
                this.docs.set(local.id, doc);
                acknowledgedData = { key: `doc:${local.id}`, value: Y.encodeStateAsUpdate(doc) };
              } else if (local.kind === "text") {
                const stored = await this.options.store.get(`doc:${oldId}`);
                if (!stored) throw new Error("競合ノートのローカル CRDT 状態がありません");
                acknowledgedData = { key: `doc:${local.id}`, value: stored };
              }
            }
          }
          await this.options.store.save(this.state, acknowledgedData);
          if ("content" in operation && operation.content.kind === "blob")
            await this.options.store.delete(`blob:${operation.content.blob.key}`);
        }
        snapshot = await this.options.api.snapshot();
        const context: ReconcileContext = {
          paths: new Set(await this.options.vault.list()),
          byId: new Map(this.state.files.map((file) => [file.id, file])),
          byPath: new Map(this.state.files.map((file) => [file.path, file])),
        };
        const pendingIds = new Set(this.state.pending.map((op) => op.fileId));
        const remoteIds = new Set(snapshot.files.map((file) => file.id));
        for (const remote of snapshot.files) {
          if (isExcluded(remote.path, snapshot.exclusions) || pendingIds.has(remote.id)) continue;
          await this.acceptRemote(remote, undefined, context);
        }
        for (const local of this.state.files) {
          if (
            remoteIds.has(local.id) ||
            isExcluded(local.path, snapshot.exclusions) ||
            pendingIds.has(local.id)
          )
            continue;
          if (context.paths.has(local.path)) {
            if ((await digest(await this.options.vault.read(local.path))) !== local.digest) {
              await this.capturePath(local.path);
              continue;
            }
            await this.options.vault.remove(local.path);
          }
          this.state.files = this.state.files.filter((file) => file.id !== local.id);
          this.docs.get(local.id)?.destroy();
          this.docs.delete(local.id);
          await this.options.store.delete(`doc:${local.id}`);
        }
        this.state.revision = snapshot.revision;
        this.state.r2Revision = snapshot.r2Revision;
        await this.persist();
        this.emit(
          this.state.pending.length
            ? "syncing"
            : snapshot.r2Revision < snapshot.revision
              ? "r2-pending"
              : "synced",
        );
        this.schedule(10_000);
      } catch (error) {
        this.emit("offline", error);
        this.schedule(5000);
      }
    });
  }
  private reportConflict(file: FileRecord, message: string): void {
    if (!this.state.conflicts.some((entry) => entry.id === file.id)) {
      this.state.conflicts.push(file);
      this.options.onConflict(file, message);
    }
  }
  private async acceptRemote(
    remote: FileRecord,
    fetched?: DocumentResponse,
    context?: ReconcileContext,
  ): Promise<void> {
    let local = context
      ? context.byId.get(remote.id)
      : this.state.files.find((file) => file.id === remote.id);
    const paths = context?.paths ?? new Set(await this.options.vault.list());
    if (
      local?.digest === remote.digest &&
      local.path === remote.path &&
      (remote.kind === "blob" || local.documentRevision === remote.revision)
    ) {
      local.revision = remote.revision;
      local.pathRevision = remote.pathRevision;
      return;
    }
    if (local && paths.has(local.path)) {
      const current = await this.options.vault.read(local.path);
      if ((await digest(current)) !== local.digest) {
        await this.capturePath(local.path);
        return;
      }
    }
    const document = fetched ?? (await this.options.api.document(remote.id));
    const previousLocal = local;
    const sourcePath = local?.path ?? remote.path;
    const present = new Set(await this.options.vault.list());
    const expected = present.has(sourcePath)
      ? await this.options.vault.read(sourcePath)
      : undefined;
    if (local && (!expected || (await digest(expected)) !== local.digest)) {
      if (expected) await this.capturePath(sourcePath);
      else await this.deletePath(sourcePath);
      return;
    }
    if (!local && expected && (await digest(expected)) !== remote.digest) {
      await this.capturePath(sourcePath);
      return;
    }
    let bytes: Uint8Array;
    let incomingUpdate: string | null = null;
    let targetDoc: Y.Doc | undefined;
    let wasOpen = false;
    if (!local) local = { ...remote, diskDigest: remote.digest, documentRevision: 0 };
    if (document.content.kind === "text") {
      wasOpen = this.docs.has(local.id);
      targetDoc = await this.openDoc(local);
      const staged = new Y.Doc();
      Y.applyUpdate(staged, Y.encodeStateAsUpdate(targetDoc));
      Y.applyUpdate(staged, fromBase64(document.content.update));
      bytes = encoder.encode(staged.getText("content").toString());
      incomingUpdate = toBase64(Y.encodeStateAsUpdate(staged));
      staged.destroy();
    } else bytes = await this.options.api.download(document.content.blob);
    // A path can be occupied by an independent local file; preserve it before writing.
    const candidate = context
      ? context.byPath.get(remote.path)
      : this.state.files.find((file) => file.path === remote.path);
    const occupant = candidate?.id !== local.id ? candidate : undefined;
    if (occupant && paths.has(remote.path)) {
      const protectedPath = conflictPath(remote.path, crypto.randomUUID());
      await this.options.vault.rename(remote.path, protectedPath);
      context?.byPath.delete(occupant.path);
      occupant.path = protectedPath;
      context?.byPath.set(protectedPath, occupant);
      paths.delete(remote.path);
      paths.add(protectedPath);
      for (const pending of this.state.pending)
        if (pending.fileId === occupant.id && "path" in pending) pending.path = protectedPath;
    }
    if (local.path !== remote.path && paths.has(local.path)) {
      await this.options.vault.rename(local.path, remote.path);
      paths.delete(local.path);
      context?.byPath.delete(local.path);
    }
    const expectedAtTarget = occupant ? undefined : expected;
    this.state.incoming = {
      file: { ...remote, revision: document.file.revision },
      digest: await digest(bytes),
      expectedDigest: expectedAtTarget ? await digest(expectedAtTarget) : null,
      update: incomingUpdate,
    };
    await this.options.store.save(this.state, { key: "incoming", value: bytes });
    const written = await this.options.vault.writeIfUnchanged(remote.path, expectedAtTarget, bytes);
    if (!written) {
      await this.options.store.save({ ...this.state, incoming: null });
      this.state.incoming = null;
      if (targetDoc && !wasOpen) {
        targetDoc.destroy();
        this.docs.delete(local.id);
      }
      // Capture against the unchanged baseline; the staged remote state was never applied.
      if (previousLocal && previousLocal.path !== remote.path) previousLocal.path = remote.path;
      await this.capturePath(remote.path);
      return;
    }
    if (!previousLocal) this.state.files.push(local);
    if (targetDoc && document.content.kind === "text") {
      Y.applyUpdate(targetDoc, fromBase64(document.content.update), "remote");
    }
    paths.add(remote.path);
    context?.byId.set(local.id, local);
    context?.byPath.set(remote.path, local);
    const materializedDigest = await digest(bytes);
    Object.assign(local, remote, {
      digest: materializedDigest,
      diskDigest: materializedDigest,
      documentRevision: document.file.revision,
    });
    if (remote.conflict) this.reportConflict(remote, "競合ファイルを同期しました");
    const receivedData = targetDoc
      ? { key: `doc:${local.id}`, value: Y.encodeStateAsUpdate(targetDoc) }
      : undefined;
    await this.options.store.save({ ...this.state, incoming: null }, receivedData);
    this.state.incoming = null;
    if (targetDoc && !wasOpen) {
      targetDoc.destroy();
      this.docs.delete(local.id);
    }
  }
  private async recoverIncoming(): Promise<void> {
    const incoming = this.state.incoming;
    if (!incoming) return;
    const path = incoming.file.path;
    const paths = new Set(await this.options.vault.list());
    const current = paths.has(path) ? await this.options.vault.read(path) : undefined;
    const currentDigest = current ? await digest(current) : null;
    if (!current && incoming.expectedDigest !== null) {
      const received = await this.options.store.get("incoming");
      if (!received) throw new Error("受信中のファイルデータがありません");
      const recoveryPath = conflictPath(path, crypto.randomUUID());
      await this.options.vault.write(recoveryPath, received);
      await this.capturePath(recoveryPath);
      const recovered = this.state.files.find((file) => file.path === recoveryPath)!;
      this.reportConflict(
        { ...incoming.file, ...recovered, size: received.length, conflict: true },
        "削除と競合した受信内容を復旧コピーへ保護しました",
      );
      if (
        !this.state.pending.some(
          (operation) => operation.fileId === incoming.file.id && operation.type === "delete",
        )
      ) {
        this.state.pending.push({
          type: "delete",
          opId: crypto.randomUUID(),
          fileId: incoming.file.id,
          baseRevision: incoming.file.revision,
        });
      }
      await this.options.store.save({ ...this.state, incoming: null });
      this.state.incoming = null;
      return;
    }
    if (currentDigest === incoming.expectedDigest) {
      await this.options.store.save({ ...this.state, incoming: null });
      this.state.incoming = null;
      return;
    }
    if (currentDigest !== incoming.digest) {
      if (current) {
        const recoveryPath = conflictPath(path, crypto.randomUUID());
        await this.options.vault.write(recoveryPath, current);
        await this.capturePath(recoveryPath);
        const recovered = this.state.files.find((file) => file.path === recoveryPath)!;
        this.reportConflict(
          { ...incoming.file, ...recovered, size: current.length, conflict: true },
          "中断中に変更された内容を復旧コピーへ保護しました",
        );
      }
      const received = await this.options.store.get("incoming");
      if (!received) throw new Error("受信中のファイルデータがありません");
      if (!(await this.options.vault.writeIfUnchanged(path, current, received)))
        throw new Error("受信回復中にファイルが変更されました。再試行します");
    }
    let local = this.state.files.find((file) => file.id === incoming.file.id);
    if (!local) {
      local = {
        ...incoming.file,
        digest: incoming.digest,
        diskDigest: incoming.digest,
        documentRevision: incoming.file.revision,
      };
      this.state.files.push(local);
    } else
      Object.assign(local, incoming.file, {
        digest: incoming.digest,
        diskDigest: incoming.digest,
        documentRevision: incoming.file.revision,
      });
    const data = incoming.update
      ? { key: `doc:${local.id}`, value: fromBase64(incoming.update) }
      : undefined;
    await this.options.store.save({ ...this.state, incoming: null }, data);
    this.state.incoming = null;
    if (data) {
      const doc = this.docs.get(local.id);
      if (doc) Y.applyUpdate(doc, data.value, "remote");
    }
  }
  private receive(message: ServerMessage): void {
    if (message.type === "error") {
      this.emit("error", message.message);
      return;
    }
    if (message.type === "changed" || message.type === "text") {
      void this.enqueue(async () => {
        if (this.paused || this.disposed) return;
        if (this.state.pending.some((op) => op.fileId === message.fileId)) {
          this.schedule();
          return;
        }
        try {
          const document = await this.options.api.document(message.fileId);
          if (!isExcluded(document.file.path, this.state.exclusions))
            await this.acceptRemote(document.file, document);
          this.state.revision = Math.max(this.state.revision, message.revision);
          await this.persist();
          this.emit("r2-pending");
        } catch {
          this.schedule(100);
        }
      }).catch(() => {});
      return;
    }
    if (message.type === "r2") {
      void this.enqueue(async () => {
        this.state.r2Revision = Math.max(this.state.r2Revision, message.revision);
        await this.persist();
        this.emit(
          this.state.pending.length
            ? "syncing"
            : this.state.r2Revision < this.state.revision
              ? "r2-pending"
              : "synced",
        );
      }).catch(() => {});
    } else this.schedule(100);
  }
}
