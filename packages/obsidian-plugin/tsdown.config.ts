import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: "cjs",
  platform: "browser",
  // CommonJS is Obsidian's output format; dependency resolution must still target the browser.
  inputOptions: { platform: "browser" },
  target: "es2022",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  clean: true,
  plugins: [
    {
      name: "obsidian-host-imports",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          for (const dependency of output.imports) {
            if (!/^(obsidian|@codemirror\/[^/]+|@lezer\/[^/]+)$/.test(dependency)) {
              this.error(`Unexpected runtime dependency in the Obsidian bundle: ${dependency}`);
            }
          }
        }
      },
    },
  ],
  deps: {
    neverBundle: ["obsidian", /^@codemirror\//, /^@lezer\//],
    alwaysBundle: [
      "@cf-sync/protocol",
      "js-base64",
      "yjs",
      "y-codemirror.next",
      "y-protocols",
      /^lib0(?:\/|$)/,
      "zod",
    ],
  },
  outputOptions: { entryFileNames: "[name].js" },
});
