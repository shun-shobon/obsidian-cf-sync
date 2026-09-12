import type { BlobRef } from "@cf-sync/protocol";
import { z } from "zod";

import { ApplicationError } from "../domain/errors";

export class BlobStorage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly vaultId: string,
  ) {}

  async get(key: string): Promise<R2ObjectBody> {
    const object = await this.bucket.get(this.key(key));
    if (!object) throw new ApplicationError("not-found", "Blob not found");
    return object;
  }

  async validate(blob: BlobRef): Promise<void> {
    const object = await this.bucket.head(this.key(blob.key));
    if (!object || object.size !== blob.size || object.customMetadata?.["digest"] !== blob.digest) {
      throw new ApplicationError("invalid-input", "Blob is missing or does not match");
    }
  }

  async upload(key: string, expected: string, request: Request): Promise<BlobRef> {
    const previous = await this.bucket.head(this.key(key));
    if (previous) {
      if (previous.customMetadata?.["digest"] !== expected)
        throw new ApplicationError("conflict", "Blob id reused with different content");
      return { key, size: previous.size, digest: expected };
    }

    if (!request.body) throw new ApplicationError("invalid-input", "Missing body");
    const abort = new AbortController();

    try {
      const length = z.coerce
        .number()
        .int()
        .nonnegative()
        .safe()
        .parse(request.headers.get("X-Content-Size"));
      if (!request.headers.has("X-Content-Size"))
        throw new ApplicationError("length-required", "X-Content-Size required");
      const stream = new FixedLengthStream(length);
      const writing = request.body.pipeTo(stream.writable, { signal: abort.signal });
      const [object] = await Promise.all([
        this.bucket.put(this.key(key), stream.readable, {
          sha256: expected,
          customMetadata: { digest: expected },
        }),
        writing,
      ]);
      if (!object) throw new Error("Blob write failed");
      return { key, size: object.size, digest: expected };
    } catch (error) {
      abort.abort(error);
      if (error instanceof ApplicationError) throw error;
      console.error(error);
      throw new ApplicationError(
        "invalid-input",
        "Blob upload failed; verify digest and request size",
      );
    }
  }

  async collectUnreferenced(referenced: Set<string>): Promise<void> {
    let cursor: string | undefined;

    do {
      const listing = await this.bucket.list({
        prefix: `staging/${this.vaultId}/`,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of listing.objects) {
        const key = object.key.slice(object.key.lastIndexOf("/") + 1);
        if (!referenced.has(key) && object.uploaded.getTime() < Date.now() - 86_400_000)
          await this.bucket.delete(object.key);
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  private key(key: string): string {
    return `staging/${this.vaultId}/${key}`;
  }
}
