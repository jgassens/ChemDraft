/**
 * The provenance report (PLANS.md §9 Release 1, §10).
 *
 * "A copyable/exportable provenance report" — the artifact that makes Release 1's numbers reviewable
 * by someone who was not watching them being computed. It answers, for every value on screen: which
 * molecule is this about, which method produced it, what convention did that method choose, and what
 * did the run decline to answer.
 *
 * Two decisions worth stating.
 *
 * **Grouping reads `classification.claim`.** §2 says the enums are "for display and grouping" and the
 * flags are what code branches on. This module is the display side of that bargain and the only place
 * a claim class decides anything — everything behavioural here reads the flags instead.
 *
 * **Declined methods get their own section rather than being omitted.** A report that silently drops
 * what it could not compute is how "TPSA unavailable" becomes indistinguishable from "TPSA not asked
 * for". §10 is blunt about which of those is the dangerous one.
 *
 * Engine- and UI-neutral: it consumes an `AnalysisRun` and emits a small section model plus text and
 * Markdown renderings. The desktop maps the same model onto its panel renderer.
 */
import {
  requiresConventionDisclosure,
  requiresEmpiricalProvenance,
  type Classification
} from "./classification";
import { interpretationChangesIdentity, type MolecularInterpretation } from "./interpretation";
import type { AnalysisResult, AnalysisRun } from "./results";
import { unit as unitDefinition, type UnitId } from "./units";

export interface ReportRow {
  label: string;
  value: string;
  /** Present when the value depends on a named convention the reader should see (§2). */
  note?: string;
}

export type AnalysisReportSection =
  | { kind: "keyValue"; title: string; rows: ReportRow[] }
  | { kind: "table"; title: string; columns: string[]; rows: string[][] }
  | { kind: "text"; title: string; body: string };

export interface ReportInterpretation {
  id: string;
  label: string;
  /** The one most results were computed against — what the panel's disclosure line names. */
  active: boolean;
  changesIdentity: boolean;
  /** One line per transformation, in ledger order. */
  ledger: string[];
}

export interface AnalysisReport {
  title: string;
  /** Every interpretation the run used. More than one means the "— change" affordance has somewhere to go. */
  interpretations: ReportInterpretation[];
  sections: AnalysisReportSection[];
  /** Engine name, version, and artifact hashes — the line that makes a number reproducible. */
  engineSummary: string;
  fingerprint: string;
}

// --- value formatting ----------------------------------------------------------------------------

function formatNumber(value: number, decimalPlaces?: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (decimalPlaces === undefined) return String(value);
  return value.toFixed(decimalPlaces);
}

function formatScalar(result: Extract<AnalysisResult, { kind: "scalar" }>): string {
  if (result.value === null) return "—";
  const symbol = unitSymbol(result.unit);
  const number = formatNumber(result.value, result.decimalPlaces);
  return symbol ? `${number} ${symbol}` : number;
}

function unitSymbol(id: UnitId): string {
  try {
    return unitDefinition(id).symbol;
  } catch {
    return "";
  }
}

/** The short marker that tells a reader the number is a choice, not a fact about the molecule. */
function conventionNote(classification: Classification): string | undefined {
  if (requiresEmpiricalProvenance(classification)) return "calibrated method — see Provenance";
  if (requiresConventionDisclosure(classification)) return "convention-dependent — see Provenance";
  return undefined;
}

function row(result: AnalysisResult, value: string, label = result.label): ReportRow {
  const note = conventionNote(result.classification);
  return { label, value, ...(note ? { note } : {}) };
}

/**
 * Drop the interpretation suffix from a row label when the whole report is about one interpretation.
 *
 * A derived result is labelled "Crippen logP · largest organic fragment · Na removed" so it stays
 * legible beside the declined source result. Under an override there is no source result to sit
 * beside, and the header already says "Computed on: largest organic fragment · Na removed" — so every
 * row repeating it is noise that pushes the actual values off the edge of the panel.
 */
function labelStripper(activeLabel: string | undefined, singleInterpretation: boolean) {
  const suffix = activeLabel ? ` \u00b7 ${activeLabel}` : "";
  return (result: AnalysisResult): string =>
    singleInterpretation && suffix.length > 0 && result.label.endsWith(suffix)
      ? result.label.slice(0, -suffix.length)
      : result.label;
}

// --- ledger prose --------------------------------------------------------------------------------

/** One human-readable line per transformation, built from the ledger rather than written by hand. */
export function ledgerLines(interpretation: MolecularInterpretation): string[] {
  return interpretation.transformations.map((step) => {
    const parts: string[] = [];
    if (step.componentsRemoved.length > 0) parts.push(`removed ${step.componentsRemoved.join(", ")}`);
    if (step.componentsRetained.length > 0) parts.push(`kept ${step.componentsRetained.join(", ")}`);
    if (step.chargeChanges !== 0) {
      parts.push(`${Math.abs(step.chargeChanges)} charge${Math.abs(step.chargeChanges) === 1 ? "" : "s"} removed`);
    }
    if (step.hydrogenChanges !== 0) {
      const direction = step.hydrogenChanges > 0 ? "added" : "removed";
      parts.push(`${Math.abs(step.hydrogenChanges)} hydrogen${Math.abs(step.hydrogenChanges) === 1 ? "" : "s"} ${direction}`);
    }
    if (step.tautomerChanged) parts.push("tautomer changed");
    for (const feature of step.unrepresentableFeatures) parts.push(`⚠ ${feature}`);
    return parts.length > 0 ? `${step.name}: ${parts.join("; ")}` : step.name;
  });
}

// --- the builder ---------------------------------------------------------------------------------

function isKind<K extends AnalysisResult["kind"]>(kind: K) {
  return (result: AnalysisResult): result is Extract<AnalysisResult, { kind: K }> => result.kind === kind;
}

/** The interpretation the most results were computed against; ties break toward `source`. */
function activeInterpretationId(run: AnalysisRun): string {
  const counts = new Map<string, number>();
  for (const result of run.results) {
    if (result.status !== "ok") continue;
    counts.set(result.interpretationId, (counts.get(result.interpretationId) ?? 0) + 1);
  }
  let best = run.interpretations[0]?.id ?? "source";
  let bestCount = -1;
  for (const interpretation of run.interpretations) {
    const count = counts.get(interpretation.id) ?? 0;
    if (count > bestCount) {
      best = interpretation.id;
      bestCount = count;
    }
  }
  return best;
}

export function buildAnalysisReport(run: AnalysisRun, options: { title?: string } = {}): AnalysisReport {
  const active = activeInterpretationId(run);
  const ok = run.results.filter((result) => result.status === "ok");
  const declined = run.results.filter((result) => result.status !== "ok");
  const sections: AnalysisReportSection[] = [];
  const displayLabel = labelStripper(
    run.interpretations.find((entry) => entry.id === active)?.label,
    new Set(run.results.map((result) => result.interpretationId)).size <= 1
  );

  // --- identity -----------------------------------------------------------------------------
  const identifiers = ok.filter(isKind("identifier"));
  if (identifiers.length > 0) {
    sections.push({
      kind: "keyValue",
      title: "Identity",
      rows: identifiers.map((result) => row(result, result.value ?? "—", displayLabel(result)))
    });
  }

  // --- composition --------------------------------------------------------------------------
  const composition = ok.find(isKind("composition"));
  const massRows = ok
    .filter(isKind("scalar"))
    .filter((result) => result.classification.claim === "composition")
    .map((result) => row(result, formatScalar(result), displayLabel(result)));

  if (composition || massRows.length > 0) {
    const rows: ReportRow[] = [];
    if (composition) {
      rows.push({ label: "Formula", value: composition.formula ?? "—" });
      rows.push({ label: "Formal charge", value: String(composition.formalCharge ?? "—") });
      if (composition.radicalElectronCount > 0) {
        rows.push({ label: "Radical electrons", value: String(composition.radicalElectronCount) });
      }
      if (composition.hasExplicitIsotopes) {
        rows.push({ label: "Isotope labels", value: "present — reflected in the formula and masses" });
      }
    }
    sections.push({ kind: "keyValue", title: "Composition", rows: [...rows, ...massRows] });
  }

  // Components get their own table only when there is more than one — a single-component molecule
  // does not need a table restating its own formula.
  const componentCount = composition?.components.reduce((total, entry) => total + entry.multiplicity, 0) ?? 0;
  if (composition && componentCount > 1) {
    sections.push({
      kind: "table",
      title: `Components (${componentCount})`,
      columns: ["Formula", "Charge", "Count"],
      rows: composition.components.map((component) => [
        component.formula,
        component.charge > 0 ? `+${component.charge}` : String(component.charge),
        String(component.multiplicity)
      ])
    });
  }

  // --- descriptors and predictions ------------------------------------------------------------
  const scalars = ok.filter(isKind("scalar"));
  const descriptors = scalars.filter((result) => result.classification.claim === "descriptor");
  const predictions = scalars.filter((result) => result.classification.claim === "prediction");

  if (predictions.length > 0) {
    sections.push({
      kind: "keyValue",
      title: "Predicted properties",
      rows: predictions.map((result) => row(result, formatScalar(result), displayLabel(result)))
    });
  }
  if (descriptors.length > 0) {
    sections.push({
      kind: "keyValue",
      title: "Descriptors",
      rows: descriptors.map((result) => row(result, formatScalar(result), displayLabel(result)))
    });
  }

  // --- declined -------------------------------------------------------------------------------
  if (declined.length > 0) {
    sections.push({
      kind: "table",
      title: "Not computed",
      columns: ["Property", "Status", "Reason"],
      rows: declined.map((result) => [
        displayLabel(result),
        result.status,
        result.applicability.reasons[0] ?? result.warnings[0]?.message ?? "no reason recorded"
      ])
    });
  }

  // --- warnings -------------------------------------------------------------------------------
  // Run-level warnings always; result-level warnings only from results that succeeded. A declined
  // result's warning *is* its reason, and "Not computed" above already carries it — repeating it here
  // would make the report look twice as alarming as the run actually was.
  const notices = [...run.warnings, ...ok.flatMap((result) => result.warnings)];
  if (notices.length > 0) {
    sections.push({
      kind: "table",
      title: "Notices",
      columns: ["Severity", "Code", "Message"],
      rows: notices.map((warning) => [warning.severity, warning.code, warning.message])
    });
  }

  // --- provenance -----------------------------------------------------------------------------
  const contracts = new Map<string, AnalysisResult>();
  for (const result of run.results) if (!contracts.has(result.methodId)) contracts.set(result.methodId, result);
  sections.push({
    kind: "table",
    title: "Provenance",
    columns: ["Property", "Method", "Version", "Interpretation"],
    rows: [...contracts.values()].map((result) => [
      displayLabel(result),
      result.methodId,
      result.methodVersion,
      result.interpretationId
    ])
  });

  const citations = new Map<string, string>();
  for (const result of run.results) {
    for (const citation of result.citations) {
      const parts = [citation.authors, citation.title, citation.year ? String(citation.year) : undefined]
        .filter(Boolean)
        .join(". ");
      citations.set(citation.id, parts);
    }
  }
  if (citations.size > 0) {
    sections.push({
      kind: "table",
      title: "References",
      columns: ["Key", "Citation"],
      rows: [...citations.entries()].sort(([a], [b]) => a.localeCompare(b))
    });
  }

  const engineSummary = run.engines
    .map((engine) => `${engine.name} ${engine.version}${engine.artifactHashes.length > 0 ? ` (${engine.artifactHashes.join(", ")})` : ""}`)
    .join("; ");

  return {
    title: options.title ?? "Molecular properties",
    interpretations: run.interpretations.map((interpretation) => ({
      id: interpretation.id,
      label: interpretation.label,
      active: interpretation.id === active,
      changesIdentity: interpretationChangesIdentity(interpretation),
      ledger: ledgerLines(interpretation)
    })),
    sections,
    engineSummary,
    fingerprint: run.fingerprint
  };
}

// --- renderers -----------------------------------------------------------------------------------

function padColumns(columns: string[], rows: string[][]): number[] {
  return columns.map((column, index) =>
    Math.max(column.length, ...rows.map((cells) => (cells[index] ?? "").length))
  );
}

/** Plain text, for the clipboard. Fixed-width columns so a pasted table stays readable in a notebook. */
export function renderReportText(report: AnalysisReport): string {
  const lines: string[] = [report.title, "=".repeat(report.title.length), ""];

  const activeInterpretation = report.interpretations.find((entry) => entry.active);
  if (activeInterpretation) {
    lines.push(`Computed on: ${activeInterpretation.label}`);
    for (const step of activeInterpretation.ledger) lines.push(`  ${step}`);
    const others = report.interpretations.filter((entry) => !entry.active);
    if (others.length > 0) {
      lines.push(`Also available: ${others.map((entry) => entry.label).join("; ")}`);
    }
    lines.push("");
  }

  for (const section of report.sections) {
    lines.push(section.title, "-".repeat(section.title.length));
    if (section.kind === "text") {
      lines.push(section.body);
    } else if (section.kind === "keyValue") {
      const width = Math.max(0, ...section.rows.map((entry) => entry.label.length));
      for (const entry of section.rows) {
        lines.push(`${entry.label.padEnd(width)}  ${entry.value}${entry.note ? `   [${entry.note}]` : ""}`);
      }
    } else {
      const widths = padColumns(section.columns, section.rows);
      lines.push(section.columns.map((column, index) => column.padEnd(widths[index]!)).join("  "));
      for (const cells of section.rows) {
        lines.push(cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  "));
      }
    }
    lines.push("");
  }

  lines.push(`Engine: ${report.engineSummary || "unrecorded"}`);
  lines.push(`Run fingerprint: ${report.fingerprint}`);
  return lines.join("\n");
}

/** Markdown, for export into a lab notebook or an issue. */
export function renderReportMarkdown(report: AnalysisReport): string {
  const escape = (cell: string): string => cell.replace(/\|/g, "\\|");
  const lines: string[] = [`# ${report.title}`, ""];

  const activeInterpretation = report.interpretations.find((entry) => entry.active);
  if (activeInterpretation) {
    lines.push(`**Computed on:** ${activeInterpretation.label}`, "");
    for (const step of activeInterpretation.ledger) lines.push(`- ${step}`);
    const others = report.interpretations.filter((entry) => !entry.active);
    if (others.length > 0) {
      lines.push("", `_Also available: ${others.map((entry) => entry.label).join("; ")}_`);
    }
    lines.push("");
  }

  for (const section of report.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.kind === "text") {
      lines.push(section.body, "");
    } else if (section.kind === "keyValue") {
      lines.push("| Property | Value |", "| --- | --- |");
      for (const entry of section.rows) {
        const value = entry.note ? `${entry.value} _(${entry.note})_` : entry.value;
        lines.push(`| ${escape(entry.label)} | ${escape(value)} |`);
      }
      lines.push("");
    } else {
      lines.push(`| ${section.columns.map(escape).join(" | ")} |`);
      lines.push(`| ${section.columns.map(() => "---").join(" | ")} |`);
      for (const cells of section.rows) lines.push(`| ${cells.map(escape).join(" | ")} |`);
      lines.push("");
    }
  }

  lines.push(`_Engine: ${report.engineSummary || "unrecorded"}_`);
  lines.push("", `_Run fingerprint: \`${report.fingerprint}\`_`);
  return lines.join("\n");
}
