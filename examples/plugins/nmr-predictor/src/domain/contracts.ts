/**
 * Framework- and provider-neutral NMR prediction contracts. Every type here is JSON-serializable so
 * a result can cross the worker boundary (M7) and enter the generic analysis store (M8) unchanged —
 * no OpenChemLib instances, functions, maps, or cyclic references.
 *
 * Shapes follow PLANS.md ("Structure normalization…", "Hydrogen treatment", and the NmrPredictor
 * block). These are domain contracts, not the generic plugin API — nothing here leaks into
 * `@chemdraft/plugin-api`.
 */
import type { NmrPredictionWarning } from "./warnings";

export type NmrNucleus = "1H" | "13C";

/** The predictor's input structure. Deliberately excludes "unknown": a selection may report unknown,
 *  but request construction must reject it (NMR_UNSUPPORTED_STRUCTURE_FORMAT) before this type. */
export interface ChemicalStructureInput {
  format: "smiles" | "molfile-v2000" | "molfile-v3000";
  value: string;
}

export interface NmrPredictorCapabilities {
  id: string;
  version: string;
  execution: "worker-js" | "wasm" | "native-service" | "remote";
  nuclei: readonly NmrNucleus[];
  supportsAtomAssignments: boolean;
  supportsUncertainty: boolean;
  supportsCouplings: boolean;
  supportsSolvent: boolean;
  supportsConformers: boolean;
  supportsStereochemistry: boolean;
}

export interface NmrPredictionOptions {
  statistic: "median" | "mean";
  hoseLevels: readonly number[];
  ignoreLabileHydrogens: boolean;
}

export interface NmrPredictionRequest {
  structure: ChemicalStructureInput;
  nuclei: readonly NmrNucleus[];
  options: NmrPredictionOptions;
  /**
   * Optional selection fingerprint carried through from the M4 selection snapshot. When present the
   * result echoes it so downstream staleness detection compares against the exact source; when
   * absent the provider derives a structure-only fingerprint. (Documented extension of the PLANS
   * request shape — see fingerprint.ts.)
   */
  sourceFingerprint?: string;
}

export interface NmrAtomReference {
  sourceAtomIndex: number;
  element: string;
  equivalentCount?: number;
  backendAtomId?: string;
  chemDraftAtomId?: string;
}

export interface NmrPredictionEvidence {
  method: "fixture-fragment" | "hose-fragment" | "gnn" | "dft" | "hybrid" | "rule-estimated";
  matchedSphere?: number;
  sampleCount?: number;
  environmentCode?: string;
}

export interface NmrPredictionUncertainty {
  standardDeviationPpm?: number;
  minimumPpm?: number;
  maximumPpm?: number;
}

/** One first-order scalar coupling: a typical J for its class and how many equivalent partners
 *  contribute it. J values are class-typical estimates from the bond topology, not measured. */
export interface NmrCoupling {
  jHz: number;
  partnerCount: number;
  kind: "vicinal" | "aromatic-ortho" | "aromatic-meta" | "aldehyde" | "other";
  /** A representative partner atom index (for future peak↔peak linking). */
  toAtomIndex?: number;
}

/** First-order multiplicity for a ¹H resonance: a label (s, d, t, q, quint, sext, sept, dd, dt, ddd,
 *  m, …) and the distinct J groups (merged by value, largest first) that produce it. */
export interface NmrMultiplet {
  label: string;
  couplings: readonly NmrCoupling[];
}

export interface NmrResonance {
  id: string;
  nucleus: NmrNucleus;
  deltaPpm: number;
  atomRefs: readonly NmrAtomReference[];
  /** Predicted count of equivalent nuclei. This is NOT an experimental integral. */
  equivalentNuclei?: number;
  uncertainty?: NmrPredictionUncertainty;
  evidence?: NmrPredictionEvidence;
  /** First-order multiplicity + estimated couplings (¹H only; absent for ¹³C or when not computed). */
  multiplet?: NmrMultiplet;
  flags: readonly string[];
}

export interface NmrPredictionBackend {
  id: string;
  version: string;
  dataVersion?: string;
  method: string;
  /** Reference-database provenance, surfaced in the panel (see ADR-0014). */
  license?: string;
  attribution?: string;
  source?: string;
}

export interface NmrStructureAtom {
  index: number;
  x: number;
  y: number;
  element: string;
}

export interface NmrStructureBond {
  from: number;
  to: number;
  order: number;
}

/**
 * A chemistry-agnostic 2D depiction the desktop's interactive linked figure renders (ADR-0015).
 * Atom `index` values are the predictor's own atom indices, so they line up with resonance
 * `atomRefs.sourceAtomIndex` and the panel can cross-highlight peaks against atoms with no
 * re-derivation. Only backends that build a real molecule (the OCL predictor) emit this.
 */
export interface NmrStructureDepiction {
  atoms: readonly NmrStructureAtom[];
  bonds: readonly NmrStructureBond[];
}

export interface NmrPredictionResult {
  schemaVersion: "1";
  sourceFingerprint: string;
  backend: NmrPredictionBackend;
  resonances: readonly NmrResonance[];
  warnings: readonly NmrPredictionWarning[];
  generatedAt: string;
  /** Optional 2D structure geometry for the interactive panel figure. Absent for fixture backends. */
  depiction?: NmrStructureDepiction;
}

export interface NmrPredictor {
  getCapabilities(): NmrPredictorCapabilities | Promise<NmrPredictorCapabilities>;
  predict(request: NmrPredictionRequest, signal?: AbortSignal): Promise<NmrPredictionResult>;
}

/**
 * The normalization boundary's output: a provider-ready molecule plus the atom mapping back to the
 * source ordering. The normalized OpenChemLib molecule is the internal object; this carries only
 * serializable summary data.
 */
export interface NormalizedMolecule {
  sourceFormat: "smiles" | "molfile-v2000" | "molfile-v3000";
  canonicalSmiles?: string;
  molfileV3000?: string;
  /** Atom count in the active provider's indexing. */
  providerAtomCount: number;
  /** Optional source-to-provider atom index mapping. */
  atomIndexMap?: readonly { sourceAtomIndex: number; providerAtomIndex: number }[];
  warnings: readonly NmrPredictionWarning[];
}
