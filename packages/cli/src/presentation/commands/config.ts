import { defineCommand } from "citty";

import { configure } from "../../usecase/configure";
import type { CliContext } from "../context";
import { writeOutput } from "../output";

export function createConfigCommand(context: CliContext) {
  return defineCommand({
    meta: { name: "config", description: "Save Service Token from environment" },
    args: {
      server: { type: "string", description: "Server URL (or CF_SYNC_SERVER_URL)" },
      json: { type: "boolean", description: "Write a JSON result" },
    },
    async run({ args }) {
      const result = await configure(args.server, context.env);

      writeOutput(context, args.json, result, `Saved credentials for ${result.serverUrl}`);
    },
  });
}
