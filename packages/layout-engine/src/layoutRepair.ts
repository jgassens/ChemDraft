import { evaluateLayoutQuality, type LayoutBond, type LayoutPoint, type LayoutQuality } from "./layoutQuality";

export interface LayoutRepair {
  atoms: LayoutPoint[];
  quality: LayoutQuality;
  kind: "spiro rotation" | "bridge swing" | "substituent swing";
  pivot: number;
  movedAtoms: number[];
  angleDegrees: number;
}

/** Strict before relaxed, then least soft distortion, then greatest non-bonded clearance.
 * Exact ties retain enumeration order. */
export function compareLayoutRepairs(a: LayoutRepair, b: LayoutRepair): number {
  const strict = Number(b.quality.passes) - Number(a.quality.passes);
  return strict || a.quality.softScore - b.quality.softScore ||
    (a.quality.nearestNonBondedAtomPairDistance === b.quality.nearestNonBondedAtomPairDistance ? 0 :
      b.quality.nearestNonBondedAtomPairDistance - a.quality.nearestNonBondedAtomPairDistance);
}

/** Pure, rotation-only alternatives for overlap-only defects. Cutting at an articulation atom
 * or an acyclic edge keeps every cyclic block rigid (including all attached downstream atoms).
 * All passing alternatives are returned in preference order so a caller can reject a rotation
 * on stereo read-back and still try the next one. No coordinates are changed in the input.
 * Search is deliberately bounded to one move: no combinations or ring deformation. */
export function repairLayoutOverlaps(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[]
): LayoutRepair[] {
  const original = evaluateLayoutQuality(atoms, bonds);
  if (!original.overlappingAtoms.length || original.crossings.length || original.hasBridgedRings ||
      original.fusedSideDefects.length) return [];
  const adjacent: number[][] = atoms.map(() => []);
  bonds.forEach(b => { adjacent[b.from].push(b.to); adjacent[b.to].push(b.from); });
  const ringAtoms = new Set(original.rings.flatMap(r => r.atoms));
  const component = (start: number, excludedAtom = -1, edge?: LayoutBond): number[] => {
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      for (const next of adjacent[node]) {
        if (next === excludedAtom || seen.has(next) || (edge &&
          ((node === edge.from && next === edge.to) || (node === edge.to && next === edge.from)))) continue;
        seen.add(next); queue.push(next);
      }
    }
    return queue.sort((a, b) => a - b);
  };
  type Move = Pick<LayoutRepair, "kind" | "pivot" | "movedAtoms"> & { limit: number };
  const moves: Move[] = [];
  // Removing a true spiro articulation separates its ring blocks. Fused rings never split.
  for (const pivot of ringAtoms) {
    const seen = new Set<number>();
    const sides: number[][] = [];
    for (const neighbour of adjacent[pivot]) {
      if (seen.has(neighbour)) continue;
      const side = component(neighbour, pivot);
      side.forEach(i => seen.add(i));
      if (adjacent[pivot].filter(i => side.includes(i)).length >= 2) sides.push(side);
    }
    sides.sort((a, b) => b.length - a.length || a[0] - b[0]);
    for (const side of sides.slice(1)) moves.push({ kind: "spiro rotation", pivot, movedAtoms: side, limit: 180 });
  }
  for (const edge of bonds) {
    const fromSide = component(edge.from, -1, edge);
    if (fromSide.includes(edge.to)) continue; // cyclic edge
    const toSide = component(edge.to, -1, edge);
    if (ringAtoms.has(edge.from) && ringAtoms.has(edge.to)) {
      const moveTo = toSide.length <= fromSide.length;
      moves.push({ kind: "bridge swing", pivot: moveTo ? edge.from : edge.to,
        movedAtoms: moveTo ? toSide : fromSide, limit: 40 });
    } else {
      for (const [pivot, side] of [[edge.from, toSide], [edge.to, fromSide]] as const) {
        if (ringAtoms.has(pivot) && side.every(i => !ringAtoms.has(i))) {
          moves.push({ kind: "substituent swing", pivot, movedAtoms: side, limit: 40 });
        }
      }
    }
  }
  const repairs: LayoutRepair[] = [];
  for (const move of moves) {
    const moving = new Set(move.movedAtoms);
    if (!original.overlappingAtoms.some(([a, b]) => moving.has(a) !== moving.has(b))) continue;
    for (let angleDegrees = -move.limit; angleDegrees <= move.limit; angleDegrees += 2) {
      if (angleDegrees === 0 || (move.limit === 180 && angleDegrees === 180)) continue;
      const angle = angleDegrees * Math.PI / 180;
      const c = Math.cos(angle), s = Math.sin(angle), p = atoms[move.pivot];
      const rotated = atoms.map((a, i) => moving.has(i) ? {
        x: p.x + (a.x - p.x) * c - (a.y - p.y) * s,
        y: p.y + (a.x - p.x) * s + (a.y - p.y) * c
      } : { ...a });
      const angles = adjacent[move.pivot].map(i => Math.atan2(rotated[i].y - p.y, rotated[i].x - p.x));
      if (angles.some((a, i) => angles.slice(i + 1).some(b =>
        Math.acos(Math.max(-1, Math.min(1, Math.cos(a - b)))) < Math.PI / 6 - 1e-9))) continue;
      const quality = evaluateLayoutQuality(rotated, bonds, original.referenceBondLength);
      if (quality.passes || quality.passesRelaxed) repairs.push({ atoms: rotated, quality,
        kind: move.kind, pivot: move.pivot, movedAtoms: move.movedAtoms, angleDegrees });
    }
  }
  return repairs.sort(compareLayoutRepairs);
}
