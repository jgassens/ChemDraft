import { cliExitCode, defaultCliIo, type CliIo } from "../output";

export const reactionCommand = {
  name: "reaction",
  summary: "Build reaction documents (planned).",
  async run(_argv: readonly string[], io: CliIo = defaultCliIo) {
    io.stderr("reaction: not implemented yet");
    return cliExitCode.badArguments;
  }
} as const;
