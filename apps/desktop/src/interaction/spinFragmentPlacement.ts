import { quatConjugate, rotateVectorByQuat, type Quaternion } from "./rotation3d";
import { conformerCentroid, medianBondLength3d, overlayScale } from "./spinOverlay";

type BondPair = readonly [number, number];
export type SpinFragmentArrangement = {
  /** Opening centres relative to the molecule centroid, in page px in the conformer's frame.
   * Independent of the embedded/refined ScreenPlacement.scale and the user's live rotation. */
  fragments: { indices: number[]; targetPage: readonly [number, number, number] }[];
};

/** Connected components in original-atom order, including isolated atoms. */
export function spinFragmentIndices(atomCount: number, bondPairs: readonly BondPair[]): number[][] {
  const neighbors: number[][] = Array.from({ length: atomCount }, () => []);
  for (const [a, b] of bondPairs) {
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  const seen = new Set<number>();
  const fragments: number[][] = [];
  for (let atom = 0; atom < atomCount; atom++) {
    if (seen.has(atom)) continue;
    const indices = [atom];
    seen.add(atom);
    for (let cursor = 0; cursor < indices.length; cursor++) {
      for (const neighbor of neighbors[indices[cursor]]) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        indices.push(neighbor);
      }
    }
    fragments.push(indices);
  }
  return fragments;
}

/**
 * Engines embed disconnected fragments independently, often at the same origin.
 * Translate each intact conformer to its drawn centroid in the opening view's
 * plane (z centred), using the SAME bond-length scale as ScreenPlacement.
 * Uniformly expand that arrangement only as far as bounding spheres require.
 * This is done once on fresh engine results, never on persisted/reopened models;
 * overlay, rotation and flatten then all consume the same separated coordinates.
 * Refinement must use the embedded stage's opening orientation, even after a drag.
 * Connected molecules have no fragment arrangement.
 */
export function computeSpinFragmentArrangement(
  points2d: readonly { x: number; y: number }[],
  coords3d: Float64Array,
  bondPairs: readonly BondPair[],
  openingOrientation: Quaternion
): SpinFragmentArrangement | undefined {
  const fragments = spinFragmentIndices(points2d.length, bondPairs);
  if (fragments.length < 2) return undefined;

  const scale = overlayScale(points2d, coords3d, bondPairs);
  const gap = medianBondLength3d(coords3d, bondPairs) || 1;
  const centers = fragments.map((indices) => {
    const local = indices.flatMap((index) => Array.from(coords3d.subarray(index * 3, index * 3 + 3)));
    const center = conformerCentroid(local);
    const radius = indices.reduce((largest, index) => Math.max(largest, Math.hypot(
      coords3d[index * 3] - center[0],
      coords3d[index * 3 + 1] - center[1],
      coords3d[index * 3 + 2] - center[2]
    )), 0);
    return {
      indices, center, radius,
      x: indices.reduce((sum, index) => sum + points2d[index].x, 0) / indices.length / scale,
      y: -indices.reduce((sum, index) => sum + points2d[index].y, 0) / indices.length / scale
    };
  });

  // Coincident drawn centres have no direction to preserve. Give just those centres
  // a deterministic +X separation before expanding the complete arrangement.
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y) < 1e-9) {
        centers[i].x = Math.max(...centers.map((center) => center.x)) + centers[i].radius + centers[j].radius + gap;
      }
    }
  }
  let expansion = 1;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < i; j++) {
      const distance = Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y);
      expansion = Math.max(expansion, (centers[i].radius + centers[j].radius + gap) / distance);
    }
  }
  const centerX = centers.reduce((sum, center) => sum + center.x * center.indices.length, 0) / points2d.length;
  const centerY = centers.reduce((sum, center) => sum + center.y * center.indices.length, 0) / points2d.length;
  const inverseOpening = quatConjugate(openingOrientation);
  return { fragments: centers.map((fragment) => ({
    indices: fragment.indices,
    targetPage: rotateVectorByQuat(inverseOpening, [
      (fragment.x - centerX) * expansion * scale, (fragment.y - centerY) * expansion * scale, 0
    ])
  })) };
}

/** Convert opening page targets with THIS stage's placement scale. For each later fragment, resolve overlapping earlier spheres by
 * moving only that fragment along the current pair's centre-to-centre direction, by the
 * overlap distance plus a tiny clearance. Recheck earlier pairs after every correction.
 * At most fragments² corrections per fragment; if trapped between earlier spheres, place it
 * beyond all their projected extents along its opening direction from the first centre.
 * Earlier spheres stay fixed. projectSpin/flatten both recenter the resulting whole conformer. */
export function applySpinFragmentArrangement(coords3d: Float64Array, arrangement: SpinFragmentArrangement, scale: number): Float64Array {
  if (arrangement.fragments.length < 2) return coords3d;
  const placed = new Float64Array(coords3d);
  const spheres: { center: [number, number, number]; radius: number }[] = [];
  for (const fragment of arrangement.fragments) {
    const center = conformerCentroid(fragment.indices.flatMap((index) => Array.from(coords3d.subarray(index * 3, index * 3 + 3))));
    const radius = fragment.indices.reduce((largest, index) => Math.max(largest, Math.hypot(
      coords3d[index * 3] - center[0], coords3d[index * 3 + 1] - center[1], coords3d[index * 3 + 2] - center[2]
    )), 0);
    const target: [number, number, number] = [fragment.targetPage[0] / scale, fragment.targetPage[1] / scale, fragment.targetPage[2] / scale];
    const openingTarget = [...target];
    let corrections = 0;
    const maxCorrections = arrangement.fragments.length ** 2;
    for (let j = 0; j < spheres.length;) {
      const other = spheres[j];
      const delta = target.map((value, axis) => value - other.center[axis]);
      const distance = Math.hypot(...delta);
      const required = radius + other.radius;
      if (distance < required) {
        if (corrections >= maxCorrections) {
          // A projection gap at least as large as the radii sum guarantees a 3D gap,
          // even when earlier centres are not collinear. This bounded fallback also
          // handles coincident targets (deterministically along +X).
          const origin = spheres[0].center;
          const delta = openingTarget.map((value, axis) => value - origin[axis]);
          const length = Math.hypot(...delta);
          const direction = length > 0 ? delta.map((value) => value / length) : [1, 0, 0];
          const extent = Math.max(...spheres.map((sphere) =>
            sphere.center.reduce((sum, value, axis) => sum + (value - origin[axis]) * direction[axis], 0) + sphere.radius));
          const clearance = Math.max(1, Math.abs(extent), radius) * 1e-12;
          for (let axis = 0; axis < 3; axis++) target[axis] = origin[axis] + direction[axis] * (extent + radius + clearance);
          break;
        }
        const direction = distance > 0 ? delta.map((value) => value / distance) : [1, 0, 0];
        const shift = required - distance + Math.max(1, required) * 1e-12;
        for (let axis = 0; axis < 3; axis++) target[axis] += direction[axis] * shift;
        corrections++;
        j = 0;
      } else j++;
    }
    spheres.push({ center: target, radius });
    for (const index of fragment.indices) {
      for (let axis = 0; axis < 3; axis++) {
        placed[index * 3 + axis] += target[axis] - center[axis];
      }
    }
  }
  return placed;
}

export function placeSpinFragments(points2d: readonly { x: number; y: number }[], coords3d: Float64Array, bondPairs: readonly BondPair[], openingOrientation: Quaternion): Float64Array {
  const arrangement = computeSpinFragmentArrangement(points2d, coords3d, bondPairs, openingOrientation);
  return arrangement ? applySpinFragmentArrangement(coords3d, arrangement, overlayScale(points2d, coords3d, bondPairs)) : coords3d;
}
