import type { Operation } from "@cf-sync/protocol";
import { Hono } from "hono";

import { Account } from "../../packages/worker/src/infra/durable-objects/account";
import { Vault } from "../../packages/worker/src/infra/durable-objects/vault";
import type { Env } from "../../packages/worker/src/infra/env";
import { onError } from "../../packages/worker/src/infra/http/responses";
import { jsonStream } from "../../packages/worker/src/infra/rpc-json";
import { unwrapRpcResult } from "../../packages/worker/src/infra/rpc-result";

export { Account };

export class TestVault extends Vault {
  async echoJson(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
    const value: unknown = await new Response(body).json();
    return jsonStream(value);
  }

  async flushNow(): Promise<void> {
    await this.alarm();
  }
}

type TestContext = {
  Bindings: Env;
  Variables: { vault: DurableObjectStub<TestVault>; vaultId: string; deviceId: string };
};

const app = new Hono<TestContext>();

app.onError(onError);

app.use("*", async (c, next) => {
  const vaultId = c.req.header("X-Vault-Id");

  if (!vaultId) {
    return c.text("Missing test vault", 400);
  }

  const namespace = c.env.VAULTS as unknown as DurableObjectNamespace<TestVault>;
  c.set("vault", namespace.get(namespace.idFromName(vaultId)));
  c.set("vaultId", vaultId);
  c.set("deviceId", c.req.header("X-Device-Id") ?? "");
  return next();
});

app.get("/snapshot", async (c) => {
  const result = await c.get("vault").snapshot(c.get("vaultId"), c.get("deviceId"));
  return new Response(unwrapRpcResult(result), { headers: { "Content-Type": "application/json" } });
});

app.post("/operations", async (c) => {
  const operation = await c.req.json<Operation>();
  const result = await c
    .get("vault")
    .applyOperation(c.get("vaultId"), c.get("deviceId"), jsonStream(operation));
  return c.json(unwrapRpcResult(result));
});

app.get("/files/:id", async (c) => {
  const result = await c
    .get("vault")
    .document(c.get("vaultId"), c.get("deviceId"), c.req.param("id"));
  return new Response(unwrapRpcResult(result), { headers: { "Content-Type": "application/json" } });
});

app.put("/exclusions", async (c) => {
  const { exclusions } = await c.req.json<{ exclusions: string[] }>();
  const result = await c
    .get("vault")
    .setExclusions(c.get("vaultId"), c.get("deviceId"), exclusions);
  return new Response(unwrapRpcResult(result), { headers: { "Content-Type": "application/json" } });
});

app.post("/tickets", async (c) => {
  const result = await c.get("vault").issueTicket(c.get("vaultId"), c.get("deviceId"));
  return c.json(unwrapRpcResult(result));
});

app.get("/blobs/:id", async (c) => {
  const result = await c
    .get("vault")
    .downloadBlob(c.get("vaultId"), c.get("deviceId"), c.req.param("id"));
  return new Response(unwrapRpcResult(result));
});

app.put("/blobs/:id", async (c) => {
  const digest = c.req.header("X-Content-Digest");

  if (!digest) {
    return c.text("Missing digest", 400);
  }

  const result = await c
    .get("vault")
    .uploadBlob(
      c.get("vaultId"),
      c.get("deviceId"),
      c.req.param("id"),
      digest,
      c.req.raw.body,
      c.req.raw.headers.get("X-Content-Size"),
    );
  return c.json(unwrapRpcResult(result));
});

app.post("/revoke", async (c) => {
  const { deviceId } = await c.req.json<{ deviceId: string }>();
  return c.json(unwrapRpcResult(await c.get("vault").revokeDevice(deviceId)));
});

app.get("/flush", async (c) => {
  await c.get("vault").flushNow();
  return c.json({ ok: true });
});

app.post("/echo-json", async (c) => {
  const value: unknown = await c.req.json();
  const stream = await c.get("vault").echoJson(jsonStream(value));
  return new Response(stream, { headers: { "Content-Type": "application/json" } });
});

app.get("/ws", (c) => c.get("vault").fetch(c.req.raw));

export default app;
