import { copyFile, readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== pkg.version) throw new Error("Package and manifest versions must match");
await copyFile("manifest.json", "dist/manifest.json");
