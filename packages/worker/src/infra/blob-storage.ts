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

// R2 bindings expose API error codes only as a message suffix: BadDigest and IncompleteBody.
const R2_CONTENT_ERRORS = [10037, 10013];

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
		const sizeMatches = object?.size === blob.size;
		const digestMatches = object?.customMetadata?.["digest"] === blob.digest;

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

		if (sizeHeader == null) {
			throw new ApplicationError("length-required", "X-Content-Size required");
		}

		const length = v.parse(contentSizeSchema, sizeHeader);
		const object = await this.store(key, expected, body, length);

		if (!object) {
			throw new ApplicationError("conflict", "Blob was uploaded concurrently");
		}

		return { key, size: object.size, digest: expected };
	}

	async collectUnreferenced(referenced: Set<string>): Promise<number | null> {
		const prefix = `staging/${this.vaultId}/`;
		let listing = await this.bucket.list({ prefix });
		let nextExpiry = await this.deleteExpired(listing.objects, referenced, null);

		while (listing.truncated) {
			listing = await this.bucket.list({ prefix, cursor: listing.cursor });
			nextExpiry = await this.deleteExpired(listing.objects, referenced, nextExpiry);
		}

		return nextExpiry;
	}

	private async deleteExpired(
		objects: R2Object[],
		referenced: Set<string>,
		currentExpiry: number | null,
	): Promise<number | null> {
		let nextExpiry = currentExpiry;

		for (const object of objects) {
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

			if (nextExpiry == null || expiresAt < nextExpiry) {
				nextExpiry = expiresAt;
			}
		}

		return nextExpiry;
	}

	private async store(
		key: string,
		expected: string,
		body: ReadableStream<Uint8Array>,
		length: number,
	): Promise<R2Object | null> {
		const stream = new FixedLengthStream(length);
		const counter = new ByteCounter(length);
		const abort = new AbortController();
		const writing = body
			.pipeThrough(counter.stream)
			.pipeTo(stream.writable, { signal: abort.signal });
		const putting = this.bucket.put(this.key(key), stream.readable, {
			onlyIf: { etagDoesNotMatch: "*" },
			sha256: expected,
			customMetadata: { digest: expected },
		});
		const [written, put] = await Promise.allSettled([
			writing,
			putting.catch((error: unknown) => {
				abort.abort(error);
				throw error;
			}),
		]);

		if (counter.mismatched) {
			throw new ApplicationError("invalid-input", "Blob body does not match X-Content-Size");
		}

		if (put.status === "rejected") {
			throwPutError(put.reason);
		}

		if (written.status === "rejected") {
			throw written.reason;
		}

		return put.value;
	}

	private key(key: string): string {
		return `staging/${this.vaultId}/${key}`;
	}
}

class ByteCounter {
	mismatched = false;
	readonly stream: TransformStream<Uint8Array, Uint8Array>;

	constructor(length: number) {
		let received = 0;

		this.stream = new TransformStream({
			transform: (chunk, controller) => {
				received += chunk.byteLength;
				this.mismatched ||= received > length;
				controller.enqueue(chunk);
			},
			flush: () => {
				this.mismatched ||= received !== length;
			},
		});
	}
}

function throwPutError(error: unknown): never {
	const rejectedContent =
		error instanceof Error && R2_CONTENT_ERRORS.some((code) => error.message.endsWith(`(${code})`));

	if (rejectedContent) {
		throw new ApplicationError("invalid-input", "Blob content does not match the request");
	}

	throw error;
}
