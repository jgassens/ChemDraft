import { useEffect, useState } from "react";
import { startPaletteWindowDrag } from "../window-manager";
import {
  hideCurrentPanelWindow,
  listenForPluginPanelReports,
  listenForPluginPanelStaleness,
  notifyPluginPanelClosed,
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
    let unlistenReports: (() => void) | undefined;
    let unlistenStaleness: (() => void) | undefined;
    void listenForPluginPanelReports((next) => {
      if (next.panelId !== panelId) {
        return;
      }
      setPayload((current) => (current && current.revision >= next.revision ? current : next));
    })
      .then((cleanup) => {
        unlistenReports = cleanup;
        void requestPluginPanelReport(panelId).catch(() => undefined);
      })
      .catch(() => undefined);
    void listenForPluginPanelStaleness((next) => {
      if (next.panelId !== panelId) {
        return;
      }
      // Keyed to the report revision it was computed for, so a late push can never mark a newer report.
      setStaleness((current) =>
        current && current.revision > next.revision ? current : { revision: next.revision, stale: next.stale }
      );
    })
      .then((cleanup) => {
        unlistenStaleness = cleanup;
      })
      .catch(() => undefined);

    return () => {
      unlistenReports?.();
      unlistenStaleness?.();
    };
  }, [panelId]);

  const stale = payload !== undefined && staleness?.revision === payload.revision && staleness.stale;

  return (
    <aside className="plugin-panel-shell" aria-label={payload?.report.title ?? "Plugin panel"} data-panel-id={panelId}>
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
            onClick={() => void requestPluginPanelRerun(panelId).catch(() => undefined)}
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
            void notifyPluginPanelClosed(panelId).catch(() => undefined);
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
