import { cliExitCode, defaultCliIo, type CliIo } from "../output";

export const exportCommand = {
  name: "export",
  summary: "Export ChemDraft documents (planned).",
  async run(_argv: readonly string[], io: CliIo = defaultCliIo) {
    io.stderr("export: not implemented yet");
    return cliExitCode.badArguments;
  }
} as const;
