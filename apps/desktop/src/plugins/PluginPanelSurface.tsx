import type { PluginManifest } from "@chemdraft/plugin-api";

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
  if (!openPanel && !diagnosticsOpen) {
    return null;
  }

  return (
    <div className="plugin-surface" data-testid="plugin-surface">
      {openPanel ? (
        <OpenPanelView
          panel={openPanel}
          stale={props.stale ?? false}
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
  onClose,
  onRunAgain
}: {
  panel: OpenPluginPanel;
  stale: boolean;
  onClose: () => void;
  onRunAgain: (commandId: string) => void;
}) {
  const runCommandId = panel.commandId;
  return (
    <section
      className={["plugin-panel", stale ? "is-stale" : ""].filter(Boolean).join(" ")}
      data-testid="plugin-panel"
      data-panel-id={panel.panelId}
      data-stale={stale ? "true" : undefined}
    >
      <header className="plugin-panel-header">
        <h3 className="plugin-panel-title">{panel.report.title || panel.title}</h3>
        <div className="plugin-panel-actions">
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
