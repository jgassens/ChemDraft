/**
 * Maps a core `AnalysisReport` onto the panel-report shape the shared renderer consumes.
 *
 * AGENTS.md §8a: "`PluginReportRenderer` is the single renderer for every surface". That rule is about
 * the renderer, not about pretending core analysis is a plugin — analysis commands carry no
 * `pluginId`, register through the core registry, and never enter the plugin runtime. So the report
 * travels in the renderer's vocabulary and nothing else is shared.
 *
 * The only real work here is folding `ReportRow.note` into the rendered value. The renderer's
 * `keyValue` row is a label/value pair with no third slot, and dropping the note would take the
 * convention disclosure off the number it qualifies — which is the one thing §2 asks the UI not to do.
 */
import type { PluginPanelReport, PluginPanelSection } from "@chemdraft/plugin-api";
import type { AnalysisReport, AnalysisReportSection } from "@chemdraft/analysis-core";

function toSection(section: AnalysisReportSection): PluginPanelSection {
  switch (section.kind) {
    case "text":
      return { kind: "text", title: section.title, body: section.body };
    case "conventions":
      // Flattened to `text` rather than adding a section kind to `PluginPanelSection`: that schema is
      // the versioned plugin SDK surface, and this is a core-analysis presentation concern that no
      // plugin has asked for. The body keeps its line breaks — `.molecular-inspector-pane` styles the renderer's
      // text sections `white-space: pre-line` so they survive.
      return {
        kind: "text",
        title: section.title,
        body: section.groups
          .map((group) => [group.appliesTo.join(", "), ...group.conventions.map((entry) => `  • ${entry}`)].join("\n"))
          .join("\n\n")
      };
    case "keyValue":
      return {
        kind: "keyValue",
        title: section.title,
        rows: section.rows.map((row) => ({
          label: row.label,
          value: row.note ? `${row.value} · ${row.note}` : row.value
        }))
      };
    case "table":
      return { kind: "table", title: section.title, columns: [...section.columns], rows: section.rows.map((row) => [...row]) };
    case "svg":
      // Straight through: `svg` exists in the plugin panel schema already, and the renderer puts it in
      // an <img>, so a figure the core built travels the same script-free path a plugin's would.
      return {
        kind: "svg",
        title: section.title,
        svg: section.svg,
        ...(section.caption ? { caption: section.caption } : {})
      };
    case "spectrum":
      // A fallback only. The Molecular Inspector draws spectra itself and never routes them here; any
      // other surface using this mapper gets the values as a table rather than nothing at all.
      return {
        kind: "table",
        title: section.title,
        columns: ["Position", "Intensity"],
        rows: section.positions.map((position, index) => [
          position.toFixed(section.positionDecimals ?? 5),
          (section.intensities[index] ?? 0).toFixed(2)
        ])
      };
  }
}

export function toPanelReport(report: AnalysisReport): PluginPanelReport {
  return {
    title: report.title,
    sections: report.sections.map(toSection)
  };
}
