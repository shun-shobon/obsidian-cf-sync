import { describe, expect, it } from "vitest";

import { AccountRepository } from "../src/infra/account-repository";
import { accountRoutes } from "../src/infra/http/account-routes";
import type { DeviceConnections } from "../src/usecase/ports";

function createAccount() {
  const records = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => records.set(key, value),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(storage),
  } as unknown as DurableObjectStorage;
  const repository = new AccountRepository(storage);
  const connections = {} as DeviceConnections;

  return accountRoutes(repository, connections);
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

  it.each(["", "   ", "a".repeat(201), null, 42])("rejects an invalid name: %j", async (name) => {
    const app = createAccount();
    const response = await app.request("/devices", {
      method: "POST",
      body: JSON.stringify({ id: crypto.randomUUID(), name }),
    });

    expect(response.status).toBe(400);
  });
});
