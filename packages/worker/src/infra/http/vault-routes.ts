import { idSchema, operationSchema, pathSchema } from "@cf-sync/protocol";
import { Hono, type Context } from "hono";
import { z } from "zod";

import type { VaultMeta } from "../../domain/vault-state";
import { ApplyOperation } from "../../usecase/apply-operation";
import { BlobStorage } from "../blob-storage";
import type { VaultRepository } from "../vault-repository";
import type { VaultSockets } from "../vault-sockets";

import { notFound, onError } from "./responses";

type VaultContext = {
  Variables: { meta: VaultMeta; deviceId: string; blobs: BlobStorage };
};

export class VaultRoutes {
  readonly app = new Hono<VaultContext>();

  constructor(
    private readonly repository: VaultRepository,
    private readonly sockets: VaultSockets,
    bucket: R2Bucket,
  ) {
    this.app.onError(onError);
    this.app.notFound(notFound);
    this.app.post("/revoke", async (c) => {
      const { deviceId } = z.object({ deviceId: idSchema }).parse(await c.req.json());
      await sockets.revoke(deviceId);
      return c.json({ ok: true });
    });
    this.app.use("*", async (c, next) => {
      const vaultId = idSchema.parse(c.req.header("X-Vault-Id"));
      c.set("meta", await repository.initialize(vaultId));
      c.set("blobs", new BlobStorage(bucket, vaultId));
      await next();
    });
    this.app.get("/ws", async (c) => {
      const response = await sockets.connect(c.req.raw);
      await repository.schedule();
      return response;
    });
    this.app.use("*", async (c, next) => {
      const deviceId = idSchema.parse(c.req.header("X-Device-Id"));
      await sockets.assertDeviceActive(deviceId);
      c.set("deviceId", deviceId);
      await next();
    });
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.app.get("/snapshot", (c) => this.snapshot(c));
    this.app.post("/operations", async (c) => {
      const operations = new ApplyOperation(this.repository, this.sockets, c.get("blobs"));
      return c.json(await operations.execute(operationSchema.parse(await c.req.json())));
    });
    this.app.get("/files/:id", async (c) => {
      const stored = await this.repository.file(idSchema.parse(c.req.param("id")));
      return c.json({ file: stored.file, content: await this.repository.content(stored) });
    });
    this.app.put("/exclusions", (c) => this.exclusions(c));
    this.app.post("/tickets", async (c) => {
      const ticket = await this.sockets.issueTicket(c.get("deviceId"));
      await this.repository.schedule();
      return c.json(ticket);
    });
    this.app.get("/blobs/:id", async (c) => {
      const object = await c.get("blobs").get(idSchema.parse(c.req.param("id")));
      return new Response(object.body, { headers: { "Content-Type": "application/octet-stream" } });
    });
    this.app.put("/blobs/:id", (c) => this.uploadBlob(c));
  }

  private async snapshot(c: Context<VaultContext>): Promise<Response> {
    return c.json({
      ...c.get("meta"),
      files: (await this.repository.files()).map((item) => item.file),
    });
  }

  private async exclusions(c: Context<VaultContext>): Promise<Response> {
    const { exclusions } = z
      .object({ exclusions: z.array(pathSchema).max(1000) })
      .parse(await c.req.json());
    const meta = c.get("meta");
    await this.repository.setExclusions(meta, exclusions);
    await this.repository.schedule();
    this.sockets.broadcast({ type: "settings", revision: meta.revision });
    return this.snapshot(c);
  }

  private async uploadBlob(c: Context<VaultContext>): Promise<Response> {
    const expected = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(c.req.header("X-Content-Digest"));
    const key = idSchema.parse(c.req.param("id"));
    const blob = await c.get("blobs").upload(key, expected, c.req.raw);
    await this.repository.schedule();
    return c.json(blob);
  }
}
