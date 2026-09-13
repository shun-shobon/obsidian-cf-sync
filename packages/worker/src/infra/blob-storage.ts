import type { BlobRef } from "@cf-sync/protocol";
import * as v from "valibot";

import { ApplicationError } from "../domain/errors";

const contentSizeSchema = v.pipe(
  v.string(),
  v.transform(Number),
  v.number(),
  v.safeInteger(),
  v.minValue(0),
);

export class BlobStorage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly vaultId: string,
  ) {}

  async get(key: string): Promise<R2ObjectBody> {
    const object = await this.bucket.get(this.key(key));

    if (!object) {
      throw new ApplicationError("not-found", "Blob not found");
    }

    return object;
  }

  async validate(blob: BlobRef): Promise<void> {
    const object = await this.bucket.head(this.key(blob.key));

    if (!object) {
      throw new ApplicationError("invalid-input", "Blob is missing or does not match");
    }

    const sizeMatches = object.size === blob.size;
    const digestMatches = object.customMetadata?.["digest"] === blob.digest;

    if (!sizeMatches || !digestMatches) {
      throw new ApplicationError("invalid-input", "Blob is missing or does not match");
    }
  }

  async upload(
    key: string,
    expected: string,
    body: ReadableStream<Uint8Array> | null,
    sizeHeader: string | null,
  ): Promise<BlobRef> {
    const previous = await this.bucket.head(this.key(key));

    if (previous) {
      if (previous.customMetadata?.["digest"] !== expected) {
        throw new ApplicationError("conflict", "Blob id reused with different content");
      }

      return { key, size: previous.size, digest: expected };
    }

    if (!body) {
      throw new ApplicationError("invalid-input", "Missing body");
    }

    const abort = new AbortController();

    try {
      if (sizeHeader === null) {
        throw new ApplicationError("length-required", "X-Content-Size required");
      }

      const length = v.parse(contentSizeSchema, sizeHeader);
      const stream = new FixedLengthStream(length);
      const writing = body.pipeTo(stream.writable, { signal: abort.signal });
      const [object] = await Promise.all([
        this.bucket.put(this.key(key), stream.readable, {
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: expected,
          customMetadata: { digest: expected },
        }),
        writing,
      ]);

      if (!object) {
        throw new Error("Blob write failed");
      }

      return { key, size: object.size, digest: expected };
    } catch (error) {
      abort.abort(error);

      if (error instanceof ApplicationError) {
        throw error;
      }

      console.error(error);
      throw new ApplicationError(
        "invalid-input",
        "Blob upload failed; verify digest and request size",
      );
    }
  }

  async collectUnreferenced(referenced: Set<string>): Promise<number | null> {
    let cursor: string | undefined;
    let nextExpiry: number | null = null;

    while (true) {
      const options: R2ListOptions = { prefix: `staging/${this.vaultId}/` };

      if (cursor) {
        options.cursor = cursor;
      }

      const listing = await this.bucket.list(options);

      for (const object of listing.objects) {
        const key = object.key.slice(object.key.lastIndexOf("/") + 1);
        const isReferenced = referenced.has(key);
        if (isReferenced) {
          continue;
        }

        const expiresAt = object.uploaded.getTime() + 86_400_000;

        if (expiresAt <= Date.now()) {
          await this.bucket.delete(object.key);
          continue;
        }

        if (nextExpiry === null || expiresAt < nextExpiry) {
          nextExpiry = expiresAt;
        }
      }

      if (!listing.truncated) {
        return nextExpiry;
      }

      cursor = listing.cursor;
    }
  }

  private key(key: string): string {
    return `staging/${this.vaultId}/${key}`;
  }
}
