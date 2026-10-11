import { operationSchema } from "@cf-sync/protocol";
import type { Operation } from "@cf-sync/protocol";
import * as v from "valibot";

import { ApplicationError } from "../domain/errors";

export function jsonStream(value: unknown): ReadableStream<Uint8Array> {
	const body: ReadableStream<Uint8Array> | null = Response.json(value).body;

	return body!;
}

export async function readOperation(stream: ReadableStream<Uint8Array> | null): Promise<Operation> {
	let value: unknown;

	try {
		value = await new Response(stream).json();
	} catch {
		throw new ApplicationError("invalid-input", "Invalid JSON");
	}

	return v.parse(operationSchema, value);
}
