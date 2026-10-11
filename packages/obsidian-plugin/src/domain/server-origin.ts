import { parseServerOrigin } from "@cf-sync/protocol";

import { t } from "../i18n";

export function serverOrigin(value: string): string {
	const origin = parseServerOrigin(value, { allowLocalHttp: false });

	if (origin === undefined) {
		throw new Error(t(($) => $.errors.serverOrigin));
	}

	return origin;
}
