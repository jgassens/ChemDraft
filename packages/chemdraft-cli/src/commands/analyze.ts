import { cliExitCode, defaultCliIo, type CliIo } from "../output";

export const analyzeCommand = {
  name: "analyze",
  summary: "Analyze chemical structures (planned).",
  async run(_argv: readonly string[], io: CliIo = defaultCliIo) {
    io.stderr("analyze: not implemented yet");
    return cliExitCode.badArguments;
  }
} as const;
