import { useEffect, useState } from "react";
import { startPaletteWindowDrag } from "../window-manager";
import {
  ANALYSIS_WINDOW_OWNER_ID,
  hideCurrentPanelWindow,
  listenForAnalysisWindowSnapshots,
  listenForPluginPanelReports,
  listenForPluginPanelStaleness,
  notifyPluginPanelClosed,
  parsePluginPanelWindowId,
  requestAnalysisWindowAction,
  requestPluginPanelRerun,
  requestPluginPanelReport,
  type AnalysisWindowSnapshotPayload,
  type PluginPanelReportPayload
} from "./panelBridge";
import { PluginReportRenderer } from "./PluginReportRenderer";
import { PluginDiagnosticsPanel } from "./PluginDiagnosticsPanel";
import { PatchReviewList } from "./PatchReviewTray";
import { MolecularInspectorPane } from "../analysis/MolecularInspectorPane";

/**
 * Floating native analysis window. It renders either a plugin's declarative report or one of the
 * host-owned Analyze surfaces. Content arrives over the request/replay event bridge and the window
 * holds no plugin code or document authority.
 *
 * Plugin report bodies use the SAME renderer as the web fallback ({@link PluginReportRenderer}), so
 * every section kind — including `linkedFigure` — renders identically and cannot be dropped by a
 * window-private switch.
 * "Run again" is relayed to the main window (the plugin runtime lives there), staleness (D-09) is
 * pushed FROM the main window (only it can compare against the live document), and dismissing the
 * window is a real panel close (ADR-0012): the plugin gets its cancellation signal.
 */
export function PluginPanelWindow({ panelId }: { panelId: string }) {
  // The Rust window route still calls this query field `panelId`, but the value is the reversible
  // composite window id produced by panelBridge. Decode it before filtering any messages.
  const identity = parsePluginPanelWindowId(panelId);
  const [payload, setPayload] = useState<PluginPanelReportPayload | undefined>();
  const [analysisPayload, setAnalysisPayload] = useState<AnalysisWindowSnapshotPayload | undefined>();
  const [staleness, setStaleness] = useState<{ revision: number; stale: boolean } | undefined>();

  useEffect(() => {
    document.documentElement.classList.add("palette-window-html");
    document.body.classList.add("palette-window-body");
    return () => {
      document.documentElement.classList.remove("palette-window-html");
      document.body.classList.remove("palette-window-body");
    };
  }, []);

  useEffect(() => {
    if (!identity) {
      return;
    }
    const unlistenReports = listenForPluginPanelReports((next) => {
      if (next.pluginId !== identity.pluginId || next.panelId !== identity.panelId) {
        return;
      }
      setPayload((current) => (current && current.revision >= next.revision ? current : next));
    });
    const unlistenAnalysis = listenForAnalysisWindowSnapshots((next) => {
      if (next.pluginId !== identity.pluginId || next.panelId !== identity.panelId) {
        return;
      }
      setAnalysisPayload((current) => (current && current.revision >= next.revision ? current : next));
    });
    const unlistenStaleness = listenForPluginPanelStaleness((next) => {
      if (next.pluginId !== identity.pluginId || next.panelId !== identity.panelId) {
        return;
      }
      // Keyed to the report revision it was computed for, so a late push can never mark a newer report.
      setStaleness((current) =>
        current && current.revision > next.revision ? current : { revision: next.revision, stale: next.stale }
      );
    });
    // Request only after both listeners exist: the response replays the report and its staleness
    // verdict, so neither can be lost while a newly created webview is still mounting.
    void requestPluginPanelReport(identity).catch(() => undefined);

    return () => {
      unlistenReports();
      unlistenAnalysis();
      unlistenStaleness();
    };
  }, [identity?.panelId, identity?.pluginId]);

  const isCoreAnalysisWindow = identity?.pluginId === ANALYSIS_WINDOW_OWNER_ID;
  const stale = payload !== undefined && staleness?.revision === payload.revision && staleness.stale;
  const title = isCoreAnalysisWindow
    ? analysisWindowTitle(analysisPayload)
    : payload?.report.title ?? "Plugin panel";

  const closeWindow = (): void => {
    if (identity) {
      if (isCoreAnalysisWindow) {
        void requestAnalysisWindowAction({ kind: "close", windowId: identity.panelId }).catch(() => undefined);
      } else {
        // A plugin report window close is a real ADR-0012 close: the plugin cancels in-flight work.
        void notifyPluginPanelClosed(identity).catch(() => undefined);
      }
    }
    void hideCurrentPanelWindow().catch(() => undefined);
  };

  return (
    <aside
      className="plugin-panel-shell"
      aria-label={title}
      data-panel-id={identity?.panelId}
      data-plugin-id={identity?.pluginId}
    >
      <div
        className="palette-title"
        data-palette-title-drag-surface="true"
        onPointerDown={(event) => {
          if (event.button === 0 && !(event.target as HTMLElement).closest("button")) {
            void startPaletteWindowDrag().catch(() => undefined);
          }
        }}
      >
        <span className="palette-title-label">{title}</span>
        {!isCoreAnalysisWindow && payload?.commandId ? (
          <button
            type="button"
            className="plugin-panel-run-again"
            onClick={() => identity && void requestPluginPanelRerun(identity).catch(() => undefined)}
          >
            Run again
          </button>
        ) : null}
        <button
          type="button"
          className="palette-close-button"
          aria-label="Close panel"
          onClick={closeWindow}
        >
          ×
        </button>
      </div>
      <div className="plugin-panel-content">
        {isCoreAnalysisWindow ? (
          analysisPayload ? (
            <AnalysisWindowContent payload={analysisPayload} />
          ) : (
            <p className="plugin-panel-waiting">Waiting for analysis content…</p>
          )
        ) : payload ? (
          <>
            {stale ? (
              <div className="plugin-panel-stale" role="status" data-testid="plugin-panel-stale">
                This result may be out of date — the structure changed since it was computed. Run again to
                refresh.
              </div>
            ) : null}
            <PluginReportRenderer report={payload.report} />
          </>
        ) : (
          <p className="plugin-panel-waiting">Waiting for plugin content…</p>
        )}
      </div>
    </aside>
  );
}

function analysisWindowTitle(payload: AnalysisWindowSnapshotPayload | undefined): string {
  if (!payload) return "Analysis";
  switch (payload.content.kind) {
    case "molecularInspector":
      return "Molecular Inspector";
    case "pluginDiagnostics":
      return "Bundled Plugins";
    case "patchReview":
      return "Plugin Proposals";
    case "report":
      return payload.content.report.title || "Analysis";
  }
}

function AnalysisWindowContent({ payload }: { payload: AnalysisWindowSnapshotPayload }) {
  const { content } = payload;
  switch (content.kind) {
    case "molecularInspector":
      return (
        <MolecularInspectorPane
          report={content.report}
          busy={content.busy}
          stale={content.stale}
          onCopy={(text) => {
            void requestAnalysisWindowAction({ kind: "copyMolecularInspector", text }).catch(() => undefined);
          }}
          onChangeInterpretation={(interpretationId) => {
            void requestAnalysisWindowAction({
              kind: "changeMolecularInterpretation",
              ...(interpretationId ? { interpretationId } : {})
            }).catch(() => undefined);
          }}
        />
      );
    case "report":
      return <PluginReportRenderer report={content.report} />;
    case "pluginDiagnostics":
      return <PluginDiagnosticsPanel plugins={content.plugins} diagnostics={content.diagnostics} />;
    case "patchReview":
      return (
        <PatchReviewList
          proposals={content.proposals}
          onAccept={(proposalId) => {
            void requestAnalysisWindowAction({ kind: "acceptPluginProposal", proposalId }).catch(() => undefined);
          }}
          onReject={(proposalId) => {
            void requestAnalysisWindowAction({ kind: "rejectPluginProposal", proposalId }).catch(() => undefined);
          }}
        />
      );
  }
}
