import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import * as v from "valibot";

import { credentialsSchema } from "../../domain/credentials";
import type { Credentials } from "../../domain/credentials";
import { ifExists } from "../fs/error-code";

const configSchema = v.record(v.string(), credentialsSchema);

type Config = v.InferOutput<typeof configSchema>;

function configPath(env: NodeJS.ProcessEnv): string {
	const base = env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");

	return join(base, "obsidian-cf-sync", "config.json");
}

export async function readConfig(env: NodeJS.ProcessEnv): Promise<Config> {
	const text = await ifExists(readFile(configPath(env), "utf8"));

	if (text === undefined) {
		return {};
	}

	return v.parse(configSchema, JSON.parse(text));
}

export async function writeConfig(
	origin: string,
	value: Credentials,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const config = await readConfig(env);
	config[origin] = value;

	const path = configPath(env);
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;

	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}
