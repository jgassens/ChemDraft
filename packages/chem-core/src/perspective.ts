/**
 * Flatten a spun 3D conformer back to a 2D perspective depiction (Phase 1B —
 * engine-free constrained search). The companion to the Phase 1A identity layer
 * (`identity.ts`) and the design in `bright-spinning-panda.md`.
 *
 * Pipeline: a 2D molecule is drawn, an engine generates a 3D conformer, the user
 * spins it to a viewing angle, and on release we project the rotated conformer to
 * 2D and re-derive the *minimal* set of wedge/hash markers + over/under bond
 * crossings that faithfully depict what the user sees — WITHOUT changing the
 * molecule's chemical identity.
 *
 * Core principle (from the plan): **encoding-soundness is a HARD CONSTRAINT;
 * view-fidelity is the OPTIMIZATION TARGET.** It is never "higher z ⇒ wedge".
 *
 * Why this is engine-free yet sound: tetrahedral handedness is the SIGN of a
 * scalar triple product (signed volume) of the bonds around a center. We compute
 * three independent parities per specified center, all from coordinates:
 *   1. `originalParity`  — from the user's drawn 2D + its existing wedge markers
 *      (what the user *intends*). Independent of any engine.
 *   2. `conformerParity` — from the supplied 3D coordinates (what the conformer
 *      *embodies*). If (1) ≠ (2) the conformer silently flipped the drawn stereo →
 *      we REFUSE (this is the engine-independent guard against a bad conformer —
 *      the correlated-failure trap in the plan).
 *   3. `candidateParity` — from the projected 2D + a *trial* wedge assignment.
 *      A candidate is "encoding-sound" iff its sign equals `conformerParity`.
 * This is the geometric stand-in for the plan's "assemble molfile → parse back →
 * compare perceived stereo" hard filter. Phase 1C/2 augment it with an engine's
 * CIP R/S perception; the geometric parity remains as an independent check.
 *
 * Identity is *not* depiction: the flatten legitimately MOVES a wedge to whatever
 * bond reads best for the new view, so `diffChemicalIdentity`'s display-level
 * stereo-marker comparison must NOT gate the commit. We use `diffChemicalIdentity`
 * only as the GRAPH backstop (atoms/bonds/charge/connectivity/isotopes), and we
 * enforce stereo preservation via the parity engine + the specified-center count.
 *
 * Over/under crossings are a *separate, display-only* output (the model in
 * `docs/architecture/over-under-crossing-model.md`): the same rotated z that drives
 * wedges resolves front/back at every projected bond–bond crossing, baked into
 * `CrossingOverride`s. Inconsistent pairwise depths (Escher knots) raise the
 * existing cyclic-depth canary as a warning, never a silent winner.
 *
 * ── COORDINATE-FRAME CONTRACT (read this before integrating) ─────────────────
 * Everything in this function lives in ONE right-handed math frame:
 *   x → right, y → UP, z → toward the viewer (wedge = +z).
 * `mol2dOriginal.atoms[].x/y`, `coords3d`, and the emitted projected coordinates
 * are all interpreted/produced in that frame. The three parities (drawn /
 * conformer / candidate) are only sign-comparable because the frames agree.
 *
 * ChemDraft DOCUMENTS store screen coordinates (y grows DOWN — molfile import
 * negates y, see `scaleParsedMolfileAtoms` in documentWorkflow.ts). A screen-frame
 * caller MUST apply the perception-preserving conversion:
 *   in:  mathAtom.y = -docAtom.y   (wedge/hash styles unchanged)
 *   out: docAtom.y  = -mathAtom.y  (wedge/hash styles unchanged)
 * Negating y alone, with styles untouched, maps the document to exactly the
 * molecule a human perceives on screen, and back. Passing doc coords raw instead
 * makes the drawn parity read as the MIRROR enantiomer and this function will
 * (correctly, conservatively) refuse with `conformer-mismatch`. Both behaviors
 * are pinned by the "screen-frame (y-down) callers" tests.
 */

import type {
  BondRef,
  CrossingOverride,
  MoleculeAtom,
  MoleculeBond,
  MoleculeObject
} from "./schemas";
import {
  diffChemicalIdentity,
  snapshotChemicalIdentity,
  type MoleculeIdentityDiff,
  type StereoMarkerStyle
} from "./identity";

/** Row-major 4×4 view matrix, applied to a column vector `[x, y, z, 1]`. */
export type ViewMatrix = readonly number[];

export interface FlattenOptions {
  /** Object id used on emitted `CrossingOverride` bond refs. Defaults to `mol.id`. */
  objectId?: string;
  /**
   * Minimum projected bond length for a bond to legibly carry a wedge, expressed
   * as a fraction of the median projected bond length (scale-independent).
   */
  minProjectedBondLengthFraction?: number;
  /**
   * |unit signed volume| below which a projected depiction is treated as
   * degenerate (the center is viewed edge-on along that assignment). In [0, 1].
   */
  parityVolumeEpsilon?: number;
  /**
   * |Δdepth| at a crossing (as a fraction of median projected bond length) below
   * which front/back is ambiguous → warn but still pick a stable front.
   */
  crossingDepthEpsilonFraction?: number;
  /** Substituent–axis angle (degrees) below which an E/Z bond reads edge-on. */
  ezEdgeOnAngleDeg?: number;
  /**
   * Atom ids that are ACTUAL tetrahedral stereocenters (perceived chemically by the caller, e.g.
   * via OpenChemLib). When provided, a drawn wedge/hash is treated as specified stereo ONLY if its
   * narrow-end atom is in this set; wedges on non-chiral atoms — common as graphic "projects
   * toward/away" cues — are dropped (stripped with all markers, never encoded, never a refusal).
   * When omitted, every drawn wedge is treated as a center (legacy, geometry-only behavior).
   */
  stereoCenterAtomIds?: ReadonlySet<string>;
}

type Required<T> = { [K in keyof T]-?: T[K] };

export const DEFAULT_MIN_PROJECTED_BOND_LENGTH_FRACTION = 0.2;

const DEFAULTS: Required<Omit<FlattenOptions, "objectId" | "stereoCenterAtomIds">> = {
  minProjectedBondLengthFraction: DEFAULT_MIN_PROJECTED_BOND_LENGTH_FRACTION,
  parityVolumeEpsilon: 0.05,
  crossingDepthEpsilonFraction: 0.04,
  ezEdgeOnAngleDeg: 12
};

export type FlattenStatus = "committed" | "refused";

export type FlattenWarningCode =
  | "ez-edge-on"
  | "cyclic-depth"
  | "ambiguous-crossing-depth"
  | "degenerate-drawn-parity"
  | "perspective-cleanup";

export interface FlattenWarning {
  code: FlattenWarningCode;
  message: string;
  atomIds?: string[];
  bondIds?: string[];
}

export type StereoCenterStatus =
  | "encoded" // a sound wedge/hash was assigned
  | "edge-on" // every eligible bond projects degenerately for this view
  | "no-sound-assignment" // no encoding-sound wedge exists (e.g. CSP contention)
  | "conformer-mismatch" // 3D coords contradict the drawn stereo
  | "skipped-unspecified"; // not specified in the original → intentionally left plain

export interface StereoCenterReport {
  atomId: string;
  status: StereoCenterStatus;
  wedgeBondId?: string;
  style?: StereoMarkerStyle;
  /** Sign of the conformer's signed volume at this center: -1, 0, or +1. */
  referenceParitySign: number;
}

export interface FlattenResult {
  status: FlattenStatus;
  /** The projected 2D molecule; present only when `status === "committed"`. */
  mol2dProjected?: MoleculeObject;
  /** Over/under decisions baked from projected depth (display-only). */
  crossings: CrossingOverride[];
  warnings: FlattenWarning[];
  /** Graph/identity diff between original and projected; present when a candidate was built. */
  stereoDiff?: MoleculeIdentityDiff;
  stereoCenters: StereoCenterReport[];
  refusalReasons: string[];
}

// ---------------------------------------------------------------------------
// Vector / matrix helpers (pure, dependency-free)
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len < 1e-12 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

/** Apply a row-major 4×4 matrix to a point; returns `[projX, projY, depthZ]`. */
function applyMatrix(m: ViewMatrix, x: number, y: number, z: number): Vec3 {
  const rx = m[0] * x + m[1] * y + m[2] * z + m[3];
  const ry = m[4] * x + m[5] * y + m[6] * z + m[7];
  const rz = m[8] * x + m[9] * y + m[10] * z + m[11];
  const rw = m[12] * x + m[13] * y + m[14] * z + m[15];
  const w = Math.abs(rw) < 1e-12 ? 1 : rw;
  return [rx / w, ry / w, rz / w];
}

/** Normalized triple product of three vectors; scale-independent, in [-1, 1]. */
function normTriple(a: Vec3, b: Vec3, c: Vec3): number {
  return dot(normalize(a), cross(normalize(b), normalize(c)));
}

/**
 * Unit tetrahedral parity — the sign is the handedness, the magnitude the
 * "out-of-plane-ness" of the view (≈0 ⇒ degenerate / edge-on).
 *
 * For 4 substituents it is **center-independent**: the normalized triple product
 * of `(n2−n1, n3−n1, n4−n1)` over the id-sorted neighbors. This avoids the
 * symmetric-view degeneracy where two in-plane neighbors project collinearly
 * through the center. For 3 explicit substituents (the 4th an implicit H), it is
 * the triple product of the bond vectors measured from the center.
 *
 * The SAME function and neighbor ordering must drive the 3D reference, the drawn
 * pre-check, and every depiction candidate, so their signs are comparable.
 */
function tetrahedralParity(center: Vec3, neighbors: readonly Vec3[]): number {
  if (neighbors.length >= 4) {
    return normTriple(
      sub(neighbors[1], neighbors[0]),
      sub(neighbors[2], neighbors[0]),
      sub(neighbors[3], neighbors[0])
    );
  }
  return normTriple(sub(neighbors[0], center), sub(neighbors[1], center), sub(neighbors[2], center));
}

function signWithEpsilon(value: number, epsilon: number): -1 | 0 | 1 {
  if (value > epsilon) return 1;
  if (value < -epsilon) return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

interface Neighbor {
  atomId: string;
  bondId: string;
  bond: MoleculeBond;
}

function buildAdjacency(bonds: readonly MoleculeBond[]): Map<string, Neighbor[]> {
  const adjacency = new Map<string, Neighbor[]>();
  const push = (from: string, to: string, bond: MoleculeBond) => {
    const list = adjacency.get(from) ?? [];
    list.push({ atomId: to, bondId: bond.id, bond });
    adjacency.set(from, list);
  };
  for (const bond of bonds) {
    push(bond.fromAtomId, bond.toAtomId, bond);
    push(bond.toAtomId, bond.fromAtomId, bond);
  }
  // Stable order so parity reference triples are deterministic.
  for (const list of adjacency.values()) list.sort((a, b) => a.atomId.localeCompare(b.atomId));
  return adjacency;
}

/** Bond ids that lie on at least one ring (endpoints still connected without the bond). */
function ringBondIds(bonds: readonly MoleculeBond[]): Set<string> {
  const rings = new Set<string>();
  for (const target of bonds) {
    const start = target.fromAtomId;
    const goal = target.toAtomId;
    const seen = new Set<string>([start]);
    const queue = [start];
    let connected = false;
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === goal) {
        connected = true;
        break;
      }
      for (const bond of bonds) {
        if (bond.id === target.id) continue;
        const next =
          bond.fromAtomId === current ? bond.toAtomId : bond.toAtomId === current ? bond.fromAtomId : undefined;
        if (next !== undefined && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    if (connected) rings.add(target.id);
  }
  return rings;
}

function isStereoStyle(style: string | undefined): style is StereoMarkerStyle {
  return style === "wedge" || style === "hashed";
}

// ---------------------------------------------------------------------------
// Flatten
// ---------------------------------------------------------------------------

interface Projected {
  x: number;
  y: number;
  z: number; // rotated depth; larger = nearer the viewer
}

interface Candidate {
  bondId: string;
  neighborId: string;
  style: StereoMarkerStyle;
  score: number;
}

interface CenterPlan {
  atomId: string;
  candidates: Candidate[]; // sorted by score, descending
  referenceParitySign: number;
}

/**
 * Project a spun 3D conformer to a 2D perspective depiction with encoding-sound
 * wedges and over/under crossings, or refuse if identity cannot be preserved.
 *
 * FRAME: all coordinate inputs and outputs are in the right-handed math frame
 * (y UP, z toward viewer) — see the module-header contract. Screen-frame (y-down)
 * callers must negate y on the way in AND on the way out, styles untouched.
 *
 * @param mol2dOriginal the user's drawn 2D molecule (source of identity + intent);
 *                      atom x/y must be in the math frame (y up)
 * @param coords3d      flat `[x0,y0,z0, x1,y1,z1, …]`, indexed by `mol.atoms`
 *                      order (matches `ConformerAtomMapping.coords3dByOriginalAtom`)
 * @param viewMatrix    row-major 4×4 rotation+projection (e.g. trackball → ortho)
 */
export function flattenPerspectiveFrom3D(
  mol2dOriginal: MoleculeObject,
  coords3d: ArrayLike<number>,
  viewMatrix: ViewMatrix,
  options: FlattenOptions = {}
): FlattenResult {
  const atoms = mol2dOriginal.atoms;
  const bonds = mol2dOriginal.bonds;
  if (coords3d.length !== atoms.length * 3) {
    throw new TypeError(
      `coords3d length ${coords3d.length} does not match atomCount*3 (${atoms.length * 3}).`
    );
  }
  if (viewMatrix.length !== 16) {
    throw new TypeError(`viewMatrix must have 16 elements (row-major 4×4); got ${viewMatrix.length}.`);
  }

  const opts = { ...DEFAULTS, ...options };
  const objectId = options.objectId ?? mol2dOriginal.id;
  const warnings: FlattenWarning[] = [];
  const refusalReasons: string[] = [];
  const stereoCenters: StereoCenterReport[] = [];

  const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index] as const));
  const adjacency = buildAdjacency(bonds);
  const rings = ringBondIds(bonds);

  // Raw 3D positions (chirality reference) and projected 2D positions (depiction).
  const raw3d = new Map<string, Vec3>();
  const projected = new Map<string, Projected>();
  atoms.forEach((atom, index) => {
    const x = coords3d[index * 3];
    const y = coords3d[index * 3 + 1];
    const z = coords3d[index * 3 + 2];
    raw3d.set(atom.id, [x, y, z]);
    const [px, py, depth] = applyMatrix(viewMatrix, x, y, z);
    projected.set(atom.id, { x: px, y: py, z: depth });
  });

  const medianProjectedBondLength = medianBondLength(bonds, projected);
  const minWedgeLength = opts.minProjectedBondLengthFraction * medianProjectedBondLength;

  // Eligible set: only centers the user explicitly specified (narrow end of an
  // existing wedge/hash bond). Never invent stereo just because the view has depth.
  // If one center carries SEVERAL drawn markers (over-specified input), the last
  // bond in document order wins for the drawn-parity pre-check. That is safe: the
  // check can only become more conservative (a real contradiction still refuses),
  // and all original markers are stripped before re-encoding regardless.
  const originalMarkerByCenter = new Map<string, { neighborId: string; style: StereoMarkerStyle }>();
  for (const bond of bonds) {
    if (isStereoStyle(bond.display?.bondStyle)) {
      // narrow end (stereocenter) is fromAtomId by ChemDraft convention.
      // A wedge/hash only encodes stereo at an ACTUAL stereocenter. When the caller supplies the
      // perceived stereocenter set, ignore markers on non-centers: they are graphic "toward/away"
      // cues, not specified stereo, and are dropped (they get stripped with all markers below and
      // never re-encoded) instead of being (mis)enforced and refusing the whole flatten.
      if (opts.stereoCenterAtomIds && !opts.stereoCenterAtomIds.has(bond.fromAtomId)) continue;
      originalMarkerByCenter.set(bond.fromAtomId, {
        neighborId: bond.toAtomId,
        style: bond.display?.bondStyle as StereoMarkerStyle
      });
    }
  }

  const centerPlans: CenterPlan[] = [];

  for (const [centerId, marker] of originalMarkerByCenter) {
    void marker;
    const neighbors = adjacency.get(centerId) ?? [];
    if (neighbors.length < 3) {
      // Not enough substituents to define tetrahedral handedness → cannot encode.
      stereoCenters.push({ atomId: centerId, status: "no-sound-assignment", referenceParitySign: 0 });
      refusalReasons.push(`center ${centerId} has < 3 neighbors; tetrahedral stereo is undefined`);
      continue;
    }
    if (neighbors.length > 4) {
      stereoCenters.push({ atomId: centerId, status: "no-sound-assignment", referenceParitySign: 0 });
      refusalReasons.push(`center ${centerId} has coordination > 4; not a supported tetrahedral center`);
      continue;
    }

    // One id-sorted neighbor set drives all three parities (reference, drawn, candidate).
    const parityNeighborIds = neighbors.map((n) => n.atomId);
    const centerXY = centerOf(centerId, atoms);

    const conformerVolume = tetrahedralParity(
      raw3d.get(centerId) as Vec3,
      parityNeighborIds.map((id) => raw3d.get(id) as Vec3)
    );
    const referenceParitySign = signWithEpsilon(conformerVolume, opts.parityVolumeEpsilon);

    // Engine-independent guard: does the 3D conformer agree with the DRAWN stereo?
    const drawnVolume = tetrahedralParity(
      [centerXY[0], centerXY[1], 0],
      parityNeighborIds.map((id) => drawnPseudo3d(id, centerId, atoms, originalMarkerByCenter))
    );
    const drawnSign = signWithEpsilon(drawnVolume, opts.parityVolumeEpsilon);

    if (referenceParitySign === 0) {
      stereoCenters.push({ atomId: centerId, status: "conformer-mismatch", referenceParitySign });
      refusalReasons.push(`center ${centerId}: 3D conformer is flat (no handedness) at a specified center`);
      continue;
    }
    if (drawnSign !== 0 && drawnSign !== referenceParitySign) {
      stereoCenters.push({ atomId: centerId, status: "conformer-mismatch", referenceParitySign });
      refusalReasons.push(
        `center ${centerId}: 3D conformer handedness contradicts the drawn wedge (engine flipped stereo)`
      );
      continue;
    }
    if (drawnSign === 0) {
      // The drawn 2D geometry is too degenerate (e.g. collinear sketch) to verify
      // against the conformer — the engine-flip guard cannot run for this center.
      // Proceed on the conformer's handedness, but say so out loud.
      warnings.push({
        code: "degenerate-drawn-parity",
        message: `Center ${centerId}: drawn 2D geometry is too degenerate to cross-check against the 3D conformer; trusting the conformer's handedness.`,
        atomIds: [centerId]
      });
    }

    // Enumerate encoding-sound candidates: per eligible bond, exactly one of
    // {wedge, hashed} reproduces the conformer's handedness (when non-degenerate).
    const candidates: Candidate[] = [];
    const centerProj = projected.get(centerId) as Projected;

    for (const neighbor of neighbors) {
      if (neighbor.bond.order !== "single") continue; // never wedge a non-single bond
      const neighborProj = projected.get(neighbor.atomId) as Projected;
      const projLength = Math.hypot(neighborProj.x - centerProj.x, neighborProj.y - centerProj.y);
      if (projLength < minWedgeLength) continue; // too foreshortened to read

      for (const style of ["wedge", "hashed"] as const) {
        const candidateVolume = depictionParity(
          centerId,
          neighbor.atomId,
          style,
          parityNeighborIds,
          projected
        );
        const candidateSign = signWithEpsilon(candidateVolume, opts.parityVolumeEpsilon);
        if (candidateSign === 0) continue; // degenerate projection for this bond
        if (candidateSign !== referenceParitySign) continue; // unsound encoding
        const outOfPlane = Math.abs(neighborProj.z - centerProj.z);
        const score =
          (rings.has(neighbor.bondId) ? 0 : 2) + // prefer non-ring bonds
          outOfPlane / (medianProjectedBondLength || 1) + // prefer genuinely out-of-plane bonds
          projLength / (medianProjectedBondLength || 1) * 0.1; // mild legibility bonus
        candidates.push({ bondId: neighbor.bondId, neighborId: neighbor.atomId, style, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      stereoCenters.push({ atomId: centerId, status: "edge-on", referenceParitySign });
      refusalReasons.push(`center ${centerId}: viewed edge-on — no legible, encoding-sound wedge exists`);
      continue;
    }

    centerPlans.push({ atomId: centerId, candidates, referenceParitySign });
  }

  // Bonds are a shared resource: vicinal/meso centers may contend for the same
  // bond. Solve as a CSP (one wedge bond per center, no bond reused) via MRV
  // backtracking, preferring high-scoring assignments.
  const assignment = solveSharedBondCsp(centerPlans);
  if (assignment === null && centerPlans.length > 0) {
    for (const plan of centerPlans) {
      stereoCenters.push({
        atomId: plan.atomId,
        status: "no-sound-assignment",
        referenceParitySign: plan.referenceParitySign
      });
    }
    refusalReasons.push("shared-bond conflict: no globally consistent wedge assignment (CSP unsatisfiable)");
  }

  if (refusalReasons.length > 0) {
    return { status: "refused", crossings: [], warnings, stereoCenters, refusalReasons };
  }

  // Build the projected molecule: new 2D coords, stripped wedge/hash markers, then
  // the chosen sound wedges (oriented narrow-end-at-center).
  const projectedMolecule = buildProjectedMolecule(mol2dOriginal, projected, assignment ?? new Map());

  for (const plan of centerPlans) {
    const chosen = (assignment as Map<string, Candidate>).get(plan.atomId);
    stereoCenters.push({
      atomId: plan.atomId,
      status: "encoded",
      wedgeBondId: chosen?.bondId,
      style: chosen?.style,
      referenceParitySign: plan.referenceParitySign
    });
  }

  // Graph backstop (NOT marker-level): atoms/bonds/charge/connectivity/isotopes.
  const stereoDiff = diffChemicalIdentity(
    snapshotChemicalIdentity(mol2dOriginal),
    snapshotChemicalIdentity(projectedMolecule)
  );
  if (graphDrifted(stereoDiff)) {
    return {
      status: "refused",
      crossings: [],
      warnings,
      stereoDiff,
      stereoCenters,
      refusalReasons: [`graph drift after projection: ${stereoDiff.reasons.join("; ")}`]
    };
  }

  // E/Z: never wedge a double bond; warn if the view makes it read edge-on.
  warnEdgeOnDoubleBonds(bonds, projected, opts.ezEdgeOnAngleDeg, warnings);

  // Over/under crossings from depth (display-only) + cyclic-depth canary.
  const crossings = computeCrossings(bonds, projected, objectId, opts, medianProjectedBondLength, warnings);

  warnings.push({
    code: "perspective-cleanup",
    message: "Perspective depiction — projected geometry may need cleanup."
  });

  return {
    status: "committed",
    mol2dProjected: projectedMolecule,
    crossings,
    warnings,
    stereoDiff,
    stereoCenters,
    refusalReasons: []
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function centerOf(atomId: string, atoms: readonly MoleculeAtom[]): readonly [number, number] {
  const atom = atoms.find((candidate) => candidate.id === atomId);
  // A missing atom (stale reference) silently using origin [0,0] would compute the WRONG
  // parity sign — a wrong wedge or a spurious refusal. Fail loud instead (the flatten
  // commit catches and refuses cleanly).
  if (!atom) {
    throw new Error(`perspective: stereocenter references missing atom "${atomId}"`);
  }
  return [atom.x, atom.y];
}

/** Pseudo-3D position of `neighborId` in the ORIGINAL drawing (z from drawn wedge at center). */
function drawnPseudo3d(
  neighborId: string,
  centerId: string,
  atoms: readonly MoleculeAtom[],
  markers: Map<string, { neighborId: string; style: StereoMarkerStyle }>
): Vec3 {
  const atom = atoms.find((candidate) => candidate.id === neighborId);
  if (!atom) {
    throw new Error(`perspective: stereo neighbor references missing atom "${neighborId}"`);
  }
  const marker = markers.get(centerId);
  let z = 0;
  if (marker && marker.neighborId === neighborId) z = marker.style === "wedge" ? 1 : -1;
  return [atom.x, atom.y, z];
}

/** Parity of a trial depiction: wedge/hash neighbor lifted to z=±1, others in-plane. */
function depictionParity(
  centerId: string,
  wedgeNeighborId: string,
  style: StereoMarkerStyle,
  parityNeighborIds: readonly string[],
  projected: Map<string, Projected>
): number {
  const center = projected.get(centerId) as Projected;
  const positions = parityNeighborIds.map((atomId): Vec3 => {
    const p = projected.get(atomId) as Projected;
    const z = atomId === wedgeNeighborId ? (style === "wedge" ? 1 : -1) : 0;
    return [p.x, p.y, z];
  });
  return tetrahedralParity([center.x, center.y, 0], positions);
}

function medianBondLength(bonds: readonly MoleculeBond[], projected: Map<string, Projected>): number {
  const lengths = bonds
    .map((bond) => {
      const a = projected.get(bond.fromAtomId);
      const b = projected.get(bond.toAtomId);
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    })
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (lengths.length === 0) return 1;
  const mid = Math.floor(lengths.length / 2);
  return lengths.length % 2 === 0 ? (lengths[mid - 1] + lengths[mid]) / 2 : lengths[mid];
}

/**
 * MRV backtracking: assign each center one bond, no bond reused, prefer high score.
 *
 * A carbon must not end up with two solid wedges or two hashed wedges meeting at it.
 * Even when opposite bond directions make that depiction encoding-sound, the repeated
 * glyph reads as an accidental double wedge/hash. Treat endpoint style uniqueness as a
 * hard legibility constraint and let the CSP move one center's marker to another
 * encoding-sound bond.
 */
function solveSharedBondCsp(plans: readonly CenterPlan[]): Map<string, Candidate> | null {
  if (plans.length === 0) return new Map();
  const order = [...plans].sort((a, b) => a.candidates.length - b.candidates.length);
  const used = new Set<string>();
  const usedStylesByAtom = new Map<string, Set<StereoMarkerStyle>>();
  const result = new Map<string, Candidate>();

  const styleIsUsedAt = (atomId: string, style: StereoMarkerStyle): boolean =>
    usedStylesByAtom.get(atomId)?.has(style) ?? false;
  const addStyleAt = (atomId: string, style: StereoMarkerStyle): void => {
    const styles = usedStylesByAtom.get(atomId) ?? new Set<StereoMarkerStyle>();
    styles.add(style);
    usedStylesByAtom.set(atomId, styles);
  };
  const removeStyleAt = (atomId: string, style: StereoMarkerStyle): void => {
    const styles = usedStylesByAtom.get(atomId);
    if (!styles) return;
    styles.delete(style);
    if (styles.size === 0) usedStylesByAtom.delete(atomId);
  };

  const backtrack = (index: number): boolean => {
    if (index === order.length) return true;
    const plan = order[index];
    for (const candidate of plan.candidates) {
      if (used.has(candidate.bondId)) continue;
      if (
        styleIsUsedAt(plan.atomId, candidate.style) ||
        styleIsUsedAt(candidate.neighborId, candidate.style)
      ) {
        continue;
      }
      used.add(candidate.bondId);
      addStyleAt(plan.atomId, candidate.style);
      addStyleAt(candidate.neighborId, candidate.style);
      result.set(plan.atomId, candidate);
      if (backtrack(index + 1)) return true;
      used.delete(candidate.bondId);
      removeStyleAt(plan.atomId, candidate.style);
      removeStyleAt(candidate.neighborId, candidate.style);
      result.delete(plan.atomId);
    }
    return false;
  };

  return backtrack(0) ? result : null;
}

function buildProjectedMolecule(
  original: MoleculeObject,
  projected: Map<string, Projected>,
  assignment: Map<string, Candidate>
): MoleculeObject {
  const wedgeBondToCenter = new Map<string, { centerId: string; style: StereoMarkerStyle }>();
  for (const [centerId, candidate] of assignment) {
    wedgeBondToCenter.set(candidate.bondId, { centerId, style: candidate.style });
  }

  const atoms = original.atoms.map((atom) => {
    const p = projected.get(atom.id);
    return p ? { ...atom, x: p.x, y: p.y } : { ...atom };
  });

  const bonds = original.bonds.map((bond) => {
    const next: MoleculeBond = { ...bond };
    // Strip existing chirality markers; preserve cosmetic bold/dashed.
    if (isStereoStyle(bond.display?.bondStyle)) {
      const { bondStyle, ...restDisplay } = bond.display ?? {};
      void bondStyle;
      next.display = Object.keys(restDisplay).length > 0 ? restDisplay : undefined;
    }
    const wedge = wedgeBondToCenter.get(bond.id);
    if (wedge) {
      // Orient narrow end at the stereocenter (fromAtomId === center).
      if (next.fromAtomId !== wedge.centerId) {
        const swappedFrom = next.toAtomId;
        next.toAtomId = next.fromAtomId;
        next.fromAtomId = swappedFrom;
      }
      next.display = { ...(next.display ?? {}), bondStyle: wedge.style };
    }
    return next;
  });

  return { ...original, structure: "", atoms, bonds };
}

function graphDrifted(diff: MoleculeIdentityDiff): boolean {
  return (
    diff.atomCountDelta !== 0 ||
    diff.bondCountDelta !== 0 ||
    diff.atomMultisetChanged ||
    diff.bondOrderMultisetChanged ||
    diff.netChargeDelta !== 0 ||
    diff.connectivityChanged ||
    diff.isotopeLabelsChanged ||
    diff.radicalCountDelta !== 0
  );
}

function warnEdgeOnDoubleBonds(
  bonds: readonly MoleculeBond[],
  projected: Map<string, Projected>,
  edgeOnAngleDeg: number,
  warnings: FlattenWarning[]
): void {
  const adjacency = buildAdjacency(bonds);
  for (const bond of bonds) {
    if (bond.order !== "double") continue;
    const a = projected.get(bond.fromAtomId);
    const b = projected.get(bond.toAtomId);
    if (!a || !b) continue;
    const axis: Vec3 = [b.x - a.x, b.y - a.y, 0];
    if (length(axis) < 1e-9) continue;
    const substituents = [
      ...(adjacency.get(bond.fromAtomId) ?? []).filter((n) => n.atomId !== bond.toAtomId).map((n) => ({ base: a, n })),
      ...(adjacency.get(bond.toAtomId) ?? []).filter((n) => n.atomId !== bond.fromAtomId).map((n) => ({ base: b, n }))
    ];
    let edgeOn = false;
    for (const { base, n } of substituents) {
      const p = projected.get(n.atomId);
      if (!p) continue;
      const arm: Vec3 = [p.x - base.x, p.y - base.y, 0];
      if (length(arm) < 1e-9) continue;
      const cosTheta = Math.abs(dot(normalize(arm), normalize(axis)));
      const angleDeg = Math.acos(Math.min(1, cosTheta)) * (180 / Math.PI);
      if (angleDeg < edgeOnAngleDeg) edgeOn = true;
    }
    if (edgeOn) {
      warnings.push({
        code: "ez-edge-on",
        message: `Double bond ${bond.id} is viewed nearly edge-on; E/Z geometry may be unclear.`,
        bondIds: [bond.id]
      });
    }
  }
}

interface CrossingPair {
  a: MoleculeBond;
  b: MoleculeBond;
  frontIsA: boolean;
  depthGap: number;
}

function computeCrossings(
  bonds: readonly MoleculeBond[],
  projected: Map<string, Projected>,
  objectId: string,
  opts: Required<Omit<FlattenOptions, "objectId" | "stereoCenterAtomIds">>,
  medianLength: number,
  warnings: FlattenWarning[]
): CrossingOverride[] {
  const depthEpsilon = opts.crossingDepthEpsilonFraction * medianLength;
  const pairs: CrossingPair[] = [];

  for (let i = 0; i < bonds.length; i += 1) {
    for (let j = i + 1; j < bonds.length; j += 1) {
      const a = bonds[i];
      const b = bonds[j];
      // Skip bonds that share an atom (junctions are not crossings).
      if (
        a.fromAtomId === b.fromAtomId ||
        a.fromAtomId === b.toAtomId ||
        a.toAtomId === b.fromAtomId ||
        a.toAtomId === b.toAtomId
      ) {
        continue;
      }
      const p1 = projected.get(a.fromAtomId);
      const p2 = projected.get(a.toAtomId);
      const p3 = projected.get(b.fromAtomId);
      const p4 = projected.get(b.toAtomId);
      if (!p1 || !p2 || !p3 || !p4) continue;
      const hit = segmentIntersection(p1, p2, p3, p4);
      if (!hit) continue;
      const depthA = p1.z + (p2.z - p1.z) * hit.t;
      const depthB = p3.z + (p4.z - p3.z) * hit.u;
      const depthGap = Math.abs(depthA - depthB);
      const frontIsA = depthA >= depthB;
      if (depthGap < depthEpsilon) {
        warnings.push({
          code: "ambiguous-crossing-depth",
          message: `Bonds ${a.id} and ${b.id} cross at nearly equal depth; front/back is ambiguous.`,
          bondIds: [a.id, b.id]
        });
      }
      pairs.push({ a, b, frontIsA, depthGap });
    }
  }

  detectCyclicDepth(pairs, warnings);

  const ref = (bond: MoleculeBond): BondRef => ({ objectId, bondId: bond.id });
  return pairs.map((pair) => ({
    bonds: [ref(pair.a), ref(pair.b)] as [BondRef, BondRef],
    front: pair.frontIsA ? ref(pair.a) : ref(pair.b)
  }));
}

/** Detect an inconsistent "over" cycle (A over B over C over A) — an Escher knot. */
function detectCyclicDepth(pairs: readonly CrossingPair[], warnings: FlattenWarning[]): void {
  const overEdges = new Map<string, Set<string>>(); // front → backs
  const addEdge = (front: string, back: string) => {
    const set = overEdges.get(front) ?? new Set<string>();
    set.add(back);
    overEdges.set(front, set);
  };
  for (const pair of pairs) {
    const frontId = pair.frontIsA ? pair.a.id : pair.b.id;
    const backId = pair.frontIsA ? pair.b.id : pair.a.id;
    addEdge(frontId, backId);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  let hasCycle = false;

  const visit = (node: string): void => {
    color.set(node, GRAY);
    for (const next of overEdges.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        hasCycle = true;
        return;
      }
      if (c === WHITE) {
        visit(next);
        if (hasCycle) return; // stop the DFS as soon as any deeper call found a cycle
      }
    }
    color.set(node, BLACK);
  };

  for (const node of overEdges.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
    if (hasCycle) break;
  }

  if (hasCycle) {
    warnings.push({
      code: "cyclic-depth",
      message:
        "Projected crossings form an inconsistent depth cycle (Escher-like). This view cannot be realized as a clean 2D weave — try re-spinning.",
      bondIds: [...overEdges.keys()]
    });
  }
}

/** Proper segment intersection (interiors only). Returns parameters along each segment. */
function segmentIntersection(
  p1: Projected,
  p2: Projected,
  p3: Projected,
  p4: Projected
): { t: number; u: number } | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null; // parallel or degenerate
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  const EPS = 1e-9;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null;
  return { t, u };
}
