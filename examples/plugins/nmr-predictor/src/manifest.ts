import type { PluginManifest } from "@chemdraft/plugin-api";

export const nmrPredictorPluginId = "org.chemdraft.nmr.predictor";

/** ¹³C is the default nucleus; ¹H is a separate, experimental command (ADR-0011: value-encoded
 *  commands, not an argument channel). Handlers are wired in M8. */
export const nmrPredictCarbonCommandId = "plugin.nmrPredictor.predictSelectedStructure";
export const nmrPredictProtonCommandId = "plugin.nmrPredictor.predictWithProtonExperimental";
export const nmrPredictorPanelId = "panel.nmrPredictor.review";
export const nmrPredictorAnalyzerId = "plugin.nmrPredictor.forwardPrediction";

/** analysisType stamped on records written to the generic analysis store (M8). */
export const nmrForwardPredictionAnalysisType = "nmr.forward-prediction";

export const nmrPredictorManifest: PluginManifest = {
  id: nmrPredictorPluginId,
  name: "NMR Shift Predictor",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  description:
    "¹H/¹³C NMR shift predictor: HOSE-fragment lookup over shift statistics derived from NMRShiftDB2 experimental assignments (nmrshiftdb2 Database License, ODbL-derived). ¹H multiplicity and couplings are first-order topology estimates, not measured values; stick height is predicted equivalent nuclei, not experimental integration; unsupported environments are omitted with a warning rather than given a fabricated value.",
  entry: "dist/plugin.js",
  permissions: ["selection.read", "analysis.write", "ui.menu", "ui.panel"],
  contributes: {
    commands: [
      {
        id: nmrPredictCarbonCommandId,
        title: "Predict ¹³C NMR Shifts",
        category: "Analyze",
        description:
          "Predict ¹³C shifts for the selected structure by HOSE-fragment lookup over NMRShiftDB2-derived statistics.",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      },
      {
        id: nmrPredictProtonCommandId,
        title: "Predict ¹H NMR Shifts (experimental)",
        category: "Analyze",
        description: "Experimental ¹H prediction; labile protons are omitted by default.",
        requiredPermissions: ["selection.read", "analysis.write"],
        enabled: true
      }
    ],
    menus: [
      {
        id: "menu.nmrPredictor.predictCarbon",
        title: "Predict ¹³C NMR Shifts",
        commandId: nmrPredictCarbonCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      },
      {
        id: "menu.nmrPredictor.predictProton",
        title: "Predict ¹H NMR Shifts (experimental)",
        commandId: nmrPredictProtonCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
    panels: [
      {
        id: nmrPredictorPanelId,
        title: "NMR Prediction",
        commandId: nmrPredictCarbonCommandId,
        requiredPermissions: ["ui.panel"]
      }
    ],
    analyzers: [
      {
        id: nmrPredictorAnalyzerId,
        title: "NMR Forward Prediction",
        commandId: nmrPredictCarbonCommandId,
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
