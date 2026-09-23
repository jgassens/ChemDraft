import { cliExitCode, defaultCliIo, type CliIo } from "../output";

export const stereoCommand = {
  name: "stereo",
  summary: "Inspect stereochemistry (planned).",
  async run(_argv: readonly string[], io: CliIo = defaultCliIo) {
    io.stderr("stereo: not implemented yet");
    return cliExitCode.badArguments;
  }
} as const;
