export type ChemistryStructureFormat = "smiles" | "molfile-v2000" | "molfile-v3000" | "rxnfile" | "unknown";

export interface ChemistryWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}

export interface ChemistryStructureInput {
  format: ChemistryStructureFormat;
  value: string;
}

export interface ChemistryAdapterCapabilities {
  implementationName: string;
  implementationVersion?: string;
  supportedFormats: readonly ChemistryStructureFormat[];
  canValidateStructure: boolean;
  canCalculateFormula: boolean;
  canCalculateAverageMass: boolean;
  canCalculateExactMass: boolean;
  canCalculateTotalCharge: boolean;
  canReportStereochemistryWarnings: boolean;
  warnings: readonly ChemistryWarning[];
}

export interface StructureValidationResult {
  valid: boolean;
  errors: ChemistryWarning[];
  warnings: ChemistryWarning[];
}

export interface StructureProperties {
  formula?: string;
  averageMass?: number;
  exactMass?: number;
  totalCharge?: number;
  atomCount?: number;
  bondCount?: number;
  stereochemistry: string[];
}

export interface StructureAnalysisResult {
  input: ChemistryStructureInput;
  validation: StructureValidationResult;
  properties: StructureProperties;
  warnings: ChemistryWarning[];
}

export interface ChemistryAdapter {
  readonly id: string;
  getCapabilities(): ChemistryAdapterCapabilities;
  validateStructure(input: ChemistryStructureInput): Promise<StructureValidationResult>;
  analyzeStructure(input: ChemistryStructureInput): Promise<StructureAnalysisResult>;
}

// ---------------------------------------------------------------------------
// 3D conformer generation contract (Phase 2 — the 3D spin -> flatten feature)
// ---------------------------------------------------------------------------
//
// This is the seam between the app and whichever engine embeds a 3D conformer
// (OpenChemLib v1; RDKit-WASM fallback later). It is engine-NEUTRAL: only types.
//
// Atom identity mapping is first-order. Engines saturate the molecule with
// hydrogens and may mutate it in place, so an implementation MUST work on a copy,
// tag every original atom before handing it over, and rebuild the map afterward.
// `coords3dByOriginalAtom` is laid out exactly as `flattenPerspectiveFrom3D`'s
// `coords3d` expects: flat [x0,y0,z0, x1,y1,z1, ...] indexed by ORIGINAL atom.

export type ConformerEngineName = "openchemlib" | "rdkit-wasm" | "rdkit-native" | (string & {});

export interface ConformerAtomMapping {
  /** Flat [x,y,z] per original atom; length = originalAtomCount * 3. */
  coords3dByOriginalAtom: Float64Array;
  /** original atom index -> engine atom index. */
  originalToEngineAtom: number[];
  /** engine atom index -> original atom index, or -1 for an engine-generated H. */
  engineToOriginalAtom: number[];
  /** Engine atom indices for hydrogens the engine added (not in the input). */
  generatedHydrogenEngineAtoms: number[];
}

export interface ConformerForceFieldReport {
  name: "MMFF94" | "MMFF94s" | "UFF" | "none";
  status: "not-run" | "converged" | "not-converged" | "setup-failed";
  returnCode?: number;
  energy?: number;
  iterations?: number;
}

export interface Generate3DConformerResult {
  mapping: ConformerAtomMapping;
  originalAtomCount: number;
  generatedAtomCount: number;
  hydrogens: { added: boolean; explicitInputHydrogensPreserved: boolean };
  engine: { name: ConformerEngineName; version: string; parameters: Record<string, unknown> };
  embed: { status: "ok" | "failed" | "unsupported"; failureReason?: string };
  forceField?: ConformerForceFieldReport;
  unsupportedFeatures: ChemistryWarning[];
  warnings: ChemistryWarning[];
}

export interface Generate3DConformerOptions {
  /** Deterministic seed for the embedding (default engine-defined). */
  seed?: number;
  /** Force-field refinement. "auto" lets the engine choose (MMFF94, else none). */
  optimize?: "none" | "auto" | "mmff94" | "uff";
  /**
   * Cap on force-field minimisation iterations (default: the engine's full run).
   * Depiction-grade geometry reaches essentially the final energy well before the
   * engine default; capping bounds the worst case on large molecules.
   */
  maxMinimiseIterations?: number;
  /** v1 invariant: specified stereo is preserved. */
  preserveSpecifiedStereo?: boolean;
  /** v1 invariant: never invent unspecified stereo. */
  allowInventStereo?: boolean;
}

/**
 * Two-stage conformer delivery for latency-sensitive UI: the embedded conformer is
 * usable (collision-free, parities respected) the moment it exists; force-field
 * refinement is strictly cosmetic polish and can land later. `refine` is absent
 * when the embed failed or refinement was disabled (`optimize: "none"`).
 */
export interface ProgressiveConformerResult {
  embedded: Generate3DConformerResult;
  /** Run the (capped) force-field refinement on the same conformer. Call at most once. */
  refine?: () => Generate3DConformerResult;
}

export interface ConformerInput {
  /** A V2000 or V3000 molfile carrying the molecule's connectivity + drawn stereo. */
  molfile: string;
  /**
   * Optional expected heavy-atom count of the original drawing, used as a
   * consistency cross-check against what the engine parsed.
   */
  originalAtomCount?: number;
}

export interface ConformerGenerator3D {
  readonly engineName: ConformerEngineName;
  readonly canGenerate3DConformer: boolean;
  /** Lazily register engine static resources (idempotent). Browser engines may fetch. */
  init(): Promise<void> | void;
  generate3DConformer(
    input: ConformerInput,
    options?: Generate3DConformerOptions
  ): Promise<Generate3DConformerResult>;
}
