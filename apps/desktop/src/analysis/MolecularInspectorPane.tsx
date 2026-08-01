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

export interface MolecularInspectorPaneProps {
  /** Absent until an analysis has run — the palette can be open before anything is selected. */
  report?: AnalysisReport;
  busy?: boolean;
  onChangeInterpretation?(interpretationId: string | undefined): void;
  onCopy?(text: string): void;
}

export function MolecularInspectorPane({
  report,
  busy,
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
  const panelReport = useMemo(() => (visible ? toPanelReport(visible) : undefined), [visible]);

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
    onCopy?.(
      kind === "text" ? renderSelectionText(report, selection) : renderSelectionMarkdown(report, selection)
    );
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
          {panelReport ? <PluginReportRenderer report={panelReport} /> : null}
        </section>
      </div>

      <footer className="molecular-inspector-footer">
        <span>{model.engineSummary}</span>
      </footer>
    </div>
  );
}
