#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commands } from "./commands";
import {
  cliExitCode,
  defaultCliIo,
  type CliExitCode,
  type CliIo
} from "./output";

const HELP = `ChemDraft command-line tools

Usage:
  pnpm chemdraft <subcommand> [options]
  chemdraft <subcommand> [options]

Subcommands:
${commands.map((command) => `  ${command.name.padEnd(10)} ${command.summary}`).join("\n")}

Run chemdraft <subcommand> --help for command-specific usage.`;

/** Dispatch a ChemDraft CLI subcommand and return its process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  if (argv.length === 1 && argv[0] === "--help") {
    io.stdout(HELP);
    return cliExitCode.ok;
  }
  if (argv.length === 0) {
    io.stderr("Error: a subcommand is required.");
    io.stderr(HELP);
    return cliExitCode.badArguments;
  }

  const [name, ...commandArgv] = argv;
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    io.stderr(`Error: unknown subcommand "${name}".`);
    io.stderr("Run pnpm chemdraft --help for usage.");
    return cliExitCode.badArguments;
  }
  return command.run(commandArgv, io);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) process.exitCode = await runCli(process.argv.slice(2));
