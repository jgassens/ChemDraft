/**
 * The Molecular Inspector's contents: categories on the left, the selected analysis on the right,
 * everything in the viewport copyable.
 *
 * A toolset widget rather than a window of its own. That is what makes it a real OS window on the
 * desktop — palettes open through `openToolsetWindow`, so this gets the same native frame, the same
 * drag-anywhere behaviour, and the same saved position as the Main and Art toolbars, with no bespoke
 * drag handling here. In the browser the same widget renders as a floating web palette.
 *
 * The load-bearing decision: **narrowing returns a report, not a rendering.** `reportForSelection`
 * filters an `AnalysisReport` to one category and hands back an `AnalysisReport`, so the viewport, the
 * text export, and the Markdown export all consume one value. What was copied cannot disagree with
 * what was on screen, and the engine line and fingerprint ride along on every fragment — a pasted
 * number that cannot be traced is not evidence.
 */
import { useEffect, useMemo, useState } from "react";

import {
  buildInspectorModel,
  reconcileSelection,
  renderSelectionMarkdown,
  renderSelectionText,
  reportForSelection,
  type AnalysisReport,
  type InspectorSelection
} from "@chemdraft/analysis-core";

import { PluginReportRenderer } from "../plugins/PluginReportRenderer";
import { toPanelReport } from "./analysisPanelReport";
import { IsotopeSpectrum } from "./IsotopeSpectrum";

export interface MolecularInspectorPaneProps {
  /** Absent until an analysis has run — the palette can be open before anything is selected. */
  report?: AnalysisReport;
  busy?: boolean;
  /**
   * The report no longer describes what is selected.
   *
   * Nothing invalidated this report: it was set at run completion and never cleared on a document
   * edit, a selection change, an undo, or a new document, and `cancel("selection")` was never called.
   * So a user could read a confident, fully provenanced page of numbers for a structure they had
   * since changed or deselected, with only the identity rows to notice. Badged rather than cleared —
   * the analysis was asked for, and throwing it away on a stray click would be its own annoyance.
   */
  stale?: boolean;
  onChangeInterpretation?(interpretationId: string | undefined): void;
  onCopy?(text: string): void;
}

export function MolecularInspectorPane({
  report,
  busy,
  stale,
  onChangeInterpretation,
  onCopy
}: MolecularInspectorPaneProps) {
  const [selection, setSelection] = useState<InspectorSelection>({});
  const [copied, setCopied] = useState<"text" | "markdown" | undefined>();

  const model = useMemo(() => (report ? buildInspectorModel(report) : undefined), [report]);

  // A recomputation can remove the category being read. Keep the selection when it survives and reset
  // only when it genuinely does not, so an edit does not silently yank the reader back to the top.
  useEffect(() => {
    if (!model) return;
    setSelection((current) => reconcileSelection(model, current));
  }, [model]);

  // Never let "Copied" claim a stale success for a different selection or a newer run.
  useEffect(() => {
    setCopied(undefined);
  }, [selection, report]);

  const visible = useMemo(
    () => (report ? reportForSelection(report, selection) : undefined),
    [report, selection]
  );

  /**
   * Sections in document order, with spectra drawn here and everything else handed to the shared
   * renderer in contiguous runs.
   *
   * Splitting into runs rather than hoisting the plots keeps the report's own order intact — under
   * "All analyses" the isotope envelope belongs where the report put it, not floated to the top.
   */
  const body = useMemo(() => {
    if (!visible) return null;
    const nodes: React.ReactNode[] = [];
    let run: typeof visible.sections = [];
    const flushRun = (key: string) => {
      if (run.length === 0) return;
      nodes.push(<PluginReportRenderer key={key} report={toPanelReport({ ...visible, sections: run })} />);
      run = [];
    };
    for (const [index, section] of visible.sections.entries()) {
      if (section.kind === "spectrum") {
        flushRun(`run-${index}`);
        nodes.push(
          <section key={`spectrum-${index}`} className="molecular-inspector-spectrum-section">
            <h4>{section.title}</h4>
            <IsotopeSpectrum section={section} />
          </section>
        );
      } else {
        run.push(section);
      }
    }
    flushRun("run-tail");
    return nodes;
  }, [visible]);

  if (!report || !model) {
    return (
      <div className="molecular-inspector-pane molecular-inspector-empty">
        <p>Select a structure to see its analyses here.</p>
      </div>
    );
  }

  const active = model.interpretations.find((entry) => entry.active);
  const alternatives = model.interpretations.filter((entry) => !entry.active);
  const selectedLabel = selection.categoryId ?? "All analyses";

  const copy = (kind: "text" | "markdown"): void => {
    // "Copied" only when something was asked to copy it. `setCopied` used to fire unconditionally, so
    // wherever `onCopy` was absent — the detached palette, which is the shipping desktop path — the
    // button announced success onto an empty clipboard. A label that lies about the clipboard is
    // worse than a button that does nothing, because the user walks away and pastes something else.
    if (!onCopy) return;
    onCopy(kind === "text" ? renderSelectionText(report, selection) : renderSelectionMarkdown(report, selection));
    setCopied(kind);
  };

  return (
    <div className="molecular-inspector-pane">
      <div className="molecular-inspector-toolbar">
        {active ? (
          <span className="molecular-inspector-interpretation">
            Computed on: <strong>{active.label}</strong>
            {active.changesIdentity ? <span className="analysis-panel-identity-flag"> — identity changed</span> : null}
          </span>
        ) : null}
        {active && alternatives.length > 0 ? (
          <label className="analysis-panel-change">
            <span>change</span>
            <select
              value={active.id}
              disabled={busy}
              onChange={(event) =>
                onChangeInterpretation?.(event.target.value === "source" ? undefined : event.target.value)
              }
            >
              {model.interpretations.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="molecular-inspector-spacer" />
        <button type="button" onClick={() => copy("text")} title={`Copy ${selectedLabel} as text`}>
          {copied === "text" ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={() => copy("markdown")} title={`Copy ${selectedLabel} as Markdown`}>
          {copied === "markdown" ? "Copied" : "Copy as Markdown"}
        </button>
      </div>

      <div className="molecular-inspector-body">
        <nav className="molecular-inspector-categories" aria-label="Analyses">
          <button
            type="button"
            className={selection.categoryId === undefined ? "is-selected" : undefined}
            aria-current={selection.categoryId === undefined}
            onClick={() => setSelection({})}
          >
            <span className="molecular-inspector-category-label">All analyses</span>
            <span className="molecular-inspector-category-count">{model.categories.length}</span>
          </button>
          {model.categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={selection.categoryId === category.id ? "is-selected" : undefined}
              aria-current={selection.categoryId === category.id}
              onClick={() => setSelection({ categoryId: category.id })}
            >
              <span className="molecular-inspector-category-label">{category.label}</span>
              <span className="molecular-inspector-category-count">{category.entryCount}</span>
              {category.detail ? (
                <span className="molecular-inspector-category-detail">{category.detail}</span>
              ) : null}
              {category.note ? <span className="molecular-inspector-category-note">{category.note}</span> : null}
            </button>
          ))}
        </nav>

        <section className="molecular-inspector-viewport" aria-label={selectedLabel}>
          {busy ? <p className="analysis-panel-busy">Recomputing…</p> : null}
          {!busy && stale ? (
            <p className="analysis-panel-stale">
              These numbers describe a structure that is no longer selected. Run Analyze again for the
              current selection.
            </p>
          ) : null}
          {body}
        </section>
      </div>

      <footer className="molecular-inspector-footer">
        <span>{model.engineSummary}</span>
      </footer>
    </div>
  );
}
