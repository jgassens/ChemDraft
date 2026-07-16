import type {
  PluginLinkedFigurePeak,
  PluginLinkedFigureSection,
  PluginPanelReport,
  PluginPanelSection,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";

import { PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM } from "../domain/contracts";
import type { NmrNucleus, NmrPredictionResult, NmrResonance } from "../domain/contracts";
import type { CommandError } from "../application/mapSelection";
import { MEASURED_ACCURACY } from "../providers/ocl/measuredAccuracy";

const PANEL_TITLE = "NMR Prediction";
const SYNTHETIC_DISCLAIMER =
  "Synthetic fixture values — a deterministic architecture demo, not experimental reference data.";
const EXPERIMENTAL_NOTE =
  "Statistical predictions from aggregated experimental reference shifts. Confidence is low where the " +
  "reference population is small or only a shallow environment matched — see notices above.";
const MIXED_METHOD_NOTE =
  "Mixed result: HOSE peaks are statistical predictions from aggregated experimental reference shifts; " +
  "rule-estimated shifts are marked ≈ in the table and drawn muted/italic in the spectrum.";
const RULE_ONLY_NOTE =
  "Rule-estimated shifts from bounded increment and functional-class tables; no HOSE reference match " +
  "contributed to this result. Treat these values as coarse estimates, not experimental-reference predictions.";
const NO_RESULT_NOTE =
  "No applicable resonance was produced: neither the configured reference database nor the bounded " +
  "rule tables yielded a supported shift. See the notices for the omitted chemistry.";
const OTHER_METHOD_NOTE =
  "Method-derived predicted shifts from the reported backend. They are predictions, not experimental " +
  "measurements; consult the engine provenance and notices for method-specific limits.";

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

/** Panel shown for a produced result: provenance, linked spectrum/structure, shift table, notices,
 * and a method-specific scientific disclaimer. */
export function composePredictionReport(
  source: PluginSelectedMolecule,
  result: NmrPredictionResult
): PluginPanelReport {
  const methods = resultMethodSummary(result);
  const sections: PluginPanelSection[] = [
    {
      kind: "keyValue",
      title: "Prediction",
      rows: [
        { label: "Method", value: resultMethodLabel(result, methods) },
        { label: "Engine", value: `${result.backend.id} v${result.backend.version}` },
        { label: "Nuclei", value: nucleiLabel(distinctNuclei(result)) || "—" },
        { label: "Resonances", value: String(result.resonances.length) }
      ]
    },
    structureSection(source)
  ];

  if (result.resonances.length > 0) {
    sections.push(...estimateProvenanceSections(result));
    sections.push(linkedFigureSection(result, methods));
    sections.push(resonanceTable(result));
  }
  sections.push(...noticeSections(result));
  sections.push(...databaseSection(result));
  sections.push({ kind: "text", body: resultDisclaimer(result, methods) });

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
interface ResultMethodSummary {
  fixture: boolean;
  hasHose: boolean;
  hasRules: boolean;
  empty: boolean;
}

function resultMethodSummary(result: NmrPredictionResult): ResultMethodSummary {
  return {
    fixture: result.backend.method === "fixture-fragment",
    hasHose: result.resonances.some((resonance) => resonance.evidence?.method === "hose-fragment"),
    hasRules: result.resonances.some((resonance) => resonance.evidence?.method === "rule-estimated"),
    empty: result.resonances.length === 0
  };
}

function resultDisclaimer(result: NmrPredictionResult, methods: ResultMethodSummary): string {
  if (methods.empty) return NO_RESULT_NOTE;
  if (methods.fixture) return SYNTHETIC_DISCLAIMER;
  if (methods.hasHose && methods.hasRules) return MIXED_METHOD_NOTE;
  if (methods.hasRules) return RULE_ONLY_NOTE;
  if (methods.hasHose || result.backend.method === "hose-fragment") return EXPERIMENTAL_NOTE;
  return OTHER_METHOD_NOTE;
}

function resultMethodLabel(result: NmrPredictionResult, methods: ResultMethodSummary): string {
  if (methods.empty) return "no applicable prediction";
  if (methods.hasHose && methods.hasRules) return "hose-fragment + rule-estimated";
  if (methods.hasRules) return "rule-estimated";
  return result.backend.method;
}

function linkedFigureSection(result: NmrPredictionResult, methods: ResultMethodSummary): PluginLinkedFigureSection {
  const nucleus = result.resonances[0]?.nucleus ?? "13C";
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
    // Expose every chemically applicable HOSE/increment pair to the figure. `disagrees` controls
    // interpretation only; it never gates the user's access to an available table calculation.
    if (resonance.crossCheck) {
      peak.alternativePpm = resonance.crossCheck.incrementPpm;
    }
    const couplings = resonance.multiplet?.couplings ?? [];
    if (couplings.length > 0) {
      peak.couplings = couplings.map((coupling) => ({ jHz: coupling.jHz, partnerCount: coupling.partnerCount }));
    }
    return peak;
  });
  // A user may switch to "Show both" after the initial render. Include alternatives in the initial
  // domain so the added comparison peak cannot fall off-canvas.
  const shifts = peaks.flatMap((peak) =>
    peak.alternativePpm === undefined ? [peak.ppm] : [peak.ppm, peak.alternativePpm]
  );

  const section: PluginLinkedFigureSection = {
    kind: "linkedFigure",
    title: `Predicted ${nucleusLabel(nucleus)} NMR`,
    caption: figureCaption(methods),
    spectrum: {
      nucleus,
      domain: spectrumDomain(nucleus, shifts),
      reversed: true,
      peaks,
      ...(nucleus === "1H" && methods.hasHose
        ? {
            comparison: {
              primaryLabel: "HOSE",
              alternativeLabel: "increment",
              alternativeMarker: "ᵢ"
            }
          }
        : {})
    }
  };

  if (methods.hasHose) {
    // Measured 106/196 CDCl₃ in the NMReDATA sample (then D₂O, DMSO-d₆, …): predominant, not uniform.
    // Only stated for measured-data results — the synthetic fixture has no solvent context.
    section.spectrum.solvent = "CDCl₃ (predominant reference solvent; mixed corpus)";
  }

  if (result.depiction) {
    section.structure = {
      atoms: result.depiction.atoms.map((atom) => ({ index: atom.index, x: atom.x, y: atom.y, element: atom.element })),
      bonds: result.depiction.bonds.map((bond) => ({ from: bond.from, to: bond.to, order: bond.order }))
    };
  }

  return section;
}

function figureCaption(methods: ResultMethodSummary): string {
  const interaction =
    "Peak height represents predicted equivalent nuclei, not experimental integration. " +
    "Scroll to zoom, drag to pan; hover a peak to highlight its atoms.";
  if (methods.fixture) return `Synthetic fixture spectrum. ${interaction}`;
  if (methods.hasHose && methods.hasRules) {
    return `Mixed HOSE and rule-estimated spectrum; muted italic peaks mark rule estimates. ${interaction}`;
  }
  if (methods.hasRules) {
    return `Rule-estimated spectrum; muted italic peaks mark coarse table estimates. ${interaction}`;
  }
  return interaction;
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
        confidenceCell(resonance),
        resonance.atomRefs.map((ref) => ref.sourceAtomIndex).join(", "),
        estimated
          ? `rule-estimated (${resonance.evidence?.estimator?.method ?? "unknown rule"})`
          : resonance.evidence?.environmentCode ?? "—"
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

/** Confidence label plus every paired increment value. The table always shows both numbers
 * transparently; `disagrees` controls notice emphasis, not whether the second opinion is visible. */
function confidenceCell(resonance: NmrResonance): string {
  const base = confidenceLabel(resonance);
  if (resonance.crossCheck) {
    return `${base} · vs inc ${resonance.crossCheck.incrementPpm.toFixed(2)}`;
  }
  return base;
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
  rows.push(...measuredAccuracyRows(result));
  const sections: PluginPanelSection[] = [{ kind: "keyValue", title: "Reference database", rows }];
  if (backend.attribution) {
    sections.push({ kind: "text", body: backend.attribution });
  }
  return sections;
}

/** Held-out benchmark error for the nuclei in this result — shown only when the active database was
 * compiled from the exact corpus the benchmark measured (checksum equality). A rebuild from any
 * other corpus silently drops the claim until the benchmark is rerun (ADR-0026). */
function measuredAccuracyRows(result: NmrPredictionResult): { label: string; value: string }[] {
  if (result.backend.dataChecksum !== MEASURED_ACCURACY.corpusSha256) {
    return [];
  }
  const rows: { label: string; value: string }[] = [];
  for (const nucleus of distinctNuclei(result)) {
    const measured = MEASURED_ACCURACY.nuclei[nucleus];
    if (!measured) continue;
    const tiers = (["high", "medium", "low"] as const)
      .flatMap((tier) => {
        const stats = measured.byTier[tier];
        return stats ? [`${tier} ${stats.medianAe}`] : [];
      })
      .join(" / ");
    rows.push({
      label: `Measured accuracy (${nucleiLabel([nucleus])})`,
      value: `median |Δ| ${measured.hose.medianAe} ppm (${tiers}) — held-out benchmark, ${MEASURED_ACCURACY.benchmarkDate}`
    });
  }
  return rows;
}

/** Exact per-estimate identity for mixed-method results. The overall backend remains the HOSE engine;
 * this section prevents a displayed additive value from inheriting database provenance by accident. */
function estimateProvenanceSections(result: NmrPredictionResult): PluginPanelSection[] {
  const estimates = new Map<string, { id: string; version: string; method: string }>();
  for (const resonance of result.resonances) {
    for (const estimator of [resonance.evidence?.estimator, resonance.crossCheck?.estimator]) {
      if (!estimator) continue;
      estimates.set(`${estimator.id}@${estimator.version}:${estimator.method}`, estimator);
    }
  }
  if (estimates.size === 0) return [];
  return [
    {
      kind: "keyValue",
      title: "Estimate provenance",
      rows: [...estimates.values()].map((estimator, index) => ({
        label: estimates.size === 1 ? "Estimator" : `Estimator ${index + 1}`,
        value: `${estimator.id} v${estimator.version} · ${estimator.method}`
      }))
    }
  ];
}

function noticeSections(result: NmrPredictionResult): PluginPanelSection[] {
  const lines: string[] = [];
  const agreement = incrementAgreementSummary(result);
  if (agreement) lines.push(`• ${agreement}`);
  const eligibility = incrementEligibilitySummary(result);
  if (eligibility) lines.push(`• ${eligibility}`);
  lines.push(...result.warnings.map((warning) => `• ${warning.message} (${warning.code})`));
  if (lines.length === 0) return [];
  return [
    {
      kind: "text",
      title: "Notices",
      body: lines.join("\n")
    }
  ];
}

function incrementEligibilitySummary(result: NmrPredictionResult): string | undefined {
  const highDispersionCount = result.resonances.filter(
    (resonance) => resonance.crossCheck?.reason === "high-dispersion"
  ).length;
  if (highDispersionCount === 0) return undefined;
  const noun = highDispersionCount === 1 ? "HOSE resonance" : "HOSE resonances";
  return `${highDispersionCount} compared ${noun} ${highDispersionCount === 1 ? "has" : "have"} a broad reference distribution (σ ≥ ${PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM.toFixed(2)} ppm); that spread affects interpretation, not comparison availability.`;
}

/** Plain-language method comparison for the report's Notices area. Only paired, applicable
 * HOSE/increment values participate; unmatched rule estimates have no HOSE value to compare against. */
function incrementAgreementSummary(result: NmrPredictionResult): string | undefined {
  const hoseResonances = result.resonances.filter(
    (resonance) => resonance.nucleus === "1H" && resonance.evidence?.method === "hose-fragment"
  );
  if (hoseResonances.length === 0) return undefined;

  const comparisons = hoseResonances.flatMap((resonance) =>
    resonance.crossCheck ? [{ hosePpm: resonance.deltaPpm, comparison: resonance.crossCheck }] : []
  );
  const coverage = `${comparisons.length} of ${hoseResonances.length} HOSE-predicted resonances`;
  if (comparisons.length === 0) {
    return `Additive-increment table calculations are not applicable to any of the ${hoseResonances.length} HOSE-predicted resonances in this structure; the shift comparison is HOSE-only.`;
  }

  const disagreementCount = comparisons.filter(({ comparison }) => comparison.disagrees).length;
  const agreementCount = comparisons.length - disagreementCount;
  const coverageIsLimited = comparisons.length < 3 || comparisons.length / hoseResonances.length < 0.5;
  if (coverageIsLimited) {
    if (comparisons.length === 1) {
      const [{ hosePpm, comparison }] = comparisons;
      const difference = Math.abs(hosePpm - comparison.incrementPpm).toFixed(2);
      return `Limited additive-increment comparison: ${coverage} has an applicable table calculation. It differs from HOSE by ${difference} ppm and ${comparison.disagrees ? "exceeds" : "is within"} the comparison threshold. Coverage is too limited to assess general agreement.`;
    }
    return `Limited additive-increment comparison: ${coverage} have applicable table calculations; ${agreementCount} are within the comparison threshold and ${disagreementCount} exceed it. Coverage is too limited to assess general agreement.`;
  }

  const allCompared =
    comparisons.length === 1
      ? "the compared resonance"
      : `all ${comparisons.length} compared resonances`;
  if (disagreementCount === 0) {
    return `Additive-increment table calculations are in general agreement with the HOSE predictions for ${allCompared} (${coverage} covered).`;
  }
  if (agreementCount === 0) {
    return `Additive-increment table calculations are not in general agreement with the HOSE predictions: ${allCompared} ${comparisons.length === 1 ? "exceeds" : "exceed"} the disagreement threshold (${coverage} covered).`;
  }
  return `Additive-increment table calculations show mixed agreement with the HOSE predictions: ${agreementCount} of ${comparisons.length} are within the comparison threshold and ${disagreementCount} exceed it (${coverage} covered).`;
}
