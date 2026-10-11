/// <reference types="node" />
import { copyFile, readFile } from "node:fs/promises";

import * as v from "valibot";

const versionSchema = v.object({ version: v.string() });
const manifestPath = "../../manifest.json";
const manifest = v.parse(versionSchema, JSON.parse(await readFile(manifestPath, "utf8")));
const pkg = v.parse(versionSchema, JSON.parse(await readFile("package.json", "utf8")));

if (manifest.version !== pkg.version) throw new Error("Package and manifest versions must match");

await copyFile(manifestPath, "dist/manifest.json");
