import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";

import {
  insertNativeTextObject,
  insertSmilesMolecule,
  nativeTextObjectSizeForText
} from "../../../../apps/desktop/src/documentWorkflow";
import { integerOption, numericOption, parseOptions, stringOption } from "../args";
import {
  cropDocumentSvgToContent,
  depictSmiles,
  renderDefaults,
  svgToPng,
  type RenderBackground,
  type SmilesDepictionResult
} from "../document";
import { installNodeEngines } from "../engine";
import {
  CliUsageError,
  cliExitCode,
  defaultCliIo,
  handleCliError,
  parseNamedSmilesJob,
  readBatchFile,
  writeJsonLine,
  writeProgress,
  type CliExitCode,
  type CliIo
} from "../output";

export interface GridJob {
  name: string;
  smiles: string;
}

export type GridLabels = "none" | "letters" | "names";
type GridOutputFormat = "png" | "svg";

export interface RenderGridOptions {
  columns?: number;
  labels: GridLabels;
  width: number;
  gutter: number;
  padding: number;
  background: RenderBackground;
}

interface ParsedArguments extends RenderGridOptions {
  jobsFile: string;
  out: string;
  format: GridOutputFormat;
}

interface MeasuredEntry extends GridJob {
  depiction: SmilesDepictionResult;
  width: number;
  height: number;
  label: string | null;
}

export const gridHelp = `ChemDraft multiple-choice structure grid renderer

Usage:
  pnpm -s chemdraft grid --batch <jobs.json> --out <grid.png|grid.svg> [options]

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}.
Every entry is validated before the image is written: a bad SMILES fails the entire grid.

Options:
  --columns <N>                  Number of columns (default: automatic)
  --labels none|letters|names    Cell labels (default: letters)
  --width <px>                   PNG width (default: ${renderDefaults.width}; ignored for SVG)
  --gutter <px>                  Space between cells (default: 32)
  --padding <px>                 Crop padding around all visible content (default: ${renderDefaults.padding})
  --background white|transparent Background (default: white)
  --help                         Print this help

Output:
  One JSON result line is written to stdout and progress is written to stderr.
  Exit 0 on success, 1 when the grid cannot be rendered, and 2 for bad arguments.`;

const gridOptions = {
  "--batch": { kind: "value" },
  "--out": { kind: "value" },
  "--columns": { kind: "value" },
  "--labels": { kind: "value" },
  "--width": { kind: "value" },
  "--gutter": { kind: "value" },
  "--padding": { kind: "value" },
  "--background": { kind: "value" },
  "--help": { kind: "boolean" }
} as const;

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, gridOptions);
  if (parsed.positionals.length > 0) throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);

  const jobsFile = stringOption(parsed, "--batch");
  const out = stringOption(parsed, "--out");
  if (!jobsFile) throw new CliUsageError("--batch is required.");
  if (!out) throw new CliUsageError("--out is required.");
  const extension = extname(out).toLowerCase();
  if (extension !== ".png" && extension !== ".svg") {
    throw new CliUsageError("--out must end in .png or .svg.");
  }

  const requestedLabels = stringOption(parsed, "--labels") ?? "letters";
  if (requestedLabels !== "none" && requestedLabels !== "letters" && requestedLabels !== "names") {
    throw new CliUsageError(`--labels must be none, letters, or names; received "${requestedLabels}".`);
  }
  const requestedBackground = stringOption(parsed, "--background") ?? renderDefaults.background;
  if (requestedBackground !== "white" && requestedBackground !== "transparent") {
    throw new CliUsageError(
      `--background must be white or transparent; received "${requestedBackground}".`
    );
  }

  return {
    jobsFile,
    out,
    format: extension.slice(1) as GridOutputFormat,
    columns: stringOption(parsed, "--columns") === undefined
      ? undefined
      : integerOption(stringOption(parsed, "--columns"), "--columns"),
    labels: requestedLabels,
    width: stringOption(parsed, "--width") === undefined
      ? renderDefaults.width
      : numericOption(stringOption(parsed, "--width"), "--width", false),
    gutter: stringOption(parsed, "--gutter") === undefined
      ? 32
      : numericOption(stringOption(parsed, "--gutter"), "--gutter", true),
    padding: stringOption(parsed, "--padding") === undefined
      ? renderDefaults.padding
      : numericOption(stringOption(parsed, "--padding"), "--padding", true),
    background: requestedBackground
  };
}

async function readJobs(path: string): Promise<GridJob[]> {
  const jobs = await readBatchFile(path, parseNamedSmilesJob, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
  if (jobs.length === 0) throw new CliUsageError("Batch JSON must contain at least one grid entry.");
  return jobs;
}

function letterLabel(index: number): string {
  let remaining = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + remaining % 26) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

function measureDepiction(entry: GridJob, depiction: SmilesDepictionResult): Pick<MeasuredEntry, "width" | "height"> {
  let document = createEmptyDocument({ title: entry.name });
  const page = document.pages[0];
  if (!page) throw new Error("The grid document has no page.");
  document = insertSmilesMolecule(
    document,
    { x: page.width / 2, y: page.height / 2 },
    depiction.depiction,
    entry.smiles.trim()
  );
  const molecule = document.pages[0]?.objects.find((object): object is MoleculeObject => object.type === "molecule");
  if (!molecule) throw new Error(`Unable to measure SMILES "${entry.smiles}".`);
  return { width: molecule.width, height: molecule.height };
}

async function prepareEntries(jobs: readonly GridJob[], labels: GridLabels, io: CliIo): Promise<MeasuredEntry[]> {
  installNodeEngines();
  const entries: MeasuredEntry[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    writeProgress(io, `Preparing ${job.name}…`);
    const depiction = await depictSmiles(job.smiles.trim());
    entries.push({
      ...job,
      depiction,
      ...measureDepiction(job, depiction),
      label: labels === "none" ? null : labels === "letters" ? letterLabel(index) : job.name
    });
  }
  return entries;
}

function automaticColumns(entries: readonly MeasuredEntry[], gutter: number): number {
  const pageWidth = createEmptyDocument().pages[0]?.width;
  if (!pageWidth) throw new Error("The grid document has no page.");
  const cellWidth = Math.max(...entries.map((entry) => entry.width)) + gutter;
  return Math.min(entries.length, Math.max(1, Math.floor((pageWidth - 48) / cellWidth)));
}

export interface RenderedGrid {
  svg: string;
  png: Uint8Array;
  document: ReturnType<typeof createEmptyDocument>;
  viewBox: { x: number; y: number; width: number; height: number };
  columns: number;
  rows: number;
  cells: { name: string; smiles: string; label: string | null; column: number; row: number }[];
  warnings: string[];
}

export async function renderGrid(
  jobs: readonly GridJob[],
  args: RenderGridOptions,
  io: CliIo = defaultCliIo
): Promise<RenderedGrid> {
  const entries = await prepareEntries(jobs, args.labels, io);
  const columns = Math.min(entries.length, args.columns ?? automaticColumns(entries, args.gutter));
  const rows = Math.ceil(entries.length / columns);
  const moleculeWidth = Math.max(...entries.map((entry) => entry.width));
  const moleculeHeight = Math.max(...entries.map((entry) => entry.height));
  const labelGap = args.labels === "none" ? 0 : 8;
  const labelHeight = args.labels === "none" ? 0 : Math.max(
    ...entries.map((entry) => nativeTextObjectSizeForText(entry.label!).height)
  );
  const cellWidth = moleculeWidth + args.gutter;
  const cellHeight = moleculeHeight + labelGap + labelHeight + args.gutter;
  const margin = 24;
  let document = createEmptyDocument({ title: "ChemDraft grid" });
  const cells = entries.map((entry, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellX = margin + column * cellWidth;
    const cellY = margin + row * cellHeight;
    document = insertSmilesMolecule(
      document,
      { x: cellX + cellWidth / 2, y: cellY + moleculeHeight / 2 },
      entry.depiction.depiction,
      entry.smiles.trim()
    );
    if (entry.label !== null) {
      const size = nativeTextObjectSizeForText(entry.label);
      const x = cellX + (cellWidth - size.width) / 2;
      const y = cellY + moleculeHeight + labelGap;
      document = insertNativeTextObject(document, { x, y }, entry.label);
    }
    return { name: entry.name, smiles: entry.smiles, label: entry.label, column, row };
  });

  const exported = exportDocumentToSvg(document, {
    background: args.background === "white" ? "#ffffff" : "transparent"
  });
  const cropped = cropDocumentSvgToContent(
    exported.contents,
    document,
    args.padding,
    args.background
  );
  return {
    svg: cropped.svg,
    png: svgToPng(cropped.svg, args.width),
    document,
    viewBox: cropped.viewBox,
    columns,
    rows,
    cells,
    warnings: [...entries.flatMap((entry) => entry.depiction.warnings), ...exported.warnings.map((warning) => warning.message)]
  };
}

/** Render an all-or-nothing, multiple-choice grid from a named SMILES batch. */
export async function runGridCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  try {
    const args = parseArguments(argv);
    if ("help" in args) {
      io.stdout(gridHelp);
      return cliExitCode.ok;
    }
    const jobs = await readJobs(args.jobsFile);
    writeProgress(io, `Rendering ${jobs.length} structures as one grid…`);
    try {
      const rendered = await renderGrid(jobs, args, io);
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, args.format === "svg" ? rendered.svg : rendered.png);
      writeJsonLine(io, {
        name: "grid",
        ok: true,
        warnings: rendered.warnings,
        out: args.out,
        columns: rendered.columns,
        rows: rendered.rows,
        cells: rendered.cells
      });
      writeProgress(io, `Wrote ${args.out}`);
      return cliExitCode.ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Render errors name the SMILES in quotes; match the quoted form so a short SMILES such as
      // methane's "C" is not blamed for any message that merely contains the letter C.
      const failingJob = jobs.find((job) =>
        message.includes(`"${job.smiles}"`) || message.includes(`"${job.smiles.trim()}"`)
      );
      writeJsonLine(io, {
        name: "grid",
        ok: false,
        error: message,
        ...(failingJob ? { smiles: failingJob.smiles } : {})
      });
      writeProgress(io, `Failed grid: ${message}`);
      return cliExitCode.failed;
    }
  } catch (error) {
    return handleCliError(error, io, "grid");
  }
}

export const gridCommand = {
  name: "grid",
  summary: "Render named SMILES as one multiple-choice grid.",
  run: runGridCommand
} as const;
