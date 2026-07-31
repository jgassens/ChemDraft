/**
 * The Molecular Inspector: one window for every analysis of the selected structure.
 *
 * Categories on the left, the selected analysis on the right, and everything in the viewport
 * copyable — as text or as Markdown, narrowed to whatever is selected.
 *
 * Two things are load-bearing rather than decorative:
 *
 * - **The viewport renders the same `AnalysisReport` the clipboard gets.** `reportForSelection`
 *   narrows a report to a category and returns a report, so the panel, the text export, and the
 *   Markdown export all consume one value. What you copied cannot disagree with what you saw.
 * - **The window is free of the drawing viewport.** It is positioned in viewport units and dragged by
 *   its title bar, so it can sit anywhere on screen regardless of where the canvas is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

export interface MolecularInspectorProps {
  report: AnalysisReport;
  /** True while a newer run for this selection is in flight. */
  busy?: boolean;
  /** Recompute against another interpretation. `undefined` means "as drawn". */
  onChangeInterpretation(interpretationId: string | undefined): void;
  onCopy(text: string): void;
  onClose(): void;
  /** Starting position, in px from the top-left of the window. Defaults to a sensible inset. */
  initialPosition?: { x: number; y: number };
}

/** Keeps the title bar clear of the app menu bar, which draws above this window. */
const MIN_TOP = 40;

interface DragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

export function MolecularInspector({
  report,
  busy,
  onChangeInterpretation,
  onCopy,
  onClose,
  initialPosition
}: MolecularInspectorProps) {
  const model = useMemo(() => buildInspectorModel(report), [report]);
  const [selection, setSelection] = useState<InspectorSelection>({});
  const [copied, setCopied] = useState<"text" | "markdown" | undefined>();
  const [position, setPosition] = useState(initialPosition ?? { x: 120, y: 90 });
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // A recomputation can remove the category being read. Keep the selection when it survives; reset
  // only when it genuinely no longer exists, so an edit does not silently yank the reader to the top.
  useEffect(() => {
    setSelection((current) => reconcileSelection(model, current));
  }, [model]);

  const active = model.interpretations.find((entry) => entry.active);
  const alternatives = model.interpretations.filter((entry) => !entry.active);
  const visible = useMemo(() => reportForSelection(report, selection), [report, selection]);
  const panelReport = useMemo(() => toPanelReport(visible), [visible]);

  const copy = (kind: "text" | "markdown"): void => {
    onCopy(kind === "text" ? renderSelectionText(report, selection) : renderSelectionMarkdown(report, selection));
    setCopied(kind);
  };

  // Reset the "Copied" affordance whenever the thing that would be copied changes, so the label never
  // claims a stale success for a different selection.
  useEffect(() => {
    setCopied(undefined);
  }, [selection, report]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Ignore drags that start on a control in the title bar — the close button is in there.
    if ((event.target as HTMLElement).closest("button, select, input")) return;
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // Clamped so the title bar can never be dragged out of reach — a window you cannot grab again is a
    // window you have lost. The lower bound is the menu-bar height rather than 0: at y=0 the title bar
    // slides *under* the app menu bar, which looks like the window vanished and leaves nothing to drag.
    const maxX = Math.max(0, window.innerWidth - 120);
    const maxY = Math.max(MIN_TOP, window.innerHeight - 40);
    setPosition({
      x: Math.min(Math.max(0, event.clientX - drag.offsetX), maxX),
      y: Math.min(Math.max(MIN_TOP, event.clientY - drag.offsetY), maxY)
    });
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const selectedLabel = selection.categoryId ?? "All analyses";

  return (
    <div
      ref={frameRef}
      className="molecular-inspector"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      role="dialog"
      aria-label="Molecular Inspector"
    >
      <header
        className="molecular-inspector-titlebar"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <h3>Molecular Inspector</h3>
        <div className="molecular-inspector-actions">
          <button type="button" onClick={() => copy("text")} title={`Copy ${selectedLabel} as text`}>
            {copied === "text" ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={() => copy("markdown")} title={`Copy ${selectedLabel} as Markdown`}>
            {copied === "markdown" ? "Copied" : "Copy as Markdown"}
          </button>
          <button type="button" aria-label="Close Molecular Inspector" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      {active ? (
        <div className="molecular-inspector-interpretation">
          <span>
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
                {model.interpretations.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

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
          <PluginReportRenderer report={panelReport} />
        </section>
      </div>

      <footer className="molecular-inspector-footer">
        <span>{model.engineSummary}</span>
      </footer>
    </div>
  );
}
