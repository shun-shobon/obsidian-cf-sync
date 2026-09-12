import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { Account } from "../src/infra/durable-objects/account";
import type { Env } from "../src/infra/env";
import { accountApiRoutes } from "../src/infra/http/account-routes";
import { onError } from "../src/infra/http/responses";

function createAccount() {
  const records = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => records.set(key, value),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(storage),
  } as unknown as DurableObjectStorage;
  const account = new Account({ storage } as DurableObjectState, {} as Env);
  const env = {
    ACCOUNT: { getByName: () => account },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(onError);
  app.route("/", accountApiRoutes);

  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
}

describe("account request validation", () => {
  it("trims names and strips unknown fields before persistence", async () => {
    const app = createAccount();
    const id = crypto.randomUUID();
    const response = await app.request("/devices", {
      method: "POST",
      body: JSON.stringify({ id, name: "  Laptop  ", unexpected: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, name: "Laptop", revoked: false });

    const persisted = await app.request(`/devices/${id}`);

    expect(await persisted.json()).toEqual({ id, name: "Laptop", revoked: false });
  });

  it("rejects malformed device IDs before calling the account", async () => {
    const app = createAccount();
    const response = await app.request("/devices/invalid");

    expect(response.status).toBe(400);
  });

  it.each([
    ["/devices/id", "PUT"],
    ["/devices/id/extra", "GET"],
    ["/vaults/id", "DELETE"],
  ])("rejects unsupported account routes: %s %s", async (path, method) => {
    const app = createAccount();
    const response = await app.request(path, { method });

    expect(response.status).toBe(404);
  });

  it.each(["", "   ", "a".repeat(201), null, 42])("rejects an invalid name: %j", async (name) => {
    const app = createAccount();
    const response = await app.request("/devices", {
      method: "POST",
      body: JSON.stringify({ id: crypto.randomUUID(), name }),
    });

    expect(response.status).toBe(400);
  });
});
