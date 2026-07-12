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

interface InputOrderedOclMolecule {
  molecule: OclMolecule;
  /** Maps each molfile atom index to the corresponding OCL atom index. */
  originalToEngineAtom: number[];
  /** Maps each OCL atom index back to its molfile atom index. */
  engineToOriginalAtom: number[];
  /** Maps each OCL bond index back to its V2000 molfile bond index when available. */
  engineToOriginalBond?: number[];
}

interface V2000Blocks {
  lines: string[];
  countsLineIndex: number;
  atomCount: number;
  bondCount: number;
  atomLines: string[];
  bondLines: string[];
}

function v2000Blocks(molfile: string): V2000Blocks | undefined {
  const lines = molfile.split(/\r?\n/);
  const countsLineIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  if (countsLineIndex < 0) return undefined;
  const countsLine = lines[countsLineIndex] ?? "";
  const atomCount = Number.parseInt(countsLine.slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt(countsLine.slice(3, 6).trim(), 10);
  if (!Number.isInteger(atomCount) || !Number.isInteger(bondCount)) return undefined;
  const atomStart = countsLineIndex + 1;
  const atomLines = lines.slice(atomStart, atomStart + atomCount);
  const bondLines = lines.slice(atomStart + atomCount, atomStart + atomCount + bondCount);
  if (atomLines.length !== atomCount || bondLines.length !== bondCount) return undefined;
  return { lines, countsLineIndex, atomCount, bondCount, atomLines, bondLines };
}

function v2000BondAtomIndices(line: string): { from: number; to: number } | undefined {
  const from = Number.parseInt(line.slice(0, 3).trim(), 10) - 1;
  const to = Number.parseInt(line.slice(3, 6).trim(), 10) - 1;
  return Number.isInteger(from) && from >= 0 && Number.isInteger(to) && to >= 0 ? { from, to } : undefined;
}

function numericAtomPairKey(from: number, to: number): string {
  return from < to ? `${from}::${to}` : `${to}::${from}`;
}

function v2000EngineToOriginalBondMap(
  molfile: string,
  molecule: OclMolecule,
  engineToOriginalAtom: readonly number[]
): number[] | undefined {
  const blocks = v2000Blocks(molfile);
  if (!blocks || blocks.bondCount !== molecule.getAllBonds()) return undefined;
  const originalIndicesByPair = new Map<string, number[]>();
  blocks.bondLines.forEach((line, originalBondIndex) => {
    const atoms = v2000BondAtomIndices(line);
    if (!atoms) return;
    const key = numericAtomPairKey(atoms.from, atoms.to);
    originalIndicesByPair.set(key, [...(originalIndicesByPair.get(key) ?? []), originalBondIndex]);
  });

  const engineToOriginalBond: number[] = [];
  for (let engineBondIndex = 0; engineBondIndex < molecule.getAllBonds(); engineBondIndex++) {
    const engineFrom = molecule.getBondAtom(0, engineBondIndex);
    const engineTo = molecule.getBondAtom(1, engineBondIndex);
    const originalFrom = engineToOriginalAtom[engineFrom];
    const originalTo = engineToOriginalAtom[engineTo];
    if (originalFrom === undefined || originalTo === undefined) return undefined;
    const candidates = originalIndicesByPair.get(numericAtomPairKey(originalFrom, originalTo));
    const originalBondIndex = candidates?.shift();
    if (originalBondIndex === undefined) return undefined;
    engineToOriginalBond.push(originalBondIndex);
  }
  return engineToOriginalBond;
}

function v2000Coordinate(value: number): string {
  const safe = Number.isFinite(value) ? value + 0 : 0;
  const text = safe.toFixed(4);
  if (text.length > 10) {
    throw new Error("OpenChemLib returned a 2D coordinate outside V2000's fixed-width range.");
  }
  return text.padStart(10);
}

/**
 * Keep the caller's atom/bond order and all original atom-indexed property lines (`M  CHG`,
 * `M  ISO`, `M  RAD`, etc.), replacing only the freshly invented geometry and wedge assignment.
 * Reordering OCL's serialized atom block alone would leave those property lines pointing at the
 * wrong atoms whenever OCL compacted an explicit hydrogen.
 */
function rewriteOriginalV2000Depiction(molfile: string, depiction: Depiction2D): string {
  const blocks = v2000Blocks(molfile);
  if (!blocks || blocks.atomCount !== depiction.atoms.length || blocks.bondCount !== depiction.bonds.length) {
    throw new Error("OpenChemLib returned a 2D depiction that cannot be mapped onto the input V2000 structure.");
  }

  const atomLines = blocks.atomLines.map((line, index) => {
    const atom = depiction.atoms[index];
    if (!atom) throw new Error("OpenChemLib omitted an atom from its 2D depiction.");
    return `${v2000Coordinate(atom.x)}${v2000Coordinate(atom.y)}${v2000Coordinate(0)}${line.slice(30)}`;
  });
  const depictionBondByPair = new Map(
    depiction.bonds.map((bond) => [numericAtomPairKey(bond.from, bond.to), bond])
  );
  const bondLines = blocks.bondLines.map((line) => {
    const inputAtoms = v2000BondAtomIndices(line);
    if (!inputAtoms) throw new Error("Input V2000 structure contains an invalid bond line.");
    const bond = depictionBondByPair.get(numericAtomPairKey(inputAtoms.from, inputAtoms.to));
    if (!bond) throw new Error("OpenChemLib omitted a bond from its 2D depiction.");
    const stereoCode = bond.wedge === "wedge" ? 1 : bond.wedge === "hashed" ? 6 : 0;
    const originalStereoCode = Number.parseInt(line.slice(9, 12).trim(), 10) || 0;
    const from = bond.wedge ? bond.from : inputAtoms.from;
    const to = bond.wedge ? bond.to : inputAtoms.to;
    const stereo = bond.wedge || originalStereoCode === 1 || originalStereoCode === 6
      ? stereoCode
      : originalStereoCode;
    return `${String(from + 1).padStart(3)}${String(to + 1).padStart(3)}${line.slice(6, 9)}${String(stereo).padStart(3)}${line.slice(12)}`;
  });

  const atomStart = blocks.countsLineIndex + 1;
  const suffixStart = atomStart + blocks.atomCount + blocks.bondCount;
  return [
    ...blocks.lines.slice(0, atomStart),
    ...atomLines,
    ...bondLines,
    ...blocks.lines.slice(suffixStart)
  ].join("\n");
}

/**
 * OCL compacts ordinary explicit hydrogens to the end while parsing a molfile. In doing so it may
 * move a non-hydrogen atom into the vacated slot as well, so reading index `i` directly from the
 * parsed molecule is not an input-order contract. Keep OCL's own parser-provided map beside every
 * parsed molecule and use it whenever values cross the adapter boundary by atom index.
 */
function parseMolfileWithInputOrder(molfile: string): InputOrderedOclMolecule {
  const parsed = OCL.Molecule.fromMolfileWithAtomMap(molfile);
  const molecule = parsed.molecule as OclMolecule;
  const originalToEngineAtom = [...parsed.map];
  const engineToOriginalAtom = new Array<number>(molecule.getAllAtoms()).fill(-1);

  originalToEngineAtom.forEach((engineIndex, originalIndex) => {
    if (
      !Number.isInteger(engineIndex) ||
      engineIndex < 0 ||
      engineIndex >= engineToOriginalAtom.length ||
      engineToOriginalAtom[engineIndex] !== -1
    ) {
      throw new Error("OpenChemLib returned an invalid molfile atom-order map.");
    }
    engineToOriginalAtom[engineIndex] = originalIndex;
  });

  if (
    originalToEngineAtom.length !== molecule.getAllAtoms() ||
    engineToOriginalAtom.some((originalIndex) => originalIndex === -1)
  ) {
    throw new Error("OpenChemLib could not preserve every molfile atom index.");
  }

  const engineToOriginalBond = v2000EngineToOriginalBondMap(molfile, molecule, engineToOriginalAtom);
  return { molecule, originalToEngineAtom, engineToOriginalAtom, engineToOriginalBond };
}

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

/** Invent fresh 2D coordinates for an OCL molecule and read the result back as a Depiction2D.
 *  Shared by the SMILES depictor and molfile re-layout. Coordinate invention keeps OCL's parsed
 *  atom table stable; `inputOrder` restores the caller's pre-compaction molfile indices. */
function inventDepiction2D(
  mol: OclMolecule,
  inputOrder?: Pick<InputOrderedOclMolecule, "originalToEngineAtom" | "engineToOriginalAtom">
): Depiction2D {
  // Ordinary explicit H atoms are real ChemDraft atoms. OCL removes them by default during
  // coordinate invention, so keeping them is required for both atom identity and index mapping.
  mol.inventCoordinates({ keepHydrogens: true });
  mol.ensureHelperArrays(OCL.Molecule.cHelperParities);

  const up = OCL.Molecule.cBondTypeUp;
  const down = OCL.Molecule.cBondTypeDown;

  const engineAtoms: DepictionAtom2D[] = [];
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    engineAtoms.push({
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

  const engineBonds: DepictionBond2D[] = [];
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const type = mol.getBondType(b);
    engineBonds.push({
      from: mol.getBondAtom(0, b),
      to: mol.getBondAtom(1, b),
      order: depictionOrder(mol.getBondOrder(b)),
      wedge: type === up ? "wedge" : type === down ? "hashed" : null
    });
  }

  const atoms = inputOrder
    ? inputOrder.originalToEngineAtom.map((engineIndex) => engineAtoms[engineIndex])
    : engineAtoms;
  if (atoms.some((atom) => atom === undefined)) {
    throw new Error("OpenChemLib lost an atom while inventing 2D coordinates.");
  }

  const bonds = inputOrder
    ? engineBonds.map((bond) => {
        const from = inputOrder.engineToOriginalAtom[bond.from];
        const to = inputOrder.engineToOriginalAtom[bond.to];
        if (from === undefined || from < 0 || to === undefined || to < 0) {
          throw new Error("OpenChemLib returned a bond with an unmapped atom.");
        }
        return { ...bond, from, to };
      })
    : engineBonds;

  return { molfile: mol.toMolfile(), atoms: atoms as DepictionAtom2D[], bonds };
}

/**
 * Lay out a SMILES into a 2D depiction with wedge/hash stereo bonds derived from
 * its parities, returning both a structured form (atom order preserved) and the
 * corresponding molfile. Atom indices in `bonds` and the molfile match the `atoms`
 * array, so coordinates returned by `generate3DConformer(molfile)` align 1:1.
 */
export function depictSmiles2D(smiles: string): Depiction2D {
  return inventDepiction2D(OCL.Molecule.fromSmiles(smiles));
}

/**
 * Regenerate a clean 2D layout for an existing structure (the "3D Cleanup" engine): parse the
 * molfile (OCL perceives the drawn wedge/hash stereo into parities), invent fresh coordinates, and
 * re-derive the wedge bonds from those parities on the new geometry. Atom order is preserved, so the
 * result maps back onto the source structure by index. Throws if the re-layout would change the
 * molecule's identity (canonical idcode compared before/after — belt and braces; the inventor only
 * writes coordinates and stereo bonds).
 */
export function relayoutMolfile2D(molfile: string): Depiction2D {
  const parsed = parseMolfileWithInputOrder(molfile);
  const identityBefore = parsed.molecule.getIDCode();
  const invented = inventDepiction2D(parsed.molecule, parsed);
  const depiction = { ...invented, molfile: rewriteOriginalV2000Depiction(molfile, invented) };
  // Reparse the actual serialized output. Comparing the same mutable OCL object before/after does
  // not validate the wedge/coordinate representation that crosses the adapter boundary.
  const identityAfter = OCL.Molecule.fromMolfile(depiction.molfile).getIDCode();
  if (identityBefore !== identityAfter) {
    throw new Error("2D re-layout unexpectedly changed the molecule's identity.");
  }
  return depiction;
}

/** Per-atom stereo verdict, index-aligned to the molfile's atom order (so index i corresponds to
 *  the i-th atom of the molecule that produced `molfile`). */
export interface OclAtomStereo {
  /** True only when the atom is an ACTUAL tetrahedral stereocenter (constitutionally chiral),
   *  not merely an atom that happens to carry a drawn wedge/hash. */
  isStereoCenter: boolean;
  /** CIP descriptor when OCL can assign one; `"unspecified"` otherwise. */
  descriptor: "R" | "S" | "unspecified";
}

/**
 * Perceive which atoms are TRUE stereocenters. A drawn wedge/hash only encodes stereochemistry at
 * a real chiral center; on many structures a wedge is a graphic "projects toward/away" cue on an
 * atom that is not chiral at all (and would otherwise be (mis)treated as a specified center and
 * block a flatten). OCL reads the molfile's 2D coordinates + wedge bonds to decide. The returned
 * array is index-aligned to the molfile's atom order.
 */
export function perceiveStereoCentersFromMolfile(molfile: string): OclAtomStereo[] {
  const parsed = parseMolfileWithInputOrder(molfile);
  const mol = parsed.molecule;
  mol.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  return parsed.originalToEngineAtom.map((engineIndex): OclAtomStereo => {
    const isStereoCenter = mol.isAtomStereoCenter(engineIndex);
    let descriptor: OclAtomStereo["descriptor"] = "unspecified";
    // A cumulated-π axial center (allene/cumulene, pi ≥ 2) is a genuine stereocenter, but its hand
    // is carried by the AXIS, not by a σ-bond wedge, so a flat 2D depiction cannot encode it. Leave
    // its descriptor "unspecified" so the flatten read-back guard never treats it as a center it
    // must preserve — which it never can, so the whole flatten would otherwise be refused. Such
    // axes are surfaced separately by perceiveUnrepresentableStereo.
    if (isStereoCenter && mol.getAtomPi(engineIndex) < 2) {
      const cip = mol.getAtomCIPParity(engineIndex);
      if (cip === OCL.Molecule.cAtomCIPParityRorM) descriptor = "R";
      else if (cip === OCL.Molecule.cAtomCIPParitySorP) descriptor = "S";
    }
    return { isStereoCenter, descriptor };
  });
}

export interface UnrepresentableStereo {
  /** Allene / cumulene axial stereocenters: the central atom's asymmetry is carried by a
   *  cumulated-π AXIS (≥2 π bonds), not by four σ substituents — there is no bond to wedge. */
  alleneAtoms: number[];
  /** Atropisomer (BINAP-type) hindered-rotation stereo axes, reported by their V2000 input bond
   *  index. For V3000, where OCL exposes no original bond map, this remains the engine bond index. */
  atropisomerBonds: number[];
}

/**
 * Detect stereogenic units a FLAT 2D wedge drawing cannot carry — the "axial" chirality types
 * OpenChemLib still recognizes: allene/cumulene axes and atropisomer (BINAP) axes. Used to WARN a
 * user that flattening a spun 3D model drops stereochemistry the 2D depiction can't hold.
 *
 * Deliberate gap: PLANAR (cyclophane, trans-cyclooctene) and HELICAL (helicene) chirality are
 * invisible to CIP perception AND inexpressible in 2D notation, so they can be neither detected
 * here nor supplied as 2D input — a molecule only acquires them from a hand-built 3D structure.
 * Atom indices are in molfile input order. Bond indices are in V2000 input order; see the V3000
 * limitation on `atropisomerBonds` above.
 */
export function perceiveUnrepresentableStereo(molfile: string): UnrepresentableStereo {
  const parsed = parseMolfileWithInputOrder(molfile);
  const mol = parsed.molecule;
  mol.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  const alleneAtoms: number[] = [];
  for (let engineIndex = 0; engineIndex < mol.getAllAtoms(); engineIndex++) {
    if (mol.isAtomStereoCenter(engineIndex) && mol.getAtomPi(engineIndex) >= 2) {
      alleneAtoms.push(parsed.engineToOriginalAtom[engineIndex]);
    }
  }
  const atropisomerBonds: number[] = [];
  for (let b = 0; b < mol.getAllBonds(); b++) {
    if (mol.isBINAPChiralityBond(b)) atropisomerBonds.push(parsed.engineToOriginalBond?.[b] ?? b);
  }
  return { alleneAtoms, atropisomerBonds };
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
  let originalToEngineAtom: number[];
  try {
    const inputOrdered = parseMolfileWithInputOrder(input.molfile);
    parsed = inputOrdered.molecule;
    originalToEngineAtom = inputOrdered.originalToEngineAtom;
    parseSpan.complete({ atomCount: originalToEngineAtom.length });
  } catch (error) {
    parseSpan.fail(error);
    throw error;
  }
  const originalAtomCount = originalToEngineAtom.length;
  const explicitInputHydrogens = countExplicitHydrogens(parsed);

  if (typeof input.originalAtomCount === "number" && input.originalAtomCount !== originalAtomCount) {
    warnings.push({
      code: "ocl.atom-count-mismatch",
      message: `Parsed ${originalAtomCount} atoms but caller expected ${input.originalAtomCount}.`,
      severity: "warning"
    });
  }

  // Tag every original atom so it survives H-saturation and any reordering.
  for (let originalIndex = 0; originalIndex < originalAtomCount; originalIndex++) {
    parsed.setAtomMapNo(originalToEngineAtom[originalIndex], originalIndex + 1, false);
  }

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
