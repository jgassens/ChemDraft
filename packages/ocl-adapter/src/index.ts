/**
 * OpenChemLib 3D conformer adapter (Phase 2 — the v1 engine behind the spin tool).
 *
 * Implements the engine-neutral `ConformerGenerator3D` contract from
 * `@chemdraft/chemistry-adapter` using OpenChemLib's `ConformerGenerator` +
 * `ForceFieldMMFF94`. Designed to be **lazy-loaded** (`import("@chemdraft/ocl-adapter")`
 * on first spin) so OCL's ~2.3 MB (1.0 MB JS + 1.3 MB torsion resources) never
 * touches app startup.
 *
 * Atom-identity discipline (verified against the live engine):
 *   1. Parse the molfile -> an OCL `Molecule` (OCL perceives drawn wedge stereo).
 *   2. Tag every parsed atom with `setAtomMapNo(i, i+1)` BEFORE handoff.
 *   3. Copy the molecule (`copyMolecule`) — `getOneConformerAsMolecule` mutates its
 *      argument IN PLACE (saturates with H, writes 3D coords), so the conformer runs
 *      on the copy and the parsed reference is never disturbed.
 *   4. Generate the conformer, optionally MMFF94-minimise.
 *   5. Rebuild the original<->engine atom map via `getAtomMapNo` (generated H carry
 *      mapNo 0) and read `getAtomX/Y/Z` into `coords3dByOriginalAtom`.
 *
 * OCL `ConformerGenerator` requires static torsion resources to be registered once
 * before use (`Resources.register*`); `init()` handles this for Node and browser.
 */

import * as OCL from "openchemlib";
import type {
  ConformerGenerator3D,
  ConformerInput,
  Generate3DConformerOptions,
  Generate3DConformerResult,
  ProgressiveConformerResult,
  ChemistryWarning
} from "@chemdraft/chemistry-adapter";

let resourcesPromise: Promise<void> | undefined;
let resourcesUrlOverride: string | undefined;
let activeTraceSink: ((event: OclConformerTraceEvent) => void) | undefined;
let traceCounter = 0;

export type OclTraceStatus = "started" | "completed" | "failed" | "info";

export interface OclConformerTraceEvent {
  spanId: string;
  stage: string;
  status: OclTraceStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  atomCount?: number;
  message?: string;
  warningCount?: number;
  error?: string;
}

/** OpenChemLib version string (from the package's own constant when present). */
function oclVersion(): string {
  const v = (OCL as unknown as { version?: string }).version;
  return typeof v === "string" ? v : "unknown";
}

function oclTraceNow(): number {
  return Date.now();
}

function startOclTraceSpan(stage: string, extras: Partial<OclConformerTraceEvent> = {}) {
  const startedAt = oclTraceNow();
  const spanId = `${stage}:${++traceCounter}`;
  emitOclTrace({ ...extras, spanId, stage, status: "started", startedAt });

  return {
    complete(extra: Partial<OclConformerTraceEvent> = {}) {
      const endedAt = oclTraceNow();
      emitOclTrace({
        ...extras,
        ...extra,
        spanId,
        stage,
        status: "completed",
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt)
      });
    },
    fail(error: unknown, extra: Partial<OclConformerTraceEvent> = {}) {
      const endedAt = oclTraceNow();
      emitOclTrace({
        ...extras,
        ...extra,
        spanId,
        stage,
        status: "failed",
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

function emitOclTrace(event: OclConformerTraceEvent): void {
  activeTraceSink?.(event);
}

/**
 * Browser/Tauri bundles MUST call this before the first conformer generation.
 * `registerFromUrl()` with no argument fetches `resources.json` relative to the
 * OCL module's URL — which, in a bundled Vite app, is a hashed chunk and 404s.
 * The Vite recipe (see the Phase 4 spec in docs/architecture/3d-spin-flatten.md):
 *
 *   import oclResourcesUrl from "openchemlib/dist/resources.json?url";
 *   setOclResourcesUrl(oclResourcesUrl);
 *
 * No-op concern in Node: the Node path reads the file from disk and ignores this.
 */
export function setOclResourcesUrl(url: string): void {
  resourcesUrlOverride = url;
}

export async function withOclConformerTrace<T>(
  sink: (event: OclConformerTraceEvent) => void,
  run: () => Promise<T>
): Promise<T> {
  const previous = activeTraceSink;
  activeTraceSink = sink;
  try {
    return await run();
  } finally {
    activeTraceSink = previous;
  }
}

/**
 * Register OCL's static torsion resources exactly once. In Node the bundled
 * `resources.json` is read synchronously from disk; in a browser/Tauri bundle the
 * URL set via `setOclResourcesUrl` is fetched (falling back to OCL's
 * module-relative default, which only works unbundled).
 */
export function ensureOclResources(): Promise<void> {
  // Cache the in-flight registration promise so two concurrent first callers don't BOTH pass
  // a "not yet registered" check and register the torsion tables twice (a TOCTOU race, since
  // registration awaits). On failure, clear the cache so a later call can retry.
  if (!resourcesPromise) {
    resourcesPromise = registerOclResources().catch((error) => {
      resourcesPromise = undefined;
      throw error;
    });
  }
  return resourcesPromise;
}

async function registerOclResources(): Promise<void> {
  const span = startOclTraceSpan("resources");
  const Resources = (OCL as unknown as {
    Resources?: {
      registerFromNodejs?: () => void;
      registerFromUrl?: (url?: string) => Promise<void>;
    };
  }).Resources;
  if (!Resources) {
    span.complete({ message: "no resources API" });
    return;
  }
  const nodeVersion = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node;
  const isNode = typeof nodeVersion === "string";
  try {
    if (isNode && Resources.registerFromNodejs) {
      Resources.registerFromNodejs();
    } else if (Resources.registerFromUrl) {
      await Resources.registerFromUrl(resourcesUrlOverride);
    }
    span.complete({ message: isNode ? "node" : "url" });
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

type OclMolecule = InstanceType<typeof OCL.Molecule>;

// ---------------------------------------------------------------------------
// 2D depiction utility (SMILES -> laid-out 2D structure with wedges + molfile)
// ---------------------------------------------------------------------------

export type DepictionBondOrder = "single" | "double" | "triple" | "aromatic" | "unknown";

export interface DepictionAtom2D {
  element: string;
  x: number;
  y: number;
  charge: number;
}

export interface DepictionBond2D {
  from: number;
  to: number;
  order: DepictionBondOrder;
  /** Drawn stereo at the bond's narrow end (`from`): wedge (up), hashed (down), or none. */
  wedge: "wedge" | "hashed" | null;
}

export interface Depiction2D {
  molfile: string;
  atoms: DepictionAtom2D[];
  bonds: DepictionBond2D[];
}

function depictionOrder(order: number): DepictionBondOrder {
  switch (order) {
    case 1:
      return "single";
    case 2:
      return "double";
    case 3:
      return "triple";
    case 4:
      // Delocalized/aromatic: OCL can return order 4 for un-kekulized rings. Preserve it as
      // "aromatic" rather than silently collapsing to a single bond (AGENTS.md §5.7) — the
      // bond order stays faithful even though the renderer currently draws it as a single line.
      return "aromatic";
    default:
      return "unknown";
  }
}

/**
 * Lay out a SMILES into a 2D depiction with wedge/hash stereo bonds derived from
 * its parities, returning both a structured form (atom order preserved) and the
 * corresponding molfile. Atom indices in `bonds` and the molfile match the `atoms`
 * array, so coordinates returned by `generate3DConformer(molfile)` align 1:1.
 */
export function depictSmiles2D(smiles: string): Depiction2D {
  const mol: OclMolecule = OCL.Molecule.fromSmiles(smiles);
  mol.inventCoordinates();
  mol.ensureHelperArrays(OCL.Molecule.cHelperParities);

  const up = OCL.Molecule.cBondTypeUp;
  const down = OCL.Molecule.cBondTypeDown;

  const atoms: DepictionAtom2D[] = [];
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    atoms.push({
      element: mol.getAtomLabel(i),
      x: mol.getAtomX(i),
      // OCL's 2D layout is screen-oriented (y grows DOWN); its molfile writer flips
      // y to the chemistry-standard y-up. We emit y-up too so the depiction's
      // perceived chirality matches the molfile / 3D conformer (verified via the
      // RDKit oracle — without this flip the wedge reads as the mirror enantiomer).
      y: -mol.getAtomY(i),
      charge: mol.getAtomCharge(i)
    });
  }

  const bonds: DepictionBond2D[] = [];
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const type = mol.getBondType(b);
    bonds.push({
      from: mol.getBondAtom(0, b),
      to: mol.getBondAtom(1, b),
      order: depictionOrder(mol.getBondOrder(b)),
      wedge: type === up ? "wedge" : type === down ? "hashed" : null
    });
  }

  return { molfile: mol.toMolfile(), atoms, bonds };
}

function countExplicitHydrogens(mol: OclMolecule): number {
  let count = 0;
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    if (mol.getAtomicNo(i) === 1) count += 1;
  }
  return count;
}

/** Read the original-atom mapping + coordinates out of a (tagged) conformer molecule. */
function readConformerMapping(
  conformer: OclMolecule,
  originalAtomCount: number,
  warnings: ChemistryWarning[]
): Generate3DConformerResult["mapping"] {
  const engineAtomCount = conformer.getAllAtoms();
  const coords3dByOriginalAtom = new Float64Array(originalAtomCount * 3);
  const originalToEngineAtom = new Array<number>(originalAtomCount).fill(-1);
  const engineToOriginalAtom = new Array<number>(engineAtomCount).fill(-1);
  const generatedHydrogenEngineAtoms: number[] = [];

  for (let engineIdx = 0; engineIdx < engineAtomCount; engineIdx++) {
    const mapNo = conformer.getAtomMapNo(engineIdx);
    if (mapNo > 0) {
      const originalIdx = mapNo - 1;
      originalToEngineAtom[originalIdx] = engineIdx;
      engineToOriginalAtom[engineIdx] = originalIdx;
      coords3dByOriginalAtom[originalIdx * 3] = conformer.getAtomX(engineIdx);
      coords3dByOriginalAtom[originalIdx * 3 + 1] = conformer.getAtomY(engineIdx);
      coords3dByOriginalAtom[originalIdx * 3 + 2] = conformer.getAtomZ(engineIdx);
    } else {
      generatedHydrogenEngineAtoms.push(engineIdx);
    }
  }

  const unmapped = originalToEngineAtom.filter((engineIdx) => engineIdx === -1).length;
  if (unmapped > 0) {
    warnings.push({
      code: "ocl.unmapped-original-atoms",
      message: `${unmapped} original atom(s) could not be located in the conformer by map number.`,
      severity: "error"
    });
  }

  return { coords3dByOriginalAtom, originalToEngineAtom, engineToOriginalAtom, generatedHydrogenEngineAtoms };
}

/**
 * Two-stage generation: the embedded conformer is delivered as soon as it exists
 * (already collision-free with correct E/Z + R/S parities — fully usable for an
 * interactive overlay); `refineFromEmbedded()` then runs the (capped) MMFF94
 * minimisation from the embedded coordinates and re-reads them. This splits the two
 * dominant latency costs so callers can put the overlay up after the first, and is
 * re-runnable so a caller can try different iteration caps without re-embedding.
 */
export async function generate3DConformerProgressive(
  input: ConformerInput,
  options: Generate3DConformerOptions = {}
): Promise<ProgressiveConformerResult> {
  await ensureOclResources();

  const warnings: ChemistryWarning[] = [];
  const unsupportedFeatures: ChemistryWarning[] = [];
  const seed = options.seed ?? 42;
  const optimize = options.optimize ?? "auto";

  // v1 stereo invariants are enforced by construction: OCL's ConformerGenerator embeds the
  // stereo parsed from the molfile and never invents unspecified centres. The two options
  // exist to make that contract explicit; only their default (true / false) is supported, so
  // surface a warning rather than silently ignoring a caller that asked for the opposite.
  if (options.preserveSpecifiedStereo === false || options.allowInventStereo === true) {
    warnings.push({
      code: "ocl.stereo-option-unsupported",
      message:
        "OCL always preserves specified stereo and never invents unspecified stereo; " +
        "preserveSpecifiedStereo:false / allowInventStereo:true are not supported.",
      severity: "warning"
    });
  }

  const parseSpan = startOclTraceSpan("parse-molfile");
  let parsed: OclMolecule;
  try {
    parsed = OCL.Molecule.fromMolfile(input.molfile);
    parseSpan.complete({ atomCount: parsed.getAllAtoms() });
  } catch (error) {
    parseSpan.fail(error);
    throw error;
  }
  const originalAtomCount = parsed.getAllAtoms();
  const explicitInputHydrogens = countExplicitHydrogens(parsed);

  if (typeof input.originalAtomCount === "number" && input.originalAtomCount !== originalAtomCount) {
    warnings.push({
      code: "ocl.atom-count-mismatch",
      message: `Parsed ${originalAtomCount} atoms but caller expected ${input.originalAtomCount}.`,
      severity: "warning"
    });
  }

  // Tag every original atom so it survives H-saturation and any reordering.
  for (let i = 0; i < originalAtomCount; i++) parsed.setAtomMapNo(i, i + 1, false);

  // Work on a copy — the conformer generator mutates its argument in place.
  const work: OclMolecule = new OCL.Molecule(0, 0);
  parsed.copyMolecule(work);

  const embedSpan = startOclTraceSpan("embed-conformer", { atomCount: originalAtomCount });
  const generator = new OCL.ConformerGenerator(seed);
  let conformer: OclMolecule | null;
  try {
    conformer = generator.getOneConformerAsMolecule(work);
  } catch (error) {
    embedSpan.fail(error, { atomCount: originalAtomCount });
    throw error;
  }

  const engine = { name: "openchemlib", version: oclVersion(), parameters: { seed, optimize } } as const;
  const hydrogens = (added: boolean) => ({
    added,
    explicitInputHydrogensPreserved: explicitInputHydrogens > 0
  });

  if (!conformer) {
    embedSpan.fail(new Error("ConformerGenerator returned no collision-free conformer"), { atomCount: originalAtomCount });
    return {
      embedded: {
        mapping: {
          coords3dByOriginalAtom: new Float64Array(originalAtomCount * 3),
          originalToEngineAtom: new Array(originalAtomCount).fill(-1),
          engineToOriginalAtom: [],
          generatedHydrogenEngineAtoms: []
        },
        originalAtomCount,
        generatedAtomCount: 0,
        hydrogens: hydrogens(false),
        engine,
        embed: { status: "failed", failureReason: "ConformerGenerator returned no collision-free conformer" },
        unsupportedFeatures,
        warnings
      }
    };
  }
  embedSpan.complete({ atomCount: originalAtomCount });

  const embeddedMappingSpan = startOclTraceSpan("atom-mapping.embedded", { atomCount: originalAtomCount });
  const embeddedMapping = readConformerMapping(conformer, originalAtomCount, warnings);
  embeddedMappingSpan.complete({ atomCount: originalAtomCount, warningCount: warnings.length });
  const embedded: Generate3DConformerResult = {
    mapping: embeddedMapping,
    originalAtomCount,
    generatedAtomCount: embeddedMapping.generatedHydrogenEngineAtoms.length,
    hydrogens: hydrogens(embeddedMapping.generatedHydrogenEngineAtoms.length > 0),
    engine,
    embed: { status: "ok" },
    forceField: { name: optimize === "none" ? "none" : "MMFF94", status: "not-run" },
    unsupportedFeatures: [...unsupportedFeatures],
    warnings: [...warnings]
  };

  if (optimize === "none") {
    return { embedded };
  }

  // Embed-stage warnings, snapshotted so each (re-runnable) refinement starts from them
  // rather than appending to a shared array — otherwise deriving multiple modes from one
  // embed would duplicate/accumulate mapping warnings across calls.
  const embeddedWarnings: ChemistryWarning[] = [...warnings];

  // Snapshot the pristine embedded coordinates so refinement can be re-run from them
  // for different iteration caps / modes WITHOUT re-embedding. MMFF94's minimise() is
  // single-shot and mutates the conformer in place, and re-minimising from already-
  // relaxed coordinates warps geometry (notably flattening aromatic rings); restoring
  // the embed before each run keeps every call independent and reproducible.
  const engineAtomCount = conformer.getAllAtoms();
  const embeddedCoords = new Float64Array(engineAtomCount * 3);
  for (let i = 0; i < engineAtomCount; i++) {
    embeddedCoords[i * 3] = conformer.getAtomX(i);
    embeddedCoords[i * 3 + 1] = conformer.getAtomY(i);
    embeddedCoords[i * 3 + 2] = conformer.getAtomZ(i);
  }
  const restoreEmbeddedCoords = (): void => {
    for (let i = 0; i < engineAtomCount; i++) {
      conformer.setAtomX(i, embeddedCoords[i * 3]);
      conformer.setAtomY(i, embeddedCoords[i * 3 + 1]);
      conformer.setAtomZ(i, embeddedCoords[i * 3 + 2]);
    }
  };

  const refineFromEmbedded = (maxItsOverride?: number): Generate3DConformerResult => {
    const maxIts = maxItsOverride ?? options.maxMinimiseIterations;
    restoreEmbeddedCoords(); // every refinement starts from the pristine embed
    // Per-call warnings: start from the embed-stage snapshot so re-running a different mode
    // never inherits or re-appends a prior call's refine/mapping warnings.
    const refineWarnings: ChemistryWarning[] = [...embeddedWarnings];
    let forceField: Generate3DConformerResult["forceField"];
    const refineSpan = startOclTraceSpan("mmff94-refine", { atomCount: originalAtomCount });
    try {
      const ff = new OCL.ForceFieldMMFF94(conformer, OCL.ForceFieldMMFF94.MMFF94, {});
      const rc = maxIts !== undefined ? ff.minimise({ maxIts }) : ff.minimise();
      forceField = {
        name: "MMFF94",
        status: rc === 0 ? "converged" : "not-converged",
        returnCode: rc,
        energy: typeof ff.getTotalEnergy === "function" ? ff.getTotalEnergy() : undefined
      };
      refineSpan.complete({ atomCount: originalAtomCount, message: forceField.status });
    } catch (error) {
      forceField = { name: "MMFF94", status: "setup-failed" };
      refineWarnings.push({
        code: "ocl.forcefield-unavailable",
        message: `MMFF94 setup failed: ${(error as Error).message}`,
        severity: "warning"
      });
      refineSpan.fail(error, { atomCount: originalAtomCount });
    }
    const refinedMappingSpan = startOclTraceSpan("atom-mapping.refined", { atomCount: originalAtomCount });
    const refinedMapping = readConformerMapping(conformer, originalAtomCount, refineWarnings);
    refinedMappingSpan.complete({ atomCount: originalAtomCount, warningCount: refineWarnings.length });
    return {
      mapping: refinedMapping,
      originalAtomCount,
      generatedAtomCount: refinedMapping.generatedHydrogenEngineAtoms.length,
      hydrogens: hydrogens(refinedMapping.generatedHydrogenEngineAtoms.length > 0),
      engine,
      embed: { status: "ok" },
      forceField,
      unsupportedFeatures: [...unsupportedFeatures],
      warnings: [...refineWarnings]
    };
  };

  return { embedded, refineFromEmbedded };
}

export const oclConformerGenerator: ConformerGenerator3D = {
  engineName: "openchemlib",
  canGenerate3DConformer: true,

  async init(): Promise<void> {
    await ensureOclResources();
  },

  async generate3DConformer(
    input: ConformerInput,
    options: Generate3DConformerOptions = {}
  ): Promise<Generate3DConformerResult> {
    const { embedded, refineFromEmbedded } = await generate3DConformerProgressive(input, options);
    return refineFromEmbedded ? refineFromEmbedded() : embedded;
  }
};
