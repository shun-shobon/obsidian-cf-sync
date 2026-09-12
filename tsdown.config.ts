import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { main: "src/plugin/main.ts" },
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ["obsidian", /^@codemirror\//, /^@lezer\//],
    alwaysBundle: ["yjs", "y-codemirror.next", "y-protocols", "lib0", "zod"],
  },
  outputOptions: { entryFileNames: "[name].js" },
});
