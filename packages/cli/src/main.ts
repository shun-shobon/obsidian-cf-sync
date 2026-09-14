#!/usr/bin/env node
import { runMain } from "citty";

import { createCommands } from "./presentation/commands";
import type { CliContext } from "./presentation/context";

const context: CliContext = { env: process.env, output: console.log, exitCode: 0 };

await runMain(createCommands(context));

process.exitCode = context.exitCode;
