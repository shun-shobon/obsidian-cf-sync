import { defineConfig } from "oxfmt";
export default defineConfig({
  ignorePatterns: ["dist/**", ".wrangler/**", "pnpm-lock.yaml", "mise.lock"],
  sortImports: { groups: ["builtin", "external", "internal", "parent", "sibling", "index"] },
  sortPackageJson: { sortScripts: true },
});
