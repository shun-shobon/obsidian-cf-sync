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
  const account = vi.fn(async () => Response.json({ id: "owner" }));
  const vault = vi.fn<(request: Request) => Promise<Response>>(async () =>
    Response.json({ revision: 1 }),
  );
  const env = {
    ACCOUNT: { idFromName: (id: string) => id, get: () => ({ fetch: account }) },
    VAULTS: { idFromName: (id: string) => id, get: () => ({ fetch: vault }) },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>().route("/api", apiRoutes);
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const call = (path: string, method = "GET") =>
    app.request(
      `https://sync.test/api${path}`,
      {
        method,
        headers: { "X-Device-Id": deviceId },
      },
      env,
    );
  return { account, vault, call, vaultId, deviceId };
}

describe("Public API routes", () => {
  it("authenticates and verifies device and vault before forwarding", async () => {
    const s = setup();
    expect((await s.call(`/vaults/${s.vaultId}/snapshot`)).status).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(s.account).toHaveBeenNthCalledWith(1, `https://internal/devices/${s.deviceId}`);
    expect(s.account).toHaveBeenNthCalledWith(2, `https://internal/vaults/${s.vaultId}`);
    const request = s.vault.mock.calls[0]![0];
    expect(request.url).toBe("https://internal/snapshot");
    expect(request.headers.get("X-Vault-Id")).toBe(s.vaultId);
    expect(request.headers.get("X-Device-Id")).toBe(s.deviceId);
  });

  it.each([
    ["/snapshot", "POST"],
    ["/snapshot/extra", "GET"],
    ["/revoke", "POST"],
    ["/ws", "GET"],
  ])("does not forward unsupported vault route %s with %s", async (path, method) => {
    const s = setup();
    expect((await s.call(`/vaults/${s.vaultId}${path}`, method)).status).toBe(404);
    expect(s.account).not.toHaveBeenCalled();
    expect(s.vault).not.toHaveBeenCalled();
  });

  it("fails before forwarding when authentication rejects a request", async () => {
    const s = setup();
    vi.mocked(authenticate).mockRejectedValue(new ApplicationError("unauthenticated", "Denied"));
    expect((await s.call("/devices")).status).toBe(401);
    expect(s.account).not.toHaveBeenCalled();
  });

  it("converts a vault ticket to a no-store public websocket URL", async () => {
    const s = setup();
    s.vault.mockImplementation(async () => Response.json({ ticket: "secret", expiresAt: 123 }));
    const response = await s.call(`/vaults/${s.vaultId}/tickets`, "POST");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      url: `wss://sync.test/ws?vault=${s.vaultId}&ticket=secret`,
      expiresAt: 123,
    });
  });
});
