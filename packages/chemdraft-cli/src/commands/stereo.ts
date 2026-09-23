import { depictSmiles } from "../document";
import { installNodeEngines } from "../engine";
import { parseOptions, stringOption } from "../args";
import {
  CliUsageError,
  cliExitCode,
  defaultCliIo,
  readBatchFile,
  resultExitCode,
  writeJsonLine,
  writeProgress,
  type CliExitCode,
  type CliIo
} from "../output";
import {
  perceiveStereoCentersFromMolfile,
  perceiveUnrepresentableStereo
} from "@chemdraft/ocl-adapter";

export interface StereoJob {
  name: string;
  smiles: string;
}

interface ParsedArguments {
  mode: "single" | "batch";
  smiles?: string;
  jobsFile?: string;
}

export const stereoHelp = `ChemDraft stereochemistry inspector

Usage:
  pnpm chemdraft stereo --smiles <SMILES>
  pnpm chemdraft stereo --batch <jobs.json>

Batch input is a JSON array of {"name":"alanine","smiles":"C[C@H](N)C(=O)O"}.
Atom indices are 0-based molfile atom order.

Output:
  One JSON line per structure is written to stdout. Progress is written to stderr.
  Exit 0 when every structure succeeds, 1 when any structure fails, and 2 for bad arguments.`;

const stereoOptions = {
  "--smiles": { kind: "value" },
  "--batch": { kind: "value" },
  "--help": { kind: "boolean" }
} as const;

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, stereoOptions);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
  }
  const smiles = stringOption(parsed, "--smiles");
  const jobsFile = stringOption(parsed, "--batch");
  if ((smiles ? 1 : 0) + (jobsFile ? 1 : 0) !== 1) {
    throw new CliUsageError("Provide exactly one of --smiles or --batch.");
  }
  return smiles !== undefined
    ? { mode: "single", smiles }
    : { mode: "batch", jobsFile };
}

async function readJobs(path: string): Promise<StereoJob[]> {
  return readBatchFile(path, (candidate, index) => {
    if (
      !candidate || typeof candidate !== "object" ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { smiles?: unknown }).smiles !== "string"
    ) {
      throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "smiles" fields.`);
    }
    return candidate as StereoJob;
  }, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
}

async function inspectJob(job: StereoJob, io: CliIo): Promise<boolean> {
  writeProgress(io, `Inspecting ${job.name}…`);
  try {
    const depicted = await depictSmiles(job.smiles);
    const perceived = perceiveStereoCentersFromMolfile(depicted.molfile);
    const stereoCenters = perceived.flatMap((center, atomIndex) => center.isStereoCenter
      ? [{ atomIndex, element: depicted.depiction.atoms[atomIndex]?.element ?? "?", descriptor: center.descriptor }]
      : []);
    const specifiedCount = stereoCenters.filter((center) => center.descriptor !== "unspecified").length;
    const unspecifiedCount = stereoCenters.length - specifiedCount;
    const warnings = [...depicted.warnings];
    if (unspecifiedCount > 0) warnings.push(`${unspecifiedCount} stereocentre(s) left unspecified`);
    writeJsonLine(io, {
      name: job.name,
      smiles: job.smiles,
      ok: true,
      stereoCenters,
      specifiedCount,
      unspecifiedCount,
      unrepresentable: perceiveUnrepresentableStereo(depicted.molfile),
      warnings
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeProgress(io, `Failed ${job.name}: ${message}`);
    writeJsonLine(io, { name: job.name, smiles: job.smiles, ok: false, error: message });
    return false;
  }
}

export async function runStereoCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(stereoHelp);
      return cliExitCode.ok;
    }
    // Install the real Node RDKit loader before any depiction or OCL chemistry work.
    installNodeEngines();
    const jobs = parsed.mode === "single"
      ? [{ name: "structure", smiles: parsed.smiles! }]
      : await readJobs(parsed.jobsFile!);
    let allSucceeded = true;
    for (const job of jobs) {
      if (!await inspectJob(job, io)) allSucceeded = false;
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}`);
    io.stderr("Run pnpm chemdraft stereo --help for usage.");
    return error instanceof CliUsageError ? cliExitCode.badArguments : cliExitCode.failed;
  }
}

export const stereoCommand = {
  name: "stereo",
  summary: "Inspect stereochemistry.",
  run: runStereoCommand
} as const;
