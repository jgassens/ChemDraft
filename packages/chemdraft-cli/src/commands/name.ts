import { cliExitCode, defaultCliIo, type CliIo } from "../output";

export const nameCommand = {
  name: "name",
  summary: "Convert chemical names and structures (planned).",
  async run(_argv: readonly string[], io: CliIo = defaultCliIo) {
    io.stderr("name: not implemented yet");
    return cliExitCode.badArguments;
  }
} as const;
