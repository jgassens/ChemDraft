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
  const peaks: PluginLinkedFigurePeak[] = result.resonances.map((resonance) => {
    const peak: PluginLinkedFigurePeak = {
      id: resonance.id,
      ppm: resonance.deltaPpm,
      intensity: resonance.equivalentNuclei ?? 1,
      label: resonance.deltaPpm.toFixed(2),
      atomIndices: resonance.atomRefs.map((ref) => ref.sourceAtomIndex)
    };
    const tier = confidenceTier(resonance);
    if (tier === "estimated") {
      peak.estimated = true;
    } else if (tier === "high" || tier === "medium" || tier === "low") {
      peak.confidence = tier;
    }
    const couplings = resonance.multiplet?.couplings ?? [];
    if (couplings.length > 0) {
      peak.couplings = couplings.map((coupling) => ({ jHz: coupling.jHz, partnerCount: coupling.partnerCount }));
    }
    return peak;
  });

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

/**
 * ppm window to plot: just the predicted peaks plus a small buffer, snapped to a clean edge — not the
 * whole conventional range. A ~1 ppm (¹H) / ~10 ppm (¹³C) margin keeps a little breathing room without
 * a screenful of empty baseline.
 */
function spectrumDomain(nucleus: NmrNucleus, shifts: readonly number[]): { min: number; max: number } {
  if (shifts.length === 0) {
    return nucleus === "13C" ? { min: 0, max: 220 } : { min: 0, max: 12 };
  }
  const buffer = nucleus === "13C" ? 10 : 1;
  const snap = nucleus === "13C" ? 5 : 0.5;
  const lo = Math.min(...shifts) - buffer;
  const hi = Math.max(...shifts) + buffer;
  return { min: Math.floor(lo / snap) * snap, max: Math.ceil(hi / snap) * snap };
}

function resonanceTable(result: NmrPredictionResult): PluginPanelSection {
  const rows = [...result.resonances]
    .sort((a, b) => b.deltaPpm - a.deltaPpm)
    .map((resonance) => {
      const estimated = resonance.evidence?.method === "rule-estimated";
      return [
        nucleusLabel(resonance.nucleus),
        `${estimated ? "≈" : ""}${resonance.deltaPpm.toFixed(2)}`,
        String(resonance.equivalentNuclei ?? 1),
        resonance.multiplet?.label ?? "—",
        formatCouplings(resonance),
        formatUncertainty(resonance),
        confidenceLabel(resonance),
        resonance.atomRefs.map((ref) => ref.sourceAtomIndex).join(", "),
        estimated ? "rule-estimated" : resonance.evidence?.environmentCode ?? "—"
      ];
    });

  return {
    kind: "table",
    title: "Predicted shifts",
    columns: ["Nucleus", "δ (ppm)", "Equiv.", "Mult.", "J (Hz)", "± σ (ppm)", "Confidence", "Atoms", "Environment"],
    rows
  };
}

/** First-order coupling constants (estimated, topology-based) for a resonance; "—" when none. */
function formatCouplings(resonance: NmrResonance): string {
  const couplings = resonance.multiplet?.couplings ?? [];
  return couplings.length === 0 ? "—" : couplings.map((coupling) => coupling.jHz.toFixed(1)).join(", ");
}

function formatUncertainty(resonance: NmrResonance): string {
  const sigma = resonance.uncertainty?.standardDeviationPpm;
  return sigma === undefined ? "—" : sigma.toFixed(2);
}

// Honest confidence comes from the *applicability* of the match, not a fabricated score: how specific
// the matched environment is (HOSE sphere depth) and how well-populated its reference is (n). These
// mirror the notices the predictor already raises — LowHoseSphereMatch (sphere ≤ 1) and
// SmallReferencePopulation (n < 3) — so the column and the notices never disagree.
const CONFIDENCE_MIN_POPULATION = 3; // mirrors OclHosePredictor SMALL_POPULATION_THRESHOLD
const CONFIDENCE_HIGH_POPULATION = 8; // a healthy reference population, well above the small-population floor
const CONFIDENCE_HIGH_SPHERE = 3; // a specific (≥3-bond) environment, not a shallow class match

type ConfidenceTier = "high" | "medium" | "low" | "estimated" | "unknown";

/** Machine-readable confidence tier from match applicability. Shared by the table label and the
 *  figure peak (low-confidence peaks are drawn muted). `estimated` = rule guess (never a DB match);
 *  `unknown` = a match with no sphere/n basis (e.g. the synthetic fixture). */
function confidenceTier(resonance: NmrResonance): ConfidenceTier {
  const evidence = resonance.evidence;
  if (evidence?.method === "rule-estimated") {
    return "estimated";
  }
  const sphere = evidence?.matchedSphere;
  const n = evidence?.sampleCount;
  if (sphere === undefined || n === undefined) {
    return "unknown";
  }
  if (sphere <= 1 || n < CONFIDENCE_MIN_POPULATION) {
    return "low";
  }
  if (sphere >= CONFIDENCE_HIGH_SPHERE && n >= CONFIDENCE_HIGH_POPULATION) {
    return "high";
  }
  return "medium";
}

/**
 * Per-peak confidence label carrying its own basis (sphere depth + n) so the number is self-explaining:
 * `high · s4, n=42`. A rule-estimated peak is never a database match → `est.`; a match with no
 * applicability data (e.g. the synthetic fixture) → `—`.
 */
function confidenceLabel(resonance: NmrResonance): string {
  const tier = confidenceTier(resonance);
  if (tier === "estimated") {
    return "est.";
  }
  if (tier === "unknown") {
    return "—";
  }
  const { matchedSphere, sampleCount } = resonance.evidence ?? {};
  return `${tier === "medium" ? "med" : tier} · s${matchedSphere}, n=${sampleCount}`;
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
