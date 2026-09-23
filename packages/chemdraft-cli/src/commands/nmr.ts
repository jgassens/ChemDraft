import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { booleanOption, parseOptions, stringOption } from "../args";
import { depictSmiles, finitePositive, svgToPng } from "../document";
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

/**
 * `chemdraft nmr` — predicted ¹H/¹³C shifts from the ChemDraft NMR predictor plugin.
 *
 * The plugin lives in its own repository and is deliberately NOT a dependency of this workspace.
 * It is loaded at run time from a directory (CHEMDRAFT_NMR_PLUGIN_DIR, default
 * ~/programming/chemdraft-nmr-plugin) through an import whose specifier is a runtime string, so the
 * root `tsc` never sees the plugin's sources. The interfaces below describe only the part of the
 * plugin's public surface this command reads.
 */

export type NmrNucleus = "1H" | "13C";

interface PluginAtomReference {
  sourceAtomIndex: number;
  equivalentCount?: number;
}

interface PluginEvidence {
  method: string;
  matchedSphere?: number;
  sampleCount?: number;
  estimator?: { id: string; version: string; method: string };
}

interface PluginResonance {
  nucleus: NmrNucleus;
  deltaPpm: number;
  atomRefs: readonly PluginAtomReference[];
  equivalentNuclei?: number;
  evidence?: PluginEvidence;
  multiplet?: { label: string; couplings: readonly { jHz: number }[] } | null;
  flags: readonly string[];
}

interface PluginWarning {
  code: string;
  message: string;
  severity: string;
  atomIndices?: readonly number[];
}

interface PluginPredictionResult {
  backend: {
    id: string;
    version: string;
    dataVersion?: string;
    method: string;
    license?: string;
    attribution?: string;
    source?: string;
  };
  resonances: readonly PluginResonance[];
  warnings: readonly PluginWarning[];
  depiction?: { atoms: readonly { index: number; element: string }[] };
}

interface PluginPredictionRequest {
  structure: { format: "smiles" | "molfile-v2000" | "molfile-v3000"; value: string };
  nuclei: readonly NmrNucleus[];
  options: { statistic: "median" | "mean"; hoseLevels: readonly number[]; ignoreLabileHydrogens: boolean };
}

interface NmrPluginModule {
  OclHosePredictor: new () => {
    predict(request: PluginPredictionRequest): Promise<PluginPredictionResult>;
  };
  renderStickSpectrumSvg(result: PluginPredictionResult, options?: { width?: number; height?: number }): string;
}

export const NMR_PLUGIN_DIR_ENV = "CHEMDRAFT_NMR_PLUGIN_DIR";
const DEFAULT_PLUGIN_DIR = "~/programming/chemdraft-nmr-plugin";
const DEFAULT_PNG_WIDTH = 1280;
const ALL_NUCLEI: readonly NmrNucleus[] = ["1H", "13C"];

type SpectrumFormat = "svg" | "png";

interface NmrJob {
  name: string;
  smiles: string;
}

interface ParsedArguments {
  jobs?: NmrJob[];
  jobsFile?: string;
  nuclei: NmrNucleus[];
  statistic: "median" | "mean";
  ignoreLabile: boolean;
  spectrum?: string;
  spectrumDir?: string;
  spectrumFormat: SpectrumFormat;
  width: number;
}

export const nmrHelp = `ChemDraft NMR shift prediction

Usage:
  pnpm chemdraft nmr --smiles <SMILES> [--nuclei 1H,13C] [--spectrum out.svg|out.png]
  pnpm chemdraft nmr --batch <jobs.json> [--nuclei 1H,13C] [--spectrum-dir <dir>]

Batch input is a JSON array of {"name":"ethanol","smiles":"CCO"}.

Options:
  --nuclei <list>              Comma-separated nuclei, 1H and/or 13C (default: 1H,13C)
  --name <name>                Name for the single-structure result line (default: structure)
  --spectrum <file.svg|.png>   Write the stick spectrum (single mode). With more than one nucleus,
                               one file per nucleus is written with a -1H / -13C suffix.
  --spectrum-dir <dir>         Batch mode: write <dir>/<name>-<nucleus>.<format> per structure
  --spectrum-format svg|png    Batch spectrum format (default: svg)
  --width <px>                 PNG spectrum width (default: ${DEFAULT_PNG_WIDTH})
  --statistic median|mean      Reference statistic used for each shift (default: median)
  --ignore-labile              Omit exchangeable O-H, N-H and S-H protons
  --help                       Print this help

The predictor plugin is loaded from $${NMR_PLUGIN_DIR_ENV}
(default: ${DEFAULT_PLUGIN_DIR}). It is a separate repository and is not bundled here.

What the numbers are:
  - Shifts come from HOSE-fragment lookup over statistics derived from NMRShiftDB2 experimental
    assignments. They are predictions, not measurements. source "hose-fragment" is a database
    match; source "rule-estimated" is a disclosed additive-rule estimate, emitted only where the
    rule applies and always flagged by an NMR_RULE_ESTIMATED warning.
  - 1H multiplicity and J are first-order estimates from bond topology. They are labelled
    estimated ("estimated": true) and are never measured values.
  - nEquivalent (and stick height in the spectrum) is the predicted number of equivalent nuclei.
    It is not an integration.
  - No shift is ever invented for an unmatched environment: it is omitted and a warning
    (NMR_NO_FRAGMENT_MATCH / NMR_PARTIAL_PREDICTION) says so.
  - No confidence percentages are reported; thin matches carry warnings instead.
  - The reference database is a derivative database under the nmrshiftdb2 Database License
    (ODbL-derived: attribution, share-alike). That licence is separate from the code licence;
    each result line names it under "database".

Output:
  One JSON line per structure on stdout; progress on stderr. atomIndices are 0-based indices into
  the drawn structure (the molfile ChemDraft depicts from the SMILES); for 1H they are the atoms
  carrying the hydrogens.
  Exit 0 when every structure succeeds, 1 when any fails, and 2 for bad arguments.`;

const nmrOptions = {
  "--smiles": { kind: "value" },
  "--batch": { kind: "value" },
  "--name": { kind: "value" },
  "--nuclei": { kind: "value" },
  "--spectrum": { kind: "value" },
  "--spectrum-dir": { kind: "value" },
  "--spectrum-format": { kind: "value" },
  "--width": { kind: "value" },
  "--statistic": { kind: "value" },
  "--ignore-labile": { kind: "boolean" },
  "--help": { kind: "boolean" }
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve the plugin checkout: the environment variable when set, otherwise the default path. */
export function resolveNmrPluginDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[NMR_PLUGIN_DIR_ENV]?.trim() || DEFAULT_PLUGIN_DIR;
  const expanded = configured === "~" || configured.startsWith("~/")
    ? join(homedir(), configured.slice(1))
    : configured;
  return resolve(expanded);
}

const pluginCache = new Map<string, Promise<NmrPluginModule>>();

function loadNmrPlugin(pluginDir: string): Promise<NmrPluginModule> {
  const entry = join(pluginDir, "src", "index.ts");
  let loading = pluginCache.get(entry);
  if (!loading) {
    loading = (async () => {
      if (!existsSync(entry)) {
        throw new Error(
          `NMR predictor plugin not found: expected ${entry}. Set ${NMR_PLUGIN_DIR_ENV} to a chemdraft-nmr-plugin checkout (default ${DEFAULT_PLUGIN_DIR}).`
        );
      }
      // A runtime string keeps the plugin outside the workspace type graph; its own openchemlib
      // and zod resolve from its node_modules because Node resolves relative to the imported file.
      const specifier: string = pathToFileURL(entry).href;
      const loaded = await import(specifier) as Partial<NmrPluginModule>;
      if (typeof loaded.OclHosePredictor !== "function" || typeof loaded.renderStickSpectrumSvg !== "function") {
        throw new Error(
          `The plugin at ${entry} does not export OclHosePredictor and renderStickSpectrumSvg; check ${NMR_PLUGIN_DIR_ENV}.`
        );
      }
      return loaded as NmrPluginModule;
    })();
    pluginCache.set(entry, loading);
    // A failed load is not cached, so a later run in the same process can pick up a fixed path.
    loading.catch(() => pluginCache.delete(entry));
  }
  return loading;
}

function parseNuclei(value: string | undefined): NmrNucleus[] {
  if (value === undefined) return [...ALL_NUCLEI];
  const nuclei: NmrNucleus[] = [];
  for (const raw of value.split(",")) {
    const token = raw.trim().toUpperCase();
    const nucleus = token === "1H" ? "1H" : token === "13C" ? "13C" : undefined;
    if (!nucleus) throw new CliUsageError(`--nuclei accepts 1H and 13C; received "${raw.trim()}".`);
    if (!nuclei.includes(nucleus)) nuclei.push(nucleus);
  }
  if (nuclei.length === 0) throw new CliUsageError("--nuclei must name at least one nucleus.");
  return nuclei;
}

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, nmrOptions);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
  }

  const smiles = stringOption(parsed, "--smiles");
  const jobsFile = stringOption(parsed, "--batch");
  if ((smiles !== undefined ? 1 : 0) + (jobsFile !== undefined ? 1 : 0) !== 1) {
    throw new CliUsageError("Provide exactly one of --smiles or --batch.");
  }

  const statistic = stringOption(parsed, "--statistic") ?? "median";
  if (statistic !== "median" && statistic !== "mean") {
    throw new CliUsageError(`--statistic must be median or mean; received "${statistic}".`);
  }

  let width = DEFAULT_PNG_WIDTH;
  const requestedWidth = stringOption(parsed, "--width");
  if (requestedWidth !== undefined) {
    try {
      width = finitePositive(Number(requestedWidth), "--width");
    } catch (error) {
      throw new CliUsageError(errorMessage(error));
    }
  }

  const spectrum = stringOption(parsed, "--spectrum");
  const spectrumDir = stringOption(parsed, "--spectrum-dir");
  const requestedFormat = stringOption(parsed, "--spectrum-format");
  if (requestedFormat !== undefined && requestedFormat !== "svg" && requestedFormat !== "png") {
    throw new CliUsageError(`--spectrum-format must be svg or png; received "${requestedFormat}".`);
  }

  const common = {
    nuclei: parseNuclei(stringOption(parsed, "--nuclei")),
    statistic,
    ignoreLabile: booleanOption(parsed, "--ignore-labile"),
    width
  } as const;

  if (smiles !== undefined) {
    if (!smiles.trim()) throw new CliUsageError("--smiles must not be empty.");
    if (spectrumDir !== undefined) throw new CliUsageError("--spectrum-dir is only valid with --batch.");
    if (requestedFormat !== undefined) {
      throw new CliUsageError("--spectrum-format is only valid with --batch; --spectrum takes its format from the extension.");
    }
    let spectrumFormat: SpectrumFormat = "svg";
    if (spectrum !== undefined) {
      const extension = extname(spectrum).toLowerCase();
      if (extension !== ".svg" && extension !== ".png") {
        throw new CliUsageError("--spectrum must end in .svg or .png.");
      }
      spectrumFormat = extension === ".png" ? "png" : "svg";
    }
    const name = stringOption(parsed, "--name")?.trim() || "structure";
    return { ...common, jobs: [{ name, smiles }], spectrum, spectrumFormat };
  }

  if (spectrum !== undefined) throw new CliUsageError("--spectrum is only valid with --smiles; use --spectrum-dir with --batch.");
  if (stringOption(parsed, "--name") !== undefined) throw new CliUsageError("--name is only valid with --smiles.");
  return { ...common, jobsFile, spectrumDir, spectrumFormat: requestedFormat ?? "svg" };
}

async function readJobs(path: string): Promise<NmrJob[]> {
  return readBatchFile(path, (candidate, index) => {
    if (
      !candidate || typeof candidate !== "object" ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { smiles?: unknown }).smiles !== "string"
    ) {
      throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "smiles" fields.`);
    }
    const { name, smiles } = candidate as NmrJob;
    return { name, smiles };
  }, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
}

function molfileFormat(molfile: string): "molfile-v2000" | "molfile-v3000" {
  return /V3000/.test(molfile.split("\n")[3] ?? "") ? "molfile-v3000" : "molfile-v2000";
}

/** Element symbols from a V2000 atom block, in file order; undefined when the block is not V2000. */
function v2000Elements(molfile: string): string[] | undefined {
  const lines = molfile.split(/\r?\n/);
  const counts = lines[3];
  if (!counts || /V3000/.test(counts)) return undefined;
  const atomCount = Number(counts.slice(0, 3));
  if (!Number.isInteger(atomCount)) return undefined;
  return lines.slice(4, 4 + atomCount).map((line) => line.slice(31, 34).trim());
}

/**
 * The atom indices the predictor reports are its own. They line up with the drawing only while the
 * predictor keeps the molfile's atom order; if it reordered (explicit hydrogens are the usual
 * cause), say so rather than letting indices point at the wrong atoms.
 */
function atomOrderWarning(molfile: string, result: PluginPredictionResult): string | undefined {
  const drawn = v2000Elements(molfile);
  const predicted = result.depiction?.atoms;
  if (!drawn || !predicted) return undefined;
  const aligned = predicted.length === drawn.length &&
    predicted.every((atom) => drawn[atom.index] === atom.element);
  return aligned
    ? undefined
    : "NMR_ATOM_ORDER_MISMATCH: the predictor's atom order differs from the drawn molfile; atomIndices follow the predictor's order, not the drawing.";
}

function formatResonance(resonance: PluginResonance) {
  const evidence = resonance.evidence;
  const nEquivalent = resonance.equivalentNuclei ??
    resonance.atomRefs.reduce((sum, ref) => sum + (ref.equivalentCount ?? 1), 0);
  const isProton = resonance.nucleus === "1H";
  return {
    nucleus: resonance.nucleus,
    atomIndices: resonance.atomRefs.map((ref) => ref.sourceAtomIndex),
    shiftPpm: resonance.deltaPpm,
    // 13C predictions are proton-decoupled singlets; multiplicity and J are 1H-only estimates.
    multiplicity: isProton ? resonance.multiplet?.label ?? null : null,
    jHz: isProton ? (resonance.multiplet?.couplings ?? []).map((coupling) => coupling.jHz) : [],
    estimated: true as const,
    nEquivalent,
    source: evidence?.method ?? "unknown",
    ...(evidence?.matchedSphere !== undefined ? { hoseSphere: evidence.matchedSphere } : {}),
    ...(evidence?.sampleCount !== undefined ? { referenceCount: evidence.sampleCount } : {}),
    ...(evidence?.estimator
      ? { estimator: `${evidence.estimator.id}@${evidence.estimator.version} (${evidence.estimator.method})` }
      : {}),
    flags: [...resonance.flags]
  };
}

function orderedResonances(result: PluginPredictionResult, nuclei: readonly NmrNucleus[]): PluginResonance[] {
  return nuclei.flatMap((nucleus) =>
    result.resonances
      .filter((resonance) => resonance.nucleus === nucleus)
      .sort((left, right) => right.deltaPpm - left.deltaPpm)
  );
}

/**
 * The plugin's stick renderer still carries the axis caption from its fixture era. The shipped
 * provider is the NMRShiftDB2-derived HOSE lookup, so that caption would mislabel real predictions
 * (AGENTS.md §8a); it is replaced here, and the stick-height meaning is stated on the figure.
 */
function relabelSpectrum(svg: string): string {
  const note =
    `<text x="22" y="11" font-size="9" fill="#475569">Stick height = predicted equivalent nuclei, not integration</text>`;
  return svg
    .replace("— synthetic fixture", "— predicted (HOSE / NMRShiftDB2)")
    .replace(/<\/svg>\s*$/, `${note}</svg>`);
}

function spectrumPath(base: string, nucleus: NmrNucleus, withSuffix: boolean, format: SpectrumFormat): string {
  if (!withSuffix) return base;
  const extension = extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  return `${stem}-${nucleus}.${format}`;
}

async function writeSpectra(
  plugin: NmrPluginModule,
  result: PluginPredictionResult,
  nuclei: readonly NmrNucleus[],
  base: string,
  withSuffix: boolean,
  format: SpectrumFormat,
  width: number
): Promise<string[]> {
  const files: string[] = [];
  for (const nucleus of nuclei) {
    const resonances = result.resonances.filter((resonance) => resonance.nucleus === nucleus);
    // The renderer draws one nucleus per figure and reads the axis from the first resonance.
    if (resonances.length === 0) continue;
    const svg = relabelSpectrum(plugin.renderStickSpectrumSvg({ ...result, resonances }));
    const file = spectrumPath(base, nucleus, withSuffix, format);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, format === "png" ? svgToPng(svg, width) : svg);
    files.push(file);
  }
  return files;
}

async function predictJob(job: NmrJob, args: ParsedArguments, pluginDir: string, io: CliIo): Promise<boolean> {
  writeProgress(io, `Predicting ${args.nuclei.join(", ")} shifts for ${job.name}…`);
  const smiles = job.smiles.trim();
  let stage: "plugin" | "structure" | "prediction" = "plugin";
  try {
    const plugin = await loadNmrPlugin(pluginDir);

    stage = "structure";
    const depicted = await depictSmiles(smiles);

    stage = "prediction";
    const predictor = new plugin.OclHosePredictor();
    const result = await predictor.predict({
      structure: { format: molfileFormat(depicted.molfile), value: depicted.molfile },
      nuclei: args.nuclei,
      options: { statistic: args.statistic, hoseLevels: [], ignoreLabileHydrogens: args.ignoreLabile }
    });

    const warnings = [
      ...depicted.warnings,
      ...result.warnings.map((warning) => `${warning.code}: ${warning.message}`)
    ];
    const orderWarning = atomOrderWarning(depicted.molfile, result);
    if (orderWarning) warnings.push(orderWarning);

    let spectrum: string[] | undefined;
    if (args.spectrum !== undefined) {
      spectrum = await writeSpectra(
        plugin, result, args.nuclei, args.spectrum, args.nuclei.length > 1, args.spectrumFormat, args.width
      );
    } else if (args.spectrumDir !== undefined) {
      spectrum = await writeSpectra(
        plugin, result, args.nuclei, join(args.spectrumDir, job.name), true, args.spectrumFormat, args.width
      );
    }

    writeJsonLine(io, {
      name: job.name,
      ok: true,
      smiles,
      nuclei: args.nuclei,
      resonances: orderedResonances(result, args.nuclei).map(formatResonance),
      warnings,
      ...(spectrum ? { spectrum } : {}),
      method: result.backend.method,
      database: {
        name: result.backend.dataVersion ?? null,
        version: result.backend.version,
        license: result.backend.license ?? null,
        attribution: result.backend.attribution ?? null,
        source: result.backend.source ?? null
      }
    });
    if (spectrum?.length) writeProgress(io, `Wrote ${spectrum.join(", ")}`);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    const namedMessage = stage === "plugin" || message.includes(smiles)
      ? message
      : stage === "structure"
        ? `Could not read SMILES "${smiles}": ${message}`
        : `NMR prediction failed for SMILES "${smiles}": ${message}`;
    writeJsonLine(io, { name: job.name, ok: false, smiles, nuclei: args.nuclei, error: namedMessage });
    writeProgress(io, `Failed ${job.name}: ${namedMessage}`);
    return false;
  }
}

/** Run `chemdraft nmr`. */
export async function runNmrCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(nmrHelp);
      return cliExitCode.ok;
    }
    const jobs = parsed.jobs ?? await readJobs(parsed.jobsFile!);
    const pluginDir = resolveNmrPluginDir();

    let allSucceeded = true;
    for (const job of jobs) {
      if (!await predictJob(job, parsed, pluginDir, io)) allSucceeded = false;
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    io.stderr(`Error: ${errorMessage(error)}`);
    io.stderr("Run pnpm chemdraft nmr --help for usage.");
    return error instanceof CliUsageError ? cliExitCode.badArguments : cliExitCode.failed;
  }
}

export const nmrCommand = {
  name: "nmr",
  summary: "Predict 1H/13C NMR shifts with the ChemDraft NMR predictor plugin.",
  run: runNmrCommand
} as const;
