import { Hono } from "hono";

import worker from "../../packages/worker/src/index";
import { Vault } from "../../packages/worker/src/infra/durable-objects/vault";
import type { Env } from "../../packages/worker/src/infra/env";
import { jsonStream } from "../../packages/worker/src/infra/rpc-json";

export { AccountDO } from "../../packages/worker/src/index";

export class TestVault extends Vault {
	private readonly incarnation = crypto.randomUUID();

	async runtimeState() {
		return {
			incarnation: this.incarnation,
			alarm: await this.ctx.storage.getAlarm(),
			connections: this.ctx.getWebSockets().length,
		};
	}

	async echoJson(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
		const value: unknown = await new Response(body).json();
		return jsonStream(value);
	}

	async flushNow(): Promise<void> {
		const pending = await this.ctx.storage.get<number>("maintenance:flush");

		if (pending !== undefined) {
			await this.ctx.storage.put("maintenance:flush", Date.now());
		}

		await this.alarm();
	}
}

type TestEnv = Omit<Env, "VAULTS"> & { VAULTS: DurableObjectNamespace<TestVault> };

const app = new Hono<{ Bindings: TestEnv }>();

// Test-only hooks into the Vault DO; every other request goes through the production Worker.
app.get("/test/vaults/:vaultId/runtime-state", async (c) => {
	const vault = c.env.VAULTS.getByName(c.req.param("vaultId"));

	return c.json(await vault.runtimeState());
});

app.post("/test/vaults/:vaultId/flush", async (c) => {
	const vault = c.env.VAULTS.getByName(c.req.param("vaultId"));
	await vault.flushNow();

	return c.json({ ok: true });
});

app.post("/test/vaults/:vaultId/echo-json", async (c) => {
	const vault = c.env.VAULTS.getByName(c.req.param("vaultId"));
	const value: unknown = await c.req.json();
	const stream = await vault.echoJson(jsonStream(value));

	return new Response(stream, { headers: { "Content-Type": "application/json" } });
});

app.mount("/", worker.fetch);

export default app;
