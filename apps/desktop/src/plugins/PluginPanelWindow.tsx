import { useEffect, useState } from "react";
import { startPaletteWindowDrag } from "../window-manager";
import {
  hideCurrentPanelWindow,
  listenForPluginPanelReports,
  listenForPluginPanelStaleness,
  notifyPluginPanelClosed,
  parsePluginPanelWindowId,
  requestPluginPanelRerun,
  requestPluginPanelReport,
  type PluginPanelReportPayload
} from "./panelBridge";
import { PluginReportRenderer } from "./PluginReportRenderer";

/**
 * Floating utility window that renders a plugin's declarative report. Content arrives over
 * the event bridge (a request on mount, plus broadcasts from the main window); the window
 * holds no plugin code.
 *
 * The report body is the SAME renderer the in-app surface uses ({@link PluginReportRenderer},
 * ADR-0030), so every section kind — including the interactive `linkedFigure` — renders identically
 * in both places, and a future section kind can never be silently dropped by a private switch.
 * "Run again" is relayed to the main window (the plugin runtime lives there), staleness (D-09) is
 * pushed FROM the main window (only it can compare against the live document), and dismissing the
 * window is a real panel close (ADR-0012): the plugin gets its cancellation signal.
 */
export function PluginPanelWindow({ panelId }: { panelId: string }) {
  // The Rust window route still calls this query field `panelId`, but the value is the reversible
  // composite window id produced by panelBridge. Decode it before filtering any messages.
  const identity = parsePluginPanelWindowId(panelId);
  const [payload, setPayload] = useState<PluginPanelReportPayload | undefined>();
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
      unlistenStaleness();
    };
  }, [identity?.panelId, identity?.pluginId]);

  const stale = payload !== undefined && staleness?.revision === payload.revision && staleness.stale;

  return (
    <aside
      className="plugin-panel-shell"
      aria-label={payload?.report.title ?? "Plugin panel"}
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
        <span className="palette-title-label">{payload?.report.title ?? "Plugin panel"}</span>
        {payload?.commandId ? (
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
          onClick={() => {
            // Notify first (a real ADR-0012 close — the plugin cancels in-flight work), then hide.
            if (identity) {
              void notifyPluginPanelClosed(identity).catch(() => undefined);
            }
            void hideCurrentPanelWindow().catch(() => undefined);
          }}
        >
          ×
        </button>
      </div>
      <div className="plugin-panel-content">
        {payload ? (
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
