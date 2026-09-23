import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { numericOption, parseOptions, stringOption } from "../args";
import {
  renderDefaults,
  renderSmilesToAssets,
  type RenderBackground
} from "../document";
import {
  CliUsageError,
  cliExitCode,
  defaultCliIo,
  handleCliError,
  parseNamedSmilesJob,
  readBatchFile,
  resultExitCode,
  writeJsonLine,
  writeProgress,
  type CliExitCode,
  type CliIo
} from "../output";

export type OutputFormat = "png" | "svg" | "both";

export interface RenderJob {
  name: string;
  smiles: string;
}

interface ParsedArguments {
  mode: "single" | "batch";
  jobsFile?: string;
  out?: string;
  outDir?: string;
  smiles?: string;
  format: OutputFormat;
  width: number;
  background: RenderBackground;
  bondLength: number;
  padding: number;
}

export const renderHelp = `ChemDraft headless structure renderer

Usage:
  pnpm -s chemdraft render --smiles <SMILES> --out <file.png|file.svg>
  pnpm -s chemdraft render --smiles <SMILES> --out <base> --format both
  pnpm -s chemdraft render --batch <jobs.json> --out-dir <dir> [--format png|svg|both]

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}.
Names are trimmed; blank/duplicate names, path separators, and names beginning with a dot are rejected.

Options:
  --width <px>                    PNG width, 16–4000 (default: 600)
  --background white|transparent SVG/PNG background (default: white)
  --bond-length <px>              Depicted bond length (default: ${renderDefaults.bondLength}, the desktop paste value)
  --padding <px>                  Crop padding around the molecule (default: 24)
  --format png|svg|both           Output format (single mode normally infers the extension)
  --help                          Print this help

Output:
  One JSON line per structure is written to stdout. Progress is written to stderr.
  stereoCenters counts specified centers; unspecifiedStereoCenters counts constitutional centers
  without a specified descriptor; unspecifiedDoubleBonds counts unknown E/Z double bonds.
  Exit 0 when every structure succeeds, 1 when any render fails, and 2 for bad arguments.`;

const renderOptions = {
  "--smiles": { kind: "value" },
  "--batch": { kind: "value" },
  "--out": { kind: "value" },
  "--out-dir": { kind: "value" },
  "--format": { kind: "value" },
  "--width": { kind: "value" },
  "--background": { kind: "value" },
  "--bond-length": { kind: "value" },
  "--padding": { kind: "value" },
  "--help": { kind: "boolean" }
} as const;

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, renderOptions);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
  }

  const smiles = stringOption(parsed, "--smiles");
  const jobsFile = stringOption(parsed, "--batch");
  const out = stringOption(parsed, "--out");
  const outDir = stringOption(parsed, "--out-dir");
  const requestedFormat = stringOption(parsed, "--format");
  let format: OutputFormat | undefined;
  if (requestedFormat !== undefined) {
    if (requestedFormat !== "png" && requestedFormat !== "svg" && requestedFormat !== "both") {
      throw new CliUsageError(`--format must be png, svg, or both; received "${requestedFormat}".`);
    }
    format = requestedFormat;
  }
  const requestedBackground = stringOption(parsed, "--background");
  let background: RenderBackground = renderDefaults.background;
  if (requestedBackground !== undefined) {
    if (requestedBackground !== "white" && requestedBackground !== "transparent") {
      throw new CliUsageError(
        `--background must be white or transparent; received "${requestedBackground}".`
      );
    }
    background = requestedBackground;
  }
  const width = stringOption(parsed, "--width") === undefined
    ? renderDefaults.width
    : numericOption(stringOption(parsed, "--width"), "--width", false);
  const bondLength = stringOption(parsed, "--bond-length") === undefined
    ? renderDefaults.bondLength
    : numericOption(stringOption(parsed, "--bond-length"), "--bond-length", false);
  const padding = stringOption(parsed, "--padding") === undefined
    ? renderDefaults.padding
    : numericOption(stringOption(parsed, "--padding"), "--padding", true);

  if ((smiles ? 1 : 0) + (jobsFile ? 1 : 0) !== 1) {
    throw new CliUsageError("Provide exactly one of --smiles or --batch.");
  }
  if (smiles !== undefined) {
    if (!out) throw new CliUsageError("Single-structure mode requires --out.");
    if (outDir) throw new CliUsageError("--out-dir is only valid with --batch.");
    const extension = extname(out).toLowerCase();
    const inferred = extension === ".png" ? "png" : extension === ".svg" ? "svg" : undefined;
    if (!format && !inferred) {
      throw new CliUsageError("--out must end in .png or .svg unless --format is provided.");
    }
    if (format && format !== "both" && inferred && format !== inferred) {
      throw new CliUsageError(`--format ${format} conflicts with the --out extension ${extension}.`);
    }
    return {
      mode: "single",
      smiles,
      out,
      format: format ?? inferred!,
      width,
      background,
      bondLength,
      padding
    };
  }

  if (!outDir) throw new CliUsageError("Batch mode requires --out-dir.");
  if (out) throw new CliUsageError("--out is only valid with --smiles.");
  return {
    mode: "batch",
    jobsFile,
    outDir,
    format: format ?? "png",
    width,
    background,
    bondLength,
    padding
  };
}

async function readJobs(path: string): Promise<RenderJob[]> {
  return readBatchFile(path, parseNamedSmilesJob, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
}

function baseWithoutKnownExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension === ".png" || extension === ".svg" ? path.slice(0, -extension.length) : path;
}

function outputPaths(base: string, format: OutputFormat): string[] {
  if (format === "both") {
    return [`${baseWithoutKnownExtension(base)}.svg`, `${baseWithoutKnownExtension(base)}.png`];
  }
  return extname(base).toLowerCase() === `.${format}` ? [base] : [`${base}.${format}`];
}

async function renderJob(
  job: RenderJob,
  base: string,
  args: ParsedArguments,
  io: CliIo
): Promise<boolean> {
  writeProgress(io, `Rendering ${job.name}…`);
  try {
    const rendered = await renderSmilesToAssets(job.smiles, {
      name: job.name,
      width: args.width,
      background: args.background,
      bondLength: args.bondLength,
      padding: args.padding
    });
    const files = outputPaths(base, args.format);
    for (const file of files) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, file.endsWith(".svg") ? rendered.svg : rendered.png);
    }
    writeJsonLine(io, {
      name: job.name,
      smiles: job.smiles,
      ok: true,
      files,
      engine: rendered.engine,
      stereoCenters: rendered.stereoCenters,
      unspecifiedStereoCenters: rendered.unspecifiedStereoCenters,
      unspecifiedDoubleBonds: rendered.unspecifiedDoubleBonds,
      warnings: rendered.warnings
    });
    writeProgress(io, `Wrote ${files.join(", ")}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const namedMessage = message.includes(job.smiles)
      ? message
      : `Unable to render SMILES "${job.smiles}": ${message}`;
    writeJsonLine(io, { name: job.name, smiles: job.smiles, ok: false, error: namedMessage });
    writeProgress(io, `Failed ${job.name}: ${namedMessage}`);
    return false;
  }
}

/** Run the backwards-compatible SMILES renderer command. */
export async function runRenderCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(renderHelp);
      return cliExitCode.ok;
    }

    let jobs: RenderJob[];
    let bases: string[];
    if (parsed.mode === "single") {
      const out = parsed.out!;
      jobs = [{ name: basename(baseWithoutKnownExtension(out)) || "structure", smiles: parsed.smiles! }];
      bases = [out];
    } else {
      jobs = await readJobs(parsed.jobsFile!);
      await mkdir(parsed.outDir!, { recursive: true });
      bases = jobs.map((job) => join(parsed.outDir!, job.name));
    }

    let allSucceeded = true;
    for (let index = 0; index < jobs.length; index += 1) {
      if (!await renderJob(jobs[index]!, bases[index]!, parsed, io)) allSucceeded = false;
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    return handleCliError(error, io, "render");
  }
}

export const renderCommand = {
  name: "render",
  summary: "Render SMILES to cropped SVG or PNG.",
  run: runRenderCommand
} as const;
