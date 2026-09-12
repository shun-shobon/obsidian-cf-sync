import { ApplicationError, type ErrorKind } from "../../domain/errors";

const statusByKind: Record<ErrorKind, number> = {
  "invalid-input": 400,
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "length-required": 411,
  "upgrade-required": 426,
  unavailable: 503,
};

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export async function handleErrors(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ApplicationError)
      return json({ error: error.message }, statusByKind[error.kind]);
    if (error instanceof Error && error.name === "ZodError")
      return json({ error: error.message }, 400);
    console.error(error);
    return json({ error: "Internal server error" }, 500);
  }
}
