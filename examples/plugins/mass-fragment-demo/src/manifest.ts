import type { PluginManifest } from "@chemdraft/plugin-api";

/**
 * A second, deliberately non-NMR analyzer. It exists to prove the host/analysis/panel APIs are
 * domain-agnostic: it reads the same selection, writes the same generic analysis store, and renders
 * the same declarative panel report as the NMR plugin — with zero spectroscopy concepts. Adding it is
 * one import + one `registerPlugin` call in the desktop (see `registerBundledPlugins`).
 */
export const massFragmentPluginId = "org.chemdraft.mass.fragment";

export const massAnalyzeCommandId = "plugin.massFragment.analyzeSelectedStructure";
export const massFragmentPanelId = "panel.massFragment.review";
export const massFragmentAnalyzerId = "analyzer.massFragment.forwardAnalysis";

/** analysisType stamped on records written to the generic analysis store. */
export const massForwardAnalysisType = "mass.forward-analysis";

export const massFragmentManifest: PluginManifest = {
  id: massFragmentPluginId,
  name: "Mass / m/z Analyzer",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  description: "Molecular formula, monoisotopic + average mass, common ESI adduct m/z, and a first-order isotope pattern for the selected structure.",
  entry: "dist/plugin.js",
  permissions: ["selection.read", "analysis.write", "ui.menu", "ui.panel"],
  contributes: {
    commands: [
      {
        id: massAnalyzeCommandId,
        title: "Analyze Mass / m/z",
        category: "Analyze",
        description: "Compute molecular formula, exact/average mass, adduct m/z, and isotope pattern for the selection.",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      }
    ],
    menus: [
      {
        id: "menu.massFragment.analyze",
        title: "Analyze Mass / m/z",
        commandId: massAnalyzeCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
    panels: [
      {
        id: massFragmentPanelId,
        title: "Mass Analysis",
        commandId: massAnalyzeCommandId,
        requiredPermissions: ["ui.panel"]
      }
    ],
    analyzers: [
      {
        id: massFragmentAnalyzerId,
        title: "Mass Forward Analysis",
        commandId: massAnalyzeCommandId,
        requiredPermissions: ["selection.read", "analysis.write"]
      }
    ],
    toolbarButtons: [],
    toolsets: [],
    inspectors: [],
    templates: [],
    importers: [],
    exporters: [],
    transformers: [],
    recognizers: []
  }
};
