import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

import { createEmptyDocument } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import {
  layoutGrid
} from "@chemdraft/document-workflow-core";

import { integerOption, numericOption, parseOptions, stringOption } from "../args";
import { figureStyleHelp, figureStyleOptions, figureStyleResult, parseFigureStyle, validateFigureDpi, type FigureStyleOptions } from "../figureStyle";
import {
  buildSmilesDocument,
  cropDocumentSvgToContent,
  documentVisualBounds,
  renderDefaults,
  svgToPng,
  validateRasterWidth,
  type BuiltSmilesDocument,
  type RenderBackground
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

export interface RenderGridOptions extends FigureStyleOptions {
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
  built: BuiltSmilesDocument;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
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
${figureStyleHelp}
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
  "--bond-length": { kind: "value" },
  ...figureStyleOptions,
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
  const figure = parseFigureStyle(parsed);
  if (parsed.options["--bond-length"] !== undefined) throw new CliUsageError("--bond-length is not supported by grid.");
  if (parsed.positionals.length > 0) throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);

  const jobsFile = stringOption(parsed, "--batch");
  const out = stringOption(parsed, "--out");
  if (!jobsFile) throw new CliUsageError("--batch is required.");
  if (!out) throw new CliUsageError("--out is required.");
  const extension = extname(out).toLowerCase();
  if (extension !== ".png" && extension !== ".svg") {
    throw new CliUsageError("--out must end in .png or .svg.");
  }

  validateFigureDpi(figure, extension === ".png");
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

  const requestedWidth = stringOption(parsed, "--width") === undefined
    ? renderDefaults.width
    : numericOption(stringOption(parsed, "--width"), "--width", false);
  let width: number;
  try {
    width = validateRasterWidth(requestedWidth, "--width");
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }

  return {
    jobsFile,
    ...figure,
    out,
    format: extension.slice(1) as GridOutputFormat,
    columns: stringOption(parsed, "--columns") === undefined
      ? undefined
      : integerOption(stringOption(parsed, "--columns"), "--columns"),
    labels: requestedLabels,
    width,
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

async function prepareEntries(jobs: readonly GridJob[], labels: GridLabels, io: CliIo, style: FigureStyleOptions["style"]): Promise<MeasuredEntry[]> {
  installNodeEngines();
  const entries: MeasuredEntry[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index]!;
    writeProgress(io, `Preparing ${job.name}…`);
    const built = await buildSmilesDocument(job.smiles.trim(), {
      name: job.name,
      style,
      bondLength: renderDefaults.bondLength
    });
    const bounds = documentVisualBounds(built.document);
    entries.push({
      ...job,
      built,
      bounds,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      label: labels === "none" ? null : labels === "letters" ? letterLabel(index) : job.name
    });
  }
  return entries;
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
  const entries = await prepareEntries(jobs, args.labels, io, args.style);
  const pageWidth = createEmptyDocument().pages[0]?.width;
  if (!pageWidth) throw new Error("The grid document has no page.");
  const layout = layoutGrid({
    style: args.style,
    entries: entries.map((entry) => ({ molecule: entry.built.molecule, bounds: entry.bounds, label: entry.label })),
    columns: args.columns,
    gutter: args.gutter,
    anchor: { x: 24, y: 24 },
    pageWidth,
    labelGap: args.labels === "none" ? 0 : 8
  });
  const document = layout.document;
  const cells = entries.map((entry, index) => {
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    return { name: entry.name, smiles: entry.smiles, label: entry.label, column, row };
  });

  const exported = exportDocumentToSvg(document, {
    background: args.background === "white" ? "#ffffff" : "transparent"
  });
  const cropped = cropDocumentSvgToContent(
    exported.contents,
    document,
    args.padding,
    args.background,
    false,
    args.style
  );
  return {
    svg: cropped.svg,
    png: svgToPng(cropped.svg, args.width, args.style, args.dpi),
    document,
    viewBox: cropped.viewBox,
    columns: layout.columns,
    rows: layout.rows,
    cells,
    warnings: [...entries.flatMap((entry) => entry.built.warnings), ...exported.warnings.map((warning) => warning.message)]
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
        ...figureStyleResult(args, rendered.viewBox, args.format === "png"),
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
        style: args.style ?? "fit",
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
