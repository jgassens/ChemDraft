import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { depictSmiles } from "../document";
import { installNodeEngines } from "../engine";
import { parseOptions, stringOption } from "../args";
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
  pnpm -s chemdraft stereo --smiles <SMILES>
  pnpm -s chemdraft stereo --batch <jobs.json>

Batch input is a JSON array of {"name":"alanine","smiles":"C[C@H](N)C(=O)O"}.
Atom and bond indices are 0-based molfile order. Tetrahedral centres and stereogenic double bonds
are reported separately; constitutionally stereogenic units without a descriptor count as unspecified.

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
  return readBatchFile(path, parseNamedSmilesJob, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
}

interface OclMoleculeLike {
  ensureHelperArrays(level: number): void;
  getAllBonds(): number;
  getBondOrder(index: number): number;
  getBondParity(index: number): number;
  getBondCIPParity(index: number): number;
}

interface OpenChemLibLike {
  Molecule: {
    fromMolfile(molfile: string): OclMoleculeLike;
    cHelperCIP: number;
    cBondParityUnknown: number;
    cBondCIPParityEorP: number;
    cBondCIPParityZorM: number;
  };
}

let openChemLibPromise: Promise<OpenChemLibLike> | undefined;

function loadOpenChemLib(): Promise<OpenChemLibLike> {
  openChemLibPromise ??= (async () => {
    // openchemlib belongs to ocl-adapter, not this CLI package. Resolve it from that package so the
    // direct parity call uses the adapter's pinned engine without inventing another dependency.
    const requireFromAdapter = createRequire(new URL("../../../ocl-adapter/package.json", import.meta.url));
    const entry = requireFromAdapter.resolve("openchemlib");
    const loaded = await import(pathToFileURL(entry).href) as unknown as OpenChemLibLike & {
      default?: OpenChemLibLike;
    };
    return loaded.default ?? loaded;
  })();
  return openChemLibPromise;
}

export interface DoubleBondStereo {
  bondIndex: number;
  descriptor: "E" | "Z" | "unspecified";
}

async function perceiveDoubleBondStereo(molfile: string): Promise<DoubleBondStereo[]> {
  const OCL = await loadOpenChemLib();
  const molecule = OCL.Molecule.fromMolfile(molfile);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  const doubleBonds: DoubleBondStereo[] = [];
  for (let bondIndex = 0; bondIndex < molecule.getAllBonds(); bondIndex += 1) {
    if (molecule.getBondOrder(bondIndex) !== 2) continue;
    const cip = molecule.getBondCIPParity(bondIndex);
    const parity = molecule.getBondParity(bondIndex);
    const descriptor = cip === OCL.Molecule.cBondCIPParityEorP
      ? "E"
      : cip === OCL.Molecule.cBondCIPParityZorM
        ? "Z"
        : parity === OCL.Molecule.cBondParityUnknown
          ? "unspecified"
          : undefined;
    if (descriptor) doubleBonds.push({ bondIndex, descriptor });
  }
  return doubleBonds;
}

async function inspectJob(job: StereoJob, io: CliIo): Promise<boolean> {
  writeProgress(io, `Inspecting ${job.name}…`);
  try {
    const depicted = await depictSmiles(job.smiles);
    const perceived = perceiveStereoCentersFromMolfile(depicted.molfile);
    const stereoCenters = perceived.flatMap((center, atomIndex) => center.isStereoCenter
      ? [{ atomIndex, element: depicted.depiction.atoms[atomIndex]?.element ?? "?", descriptor: center.descriptor }]
      : []);
    const doubleBonds = await perceiveDoubleBondStereo(depicted.molfile);
    const specifiedCount = stereoCenters.filter((center) => center.descriptor !== "unspecified").length +
      doubleBonds.filter((bond) => bond.descriptor !== "unspecified").length;
    const tetrahedralUnspecified = stereoCenters.filter((center) => center.descriptor === "unspecified").length;
    const doubleBondUnspecified = doubleBonds.filter((bond) => bond.descriptor === "unspecified").length;
    const unspecifiedCount = tetrahedralUnspecified + doubleBondUnspecified;
    const warnings = [...depicted.warnings];
    if (tetrahedralUnspecified > 0) {
      warnings.push(`${tetrahedralUnspecified} stereocentre(s) left unspecified`);
    }
    if (doubleBondUnspecified > 0) {
      warnings.push(`${doubleBondUnspecified} stereogenic double bond(s) left unspecified`);
    }
    writeJsonLine(io, {
      name: job.name,
      smiles: job.smiles,
      ok: true,
      stereoCenters,
      doubleBonds,
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
    return handleCliError(error, io, "stereo");
  }
}

export const stereoCommand = {
  name: "stereo",
  summary: "Inspect stereochemistry.",
  run: runStereoCommand
} as const;
