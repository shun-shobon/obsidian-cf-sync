import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";

import { IndexedDbStore } from "../src/sync/infra/storage/indexed-db-store";

const stores: IndexedDbStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

it("rejects a failed database open with an Error that preserves the cause", async () => {
  const name = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(new Error("Test database setup failed"));
  });
  const store = new IndexedDbStore(name);
  // Opening version 1 must fail when the database already uses version 2.
  const failure: unknown = await store.load().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ cause: { name: "VersionError" } });
});

it("rejects an explicit transaction abort even when IndexedDB supplies no error", async () => {
  const store = new IndexedDbStore(crypto.randomUUID());
  stores.push(store);
  await store.put("note", new Uint8Array([1]));
  // The original method is applied to the database supplied by the spy.
  // oxlint-disable-next-line typescript/unbound-method
  const transaction = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args
  ) {
    const result = transaction.apply(this, args);
    queueMicrotask(() => result.abort());
    return result;
  });
  const failure: unknown = await store
    .put("note", new Uint8Array([2]))
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ cause: null });
  vi.restoreAllMocks();
  expect(await store.get("note")).toEqual(new Uint8Array([1]));
});
