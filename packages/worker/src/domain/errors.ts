export type ErrorKind =
  | "invalid-input"
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "length-required"
  | "upgrade-required"
  | "unavailable";

export class ApplicationError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}
