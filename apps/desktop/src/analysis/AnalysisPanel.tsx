/**
 * The Analyze surface (PLANS.md §9 Release 1, §1).
 *
 * Core-owned chrome around the shared `PluginReportRenderer`. Two things here are load-bearing rather
 * than decorative:
 *
 * - **The disclosure line.** §1 requires the active interpretation to be inspectable and overridable
 *   *per analysis*: "largest organic fragment · counterion removed — change". The line below is that
 *   requirement, and the select next to it is the "— change".
 * - **Copy.** §9 asks for a "copyable/exportable provenance report". The text and Markdown renderings
 *   come from `analysis-core`, so what lands on the clipboard is the same artifact the tests pin.
 */
import { useMemo, useState } from "react";

import {
  renderReportMarkdown,
  renderReportText,
  type AnalysisReport
} from "@chemdraft/analysis-core";

import { PluginReportRenderer } from "../plugins/PluginReportRenderer";
import { toPanelReport } from "./analysisPanelReport";

export interface AnalysisPanelProps {
  report: AnalysisReport;
  /** True while a newer run for this selection is in flight. */
  busy?: boolean;
  /** Recompute against another interpretation. `undefined` means "as drawn". */
  onChangeInterpretation(interpretationId: string | undefined): void;
  onCopy(text: string): void;
  onClose(): void;
}

export function AnalysisPanel({ report, busy, onChangeInterpretation, onCopy, onClose }: AnalysisPanelProps) {
  const [copied, setCopied] = useState<"text" | "markdown" | undefined>();
  const panelReport = useMemo(() => toPanelReport(report), [report]);
  const active = report.interpretations.find((entry) => entry.active);
  const alternatives = report.interpretations.filter((entry) => !entry.active);

  const copy = (kind: "text" | "markdown"): void => {
    onCopy(kind === "text" ? renderReportText(report) : renderReportMarkdown(report));
    setCopied(kind);
  };

  return (
    <aside className="analysis-panel" aria-label="Molecular properties">
      <header className="analysis-panel-header">
        <h3>{report.title}</h3>
        <div className="analysis-panel-actions">
          <button type="button" onClick={() => copy("text")}>
            {copied === "text" ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={() => copy("markdown")}>
            {copied === "markdown" ? "Copied" : "Copy as Markdown"}
          </button>
          <button type="button" aria-label="Close molecular properties" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      {active ? (
        <div className="analysis-panel-interpretation">
          <span className="analysis-panel-interpretation-label">
            Computed on: <strong>{active.label}</strong>
            {active.changesIdentity ? <span className="analysis-panel-identity-flag"> — identity changed</span> : null}
          </span>
          {alternatives.length > 0 ? (
            <label className="analysis-panel-change">
              <span>change</span>
              <select
                value={active.id}
                disabled={busy}
                onChange={(event) =>
                  onChangeInterpretation(event.target.value === "source" ? undefined : event.target.value)
                }
              >
                {report.interpretations.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {active.ledger.length > 0 ? (
            <ul className="analysis-panel-ledger">
              {active.ledger.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {busy ? <p className="analysis-panel-busy">Recomputing…</p> : null}

      <PluginReportRenderer report={panelReport} />

      <footer className="analysis-panel-footer">
        <span>{report.engineSummary}</span>
      </footer>
    </aside>
  );
}
