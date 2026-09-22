#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  finiteNonNegative,
  finitePositive,
  renderDefaults,
  renderSmilesToAssets,
  type RenderBackground
} from "./renderer";

type OutputFormat = "png" | "svg" | "both";

interface RenderJob {
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

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HELP = `ChemDraft headless structure renderer

Usage:
  pnpm render --smiles <SMILES> --out <file.png|file.svg>
  pnpm render --smiles <SMILES> --out <base> --format both
  pnpm render --batch <jobs.json> --out-dir <dir> [--format png|svg|both]

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}.
Names are trimmed; blank/duplicate names, path separators, and names beginning with a dot are rejected.

Options:
  --width <px>                    PNG width (default: 600)
  --background white|transparent SVG/PNG background (default: white)
  --bond-length <px>              Depicted bond length (default: ${renderDefaults.bondLength}, the desktop paste value)
  --padding <px>                  Crop padding around the molecule (default: 24)
  --format png|svg|both           Output format (single mode normally infers the extension)
  --help                          Print this help

Output:
  One JSON line per structure is written to stdout. Progress is written to stderr.
  stereoCenters counts specified centers; unspecifiedStereoCenters counts constitutional centers
  without a specified descriptor.
  Exit 0 when every structure succeeds, 1 when any render fails, and 2 for bad arguments.`;

class CliUsageError extends Error {}

function numericOption(value: string | undefined, flag: string, allowZero: boolean): number {
  if (value === undefined) throw new CliUsageError(`${flag} requires a value.`);
  const parsed = Number(value);
  try {
    return allowZero
      ? finiteNonNegative(parsed, flag)
      : finitePositive(parsed, flag);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function optionValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };

  let smiles: string | undefined;
  let jobsFile: string | undefined;
  let out: string | undefined;
  let outDir: string | undefined;
  let format: OutputFormat | undefined;
  let width = renderDefaults.width;
  let background: RenderBackground = renderDefaults.background;
  let bondLength = renderDefaults.bondLength;
  let padding = renderDefaults.padding;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag) continue;
    const value = () => optionValue(argv, index, flag);
    switch (flag) {
      case "--smiles":
        smiles = value();
        index += 1;
        break;
      case "--batch":
        jobsFile = value();
        index += 1;
        break;
      case "--out":
        out = value();
        index += 1;
        break;
      case "--out-dir":
        outDir = value();
        index += 1;
        break;
      case "--format": {
        const requested = value();
        if (requested !== "png" && requested !== "svg" && requested !== "both") {
          throw new CliUsageError(`--format must be png, svg, or both; received "${requested}".`);
        }
        format = requested;
        index += 1;
        break;
      }
      case "--width":
        width = numericOption(value(), flag, false);
        index += 1;
        break;
      case "--background": {
        const requested = value();
        if (requested !== "white" && requested !== "transparent") {
          throw new CliUsageError(`--background must be white or transparent; received "${requested}".`);
        }
        background = requested;
        index += 1;
        break;
      }
      case "--bond-length":
        bondLength = numericOption(value(), flag, false);
        index += 1;
        break;
      case "--padding":
        padding = numericOption(value(), flag, true);
        index += 1;
        break;
      default:
        throw new CliUsageError(`Unknown argument "${flag}".`);
    }
  }

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

function validateJobName(name: string): void {
  if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\")) {
    throw new CliUsageError(
      `Invalid batch name "${name}": names must be non-empty, must not begin with a dot, and must not contain path separators.`
    );
  }
}

async function readJobs(path: string): Promise<RenderJob[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`Could not read batch file "${path}": ${message}`);
  }
  if (!Array.isArray(parsed)) throw new CliUsageError("Batch JSON must be an array of jobs.");
  const names = new Set<string>();
  return parsed.map((candidate, index) => {
    if (
      !candidate || typeof candidate !== "object" ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { smiles?: unknown }).smiles !== "string"
    ) {
      throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "smiles" fields.`);
    }
    const candidateJob = candidate as RenderJob;
    const job = { ...candidateJob, name: candidateJob.name.trim() };
    validateJobName(job.name);
    if (names.has(job.name)) {
      throw new CliUsageError(`Duplicate batch name "${job.name}".`);
    }
    names.add(job.name);
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
    return job;
  });
}

function baseWithoutKnownExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension === ".png" || extension === ".svg" ? path.slice(0, -extension.length) : path;
}

function outputPaths(base: string, format: OutputFormat): string[] {
  if (format === "both") return [`${baseWithoutKnownExtension(base)}.svg`, `${baseWithoutKnownExtension(base)}.png`];
  const extension = extname(base).toLowerCase();
  if (extension === `.${format}`) return [base];
  return [`${base}.${format}`];
}

async function renderJob(
  job: RenderJob,
  base: string,
  args: ParsedArguments,
  io: CliIo
): Promise<boolean> {
  io.stderr(`Rendering ${job.name}…`);
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
    io.stdout(JSON.stringify({
      name: job.name,
      smiles: job.smiles,
      ok: true,
      files,
      engine: rendered.engine,
      stereoCenters: rendered.stereoCenters,
      unspecifiedStereoCenters: rendered.unspecifiedStereoCenters,
      warnings: rendered.warnings
    }));
    io.stderr(`Wrote ${files.join(", ")}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const namedMessage = message.includes(job.smiles)
      ? message
      : `Unable to render SMILES "${job.smiles}": ${message}`;
    io.stdout(JSON.stringify({ name: job.name, smiles: job.smiles, ok: false, error: namedMessage }));
    io.stderr(`Failed ${job.name}: ${namedMessage}`);
    return false;
  }
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`)
  }
): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(HELP);
      return 0;
    }

    let jobs: RenderJob[];
    let bases: string[];
    if (parsed.mode === "single") {
      const out = parsed.out!;
      const name = basename(baseWithoutKnownExtension(out)) || "structure";
      jobs = [{ name, smiles: parsed.smiles! }];
      bases = [out];
    } else {
      jobs = await readJobs(parsed.jobsFile!);
      await mkdir(parsed.outDir!, { recursive: true });
      bases = jobs.map((job) => join(parsed.outDir!, job.name));
    }

    let allSucceeded = true;
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]!;
      const base = bases[index]!;
      if (!await renderJob(job, base, parsed, io)) allSucceeded = false;
    }
    return allSucceeded ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}`);
    io.stderr("Run pnpm render --help for usage.");
    return error instanceof CliUsageError ? 2 : 1;
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
