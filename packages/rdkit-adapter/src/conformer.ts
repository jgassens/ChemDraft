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
  delete(): void;
}

export interface RdkitMinimalModule {
  /** Parse a molblock. `detailsJson` carries e.g. `{ removeHs: false }`. Returns null on failure. */
  get_mol(molblock: string, detailsJson?: string): RdkitJsMol | null;
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


function isFiniteCoordinateArray(values: unknown, expectedLength: number): values is ArrayLike<number> {
  if (values === null || values === undefined) return false;
  const arrayLike = values as ArrayLike<unknown>;
  if (arrayLike.length !== expectedLength) return false;
  for (let index = 0; index < expectedLength; index += 1) {
    const value = arrayLike[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  return true;
}

interface DeformedMolblock {
  molblock: string;
  engineCoords: number[];
}

function deformedV2000Molblock(
  embeddedMolblock: string,
  embeddedEngineCoords: readonly number[],
  originalToEngineAtom: readonly number[],
  engineToOriginalAtom: readonly number[],
  requestedOriginalCoords: ArrayLike<number>
): DeformedMolblock | undefined {
  if (!isFiniteCoordinateArray(requestedOriginalCoords, originalToEngineAtom.length * 3)) return undefined;
  const lines = embeddedMolblock.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => line.includes("V2000"));
  if (countsIndex < 0) return undefined;
  const atomCount = Number.parseInt(lines[countsIndex].slice(0, 3), 10);
  const bondCount = Number.parseInt(lines[countsIndex].slice(3, 6), 10);
  if (!Number.isInteger(atomCount) || !Number.isInteger(bondCount) || atomCount < 1 || bondCount < 0) return undefined;
  if (embeddedEngineCoords.length !== atomCount * 3 || engineToOriginalAtom.length !== atomCount) return undefined;
  const atomStart = countsIndex + 1;
  const bondStart = atomStart + atomCount;
  if (lines.length < bondStart + bondCount) return undefined;

  const engineCoords = [...embeddedEngineCoords];
  const deltas = Array.from({ length: originalToEngineAtom.length }, (): [number, number, number] => [0, 0, 0]);
  for (let original = 0; original < originalToEngineAtom.length; original += 1) {
    const engine = originalToEngineAtom[original];
    if (engine < 0 || engine >= atomCount) return undefined;
    const nx = requestedOriginalCoords[original * 3];
    const ny = requestedOriginalCoords[original * 3 + 1];
    const nz = requestedOriginalCoords[original * 3 + 2];
    deltas[original] = [
      nx - engineCoords[engine * 3],
      ny - engineCoords[engine * 3 + 1],
      nz - engineCoords[engine * 3 + 2]
    ];
    engineCoords[engine * 3] = nx;
    engineCoords[engine * 3 + 1] = ny;
    engineCoords[engine * 3 + 2] = nz;
  }

  // Carry each directly attached generated H/extra atom with the visible atom that was tugged.
  // This avoids beginning MMFF/UFF with catastrophically stretched hidden X-H bonds.
  for (let bondOffset = 0; bondOffset < bondCount; bondOffset += 1) {
    const line = lines[bondStart + bondOffset];
    const a = Number.parseInt(line.slice(0, 3), 10) - 1;
    const b = Number.parseInt(line.slice(3, 6), 10) - 1;
    if (a < 0 || b < 0 || a >= atomCount || b >= atomCount) continue;
    const originalA = engineToOriginalAtom[a];
    const originalB = engineToOriginalAtom[b];
    const generated = originalA < 0 ? a : originalB < 0 ? b : -1;
    const original = originalA >= 0 ? originalA : originalB >= 0 ? originalB : -1;
    if (generated < 0 || original < 0) continue;
    const [dx, dy, dz] = deltas[original];
    engineCoords[generated * 3] += dx;
    engineCoords[generated * 3 + 1] += dy;
    engineCoords[generated * 3 + 2] += dz;
  }

  const field = (value: number) => value.toFixed(4).padStart(10);
  for (let engine = 0; engine < atomCount; engine += 1) {
    const line = lines[atomStart + engine];
    if (line.length < 30) return undefined;
    lines[atomStart + engine] =
      `${field(engineCoords[engine * 3])}${field(engineCoords[engine * 3 + 1])}${field(engineCoords[engine * 3 + 2])}${line.slice(30)}`;
  }
  return { molblock: lines.join("\n"), engineCoords };
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

  let attempt = attemptEmbed(false);
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


  // A tug relaxation is intentionally different from refineFromEmbedded(): inject the
  // user-deformed original-atom coordinates into a fresh copy of the embedded molblock and
  // optimise from THERE. The existing refineFromEmbedded implementation above is preserved.
  const relaxFromCoordinates = (
    coords3dByOriginalAtom: ArrayLike<number>,
    maxIts?: number,
    refineOptions?: ConformerRefineOptions
  ): Generate3DConformerResult => {
    const requested = Float64Array.from(coords3dByOriginalAtom);
    const forceField = refineForceFieldFor(options.optimize, refineOptions?.forceField);
    const deformed = deformedV2000Molblock(
      embeddedMolblock,
      payload.coords3dByEngineAtom,
      originalToEngineAtom,
      engineToOriginalAtom,
      requested
    );
    if (!deformed) {
      const fallback = isFiniteCoordinateArray(requested, originalAtomCount * 3)
        ? requested
        : Float64Array.from(embeddedCoords);
      return buildResult(fallback, { name: reportNameFor(forceField), status: "setup-failed" });
    }

    const work = rdkit.get_mol(deformed.molblock, JSON.stringify({ removeHs: false }));
    if (!work) {
      return buildResult(requested, { name: reportNameFor(forceField), status: "setup-failed" });
    }

    let lastValid = [...deformed.engineCoords];
    let lastStatus: ConformerForceFieldReport["status"] = "setup-failed";
    let lastEnergy: number | undefined;
    let totalIterations: number | undefined = 0;
    let validPasses = 0;
    try {
      for (const budget of focusedRefinementBudgets(maxIts ?? options.maxMinimiseIterations)) {
        let optimized: unknown;
        try {
          optimized = JSON.parse(
            work.optimize_3d_conformer(JSON.stringify({ forceField, ...(budget === undefined ? {} : { maxIters: budget }) }))
          );
        } catch {
          optimized = undefined;
        }
        if (!isValidOptimizePayload(optimized, payload.coords3dByEngineAtom.length)) {
          break; // retain the last valid pass; first-pass failure keeps the user-deformed geometry
        }
        validPasses += 1;
        lastValid = [...optimized.coords3dByEngineAtom];
        lastStatus = reportStatusFor(optimized.forceField?.status);
        lastEnergy = optimized.forceField?.energy;
        const iterations = optimized.forceField?.iterations;
        totalIterations = totalIterations === undefined || iterations === undefined
          ? undefined
          : totalIterations + iterations;
        // Preserve the focused minimization continuation rule: only another not-converged
        // pass continues. setup-failed/not-run stop instead of consuming more budget.
        if (lastStatus !== "not-converged") break;
      }
    } finally {
      work.delete();
    }

    if (validPasses === 0) {
      return buildResult(requested, { name: reportNameFor(forceField), status: "setup-failed" });
    }

    const relaxedOriginal = scatterToOriginal(lastValid, engineToOriginalAtom, originalAtomCount);
    return buildResult(relaxedOriginal, {
      name: reportNameFor(forceField),
      status: lastStatus,
      energy: lastEnergy,
      iterations: totalIterations
    });
  };

  return { embedded, refineFromEmbedded, relaxFromCoordinates };
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
