import type { CliExitCode, CliIo } from "../output";

import { analyzeCommand } from "./analyze";
import { exportCommand } from "./export";
import { gridCommand } from "./grid";
import { nameCommand } from "./name";
import { nmrCommand } from "./nmr";
import { reactionCommand } from "./reaction";
import { renderCommand } from "./render";
import { stereoCommand } from "./stereo";

export interface CliCommand {
  name: string;
  summary: string;
  run: (argv: readonly string[], io?: CliIo) => Promise<CliExitCode>;
}

/** The complete ChemDraft CLI command table used by dispatch and top-level help. */
export const commands: readonly CliCommand[] = [
  renderCommand,
  gridCommand,
  reactionCommand,
  analyzeCommand,
  nameCommand,
  stereoCommand,
  nmrCommand,
  exportCommand
];
