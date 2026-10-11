import { shun_shobon } from "@shun-shobon/oxlint-config";

export default shun_shobon(
	{ ignores: ["**/dist/**", "**/.wrangler/**"] },
	{
		rules: {
			"import/newline-after-import": "error",
			"typescript/no-base-to-string": ["warn", { ignoredTypeNames: ["YText"] }],
		},
		overrides: [
			{
				files: ["packages/*/src/**/*.{ts,tsx}"],
				rules: {
					"no-ternary": "error",
					curly: "error",
					"max-lines-per-function": [
						"error",
						{ max: 60, skipBlankLines: true, skipComments: true },
					],
				},
			},
			{
				files: ["tests/**", "packages/*/tests/**"],
				rules: {
					"typescript/no-unsafe-type-assertion": "off",
				},
			},
		],
	},
);
