import type {
  PluginLinkedFigurePeak,
  PluginLinkedFigureSection,
  PluginPanelReport,
  PluginPanelSection,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";

import type { NmrNucleus, NmrPredictionResult, NmrResonance } from "../domain/contracts";
import type { CommandError } from "../application/mapSelection";

const PANEL_TITLE = "NMR Prediction";
const SYNTHETIC_DISCLAIMER =
  "Synthetic fixture values — a deterministic architecture demo, not experimental reference data.";
const EXPERIMENTAL_NOTE =
  "Statistical predictions from aggregated experimental reference shifts. Confidence is low where the " +
  "reference population is small or only a shallow environment matched — see notices above.";

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

  const experimental = result.backend.method === "hose-fragment";

  if (result.resonances.length > 0) {
    sections.push(linkedFigureSection(result, experimental));
    sections.push(resonanceTable(result));
  }
  sections.push(...noticeSections(result));
  sections.push(...databaseSection(result));
  sections.push({ kind: "text", body: experimental ? EXPERIMENTAL_NOTE : SYNTHETIC_DISCLAIMER });

  return {
    title: PANEL_TITLE,
    // Staleness reference (D-09): desktop chrome compares this against the live document.
    source: { objectId: source.objectId, sourceFingerprint: source.sourceFingerprint },
    sections
  };
}

function distinctNuclei(result: NmrPredictionResult): NmrNucleus[] {
  const seen = new Set<NmrNucleus>();
  for (const resonance of result.resonances) {
    seen.add(resonance.nucleus);
  }
  return [...seen];
}

/**
 * The interactive figure (ADR-0015): peaks carry the atoms they came from, and — when the backend
 * built a real molecule — the 2D depiction rides along so the desktop can annotate each atom with its
 * shift and cross-highlight on hover. Data only; the core owns all rendering and interaction.
 */
function linkedFigureSection(result: NmrPredictionResult, experimental: boolean): PluginLinkedFigureSection {
  const nucleus = result.resonances[0]?.nucleus ?? "13C";
  const shifts = result.resonances.map((resonance) => resonance.deltaPpm);
  const peaks: PluginLinkedFigurePeak[] = result.resonances.map((resonance) => ({
    id: resonance.id,
    ppm: resonance.deltaPpm,
    intensity: resonance.equivalentNuclei ?? 1,
    label: resonance.deltaPpm.toFixed(2),
    atomIndices: resonance.atomRefs.map((ref) => ref.sourceAtomIndex)
  }));

  const section: PluginLinkedFigureSection = {
    kind: "linkedFigure",
    title: `Predicted ${nucleusLabel(nucleus)} NMR`,
    caption: experimental
      ? "Scroll to zoom, drag to pan; hover a peak to highlight the atoms it came from."
      : "Synthetic fixture spectrum. Scroll to zoom, drag to pan; hover a peak to highlight its atoms.",
    spectrum: { nucleus, domain: spectrumDomain(nucleus, shifts), reversed: true, peaks }
  };

  if (result.depiction) {
    section.structure = {
      atoms: result.depiction.atoms.map((atom) => ({ index: atom.index, x: atom.x, y: atom.y, element: atom.element })),
      bonds: result.depiction.bonds.map((bond) => ({ from: bond.from, to: bond.to, order: bond.order }))
    };
  }

  return section;
}

/** ppm window to plot: the nucleus's conventional range, widened to fit any outlying predicted shift. */
function spectrumDomain(nucleus: NmrNucleus, shifts: readonly number[]): { min: number; max: number } {
  const defaults = nucleus === "13C" ? { min: 0, max: 220 } : { min: 0, max: 12 };
  if (shifts.length === 0) {
    return defaults;
  }
  return {
    min: Math.min(defaults.min, Math.floor(Math.min(...shifts) - 5)),
    max: Math.max(defaults.max, Math.ceil(Math.max(...shifts) + 5))
  };
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

/** Database provenance (ADR-0014): name, version, license, source + attribution, when the backend
 *  carries it (the OCL-native predictor does; the fixture does not). */
function databaseSection(result: NmrPredictionResult): PluginPanelSection[] {
  const { backend } = result;
  if (!backend.license && !backend.source) {
    return [];
  }
  const rows = [
    { label: "Database", value: backend.dataVersion ?? backend.id },
    { label: "Version", value: backend.version }
  ];
  if (backend.license) {
    rows.push({ label: "License", value: backend.license });
  }
  if (backend.source) {
    rows.push({ label: "Source", value: backend.source });
  }
  const sections: PluginPanelSection[] = [{ kind: "keyValue", title: "Reference database", rows }];
  if (backend.attribution) {
    sections.push({ kind: "text", body: backend.attribution });
  }
  return sections;
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
