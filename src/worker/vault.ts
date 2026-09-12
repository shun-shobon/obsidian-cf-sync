import * as Y from "yjs";
import { z } from "zod";

import {
  conflictPath,
  digest,
  fromBase64,
  idSchema,
  isExcluded,
  operationSchema,
  pathSchema,
  toBase64,
  type BlobRef,
  type Content,
  type FileRecord,
  type Operation,
  type OperationResult,
  type ServerMessage,
} from "../shared/protocol";

import { handleErrors, HttpError, json, type Env } from "./env";
interface Meta {
  revision: number;
  r2Revision: number;
  exclusions: string[];
  vaultId: string;
}
interface Stored {
  file: FileRecord;
  blob?: BlobRef;
  chunks: number;
}
interface Ticket {
  deviceId: string;
  expiresAt: number;
}
export class Vault {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async meta(): Promise<Meta> {
    const meta = await this.state.storage.get<Meta>("meta");
    if (!meta) throw new HttpError(404, "Vault not initialized");
    return meta;
  }
  private async files(): Promise<Stored[]> {
    return [...(await this.state.storage.list<Stored>({ prefix: "file:" })).values()];
  }
  private async content(stored: Stored): Promise<Content> {
    if (stored.file.kind === "blob") {
      if (!stored.blob) throw new Error("Missing blob");
      return { kind: "blob", blob: stored.blob };
    }
    const chunks = await Promise.all(
      Array.from({ length: stored.chunks }, (_, n) =>
        this.state.storage.get<Uint8Array>(`text:${stored.file.id}:${n}`),
      ),
    );
    if (chunks.some((chunk) => !chunk)) throw new Error("Missing CRDT chunk");
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk!.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk!, offset);
      offset += chunk!.length;
    }
    return { kind: "text", update: toBase64(bytes) };
  }
  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = ws.deserializeAttachment() as { expiresAt: number };
      if (attachment.expiresAt <= Date.now()) {
        ws.close(4001, "Reconnect with a fresh ticket");
        continue;
      }
      try {
        ws.send(data);
      } catch {
        ws.close(1011, "Notification failed");
      }
    }
  }
  private async schedule(): Promise<void> {
    const alarm = await this.state.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 10000)
      await this.state.storage.setAlarm(Date.now() + 10000);
  }
  fetch(request: Request): Promise<Response> {
    return this.serial(() => handleErrors(() => this.route(request)));
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/revoke") {
      const { deviceId } = z.object({ deviceId: idSchema }).parse(await request.json());
      await this.state.storage.put(`revoked:${deviceId}`, true);
      for (const ws of this.state.getWebSockets(deviceId)) ws.close(4003, "Device revoked");
      return json({ ok: true });
    }
    const vaultId = idSchema.parse(request.headers.get("X-Vault-Id"));
    if (!(await this.state.storage.get("meta")))
      await this.state.storage.put("meta", {
        revision: 0,
        r2Revision: 0,
        exclusions: [],
        vaultId,
      } satisfies Meta);
    const meta = await this.meta();
    if (meta.vaultId !== vaultId) throw new HttpError(403, "Vault mismatch");
    if (url.pathname === "/ws") return this.connect(url, request);
    const deviceId = idSchema.parse(request.headers.get("X-Device-Id"));
    if (await this.state.storage.get(`revoked:${deviceId}`))
      throw new HttpError(403, "Device revoked");
    if (url.pathname === "/snapshot")
      return json({ ...meta, files: (await this.files()).map((item) => item.file) });
    if (url.pathname === "/operations" && request.method === "POST")
      return json(await this.operation(operationSchema.parse(await request.json()), deviceId));
    const document = /^\/files\/([^/]+)$/.exec(url.pathname);
    if (document && request.method === "GET") {
      const stored = await this.state.storage.get<Stored>(`file:${idSchema.parse(document[1])}`);
      if (!stored) throw new HttpError(404, "File not found");
      return json({ file: stored.file, content: await this.content(stored) });
    }
    if (url.pathname === "/exclusions" && request.method === "PUT") {
      const { exclusions } = z
        .object({ exclusions: z.array(pathSchema).max(1000) })
        .parse(await request.json());
      meta.exclusions = [...new Set(exclusions)];
      meta.revision++;
      await this.state.storage.transaction(async (tx) => {
        await tx.put("meta", meta);
        if ((await tx.getAlarm()) === null) await tx.setAlarm(Date.now() + 10000);
        for (const item of await this.files())
          if (!isExcluded(item.file.path, exclusions))
            await tx.put(`dirty:${item.file.path}`, true);
      });
      await this.schedule();
      this.broadcast({ type: "settings", revision: meta.revision });
      return json({ ...meta, files: (await this.files()).map((item) => item.file) });
    }
    if (url.pathname === "/tickets" && request.method === "POST") {
      const secret = crypto.randomUUID() + crypto.randomUUID();
      const expiresAt = Date.now() + 30000;
      await this.state.storage.put(`ticket:${await digest(new TextEncoder().encode(secret))}`, {
        deviceId,
        expiresAt,
      } satisfies Ticket);
      await this.schedule();
      return json({ ticket: secret, expiresAt });
    }
    const blobMatch = /^\/blobs\/([^/]+)$/.exec(url.pathname);
    if (blobMatch) {
      const key = idSchema.parse(blobMatch[1]);
      const r2Key = `staging/${vaultId}/${key}`;
      if (request.method === "GET") {
        const object = await this.env.BUCKET.get(r2Key);
        if (!object) throw new HttpError(404, "Blob not found");
        return new Response(object.body, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      if (request.method === "PUT") {
        const expected = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(request.headers.get("X-Content-Digest"));
        // R2 verifies streamed content before committing the immutable object.
        const previous = await this.env.BUCKET.head(r2Key);
        if (previous) {
          if (previous.customMetadata?.["digest"] !== expected)
            throw new HttpError(409, "Blob id reused with different content");
          return json({ key, size: previous.size, digest: expected });
        }
        if (!request.body) throw new HttpError(400, "Missing body");
        const abort = new AbortController();
        try {
          const length = z.coerce
            .number()
            .int()
            .nonnegative()
            .safe()
            .parse(request.headers.get("X-Content-Size"));
          if (!request.headers.has("X-Content-Size"))
            throw new HttpError(411, "X-Content-Size required");
          const stream = new FixedLengthStream(length);
          const writing = request.body.pipeTo(stream.writable, { signal: abort.signal });
          const [object] = await Promise.all([
            this.env.BUCKET.put(r2Key, stream.readable, {
              sha256: expected,
              customMetadata: { digest: expected },
            }),
            writing,
          ]);
          if (!object) throw new Error("Blob write failed");
          await this.schedule();
          return json({ key, size: object.size, digest: expected });
        } catch (error) {
          abort.abort(error);
          if (error instanceof HttpError) throw error;
          console.error(error);
          throw new HttpError(400, "Blob upload failed; verify digest and request size");
        }
      }
    }
    throw new HttpError(404, "Not found");
  }
  private async connect(url: URL, request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      throw new HttpError(426, "WebSocket upgrade required");
    const secret = url.searchParams.get("ticket");
    if (!secret || secret.length > 200) throw new HttpError(401, "Invalid ticket");
    const key = `ticket:${await digest(new TextEncoder().encode(secret))}`;
    const ticket = await this.state.storage.get<Ticket>(key);
    await this.state.storage.delete(key);
    if (
      !ticket ||
      ticket.expiresAt <= Date.now() ||
      (await this.state.storage.get(`revoked:${ticket.deviceId}`))
    )
      throw new HttpError(401, "Expired or consumed ticket");
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [ticket.deviceId]);
    pair[1].serializeAttachment({ expiresAt: Date.now() + 15 * 60 * 1000 - 10000 });
    await this.schedule();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws: WebSocket): Promise<void> {
    ws.close(1008, "Use authenticated HTTP for operations");
  }
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code);
  }
  private collision(path: string, files: Stored[], except?: string): boolean {
    const key = path.normalize("NFC").toLowerCase();
    return files.some(
      ({ file }) =>
        file.id !== except &&
        (() => {
          const other = file.path.normalize("NFC").toLowerCase();
          return other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`);
        })(),
    );
  }
  private uniquePath(path: string, files: Stored[], id: string): string {
    let candidate = conflictPath(path, id);
    // A colliding parent file cannot become a directory; keep the protected copy at vault root.
    if (this.collision(candidate, files))
      candidate = conflictPath(path.slice(path.lastIndexOf("/") + 1), id);
    if (this.collision(candidate, files) || !pathSchema.safeParse(candidate).success)
      throw new HttpError(409, "Cannot allocate conflict path");
    return candidate;
  }
  private async operation(op: Operation, deviceId: string): Promise<OperationResult> {
    const prior = await this.state.storage.get<OperationResult>(`op:${op.opId}`);
    if (prior) return prior;
    const meta = await this.meta();
    const files = await this.files();
    const current = files.find((item) => item.file.id === op.fileId);
    if (
      (current && isExcluded(current.file.path, meta.exclusions)) ||
      ("path" in op && isExcluded(op.path, meta.exclusions))
    )
      throw new HttpError(409, "Path is excluded");
    let conflict = false;
    let message: string | undefined;
    let resultFile: FileRecord | null = null;
    const writes: { stored: Stored; update?: Uint8Array }[] = [];
    const dirty = new Set<string>();
    let remove = false;
    if (op.type === "move") {
      if (!current) throw new HttpError(404, "File not found");
      if (
        current.file.pathRevision !== op.basePathRevision ||
        this.collision(op.path, files, op.fileId)
      ) {
        conflict = true;
        message = "Move rejected: path changed or destination occupied";
        resultFile = current.file;
      } else {
        meta.revision++;
        dirty.add(current.file.path);
        dirty.add(op.path);
        resultFile = {
          ...current.file,
          path: op.path,
          pathRevision: meta.revision,
          revision: meta.revision,
        };
        writes.push({ stored: { ...current, file: resultFile } });
      }
    } else if (op.type === "delete") {
      if (current) {
        meta.revision++;
        remove = true;
        dirty.add(current.file.path);
        if (op.baseRevision !== current.file.revision) {
          conflict = true;
          const id = crypto.randomUUID();
          const file = {
            ...current.file,
            id,
            path: this.uniquePath(current.file.path, files, id),
            revision: meta.revision,
            pathRevision: meta.revision,
            conflict: true,
          };
          const content = await this.content(current);
          writes.push({
            stored: { ...current, file },
            ...(content.kind === "text" ? { update: fromBase64(content.update) } : {}),
          });
          dirty.add(file.path);
          resultFile = file;
          message = "Concurrent edit preserved before deletion";
        }
      }
    } else {
      if (op.type === "create" && current) throw new HttpError(409, "File id already exists");
      let id = op.fileId;
      let path = current ? current.file.path : op.path;
      let merge = op.type === "edit" && !!current;
      if (
        (op.type === "edit" && !current) ||
        (current &&
          op.type === "edit" &&
          (current.file.kind !== op.content.kind ||
            (op.content.kind === "blob" && op.baseRevision !== current.file.revision))) ||
        (!current && this.collision(path, files))
      ) {
        conflict = true;
        id = crypto.randomUUID();
        path = this.uniquePath(path, files, id);
        merge = false;
        message = "Concurrent contents preserved as conflict copy";
      }
      meta.revision++;
      let bytes: Uint8Array | undefined;
      let size: number;
      let hash: string;
      let blob: BlobRef | undefined;
      if (op.content.kind === "text") {
        const doc = new Y.Doc();
        try {
          if (merge && current) {
            const content = await this.content(current);
            if (content.kind !== "text") throw new Error("Kind mismatch");
            Y.applyUpdate(doc, fromBase64(content.update));
          }
          Y.applyUpdate(doc, fromBase64(op.content.update));
          bytes = Y.encodeStateAsUpdate(doc);
          const plain = new TextEncoder().encode(doc.getText("content").toJSON());
          size = plain.length;
          hash = await digest(plain);
        } catch {
          throw new HttpError(400, "Invalid Yjs update");
        } finally {
          doc.destroy();
        }
      } else {
        blob = op.content.blob;
        const object = await this.env.BUCKET.head(`staging/${meta.vaultId}/${blob.key}`);
        if (
          !object ||
          object.size !== blob.size ||
          object.customMetadata?.["digest"] !== blob.digest
        )
          throw new HttpError(400, "Blob is missing or does not match");
        size = blob.size;
        hash = blob.digest;
      }
      resultFile = {
        id,
        path,
        kind: op.content.kind,
        revision: meta.revision,
        pathRevision: merge && current ? current.file.pathRevision : meta.revision,
        digest: hash,
        size,
        conflict: conflict || (merge && !!current?.file.conflict),
      };
      writes.push({
        stored: {
          file: resultFile,
          chunks: bytes ? Math.ceil(bytes.length / 64000) : 0,
          ...(blob ? { blob } : {}),
        },
        ...(bytes ? { update: bytes } : {}),
      });
      dirty.add(path);
    }
    const result: OperationResult = {
      opId: op.opId,
      revision: meta.revision,
      previousRevision: current?.file.revision ?? null,
      previousPathRevision: current?.file.pathRevision ?? null,
      file: resultFile,
      conflict,
      ...(message ? { message } : {}),
    };
    await this.state.storage.transaction(async (tx) => {
      await tx.put("meta", meta);
      if ((await tx.getAlarm()) === null) await tx.setAlarm(Date.now() + 10000);
      if (remove && current) {
        await tx.delete(`file:${current.file.id}`);
        for (let n = 0; n < current.chunks; n++) await tx.delete(`text:${current.file.id}:${n}`);
      }
      for (const { stored, update } of writes) {
        await tx.put(`file:${stored.file.id}`, stored);
        if (update) {
          for (let n = 0; n < stored.chunks; n++)
            await tx.put(`text:${stored.file.id}:${n}`, update.slice(n * 64000, (n + 1) * 64000));
          const old = files.find((entry) => entry.file.id === stored.file.id);
          if (old)
            for (let n = stored.chunks; n < old.chunks; n++)
              await tx.delete(`text:${stored.file.id}:${n}`);
        }
      }
      for (const path of dirty) await tx.put(`dirty:${path}`, true);
      await tx.put(`op:${op.opId}`, result);
    });
    await this.schedule();
    this.broadcast({ type: "changed", revision: meta.revision, fileId: op.fileId });
    if (resultFile && resultFile.id !== op.fileId)
      this.broadcast({ type: "changed", revision: meta.revision, fileId: resultFile.id });
    // Full document state travels over HTTP; websocket notifications stay small even for large notes.
    void deviceId;
    return result;
  }
  alarm(): Promise<void> {
    return this.serial(async () => {
      try {
        const tickets = await this.state.storage.list<Ticket>({ prefix: "ticket:" });
        for (const [key, ticket] of tickets)
          if (ticket.expiresAt <= Date.now()) await this.state.storage.delete(key);
        for (const ws of this.state.getWebSockets()) {
          const attachment = ws.deserializeAttachment() as { expiresAt: number };
          if (attachment.expiresAt <= Date.now()) ws.close(4001, "Reconnect with a fresh ticket");
        }
        const meta = await this.meta();
        const files = await this.files();
        const dirty = await this.state.storage.list<boolean>({ prefix: "dirty:" });
        const paths = [...dirty.keys()].map((key) => key.slice(6));
        // Complete all writes before deletes so a failed rename never loses the previous R2 copy.
        for (const path of paths) {
          const stored = files.find((item) => item.file.path === path);
          if (!stored || isExcluded(path, meta.exclusions)) continue;
          const content = await this.content(stored);
          let body: Uint8Array | ReadableStream;
          if (content.kind === "text") {
            const doc = new Y.Doc();
            try {
              Y.applyUpdate(doc, fromBase64(content.update));
              body = new TextEncoder().encode(doc.getText("content").toJSON());
            } finally {
              doc.destroy();
            }
          } else {
            const object = await this.env.BUCKET.get(`staging/${meta.vaultId}/${content.blob.key}`);
            if (!object) throw new Error("Missing staged blob");
            body = object.body;
          }
          await this.env.BUCKET.put(`vaults/${meta.vaultId}/files/${path}`, body);
        }
        for (const path of paths)
          if (!files.some((item) => item.file.path === path) && !isExcluded(path, meta.exclusions))
            await this.env.BUCKET.delete(`vaults/${meta.vaultId}/files/${path}`);
        meta.r2Revision = meta.revision;
        await this.state.storage.transaction(async (tx) => {
          await tx.put("meta", meta);
          for (const key of dirty.keys()) await tx.delete(key);
        });
        this.broadcast({ type: "r2", revision: meta.r2Revision });
        const referenced = new Set(files.flatMap((item) => (item.blob ? [item.blob.key] : [])));
        let cursor: string | undefined;
        do {
          const listing = await this.env.BUCKET.list({
            prefix: `staging/${meta.vaultId}/`,
            ...(cursor ? { cursor } : {}),
          });
          for (const object of listing.objects) {
            const key = object.key.slice(object.key.lastIndexOf("/") + 1);
            if (!referenced.has(key) && object.uploaded.getTime() < Date.now() - 86400000)
              await this.env.BUCKET.delete(object.key);
          }
          cursor = listing.truncated ? listing.cursor : undefined;
        } while (cursor);
      } finally {
        if (
          (await this.state.storage.list({ prefix: "dirty:", limit: 1 })).size ||
          this.state.getWebSockets().length ||
          (await this.state.storage.list({ prefix: "ticket:", limit: 1 })).size
        )
          await this.state.storage.setAlarm(Date.now() + 10000);
        else await this.state.storage.setAlarm(Date.now() + 86400000);
      }
    });
  }
}
