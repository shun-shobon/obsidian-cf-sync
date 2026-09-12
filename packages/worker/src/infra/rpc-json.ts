import { operationSchema, type Operation } from "@cf-sync/protocol";
import * as v from "valibot";

export function jsonStream(value: unknown): ReadableStream<Uint8Array> {
  return Response.json(value).body!;
}

export async function readOperation(stream: ReadableStream<Uint8Array>): Promise<Operation> {
  const value = await new Response(stream).json();

  return v.parse(operationSchema, value);
}
