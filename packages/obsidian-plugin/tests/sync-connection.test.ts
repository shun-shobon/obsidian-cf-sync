import "./helpers/browser-window";
import type { Operation, OperationResult, ServerMessage } from "@cf-sync/protocol";
import { afterEach, expect, it, vi } from "vitest";

import { ConnectionError } from "../src/domain/connection-error";
import type { ApiPort } from "../src/sync/ports/api-port";
import { SyncConnection } from "../src/sync/service/sync-connection";

const connections: SyncConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect();
  vi.useRealTimers();
});
function setup() {
  const receivers: ((message: ServerMessage) => void)[] = [];
  const send = vi.fn();
  const api = {
    connect: async (receive: (message: ServerMessage) => void) => {
      receivers.push(receive);
      return { send, close: vi.fn() };
    },
  } as unknown as ApiPort;
  const connection = new SyncConnection(api, vi.fn(), () => connection.disconnect());
  connections.push(connection);
  const operation: Operation = {
    type: "delete",
    opId: crypto.randomUUID(),
    fileId: crypto.randomUUID(),
    baseRevision: 1,
  };
  const result: OperationResult = {
    opId: operation.opId,
    revision: 2,
    previousRevision: 1,
    previousPathRevision: 1,
    file: null,
    conflict: false,
  };
  return { connection, receivers, send, operation, result };
}

it("accepts only the response for the outstanding durable operation ID", async () => {
  const { connection, receivers, operation, result, send } = setup();
  await connection.connect();
  let completed = false;
  const pending = connection.operate(operation).then((value) => {
    completed = true;
    return value;
  });
  expect(send).toHaveBeenCalledWith({ type: "operation", operation });
  receivers[0]!({ type: "operation-result", result: { ...result, opId: crypto.randomUUID() } });
  await Promise.resolve();
  expect(completed).toBe(false);
  receivers[0]!({ type: "operation-result", result });
  expect(await pending).toEqual(result);
});

it("rejects an unacknowledged operation on disconnect and ignores late responses after reconnect", async () => {
  const { connection, receivers, operation, result } = setup();
  await connection.connect();
  const first = connection.operate(operation);
  const rejected = expect(first).rejects.toBeInstanceOf(ConnectionError);
  connection.disconnect();
  await rejected;
  await connection.connect();
  let completed = false;
  const retry = connection.operate(operation).then((value) => {
    completed = true;
    return value;
  });
  receivers[0]!({ type: "operation-result", result });
  await Promise.resolve();
  expect(completed).toBe(false);
  receivers[1]!({ type: "operation-result", result });
  expect(await retry).toEqual(result);
});

it("distinguishes permanent operation rejection from transient persistence failures", async () => {
  const { connection, receivers, operation } = setup();
  await connection.connect();
  for (const retryable of [false, true]) {
    const pending = connection.operate(operation);
    const rejected = pending.catch((error: unknown) => error);
    receivers[0]!({
      type: "operation-error",
      opId: operation.opId,
      message: "rejected",
      retryable,
    });
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof ConnectionError).toBe(retryable);
  }
});

it("times out a lost acknowledgement so the persisted operation can be retried", async () => {
  vi.useFakeTimers();
  const { connection, operation } = setup();
  await connection.connect();
  const pending = connection.operate(operation);
  const rejected = expect(pending).rejects.toBeInstanceOf(ConnectionError);
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
