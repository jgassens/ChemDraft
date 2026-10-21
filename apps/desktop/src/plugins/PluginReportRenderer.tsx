import type { PluginPanelReport, PluginPanelSection } from "@chemdraft/plugin-api";

import { LinkedFigureView } from "./LinkedFigureView";
import { useState } from "react";
import { writeClipboardText } from "../clipboard";

/**
 * Renders a validated {@link PluginPanelReport} with core desktop UI. Plugins never ship components;
 * they describe results as data, and this is the single renderer for all of them. SVG sections are
 * drawn through an `<img>` data URL so any embedded script is inert (an `<img>` never executes
 * script), matching the security contract documented on the panel-report schema.
 */
export function PluginReportRenderer({ report, copyText = writeClipboardText }: {
  report: PluginPanelReport;
  copyText?: (text: string) => Promise<boolean>;
}) {
  return (
    <div className="plugin-report">
      {report.sections.map((section, index) => (
        <PluginReportSectionView key={index} section={section} copyText={copyText} />
      ))}
    </div>
  );
}

function PluginReportSectionView({ section, copyText }: { section: PluginPanelSection; copyText: (text: string) => Promise<boolean> }) {
  switch (section.kind) {
    case "chemicalName":
      return <ChemicalNameSection section={section} copyText={copyText} />;
    case "text":
      return (
        <section className="plugin-report-section plugin-report-text">
          {section.title ? <h4>{section.title}</h4> : null}
          <p>{section.body}</p>
        </section>
      );
    case "keyValue":
      return (
        <section className="plugin-report-section plugin-report-keyvalue">
          {section.title ? <h4>{section.title}</h4> : null}
          <dl>
            {section.rows.map((row, index) => (
              <div key={index} className="plugin-report-kv-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "table":
      return (
        <section className="plugin-report-section plugin-report-table">
          {section.title ? <h4>{section.title}</h4> : null}
          <div className="plugin-report-table-scroll">
            <table>
              <thead>
                <tr>
                  {section.columns.map((column, index) => (
                    <th key={index}>{column}</th>
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
          </div>
        </section>
      );
    case "svg":
      return (
        <section className="plugin-report-section plugin-report-svg">
          {section.title ? <h4>{section.title}</h4> : null}
          <img
            className="plugin-report-svg-image"
            alt={section.title ?? section.caption ?? "Plugin visualization"}
            src={`data:image/svg+xml;utf8,${encodeURIComponent(section.svg)}`}
          />
          {section.caption ? <p className="plugin-report-caption">{section.caption}</p> : null}
        </section>
      );
    case "linkedFigure":
      return (
        <section className="plugin-report-section plugin-report-figure">
          {section.title ? <h4>{section.title}</h4> : null}
          <LinkedFigureView spectrum={section.spectrum} structure={section.structure} />
          {section.caption ? <p className="plugin-report-caption">{section.caption}</p> : null}
        </section>
      );
  }
  return <section className="plugin-report-section"><pre>{JSON.stringify(section, null, 2)}</pre></section>;
}

function ChemicalNameSection({ section, copyText }: {
  section: Extract<PluginPanelSection, { kind: "chemicalName" }>;
  copyText: (text: string) => Promise<boolean>;
}) {
  const [error, setError] = useState<string>();
  const copy = async () => {
    try {
      const written = await copyText(section.name);
      setError(written ? undefined : "The name could not be copied to the clipboard.");
    } catch { setError("The name could not be copied to the clipboard."); }
  };
  return <section className="plugin-report-section plugin-report-chemical-name">
    <h4>{section.label}</h4>
    <pre style={{ userSelect: "text", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{section.name}</pre>
    <button type="button" onClick={() => void copy()}>Copy</button>
    <p>{section.kindLabel}</p>
    {section.warnings.map((warning, index) => <p key={index}>{warning.message}</p>)}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
