import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlobStorage } from "../src/infra/blob-storage";

const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function storeBody(_key: string, body: ReadableStream) {
	const bytes = await new Response(body).arrayBuffer();

	return { size: bytes.byteLength };
}

function createStorage(put: (key: string, body: ReadableStream) => Promise<unknown> = storeBody) {
	const bucket = { head: async () => null, put } as unknown as R2Bucket;

	return new BlobStorage(bucket, crypto.randomUUID());
}

function emptyStream() {
	return new Blob([]).stream();
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("blob size validation", () => {
	it("distinguishes a missing size header from an invalid value", async () => {
		await expect(
			createStorage().upload("blob", emptyDigest, emptyStream(), null),
		).rejects.toMatchObject({
			kind: "length-required",
		});
	});

	it.each(["-1", "1.5", "Infinity", "NaN", "invalid", "9007199254740992"])(
		"rejects an invalid size: %s",
		async (size) => {
			await expect(
				createStorage().upload("blob", emptyDigest, emptyStream(), size),
			).rejects.toBeInstanceOf(v.ValiError);
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

		const result = await createStorage().upload("blob", emptyDigest, emptyStream(), size);

		expect(result.size).toBe(0);
	});
});

describe("blob upload failures", () => {
	function stubEmptyStream() {
		class LengthStream extends TransformStream {
			constructor(_length: number) {
				super();
			}
		}

		vi.stubGlobal("FixedLengthStream", LengthStream);
	}

	it.each([10037, 10013])("rejects content refused by R2 with code %i", async (code) => {
		stubEmptyStream();
		const storage = createStorage(async () => {
			throw new Error(`put: Content rejected. (${code})`);
		});

		await expect(storage.upload("blob", emptyDigest, emptyStream(), "0")).rejects.toMatchObject({
			kind: "invalid-input",
		});
	});

	it("keeps internal R2 failures as server errors", async () => {
		stubEmptyStream();
		const failure = new Error("put: We encountered an internal error. (10001)");
		const storage = createStorage(async () => {
			throw failure;
		});

		await expect(storage.upload("blob", emptyDigest, emptyStream(), "0")).rejects.toBe(failure);
	});

	it.each(["0", "2"])("rejects a one-byte body declared as %s bytes", async (size) => {
		stubEmptyStream();
		const body = new Blob([new Uint8Array(1)]).stream();

		await expect(createStorage().upload("blob", emptyDigest, body, size)).rejects.toMatchObject({
			kind: "invalid-input",
		});
	});
});
