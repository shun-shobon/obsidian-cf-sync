import { defineConfig } from "oxlint";
export default defineConfig({
  options: { typeAware: true },
  ignorePatterns: ["dist/**", ".wrangler/**"],
  rules: {
    "typescript/no-base-to-string": ["warn", { ignoredTypeNames: ["YText"] }],
  },
});
