import type { PluginPanelReport, PluginPanelSection, PluginSelectedMolecule } from "@chemdraft/plugin-api";

import type { NmrNucleus, NmrPredictionResult, NmrResonance } from "../domain/contracts";
import type { CommandError } from "../application/mapSelection";

const PANEL_TITLE = "NMR Prediction";
const SYNTHETIC_DISCLAIMER =
  "Synthetic fixture values — a deterministic architecture demo, not experimental reference data.";

function nucleusLabel(nucleus: NmrNucleus): string {
  return nucleus === "13C" ? "¹³C" : "¹H";
}

function nucleiLabel(nuclei: readonly NmrNucleus[]): string {
  return nuclei.map(nucleusLabel).join(" + ");
}

function structureSection(source: PluginSelectedMolecule): PluginPanelSection {
  return {
    kind: "keyValue",
    title: "Source",
    rows: [
      { label: "Object", value: source.objectId },
      { label: "Format", value: source.structureFormat }
    ]
  };
}

/** Panel shown while a prediction is running (before the worker result arrives). */
export function composePendingReport(
  source: PluginSelectedMolecule,
  nuclei: readonly NmrNucleus[]
): PluginPanelReport {
  return {
    title: PANEL_TITLE,
    sections: [
      { kind: "text", body: `Predicting ${nucleiLabel(nuclei)} shifts for the selected structure…` },
      structureSection(source)
    ]
  };
}

/** Panel shown when a prediction fails or is rejected before producing a result. */
export function composeErrorReport(source: PluginSelectedMolecule, error: CommandError): PluginPanelReport {
  return {
    title: PANEL_TITLE,
    sections: [
      { kind: "text", title: "Prediction failed", body: `${error.message} (${error.code})` },
      structureSection(source)
    ]
  };
}

/** Panel shown for a produced result: provenance, the shift table, notices, and the synthetic-data
 *  disclaimer. The stick-spectrum SVG is added in M9; this milestone renders the data as a table. */
export function composePredictionReport(
  source: PluginSelectedMolecule,
  result: NmrPredictionResult
): PluginPanelReport {
  const sections: PluginPanelSection[] = [
    {
      kind: "keyValue",
      title: "Prediction",
      rows: [
        { label: "Method", value: result.backend.method },
        { label: "Engine", value: `${result.backend.id} v${result.backend.version}` },
        { label: "Nuclei", value: nucleiLabel(distinctNuclei(result)) || "—" },
        { label: "Resonances", value: String(result.resonances.length) }
      ]
    },
    structureSection(source)
  ];

  if (result.resonances.length > 0) {
    sections.push(resonanceTable(result));
  }
  sections.push(...noticeSections(result));
  sections.push({ kind: "text", body: SYNTHETIC_DISCLAIMER });

  return { title: PANEL_TITLE, sections };
}

function distinctNuclei(result: NmrPredictionResult): NmrNucleus[] {
  const seen = new Set<NmrNucleus>();
  for (const resonance of result.resonances) {
    seen.add(resonance.nucleus);
  }
  return [...seen];
}

function resonanceTable(result: NmrPredictionResult): PluginPanelSection {
  const rows = [...result.resonances]
    .sort((a, b) => b.deltaPpm - a.deltaPpm)
    .map((resonance) => [
      nucleusLabel(resonance.nucleus),
      resonance.deltaPpm.toFixed(2),
      String(resonance.equivalentNuclei ?? 1),
      formatUncertainty(resonance),
      resonance.atomRefs.map((ref) => ref.sourceAtomIndex).join(", "),
      resonance.evidence?.environmentCode ?? "—"
    ]);

  return {
    kind: "table",
    title: "Predicted shifts",
    columns: ["Nucleus", "δ (ppm)", "Equiv.", "± σ (ppm)", "Atoms", "Environment"],
    rows
  };
}

function formatUncertainty(resonance: NmrResonance): string {
  const sigma = resonance.uncertainty?.standardDeviationPpm;
  return sigma === undefined ? "—" : sigma.toFixed(2);
}

function noticeSections(result: NmrPredictionResult): PluginPanelSection[] {
  if (result.warnings.length === 0) {
    return [];
  }
  return [
    {
      kind: "text",
      title: "Notices",
      body: result.warnings.map((warning) => `• ${warning.message} (${warning.code})`).join("\n")
    }
  ];
}
