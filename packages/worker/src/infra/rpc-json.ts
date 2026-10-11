import { operationSchema } from "@cf-sync/protocol";
import type { Operation } from "@cf-sync/protocol";
import * as v from "valibot";

export function jsonStream(value: unknown): ReadableStream<Uint8Array> {
	const body: ReadableStream<Uint8Array> | null = Response.json(value).body;

	return body!;
}

export async function readOperation(stream: ReadableStream<Uint8Array>): Promise<Operation> {
	const value = await new Response(stream).json();

	return v.parse(operationSchema, value);
}
