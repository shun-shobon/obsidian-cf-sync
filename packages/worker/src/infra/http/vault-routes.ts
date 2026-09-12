import { idSchema, operationSchema, pathSchema } from "@cf-sync/protocol";
import { Hono, type Context } from "hono";
import * as v from "valibot";

import type { VaultMeta } from "../../domain/vault-state";
import { ApplyOperation } from "../../usecase/apply-operation";
import { BlobStorage } from "../blob-storage";
import type { VaultRepository } from "../vault-repository";
import type { VaultSockets } from "../vault-sockets";

import { notFound, onError } from "./responses";

const revokeSchema = v.object({ deviceId: idSchema });

const exclusionsSchema = v.object({
  exclusions: v.pipe(v.array(pathSchema), v.maxLength(1000)),
});

const digestSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

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
      const { deviceId } = v.parse(revokeSchema, await c.req.json());
      await sockets.revoke(deviceId);

      return c.json({ ok: true });
    });

    this.app.use("*", async (c, next) => {
      const vaultId = v.parse(idSchema, c.req.header("X-Vault-Id"));
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
      const deviceId = v.parse(idSchema, c.req.header("X-Device-Id"));
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

      const operation = v.parse(operationSchema, await c.req.json());
      const result = await operations.execute(operation);

      return c.json(result);
    });

    this.app.get("/files/:id", async (c) => {
      const id = v.parse(idSchema, c.req.param("id"));
      const stored = await this.repository.file(id);
      const content = await this.repository.content(stored);

      return c.json({ file: stored.file, content });
    });

    this.app.put("/exclusions", (c) => this.exclusions(c));

    this.app.post("/tickets", async (c) => {
      const ticket = await this.sockets.issueTicket(c.get("deviceId"));
      await this.repository.schedule();

      return c.json(ticket);
    });

    this.app.get("/blobs/:id", async (c) => {
      const id = v.parse(idSchema, c.req.param("id"));
      const object = await c.get("blobs").get(id);

      return new Response(object.body, { headers: { "Content-Type": "application/octet-stream" } });
    });

    this.app.put("/blobs/:id", (c) => this.uploadBlob(c));
  }

  private async snapshot(c: Context<VaultContext>): Promise<Response> {
    const stored = await this.repository.files();
    const files = stored.map((item) => item.file);

    return c.json({ ...c.get("meta"), files });
  }

  private async exclusions(c: Context<VaultContext>): Promise<Response> {
    const { exclusions } = v.parse(exclusionsSchema, await c.req.json());
    const meta = c.get("meta");
    await this.repository.setExclusions(meta, exclusions);
    await this.repository.schedule();
    this.sockets.broadcast({ type: "settings", revision: meta.revision });

    return this.snapshot(c);
  }

  private async uploadBlob(c: Context<VaultContext>): Promise<Response> {
    const expected = v.parse(digestSchema, c.req.header("X-Content-Digest"));
    const key = v.parse(idSchema, c.req.param("id"));
    const blob = await c.get("blobs").upload(key, expected, c.req.raw);
    await this.repository.schedule();

    return c.json(blob);
  }
}
