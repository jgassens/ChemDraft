/**
 * Phase 4 — pure projection math for the in-canvas 3D spin overlay.
 *
 * Sibling to `rotation3d.ts` / `camera.ts`: no React, no DOM, fully unit-tested.
 * Given a 3D conformer and the current trackball orientation, it produces
 * screen-space atom positions and depth-sorted bonds so the overlay renderer can
 * paint in painter's order (far → near) and occlusion reads correctly while
 * spinning.
 *
 * FRAME: the conformer is in the math frame (y up, z toward viewer). Screen output
 * is in the document frame (y DOWN), so projected y is negated here — the same
 * convention the flatten commit (Phase 5) uses. The overlay never mutates the
 * document; it is transient until the user releases (Phase 5) or presses Esc.
 */

import type { ViewMatrix } from "@chemdraft/chem-core";
import {
  projectPoint,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatToViewMatrix,
  type Quaternion,
  type Vec3
} from "./rotation3d";

function vlen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function vnorm(v: Vec3): Vec3 {
  const len = vlen(v);
  return len < 1e-12 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}
function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function vcross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Symmetric 3×3 eigen-decomposition via cyclic Jacobi rotations. Returns eigenvalues
 * and their (column) eigenvectors. Used only for the small covariance matrix below.
 */
function jacobiEigen3(input: readonly (readonly number[])[]): { values: number[]; vectors: Vec3[] } {
  const m = input.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let p = 0;
    let q = 1;
    let max = Math.abs(m[0][1]);
    if (Math.abs(m[0][2]) > max) {
      max = Math.abs(m[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(m[1][2]) > max) {
      max = Math.abs(m[1][2]);
      p = 1;
      q = 2;
    }
    if (max < 1e-12) break;
    const phi = 0.5 * Math.atan2(2 * m[p][q], m[p][p] - m[q][q]);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < 3; k += 1) {
      const mkp = m[k][p];
      const mkq = m[k][q];
      m[k][p] = c * mkp - s * mkq;
      m[k][q] = s * mkp + c * mkq;
    }
    for (let k = 0; k < 3; k += 1) {
      const mpk = m[p][k];
      const mqk = m[q][k];
      m[p][k] = c * mpk - s * mqk;
      m[q][k] = s * mpk + c * mqk;
    }
    for (let k = 0; k < 3; k += 1) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  return {
    values: [m[0][0], m[1][1], m[2][2]],
    vectors: [0, 1, 2].map((col): Vec3 => [v[0][col], v[1][col], v[2][col]])
  };
}

/**
 * A readable opening orientation for a freshly generated conformer. OCL embeds at an
 * arbitrary angle that often projects edge-on; this turns the molecule's principal
 * plane (smallest-variance axis = best-fit plane normal) toward the viewer, then adds
 * a gentle tilt so it still reads as 3D rather than a flat 2D copy.
 */
export function initialViewQuaternion(coords3d: ArrayLike<number>): Quaternion {
  const n = coords3d.length / 3;
  if (n < 3) return quatIdentity();
  const c = conformerCentroid(coords3d);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let i = 0; i < n; i += 1) {
    const dx = coords3d[i * 3] - c[0];
    const dy = coords3d[i * 3 + 1] - c[1];
    const dz = coords3d[i * 3 + 2] - c[2];
    cov[0][0] += dx * dx;
    cov[0][1] += dx * dy;
    cov[0][2] += dx * dz;
    cov[1][1] += dy * dy;
    cov[1][2] += dy * dz;
    cov[2][2] += dz * dz;
  }
  cov[1][0] = cov[0][1];
  cov[2][0] = cov[0][2];
  cov[2][1] = cov[1][2];

  const { values, vectors } = jacobiEigen3(cov);
  let minIndex = 0;
  if (values[1] < values[minIndex]) minIndex = 1;
  if (values[2] < values[minIndex]) minIndex = 2;
  const normal = vnorm(vectors[minIndex]);
  if (vlen(normal) < 1e-9) return quatIdentity();

  const target: Vec3 = [0, 0, 1]; // toward the viewer
  const d = clamp(vdot(normal, target), -1, 1);
  let faceOn: Quaternion;
  if (d > 0.9999) {
    faceOn = quatIdentity();
  } else if (d < -0.9999) {
    faceOn = quatFromAxisAngle([1, 0, 0], Math.PI);
  } else {
    faceOn = quatFromAxisAngle(vcross(normal, target), Math.acos(d));
  }
  // Gentle 3/4 tilt (~23°) so the depth reads without foreshortening the rings.
  const tilt = quatFromAxisAngle([1, 0.5, 0], 0.4);
  return quatNormalize(quatMultiply(tilt, faceOn));
}

export interface ScreenPlacement {
  /** Document-space center the overlay is drawn around (the molecule's 2D centroid). */
  centerX: number;
  centerY: number;
  /** Document px per conformer unit (≈ median 2D bond length / median 3D bond length). */
  scale: number;
}

export interface SpinAtom {
  index: number;
  sx: number;
  sy: number;
  depth: number; // rotated z; larger = nearer the viewer
}

export interface SpinBond {
  from: number;
  to: number;
  /** Index into the caller's bondPairs array (stable across the depth sort), so the
   *  renderer can look up per-bond data such as bond order. */
  index: number;
  depth: number; // average endpoint depth; used for painter's-order sort
}

export interface SpinProjection {
  atoms: SpinAtom[];
  /** Bonds sorted far → near (ascending depth) for painter's-order rendering. */
  bonds: SpinBond[];
}

type BondPair = readonly [number, number];

function atomAt(coords3d: ArrayLike<number>, index: number): Vec3 {
  return [coords3d[index * 3], coords3d[index * 3 + 1], coords3d[index * 3 + 2]];
}

/** Centroid of the conformer (so rotation pivots about the molecule's center). */
export function conformerCentroid(coords3d: ArrayLike<number>): Vec3 {
  const n = coords3d.length / 3;
  if (n === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i += 1) {
    x += coords3d[i * 3];
    y += coords3d[i * 3 + 1];
    z += coords3d[i * 3 + 2];
  }
  return [x / n, y / n, z / n];
}

/** Median 3D bond length over the given bond pairs (0 if none measurable). */
export function medianBondLength3d(coords3d: ArrayLike<number>, bondPairs: readonly BondPair[]): number {
  const lengths = bondPairs
    .map(([a, b]) => {
      const pa = atomAt(coords3d, a);
      const pb = atomAt(coords3d, b);
      return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    })
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  return median(lengths);
}

/** Median 2D bond length over the given bond pairs of screen/page atoms. */
export function medianBondLength2d(
  points: readonly { x: number; y: number }[],
  bondPairs: readonly BondPair[]
): number {
  const lengths = bondPairs
    .map(([a, b]) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  return median(lengths);
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Project a spun conformer to screen space. Atoms are centered on the conformer
 * centroid, rotated by `quat`, orthographically projected, scaled, and placed
 * around `placement.center`. Projected y is negated (math y-up → document y-down).
 * Bonds come back sorted far → near.
 */
export function projectSpin(
  coords3d: ArrayLike<number>,
  bondPairs: readonly BondPair[],
  quat: Quaternion,
  placement: ScreenPlacement
): SpinProjection {
  const centroid = conformerCentroid(coords3d);
  const matrix = quatToViewMatrix(quat);
  const atomCount = coords3d.length / 3;

  const atoms: SpinAtom[] = [];
  for (let i = 0; i < atomCount; i += 1) {
    const centered: Vec3 = [
      coords3d[i * 3] - centroid[0],
      coords3d[i * 3 + 1] - centroid[1],
      coords3d[i * 3 + 2] - centroid[2]
    ];
    const [px, py, depth] = projectPoint(matrix, centered);
    atoms.push({
      index: i,
      sx: placement.centerX + px * placement.scale,
      sy: placement.centerY - py * placement.scale, // math y-up → document y-down
      depth
    });
  }

  const bonds: SpinBond[] = bondPairs
    .map(([from, to], index) => ({ from, to, index, depth: (atoms[from].depth + atoms[to].depth) / 2 }))
    .sort((a, b) => a.depth - b.depth); // far first (painter's order)

  return { atoms, bonds };
}

/**
 * The document px / conformer unit scale that makes the spun molecule render at the
 * same bond length the user drew. Falls back to 1 when either length is unmeasurable.
 */
export function overlayScale(
  drawn2dPoints: readonly { x: number; y: number }[],
  coords3d: ArrayLike<number>,
  bondPairs: readonly BondPair[]
): number {
  const drawn = medianBondLength2d(drawn2dPoints, bondPairs);
  const conformer = medianBondLength3d(coords3d, bondPairs);
  if (drawn <= 0 || conformer <= 0) return 1;
  return drawn / conformer;
}

/**
 * Per-bond perspective depth weight (0 = farthest … 1 = nearest), or `undefined` for a
 * near-planar view with no meaningful depth spread.
 *
 * IMPORTANT: this is the SAME recipe `flattenSpunMolecule` (documentWorkflow.ts) bakes into
 * `display.depthWeight` on commit — mean rotated z of a bond's endpoints, normalized over
 * the bond-depth span, gated when the span is below 12% of the median 3D bond length. The
 * live spin overlay must depth-cue strokes identically, or releasing the spin would visibly
 * re-shade the bonds. Keep the two in sync.
 */
export function bondDepthWeights(
  coords3d: ArrayLike<number>,
  bondPairs: readonly BondPair[],
  viewMatrix: ViewMatrix
): (number | undefined)[] {
  const depthOf = (index: number): number =>
    viewMatrix[8] * coords3d[index * 3] +
    viewMatrix[9] * coords3d[index * 3 + 1] +
    viewMatrix[10] * coords3d[index * 3 + 2] +
    viewMatrix[11];
  const bondDepths = bondPairs.map(([a, b]) => (depthOf(a) + depthOf(b)) / 2);
  if (bondDepths.length < 2) return bondDepths.map(() => undefined);

  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const depth of bondDepths) {
    if (depth < minDepth) minDepth = depth;
    if (depth > maxDepth) maxDepth = depth;
  }
  const depthSpan = maxDepth - minDepth;
  const median3d = medianBondLength3d(coords3d, bondPairs);
  // Below this threshold the view is effectively planar — no depth cue (matches flatten).
  if (depthSpan <= median3d * 0.12) return bondDepths.map(() => undefined);
  return bondDepths.map((depth) => Math.round(((depth - minDepth) / depthSpan) * 100) / 100);
}
