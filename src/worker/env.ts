export interface Env {
  ACCOUNT: DurableObjectNamespace;
  VAULTS: DurableObjectNamespace;
  BUCKET: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
export async function handleErrors(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof Error && error.name === "ZodError")
      return json({ error: error.message }, 400);
    console.error(error);
    return json({ error: "Internal server error" }, 500);
  }
}
