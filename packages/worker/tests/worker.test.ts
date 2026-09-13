import { type Operation, type Snapshot } from "@cf-sync/protocol";
import { Hono } from "hono";
import { toUint8Array, fromUint8Array } from "js-base64";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { authenticate } from "../src/infra/access-auth";
import { Account } from "../src/infra/durable-objects/account";
import { Vault } from "../src/infra/durable-objects/vault";
import type { Env } from "../src/infra/env";
import { onError } from "../src/infra/http/responses";
import { jsonStream } from "../src/infra/rpc-json";
import { unwrapRpcResult } from "../src/infra/rpc-result";

class Storage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string) {
    return this.data.delete(key);
  }

  async list<T>(options: { prefix: string; limit?: number }) {
    return new Map(
      [...this.data]
        .filter(([key]) => key.startsWith(options.prefix))
        .slice(0, options.limit)
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async transaction<T>(fn: (tx: Storage) => Promise<T>) {
    const backup = structuredClone(this.data);
    try {
      return await fn(this);
    } catch (error) {
      this.data = backup;
      throw error;
    }
  }

  async getAlarm() {
    return this.alarm;
  }

  async deleteAlarm() {
    this.alarm = null;
  }

  async setAlarm(time: number) {
    this.alarm = time;
  }
}

function setup() {
  const storage = new Storage();
  const objects = new Map<string, string>();
  let fail = false;
  const env = {
    BUCKET: {
      put: async (key: string, bytes: Uint8Array) => {
        if (fail) throw new Error("R2 down");
        objects.set(key, new TextDecoder().decode(bytes));
        return {};
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
      list: async () => ({ objects: [], truncated: false }),
    },
  } as unknown as Env;
  const sockets: WebSocket[] = [];
  const state = { storage, getWebSockets: () => sockets } as unknown as DurableObjectState;
  let vault = new Vault(state, env);
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const operation = async (op: Operation) =>
    unwrapRpcResult(await vault.applyOperation(vaultId, deviceId, jsonStream(op)));
  return {
    storage,
    objects,
    sockets,
    env,
    message: (ws: WebSocket, data: string | ArrayBuffer) => vault.webSocketMessage(ws, data),
    close: (ws: WebSocket) => vault.webSocketClose(ws, 1000),
    snapshot: async () => {
      const result = unwrapRpcResult(await vault.snapshot(vaultId, deviceId));
      return new Response(result).json() as Promise<Snapshot>;
    },
    exclusions: async (paths: string[]) =>
      unwrapRpcResult(await vault.setExclusions(vaultId, deviceId, paths)),
    ticket: async () => unwrapRpcResult(await vault.issueTicket(vaultId, deviceId)),
    revoke: async () => unwrapRpcResult(await vault.revokeDevice(deviceId)),
    operation,
    vaultId,
    deviceId,
    fetch: (request: Request) => vault.fetch(request),
    fail: (value: boolean) => {
      fail = value;
    },
    alarm: async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(storage.alarm ?? Date.now());

      try {
        await vault.alarm();
      } finally {
        clock.mockRestore();
      }
    },
    restart: () => {
      vault = new Vault(state, env);
    },
  };
}

function text(value: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return { kind: "text" as const, update: fromUint8Array(Y.encodeStateAsUpdate(doc)) };
}

function create(path: string, value: string): Operation {
  return {
    type: "create",
    fileId: crypto.randomUUID(),
    opId: crypto.randomUUID(),
    path,
    content: text(value),
  };
}

describe("Vault durable synchronization", () => {
  it("leaves an idle vault without an alarm after flushing", async () => {
    const s = setup();
    await s.snapshot();
    expect(s.storage.alarm).toBeNull();

    await s.operation(create("a.md", "one"));
    expect(s.storage.alarm).not.toBeNull();
    await s.alarm();
    expect(s.storage.alarm).toBeNull();
    s.restart();
    await s.snapshot();
    expect(s.storage.alarm).toBeNull();
  });

  it("schedules ticket expiry exactly and stops after expiration", async () => {
    const s = setup();
    const ticket = await s.ticket();
    expect(s.storage.alarm).toBe(ticket.expiresAt);
    s.restart();
    await s.alarm();
    expect(s.storage.alarm).toBeNull();
    expect([...s.storage.data.keys()].some((key) => key.startsWith("ticket:"))).toBe(false);
  });

  it("advances a ticket alarm for writes without postponing the first flush", async () => {
    const s = setup();
    const ticket = await s.ticket();
    await s.operation(create("a.md", "one"));
    const flushAt = s.storage.alarm;
    expect(flushAt).toBeLessThan(ticket.expiresAt);
    await s.operation(create("b.md", "two"));
    expect(s.storage.alarm).toBe(flushAt);
    await s.alarm();
    expect(s.storage.alarm).toBe(ticket.expiresAt);
  });

  it("persists operation dedup across restart and retries failed R2 flush", async () => {
    const s = setup();
    const op = create("a.md", "one");
    const result = await s.operation(op);
    s.restart();
    expect(await s.operation(op)).toEqual(result);
    s.fail(true);
    await expect(s.alarm()).rejects.toThrow("R2 down");
    expect((await s.snapshot()).r2Revision).toBe(0);
    s.fail(false);
    await s.alarm();
    expect(s.objects.get(`vaults/${s.vaultId}/files/a.md`)).toBe("one");
    expect((await s.snapshot()).r2Revision).toBe(1);
  });

  it("converges offline text edits and preserves edited content on stale deletion", async () => {
    const s = setup();
    const op = create("a.md", "base");
    await s.operation(op);
    if (op.type !== "create" || op.content.kind !== "text") throw new Error();
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, toUint8Array(op.content.update));
    Y.applyUpdate(b, toUint8Array(op.content.update));
    a.getText("content").insert(4, "A");
    b.getText("content").insert(4, "B");
    for (const doc of [a, b])
      await s.operation({
        type: "edit",
        opId: crypto.randomUUID(),
        fileId: op.fileId,
        path: "a.md",
        baseRevision: 1,
        content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(doc)) },
      });
    const result = await s.operation({
      type: "delete",
      opId: crypto.randomUUID(),
      fileId: op.fileId,
      baseRevision: 1,
    });
    expect(result.conflict).toBe(true);
    expect(result.file?.id).not.toBe(op.fileId);
    await s.alarm();
    expect([...s.objects.values()][0]).toMatch(/^base(?:AB|BA)$/);
  });

  it("protects same-path creation, case collisions, stale moves and edits after deletion", async () => {
    const s = setup();
    const a = create("A.md", "first");
    await s.operation(a);
    expect((await s.operation(create("a.md", "second"))).conflict).toBe(true);
    await s.operation({
      type: "move",
      opId: crypto.randomUUID(),
      fileId: a.fileId,
      basePathRevision: 1,
      path: "moved.md",
    });
    const stale = await s.operation({
      type: "move",
      opId: crypto.randomUUID(),
      fileId: a.fileId,
      basePathRevision: 1,
      path: "else.md",
    });
    expect(stale.conflict).toBe(true);
    expect(stale.file?.path).toBe("moved.md");
    await s.operation({
      type: "delete",
      opId: crypto.randomUUID(),
      fileId: a.fileId,
      baseRevision: 3,
    });
    const edited = await s.operation({
      type: "edit",
      opId: crypto.randomUUID(),
      fileId: a.fileId,
      baseRevision: 3,
      path: "moved.md",
      content: text("offline"),
    });
    expect(edited.conflict).toBe(true);
    expect(edited.file?.id).not.toBe(a.fileId);
  });

  it("keeps existing R2 copies when excluded and rejects changes under exclusions", async () => {
    const s = setup();
    await s.operation(create("folder/a.md", "keep"));
    await s.alarm();
    await s.exclusions(["folder"]);
    await expect(s.operation(create("folder/b.md", "no"))).rejects.toMatchObject({
      kind: "conflict",
    });
    await s.alarm();
    expect([...s.objects.values()]).toEqual(["keep"]);
  });

  it("does not remove the old R2 path until the new path is persisted", async () => {
    const s = setup();
    const op = create("old.md", "safe");
    await s.operation(op);
    await s.alarm();
    await s.operation({
      type: "move",
      opId: crypto.randomUUID(),
      fileId: op.fileId,
      basePathRevision: 1,
      path: "new.md",
    });
    s.fail(true);
    await expect(s.alarm()).rejects.toThrow();
    expect(s.objects.has(`vaults/${s.vaultId}/files/old.md`)).toBe(true);
    s.fail(false);
    await s.alarm();
    expect(s.objects.has(`vaults/${s.vaultId}/files/old.md`)).toBe(false);
    expect(s.objects.get(`vaults/${s.vaultId}/files/new.md`)).toBe("safe");
  });

  it("rejects expired and reused websocket tickets before upgrade", async () => {
    const s = setup();
    const issued = await s.ticket();
    const ticketKey = [...s.storage.data.keys()].find((key) => key.startsWith("ticket:"))!;
    const stored = await s.storage.get<{ deviceId: string; expiresAt: number }>(ticketKey);
    await s.storage.put(ticketKey, { ...stored, expiresAt: 0 });
    const request = () =>
      new Request(`https://internal/ws?ticket=${issued.ticket}`, {
        headers: { "X-Vault-Id": s.vaultId, Upgrade: "websocket" },
      });
    const state = { storage: s.storage, getWebSockets: () => [] } as unknown as DurableObjectState;
    const vault = new Vault(state, {} as Env);
    expect((await vault.fetch(request())).status).toBe(401);
    expect((await vault.fetch(request())).status).toBe(401);
    expect(s.storage.data.has(ticketKey)).toBe(false);
  });
});

it("fails closed without Access configuration or a signed assertion", async () => {
  async function authenticateResponse(env: Env): Promise<Response> {
    const app = new Hono();
    app.onError(onError);
    app.get("/", async () => {
      await authenticate(new Request("https://test"), env);
      return new Response(null, { status: 204 });
    });
    return app.request("https://test/");
  }

  expect((await authenticateResponse({} as Env)).status).toBe(503);
  expect(
    (
      await authenticateResponse({
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUD: "aud",
      } as Env)
    ).status,
  ).toBe(401);
});

describe("Durable Object RPC", () => {
  it.each([
    ["/snapshot", "POST"],
    ["/operations", "PUT"],
    ["/ws", "POST"],
    ["/revoke", "GET"],
    ["/snapshot/extra", "GET"],
    ["/files", "GET"],
  ])("rejects %s with method %s", async (path, method) => {
    const s = setup();
    const response = await s.fetch(
      new Request(`https://internal${path}`, {
        method,
        headers: { "X-Vault-Id": s.vaultId, "X-Device-Id": s.deviceId },
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("revokes without vault headers and rejects subsequent authenticated operations", async () => {
    const s = setup();
    await s.revoke();
    await expect(s.snapshot()).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("reads the latest metadata for every request", async () => {
    const s = setup();
    await s.operation(create("first.md", "first"));
    expect((await s.snapshot()).revision).toBe(1);
    await s.operation(create("second.md", "second"));
    expect((await s.snapshot()).revision).toBe(2);
  });

  it("registers and reads account devices and vaults through methods", async () => {
    const account = new Account(
      { storage: new Storage() } as unknown as DurableObjectState,
      {} as Env,
    );
    const device = { id: crypto.randomUUID(), name: "Laptop" };

    expect(unwrapRpcResult(await account.registerDevice(device))).toMatchObject(device);
    expect(unwrapRpcResult(await account.device(device.id))).toMatchObject(device);

    const vault = { id: crypto.randomUUID(), name: "Notes" };

    expect(unwrapRpcResult(await account.createVault(vault))).toEqual(vault);
    expect(unwrapRpcResult(await account.vault(vault.id))).toEqual(vault);
    expect(unwrapRpcResult(await account.devices())).toHaveLength(1);
    expect(unwrapRpcResult(await account.vaults())).toEqual([vault]);
  });
});

function socket(deviceId: string) {
  let attachment: unknown = { deviceId, presence: null, updatedAt: 0 };
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: (value: unknown) => {
      attachment = value;
    },
    deserializeAttachment: () => attachment,
  };
}

describe("realtime synchronization", () => {
  it("persists and acknowledges WS operations idempotently and broadcasts edit deltas", async () => {
    const s = setup();
    await s.snapshot();
    const ws = socket(s.deviceId);
    s.sockets.push(ws as unknown as WebSocket);
    const op = create("live.md", "base");
    await s.message(s.sockets[0]!, JSON.stringify({ type: "operation", operation: op }));
    expect(ws.send.mock.calls.map(([data]) => JSON.parse(data))).toContainEqual(
      expect.objectContaining({
        type: "operation-result",
        result: expect.objectContaining({ revision: 1 }),
      }),
    );
    await s.message(s.sockets[0]!, JSON.stringify({ type: "operation", operation: op }));
    expect((await s.snapshot()).revision).toBe(1);
    if (op.type !== "create" || op.content.kind !== "text") throw new Error();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, toUint8Array(op.content.update));
    const vector = Y.encodeStateVector(doc);
    doc.getText("content").insert(4, " live");
    const update = fromUint8Array(Y.encodeStateAsUpdate(doc, vector));
    await s.message(
      s.sockets[0]!,
      JSON.stringify({
        type: "operation",
        operation: {
          type: "edit",
          opId: crypto.randomUUID(),
          fileId: op.fileId,
          path: "live.md",
          baseRevision: 1,
          content: { kind: "text", update },
        },
      }),
    );
    expect(ws.send.mock.calls.map(([data]) => JSON.parse(data))).toContainEqual(
      expect.objectContaining({
        type: "text",
        update,
        deviceId: s.deviceId,
        file: expect.objectContaining({ size: 9 }),
      }),
    );
    await s.alarm();
    expect(s.objects.get(`vaults/${s.vaultId}/files/live.md`)).toBe("base live");
  });

  it("retains the deleted CRDT base for an offline delta after deletion and restart", async () => {
    const s = setup();
    const op = create("deleted.md", "base");
    await s.operation(op);
    if (op.type !== "create" || op.content.kind !== "text") throw new Error();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, toUint8Array(op.content.update));
    const vector = Y.encodeStateVector(doc);
    doc.getText("content").insert(4, " offline");
    await s.operation({
      type: "delete",
      opId: crypto.randomUUID(),
      fileId: op.fileId,
      baseRevision: 1,
    });
    s.restart();
    const result = await s.operation({
      type: "edit",
      opId: crypto.randomUUID(),
      fileId: op.fileId,
      path: "deleted.md",
      baseRevision: 1,
      content: { kind: "text", update: fromUint8Array(Y.encodeStateAsUpdate(doc, vector)) },
    });
    expect(result.conflict).toBe(true);
    await s.alarm();
    expect([...s.objects.values()]).toEqual(["base offline"]);
  });

  it("publishes authenticated presence, clears on exit, and rejects revoked connections", async () => {
    const s = setup();
    await s.snapshot();
    const ws = socket(s.deviceId);
    s.sockets.push(ws as unknown as WebSocket);
    const doc = new Y.Doc();
    const position = fromUint8Array(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getText("content"), 0)),
    );
    const presence = {
      type: "presence",
      fileId: crypto.randomUUID(),
      clientId: 1,
      name: "Laptop",
      cursor: { anchor: position, head: position },
      deviceId: crypto.randomUUID(),
    };
    await s.message(s.sockets[0]!, JSON.stringify(presence));
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toEqual({ ...presence, deviceId: s.deviceId });
    await s.close(s.sockets[0]!);
    expect(JSON.parse(ws.send.mock.calls.at(-1)![0])).toMatchObject({
      type: "presence",
      fileId: null,
      cursor: null,
    });
    await s.revoke();
    ws.send.mockClear();
    await s.message(s.sockets[0]!, JSON.stringify(presence));
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it("reports permanent operation rejection without dropping the connection", async () => {
    const s = setup();
    await s.snapshot();
    await s.exclusions(["excluded"]);
    const ws = socket(s.deviceId);
    const op = create("excluded/a.md", "no");
    await s.message(
      ws as unknown as WebSocket,
      JSON.stringify({ type: "operation", operation: op }),
    );
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toMatchObject({
      type: "operation-error",
      opId: op.opId,
      retryable: false,
    });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("rejects oversized and binary messages", async () => {
    const s = setup();
    const ws = socket(s.deviceId);
    for (const message of [new ArrayBuffer(2), "x".repeat(16 * 1024 * 1024 + 1)]) {
      await s.message(ws as unknown as WebSocket, message);
    }
    expect(ws.close).toHaveBeenCalledWith(1009, expect.any(String));
    expect((await s.snapshot()).revision).toBe(0);
  });

  it("allows edits during R2 writes and leaves their newer revisions dirty", async () => {
    const s = setup();
    const op = create("busy.md", "base");
    await s.operation(op);
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = s.env.BUCKET.put.bind(s.env.BUCKET);
    vi.spyOn(s.env.BUCKET, "put").mockImplementationOnce(
      async (...args: Parameters<R2Bucket["put"]>) => {
        entered();
        await blocked;
        return put(...args);
      },
    );
    const flushing = s.alarm();
    await writing;
    await s.operation(create("new.md", "new"));
    release();
    await flushing;
    expect((await s.snapshot()).revision).toBe(2);
    expect((await s.snapshot()).r2Revision).toBe(1);
    expect(s.storage.data.has("dirty:new.md")).toBe(true);
    await s.alarm();
    expect((await s.snapshot()).r2Revision).toBe(2);
    expect(s.objects.get(`vaults/${s.vaultId}/files/new.md`)).toBe("new");
  });
});

it("retains old rename copies and defers the alarm when a snapshot changes before transfer", async () => {
  const s = setup();
  const original = create("old.md", "safe");
  await s.operation(original);
  await s.alarm();
  const previousRevision = (await s.snapshot()).r2Revision;
  await s.operation(create("first.md", "first"));
  await s.operation({
    type: "move",
    opId: crypto.randomUUID(),
    fileId: original.fileId,
    path: "intermediate.md",
    basePathRevision: 1,
  });
  let release!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = s.env.BUCKET.put.bind(s.env.BUCKET);
  vi.spyOn(s.env.BUCKET, "put").mockImplementationOnce(
    async (...args: Parameters<R2Bucket["put"]>) => {
      entered();
      await blocked;
      return put(...args);
    },
  );
  const firstAlarm = s.storage.alarm!;
  const flushing = s.alarm();
  await writing;
  await s.operation({
    type: "move",
    opId: crypto.randomUUID(),
    fileId: original.fileId,
    path: "latest.md",
    basePathRevision: 3,
  });
  release();
  await flushing;
  expect((await s.snapshot()).r2Revision).toBe(previousRevision);
  expect(s.objects.get(`vaults/${s.vaultId}/files/old.md`)).toBe("safe");
  expect(s.storage.data.has("dirty:old.md")).toBe(true);
  expect(s.storage.alarm).toBeGreaterThan(firstAlarm);
  await s.alarm();
  expect(s.objects.has(`vaults/${s.vaultId}/files/old.md`)).toBe(false);
  expect(s.objects.get(`vaults/${s.vaultId}/files/latest.md`)).toBe("safe");
  expect((await s.snapshot()).r2Revision).toBe(4);
});
