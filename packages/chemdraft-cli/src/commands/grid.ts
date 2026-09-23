import { cliExitCode, defaultCliIo, type CliIo } from "../output";

export const gridCommand = {
  name: "grid",
  summary: "Lay out structures in a grid (planned).",
  async run(_argv: readonly string[], io: CliIo = defaultCliIo) {
    io.stderr("grid: not implemented yet");
    return cliExitCode.badArguments;
  }
} as const;
