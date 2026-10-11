import { shun_shobon } from "@shun-shobon/oxfmt-config";

export default shun_shobon(
	{},
	{ ignorePatterns: ["**/dist/**", "**/.wrangler/**", "pnpm-lock.yaml", "mise.lock"] },
);
