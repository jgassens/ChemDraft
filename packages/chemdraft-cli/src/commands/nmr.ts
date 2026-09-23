import { cliExitCode, defaultCliIo, type CliIo } from "../output";

export const nmrCommand = {
  name: "nmr",
  summary: "Predict NMR spectra (planned).",
  async run(_argv: readonly string[], io: CliIo = defaultCliIo) {
    io.stderr("nmr: not implemented yet");
    return cliExitCode.badArguments;
  }
} as const;
