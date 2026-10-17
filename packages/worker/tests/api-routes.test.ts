import { Hono } from "hono";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";

import { ApplicationError } from "../src/domain/errors";
import { authenticate } from "../src/infra/access-auth";
import { Account } from "../src/infra/durable-objects/account";
import type { Env } from "../src/infra/env";
import { apiRoutes } from "../src/infra/http/api-routes";
import { onError } from "../src/infra/http/responses";

vi.mock("../src/infra/access-auth", () => ({ authenticate: vi.fn() }));

function setup() {
	vi.mocked(authenticate).mockReset();
	vi.mocked(authenticate).mockResolvedValue(undefined);

	const account = {
		authorizeVaultAccess: vi.fn(async () => ({ ok: true, value: undefined })),
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
	app.onError(onError);
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
		expect(s.account.authorizeVaultAccess).toHaveBeenCalledExactlyOnceWith(s.deviceId, s.vaultId);
		expect(s.vault.snapshot).toHaveBeenCalledExactlyOnceWith(s.vaultId);
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

	it("withholds a ticket when the device was deleted while it was issued", async () => {
		const s = setup();
		s.account.authorizeVaultAccess.mockResolvedValueOnce({ ok: true, value: undefined });
		s.account.authorizeVaultAccess.mockResolvedValueOnce({
			ok: false,
			error: { kind: "forbidden", message: "Unknown device" },
		} as never);

		expect((await s.call(`/vaults/${s.vaultId}/tickets`, "POST")).status).toBe(403);
		expect(s.vault.issueTicket).toHaveBeenCalledOnce();
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

function accountApi() {
	vi.mocked(authenticate).mockReset();
	vi.mocked(authenticate).mockResolvedValue(undefined);

	const records = new Map<string, unknown>();
	const storage = {
		get: async (key: string) => records.get(key),
		put: async (key: string, value: unknown) => records.set(key, value),
		delete: async (key: string) => records.delete(key),
		list: async ({ prefix }: { prefix: string }) =>
			new Map([...records].filter(([key]) => key.startsWith(prefix))),
	} as unknown as DurableObjectStorage;
	const vault = {
		snapshot: vi.fn(async () => ({ ok: true, value: Response.json({ revision: 1 }).body! })),
		issueTicket: vi.fn(async () => ({ ok: true, value: { ticket: "secret", expiresAt: 123 } })),
		removeDevice: vi.fn(async () => ({ ok: true, value: undefined })),
	};
	const env = {
		ACCOUNT: { getByName: () => account },
		VAULTS: { getByName: () => vault },
	} as unknown as Env;
	const account = new Account({ storage } as DurableObjectState, env);
	const app = new Hono<{ Bindings: Env }>().route("/api", apiRoutes);
	app.onError(onError);
	const deviceId = crypto.randomUUID();
	const vaultId = crypto.randomUUID();
	const call = (path: string, method = "GET", body?: unknown) =>
		app.request(
			`https://sync.test/api${path}`,
			{ method, headers: { "X-Device-Id": deviceId }, body: JSON.stringify(body) },
			env,
		);

	return { records, vault, call, deviceId, vaultId };
}

describe("Device deletion", () => {
	it("rejects a deleted device until the same ID registers again", async () => {
		const s = accountApi();
		vi.spyOn(console, "info").mockImplementation(() => {});
		await s.call("/devices", "POST", { id: s.deviceId, name: "Laptop" });
		await s.call("/vaults", "POST", { id: s.vaultId, name: "Notes" });

		expect((await s.call(`/vaults/${s.vaultId}/snapshot`)).status).toBe(200);
		expect((await s.call(`/devices/${s.deviceId}`, "DELETE")).status).toBe(200);
		expect(s.vault.removeDevice).toHaveBeenCalledExactlyOnceWith(s.deviceId);
		expect(await (await s.call("/devices")).json()).toEqual([]);
		expect((await s.call(`/vaults/${s.vaultId}/snapshot`)).status).toBe(403);
		expect((await s.call(`/vaults/${s.vaultId}/tickets`, "POST")).status).toBe(403);

		await s.call("/devices", "POST", { id: s.deviceId, name: "Laptop" });

		expect((await s.call(`/vaults/${s.vaultId}/snapshot`)).status).toBe(200);
		expect((await s.call(`/vaults/${s.vaultId}/tickets`, "POST")).status).toBe(200);
	});

	it("keeps the device shape required by released plugins and hides revoked records", async () => {
		const s = accountApi();
		vi.spyOn(console, "info").mockImplementation(() => {});
		const revokedId = crypto.randomUUID();
		s.records.set(`device:${revokedId}`, { id: revokedId, name: "Old", revoked: true });
		const registered = await s.call("/devices", "POST", { id: s.deviceId, name: "Laptop" });
		const releasedDeviceSchema = v.object({
			id: v.string(),
			name: v.string(),
			revoked: v.boolean(),
		});

		expect(v.parse(releasedDeviceSchema, await registered.json())).toEqual({
			id: s.deviceId,
			name: "Laptop",
			revoked: false,
		});
		expect(v.parse(v.array(releasedDeviceSchema), await (await s.call("/devices")).json())).toEqual(
			[{ id: s.deviceId, name: "Laptop", revoked: false }],
		);

		const restored = await s.call("/devices", "POST", { id: revokedId, name: "Old" });

		expect(restored.status).toBe(200);
		expect(await (await s.call("/devices")).json()).toHaveLength(2);
	});
});
