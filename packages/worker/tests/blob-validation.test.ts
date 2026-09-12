import { afterEach, describe, expect, it, vi } from "vitest";

import { BlobStorage } from "../src/infra/blob-storage";

const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function createStorage() {
  const bucket = {
    head: async () => null,
    put: async (_key: string, body: ReadableStream) => {
      const bytes = await new Response(body).arrayBuffer();

      return { size: bytes.byteLength };
    },
  } as unknown as R2Bucket;

  return new BlobStorage(bucket, crypto.randomUUID());
}

function body() {
  return new Blob([]).stream();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("blob size validation", () => {
  it("distinguishes a missing size header from an invalid value", async () => {
    await expect(createStorage().upload("blob", emptyDigest, body(), null)).rejects.toMatchObject({
      kind: "length-required",
    });
  });

  it.each(["-1", "1.5", "Infinity", "NaN", "invalid", "9007199254740992"])(
    "rejects an invalid size: %s",
    async (size) => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(createStorage().upload("blob", emptyDigest, body(), size)).rejects.toMatchObject(
        {
          kind: "invalid-input",
        },
      );
    },
  );

  it.each(["", " ", "0", "0x0"])("retains numeric header coercion: %j", async (size) => {
    class EmptyStream extends TransformStream {
      constructor(length: number) {
        super();
        expect(length).toBe(0);
      }
    }

    vi.stubGlobal("FixedLengthStream", EmptyStream);

    const result = await createStorage().upload("blob", emptyDigest, body(), size);

    expect(result.size).toBe(0);
  });
});
