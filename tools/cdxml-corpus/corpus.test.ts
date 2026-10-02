/**
 * Opt-in stress test over a folder of real CDXML/CDX files (none are committed — AGENTS.md §6.24).
 *
 *   CHEMDRAFT_CDXML_CORPUS=<folder> pnpm vitest run tools/cdxml-corpus
 *
 * Every file goes through what File ▸ Open does (read as text, `openNativeDocument`), then SVG and
 * CDXML export, then a native save → reopen round trip that must keep every atom and bond. A file
 * may fail to open — plenty of inputs are not CDXML — but only with an explicit message: a thrown
 * exception, a hang, a silently empty document, or a round trip that loses chemistry is a failure.
 * A summary is written to `<folder>/corpus-report.json`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { exportDocumentToCdxml, exportDocumentToSvg } from "@chemdraft/export-engine";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { createNativeSavePayload, openNativeDocument } from "../../apps/desktop/src/documentWorkflow";
import { decodeDocumentBytes } from "../../apps/desktop/src/documentText";

const corpusDir = process.env.CHEMDRAFT_CDXML_CORPUS;
const SLOW_STAGE_MS = 5_000;

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listFiles(full);
    return /\.(cdx|cdxml|chemdraft)$/i.test(name) ? [full] : [];
  });
}

function chemistryCounts(document: ChemDraftDocument) {
  let molecules = 0;
  let atoms = 0;
  let bonds = 0;
  let objects = 0;
  for (const page of document.pages) {
    for (const object of page.objects) {
      objects += 1;
      if (object.type === "molecule") {
        molecules += 1;
        atoms += object.atoms.length;
        bonds += object.bonds.length;
      }
    }
  }
  return { objects, molecules, atoms, bonds };
}

interface FileReport {
  file: string;
  bytes: number;
  outcome: "opened" | "refused" | "failed";
  source?: string;
  counts?: ReturnType<typeof chemistryCounts>;
  openWarnings?: string[];
  refusal?: string;
  problems: string[];
  slowStages: string[];
}

function timed<T>(report: FileReport, stage: string, run: () => T): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    const elapsed = performance.now() - started;
    if (elapsed > SLOW_STAGE_MS) report.slowStages.push(`${stage} ${Math.round(elapsed)} ms`);
  }
}

/** A non-finite number in an attribute or path, ignoring the base64 ChemDraft payload (whose text can
 *  contain "NaN" by chance). */
function hasNonFiniteNumber(markup: string): boolean {
  // A linear walk over attribute values: a regular expression over a multi-megabyte payload
  // overflows V8's regex stack (the same limit cdx-compat had to work around).
  for (let open = markup.indexOf('="'); open !== -1; open = markup.indexOf('="', open + 2)) {
    const close = markup.indexOf('"', open + 2);
    if (close === -1) {
      break;
    }
    const value = markup.slice(open + 2, close);
    if (value.length <= 4096 && /\b(NaN|-?Infinity)\b/.test(value)) {
      return true;
    }
    open = close;
  }
  return false;
}

function warningText(warning: unknown): string {
  if (typeof warning === "string") return warning;
  const record = warning as { message?: string; code?: string };
  return record.message ?? record.code ?? JSON.stringify(warning);
}

function checkFile(file: string): FileReport {
  const buffer = readFileSync(file);
  const report: FileReport = { file: relative(corpusDir!, file), bytes: buffer.length, outcome: "failed", problems: [], slowStages: [] };
  // What File ▸ Open (and a shell open) hands the opener: the bytes decoded by their byte-order mark.
  const contents = decodeDocumentBytes(buffer);
  let opened: ReturnType<typeof openNativeDocument>;
  try {
    opened = timed(report, "open", () => openNativeDocument(contents));
  } catch (error) {
    report.problems.push(`open threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return report;
  }
  const warnings = (opened.warnings ?? []).map(warningText);
  const document = opened.document ?? opened.conflict?.visibleDocument ?? opened.conflict?.embeddedDocument;
  if (!document) {
    report.outcome = "refused";
    report.refusal = warnings.join(" | ") || "(no message)";
    if (!warnings.length) report.problems.push("refused without any message");
    return report;
  }
  report.outcome = "opened";
  report.source = opened.source;
  report.openWarnings = warnings;
  const counts = chemistryCounts(document);
  report.counts = counts;
  if (counts.objects === 0 && warnings.length === 0) {
    report.problems.push("opened as an empty document with no warning");
  }

  try {
    const svg = timed(report, "svg", () => exportDocumentToSvg(document));
    if (!svg.contents.startsWith("<svg") && !svg.contents.includes("<svg")) report.problems.push("SVG export produced no <svg>");
    if (hasNonFiniteNumber(svg.contents)) report.problems.push("SVG export contains NaN/Infinity coordinates");
  } catch (error) {
    report.problems.push(`SVG export threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const cdxml = timed(report, "cdxml", () => exportDocumentToCdxml(document));
    if (hasNonFiniteNumber(cdxml.contents)) report.problems.push("CDXML export contains NaN/Infinity");
    const reopened = timed(report, "cdxml reopen", () => openNativeDocument(cdxml.contents));
    if (!reopened.document) report.problems.push("exported CDXML does not reopen");
  } catch (error) {
    report.problems.push(`CDXML export/reopen threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const payload = timed(report, "save", () => createNativeSavePayload(document));
    const reopened = timed(report, "save reopen", () => openNativeDocument(payload.contents));
    if (!reopened.document) {
      report.problems.push(`saved file does not reopen: ${(reopened.warnings ?? []).map(warningText).join(" | ")}`);
    } else {
      const after = chemistryCounts(reopened.document);
      if (after.atoms !== counts.atoms || after.bonds !== counts.bonds || after.molecules !== counts.molecules) {
        report.problems.push(
          `save round trip changed chemistry: ${counts.molecules}/${counts.atoms}/${counts.bonds} → ${after.molecules}/${after.atoms}/${after.bonds} (molecules/atoms/bonds)`
        );
      }
    }
  } catch (error) {
    report.problems.push(`save/reopen threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}

describe.skipIf(!corpusDir)("CDXML corpus", () => {
  it("opens, exports, and round-trips every file or refuses it with a message", { timeout: 30 * 60_000 }, () => {
    const files = listFiles(corpusDir!);
    expect(files.length).toBeGreaterThan(0);
    const reports = files.map(checkFile);
    const summary = {
      files: reports.length,
      opened: reports.filter((r) => r.outcome === "opened").length,
      refused: reports.filter((r) => r.outcome === "refused").length,
      withProblems: reports.filter((r) => r.problems.length > 0).length,
      slow: reports.filter((r) => r.slowStages.length > 0).length
    };
    writeFileSync(join(corpusDir!, "corpus-report.json"), JSON.stringify({ summary, reports }, null, 2));
    console.log(JSON.stringify(summary));
    const problems = reports.filter((r) => r.problems.length > 0).map((r) => `${r.file}: ${r.problems.join("; ")}`);
    expect(problems).toEqual([]);
  });
});
