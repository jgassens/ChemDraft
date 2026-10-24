import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  nativeDrawingStyleFromCdxmlStyle,
  openChemDraftPayload,
  readCdxmlDocumentStyle,
  type CdxmlDocumentStyle
} from "@chemdraft/cdx-compat";
import type { NativeDrawingStyle } from "@chemdraft/chem-core";
import {
  moleculeToMolfileV2000,
  moleculeToMolfileV3000,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { exportDocumentToCdxml, type ExportWarning } from "@chemdraft/export-engine";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { moleculeSmiles } from "@chemdraft/document-workflow-core";

import { parseOptions, stringOption } from "../args";
import {
  assertCanonicalIdentity,
  buildSmilesDocument,
  currentMoleculeIdentityMolfile,
  type BuiltSmilesDocument
} from "../document";
import { installNodeEngines } from "../engine";
import { installPdfTextMetrics } from "../pdfTextMetrics";
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

export type ExportFormat = "cdxml" | "pdf" | "sdf" | "mol" | "smi";

const COMBINED_FORMATS: readonly ExportFormat[] = ["sdf", "smi"];
const EXTENSION_FORMAT: Readonly<Record<string, ExportFormat>> = {
  ".cdxml": "cdxml",
  ".pdf": "pdf",
  ".sdf": "sdf",
  ".mol": "mol",
  ".smi": "smi"
};

export interface ExportJob {
  name: string;
  smiles: string;
}

interface ParsedArguments {
  mode: "single" | "batch";
  jobsFile?: string;
  out?: string;
  outDir?: string;
  smiles?: string;
  format: ExportFormat;
  styleReference?: string;
}

/** Names a CDXML file whose drawing settings every CDXML export uses unless --style-reference
 *  names another. It overrides the default style file below. */
export const CDXML_STYLE_REFERENCE_ENV = "CHEMDRAFT_CDXML_STYLE_REFERENCE";

/**
 * The per-user default style reference, `~/.config/chemdraft/cdxml-style.cdxml` beside the plugin
 * trust file: a CDXML export with no --style-reference and no environment override uses it when it
 * exists. The home directory comes from the OS account (`os.userInfo().homedir`), as for the trust
 * file, so every client that launches the CLI or MCP server finds the same file without being
 * configured. `lookup` is a seam for tests. An undeterminable home directory means no default.
 */
export function resolveDefaultCdxmlStylePath(lookup: () => { homedir: string } = userInfo): string | undefined {
  try {
    const home = lookup().homedir;
    return home ? join(home, ".config", "chemdraft", "cdxml-style.cdxml") : undefined;
  } catch {
    return undefined;
  }
}

const MAX_STYLE_REFERENCE_BYTES = 5 * 1024 * 1024;

/** A style reference that loaded: CDXML settings for the file header, the matching native
 *  drawing style for the molecule, and the CDXML attributes the reference left unset. */
export interface LoadedStyleReference {
  path: string;
  style: CdxmlDocumentStyle;
  drawingStyle: Partial<NativeDrawingStyle>;
  missing: string[];
}

export const exportHelp = `ChemDraft headless document exporter

Usage:
  pnpm -s chemdraft export --smiles <SMILES> --out <file.cdxml|.pdf|.sdf|.mol|.smi>
  pnpm -s chemdraft export --batch <jobs.json> --out-dir <dir> --format cdxml|pdf|mol
  pnpm -s chemdraft export --batch <jobs.json> --out <file> --format sdf|smi

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}.
Names are trimmed; blank/duplicate names, path separators, and names beginning with a dot are rejected.
--format sdf and --format smi combine every batch structure into ONE file written to --out.
Every other format writes one file per structure into --out-dir, named <job name>.<extension>.

Options:
  --format cdxml|pdf|sdf|mol|smi   Output format (single mode normally infers it from --out)
  --style-reference <file.cdxml>    CDXML only: take bond length, line widths, hash spacing, bond spacing,
                                    chain angle and label font, size and face from this CDXML file
  --help                            Print this help

Default style:
  A CDXML export without --style-reference uses ${CDXML_STYLE_REFERENCE_ENV} when set, otherwise
  ~/.config/chemdraft/cdxml-style.cdxml when that file exists.

Output:
  One JSON line per structure is written to stdout. Progress is written to stderr.
  Exit 0 when every structure succeeds, 1 when any export fails, and 2 for bad arguments.`;

const exportOptions = {
  "--smiles": { kind: "value" },
  "--batch": { kind: "value" },
  "--out": { kind: "value" },
  "--out-dir": { kind: "value" },
  "--format": { kind: "value" },
  "--style-reference": { kind: "value" },
  "--help": { kind: "boolean" }
} as const;

function parseFormat(value: string): ExportFormat {
  if (value !== "cdxml" && value !== "pdf" && value !== "sdf" && value !== "mol" && value !== "smi") {
    throw new CliUsageError(`--format must be one of cdxml, pdf, sdf, mol, smi; received "${value}".`);
  }
  return value;
}

function parseArguments(argv: readonly string[]): ParsedArguments | { help: true } {
  if (argv.includes("--help")) return { help: true };
  const parsed = parseOptions(argv, exportOptions);
  if (parsed.positionals.length > 0) {
    throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
  }

  const smiles = stringOption(parsed, "--smiles");
  const jobsFile = stringOption(parsed, "--batch");
  const out = stringOption(parsed, "--out");
  const outDir = stringOption(parsed, "--out-dir");
  const requestedFormat = stringOption(parsed, "--format");
  const format = requestedFormat === undefined ? undefined : parseFormat(requestedFormat);
  const styleReference = stringOption(parsed, "--style-reference");

  if ((smiles ? 1 : 0) + (jobsFile ? 1 : 0) !== 1) {
    throw new CliUsageError("Provide exactly one of --smiles or --batch.");
  }

  if (smiles !== undefined) {
    if (!out) throw new CliUsageError("Single-structure mode requires --out.");
    if (outDir) throw new CliUsageError("--out-dir is only valid with --batch.");
    const extension = extname(out).toLowerCase();
    const inferred = EXTENSION_FORMAT[extension];
    if (!format && !inferred) {
      throw new CliUsageError(
        "--out must end in .cdxml, .pdf, .sdf, .mol, or .smi unless --format is provided."
      );
    }
    if (format && inferred && format !== inferred) {
      throw new CliUsageError(`--format ${format} conflicts with the --out extension "${extension}".`);
    }
    return withStyleReference({ mode: "single", smiles, out, format: format ?? inferred! }, styleReference);
  }

  if (!format) throw new CliUsageError("Batch mode requires --format.");
  if (COMBINED_FORMATS.includes(format)) {
    if (!out) throw new CliUsageError(`--format ${format} with --batch requires --out.`);
    if (outDir) throw new CliUsageError(`--out-dir is not valid with --format ${format}; use --out.`);
    return withStyleReference({ mode: "batch", jobsFile, out, format }, styleReference);
  }
  if (!outDir) throw new CliUsageError(`--format ${format} with --batch requires --out-dir.`);
  if (out) throw new CliUsageError(`--out is not valid with --format ${format}; use --out-dir.`);
  return withStyleReference({ mode: "batch", jobsFile, outDir, format }, styleReference);
}

function withStyleReference(parsed: ParsedArguments, styleReference: string | undefined): ParsedArguments {
  if (styleReference === undefined) return parsed;
  if (parsed.format !== "cdxml") {
    throw new CliUsageError(`--style-reference applies only to CDXML exports, not --format ${parsed.format}.`);
  }
  return { ...parsed, styleReference };
}

/** The reference this export uses, CDXML only: the option, else the environment override, else
 *  the per-user default style file when it exists. A missing default file means no style. */
async function styleReferencePath(
  parsed: ParsedArguments,
  env: NodeJS.ProcessEnv,
  defaultStylePath: string | null
): Promise<{ path: string; source: string } | undefined> {
  if (parsed.styleReference !== undefined) return { path: parsed.styleReference, source: "--style-reference" };
  if (parsed.format !== "cdxml") return undefined;
  const configured = env[CDXML_STYLE_REFERENCE_ENV]?.trim();
  if (configured) {
    const expanded = configured === "~" || configured.startsWith("~/") ? join(homedir(), configured.slice(1)) : configured;
    return { path: resolve(expanded), source: CDXML_STYLE_REFERENCE_ENV };
  }
  if (defaultStylePath === null) return undefined;
  try {
    await stat(defaultStylePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  return { path: defaultStylePath, source: "default style file" };
}

/** Read a CDXML style reference, failing the whole run (exit 2) with the reason when it cannot be used. */
export async function loadStyleReference(path: string, source = "--style-reference"): Promise<LoadedStyleReference> {
  const unusable = (reason: string) => new CliUsageError(`CDXML style reference "${path}" (${source}) cannot be used: ${reason}`);
  let contents: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw unusable("it is not a file.");
    if (info.size > MAX_STYLE_REFERENCE_BYTES) throw unusable(`it is larger than ${MAX_STYLE_REFERENCE_BYTES} bytes.`);
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw unusable(error instanceof Error ? error.message : String(error));
  }
  try {
    const { style, missing } = readCdxmlDocumentStyle(contents);
    return { path, style, drawingStyle: nativeDrawingStyleFromCdxmlStyle(style), missing };
  } catch (error) {
    throw unusable(error instanceof Error ? error.message : String(error));
  }
}

function styleReferenceWarnings(reference: LoadedStyleReference | undefined): string[] {
  if (reference === undefined || reference.missing.length === 0) return [];
  return [`CDXML style reference "${reference.path}" sets no ${reference.missing.join(", ")}; ChemDraft's own values were kept for those.`];
}

async function readJobs(path: string): Promise<ExportJob[]> {
  return readBatchFile(path, parseNamedSmilesJob, (job) => {
    if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
  });
}

function jobErrorMessage(error: unknown, job: ExportJob): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(job.smiles) ? message : `Unable to export SMILES "${job.smiles}": ${message}`;
}

/**
 * Set up the same DOM globals svg2pdf/jsPDF read off `globalThis` during PDF export
 * (packages/export-engine/src/pdf.test.ts's withPdfDom). Production ChemDraft always runs inside a
 * real webview; this CLI runs in plain Node, so the shim has to be recreated here rather than
 * reused, since export-engine does not publish it as a runtime API.
 */
let pdfDomQueue: Promise<void> = Promise.resolve();

async function withInstalledPdfDom<T>(callback: (domParser: DOMParser) => Promise<T>): Promise<T> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const writableGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const globalKeys = [
    "window",
    "document",
    "DOMParser",
    "Node",
    "Element",
    "SVGElement",
    "HTMLElement",
    "XMLSerializer",
    "getComputedStyle",
    "navigator"
  ] as const;
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(writableGlobal, key)])
  );
  const previousGetBBox = Object.getOwnPropertyDescriptor(dom.window.SVGElement.prototype, "getBBox");
  const previousGetComputedTextLength = Object.getOwnPropertyDescriptor(dom.window.SVGElement.prototype, "getComputedTextLength");
  const previousGetContext = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, "getContext");
  let textMetrics: ReturnType<typeof installPdfTextMetrics> | undefined;

  try {
    const measurements = installPdfTextMetrics(dom.window.SVGElement.prototype);
    textMetrics = measurements;
    const define = (key: string, value: unknown) =>
      Object.defineProperty(writableGlobal, key, { configurable: true, writable: true, value });
    define("window", dom.window);
    define("document", dom.window.document);
    define("DOMParser", dom.window.DOMParser);
    define("Node", dom.window.Node);
    define("Element", dom.window.Element);
    define("SVGElement", dom.window.SVGElement);
    define("HTMLElement", dom.window.HTMLElement);
    define("XMLSerializer", dom.window.XMLSerializer);
    define("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
    define("navigator", dom.window.navigator);
    Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
      configurable: true,
      value: function (this: SVGElement) {
        if (this.localName === "text" || this.localName === "tspan") return measurements.textBox(this);
        // svg2pdf 2.7 only calls DOM getBBox on its synthetic text-measurement element.
        // Shapes/groups use svg2pdf's own geometry, so this legacy fallback is not consulted.
        return { x: 0, y: 0, width: 80, height: 16 };
      }
    });
    Object.defineProperty(dom.window.SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value: function (this: SVGElement) { return measurements.textWidth(this); }
    });
    Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null
    });
    return await callback(new dom.window.DOMParser());
  } finally {
    try {
      textMetrics?.restore();
      if (previousGetComputedTextLength) {
        Object.defineProperty(dom.window.SVGElement.prototype, "getComputedTextLength", previousGetComputedTextLength);
      } else {
        Reflect.deleteProperty(dom.window.SVGElement.prototype, "getComputedTextLength");
      }
      if (previousGetContext) {
        Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", previousGetContext);
      } else {
        Reflect.deleteProperty(dom.window.HTMLCanvasElement.prototype, "getContext");
      }
      if (previousGetBBox) {
        Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", previousGetBBox);
      } else {
        Reflect.deleteProperty(dom.window.SVGElement.prototype, "getBBox");
      }
      for (const [key, descriptor] of previousDescriptors) {
        if (!descriptor) {
          Reflect.deleteProperty(writableGlobal, key);
        } else {
          Object.defineProperty(writableGlobal, key, descriptor);
        }
      }
    } finally {
      dom.window.close();
    }
  }
}

/** Serialize installation, export, and exact restoration of process-global DOM shims. */
export async function withPdfDom<T>(callback: (domParser: DOMParser) => Promise<T>): Promise<T> {
  const run = pdfDomQueue.then(() => withInstalledPdfDom(callback));
  pdfDomQueue = run.then(() => undefined, () => undefined);
  return run;
}

interface PerJobExportResult {
  contents: string | Uint8Array;
  warnings: string[];
}

async function verifiedSourceCanonicalSmiles(built: BuiltSmilesDocument, warnings: string[] = []): Promise<string> {
  if (!built.identityVerifiedByRdkit || built.sourceCanonicalSmiles === undefined) {
    throw new Error(
      "Unable to export safely: RDKit could not canonicalize the input, so chemical identity cannot be verified."
    );
  }
  // Do not accept a supposedly verified canonical source made from an already lossy molfile.
  const notes: ExportWarning[] = [];
  await currentMoleculeIdentityMolfile(built.molecule, [], notes);
  warnings.push(...notes.map((note) => note.message));
  return built.sourceCanonicalSmiles;
}

async function assertCdxmlRoundTripIdentity(
  contents: string,
  built: BuiltSmilesDocument,
  sourceCanonicalSmiles: string
): Promise<string[]> {
  const opened = openChemDraftPayload(contents);
  const molecules = opened.document?.pages.flatMap((page) =>
    page.objects.filter((object): object is MoleculeObject => object.type === "molecule")
  ) ?? [];
  if (molecules.length !== 1) {
    throw new Error(
      `Unable to verify CDXML identity: reopening the written file produced ${molecules.length} molecule objects.`
    );
  }
  const molecule = molecules[0]!;
  const kekuleBondOrders = nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders;
  const warnings: string[] = [];
  const molfile = built.dativeBonds > 0
    ? moleculeToMolfileV3000(molecule, { fromDocFrame: true, kekuleBondOrders, warnings }).contents
    : moleculeToMolfileV2000(molecule, { fromDocFrame: true, kekuleBondOrders, warnings }).contents;
  await assertCanonicalIdentity(sourceCanonicalSmiles, molfile);
  return warnings;
}

export async function exportPerJobFormat(
  format: "cdxml" | "pdf" | "mol",
  built: BuiltSmilesDocument,
  documentStyle?: CdxmlDocumentStyle
): Promise<PerJobExportResult> {
  const identityWarnings: string[] = [];
  const sourceCanonicalSmiles = await verifiedSourceCanonicalSmiles(built, identityWarnings);
  if (format === "cdxml") {
    const result = exportDocumentToCdxml(built.document, { documentStyle });
    const warnings = await assertCdxmlRoundTripIdentity(result.contents, built, sourceCanonicalSmiles);
    return { contents: result.contents, warnings: [...identityWarnings, ...result.warnings.map((warning) => warning.message), ...warnings] };
  }
  if (format === "pdf") {
    // Keep the jsPDF/svg2pdf implementation and its Node JSDOM shim out of non-PDF exports.
    const { exportDocumentToPdf } = await import("@chemdraft/export-engine/pdf");
    const result = await withPdfDom((domParser) =>
      exportDocumentToPdf(built.document, { domParser, pageIndex: 0 })
    );
    return { contents: result.bytes, warnings: [...identityWarnings, ...result.warnings.map((warning) => warning.message)] };
  }
  await assertCanonicalIdentity(sourceCanonicalSmiles, built.identityMolfile);
  return { contents: built.identityMolfile, warnings: identityWarnings };
}

async function runPerJobExport(
  jobs: readonly ExportJob[],
  format: "cdxml" | "pdf" | "mol",
  outFor: (job: ExportJob) => string,
  io: CliIo,
  styleReference?: LoadedStyleReference
): Promise<boolean> {
  let allSucceeded = true;
  for (const job of jobs) {
    writeProgress(io, `Exporting ${job.name}…`);
    const out = outFor(job);
    try {
      const built = await buildSmilesDocument(job.smiles, { name: job.name, drawingStyle: styleReference?.drawingStyle });
      const exported = await exportPerJobFormat(format, built, styleReference?.style);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, exported.contents);
      const bytes = typeof exported.contents === "string"
        ? Buffer.byteLength(exported.contents)
        : exported.contents.byteLength;
      writeJsonLine(io, {
        name: job.name,
        smiles: job.smiles,
        ok: true,
        out,
        format,
        bytes,
        ...(styleReference === undefined ? {} : { styleReference: styleReference.path }),
        warnings: [...styleReferenceWarnings(styleReference), ...built.warnings, ...exported.warnings]
      });
      writeProgress(io, `Wrote ${out}`);
    } catch (error) {
      const message = jobErrorMessage(error, job);
      writeJsonLine(io, { name: job.name, smiles: job.smiles, ok: false, error: message });
      writeProgress(io, `Failed ${job.name}: ${message}`);
      allSucceeded = false;
    }
  }
  return allSucceeded;
}

interface CombinedRecord {
  job: ExportJob;
  content: string;
  warnings: string[];
}

async function combinedRecord(
  format: "sdf" | "smi",
  job: ExportJob,
  index: number
): Promise<CombinedRecord> {
  const built = await buildSmilesDocument(job.smiles, { name: job.name });
  const warnings = [...built.warnings];
  const molfile = built.identityMolfile;
  const sourceCanonicalSmiles = await verifiedSourceCanonicalSmiles(built);
  await assertCanonicalIdentity(sourceCanonicalSmiles, molfile);

  const smilesWarnings: ExportWarning[] = [];
  const smiles = await moleculeSmiles(
    built.molecule,
    index,
    smilesWarnings,
    computeStructureIdentifiers,
    molfile,
    { requireEngineAtomStates: true }
  );
  const loss = smilesWarnings.find((warning) => warning.severity !== "info" &&
    !(built.dativeBonds > 0 && warning.code === "export.smiles_dative_bond"));
  if (loss) throw new Error(`Cannot export without changing chemical identity: ${loss.message}`);
  await assertCanonicalIdentity(sourceCanonicalSmiles, smiles);
  warnings.push(...smilesWarnings
    // The shared desktop helper still assumes its usual V2000 input. This CLI supplied a V3000
    // molfile and the identity check above proved RDKit retained every dative bond.
    .filter((warning) => !(built.dativeBonds > 0 && warning.code === "export.smiles_dative_bond"))
    .map((warning) => warning.message));

  if (format === "smi") {
    return { job, content: `${smiles}\t${job.name}\n`, warnings };
  }

  const title = job.name;
  const body = molfile.slice(molfile.indexOf("\n"));
  const content = `${title}${body}` +
    `> <SMILES>\n${smiles}\n\n` +
    `> <Index>\n${index + 1}\n\n` +
    `> <Name>\n${job.name}\n\n` +
    "$$$$\n";
  return { job, content, warnings };
}

async function runCombinedExport(
  jobs: readonly ExportJob[],
  format: "sdf" | "smi",
  out: string,
  io: CliIo
): Promise<boolean> {
  let allSucceeded = true;
  const records: CombinedRecord[] = [];
  const failures: { job: ExportJob; message: string }[] = [];

  for (const [index, job] of jobs.entries()) {
    writeProgress(io, `Exporting ${job.name}…`);
    try {
      records.push(await combinedRecord(format, job, index));
    } catch (error) {
      const message = jobErrorMessage(error, job);
      failures.push({ job, message });
      allSucceeded = false;
    }
  }

  const combined = records.map((record) => record.content).join("");
  if (records.length === 0) {
    for (const failure of failures) {
      writeJsonLine(io, { name: failure.job.name, smiles: failure.job.smiles, ok: false, error: failure.message });
      writeProgress(io, `Failed ${failure.job.name}: ${failure.message}`);
    }
    return false;
  }

  try {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, combined);
  } catch (error) {
    const fileError = `Could not write combined ${format.toUpperCase()} file "${out}": ${error instanceof Error ? error.message : String(error)}`;
    for (const record of records) {
      writeJsonLine(io, {
        name: record.job.name,
        smiles: record.job.smiles,
        ok: false,
        out,
        format,
        error: fileError
      });
    }
    for (const failure of failures) {
      writeJsonLine(io, { name: failure.job.name, smiles: failure.job.smiles, ok: false, error: failure.message });
    }
    writeProgress(io, `Failed combined export: ${fileError}`);
    return false;
  }
  const bytes = Buffer.byteLength(combined);
  writeProgress(io, `Wrote ${out}`);

  for (const record of records) {
    writeJsonLine(io, {
      name: record.job.name,
      smiles: record.job.smiles,
      ok: true,
      out,
      format,
      bytes,
      warnings: record.warnings
    });
  }
  for (const failure of failures) {
    writeJsonLine(io, { name: failure.job.name, smiles: failure.job.smiles, ok: false, error: failure.message });
    writeProgress(io, `Failed ${failure.job.name}: ${failure.message}`);
  }
  return allSucceeded;
}

/** Run the `chemdraft export` subcommand. */
export async function runExportCommand(
  argv: readonly string[],
  io: CliIo = defaultCliIo,
  env: NodeJS.ProcessEnv = process.env,
  // null: no default style file. Not `undefined`, which would select the account's real one.
  defaultStylePath: string | null = resolveDefaultCdxmlStylePath() ?? null
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(exportHelp);
      return cliExitCode.ok;
    }

    const referencePath = await styleReferencePath(parsed, env, defaultStylePath);
    const styleReference = referencePath === undefined ? undefined
      : await loadStyleReference(referencePath.path, referencePath.source);

    installNodeEngines();

    const jobs: ExportJob[] = parsed.mode === "single"
      ? [{ name: basename(baseWithoutKnownExtension(parsed.out!)) || "structure", smiles: parsed.smiles! }]
      : await readJobs(parsed.jobsFile!);

    let allSucceeded: boolean;
    if (COMBINED_FORMATS.includes(parsed.format)) {
      const out = parsed.out!;
      allSucceeded = await runCombinedExport(jobs, parsed.format as "sdf" | "smi", out, io);
    } else {
      const format = parsed.format as "cdxml" | "pdf" | "mol";
      const outFor = parsed.mode === "single"
        ? () => parsed.out!
        : (job: ExportJob) => join(parsed.outDir!, `${job.name}.${format}`);
      if (parsed.mode === "batch") await mkdir(parsed.outDir!, { recursive: true });
      allSucceeded = await runPerJobExport(jobs, format, outFor, io, styleReference);
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    return handleCliError(error, io, "export");
  }
}

function baseWithoutKnownExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension in EXTENSION_FORMAT ? path.slice(0, -extension.length) : path;
}

export const exportCommand = {
  name: "export",
  summary: "Export SMILES to CDXML, PDF, SDF, MOL, or SMILES files.",
  run: runExportCommand
} as const;
