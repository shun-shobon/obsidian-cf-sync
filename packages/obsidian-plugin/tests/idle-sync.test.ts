import "./helpers/browser-window";
import "fake-indexeddb/auto";
import type { ServerMessage } from "@cf-sync/protocol";
import { afterEach, expect, it, vi } from "vitest";

import { AuthenticationError } from "../src/domain/authentication-error";
import { DocumentNotFoundError } from "../src/domain/document-not-found-error";
import { IndexedDbStore } from "../src/sync/infra/storage/indexed-db-store";
import { SyncEngine } from "../src/sync/usecase/sync-engine";

import { Server } from "./helpers/sync-server";
import { Vault } from "./helpers/sync-vault";

const engines: SyncEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const server = new Server();
  const vault = new Vault();
  const sockets: {
    message: (message: ServerMessage) => void;
    disconnect: () => void;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const connect = vi
    .spyOn(server.api, "connect")
    .mockImplementation(async (message, disconnect) => {
      const close = vi.fn();
      sockets.push({ message, disconnect, close });
      return { close };
    });
  const readSnapshot = server.api.snapshot.bind(server.api);
  const snapshot = vi.spyOn(server.api, "snapshot").mockImplementation(readSnapshot);
  const store = new IndexedDbStore(crypto.randomUUID());
  const engine = new SyncEngine({
    vault,
    api: server.api,
    store,
    onStatus() {},
    onConflict() {},
    confirmInitial: async () => true,
  });
  engines.push(engine);
  return { engine, server, vault, sockets, connect, snapshot, store };
}

// The serial queue is also used by editor loading, so awaiting it observes queued work
// without initiating synchronization or adding a timer.
async function settled(engine: SyncEngine) {
  await engine.ensureDoc("missing.md");
}

it("keeps an idle connection for an hour without network requests", async () => {
  const { engine, connect, snapshot } = setup();
  await engine.start();
  const count = snapshot.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  await settled(engine);
  expect(snapshot).toHaveBeenCalledTimes(count);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("receives a change while idle without periodic synchronization", async () => {
  const { engine, server, vault, sockets } = setup();
  await vault.write("note.md", new TextEncoder().encode("hello"));
  await engine.start();
  const [id, remote] = [...server.docs][0]!;
  remote.doc.getText("content").insert(5, " remote");
  remote.file.revision += 1;
  sockets[0]!.message({ type: "changed", fileId: id, revision: remote.file.revision });
  await settled(engine);
  expect(vault.text("note.md")).toBe("hello remote");
});

it("backs off after failures and stays quiet once reconnected", async () => {
  const { engine, server, sockets, connect } = setup();
  await engine.start();
  server.offline = true;
  sockets[0]!.disconnect();
  await vi.advanceTimersByTimeAsync(1000);
  await settled(engine);
  expect(connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await settled(engine);
  expect(connect).toHaveBeenCalledTimes(3);
  server.offline = false;
  await vi.advanceTimersByTimeAsync(4000);
  await settled(engine);
  expect(connect).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  await settled(engine);
  expect(connect).toHaveBeenCalledTimes(4);
});

it("rescans missed local changes and replaces a stale connection on refresh", async () => {
  const { engine, server, vault, sockets, connect } = setup();
  await engine.start();
  await vault.write("missed.md", new TextEncoder().encode("offline edit"));
  await engine.refresh();
  expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(2);
  expect([...server.docs.values()][0]!.doc.getText("content").toString()).toBe("offline edit");
  sockets[0]!.disconnect();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(connect).toHaveBeenCalledTimes(2);
});

it("retains notifications arriving during the initial snapshot", async () => {
  const { engine, snapshot, sockets } = setup();
  const original = snapshot.getMockImplementation()!;
  snapshot.mockImplementationOnce(async () => {
    sockets[0]!.message({ type: "settings", revision: 1 });
    return original();
  });
  await engine.start();
  await vi.advanceTimersByTimeAsync(250);
  await settled(engine);
  expect(snapshot).toHaveBeenCalledTimes(4);
});

it("stops retrying when authentication is rejected", async () => {
  const { engine, snapshot, connect } = setup();
  snapshot.mockRejectedValue(new AuthenticationError("revoked"));
  await engine.start();
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes a connection that finishes opening after pause", async () => {
  const { engine, connect, snapshot } = setup();
  let release!: () => void;
  const opening = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.fn();
  connect.mockImplementation(async () => {
    await opening;
    return { close };
  });
  const starting = engine.start();
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  engine.pause();
  release();
  await starting;
  expect(close).toHaveBeenCalledTimes(1);
  expect(snapshot).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("sends local changes discovered while receiving a document without another user event", async () => {
  const { engine, server, vault, sockets, store } = setup();
  await vault.write("note.md", new TextEncoder().encode("base"));
  await engine.start();
  const [id, remote] = [...server.docs][0]!;
  remote.doc.getText("content").insert(4, " remote");
  remote.file.revision += 1;
  const document = server.api.document.bind(server.api);
  vi.spyOn(server.api, "document").mockImplementationOnce(async (fileId) => {
    await vault.write("note.md", new TextEncoder().encode("base local"));
    return document(fileId);
  });
  sockets[0]!.message({ type: "changed", fileId: id, revision: remote.file.revision });
  await settled(engine);
  expect((await store.load())!.pending.length).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(250);
  await settled(engine);
  expect((await store.load())!.pending).toHaveLength(0);
  expect(remote.doc.getText("content").toString()).toContain("local");
});

it("does not retry a local storage failure as a network failure", async () => {
  const { engine, store, connect } = setup();
  await engine.start();
  vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk unavailable"));
  await engine.syncNow();
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("allows manual refresh after fixing a local storage error", async () => {
  const { engine, store, connect, snapshot } = setup();
  await engine.start();
  vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk unavailable"));
  await engine.syncNow();
  const count = snapshot.mock.calls.length;
  await engine.refresh();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(snapshot.mock.calls.length).toBeGreaterThan(count);
  expect(vi.getTimerCount()).toBe(0);
});

it("reconciles again when a file is deleted after taking a snapshot", async () => {
  const { engine, server, vault } = setup();
  await vault.write("note.md", new TextEncoder().encode("base"));
  await engine.start();
  const [id, remote] = [...server.docs][0]!;
  remote.file.revision += 1;
  vi.spyOn(server.api, "document").mockImplementationOnce(async () => {
    server.docs.delete(id);
    throw new DocumentNotFoundError("deleted");
  });
  await engine.syncNow();
  await vi.advanceTimersByTimeAsync(100);
  await settled(engine);
  expect(await vault.list()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
