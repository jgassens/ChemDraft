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
  }
}

export function toPanelReport(report: AnalysisReport): PluginPanelReport {
  return {
    title: report.title,
    sections: report.sections.map(toSection)
  };
}
