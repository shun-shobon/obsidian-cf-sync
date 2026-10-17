import { defineCommand } from "citty";

import { planSynchronization, synchronizeVault } from "../../usecase/synchronize-vault";
import type { CliContext } from "../context";
import { formatPlan, formatSyncResult, syncExitCode, writeOutput } from "../output";

export function createSyncCommand(context: CliContext) {
	return defineCommand({
		meta: { name: "sync", description: "Perform one bidirectional synchronization" },
		args: {
			directory: { type: "positional", description: "Local Vault directory", default: "." },
			json: { type: "boolean", description: "Write a JSON result" },
			"dry-run": { type: "boolean", description: "Show planned changes without applying them" },
		},
		async run({ args }) {
			if (args["dry-run"] === true) {
				const plan = await planSynchronization(args.directory, context.env);

				writeOutput(context, args.json, { dryRun: true, ...plan }, formatPlan(plan));
				return;
			}

			const result = await synchronizeVault(args.directory, context.env);

			writeOutput(context, args.json, result, formatSyncResult(result));
			context.exitCode = syncExitCode(result);
		},
	});
}
