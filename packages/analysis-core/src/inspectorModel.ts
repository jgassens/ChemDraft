/**
 * The Molecular Inspector's content model: one analysis report, presented as a list of categories on
 * the left and whatever the reader picked on the right.
 *
 * Pure and UI-neutral, like the report it consumes — no DOM, no React, no desktop types. The window
 * that renders this is one consumer; the text and Markdown a chemist pastes into a notebook are
 * another, and they must agree. Deriving both from one selection is what keeps "what I can see" and
 * "what I just copied" the same thing.
 *
 * **Categories come from the report, not from a hardcoded list.** The report already groups results by
 * claim class (§2's display side), and a second grouping here would drift from it the first time a
 * method's classification changed. So a category *is* a section, and the tree is one level deep by
 * construction.
 */
import type { AnalysisReport, AnalysisReportSection } from "./report";
import { renderReportMarkdown, renderReportText } from "./report";

/** A leaf a reader can select: one row within a section, addressed by its label. */
export interface InspectorEntry {
  /** Stable within its category — the row's label, which is what the reader sees and searches. */
  id: string;
  label: string;
  /** Present for key/value rows; absent where a row is not a simple pair (a table row, prose). */
  value?: string;
}

export interface InspectorCategory {
  /** Stable id: the section's title with its hoisted note stripped, so it survives a note change. */
  id: string;
  /** What the left list shows — the section title WITHOUT the hoisted disclosure note. */
  label: string;
  /** The hoisted note, where the section had one. The left list shows it as a subtitle. */
  note?: string;
  /**
   * A trailing parenthetical the section title carried, e.g. "8 peaks, 99.9939% of the distribution".
   *
   * Peeled off the id deliberately. The isotope envelope names its peak count in its title, so leaving
   * it in would make the category id change every time the structure did — and a selection keyed on it
   * could never survive a recomputation. Kept and displayed, because the count is real information.
   */
  detail?: string;
  /** How many entries the category holds; shown as a count so an empty one is obviously empty. */
  entryCount: number;
  entries: InspectorEntry[];
}

export interface InspectorSelection {
  /** `undefined` selects the whole report — the default, and what "everything" means. */
  categoryId?: string;
}

export interface InspectorModel {
  title: string;
  categories: InspectorCategory[];
  /** Every interpretation the run used, so the window can offer §1's "— change" affordance. */
  interpretations: AnalysisReport["interpretations"];
  engineSummary: string;
  fingerprint: string;
}

/**
 * Split a section title into the stable name, its hoisted disclosure, and any trailing parenthetical.
 *
 * "Descriptors — convention-dependent — see Conventions" -> label "Descriptors", note the rest.
 * "Isotope envelope (8 peaks, 99.99% of the distribution)" -> label "Isotope envelope", detail the rest.
 *
 * Only the label is used as an id, so neither a changed disclosure nor a changed peak count renames a
 * category out from under a reader's selection.
 */
export function splitSectionTitle(title: string): { label: string; note?: string; detail?: string } {
  const separator = title.indexOf(" — ");
  const note = separator < 0 ? undefined : title.slice(separator + 3);
  let label = separator < 0 ? title : title.slice(0, separator);

  // Peel a trailing parenthetical ONLY when it contains a digit. That is what separates a computed
  // detail from a parenthetical that is part of the name: "Isotope envelope (20 peaks, 99.9% ...)" and
  // "Components (3)" are counts that change with the structure, while "Ions (m/z)" is the section's
  // actual name and losing it would leave a category called "Ions" with no unit.
  let detail: string | undefined;
  const parenthetical = /^(.*?)\s+\(([^()]*)\)$/.exec(label);
  if (parenthetical && /\d/.test(parenthetical[2]!)) {
    label = parenthetical[1]!;
    detail = parenthetical[2];
  }

  return { label, ...(note ? { note } : {}), ...(detail ? { detail } : {}) };
}

function entriesOf(section: AnalysisReportSection): InspectorEntry[] {
  switch (section.kind) {
    case "keyValue":
      return section.rows.map((row) => ({
        id: row.label,
        label: row.label,
        value: row.note ? `${row.value} · ${row.note}` : row.value
      }));
    case "table":
      // First column is the row's identity in every table the report builds (Property, Species, Mass,
      // Key). Joining the rest keeps the row readable in a one-line list without inventing columns.
      return section.rows.map((cells, index) => ({
        id: cells[0] ?? String(index),
        label: cells[0] ?? String(index),
        value: cells.slice(1).join(" · ") || undefined
      }));
    case "conventions":
      return section.groups.map((group) => ({
        id: group.appliesTo.join(", "),
        label: group.appliesTo.join(", "),
        value: group.conventions.join(" · ")
      }));
    case "text":
      return [{ id: section.title, label: section.title, value: section.body }];
  }
}

export function buildInspectorModel(report: AnalysisReport): InspectorModel {
  const categories = report.sections.map((section) => {
    const { label, note, detail } = splitSectionTitle(section.title);
    const entries = entriesOf(section);
    return {
      id: label,
      label,
      ...(note ? { note } : {}),
      ...(detail ? { detail } : {}),
      entryCount: entries.length,
      entries
    };
  });

  return {
    title: report.title,
    categories,
    interpretations: report.interpretations,
    engineSummary: report.engineSummary,
    fingerprint: report.fingerprint
  };
}

/** The sections a selection resolves to: one category, or the whole report. */
export function selectedSections(
  report: AnalysisReport,
  selection: InspectorSelection
): AnalysisReportSection[] {
  if (selection.categoryId === undefined) return report.sections;
  return report.sections.filter((section) => splitSectionTitle(section.title).label === selection.categoryId);
}

/**
 * A report narrowed to the current selection, still a real `AnalysisReport`.
 *
 * Narrowing rather than reformatting is the point: the viewport, the text rendering, and the Markdown
 * rendering all take an `AnalysisReport`, so a selected category exports through exactly the same code
 * as the whole report. There is no second formatter to keep in step, and no way for the copied text to
 * disagree with what is on screen.
 *
 * The engine line and fingerprint ride along on every export — a pasted fragment that does not say
 * which build produced it is not provenance.
 */
export function reportForSelection(report: AnalysisReport, selection: InspectorSelection): AnalysisReport {
  const sections = selectedSections(report, selection);
  if (selection.categoryId === undefined) return report;
  return {
    ...report,
    title: `${report.title} — ${selection.categoryId}`,
    sections
  };
}

export function renderSelectionText(report: AnalysisReport, selection: InspectorSelection): string {
  return renderReportText(reportForSelection(report, selection));
}

export function renderSelectionMarkdown(report: AnalysisReport, selection: InspectorSelection): string {
  return renderReportMarkdown(reportForSelection(report, selection));
}

/**
 * Keep a selection valid across a recomputation.
 *
 * A structure edit produces a new report whose categories may differ — a salt gains "Components", an
 * uncharged molecule loses "Not computed". Silently falling back to "everything" would yank the reader
 * out of the category they were reading, so the selection survives whenever its category still exists
 * and only resets when it genuinely does not.
 */
export function reconcileSelection(
  model: InspectorModel,
  selection: InspectorSelection
): InspectorSelection {
  if (selection.categoryId === undefined) return selection;
  return model.categories.some((category) => category.id === selection.categoryId)
    ? selection
    : {};
}
