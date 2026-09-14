import * as v from "valibot";

const nonempty = v.pipe(v.string(), v.minLength(1));

export const bindingSchema = v.object({
  serverUrl: nonempty,
  vaultId: nonempty,
  deviceId: nonempty,
});

export type Binding = v.InferOutput<typeof bindingSchema>;

export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const isLocalHttp = url.protocol === "http:" && isLocalhost;

  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Server URL must use HTTPS (HTTP is allowed for localhost)");
  }

  const hasPathOrQuery = url.pathname !== "/" || url.search !== "" || url.hash !== "";
  const hasCredentials = url.username !== "" || url.password !== "";

  if (hasPathOrQuery || hasCredentials) {
    throw new Error("Server URL must contain only an origin");
  }

  return url.origin;
}
