import { useEffect, useState } from "react";
import type { PluginPanelSection } from "@chemdraft/plugin-api";
import { startPaletteWindowDrag } from "../window-manager";
import {
  hideCurrentPanelWindow,
  listenForPluginPanelReports,
  requestPluginPanelReport,
  type PluginPanelReportPayload
} from "./panelBridge";

/**
 * Floating utility window that renders a plugin's declarative report. Content arrives over
 * the event bridge (a request on mount, plus broadcasts from the main window); the panel
 * holds no plugin code. SVG sections render through an <img> data URI so embedded scripts
 * can never execute.
 */
export function PluginPanelWindow({ panelId }: { panelId: string }) {
  const [payload, setPayload] = useState<PluginPanelReportPayload | undefined>();

  useEffect(() => {
    document.documentElement.classList.add("palette-window-html");
    document.body.classList.add("palette-window-body");
    return () => {
      document.documentElement.classList.remove("palette-window-html");
      document.body.classList.remove("palette-window-body");
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenForPluginPanelReports((next) => {
      if (next.panelId !== panelId) {
        return;
      }
      setPayload((current) => (current && current.revision >= next.revision ? current : next));
    })
      .then((cleanup) => {
        unlisten = cleanup;
        void requestPluginPanelReport(panelId).catch(() => undefined);
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
    };
  }, [panelId]);

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
        <button
          type="button"
          className="palette-close-button"
          aria-label="Close panel"
          onClick={() => void hideCurrentPanelWindow().catch(() => undefined)}
        >
          ×
        </button>
      </div>
      <div className="plugin-panel-content">
        {payload ? (
          payload.report.sections.map((section, index) => <PanelSection key={index} section={section} />)
        ) : (
          <p className="plugin-panel-waiting">Waiting for plugin content…</p>
        )}
      </div>
    </aside>
  );
}

function PanelSection({ section }: { section: PluginPanelSection }) {
  switch (section.kind) {
    case "text":
      return (
        <section className="plugin-panel-section">
          {section.title ? <h2>{section.title}</h2> : null}
          <p>{section.body}</p>
        </section>
      );
    case "keyValue":
      return (
        <section className="plugin-panel-section">
          {section.title ? <h2>{section.title}</h2> : null}
          <dl>
            {section.rows.map((row, index) => (
              <div className="plugin-panel-key-value" key={index}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "table":
      return (
        <section className="plugin-panel-section">
          {section.title ? <h2>{section.title}</h2> : null}
          <table>
            <thead>
              <tr>
                {section.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    case "svg":
      return (
        <section className="plugin-panel-section">
          {section.title ? <h2>{section.title}</h2> : null}
          <img
            className="plugin-panel-svg"
            alt={section.caption ?? section.title ?? "Plugin figure"}
            src={`data:image/svg+xml;utf8,${encodeURIComponent(section.svg)}`}
          />
          {section.caption ? <p className="plugin-panel-caption">{section.caption}</p> : null}
        </section>
      );
    default:
      return null;
  }
}
