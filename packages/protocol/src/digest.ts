import { toHexString } from "lib0/buffer";

export async function digest(bytes: Uint8Array): Promise<string> {
	// Not passed directly: callers hold Uint8Array<ArrayBufferLike>, which WebCrypto does not accept.
	const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));

	return toHexString(new Uint8Array(hash));
}
