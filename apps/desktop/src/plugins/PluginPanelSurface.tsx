import type { PluginManifest } from "@chemdraft/plugin-api";
import { useRef, useState } from "react";

import { PluginDiagnosticsPanel } from "./PluginDiagnosticsPanel";
import { PluginReportRenderer } from "./PluginReportRenderer";
import type { OpenPluginPanel, PluginDiagnostic } from "./types";

export interface PluginPanelSurfaceProps {
  openPanel: OpenPluginPanel | undefined;
  diagnosticsOpen: boolean;
  plugins: readonly PluginManifest[];
  diagnostics: readonly PluginDiagnostic[];
  /** True when the open panel's report.source no longer matches the live document (D-09). */
  stale?: boolean;
  onClose: () => void;
  onCloseDiagnostics: () => void;
  onRunAgain: (commandId: string) => void;
}

/**
 * Desktop chrome around contributed panels: title, close, and a "Run again" action (the panel
 * contribution's command) around a plugin's declarative report, plus the toggleable bundled-plugin
 * diagnostics view. Renders nothing when neither a panel nor diagnostics is open, so it stays inert
 * until the plugin runtime is actually used.
 */
export function PluginPanelSurface(props: PluginPanelSurfaceProps) {
  const { openPanel, diagnosticsOpen } = props;
  const [expanded, setExpanded] = useState(false);
  if (!openPanel && !diagnosticsOpen) {
    return null;
  }

  // Only interactive figures benefit from the large view; a text/table report stays compact.
  const canExpand = openPanel?.report.sections.some((section) => section.kind === "linkedFigure") ?? false;
  const className = ["plugin-surface", expanded && canExpand ? "plugin-surface--expanded" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} data-testid="plugin-surface">
      {openPanel ? (
        <OpenPanelView
          panel={openPanel}
          stale={props.stale ?? false}
          canExpand={canExpand}
          expanded={expanded}
          onToggleExpand={() => setExpanded((value) => !value)}
          onClose={props.onClose}
          onRunAgain={props.onRunAgain}
        />
      ) : null}
      {diagnosticsOpen ? (
        <section className="plugin-diagnostics-surface" data-testid="plugin-diagnostics-surface">
          <button
            type="button"
            className="plugin-panel-close"
            aria-label="Close bundled plugins"
            onClick={props.onCloseDiagnostics}
          >
            Close
          </button>
          <PluginDiagnosticsPanel plugins={props.plugins} diagnostics={props.diagnostics} />
        </section>
      ) : null}
    </div>
  );
}

function OpenPanelView({
  panel,
  stale,
  canExpand,
  expanded,
  onToggleExpand,
  onClose,
  onRunAgain
}: {
  panel: OpenPluginPanel;
  stale: boolean;
  canExpand: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onRunAgain: (commandId: string) => void;
}) {
  const runCommandId = panel.commandId;
  const panelRef = useRef<HTMLElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // Drag the whole panel by its header. Window-level listeners (added on pointer-down, removed on
  // up) keep the drag alive even when the pointer leaves the header; a button press never starts a
  // drag. Clamped so the panel can't be dragged fully off-screen (skipped when there is no layout,
  // e.g. jsdom).
  const onHeaderPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    const rect = panelRef.current?.getBoundingClientRect();
    const base = rect ? { left: rect.left - offset.x, top: rect.top - offset.y, width: rect.width } : undefined;
    const onMove = (move: PointerEvent): void => {
      let x = start.ox + (move.clientX - start.x);
      let y = start.oy + (move.clientY - start.y);
      if (base && base.width > 0) {
        x = Math.min(Math.max(x, 80 - base.width - base.left), window.innerWidth - 80 - base.left);
        y = Math.min(Math.max(y, -base.top), window.innerHeight - 40 - base.top);
      }
      setOffset({ x, y });
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <section
      ref={panelRef}
      className={["plugin-panel", stale ? "is-stale" : ""].filter(Boolean).join(" ")}
      data-testid="plugin-panel"
      data-panel-id={panel.panelId}
      data-stale={stale ? "true" : undefined}
      style={offset.x !== 0 || offset.y !== 0 ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    >
      <header className="plugin-panel-header" onPointerDown={onHeaderPointerDown} title="Drag to move">
        <h3 className="plugin-panel-title">{panel.report.title || panel.title}</h3>
        <div className="plugin-panel-actions">
          {canExpand ? (
            <button
              type="button"
              className="plugin-panel-expand"
              aria-pressed={expanded}
              onClick={onToggleExpand}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
          {runCommandId ? (
            <button type="button" className="plugin-panel-run-again" onClick={() => onRunAgain(runCommandId)}>
              Run again
            </button>
          ) : null}
          <button type="button" className="plugin-panel-close" aria-label="Close panel" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      {stale ? (
        <div className="plugin-panel-stale" role="status" data-testid="plugin-panel-stale">
          This result may be out of date — the structure changed since it was computed. Run again to refresh.
        </div>
      ) : null}
      <PluginReportRenderer report={panel.report} />
    </section>
  );
}
