/**
 * RDKit (custom MinimalLib WASM) 3D conformer engine.
 *
 * Why this exists: OpenChemLib's `ConformerGenerator` embed is ~45 s on large rigid
 * polycyclic molecules (mode-independent, untunable). RDKit ETKDGv3 embeds the same
 * structures in ~1 s with faithful stereo (see docs/benchmarks/spin3d-rdkit-native-spike.md).
 *
 * The heavy embed runs in the custom WASM (see ../vendor/BUILD.md); this module is the
 * engine-neutral glue that turns the binding's plain-data JSON payload into the shared
 * `ProgressiveConformerResult` contract — identical in shape to the OpenChemLib adapter,
 * so the worker/client treat the two engines interchangeably.
 *
 * Lifecycle: no long-lived `JSMol` handle is kept. The embed captures a 3D molblock; each
 * refinement re-parses a pristine copy from it (engine atom order preserved), may split
 * its existing iteration budget across a few passes on that one transient copy, and then
 * deletes the handle. Every value that leaves this module is plain data
 * (structured-clone-safe across the worker boundary).
 */
import {
  defaultRefineForceField,
  parseV2000AtomBlock,
  type ChemistryWarning,
  type ConformerEngineName,
  type ConformerForceFieldReport,
  type ConformerGenerator3D,
  type ConformerInput,
  type ConformerRefineOptions,
  type Generate3DConformerOptions,
  type Generate3DConformerResult,
  type ProgressiveConformerResult
} from "@chemdraft/chemistry-adapter";

// --- injectable RDKit module ------------------------------------------------
// The real implementation loads the vendored RDKit_minimal.{js,wasm}; tests inject a
// mock that implements this same surface, so the contract is exercised without the binary.

/** A live RDKit molecule handle. Created per call and `delete()`d before the call returns. */
export interface RdkitJsMol {
  generate_3d_embed(detailsJson: string): string;
  optimize_3d_conformer(detailsJson: string): string;
  /** MinimalLib's built-in CoordGen/RDKit 2D coordinate generator. */
  set_new_coords?(useCoordGen?: boolean): boolean;
  /** Serialize the molecule, including generated 2D coordinates and stereo bonds. */
  get_molblock?(): string;
  /** Canonical isomeric SMILES, used by real-engine identity regression tests. */
  get_smiles?(): string;
  delete(): void;
}

export interface RdkitMinimalModule {
  /** Parse SMILES or a molblock. `detailsJson` carries e.g. `{ removeHs: false }`. */
  get_mol(structure: string, detailsJson?: string): RdkitJsMol | null;
  version?(): string;
}

export type RdkitModuleLoader = () => Promise<RdkitMinimalModule>;

let moduleLoader: RdkitModuleLoader | undefined;
let modulePromise: Promise<RdkitMinimalModule> | undefined;

/** Register how to load the RDKit WASM module (set once at app/worker boot, or in tests). */
export function setRdkitModuleLoader(loader: RdkitModuleLoader): void {
  moduleLoader = loader;
  modulePromise = undefined;
}

/** Resolve the RDKit module singleton (idempotent; retries after a failed load). */
export function ensureRdkit(): Promise<RdkitMinimalModule> {
  if (!moduleLoader) {
    return Promise.reject(new Error("RDKit module loader not set (call setRdkitModuleLoader)"));
  }
  if (!modulePromise) {
    modulePromise = moduleLoader().catch((error) => {
      modulePromise = undefined; // allow a later retry
      throw error;
    });
  }
  return modulePromise;
}

/** Test-only: drop the cached module + loader. */
export function resetRdkitForTesting(): void {
  moduleLoader = undefined;
  modulePromise = undefined;
}

interface DepictionCandidateMetrics {
  atomCount: number;
  bondCount: number;
  properCrossings: number;
  minimumNonbondedDistanceInBondLengths: number;
  horizontalAspectRatio: number;
}

function depictionCandidateMetrics(molfile: string): DepictionCandidateMetrics | undefined {
  const lines = molfile.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  if (countsIndex < 0) return undefined;
  const countsLine = lines[countsIndex] ?? "";
  const atomCount = Number.parseInt(countsLine.slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt(countsLine.slice(3, 6).trim(), 10);
  if (!Number.isInteger(atomCount) || atomCount < 1 || !Number.isInteger(bondCount) || bondCount < 1) {
    return undefined;
  }

  const atoms = lines.slice(countsIndex + 1, countsIndex + 1 + atomCount).map((line) => ({
    x: Number.parseFloat(line.slice(0, 10)),
    y: Number.parseFloat(line.slice(10, 20))
  }));
  const bonds = lines
    .slice(countsIndex + 1 + atomCount, countsIndex + 1 + atomCount + bondCount)
    .map((line) => ({
      from: Number.parseInt(line.slice(0, 3).trim(), 10) - 1,
      to: Number.parseInt(line.slice(3, 6).trim(), 10) - 1
    }));
  if (
    atoms.length !== atomCount || bonds.length !== bondCount ||
    atoms.some((atom) => !Number.isFinite(atom.x) || !Number.isFinite(atom.y)) ||
    bonds.some((bond) =>
      !Number.isInteger(bond.from) || !Number.isInteger(bond.to) ||
      bond.from < 0 || bond.to < 0 || bond.from >= atomCount || bond.to >= atomCount
    )
  ) {
    return undefined;
  }

  const lengths = bonds.map((bond) => {
    const from = atoms[bond.from]!;
    const to = atoms[bond.to]!;
    return Math.hypot(to.x - from.x, to.y - from.y);
  });
  const meanLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  if (!Number.isFinite(meanLength) || meanLength <= 0) return undefined;

  const bondedPairs = new Set(bonds.flatMap((bond) => [
    `${bond.from}:${bond.to}`,
    `${bond.to}:${bond.from}`
  ]));
  let minimumNonbondedDistance = Number.POSITIVE_INFINITY;
  for (let first = 0; first < atoms.length; first += 1) {
    for (let second = first + 1; second < atoms.length; second += 1) {
      if (bondedPairs.has(`${first}:${second}`)) continue;
      const left = atoms[first]!;
      const right = atoms[second]!;
      minimumNonbondedDistance = Math.min(
        minimumNonbondedDistance,
        Math.hypot(right.x - left.x, right.y - left.y)
      );
    }
  }

  const orientation = (first: number, second: number, third: number): number => {
    const a = atoms[first]!;
    const b = atoms[second]!;
    const c = atoms[third]!;
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  };
  let properCrossings = 0;
  for (let left = 0; left < bonds.length; left += 1) {
    for (let right = left + 1; right < bonds.length; right += 1) {
      const a = bonds[left]!;
      const b = bonds[right]!;
      if (new Set([a.from, a.to, b.from, b.to]).size < 4) continue;
      if (
        orientation(a.from, a.to, b.from) * orientation(a.from, a.to, b.to) < -1e-8 &&
        orientation(b.from, b.to, a.from) * orientation(b.from, b.to, a.to) < -1e-8
      ) {
        properCrossings += 1;
      }
    }
  }

  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    atomCount,
    bondCount,
    properCrossings,
    minimumNonbondedDistanceInBondLengths: minimumNonbondedDistance / meanLength,
    horizontalAspectRatio: height > 0 ? width / height : Number.POSITIVE_INFINITY
  };
}

function preferCoordGenDepiction(standardMolfile: string, coordGenMolfile: string): boolean {
  const standard = depictionCandidateMetrics(standardMolfile);
  const coordGen = depictionCandidateMetrics(coordGenMolfile);
  if (
    !standard || !coordGen ||
    standard.atomCount !== coordGen.atomCount || standard.bondCount !== coordGen.bondCount
  ) {
    return false;
  }

  if (coordGen.properCrossings !== standard.properCrossings) {
    return coordGen.properCrossings < standard.properCrossings &&
      coordGen.minimumNonbondedDistanceInBondLengths >= 0.6;
  }

  // Do not trade a clear atom overlap for a preferred orientation. This keeps the standard
  // drawer for compact bridged cages where CoordGen can place non-bonded atoms too close.
  if (
    coordGen.minimumNonbondedDistanceInBondLengths < 0.6 ||
    coordGen.minimumNonbondedDistanceInBondLengths + 0.1 <
      standard.minimumNonbondedDistanceInBondLengths
  ) {
    return false;
  }
  if (
    standard.minimumNonbondedDistanceInBondLengths + 0.1 <
      coordGen.minimumNonbondedDistanceInBondLengths
  ) {
    return true;
  }

  // When both candidates are equally clear, prefer the horizontal ring-train depiction. That
  // is the important distinction for the reported 63-atom polyether: 2.90:1 with CoordGen versus
  // a folded 0.75:1 standard result, with equal spacing and no crossings.
  return coordGen.horizontalAspectRatio > standard.horizontalAspectRatio + 0.2;
}

/**
 * Return canonical isomeric identity when MinimalLib exposes it.
 *
 * `undefined` means this loader does not expose `get_smiles` (the lightweight unit-test
 * mocks predate the 2D identity guard); `null` means the identity API exists but parsing
 * or canonicalization failed. Keeping those states distinct lets old mocks retain their
 * geometry-only fallback while a real-engine failure rejects the optional CoordGen candidate.
 */
function canonicalIsomericIdentity(
  rdkit: RdkitMinimalModule,
  structure: string
): string | null | undefined {
  let molecule: RdkitJsMol | null;
  try {
    molecule = rdkit.get_mol(structure);
  } catch {
    return null;
  }
  if (!molecule) return null;
  try {
    if (!molecule.get_smiles) return undefined;
    const identity = molecule.get_smiles();
    return typeof identity === "string" && identity.length > 0 ? identity : null;
  } catch {
    return null;
  } finally {
    molecule.delete();
  }
}

/**
 * Establish the source identity only after proving RDKit's standard serialized depiction
 * preserves it. A standard/source mismatch must escape `generateSmiles2DMolfile`: unlike an
 * optional bad CoordGen candidate, there is no safe RDKit fallback left, so the desktop caller
 * needs the rejection to invoke its OpenChemLib path.
 *
 * `undefined` is the deliberate mock fallback for injected MinimalLib surfaces that predate
 * canonical SMILES support.
 */
function validatedStandardIsomericIdentity(
  rdkit: RdkitMinimalModule,
  sourceSmiles: string,
  standardMolfile: string
): string | undefined {
  const sourceIdentity = canonicalIsomericIdentity(rdkit, sourceSmiles);
  if (sourceIdentity === undefined) return undefined;
  if (sourceIdentity === null) {
    throw new Error("RDKit could not verify the source SMILES isomeric identity.");
  }

  const standardIdentity = canonicalIsomericIdentity(rdkit, standardMolfile);
  if (standardIdentity !== sourceIdentity) {
    throw new Error("RDKit standard 2D depiction changed the source isomeric stereochemistry.");
  }
  return sourceIdentity;
}

/**
 * A CoordGen molfile is eligible only when reparsing it gives the already-validated source
 * identity. This catches lost as well as inverted tetrahedral/alkene stereo in the serialized
 * candidate rather than trusting the live generator molecule, whose internal chiral tags may
 * survive a bad wedge layout.
 */
function coordGenPreservesIsomericIdentity(
  rdkit: RdkitMinimalModule,
  sourceIdentity: string | undefined,
  coordGenMolfile: string
): boolean | undefined {
  if (sourceIdentity === undefined) return undefined;
  const coordGenIdentity = canonicalIsomericIdentity(rdkit, coordGenMolfile);
  return coordGenIdentity === sourceIdentity;
}

/**
 * Give elongated pasted SMILES a stable reading direction: the atom at which the SMILES starts
 * belongs on the left. CoordGen can otherwise emit the same wide depiction in either horizontal
 * orientation, which made the reported polyether read backwards relative to its input and the
 * reference drawing.
 *
 * A horizontal reflection reverses the planar handedness of tetrahedral centers, so every V2000
 * up/down stereo flag must be exchanged at the same time. The real-engine regression below reparses
 * the result and compares canonical isomeric SMILES; this is an appearance-only operation.
 */
function orientHorizontalDepictionFromSmilesStart(molfile: string): string {
  const lineEnding = molfile.includes("\r\n") ? "\r\n" : "\n";
  const lines = molfile.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  if (countsIndex < 0) return molfile;

  const countsLine = lines[countsIndex] ?? "";
  const atomCount = Number.parseInt(countsLine.slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt(countsLine.slice(3, 6).trim(), 10);
  if (!Number.isInteger(atomCount) || atomCount < 2 || !Number.isInteger(bondCount) || bondCount < 1) {
    return molfile;
  }

  const atomStart = countsIndex + 1;
  const atomLines = lines.slice(atomStart, atomStart + atomCount);
  const atoms = atomLines.map((line) => ({
    x: Number.parseFloat(line.slice(0, 10)),
    y: Number.parseFloat(line.slice(10, 20))
  }));
  if (atoms.some((atom) => !Number.isFinite(atom.x) || !Number.isFinite(atom.y))) return molfile;

  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const width = maxX - minX;
  const height = Math.max(...ys) - Math.min(...ys);
  const firstAtom = atoms[0]!;
  const midpointX = (minX + maxX) / 2;

  // Compact and near-symmetric depictions do not have a useful left-to-right reading direction.
  if (width <= height * 1.5 || firstAtom.x <= midpointX + width * 0.02) return molfile;

  const reflected = [...lines];
  for (let index = 0; index < atomCount; index += 1) {
    const line = atomLines[index]!;
    const reflectedX = minX + maxX - atoms[index]!.x;
    reflected[atomStart + index] = `${reflectedX.toFixed(4).padStart(10)}${line.slice(10)}`;
  }

  const bondStart = atomStart + atomCount;
  for (let index = 0; index < bondCount; index += 1) {
    const line = lines[bondStart + index];
    if (!line) return molfile;
    const stereo = Number.parseInt(line.slice(9, 12).trim(), 10) || 0;
    const reflectedStereo = stereo === 1 ? 6 : stereo === 6 ? 1 : stereo;
    if (reflectedStereo !== stereo) {
      reflected[bondStart + index] = `${line.slice(0, 9)}${String(reflectedStereo).padStart(3)}${line.slice(12)}`;
    }
  }
  return reflected.join(lineEnding);
}

function identityCheckedHorizontalOrientation(
  rdkit: RdkitMinimalModule,
  sourceIdentity: string | undefined,
  molfile: string
): string {
  const oriented = orientHorizontalDepictionFromSmilesStart(molfile);
  if (oriented === molfile || sourceIdentity === undefined) return oriented;
  // Reflection is appearance-only only if reparsing proves the same isomer. Keep the already
  // validated unreflected candidate if an unfamiliar molfile stereo encoding cannot be mirrored
  // safely by the V2000 up/down swap above.
  return canonicalIsomericIdentity(rdkit, oriented) === sourceIdentity ? oriented : molfile;
}

function generated2DMolfile(
  rdkit: RdkitMinimalModule,
  smiles: string,
  useCoordGen: boolean
): string {
  const molecule = rdkit.get_mol(smiles);
  if (!molecule) {
    throw new Error("RDKit could not parse the pasted SMILES.");
  }
  try {
    if (!molecule.set_new_coords || !molecule.get_molblock) {
      throw new Error("The bundled RDKit engine does not expose 2D coordinate generation.");
    }
    if (!molecule.set_new_coords(useCoordGen)) {
      throw new Error("RDKit could not generate 2D coordinates for the pasted SMILES.");
    }
    const molfile = molecule.get_molblock();
    if (!molfile.includes("M  END")) {
      throw new Error("RDKit returned an invalid 2D molfile.");
    }
    return molfile;
  } finally {
    molecule.delete();
  }
}

/**
 * Generate depiction-grade 2D coordinates for a SMILES with the already bundled RDKit
 * MinimalLib. The module remains lazy: callers register its loader and invoke this only after
 * the user pastes a SMILES. Returning a molfile lets the existing, tested molfile parser own
 * atom/bond extraction and wedge direction semantics.
 */
export async function generateSmiles2DMolfile(smiles: string): Promise<string> {
  const rdkit = await ensureRdkit();
  const standardMolfile = generated2DMolfile(rdkit, smiles, false);
  // Keep this outside the optional CoordGen try/catch. If RDKit's baseline depiction has already
  // changed stereo, returning it would suppress the caller's safer OpenChemLib fallback.
  const sourceIdentity = validatedStandardIsomericIdentity(rdkit, smiles, standardMolfile);
  try {
    const coordGenMolfile = generated2DMolfile(rdkit, smiles, true);
    const preservesIsomericIdentity = coordGenPreservesIsomericIdentity(
      rdkit,
      sourceIdentity,
      coordGenMolfile
    );
    const selectedMolfile = preservesIsomericIdentity !== false &&
      preferCoordGenDepiction(standardMolfile, coordGenMolfile)
      ? coordGenMolfile
      : standardMolfile;
    return identityCheckedHorizontalOrientation(rdkit, sourceIdentity, selectedMolfile);
  } catch {
    // The standard depiction is already valid. CoordGen is a readability candidate, not a
    // prerequisite, so a missing/failed optional candidate must not reject the SMILES paste.
    return identityCheckedHorizontalOrientation(rdkit, sourceIdentity, standardMolfile);
  }
}

// --- binding payloads (see ../vendor/BUILD.md) ------------------------------

interface EmbedPayload {
  embedOk: boolean;
  coords3dByEngineAtom: number[];
  engineToOriginalAtom: number[];
  generatedHydrogenEngineAtoms: number[];
  molblock: string;
}

interface OptimizePayload {
  embedOk: boolean;
  coords3dByEngineAtom: number[];
  forceField?: { name: string; status: string; energy?: number; iterations?: number };
}

const ENGINE: ConformerEngineName = "rdkit-wasm";
const DEFAULT_EMBED_TIMEOUT_SECONDS = 10;
// At/above this heavy-atom count, a failed ETKDG embed is retried with random starting
// coordinates: ETKDG's default (eigenvalue-decomposition) start fails on large, highly
// flexible molecules (e.g. long peptides) that random coords embeds successfully.
const RANDOM_COORDS_RETRY_MIN_ATOMS = 50;

// Best-of-K initial embedding bounds (Spin 3D appearance policy, Slice B). The extra cost is
// K embeds + K short MMFF scores, incurred only at generation time when a caller requests
// candidates (`embedCandidates > 1`) — never on a tug rebuild, which leaves it unset.
const MULTI_EMBED_MAX_CANDIDATES = 6; // hard ceiling on K regardless of the request
const MULTI_EMBED_TAPER_ATOMS = 60; // above this, halve K to bound large-molecule latency
const MULTI_EMBED_MAX_ATOMS = 120; // above this, skip best-of-K entirely (single embed)
const CANDIDATE_SCORE_ITERATIONS = 50; // short MMFF pass, just enough to rank candidates
const DEFAULT_MULTI_EMBED_SEED = 42; // deterministic base when no seed is supplied

type RefineForceField = NonNullable<ConformerRefineOptions["forceField"]>;

function refineForceFieldFor(
  optimize: Generate3DConformerOptions["optimize"],
  override: ConformerRefineOptions["forceField"]
): RefineForceField {
  // A per-refine override wins; otherwise fall back to the shared embed-time default
  // (kept in the contract package so the worker's cache key and this engine can't drift).
  return override ?? defaultRefineForceField(optimize);
}

function reportNameFor(forceField: RefineForceField): ConformerForceFieldReport["name"] {
  if (forceField === "uff") return "UFF";
  if (forceField === "mmff94s") return "MMFF94s";
  return "MMFF94";
}

function reportStatusFor(status: string | undefined): ConformerForceFieldReport["status"] {
  if (status === "converged" || status === "not-converged" || status === "setup-failed") return status;
  return "not-run";
}

const MAX_FOCUSED_REFINEMENT_PASSES = 3;
const PRIMARY_REFINEMENT_BUDGET_FRACTION = 0.8;

/**
 * Preserve the caller's total cap while reserving a small residual budget for continuation.
 * An absent cap keeps the historical single engine-default pass.
 */
function focusedRefinementBudgets(maxIterations: number | undefined): Array<number | undefined> {
  if (maxIterations === undefined || !Number.isFinite(maxIterations) || maxIterations <= 0) {
    return [maxIterations];
  }

  const total = Math.max(1, Math.floor(maxIterations));
  if (total === 1) return [1];

  const primary = Math.max(1, Math.floor(total * PRIMARY_REFINEMENT_BUDGET_FRACTION));
  const residual = total - primary;
  if (residual <= 0) return [total];

  const second = Math.ceil(residual / 2);
  const third = residual - second;
  return [primary, second, third].filter((budget) => budget > 0).slice(0, MAX_FOCUSED_REFINEMENT_PASSES);
}

/**
 * Resolve a requested best-of-K candidate count to an effective count, tapered by molecule
 * size so large structures don't pay the full multi-embed cost. Returns 1 to disable best-of-K
 * (single embed): for a request of 1 or less, a non-positive/unknown atom count, or a molecule
 * above the hard atom cap.
 */
function effectiveCandidateCount(requested: number, atomCount: number): number {
  if (!Number.isFinite(requested) || requested <= 1) return 1;
  if (atomCount <= 0 || atomCount > MULTI_EMBED_MAX_ATOMS) return 1;
  const capped = Math.min(Math.floor(requested), MULTI_EMBED_MAX_CANDIDATES);
  return atomCount > MULTI_EMBED_TAPER_ATOMS ? Math.min(capped, 2) : capped;
}

function isValidOptimizePayload(candidate: unknown, expectedCoordinateCount: number): candidate is OptimizePayload {
  if (typeof candidate !== "object" || candidate === null) return false;
  const payload = candidate as Partial<OptimizePayload>;
  return (
    payload.embedOk === true &&
    Array.isArray(payload.coords3dByEngineAtom) &&
    payload.coords3dByEngineAtom.length === expectedCoordinateCount &&
    payload.coords3dByEngineAtom.every(
      (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)
    )
  );
}

/** Scatter engine-order coordinates onto original atoms via the engine→original map. */
function scatterToOriginal(
  engineCoords: number[],
  engineToOriginalAtom: number[],
  originalAtomCount: number
): Float64Array {
  const out = new Float64Array(originalAtomCount * 3);
  for (let engineIdx = 0; engineIdx < engineToOriginalAtom.length; engineIdx++) {
    const originalIdx = engineToOriginalAtom[engineIdx];
    if (originalIdx < 0) continue;
    out[originalIdx * 3] = engineCoords[engineIdx * 3];
    out[originalIdx * 3 + 1] = engineCoords[engineIdx * 3 + 1];
    out[originalIdx * 3 + 2] = engineCoords[engineIdx * 3 + 2];
  }
  return out;
}

function originalAtomCountFrom(engineToOriginalAtom: number[], expected?: number): number {
  let max = -1;
  for (const original of engineToOriginalAtom) {
    if (original > max) max = original;
  }
  const derived = max + 1;
  return expected !== undefined && expected > derived ? expected : derived;
}

function invertMapping(engineToOriginalAtom: number[], originalAtomCount: number): number[] {
  const originalToEngineAtom = new Array<number>(originalAtomCount).fill(-1);
  engineToOriginalAtom.forEach((original, engineIdx) => {
    if (original >= 0) originalToEngineAtom[original] = engineIdx;
  });
  return originalToEngineAtom;
}

function explicitInputHydrogenCount(molfile: string, originalAtomCount: number): number {
  const atoms = parseV2000AtomBlock(molfile);
  if (!atoms) return 0;
  let count = 0;
  for (let i = 0; i < Math.min(atoms.length, originalAtomCount); i++) {
    if (atoms[i].element === "H") count += 1;
  }
  return count;
}

function failedEmbed(input: ConformerInput, reason: string, version: string): ProgressiveConformerResult {
  const originalAtomCount = input.originalAtomCount ?? 0;
  return {
    embedded: {
      mapping: {
        coords3dByOriginalAtom: new Float64Array(originalAtomCount * 3),
        originalToEngineAtom: new Array<number>(originalAtomCount).fill(-1),
        engineToOriginalAtom: [],
        generatedHydrogenEngineAtoms: []
      },
      originalAtomCount,
      generatedAtomCount: 0,
      hydrogens: { added: false, explicitInputHydrogensPreserved: false },
      engine: { name: ENGINE, version, parameters: {} },
      embed: { status: "failed", failureReason: reason },
      unsupportedFeatures: [],
      warnings: []
    }
  };
}

/**
 * Embed a 3D conformer with RDKit ETKDGv3, returning the usable embedded conformer
 * immediately plus a re-runnable `refineFromEmbedded` (MMFF94/MMFF94s/UFF) that derives
 * each refinement mode from the one pristine embed.
 */
export async function generate3DConformerProgressive(
  input: ConformerInput,
  options: Generate3DConformerOptions = {}
): Promise<ProgressiveConformerResult> {
  const rdkit = await ensureRdkit();
  const version = rdkit.version?.() ?? "unknown";

  // One embed attempt with a fresh, transient mol handle (the embed adds Hs + mutates it).
  // A binding throw / malformed JSON surfaces as a graceful failed embed (so the worker can
  // fall back) rather than rejecting the whole promise.
  type EmbedAttempt =
    | { kind: "parse-failed" }
    | { kind: "error"; message: string }
    | { kind: "payload"; payload: EmbedPayload };
  const attemptEmbed = (useRandomCoords: boolean, seed: number = options.seed ?? -1): EmbedAttempt => {
    const mol = rdkit.get_mol(input.molfile, JSON.stringify({ removeHs: false }));
    if (!mol) return { kind: "parse-failed" };
    try {
      const json = mol.generate_3d_embed(
        JSON.stringify({ seed, timeoutSeconds: DEFAULT_EMBED_TIMEOUT_SECONDS, useRandomCoords })
      );
      return { kind: "payload", payload: JSON.parse(json) as EmbedPayload };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      mol.delete(); // plain-data payload captured; never hold a WASM handle across calls
    }
  };

  // Best-of-K initial embedding (Slice B): score a deformation-free candidate by a short MMFF
  // relaxation and keep the lowest-energy (most relaxed) embed, so an unlucky single ETKDG draw
  // never ships. Scoring runs on a throwaway transient mol; only the winning embed flows
  // downstream, so the refine/tug contract is unchanged. Single-candidate callers skip all of it.
  const scoreEmbed = (candidate: EmbedPayload, forceField: RefineForceField): number | undefined => {
    const work = rdkit.get_mol(candidate.molblock, JSON.stringify({ removeHs: false }));
    if (!work) return undefined;
    try {
      const parsed: unknown = JSON.parse(
        work.optimize_3d_conformer(JSON.stringify({ forceField, maxIters: CANDIDATE_SCORE_ITERATIONS }))
      );
      if (!isValidOptimizePayload(parsed, candidate.coords3dByEngineAtom.length)) return undefined;
      const energy = parsed.forceField?.energy;
      return typeof energy === "number" && Number.isFinite(energy) ? energy : undefined;
    } catch {
      return undefined;
    } finally {
      work.delete();
    }
  };

  const selectBestEmbed = (baseline: EmbedPayload): EmbedPayload => {
    const candidateCount = effectiveCandidateCount(options.embedCandidates ?? 1, input.originalAtomCount ?? 0);
    if (candidateCount <= 1) return baseline;
    const forceField = refineForceFieldFor(options.optimize, undefined);
    const baseSeed = options.seed ?? DEFAULT_MULTI_EMBED_SEED;
    let best = baseline;
    let bestEnergy = scoreEmbed(baseline, forceField);
    // Candidate seeds are baseSeed+1.. so they never collide with the baseline (baseSeed),
    // and the winner is reproducible for a given molfile + seed + candidate count.
    for (let candidate = 1; candidate < candidateCount; candidate += 1) {
      const next = attemptEmbed(false, baseSeed + candidate);
      if (next.kind !== "payload" || !next.payload.embedOk) continue;
      const energy = scoreEmbed(next.payload, forceField);
      if (energy === undefined) continue;
      if (bestEnergy === undefined || energy < bestEnergy) {
        best = next.payload;
        bestEnergy = energy;
      }
    }
    return best;
  };

  // Best-of-K uses deterministic candidate seeds multiEmbedBaseSeed+0.. When the caller asked for
  // multiple candidates but supplied no explicit seed, seed the baseline deterministically too, so
  // the baseline is a candidate on equal footing and the winner is reproducible for a given
  // molfile + candidate count (a `?? -1` baseline would draw a different, random conformer each run).
  const embedCandidateCount = effectiveCandidateCount(options.embedCandidates ?? 1, input.originalAtomCount ?? 0);
  const multiEmbedBaseSeed = options.seed ?? DEFAULT_MULTI_EMBED_SEED;
  const baselineSeed = options.seed ?? (embedCandidateCount > 1 ? multiEmbedBaseSeed : -1);
  let attempt = attemptEmbed(false, baselineSeed);
  if (attempt.kind === "parse-failed") {
    return failedEmbed(input, "RDKit could not parse the molfile", version);
  }
  // Retry a failed/empty embed of a large structure with random starting coordinates — the
  // standard ETKDG remedy for big, flexible molecules (long peptides). NOTE: this takes
  // effect only once the vendored WASM is rebuilt to honour `useRandomCoords` (see
  // vendor/BUILD.md); the currently shipped binding ignores the flag, so the worker's OCL
  // fallback is what actually rescues such structures today.
  const embedFailed = attempt.kind === "error" || !attempt.payload.embedOk;
  if (embedFailed && (input.originalAtomCount ?? 0) >= RANDOM_COORDS_RETRY_MIN_ATOMS) {
    const retry = attemptEmbed(true);
    if (retry.kind === "payload" && retry.payload.embedOk) attempt = retry;
  }
  // Best-of-K rescue: if the baseline seed failed to embed, a later deterministic candidate seed
  // may still succeed. Try them before giving up, so one unlucky baseline draw does not fail a
  // request that asked for several candidates.
  if (
    (attempt.kind === "error" || (attempt.kind === "payload" && !attempt.payload.embedOk)) &&
    embedCandidateCount > 1
  ) {
    for (let candidate = 1; candidate < embedCandidateCount; candidate += 1) {
      const rescue = attemptEmbed(false, multiEmbedBaseSeed + candidate);
      if (rescue.kind === "payload" && rescue.payload.embedOk) {
        attempt = rescue;
        break;
      }
    }
  }
  if (attempt.kind === "error") {
    return failedEmbed(input, `RDKit embed failed: ${attempt.message}`, version);
  }
  if (!attempt.payload.embedOk) {
    return failedEmbed(input, "RDKit ETKDG embedding found no conformer (or timed out)", version);
  }
  // Optionally upgrade the baseline embed to the best of several deterministic candidates.
  const payload = selectBestEmbed(attempt.payload);

  const engineToOriginalAtom = payload.engineToOriginalAtom;
  const originalAtomCount = originalAtomCountFrom(engineToOriginalAtom, input.originalAtomCount);
  const originalToEngineAtom = invertMapping(engineToOriginalAtom, originalAtomCount);
  const generatedHydrogenEngineAtoms = payload.generatedHydrogenEngineAtoms;
  const explicitInputHydrogens = explicitInputHydrogenCount(input.molfile, originalAtomCount);

  // Warn (rather than silently placing the atom at the origin) when an original atom never
  // mapped to an engine atom — parity with the OCL adapter's ocl.unmapped-original-atoms.
  const embedWarnings: ChemistryWarning[] = [];
  const unmapped = originalToEngineAtom.reduce((count, engineIdx) => (engineIdx < 0 ? count + 1 : count), 0);
  if (unmapped > 0) {
    embedWarnings.push({
      code: "rdkit.unmapped-original-atoms",
      message: `${unmapped} original atom(s) were not located in the RDKit conformer; they default to the origin.`,
      severity: "error"
    });
  }

  const buildResult = (
    coords3dByOriginalAtom: Float64Array,
    forceField: ConformerForceFieldReport
  ): Generate3DConformerResult => ({
    mapping: {
      coords3dByOriginalAtom,
      originalToEngineAtom: [...originalToEngineAtom],
      engineToOriginalAtom: [...engineToOriginalAtom],
      generatedHydrogenEngineAtoms: [...generatedHydrogenEngineAtoms]
    },
    originalAtomCount,
    generatedAtomCount: generatedHydrogenEngineAtoms.length,
    hydrogens: {
      added: generatedHydrogenEngineAtoms.length > 0,
      explicitInputHydrogensPreserved: explicitInputHydrogens > 0
    },
    engine: {
      name: ENGINE,
      version,
      parameters: { seed: options.seed ?? -1, embed: "etkdgv3" }
    },
    embed: { status: "ok" },
    forceField,
    unsupportedFeatures: [],
    warnings: [...embedWarnings]
  });

  const embeddedCoords = scatterToOriginal(payload.coords3dByEngineAtom, engineToOriginalAtom, originalAtomCount);
  const embedded = buildResult(embeddedCoords, { name: "none", status: "not-run" });

  if (options.optimize === "none") {
    return { embedded };
  }

  const embeddedMolblock = payload.molblock;
  // Each public refinement starts from the pristine embed. RDKit may reserve part of the
  // same total iteration budget for up to two focused continuation passes on this ONE
  // transient conformer. Cross-call state is never reused.
  const refineFromEmbedded = (maxIts?: number, refineOptions?: ConformerRefineOptions): Generate3DConformerResult => {
    const forceField = refineForceFieldFor(options.optimize, refineOptions?.forceField);
    const work = rdkit.get_mol(embeddedMolblock, JSON.stringify({ removeHs: false }));
    if (!work) {
      return buildResult(Float64Array.from(embeddedCoords), { name: reportNameFor(forceField), status: "setup-failed" });
    }

    const expectedCoordinateCount = payload.coords3dByEngineAtom.length;
    const passBudgets = focusedRefinementBudgets(maxIts ?? options.maxMinimiseIterations);
    let optimized: OptimizePayload | undefined;
    let totalIterations: number | undefined = 0;
    try {
      for (const passBudget of passBudgets) {
        let candidate: unknown;
        try {
          candidate = JSON.parse(
            work.optimize_3d_conformer(JSON.stringify({ forceField, maxIters: passBudget }))
          );
        } catch {
          break; // retain the last valid pass; no valid pass falls back to the embed below
        }

        // Reject failed, reordered, truncated, null, NaN, or infinite coordinate payloads.
        // A bad later pass must not discard coordinates from an earlier valid pass.
        if (!isValidOptimizePayload(candidate, expectedCoordinateCount)) break;

        optimized = candidate;
        const passIterations = candidate.forceField?.iterations;
        if (totalIterations !== undefined) {
          totalIterations =
            typeof passIterations === "number" && Number.isFinite(passIterations) && passIterations >= 0
              ? totalIterations + passIterations
              : undefined;
        }

        if (reportStatusFor(candidate.forceField?.status) !== "not-converged") break;
      }
    } finally {
      work.delete();
    }

    if (!optimized) {
      return buildResult(Float64Array.from(embeddedCoords), { name: reportNameFor(forceField), status: "setup-failed" });
    }

    const refinedCoords = scatterToOriginal(optimized.coords3dByEngineAtom, engineToOriginalAtom, originalAtomCount);
    return buildResult(refinedCoords, {
      name: reportNameFor(forceField),
      status: reportStatusFor(optimized.forceField?.status),
      energy: optimized.forceField?.energy,
      iterations: totalIterations
    });
  };

  return { embedded, refineFromEmbedded };
}

/** `ConformerGenerator3D` facade (parity with `oclConformerGenerator`). */
export const rdkitConformerGenerator: ConformerGenerator3D = {
  engineName: ENGINE,
  canGenerate3DConformer: true,
  async init(): Promise<void> {
    await ensureRdkit();
  },
  async generate3DConformer(
    input: ConformerInput,
    options: Generate3DConformerOptions = {}
  ): Promise<Generate3DConformerResult> {
    const { embedded, refineFromEmbedded } = await generate3DConformerProgressive(input, options);
    return refineFromEmbedded ? refineFromEmbedded() : embedded;
  }
};
