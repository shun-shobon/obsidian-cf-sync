import * as v from "valibot";

import { ApplicationError, type ErrorKind } from "../domain/errors";

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: ErrorKind; message: string } };

export async function rpcResult<T>(action: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    if (error instanceof v.ValiError) {
      return { ok: false, error: { kind: "invalid-input", message: error.message } };
    }

    if (!(error instanceof ApplicationError)) {
      throw error;
    }

    return { ok: false, error: { kind: error.kind, message: error.message } };
  }
}

export function unwrapRpcResult<T>(result: RpcResult<T>): T {
  if (!result.ok) {
    throw new ApplicationError(result.error.kind, result.error.message);
  }

  return result.value;
}
