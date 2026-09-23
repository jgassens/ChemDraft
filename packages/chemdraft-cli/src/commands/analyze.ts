import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";

import {
  buildAnalysisReport,
  renderReportMarkdown,
  renderReportText,
  statusHasValue,
  type AnalysisResult,
  type AnalysisRun
} from "@chemdraft/analysis-core";
import {
  analyzeStructureDetailed,
  rdkitAnalysisContracts
} from "../../../rdkit-adapter/src/analysis";
import { installNodeRdkitModuleLoader } from "../../../rdkit-adapter/src/node";

import { booleanOption, parseOptions, stringOption } from "../args";
import { installNodeEngines } from "../engine";
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

type AnalysisFormat = "json" | "md" | "text";

interface AnalyzeJob {
  name: string;
  smiles: string;
}

interface ParsedArguments {
  mode: "single" | "batch";
  smiles?: string;
  jobsFile?: string;
  methods?: readonly string[];
  format: AnalysisFormat;
  out?: string;
}

interface AnalysisSummary {
  formula: string | null;
  monoisotopicMass: number | null;
  averageMass: number | null;
  canonicalSmiles: string | null;
  inchiKey: string | null;
  logP: number | null;
  tpsa: number | null;
  hbd: number | null;
  hba: number | null;
  rotatableBonds: number | null;
  pka: Array<{
    site: string;
    value: number;
    interval: { lower: number; upper: number } | null;
  }>;
}

export const analyzeHelp = `Analyze SMILES with ChemDraft's property and prediction suite.

Usage:
  pnpm chemdraft analyze --smiles <SMILES> [--methods <id,id>] [--format json|md|text] [--out <file>]
  pnpm chemdraft analyze --batch <jobs.json> [--methods <id,id>] [--format json|md|text]

Options:
  --smiles <SMILES>   Analyze one structure.
  --batch <file>      Analyze a JSON array of {"name":"...","smiles":"..."} jobs.
  --methods <id,id>   Run only the comma-separated method ids.
  --format <format>   json (default), md, or text.
  --out <file>        Write a single job's JSON or rendered report to a file.
  --help              Show this help.

Every job emits one JSON result line. For md/text without --out, the rendered report is carried in
that line's "report" field so stdout remains valid JSON Lines.`;

const VALID_METHOD_IDS = rdkitAnalysisContracts().map((contract) => contract.id).sort();
const VALID_METHOD_ID_SET = new Set(VALID_METHOD_IDS);

function parseMethods(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const methods = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (methods.length === 0) throw new CliUsageError("--methods requires at least one method id.");
  const unknown = methods.filter((id) => !VALID_METHOD_ID_SET.has(id));
  if (unknown.length > 0) {
    throw new CliUsageError(
      `Unknown method id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. ` +
        `Valid ids: ${VALID_METHOD_IDS.join(", ")}`
    );
  }
  return methods;
}

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  const parsed = parseOptions(argv, {
    "--help": { kind: "boolean" },
    "--smiles": { kind: "value" },
    "--batch": { kind: "value" },
    "--methods": { kind: "value" },
    "--format": { kind: "value" },
    "--out": { kind: "value" }
  });
  if (booleanOption(parsed, "--help")) return { help: true };
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unexpected positional argument "${parsed.positionals[0]}".`);
  }

  const smiles = stringOption(parsed, "--smiles");
  const jobsFile = stringOption(parsed, "--batch");
  const out = stringOption(parsed, "--out");
  if ((smiles === undefined) === (jobsFile === undefined)) {
    throw new CliUsageError("Provide exactly one of --smiles or --batch.");
  }
  if (smiles !== undefined && !smiles.trim()) {
    throw new CliUsageError("--smiles must not be empty.");
  }
  if (jobsFile !== undefined && out !== undefined) {
    throw new CliUsageError("--out is only valid with --smiles; batch reports are returned in their JSON lines.");
  }

  const formatValue = stringOption(parsed, "--format") ?? "json";
  if (formatValue !== "json" && formatValue !== "md" && formatValue !== "text") {
    throw new CliUsageError('--format must be one of "json", "md", or "text".');
  }

  return {
    mode: smiles !== undefined ? "single" : "batch",
    ...(smiles !== undefined ? { smiles } : { jobsFile }),
    ...(out !== undefined ? { out } : {}),
    methods: parseMethods(stringOption(parsed, "--methods")),
    format: formatValue
  };
}

async function readJobs(path: string): Promise<AnalyzeJob[]> {
  return readBatchFile(path, (candidate, index) => {
    if (
      !candidate || typeof candidate !== "object" ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { smiles?: unknown }).smiles !== "string"
    ) {
      throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "smiles" fields.`);
    }
    return candidate as AnalyzeJob;
  }, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
}

function sourceResult(run: AnalysisRun, methodId: string): AnalysisResult | undefined {
  return run.results.find((result) =>
    result.methodId === methodId &&
    result.interpretationId === "source" &&
    statusHasValue(result.status)
  );
}

function scalar(run: AnalysisRun, methodId: string): number | null {
  const result = sourceResult(run, methodId);
  return result?.kind === "scalar" && result.value !== null ? result.value : null;
}

function identifier(run: AnalysisRun, methodId: string): string | null {
  const result = sourceResult(run, methodId);
  return result?.kind === "identifier" ? result.value : null;
}

function summarize(run: AnalysisRun): AnalysisSummary {
  const composition = sourceResult(run, "rdkit.composition");
  const ionization = run.results.find((result) =>
    result.methodId === "dimorphite.ionizable-sites" &&
    result.kind === "ionization" &&
    statusHasValue(result.status)
  );
  return {
    formula: composition?.kind === "composition" ? composition.formula : null,
    monoisotopicMass: scalar(run, "rdkit.monoisotopic-mass"),
    averageMass: scalar(run, "rdkit.average-mass"),
    canonicalSmiles: identifier(run, "rdkit.canonical-smiles"),
    inchiKey: identifier(run, "rdkit.inchikey"),
    logP: scalar(run, "rdkit.crippen-logp"),
    tpsa: scalar(run, "rdkit.tpsa"),
    hbd: scalar(run, "rdkit.hbd"),
    hba: scalar(run, "rdkit.hba"),
    rotatableBonds: scalar(run, "rdkit.rotatable-bonds"),
    pka: ionization?.kind === "ionization"
      ? ionization.sites.flatMap((entry) => {
          if (entry.pKa === null) return [];
          return [{
            site: `${entry.siteType} (atom ${entry.ionizableAtomIndex + 1}, ${entry.transition})`,
            value: entry.pKa,
            interval: entry.spread === undefined
              ? null
              : { lower: entry.pKa - entry.spread, upper: entry.pKa + entry.spread }
          }];
        })
      : []
  };
}

function warningMessages(run: AnalysisRun): string[] {
  return [...new Set([
    ...run.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    ...run.results.flatMap((result) => result.warnings.map((warning) => `${warning.code}: ${warning.message}`))
  ])];
}

/** Convert typed numeric payloads to JSON arrays instead of JSON.stringify's numeric-key objects. */
function jsonCompatible<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, candidate: unknown) =>
    candidate instanceof Float64Array ? Array.from(candidate) : candidate
  )) as unknown;
}

function failedRunMessage(run: AnalysisRun, smiles: string): string {
  const reasons = run.warnings.map((warning) => warning.message);
  return `Unable to analyze SMILES "${smiles}": ${reasons.join("; ") || `analysis ended with status ${run.status}`}`;
}

async function analyzeJob(
  job: AnalyzeJob,
  jobIndex: number,
  args: ParsedArguments,
  io: CliIo
): Promise<boolean> {
  writeProgress(io, `Analyzing ${job.name}…`);
  try {
    const detailed = await analyzeStructureDetailed({
      format: "smiles",
      value: job.smiles,
      runId: `chemdraft-cli-analyze-${jobIndex + 1}-${job.name}`,
      startedAt: new Date().toISOString(),
      ...(args.methods ? { methodIds: args.methods } : {})
    });
    const { run } = detailed;
    if (run.status === "failed" || run.status === "cancelled" || run.status === "timed-out") {
      const error = failedRunMessage(run, job.smiles);
      writeJsonLine(io, { name: job.name, smiles: job.smiles, ok: false, error });
      writeProgress(io, `Failed ${job.name}: ${error}`);
      return false;
    }

    const report = buildAnalysisReport(run, { title: job.name });
    const summary = summarize(run);
    const warnings = warningMessages(run);
    const payload: Record<string, unknown> & { name: string; ok: true; warnings: readonly string[] } = {
      name: job.name,
      smiles: job.smiles,
      ok: true,
      format: args.format,
      summary,
      warnings
    };

    if (args.format === "json") {
      payload.run = jsonCompatible(run);
      if (args.out) {
        await mkdir(dirname(args.out), { recursive: true });
        await writeFile(args.out, `${JSON.stringify(payload, null, 2)}\n`);
        payload.file = args.out;
      }
    } else {
      const rendered = args.format === "md"
        ? renderReportMarkdown(report)
        : renderReportText(report);
      if (args.out) {
        await mkdir(dirname(args.out), { recursive: true });
        await writeFile(args.out, rendered);
        payload.file = args.out;
      } else {
        payload.report = rendered;
      }
    }

    writeJsonLine(io, payload);
    writeProgress(io, args.out ? `Wrote ${args.out}` : `Analyzed ${job.name}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const namedMessage = message.includes(job.smiles)
      ? message
      : `Unable to analyze SMILES "${job.smiles}": ${message}`;
    writeJsonLine(io, { name: job.name, smiles: job.smiles, ok: false, error: namedMessage });
    writeProgress(io, `Failed ${job.name}: ${namedMessage}`);
    return false;
  }
}

/** Run the ChemDraft property and prediction suite for one SMILES or a named batch. */
export async function runAnalyzeCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(analyzeHelp);
      return cliExitCode.ok;
    }

    const jobs = parsed.mode === "single"
      ? [{
          name: parsed.out
            ? basename(parsed.out, extname(parsed.out)) || "structure"
            : "structure",
          smiles: parsed.smiles!
        }]
      : await readJobs(parsed.jobsFile!);

    // Install the real vendored MinimalLib loader before the first chemistry call. In particular,
    // never route through desktop helpers whose Node path can silently fall back to another engine.
    installNodeEngines();
    // The task environment links this package's whole node_modules directory from another worktree.
    // Under Node+tsx that can give an exports-subpath import and a source import separate module
    // identities. Install idempotently on the exact source instance used above as well; in a normal
    // workspace resolution both calls reach the same module and the second one is a no-op.
    installNodeRdkitModuleLoader();

    let allSucceeded = true;
    for (const [index, job] of jobs.entries()) {
      if (!await analyzeJob(job, index, parsed, io)) allSucceeded = false;
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}`);
    io.stderr("Run pnpm chemdraft analyze --help for usage.");
    return error instanceof CliUsageError ? cliExitCode.badArguments : cliExitCode.failed;
  }
}

export const analyzeCommand = {
  name: "analyze",
  summary: "Analyze structures with the property and prediction suite.",
  run: runAnalyzeCommand
} as const;
