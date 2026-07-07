import type { PluginPanelReport, PluginPanelSection } from "@chemdraft/plugin-api";

/**
 * Renders a validated {@link PluginPanelReport} with core desktop UI. Plugins never ship components;
 * they describe results as data, and this is the single renderer for all of them. SVG sections are
 * drawn through an `<img>` data URL so any embedded script is inert (an `<img>` never executes
 * script), matching the security contract documented on the panel-report schema.
 */
export function PluginReportRenderer({ report }: { report: PluginPanelReport }) {
  return (
    <div className="plugin-report">
      {report.sections.map((section, index) => (
        <PluginReportSectionView key={index} section={section} />
      ))}
    </div>
  );
}

function PluginReportSectionView({ section }: { section: PluginPanelSection }) {
  switch (section.kind) {
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
  }
  return null;
}
