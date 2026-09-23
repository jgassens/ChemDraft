import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";

import {
  buildAnalysisReport,
  renderReportMarkdown,
  renderReportText,
  sourceAtomsFor,
  statusHasValue,
  type AnalysisResult,
  type AnalysisRun,
  type AnalysisStatus
} from "@chemdraft/analysis-core";
import {
  analyzeStructureDetailed,
  rdkitAnalysisContracts
} from "@chemdraft/rdkit-adapter";

import { booleanOption, parseOptions, stringOption } from "../args";
import { installNodeEngines } from "../engine";
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

type SummaryStatus = AnalysisStatus | "not-requested";

interface SummaryValue<T> {
  value: T | null;
  status: SummaryStatus;
  reason?: string;
  /**
   * Present only when the value was computed on a derived interpretation (the source result is
   * absent): which interpretation, and its human-readable label, so the reader knows the number
   * describes e.g. the reference protomer rather than the drawn charge state.
   */
  interpretationId?: string;
  interpretationLabel?: string;
}

interface PkaSummarySite {
  /**
   * 0-based index into the DRAWN (source) structure. A site computed on a derived interpretation is
   * mapped back through that interpretation's atom-mapping ledger; null when it has no source atom.
   */
  atomIndex: number | null;
  /** The site's index in the interpretation it was computed on, when that is not the source. */
  derivedAtomIndex?: number;
  siteType: string;
  transition: "acidic" | "basic";
  acidCharge: number;
  basis: string;
  value: number | null;
  reason?: string;
  interval: { lower: number; upper: number } | null;
}

interface AnalysisSummary {
  formula: SummaryValue<string>;
  monoisotopicMass: SummaryValue<number>;
  averageMass: SummaryValue<number>;
  canonicalSmiles: SummaryValue<string>;
  inchiKey: SummaryValue<string>;
  logP: SummaryValue<number>;
  tpsa: SummaryValue<number>;
  hbd: SummaryValue<number>;
  hba: SummaryValue<number>;
  rotatableBonds: SummaryValue<number>;
  pka: SummaryValue<PkaSummarySite[]>;
}

export const analyzeHelp = `Analyze SMILES with ChemDraft's property and prediction suite.

Usage:
  pnpm -s chemdraft analyze --smiles <SMILES> [--methods <id,id>] [--format json|md|text] [--out <file>]
  pnpm -s chemdraft analyze --batch <jobs.json> [--methods <id,id>] [--format json|md|text]

Options:
  --smiles <SMILES>   Analyze one structure.
  --batch <file>      Analyze a JSON array of {"name":"...","smiles":"..."} jobs.
  --methods <id,id>   Run only the comma-separated method ids.
  --format <format>   json (default), md, or text.
  --out <file>        Write a single job's JSON or rendered report to a file.
  --help              Show this help.

Every job emits one JSON result line. For md/text without --out, the rendered report is carried in
that line's "report" field so stdout remains valid JSON Lines.

The "summary" object reports the drawn (source) structure where a method ran on it. When a method
ran only on a derived interpretation - the pKa ladder is built on the reference protomer, with every
removable formal charge removed - its field carries "interpretationId" and "interpretationLabel", and
per-site "atomIndex" is mapped back to the 0-based atom of the drawn SMILES ("derivedAtomIndex" keeps
the index in the derived form). "not-requested" means the method was not run at all.`;

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
  return readBatchFile(path, parseNamedSmilesJob, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
}

/**
 * The result a summary field reports: the source interpretation's when the method ran there,
 * otherwise the first derived interpretation's (preferring one that carries a value). A method whose
 * contract runs on a derived form — Dimorphite's pKa ladder is built on the reference protomer — is
 * still a requested, computed result; it must never read as "not-requested".
 */
function summaryResult(run: AnalysisRun, methodId: string): AnalysisResult | undefined {
  const matching = run.results.filter((result) => result.methodId === methodId);
  return matching.find((result) => result.interpretationId === "source") ??
    matching.find((result) => statusHasValue(result.status)) ??
    matching[0];
}

function interpretationFields(run: AnalysisRun, result: AnalysisResult): {
  interpretationId?: string;
  interpretationLabel?: string;
} {
  if (result.interpretationId === "source") return {};
  const label = run.interpretations.find((entry) => entry.id === result.interpretationId)?.label;
  return {
    interpretationId: result.interpretationId,
    ...(label ? { interpretationLabel: label } : {})
  };
}

/** Map one atom index from a result's interpretation back to the drawn structure. */
function sourceAtomIndex(run: AnalysisRun, result: AnalysisResult, atomIndex: number): number | null {
  if (result.interpretationId === "source") return atomIndex;
  const interpretation = run.interpretations.find((entry) => entry.id === result.interpretationId);
  if (!interpretation) return null;
  return sourceAtomsFor(interpretation, [atomIndex])[0] ?? null;
}

function resultReason(result: AnalysisResult): string | undefined {
  return result.applicability.reasons[0] ?? result.warnings[0]?.message;
}

function summarizeResult<T>(
  run: AnalysisRun,
  methodId: string,
  readValue: (result: AnalysisResult) => T | null
): SummaryValue<T> {
  const result = summaryResult(run, methodId);
  if (!result) return { value: null, status: "not-requested" };
  return {
    value: statusHasValue(result.status) ? readValue(result) : null,
    status: result.status,
    ...(resultReason(result) ? { reason: resultReason(result) } : {}),
    ...interpretationFields(run, result)
  };
}

function scalar(run: AnalysisRun, methodId: string): SummaryValue<number> {
  return summarizeResult(run, methodId, (result) =>
    result.kind === "scalar" && result.value !== null ? result.value : null
  );
}

function identifier(run: AnalysisRun, methodId: string): SummaryValue<string> {
  return summarizeResult(run, methodId, (result) =>
    result.kind === "identifier" ? result.value : null
  );
}

function pkaSite(
  run: AnalysisRun,
  result: AnalysisResult,
  entry: Extract<AnalysisResult, { kind: "ionization" }>["sites"][number]
): PkaSummarySite {
  const derived = result.interpretationId !== "source";
  const atomIndex = sourceAtomIndex(run, result, entry.ionizableAtomIndex);
  const reasons = [
    ...(entry.pKa === null
      ? [entry.derivation ?? "Recognized ionizable site has no reportable pKa value."]
      : []),
    ...(atomIndex === null
      ? [`Site atom ${entry.ionizableAtomIndex} of interpretation "${result.interpretationId}" has no counterpart in the drawn structure.`]
      : [])
  ];
  return {
    atomIndex,
    ...(derived ? { derivedAtomIndex: entry.ionizableAtomIndex } : {}),
    siteType: entry.siteType,
    transition: entry.transition,
    acidCharge: entry.acidCharge,
    basis: entry.basis,
    value: entry.pKa,
    ...(reasons.length > 0 ? { reason: reasons.join(" ") } : {}),
    interval: entry.pKa === null || entry.spread === undefined
      ? null
      : { lower: entry.pKa - entry.spread, upper: entry.pKa + entry.spread }
  };
}

export function summarizeAnalysisRun(run: AnalysisRun): AnalysisSummary {
  const ionization = summaryResult(run, "dimorphite.ionizable-sites");
  const pka = summarizeResult(run, "dimorphite.ionizable-sites", (result) =>
    result.kind === "ionization"
      ? result.sites.map((entry) => pkaSite(run, result, entry))
      : null
  );
  if (ionization && pka.reason === undefined && resultReason(ionization)) {
    pka.reason = resultReason(ionization);
  }
  return {
    formula: summarizeResult(run, "rdkit.composition", (result) =>
      result.kind === "composition" ? result.formula : null
    ),
    monoisotopicMass: scalar(run, "rdkit.monoisotopic-mass"),
    averageMass: scalar(run, "rdkit.average-mass"),
    canonicalSmiles: identifier(run, "rdkit.canonical-smiles"),
    inchiKey: identifier(run, "rdkit.inchikey"),
    logP: scalar(run, "rdkit.crippen-logp"),
    tpsa: scalar(run, "rdkit.tpsa"),
    hbd: scalar(run, "rdkit.hbd"),
    hba: scalar(run, "rdkit.hba"),
    rotatableBonds: scalar(run, "rdkit.rotatable-bonds"),
    pka
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
    const summary = summarizeAnalysisRun(run);
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
    let allSucceeded = true;
    for (const [index, job] of jobs.entries()) {
      if (!await analyzeJob(job, index, parsed, io)) allSucceeded = false;
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    return handleCliError(error, io, "analyze");
  }
}

export const analyzeCommand = {
  name: "analyze",
  summary: "Analyze structures with the property and prediction suite.",
  run: runAnalyzeCommand
} as const;
