import {
  fromBase64,
  toBase64,
  type Operation,
  type OperationResult,
  type Snapshot,
} from "@cf-sync/protocol";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { authenticate } from "../src/infra/access-auth";
import { Vault } from "../src/infra/durable-objects/vault";
import type { Env } from "../src/infra/env";
import { handleErrors } from "../src/infra/http/responses";

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
  const state = { storage, getWebSockets: () => [] } as unknown as DurableObjectState;
  let vault = new Vault(state, env);
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const call = async (path: string, body?: unknown, method = "POST") =>
    vault.fetch(
      new Request(`https://internal${path}`, {
        method: body === undefined ? "GET" : method,
        headers: { "X-Vault-Id": vaultId, "X-Device-Id": deviceId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const operation = async (op: Operation) => {
    const response = await call("/operations", op);
    expect(response.status).toBe(200);
    return response.json() as Promise<OperationResult>;
  };
  return {
    storage,
    objects,
    call,
    operation,
    vaultId,
    fail: (value: boolean) => {
      fail = value;
    },
    alarm: () => vault.alarm(),
    restart: () => {
      vault = new Vault(state, env);
    },
  };
}
function text(value: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, value);
  return { kind: "text" as const, update: toBase64(Y.encodeStateAsUpdate(doc)) };
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
  it("persists operation dedup across restart and retries failed R2 flush", async () => {
    const s = setup();
    const op = create("a.md", "one");
    const result = await s.operation(op);
    s.restart();
    expect(await s.operation(op)).toEqual(result);
    s.fail(true);
    await expect(s.alarm()).rejects.toThrow("R2 down");
    expect(((await (await s.call("/snapshot")).json()) as Snapshot).r2Revision).toBe(0);
    s.fail(false);
    await s.alarm();
    expect(s.objects.get(`vaults/${s.vaultId}/files/a.md`)).toBe("one");
    expect(((await (await s.call("/snapshot")).json()) as Snapshot).r2Revision).toBe(1);
  });
  it("converges offline text edits and preserves edited content on stale deletion", async () => {
    const s = setup();
    const op = create("a.md", "base");
    await s.operation(op);
    if (op.type !== "create" || op.content.kind !== "text") throw new Error();
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, fromBase64(op.content.update));
    Y.applyUpdate(b, fromBase64(op.content.update));
    a.getText("content").insert(4, "A");
    b.getText("content").insert(4, "B");
    for (const doc of [a, b])
      await s.operation({
        type: "edit",
        opId: crypto.randomUUID(),
        fileId: op.fileId,
        path: "a.md",
        baseRevision: 1,
        content: { kind: "text", update: toBase64(Y.encodeStateAsUpdate(doc)) },
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
    await s.call("/exclusions", { exclusions: ["folder"] }, "PUT");
    const rejected = await s.call("/operations", create("folder/b.md", "no"));
    expect(rejected.status).toBe(409);
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
    const issued = (await (await s.call("/tickets", {})).json()) as { ticket: string };
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
    return handleErrors(async () => {
      await authenticate(new Request("https://test"), env);
      return new Response(null, { status: 204 });
    });
  }

  expect((await authenticateResponse({} as Env)).status).toBe(503);
  expect(
    (
      await authenticateResponse({
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUD: "aud",
        OWNER_EMAIL: "owner@test",
      } as Env)
    ).status,
  ).toBe(401);
});
