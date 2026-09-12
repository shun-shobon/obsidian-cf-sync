import "fake-indexeddb/auto";
import { digest } from "@cf-sync/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { IndexedDbStore } from "../src/sync/infra/storage/indexed-db-store";
import { SyncEngine } from "../src/sync/usecase/sync-engine";

import { Server } from "./helpers/sync-server";
import { Vault } from "./helpers/sync-vault";

const encode = (value: string) => new TextEncoder().encode(value);
const engines: SyncEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
});

function client(server: Server, vault: Vault, name = crypto.randomUUID()) {
  const store = new IndexedDbStore(name);
  const engine = new SyncEngine({
    vault,
    api: server.api,
    store,
    onStatus() {},
    onConflict() {},
    confirmInitial: async () => true,
  });
  engines.push(engine);
  return { engine, store };
}

describe("persistent synchronization", () => {
  it("merges two offline text replicas and retains their CRDT identities", async () => {
    const server = new Server();
    const a = new Vault();
    const b = new Vault();
    await a.write("note.md", encode("hello"));
    const first = client(server, a);
    const second = client(server, b);
    await first.engine.start();
    await second.engine.start();
    first.engine.pause();
    second.engine.pause();
    const docA = await first.engine.ensureDoc("note.md");
    const docB = await second.engine.ensureDoc("note.md");
    docA!.getText("content").insert(0, "A");
    docB!.getText("content").insert(5, "B");
    await first.engine.ensureDoc("note.md");
    await second.engine.ensureDoc("note.md");
    await first.engine.resume();
    await second.engine.resume();
    await first.engine.syncNow();
    expect(a.text("note.md")).toBe("AhelloB");
    expect(b.text("note.md")).toBe("AhelloB");
  });

  it("retries the durable operation ID after a lost acknowledgement and restart", async () => {
    const server = new Server();
    const vault = new Vault();
    const name = crypto.randomUUID();
    await vault.write("note.md", encode("survives"));
    server.failAfterSave = true;
    const first = client(server, vault, name);
    await first.engine.start();
    const pending = (await first.store.load())!.pending;
    expect(pending).toHaveLength(1);
    await first.engine.dispose();
    engines.splice(engines.indexOf(first.engine), 1);
    const next = client(server, vault, name);
    await next.engine.start();
    expect(server.calls).toEqual([pending[0]!.opId, pending[0]!.opId]);
    expect((await next.store.load())!.pending).toHaveLength(0);
    expect(vault.text("note.md")).toBe("survives");
    expect(server.docs.size).toBe(1);
  });

  it("recognizes identical existing notes without duplicating independent Yjs text", async () => {
    const server = new Server();
    const a = new Vault();
    const b = new Vault();
    await a.write("same.md", encode("same"));
    await b.write("same.md", encode("same"));
    const first = client(server, a);
    const second = client(server, b);
    await first.engine.start();
    await second.engine.start();
    expect(server.docs.size).toBe(1);
    expect(b.text("same.md")).toBe("same");
    expect((await second.engine.ensureDoc("same.md"))!.getText("content").toString()).toBe("same");
  });

  it("persists edits while paused and preserves them over process restart", async () => {
    const server = new Server();
    const vault = new Vault();
    const name = crypto.randomUUID();
    await vault.write("note.md", encode("base"));
    const first = client(server, vault, name);
    await first.engine.start();
    first.engine.pause();
    await vault.write("note.md", encode("offline edit"));
    await first.engine.capture("note.md");
    expect((await first.store.load())!.pending.length).toBe(1);
    await first.engine.dispose();
    engines.splice(engines.indexOf(first.engine), 1);
    const next = client(server, vault, name);
    await next.engine.start();
    expect([...server.docs.values()][0]!.doc.getText("content").toString()).toBe("offline edit");
  });

  it("recovers a durable editor update when the disk write was interrupted", async () => {
    const server = new Server();
    const vault = new Vault();
    const name = crypto.randomUUID();
    await vault.write("note.md", encode("base"));
    const first = client(server, vault, name);
    await first.engine.start();
    first.engine.pause();
    const originalWrite = vault.write.bind(vault);
    vault.write = async () => {
      throw Error("interrupted disk write");
    };
    const doc = await first.engine.ensureDoc("note.md");
    doc!.getText("content").insert(4, " saved");
    await first.engine.ensureDoc("note.md");
    expect((await first.store.load())!.pending).toHaveLength(1);
    expect(vault.text("note.md")).toBe("base");
    await first.engine.dispose();
    engines.splice(engines.indexOf(first.engine), 1);
    vault.write = originalWrite;
    const next = client(server, vault, name);
    await next.engine.start();
    expect(vault.text("note.md")).toBe("base saved");
    expect([...server.docs.values()][0]!.doc.getText("content").toString()).toBe("base saved");
  });

  it("persists rename and edit as operations on the same file identity", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write("note.md", encode("before"));
    const { engine } = client(server, vault);
    await engine.start();
    engine.pause();
    const id = [...server.docs.keys()][0];
    await vault.rename("note.md", "folder/renamed.md");
    await engine.captureRename("note.md", "folder/renamed.md");
    await vault.write("folder/renamed.md", encode("after"));
    await engine.capture("folder/renamed.md");
    await engine.resume();
    expect([...server.docs.keys()]).toEqual([id]);
    expect(server.docs.get(id!)!.file.path).toBe("folder/renamed.md");
    expect(vault.text("folder/renamed.md")).toBe("after");
  });

  it("compacts unsent edits but never mutates an operation whose response was lost", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write("note.md", encode("base"));
    const { engine, store } = client(server, vault);
    await engine.start();
    engine.pause();
    for (const value of ["one", "two", "three"]) {
      await vault.write("note.md", encode(value));
      await engine.capture("note.md");
    }
    expect((await store.load())!.pending).toHaveLength(1);
    server.failAfterSave = true;
    await engine.resume();
    engine.pause();
    const sealed = (await store.load())!.pending[0]!;
    await vault.write("note.md", encode("four"));
    await engine.capture("note.md");
    const state = (await store.load())!;
    expect(state.pending).toHaveLength(2);
    expect(state.pending[0]).toEqual(sealed);
    await engine.resume();
    expect([...server.docs.values()][0]!.doc.getText("content").toString()).toBe("four");
  });

  it("releases a document only after the last pane releases it", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write("note.md", encode("text"));
    const { engine } = client(server, vault);
    await engine.start();
    const first = (await engine.ensureDoc("note.md"))!;
    const second = (await engine.ensureDoc("note.md"))!;
    expect(first).toBe(second);
    engine.releaseDoc(first);
    await engine.capture("note.md");
    expect(engine.getDoc("note.md")).toBe(second);
    engine.releaseDoc(second);
    await engine.capture("note.md");
    expect(engine.getDoc("note.md")).toBeUndefined();
    const restored = (await engine.ensureDoc("note.md"))!;
    expect(restored.getText("content").toString()).toBe("text");
  });

  it("captures a disk edit made while remote document retrieval is pending", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write("note.md", encode("base"));
    const { engine, store } = client(server, vault);
    await engine.start();
    const remote = [...server.docs.values()][0]!;
    remote.doc.getText("content").insert(4, " remote");
    remote.file.digest = await digest(encode("base remote"));
    remote.file.revision = ++server.revision;
    const getDocument = server.api.document.bind(server.api);
    let captured: Promise<void> | undefined;
    server.api.document = async (id) => {
      const response = await getDocument(id);
      await vault.write("note.md", encode("base local"));
      captured = engine.capture("note.md");
      return response;
    };
    await engine.syncNow();
    await captured;
    expect(vault.text("note.md")).toBe("base local");
    expect((await store.load())!.pending).toHaveLength(1);
    server.api.document = getDocument;
    await engine.syncNow();
    expect(vault.text("note.md")).toContain("local");
    expect(vault.text("note.md")).toContain("remote");
  });

  it("rejects a last-moment disk change through compare-and-write", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write("note.md", encode("base"));
    const { engine, store } = client(server, vault);
    await engine.start();
    const remote = [...server.docs.values()][0]!;
    remote.doc.getText("content").insert(4, " remote");
    remote.file.digest = await digest(encode("base remote"));
    remote.file.revision = ++server.revision;
    const write = vault.writeIfUnchanged.bind(vault);
    vault.writeIfUnchanged = async (path, expected, bytes) => {
      await vault.write(path, encode("base late"));
      return write(path, expected, bytes);
    };
    await engine.syncNow();
    expect(vault.text("note.md")).toBe("base late");
    expect((await store.load())!.pending).toHaveLength(1);
    vault.writeIfUnchanged = write;
    await engine.syncNow();
    expect(vault.text("note.md")).toContain("late");
    expect(vault.text("note.md")).toContain("remote");
  });

  it("keeps the original move basis after an edit acknowledgement includes another device move", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write("note.md", encode("base"));
    const { engine } = client(server, vault);
    await engine.start();
    engine.pause();
    const remote = [...server.docs.values()][0]!;
    await vault.write("note.md", encode("edited"));
    await engine.capture("note.md");
    await vault.rename("note.md", "local.md");
    await engine.captureRename("note.md", "local.md");
    remote.file.path = "remote.md";
    remote.file.pathRevision = ++server.revision;
    remote.file.revision = server.revision;
    await engine.resume();
    expect(remote.file.path).toBe("remote.md");
    const move = server.operations.find((operation) => operation.type === "move")!;
    expect(move.type === "move" && move.basePathRevision).toBe(0);
  });

  it("keeps the original delete basis after merging another device edit", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write("note.md", encode("base"));
    const { engine } = client(server, vault);
    await engine.start();
    engine.pause();
    const remote = [...server.docs.values()][0]!;
    const originalRevision = remote.file.revision;
    await vault.write("note.md", encode("base local"));
    await engine.capture("note.md");
    await vault.remove("note.md");
    await engine.captureDelete("note.md");
    remote.doc.getText("content").insert(0, "remote ");
    remote.file.digest = await digest(encode("remote base"));
    remote.file.revision = ++server.revision;
    await engine.resume();
    const deletion = server.operations.find((operation) => operation.type === "delete")!;
    expect(deletion.type === "delete" && deletion.baseRevision).toBe(originalRevision);
  });

  it("moves a closed document CRDT state atomically when a conflict changes its ID", async () => {
    const server = new Server();
    const vault = new Vault();
    const name = crypto.randomUUID();
    await vault.write("note.md", encode("base"));
    const first = client(server, vault, name);
    await first.engine.start();
    first.engine.pause();
    await vault.write("note.md", encode("base local"));
    await first.engine.capture("note.md");
    expect(first.engine.getDoc("note.md")).toBeUndefined();
    const operate = server.api.operate.bind(server.api);
    const snapshot = server.api.snapshot.bind(server.api);
    const newId = crypto.randomUUID();
    server.api.operate = async (operation) => {
      const result = await operate(operation);
      const entry = server.docs.get(operation.fileId)!;
      server.docs.delete(operation.fileId);
      entry.file.id = newId;
      server.docs.set(newId, entry);
      server.api.snapshot = async () => {
        throw Error("connection lost");
      };
      return { ...result, file: { ...entry.file }, conflict: true };
    };
    await first.engine.resume();
    await first.engine.dispose();
    engines.splice(engines.indexOf(first.engine), 1);
    server.api.operate = operate;
    server.api.snapshot = snapshot;
    const second = client(server, vault, name);
    second.engine.pause();
    await second.engine.start();
    await vault.write("note.md", encode("base local next"));
    await second.engine.capture("note.md");
    await second.engine.resume();
    expect(server.docs.get(newId)!.doc.getText("content").toString()).toBe("base local next");
  });

  it("recovers a remote disk write interrupted before baseline persistence without duplicating text", async () => {
    const server = new Server();
    const vault = new Vault();
    const name = crypto.randomUUID();
    await vault.write("note.md", encode("base"));
    const first = client(server, vault, name);
    await first.engine.start();
    const remote = [...server.docs.values()][0]!;
    remote.doc.getText("content").insert(4, "R");
    remote.file.digest = await digest(encode("baseR"));
    remote.file.revision = ++server.revision;
    const save = first.store.save.bind(first.store);
    first.store.save = async (state, data) => {
      if (state.incoming === null && data?.key.startsWith("doc:"))
        throw Error("interrupted after CAS");
      await save(state, data);
    };
    await first.engine.syncNow();
    expect(vault.text("note.md")).toBe("baseR");
    expect((await first.store.load())!.incoming).not.toBeNull();
    await first.engine.dispose();
    engines.splice(engines.indexOf(first.engine), 1);
    const second = client(server, vault, name);
    await second.engine.start();
    expect((await second.store.load())!.pending).toHaveLength(0);
    expect(vault.text("note.md")).toBe("baseR");
    await vault.write("note.md", encode("baseR next"));
    await second.engine.capture("note.md");
    await second.engine.syncNow();
    expect(remote.doc.getText("content").toString()).toBe("baseR next");
  });

  it("protects a further disk edit made after an interrupted remote write", async () => {
    const server = new Server();
    const vault = new Vault();
    const name = crypto.randomUUID();
    await vault.write("note.md", encode("base"));
    const first = client(server, vault, name);
    await first.engine.start();
    const remote = [...server.docs.values()][0]!;
    remote.doc.getText("content").insert(4, "R");
    remote.file.digest = await digest(encode("baseR"));
    remote.file.revision = ++server.revision;
    const save = first.store.save.bind(first.store);
    first.store.save = async (state, data) => {
      if (state.incoming === null && data?.key.startsWith("doc:")) throw Error("interrupted");
      await save(state, data);
    };
    await first.engine.syncNow();
    await first.engine.dispose();
    engines.splice(engines.indexOf(first.engine), 1);
    await vault.write("note.md", encode("baseR outside"));
    const second = client(server, vault, name);
    await second.engine.start();
    expect(vault.text("note.md")).toBe("baseR");
    const recovery = (await vault.list()).find((path) => path.includes("(conflict"))!;
    expect(vault.text(recovery)).toBe("baseR outside");
    expect((await second.store.load())!.incoming).toBeNull();
  });

  it("keeps a deletion made after an interrupted remote write and protects the received text", async () => {
    const server = new Server();
    const vault = new Vault();
    const name = crypto.randomUUID();
    await vault.write("note.md", encode("base"));
    const first = client(server, vault, name);
    await first.engine.start();
    const remote = [...server.docs.values()][0]!;
    const originalId = remote.file.id;
    remote.doc.getText("content").insert(4, "R");
    remote.file.digest = await digest(encode("baseR"));
    remote.file.revision = ++server.revision;
    const save = first.store.save.bind(first.store);
    first.store.save = async (state, data) => {
      if (state.incoming === null && data?.key.startsWith("doc:")) throw Error("interrupted");
      await save(state, data);
    };
    await first.engine.syncNow();
    await first.engine.dispose();
    engines.splice(engines.indexOf(first.engine), 1);
    await vault.remove("note.md");
    const second = client(server, vault, name);
    second.engine.pause();
    await second.engine.start();
    expect((await vault.list()).includes("note.md")).toBe(false);
    expect(
      (await second.store.load())!.pending.some(
        (operation) => operation.type === "delete" && operation.fileId === originalId,
      ),
    ).toBe(true);
    const recovery = (await vault.list()).find((path) => path.includes("(conflict"))!;
    expect(vault.text(recovery)).toBe("baseR");
    await second.engine.resume();
    expect(server.docs.has(originalId)).toBe(false);
    expect((await vault.list()).includes("note.md")).toBe(false);
    expect(
      [...server.docs.values()].some(
        (entry) => entry.doc.getText("content").toString() === "baseR",
      ),
    ).toBe(true);
  });

  it("ignores hidden management files", async () => {
    const server = new Server();
    const vault = new Vault();
    await vault.write(".obsidian/config.json", encode("secret"));
    await vault.write("notes/.hidden", encode("secret"));
    const { engine } = client(server, vault);
    await engine.start();
    expect(server.docs.size).toBe(0);
  });
});
