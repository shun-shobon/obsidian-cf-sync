import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { ApplicationError } from "../src/domain/errors";
import { authenticate } from "../src/infra/access-auth";
import type { Env } from "../src/infra/env";
import { apiRoutes } from "../src/infra/http/api-routes";

vi.mock("../src/infra/access-auth", () => ({ authenticate: vi.fn() }));

function setup() {
  vi.mocked(authenticate).mockReset();
  vi.mocked(authenticate).mockResolvedValue(undefined);

  const account = {
    device: vi.fn(async () => ({ ok: true, value: { id: "owner" } })),
    vault: vi.fn(async () => ({ ok: true, value: { id: "vault" } })),
    devices: vi.fn(async () => ({ ok: true, value: [] })),
  };
  const vault = {
    snapshot: vi.fn(async () => ({ ok: true, value: Response.json({ revision: 1 }).body! })),
    issueTicket: vi.fn(async () => ({ ok: true, value: { ticket: "secret", expiresAt: 123 } })),
  };
  const env = {
    ACCOUNT: { getByName: () => account },
    VAULTS: { getByName: () => vault },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>().route("/api", apiRoutes);
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const call = (path: string, method = "GET") =>
    app.request(
      `https://sync.test/api${path}`,
      { method, headers: { "X-Device-Id": deviceId } },
      env,
    );

  return { account, vault, call, vaultId, deviceId };
}

describe("Public API routes", () => {
  it("authenticates and verifies device and vault before calling RPC", async () => {
    const s = setup();

    expect((await s.call(`/vaults/${s.vaultId}/snapshot`)).status).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(s.account.device).toHaveBeenCalledExactlyOnceWith(s.deviceId);
    expect(s.account.vault).toHaveBeenCalledExactlyOnceWith(s.vaultId);
    expect(s.vault.snapshot).toHaveBeenCalledExactlyOnceWith(s.vaultId, s.deviceId);
  });

  it.each([
    ["/snapshot", "POST"],
    ["/snapshot/extra", "GET"],
    ["/revoke", "POST"],
    ["/ws", "GET"],
  ])("rejects unsupported vault route %s with %s", async (path, method) => {
    const s = setup();

    expect((await s.call(`/vaults/${s.vaultId}${path}`, method)).status).toBe(404);
    expect(s.vault.snapshot).not.toHaveBeenCalled();
    expect(s.vault.issueTicket).not.toHaveBeenCalled();
  });

  it("fails before RPC when authentication rejects a request", async () => {
    const s = setup();
    vi.mocked(authenticate).mockRejectedValue(new ApplicationError("unauthenticated", "Denied"));

    expect((await s.call("/devices")).status).toBe(401);
    expect(s.account.devices).not.toHaveBeenCalled();
  });

  it("converts a vault ticket to a no-store public websocket URL", async () => {
    const s = setup();
    const response = await s.call(`/vaults/${s.vaultId}/tickets`, "POST");

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      url: `wss://sync.test/ws?vault=${s.vaultId}&ticket=secret`,
      expiresAt: 123,
    });
  });
});
