import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

import { ApplicationError, type ErrorKind } from "../../domain/errors";

const statusByKind: Record<ErrorKind, ContentfulStatusCode> = {
  "invalid-input": 400,
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "length-required": 411,
  "upgrade-required": 426,
  unavailable: 503,
};

export const onError: ErrorHandler = (error, c) => {
  if (error instanceof ApplicationError)
    return c.json({ error: error.message }, statusByKind[error.kind]);
  if (error instanceof ZodError) return c.json({ error: error.message }, 400);
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
};

export const notFound: NotFoundHandler = (c) => c.json({ error: "Not found" }, 404);
