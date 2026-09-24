import type { CliExitCode, CliIo } from "../output";

export interface CliCommand {
  name: string;
  summary: string;
  load: () => Promise<LoadedCliCommand>;
}

export interface LoadedCliCommand {
  run: (argv: readonly string[], io?: CliIo) => Promise<CliExitCode>;
}

/** The complete ChemDraft CLI command table used by dispatch and top-level help. */
export const commands: readonly CliCommand[] = [
  { name: "render", summary: "Render a SMILES structure to SVG or PNG.", load: async () => (await import("./render")).renderCommand },
  { name: "grid", summary: "Render a grid of named SMILES structures.", load: async () => (await import("./grid")).gridCommand },
  { name: "reaction", summary: "Render a reaction scheme from reaction SMILES.", load: async () => (await import("./reaction")).reactionCommand },
  { name: "analyze", summary: "Analyze molecular properties and predictions.", load: async () => (await import("./analyze")).analyzeCommand },
  { name: "name", summary: "Convert chemical names to SMILES with OPSIN.", load: async () => (await import("./name")).nameCommand },
  { name: "stereo", summary: "Inspect tetrahedral and double-bond stereochemistry.", load: async () => (await import("./stereo")).stereoCommand },
  { name: "nmr", summary: "Predict 1H and 13C NMR spectra.", load: async () => (await import("./nmr")).nmrCommand },
  { name: "export", summary: "Export structures to chemistry and document formats.", load: async () => (await import("./export")).exportCommand }
];
