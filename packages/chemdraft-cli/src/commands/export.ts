import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { JSDOM } from "jsdom";

import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, type ExportWarning } from "@chemdraft/export-engine";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";

import { moleculeSmiles } from "../../../../apps/desktop/src/moleculeSmiles";

import { parseOptions, stringOption } from "../args";
import { buildSmilesDocument } from "../document";
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
}

export const exportHelp = `ChemDraft headless document exporter

Usage:
  pnpm chemdraft export --smiles <SMILES> --out <file.cdxml|.pdf|.sdf|.mol|.smi>
  pnpm chemdraft export --batch <jobs.json> --out-dir <dir> --format cdxml|pdf|mol
  pnpm chemdraft export --batch <jobs.json> --out <file> --format sdf|smi

Batch input is a JSON array of {"name":"aspirin","smiles":"CC(=O)Oc1ccccc1C(=O)O"}.
Names are trimmed; blank/duplicate names, path separators, and names beginning with a dot are rejected.
--format sdf and --format smi combine every batch structure into ONE file written to --out.
Every other format writes one file per structure into --out-dir, named <job name>.<extension>.

Options:
  --format cdxml|pdf|sdf|mol|smi   Output format (single mode normally infers it from --out)
  --help                            Print this help

Output:
  One JSON line per structure is written to stdout. Progress is written to stderr.
  Exit 0 when every structure succeeds, 1 when any export fails, and 2 for bad arguments.`;

const exportOptions = {
  "--smiles": { kind: "value" },
  "--batch": { kind: "value" },
  "--out": { kind: "value" },
  "--out-dir": { kind: "value" },
  "--format": { kind: "value" },
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
    return { mode: "single", smiles, out, format: format ?? inferred! };
  }

  if (!format) throw new CliUsageError("Batch mode requires --format.");
  if (COMBINED_FORMATS.includes(format)) {
    if (!out) throw new CliUsageError(`--format ${format} with --batch requires --out.`);
    if (outDir) throw new CliUsageError(`--out-dir is not valid with --format ${format}; use --out.`);
    return { mode: "batch", jobsFile, out, format };
  }
  if (!outDir) throw new CliUsageError(`--format ${format} with --batch requires --out-dir.`);
  if (out) throw new CliUsageError(`--out is not valid with --format ${format}; use --out-dir.`);
  return { mode: "batch", jobsFile, outDir, format };
}

async function readJobs(path: string): Promise<ExportJob[]> {
  return readBatchFile(path, (candidate, index) => {
    if (
      !candidate || typeof candidate !== "object" ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { smiles?: unknown }).smiles !== "string"
    ) {
      throw new CliUsageError(`Batch job ${index + 1} must contain string "name" and "smiles" fields.`);
    }
    return candidate as ExportJob;
  }, (job) => {
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
async function withPdfDom<T>(callback: (domParser: DOMParser) => Promise<T>): Promise<T> {
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
  const previousGetContext = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, "getContext");

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
    value: () => ({ x: 0, y: 0, width: 80, height: 16 })
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null
  });

  try {
    return await callback(new dom.window.DOMParser());
  } finally {
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
  }
}

interface PerJobExportResult {
  contents: string | Uint8Array;
  warnings: string[];
}

async function exportPerJobFormat(
  format: "cdxml" | "pdf" | "mol",
  document: ChemDraftDocument,
  molecule: MoleculeObject
): Promise<PerJobExportResult> {
  if (format === "cdxml") {
    const result = exportDocumentToCdxml(document);
    return { contents: result.contents, warnings: result.warnings.map((warning) => warning.message) };
  }
  if (format === "pdf") {
    // Loaded lazily: packages/export-engine/src/pdf.ts statically imports svg2pdf.js's UMD
    // bundle, which Node's native ESM loader cannot resolve to a named export outside a
    // bundler/vitest transform. Deferring the import keeps every other format working under
    // plain `tsx`/`node` and turns a PDF request into a normal per-job failure instead of a
    // process crash.
    const { exportDocumentToPdf } = await import("@chemdraft/export-engine/pdf");
    const result = await withPdfDom((domParser) =>
      exportDocumentToPdf(document, { domParser, pageIndex: 0 })
    );
    return { contents: result.bytes, warnings: result.warnings.map((warning) => warning.message) };
  }
  const warnings: string[] = [];
  const molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true, warnings });
  return { contents: molfile, warnings };
}

async function runPerJobExport(
  jobs: readonly ExportJob[],
  format: "cdxml" | "pdf" | "mol",
  outFor: (job: ExportJob) => string,
  io: CliIo
): Promise<boolean> {
  let allSucceeded = true;
  for (const job of jobs) {
    writeProgress(io, `Exporting ${job.name}…`);
    const out = outFor(job);
    try {
      const built = await buildSmilesDocument(job.smiles, { name: job.name });
      const exported = await exportPerJobFormat(format, built.document, built.molecule);
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
        warnings: [...built.warnings, ...exported.warnings]
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
  const molfileWarnings: string[] = [];
  const molfile = moleculeToMolfileV2000(built.molecule, { fromDocFrame: true, warnings: molfileWarnings });
  warnings.push(...molfileWarnings);

  const smilesWarnings: ExportWarning[] = [];
  const smiles = await moleculeSmiles(
    built.molecule,
    index,
    smilesWarnings,
    computeStructureIdentifiers,
    molfile
  );
  warnings.push(...smilesWarnings.map((warning) => warning.message));

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
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, combined);
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
  io: CliIo = defaultCliIo
): Promise<CliExitCode> {
  try {
    const parsed = parseArguments(argv);
    if ("help" in parsed) {
      io.stdout(exportHelp);
      return cliExitCode.ok;
    }

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
      allSucceeded = await runPerJobExport(jobs, format, outFor, io);
    }
    return resultExitCode(allSucceeded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}`);
    io.stderr("Run pnpm chemdraft export --help for usage.");
    return error instanceof CliUsageError ? cliExitCode.badArguments : cliExitCode.failed;
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
