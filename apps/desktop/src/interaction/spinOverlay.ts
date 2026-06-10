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

import { projectPoint, quatToViewMatrix, type Quaternion, type Vec3 } from "./rotation3d";

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
    .map(([from, to]) => ({ from, to, depth: (atoms[from].depth + atoms[to].depth) / 2 }))
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
