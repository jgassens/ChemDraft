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
  /** MMFF94 family is OpenChemLib (in-process); UFF/GAFF/Ghemical come from the
   *  OpenBabel sidecar (Phase 3). */
  name: "MMFF94" | "MMFF94s" | "UFF" | "GAFF" | "Ghemical" | "none";
  /** `"unsupported"` = the requested engine/force field is unavailable (e.g. the
   *  OpenBabel binary is absent, or it changed the structure during minimisation). */
  status: "not-run" | "converged" | "not-converged" | "setup-failed" | "unsupported";
  returnCode?: number;
  energy?: number;
  /** Total engine-reported iterations across all passes in this public refinement call. */
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
   * Total force-field minimisation iteration budget for one public refinement call
   * (default: the engine's full run). An adapter may divide a finite budget across a
   * small number of continuation passes, but the requested total must remain bounded
   * by this value. Depiction-grade geometry usually reaches the useful energy well
   * before the engine default, so the budget bounds worst-case work on large molecules.
   */
  maxMinimiseIterations?: number;
  /** v1 invariant: specified stereo is preserved. */
  preserveSpecifiedStereo?: boolean;
  /** v1 invariant: never invent unspecified stereo. */
  allowInventStereo?: boolean;
}

/**
 * Per-refinement overrides. The force field is chosen here (not at embed time) so a
 * single embedded conformer can be polished under different force fields — e.g. the
 * worker derives MMFF94 and UFF modes from one embed. Engines that expose only one
 * force field (OpenChemLib = MMFF94) ignore `forceField`.
 */
export interface ConformerRefineOptions {
  forceField?: "mmff94" | "mmff94s" | "uff";
}

/**
 * Default refinement force field for an embed-time `optimize` choice: UFF only when the
 * user explicitly asked for it, MMFF94 otherwise. Shared by the conformer worker (which
 * keys its per-mode cache on the force field) and the RDKit adapter (which runs it), so
 * the two can never drift. A per-refine `ConformerRefineOptions.forceField` override takes
 * precedence over this default at the engine.
 */
export function defaultRefineForceField(
  optimize: Generate3DConformerOptions["optimize"]
): NonNullable<ConformerRefineOptions["forceField"]> {
  return optimize === "uff" ? "uff" : "mmff94";
}

/**
 * Two-stage conformer delivery for latency-sensitive UI: the embedded conformer is
 * usable (collision-free, parities respected) the moment it exists; force-field
 * refinement is strictly cosmetic polish and can land later. `refineFromEmbedded`
 * is absent when the embed failed or refinement was disabled (`optimize: "none"`).
 */
export interface ProgressiveConformerResult {
  embedded: Generate3DConformerResult;
  /**
   * Run force-field refinement starting from the *embedded* coordinates, reading
   * back the result. With no argument, runs the full `maxMinimiseIterations`-capped
   * minimisation; pass `maxIts` to cap a run to that many steps, and `options` to pick
   * the force field (engines with a single force field ignore it).
   *
   * RE-RUNNABLE FROM EMBED: every public call starts from the pristine embedded
   * coordinates. An engine may split that call's total iteration budget into a small
   * number of focused passes on one private transient conformer, but it must never
   * continue from a previous public call. Re-minimising a previously returned geometry
   * can warp structures such as aromatic rings. Calls therefore remain independent and
   * reproducible (same args ⇒ same geometry). Callers that want to avoid recomputation
   * should memoise per mode themselves.
   * `forceField.returnCode === 0` means the in-process field converged. Absent when the
   * embed failed or `optimize: "none"`.
   */
  refineFromEmbedded?: (maxIts?: number, options?: ConformerRefineOptions) => Generate3DConformerResult;
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

// ---------------------------------------------------------------------------
// External (sidecar) refinement round-trip — OpenBabel UFF/GAFF/Ghemical (Phase 3)
//
// The embed + atom mapping stay with the in-process engine (OpenChemLib): we serialise
// the embedded conformer to a molfile, hand it to the sidecar to MINIMISE only, then map
// the returned coordinates back by engine-atom index. This is engine-neutral and pure, so
// it lives in the contract package and is fully unit-testable without any binary.
// ---------------------------------------------------------------------------

export interface ParsedMolfileAtom {
  element: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Parse a V2000 molfile's atom block by fixed columns (the spec layout both OpenChemLib
 * and OpenBabel emit): x/y/z in three 10-char fields, the atom symbol at columns 32–34.
 * Returns `null` if the molfile is not well-formed V2000 (missing counts/atom lines,
 * non-numeric coordinates, or an empty element) so callers can reject rather than guess.
 */
export function parseV2000AtomBlock(molfile: string): ParsedMolfileAtom[] | null {
  const lines = molfile.split(/\r?\n/);
  // Header is 3 lines (title, program, comment); the counts line is the 4th.
  if (lines.length < 4) return null;
  const atomCount = Number.parseInt(lines[3].slice(0, 3), 10);
  if (!Number.isInteger(atomCount) || atomCount < 0) return null;
  if (lines.length < 4 + atomCount) return null;

  const atoms: ParsedMolfileAtom[] = [];
  for (let i = 0; i < atomCount; i++) {
    const line = lines[4 + i];
    if (line.length < 34) return null;
    const x = Number.parseFloat(line.slice(0, 10));
    const y = Number.parseFloat(line.slice(10, 20));
    const z = Number.parseFloat(line.slice(20, 30));
    const element = line.slice(31, 34).trim();
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || element.length === 0) {
      return null;
    }
    atoms.push({ element, x, y, z });
  }
  return atoms;
}

export interface ExternalForceFieldReport {
  /** Force field the sidecar used, e.g. "UFF" / "GAFF" / "Ghemical". */
  name: ConformerForceFieldReport["name"];
  /** Convergence as reported by the sidecar. */
  status: "converged" | "not-converged";
  returnCode?: number;
  energy?: number;
  iterations?: number;
}

export type ApplyExternalMinimizeOutcome =
  | { status: "ok"; result: Generate3DConformerResult }
  | { status: "rejected"; reason: string };

/**
 * Map a sidecar-minimised molfile's coordinates back onto the embedded conformer.
 *
 * SAFETY (do not silently corrupt geometry): the minimised structure is accepted ONLY if
 * its atom COUNT and ELEMENT SEQUENCE match the embedded molfile exactly (the molfile we
 * sent to the sidecar). OpenBabel makes hydrogens explicit before minimising, so an OCL
 * molfile that already carries all explicit H should round-trip unchanged — but if it does
 * not, we reject and let the caller fall back to the in-process force field rather than
 * scatter coordinates against a reordered atom list. Coordinates are mapped by engine-atom
 * index (the molfile's atom order == the embedded engine order) through
 * `embedded.mapping.engineToOriginalAtom`.
 */
export function applyExternalMinimizedMolfile(
  embedded: Generate3DConformerResult,
  embeddedMolfile: string,
  minimizedMolfile: string,
  report: ExternalForceFieldReport
): ApplyExternalMinimizeOutcome {
  const embeddedAtoms = parseV2000AtomBlock(embeddedMolfile);
  const minimizedAtoms = parseV2000AtomBlock(minimizedMolfile);
  if (!embeddedAtoms) return { status: "rejected", reason: "embedded molfile is not valid V2000" };
  if (!minimizedAtoms) return { status: "rejected", reason: "minimised molfile is not valid V2000" };

  const engineCount = embedded.mapping.engineToOriginalAtom.length;
  if (embeddedAtoms.length !== engineCount) {
    return { status: "rejected", reason: `embedded molfile has ${embeddedAtoms.length} atoms but the mapping has ${engineCount}` };
  }
  if (minimizedAtoms.length !== embeddedAtoms.length) {
    return { status: "rejected", reason: `sidecar changed the atom count (${embeddedAtoms.length} → ${minimizedAtoms.length})` };
  }
  for (let i = 0; i < minimizedAtoms.length; i++) {
    if (minimizedAtoms[i].element !== embeddedAtoms[i].element) {
      return { status: "rejected", reason: `sidecar changed atom order at index ${i} (${embeddedAtoms[i].element} → ${minimizedAtoms[i].element})` };
    }
  }

  const coords = Float64Array.from(embedded.mapping.coords3dByOriginalAtom);
  for (let engineIdx = 0; engineIdx < minimizedAtoms.length; engineIdx++) {
    const originalIdx = embedded.mapping.engineToOriginalAtom[engineIdx];
    if (originalIdx < 0) continue; // sidecar-side generated/extra atom — not an original
    const atom = minimizedAtoms[engineIdx];
    coords[originalIdx * 3] = atom.x;
    coords[originalIdx * 3 + 1] = atom.y;
    coords[originalIdx * 3 + 2] = atom.z;
  }

  return {
    status: "ok",
    result: {
      ...embedded,
      mapping: { ...embedded.mapping, coords3dByOriginalAtom: coords },
      forceField: {
        name: report.name,
        status: report.status,
        returnCode: report.returnCode,
        energy: report.energy,
        iterations: report.iterations
      },
      unsupportedFeatures: [...embedded.unsupportedFeatures],
      warnings: [...embedded.warnings]
    }
  };
}
