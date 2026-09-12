import { fromUint8Array } from "js-base64";

export function random(): string {
  return fromUint8Array(crypto.getRandomValues(new Uint8Array(32)), true);
}

export async function challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

  return fromUint8Array(new Uint8Array(hash), true);
}
