import * as v from "valibot";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseServerOrigin(
	value: string,
	options: { allowLocalHttp: boolean },
): string | undefined {
	if (!URL.canParse(value)) {
		return undefined;
	}

	const url = new URL(value);
	const isLocalHttp =
		options.allowLocalHttp && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);

	if (url.protocol !== "https:" && !isLocalHttp) {
		return undefined;
	}

	const hasCredentials = url.username !== "" || url.password !== "";
	const hasExtraComponents = url.pathname !== "/" || url.search !== "" || url.hash !== "";

	if (hasCredentials || hasExtraComponents) {
		return undefined;
	}

	return url.origin;
}

export const connectionTicketSchema = v.object({ url: v.pipe(v.string(), v.url()) });
