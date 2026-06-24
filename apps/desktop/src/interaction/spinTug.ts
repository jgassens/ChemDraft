import { projectPoint, quatToViewMatrix, type Quaternion, type Vec3 } from "./rotation3d";
import type { SpinProjection } from "./spinOverlay";

export type SpinTugTarget =
  | { kind: "atom"; atomIndices: readonly number[]; atomIndex: number }
  | { kind: "bond"; atomIndices: readonly number[]; bondIndex: number };

type BondPair = readonly [number, number];

export function conformerCentroid(coords3d: ArrayLike<number>): Vec3 {
  const n = Math.floor(coords3d.length / 3);
  if (n <= 0) return [0, 0, 0];
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

/** Map a page-space drag into model coordinates for the current orthographic view. */
export function screenDeltaToModel(pageDx: number, pageDy: number, placementScale: number, quat: Quaternion): Vec3 {
  const scale = Math.abs(placementScale) > 1e-9 ? placementScale : 1;
  // projectSpin maps model [x,y,z] -> page [x, -y], so document-y drag is inverted here.
  const viewDelta: Vec3 = [pageDx / scale, -pageDy / scale, 0];
  const matrix = quatToViewMatrix(quat);
  // Rotation inverse = transpose. Only the upper-left 3x3 matters.
  return [
    matrix[0] * viewDelta[0] + matrix[4] * viewDelta[1] + matrix[8] * viewDelta[2],
    matrix[1] * viewDelta[0] + matrix[5] * viewDelta[1] + matrix[9] * viewDelta[2],
    matrix[2] * viewDelta[0] + matrix[6] * viewDelta[1] + matrix[10] * viewDelta[2]
  ];
}

export function moveSpinAtomsKeepingCentroid(
  coords3d: ArrayLike<number>,
  atomIndices: readonly number[],
  delta: Vec3
): Float64Array {
  const out = Float64Array.from(coords3d);
  const n = Math.floor(out.length / 3);
  const moved = new Set(atomIndices.filter((index) => index >= 0 && index < n));
  if (moved.size === 0) return out;
  const before = conformerCentroid(out);
  for (const atom of moved) {
    out[atom * 3] += delta[0];
    out[atom * 3 + 1] += delta[1];
    out[atom * 3 + 2] += delta[2];
  }
  const after = conformerCentroid(out);
  const correction: Vec3 = [before[0] - after[0], before[1] - after[1], before[2] - after[2]];
  for (let atom = 0; atom < n; atom += 1) {
    out[atom * 3] += correction[0];
    out[atom * 3 + 1] += correction[1];
    out[atom * 3 + 2] += correction[2];
  }
  return out;
}

export function recenterConformer(coords3d: ArrayLike<number>, targetCentroid: Vec3): Float64Array {
  const out = Float64Array.from(coords3d);
  const current = conformerCentroid(out);
  const dx = targetCentroid[0] - current[0];
  const dy = targetCentroid[1] - current[1];
  const dz = targetCentroid[2] - current[2];
  for (let atom = 0; atom < out.length / 3; atom += 1) {
    out[atom * 3] += dx;
    out[atom * 3 + 1] += dy;
    out[atom * 3 + 2] += dz;
  }
  return out;
}

function distancePointToSegment(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function connectedComponent(start: number, blocked: BondPair, bondPairs: readonly BondPair[], atomCount: number): Set<number> {
  const queue = [start];
  const seen = new Set<number>([start]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const [a, b] of bondPairs) {
      if ((a === blocked[0] && b === blocked[1]) || (a === blocked[1] && b === blocked[0])) continue;
      const next = a === current ? b : b === current ? a : -1;
      if (next < 0 || next >= atomCount || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function tugAtomsForBond(pair: BondPair, bondPairs: readonly BondPair[], atomCount: number): number[] | undefined {
  const left = connectedComponent(pair[0], pair, bondPairs, atomCount);
  const right = connectedComponent(pair[1], pair, bondPairs, atomCount);
  // Ring bond or malformed graph: removing the bond did not split the molecule.
  if (left.has(pair[1]) || right.has(pair[0]) || left.size + right.size !== atomCount) return undefined;
  const chosen = left.size <= right.size ? left : right;
  return [...chosen].sort((a, b) => a - b);
}

export function hitTestSpinTug(
  projection: SpinProjection,
  bondPairs: readonly BondPair[],
  point: { x: number; y: number },
  options: { atomRadius: number; bondRadius: number }
): SpinTugTarget | undefined {
  let nearestAtom: { index: number; distance: number } | undefined;
  for (const atom of projection.atoms) {
    const distance = Math.hypot(point.x - atom.sx, point.y - atom.sy);
    if (distance <= options.atomRadius && (!nearestAtom || distance < nearestAtom.distance)) {
      nearestAtom = { index: atom.index, distance };
    }
  }
  if (nearestAtom) {
    return { kind: "atom", atomIndex: nearestAtom.index, atomIndices: [nearestAtom.index] };
  }

  let nearestBond: { index: number; distance: number; atomIndices: number[] } | undefined;
  for (let index = 0; index < bondPairs.length; index += 1) {
    const [from, to] = bondPairs[index];
    const a = projection.atoms[from];
    const b = projection.atoms[to];
    if (!a || !b) continue;
    const distance = distancePointToSegment(point, { x: a.sx, y: a.sy }, { x: b.sx, y: b.sy });
    if (distance > options.bondRadius || (nearestBond && distance >= nearestBond.distance)) continue;
    const atomIndices = tugAtomsForBond([from, to], bondPairs, projection.atoms.length);
    if (!atomIndices || atomIndices.length === 0) continue;
    nearestBond = { index, distance, atomIndices };
  }
  return nearestBond ? { kind: "bond", bondIndex: nearestBond.index, atomIndices: nearestBond.atomIndices } : undefined;
}

export function projectModelDelta(delta: Vec3, quat: Quaternion): Vec3 {
  return projectPoint(quatToViewMatrix(quat), delta);
}
