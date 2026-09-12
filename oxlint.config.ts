import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["import", "typescript"],
  options: { typeAware: true },
  ignorePatterns: ["**/dist/**", "**/.wrangler/**"],
  rules: {
    "import/newline-after-import": "error",
    "typescript/no-base-to-string": ["warn", { ignoredTypeNames: ["YText"] }],
  },
  overrides: [
    {
      files: ["packages/*/src/**/*.{ts,tsx}"],
      rules: {
        "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      },
    },
  ],
});
