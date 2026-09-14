import { describe, expect, it, vi } from "vitest";

import { Server } from "../../obsidian-plugin/tests/helpers/sync-server";
import { Vault } from "../../obsidian-plugin/tests/helpers/sync-vault";
import { PlanSync, SyncOnce, type LocalState, type StoredData, type SyncStore } from "../src";

class Store implements SyncStore {
  state: LocalState | undefined;
  data = new Map<string, Uint8Array>();
  async load() {
    return structuredClone(this.state);
  }
  async save(state: LocalState, data?: StoredData) {
    this.state = structuredClone(state);
    if (data) await this.put(data.key, data.value);
  }
  async get(key: string) {
    return this.data.get(key)?.slice();
  }
  async put(key: string, value: Uint8Array) {
    this.data.set(key, value.slice());
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  close() {}
}
const bytes = (text: string) => new TextEncoder().encode(text);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("HTTP batch synchronization", () => {
  it("uploads and retrieves text without opening a socket or waiting for R2", async () => {
    const server = new Server();
    const connect = vi.spyOn(server.api, "connect");
    const left = { vault: new Vault(), store: new Store(), api: server.api };
    await left.vault.write("note.md", bytes("hello"));
    const result = await new SyncOnce(left).run();
    expect(result.pending).toBe(0);
    expect(result.revision).toBeGreaterThan(0);
    const right = { vault: new Vault(), store: new Store(), api: server.api };
    await new SyncOnce(right).run();
    expect(right.vault.text("note.md")).toBe("hello");
    expect(connect).not.toHaveBeenCalled();
    const before = server.operations.length;
    await new SyncOnce(right).run();
    expect(server.operations).toHaveLength(before);
  });

  it("finishes when a received document is newer than the requested snapshot", async () => {
    const server = new Server();
    const left = { vault: new Vault(), store: new Store(), api: server.api };
    await left.vault.write("note.md", bytes("first"));
    await new SyncOnce(left).run();
    const snapshot = structuredClone(await server.api.snapshot());
    await left.vault.write("note.md", bytes("newer"));
    await new SyncOnce(left).run();
    const api = { ...server.api, snapshot: vi.fn(async () => structuredClone(snapshot)) };
    const right = { vault: new Vault(), store: new Store(), api };
    await new SyncOnce(right).run();
    expect(right.vault.text("note.md")).toBe("newer");
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it("waits for the other transfer lane before rejecting a failed upload", async () => {
    const server = new Server();
    const gate = deferred();
    const started = deferred();
    const api = {
      ...server.api,
      async upload(key: string, value: Uint8Array, digest: string) {
        started.resolve();
        await gate.promise;
        return { key, size: value.length, digest };
      },
      async operate() {
        throw new Error("transfer failed");
      },
    };
    const options = { vault: new Vault(), store: new Store(), api };
    await options.vault.write("note.md", bytes("hello"));
    await options.vault.write("image.png", bytes("image"));
    let settled = false;
    const result = new SyncOnce(options).run().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    expect(await result).toMatchObject({ message: "transfer failed" });
  });

  it("plans changes without changing files, remote operations or stored state", async () => {
    const server = new Server();
    const options = { vault: new Vault(), store: new Store(), api: server.api };
    await options.vault.write("note.md", bytes("hello"));
    await new SyncOnce(options).run();
    await options.vault.write("note.md", bytes("edited"));
    await options.vault.write("new.md", bytes("new"));
    const before = structuredClone({
      state: options.store.state,
      data: options.store.data,
      files: options.vault.files,
      operations: server.operations,
    });
    const plan = await new PlanSync(options).run();
    expect(plan.uploads).toEqual(
      expect.arrayContaining([
        { path: "note.md", action: "edit" },
        { path: "new.md", action: "create" },
      ]),
    );
    expect({
      state: options.store.state,
      data: options.store.data,
      files: options.vault.files,
      operations: server.operations,
    }).toEqual(before);
  });

  it("plans a local deletion as upload only and propagates it on execution", async () => {
    const server = new Server();
    const options = { vault: new Vault(), store: new Store(), api: server.api };
    await options.vault.write("note.md", bytes("hello"));
    await new SyncOnce(options).run();
    await options.vault.remove("note.md");
    const plan = await new PlanSync(options).run();
    expect(plan.uploads).toEqual([{ path: "note.md", action: "delete" }]);
    expect(plan.downloads).toEqual([]);
    await new SyncOnce(options).run();
    expect((await server.api.snapshot()).files).toEqual([]);
  });

  it("does not report downloads for an identical initial directory", async () => {
    const server = new Server();
    const first = { vault: new Vault(), store: new Store(), api: server.api };
    await first.vault.write("note.md", bytes("hello"));
    await new SyncOnce(first).run();
    const next = { vault: new Vault(), store: new Store(), api: server.api };
    await next.vault.write("note.md", bytes("hello"));
    expect(await new PlanSync(next).run()).toEqual({ uploads: [], downloads: [] });
    expect(next.store.state).toBeUndefined();
  });
});
