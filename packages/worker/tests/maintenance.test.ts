import { describe, expect, it, vi } from "vitest";

import { BlobStorage } from "../src/infra/blob-storage";
import { VaultMaintenance } from "../src/infra/vault-maintenance";
import { VaultSockets } from "../src/infra/vault-sockets";
import { FlushVault } from "../src/usecase/flush-vault";
import type { VaultArchive, VaultNotifications, VaultStore } from "../src/usecase/ports";

function storage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    data,
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => {
      alarm = time;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}

describe("maintenance deadlines", () => {
  it("advances distant GC alarms and restores deadlines after reconstruction", async () => {
    const state = storage();
    const maintenance = new VaultMaintenance(state as unknown as DurableObjectStorage);
    await maintenance.complete("blobs", Date.now() + 86_400_000);
    await maintenance.schedule();
    await maintenance.request("flush");
    const deadline = await state.getAlarm();
    expect(deadline).toBeLessThan(Date.now() + 11_000);

    const restored = new VaultMaintenance(state as unknown as DurableObjectStorage);
    await restored.schedule();
    expect(await state.getAlarm()).toBe(deadline);
  });

  it("retains failed GC work independently of successfully flushed changes", async () => {
    const state = storage();
    state.data.set("maintenance:blobs", Date.now() - 1);
    const maintenance = new VaultMaintenance(state as unknown as DurableObjectStorage);
    const repository = {
      meta: async () => ({ vaultId: "vault", revision: 0, r2Revision: 0, exclusions: [] }),
      files: async () => [],
    } as unknown as VaultStore;
    const sockets = { expire: async () => {}, broadcast: vi.fn() } satisfies VaultNotifications;
    const archive = {
      collectUnreferenced: vi
        .fn()
        .mockRejectedValueOnce(new Error("R2 down"))
        .mockResolvedValue(null),
    } as unknown as VaultArchive;
    const flush = new FlushVault(repository, sockets, archive, maintenance);

    await expect(flush.execute()).rejects.toThrow("R2 down");
    expect(await state.getAlarm()).toBeGreaterThan(Date.now());
    expect(state.data.has("maintenance:blobs")).toBe(true);
    state.data.set("maintenance:blobs", Date.now() - 1);
    await flush.execute();
    expect(await state.getAlarm()).toBeNull();
    expect(sockets.broadcast).not.toHaveBeenCalled();
  });
});

it("collects only expired unreferenced blobs and returns the earliest future expiry", async () => {
  const now = Date.now();
  const objects = [
    { key: "staging/vault/referenced", uploaded: new Date(now - 100_000_000) },
    { key: "staging/vault/expired", uploaded: new Date(now - 86_400_000) },
    { key: "staging/vault/future", uploaded: new Date(now - 40_000) },
    { key: "staging/vault/new", uploaded: new Date(now) },
  ];
  const remove = vi.fn();
  const bucket = {
    list: async () => ({ objects, truncated: false }),
    delete: remove,
  } as unknown as R2Bucket;
  const blobs = new BlobStorage(bucket, "vault");

  expect(await blobs.collectUnreferenced(new Set(["referenced"]))).toBe(now - 40_000 + 86_400_000);
  expect(remove).toHaveBeenCalledExactlyOnceWith("staging/vault/expired");
});

it("keeps an idle socket open beyond fifteen minutes and closes it when its device is revoked", async () => {
  vi.useFakeTimers();

  try {
    const deviceId = crypto.randomUUID();
    const socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    const getWebSockets = vi.fn(() => [socket]);
    const state = { storage: storage(), getWebSockets } as unknown as DurableObjectState;
    const sockets = new VaultSockets(state);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await sockets.expire();
    sockets.broadcast({ type: "r2", revision: 7 });

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ type: "r2", revision: 7 }),
    );

    await sockets.revoke(deviceId);

    expect(getWebSockets).toHaveBeenLastCalledWith(deviceId);
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(4003, "Device revoked");
    await expect(sockets.assertDeviceActive(deviceId)).rejects.toMatchObject({ kind: "forbidden" });
  } finally {
    vi.useRealTimers();
  }
});
