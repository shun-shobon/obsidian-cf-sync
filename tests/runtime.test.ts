import { mkdtemp, rm } from "node:fs/promises";

import "fake-indexeddb/auto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  digest,
  type Operation,
  type Snapshot,
  type DocumentResponse,
  type BlobRef,
} from "@cf-sync/protocol";
import { build } from "esbuild";
import { toUint8Array, fromUint8Array } from "js-base64";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { apply, deviceId, document, request, vaultId } from "./helpers/runtime-api";
import { createRuntimeClient } from "./helpers/runtime-client";

let script: string;
beforeAll(async () => {
  const built = await build({
    entryPoints: ["tests/fixtures/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  script = built.outputFiles[0]!.text;
});
const runtimes: Miniflare[] = [];
const folders: string[] = [];
afterAll(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});
async function start(folder?: string) {
  const storage = folder ?? (await mkdtemp(join(tmpdir(), "cf-sync-test-")));
  if (!folder) folders.push(storage);
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    durableObjects: {
      VAULTS: { className: "TestVault", useSQLite: true },
      ACCOUNT: { className: "Account", useSQLite: true },
    },
    r2Buckets: ["BUCKET"],
    durableObjectsPersist: join(storage, "do"),
    r2Persist: join(storage, "r2"),
  });
  runtimes.push(mf);
  return { mf, storage };
}
function textUpdate(text: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const update = fromUint8Array(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return update;
}
function plain(content: DocumentResponse) {
  if (content.content.kind !== "text") throw new Error("not text");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, toUint8Array(content.content.update));
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

describe("Durable Object and R2 runtime integration", () => {
  it("persists accepted operations across restart and flushes ordinary files", async () => {
    const { mf, storage } = await start();
    const id = crypto.randomUUID();
    const op: Operation = {
      type: "create",
      opId: crypto.randomUUID(),
      fileId: id,
      path: "日記/ノート.md",
      content: { kind: "text", update: textUpdate("日本語のノート") },
    };
    const first = await apply(mf, op);
    expect((await apply(mf, op)).revision).toBe(first.revision);
    expect(plain(await document(mf, id))).toBe("日本語のノート");
    expect((await request(mf, "/flush")).status).toBe(200);
    const bucket = await mf.getR2Bucket("BUCKET");
    expect(await (await bucket.get(`vaults/${vaultId}/files/日記/ノート.md`))!.text()).toBe(
      "日本語のノート",
    );
    await mf.dispose();
    runtimes.splice(runtimes.indexOf(mf), 1);
    const restarted = (await start(storage)).mf;
    expect((await apply(restarted, op)).revision).toBe(first.revision);
    expect(plain(await document(restarted, id))).toBe("日本語のノート");
  });
  it("merges concurrent edits, protects deletion races and preserves colliding files", async () => {
    const { mf } = await start();
    const id = crypto.randomUUID();
    const base = await apply(mf, {
      type: "create",
      opId: crypto.randomUUID(),
      fileId: id,
      path: "note.md",
      content: { kind: "text", update: textUpdate("base") },
    });
    const current = await document(mf, id);
    if (current.content.kind !== "text") throw new Error("not text");
    const left = new Y.Doc(),
      right = new Y.Doc();
    for (const doc of [left, right]) Y.applyUpdate(doc, toUint8Array(current.content.update));
    left.getText("content").insert(0, "L");
    right.getText("content").insert(4, "R");
    for (const doc of [left, right])
      await apply(mf, {
        type: "edit",
        opId: crypto.randomUUID(),
        fileId: id,
        path: "note.md",
        baseRevision: base.revision,
        content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(doc)) },
      });
    expect(plain(await document(mf, id))).toBe("LbaseR");
    const removed = await apply(mf, {
      type: "delete",
      opId: crypto.randomUUID(),
      fileId: id,
      baseRevision: base.revision,
    });
    expect(removed.conflict).toBe(true);
    expect(removed.file).not.toBeNull();
    expect(plain(await document(mf, removed.file!.id))).toBe("LbaseR");
    expect((await request(mf, `/files/${id}`)).status).toBe(404);
    const recovered = await apply(mf, {
      type: "edit",
      opId: crypto.randomUUID(),
      fileId: id,
      path: "note.md",
      baseRevision: base.revision,
      content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(left)) },
    });
    expect(recovered.conflict).toBe(true);
    await apply(mf, {
      type: "create",
      opId: crypto.randomUUID(),
      fileId: crypto.randomUUID(),
      path: "image.canvas",
      content: { kind: "text", update: textUpdate("one") },
    });
    const collision = await apply(mf, {
      type: "create",
      opId: crypto.randomUUID(),
      fileId: crypto.randomUUID(),
      path: "IMAGE.canvas",
      content: { kind: "text", update: textUpdate("two") },
    });
    expect(collision.conflict).toBe(true);
    left.destroy();
    right.destroy();
  });
  it("streams attachment bytes and retains excluded R2 files", async () => {
    const { mf } = await start();
    const bytes = new Uint8Array(20 * 1024 * 1024).fill(123),
      key = crypto.randomUUID(),
      hash = await digest(bytes);
    const uploaded = await mf.dispatchFetch(`https://test/blobs/${key}`, {
      method: "PUT",
      headers: {
        "X-Vault-Id": vaultId,
        "X-Device-Id": deviceId,
        "X-Content-Digest": hash,
        "X-Content-Size": String(bytes.length),
      },
      body: bytes,
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const blob = (await uploaded.json()) as BlobRef;
    await apply(mf, {
      type: "create",
      opId: crypto.randomUUID(),
      fileId: crypto.randomUUID(),
      path: "assets/image.png",
      content: { kind: "blob", blob },
    });
    await request(mf, "/flush");
    await request(mf, "/exclusions", { exclusions: ["assets"] }, "PUT");
    await request(mf, "/flush");
    const bucket = await mf.getR2Bucket("BUCKET");
    const saved = await (await bucket.get(
      `vaults/${vaultId}/files/assets/image.png`,
    ))!.arrayBuffer();
    expect(saved.byteLength).toBe(bytes.byteLength);
    expect(await digest(new Uint8Array(saved))).toBe(hash);
    const snapshot = (await (await request(mf, "/snapshot")).json()) as Snapshot;
    expect(snapshot.exclusions).toEqual(["assets"]);
  });
  it("consumes a ticket once and closes revoked device sockets", async () => {
    const { mf } = await start();
    const ticket = (await (await request(mf, "/tickets", {})).json()) as { ticket: string };
    const connect = () =>
      mf.dispatchFetch(`https://test/ws?ticket=${encodeURIComponent(ticket.ticket)}`, {
        headers: { "X-Vault-Id": vaultId, Upgrade: "websocket" },
      });
    const response = await connect();
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    expect((await connect()).status).toBe(401);
    const closed = new Promise<number>((resolve) =>
      response.webSocket!.addEventListener("close", (event) => resolve(event.code)),
    );
    await request(mf, "/revoke", { deviceId });
    expect(await closed).toBe(4003);
    expect((await request(mf, "/tickets", {})).status).toBe(403);
  }, 30_000);
});

describe("client engine against the real DO", () => {
  it("converges offline edits through HTTP and websocket notifications", async () => {
    const { mf } = await start();
    const left = createRuntimeClient(mf, { "note.md": "base" }),
      right = createRuntimeClient(mf, {});
    try {
      await left.engine.start();
      await right.engine.start();
      expect(right.text("note.md")).toBe("base");
      left.engine.pause();
      right.engine.pause();
      (await left.engine.ensureDoc("note.md"))!.getText("content").insert(0, "LEFT ");
      (await right.engine.ensureDoc("note.md"))!.getText("content").insert(4, " RIGHT");
      await left.engine.resume();
      await right.engine.resume();
      await left.engine.syncNow();
      await right.engine.syncNow();
      expect(left.text("note.md")).toBe("LEFT base RIGHT");
      expect(right.text("note.md")).toBe(left.text("note.md"));
      await request(mf, "/flush");
      const bucket = await mf.getR2Bucket("BUCKET");
      expect(await (await bucket.get(`vaults/${vaultId}/files/note.md`))!.text()).toBe(
        "LEFT base RIGHT",
      );
    } finally {
      await left.engine.dispose();
      await right.engine.dispose();
    }
  }, 30_000);
});
