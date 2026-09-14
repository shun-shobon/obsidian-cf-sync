import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  clean: true,
  deps: { alwaysBundle: [/./] },
  outputOptions: { entryFileNames: "[name].js" },
});
