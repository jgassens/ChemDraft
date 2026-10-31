import { LayoutSpatialGrid as RepairGrid, prepareLayoutLabelEvaluator, type LayoutLabelGeometry, atomNearBond, bondsOverlap, prepareLayoutTopology, evaluateLayoutQuality, type LayoutBond, type LayoutPoint, type LayoutQuality, type LayoutLabelBox, type LayoutTopology } from "./layoutQuality";

export interface LayoutOrientation { atoms: LayoutPoint[]; angleDegrees: number; ringSystemAtoms: number[]; rank: number }

/** Largest biconnected ring block horizontal, with the remaining atoms below it.
 * belowSign is +1 for document coordinates and -1 for engine (y-up) coordinates.
 * Every alternative is a proper rotation about the same centroid, never a reflection. */
export function conventionalLayoutOrientations(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[], belowSign: 1 | -1 = 1,
  topology = prepareLayoutTopology(atoms.length, bonds)
): LayoutOrientation[] {
  const ringSystemAtoms = [...topology.ringSystems].sort((a, b) => b.length - a.length || a[0] - b[0])[0] ?? [];
  if (!ringSystemAtoms.length) return [{ atoms: atoms.map(a => ({ ...a })), angleDegrees: 0, ringSystemAtoms, rank: 0 }];
  const center = ringSystemAtoms.reduce((p, i) => ({ x: p.x + atoms[i].x / ringSystemAtoms.length,
    y: p.y + atoms[i].y / ringSystemAtoms.length }), { x: 0, y: 0 });
  let xx = 0, yy = 0, xy = 0;
  for (const i of ringSystemAtoms) {
    const x = atoms[i].x - center.x, y = atoms[i].y - center.y;
    xx += x * x; yy += y * y; xy += x * y;
  }
  // An isotropic block has no preferred axis: use its first atom as the stable tie-break.
  let angle = Math.hypot(xx - yy, 2 * xy) < 1e-10 * (xx + yy)
    ? -Math.atan2(atoms[ringSystemAtoms[0]].y - center.y, atoms[ringSystemAtoms[0]].x - center.x)
    : -0.5 * Math.atan2(2 * xy, xx - yy);
  const ring = new Set(ringSystemAtoms);
  const restY = atoms.reduce((sum, a, i) => ring.has(i) ? sum :
    sum + (a.x - center.x) * Math.sin(angle) + (a.y - center.y) * Math.cos(angle), 0);
  if (restY * belowSign < -1e-10) angle += Math.PI;
  return [0, 180, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150].map((offset, rank) => {
    const radians = angle + offset * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
    return { ringSystemAtoms, rank, angleDegrees: ((radians * 180 / Math.PI + 540) % 360) - 180,
      atoms: atoms.map(a => ({ x: center.x + (a.x - center.x) * c - (a.y - center.y) * s,
        y: center.y + (a.x - center.x) * s + (a.y - center.y) * c })) };
  });
}

/** Text stays upright after a rotation, so replan its boxes at each orientation. */
export function orientLayoutForLabels(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[], labelBoxes: (points: readonly LayoutPoint[]) => readonly LayoutLabelBox[],
  belowSign: 1 | -1 = 1, topology?: LayoutTopology
): LayoutOrientation {
  const graph = topology ?? prepareLayoutTopology(atoms.length, bonds);
  let best: LayoutOrientation | undefined, defects = Infinity;
  for (const orientation of conventionalLayoutOrientations(atoms, bonds, belowSign, graph)) {
    const q = evaluateLayoutQuality(orientation.atoms, bonds, undefined, graph, {
      overlappingAtoms: [], crossings: [], collinearBondOverlaps: [], atomBondOverlaps: [],
      nearestAtomPairDistance: Infinity, nearestNonBondedAtomPairDistance: Infinity
    }, labelBoxes(orientation.atoms));
    if (q.hardDefects < defects) { best = orientation; defects = q.hardDefects; }
    if (defects === 0) break;
  }
  return best!;
}

export interface LayoutRepairOptions {
  labelBoxes?: (points: readonly LayoutPoint[]) => readonly LayoutLabelBox[];
  conventionalOrientation?: boolean;
  belowSign?: 1 | -1;
}

/** A deterministic cap for the entire candidate, independent of machine speed. Exhaustion
 * discards partial results rather than selecting a repair from a truncated search. */
export const MAX_LAYOUT_REPAIR_TRIALS = 1024;

/** Includes orientation attempts, label planning, translated boxes and spatial contact
 * evaluations. In particular, twelve orientations are never one unit of trial work. */
export const MAX_LAYOUT_REPAIR_EVALUATIONS = 131_072;
const exhaustedRepairBudget = Symbol("exhausted repair budget");

export interface LayoutRepair {
  atoms: LayoutPoint[];
  quality: LayoutQuality;
  kind: "spiro rotation" | "bridge swing" | "substituent swing";
  pivot: number;
  movedAtoms: number[];
  angleDegrees: number;
  /** Whole-layout rotation after the fragment swing. */
  rotationDegrees?: number;
  orientationRank?: number;
}

/** Strict before relaxed, then conventional orientation, soft distortion and non-bonded clearance.
 * Exact ties retain enumeration order. */
export function compareLayoutRepairs(a: LayoutRepair, b: LayoutRepair): number {
  const strict = Number(b.quality.passes) - Number(a.quality.passes);
  return strict || (a.orientationRank ?? 0) - (b.orientationRank ?? 0) || a.quality.softScore - b.quality.softScore ||
    (a.quality.nearestNonBondedAtomPairDistance === b.quality.nearestNonBondedAtomPairDistance ? 0 :
      b.quality.nearestNonBondedAtomPairDistance - a.quality.nearestNonBondedAtomPairDistance);
}

/** Pure, rotation-only alternatives for atom or label overlaps. Cutting at an articulation atom
 * or an acyclic edge keeps every cyclic block rigid (including all attached downstream atoms).
 * All passing alternatives are returned in preference order so a caller can reject a rotation
 * on stereo read-back and still try the next one. No coordinates are changed in the input.
 * Search is deliberately bounded to one move: no combinations or ring deformation. */
export function repairLayoutOverlaps(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[], options: LayoutRepairOptions = {}
): LayoutRepair[] {
  try { return searchLayoutRepairs(atoms, bonds, options); }
  catch (error) { if (error === exhaustedRepairBudget) return []; throw error; }
}

function searchLayoutRepairs(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[], options: LayoutRepairOptions
): LayoutRepair[] {
  let evaluations = 0;
  const work = (count = 1) => {
    evaluations += count;
    if (evaluations > MAX_LAYOUT_REPAIR_EVALUATIONS) throw exhaustedRepairBudget;
  };
  const topology = prepareLayoutTopology(atoms.length, bonds);
  work(atoms.length);
  const originalLabels = options.labelBoxes?.(atoms) ?? [];
  const skeleton = evaluateLayoutQuality(atoms, bonds, undefined, topology);
  const originalLabelGeometry = prepareLayoutLabelEvaluator(atoms, bonds, originalLabels,
    skeleton.referenceBondLength, undefined, work)();
  const original = evaluateLayoutQuality(atoms, bonds, skeleton.referenceBondLength, topology, skeleton,
    [], [], originalLabelGeometry);
  if ((!original.overlappingAtoms.length && !original.labelBondOverlaps.length && !original.labelLabelOverlaps.length) || original.crossings.length || original.hasBridgedRings ||
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
  for (const edgeIndex of topology.acyclicBonds) {
    const edge = bonds[edgeIndex];
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
  // Cache upright box sizes/offsets once per whole-layout orientation. Fragment swings
  // change positions, not label chemistry. Work in an origin-centred frame so translations
  // introduced by the conventional ring-centroid pivot do not invalidate the cache.
  const planned = new Map<number, { atoms: readonly LayoutPoint[]; labels: readonly LayoutLabelBox[] }>(
    [[0, { atoms, labels: originalLabels }]]);
  let trials = 0;
  for (const move of moves) {
    const moving = new Set(move.movedAtoms);
    if (!options.labelBoxes && !original.overlappingAtoms.some(([a, b]) => moving.has(a) !== moving.has(b))) continue;
    // A rigid move cannot fix a defect whose participants all stay on the same side.
    const mobileBond = bonds.map(b => moving.has(b.from) || moving.has(b.to));
    if (original.overlappingAtoms.some(([a, b]) => moving.has(a) === moving.has(b)) ||
        original.atomBondOverlaps.some(([a, b]) => moving.has(a) === mobileBond[b]) ||
        original.collinearBondOverlaps.some(([a, b]) => mobileBond[a] === mobileBond[b])) continue;
    const atomGrid = new RepairGrid(original.referenceBondLength);
    const bondGrid = new RepairGrid(original.referenceBondLength);
    atoms.forEach((a, i) => { if (!moving.has(i)) atomGrid.add(i, a); });
    bonds.forEach((b, i) => { if (!mobileBond[i]) bondGrid.add(i, atoms[b.from], atoms[b.to]); });
    const reference = original.referenceBondLength;
    const labelEvaluators = new Map<number, ReturnType<typeof prepareLayoutLabelEvaluator>>();
    const checkLabels = (points: readonly LayoutPoint[], degrees: number): LayoutLabelGeometry => {
      const key = Math.round((((degrees % 360) + 360) % 360) * 1e8) % 36_000_000_000;
      let base = planned.get(key);
      if (!base) {
        work(atoms.length);
        const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
        const oriented = atoms.map(a => ({ x: a.x * c - a.y * s, y: a.x * s + a.y * c }));
        base = { atoms: oriented, labels: options.labelBoxes?.(oriented) ?? [] };
        planned.set(key, base);
      }
      let evaluate = labelEvaluators.get(key);
      if (!evaluate) {
        evaluate = prepareLayoutLabelEvaluator(base.atoms, bonds, base.labels, reference, moving, work);
        labelEvaluators.set(key, evaluate);
      }
      const labels = base.labels.map(box => {
        work();
        const p = points[box.atom], a = base.atoms[box.atom];
        return { ...box, x: box.x + p.x - a.x, y: box.y + p.y - a.y };
      });
      return evaluate(points, labels);
    };
    // Intra-fragment pair distances are invariant. Compute their minima once per move;
    // the spatial queries below update them with only pairs straddling the cut.
    const bonded = new Set(bonds.map(b => `${Math.min(b.from, b.to)}:${Math.max(b.from, b.to)}`));
    let invariantNearest = Infinity, invariantNonBonded = Infinity;
    for (let i = 0; i < atoms.length; i++) for (let j = i + 1; j < atoms.length; j++) {
      if (moving.has(i) !== moving.has(j)) continue;
      const d = Math.hypot(atoms[i].x - atoms[j].x, atoms[i].y - atoms[j].y) / reference;
      invariantNearest = Math.min(invariantNearest, d);
      if (!bonded.has(`${i}:${j}`)) invariantNonBonded = Math.min(invariantNonBonded, d);
    }
    // A finite upper bound for the rare case where neither rigid part has a nonbonded pair.
    const radiusBound = 2 * Math.max(reference, ...atoms.map(a =>
      Math.hypot(a.x - atoms[move.pivot].x, a.y - atoms[move.pivot].y))) / reference + 1;
    const nearestPairs = (rotated: LayoutPoint[]) => {
      let nearestAtomPairDistance = invariantNearest;
      let nearestNonBondedAtomPairDistance = invariantNonBonded;
      for (const i of move.movedAtoms) {
        const p = rotated[i];
        const radius = Math.max(nearestAtomPairDistance, nearestNonBondedAtomPairDistance);
        for (const j of atomGrid.query(p, p, (Number.isFinite(radius) ? radius : radiusBound) * reference)) {
          const d = Math.hypot(p.x - atoms[j].x, p.y - atoms[j].y) / reference;
          nearestAtomPairDistance = Math.min(nearestAtomPairDistance, d);
          if (!bonded.has(`${Math.min(i, j)}:${Math.max(i, j)}`)) nearestNonBondedAtomPairDistance = Math.min(nearestNonBondedAtomPairDistance, d);
        }
      }
      return { nearestAtomPairDistance, nearestNonBondedAtomPairDistance };
    };
    const locallyClear = (rotated: LayoutPoint[]) => {
      for (const i of move.movedAtoms) {
        const p = rotated[i];
        for (const j of atomGrid.query(p, p, reference * 0.5)) {
          if (Math.hypot(p.x - atoms[j].x, p.y - atoms[j].y) < reference * 0.5) return false;
        }
        for (const j of bondGrid.query(p, p, reference * 0.25)) {
          const b = bonds[j];
          if (i !== b.from && i !== b.to && atomNearBond(p, atoms[b.from], atoms[b.to], reference)) return false;
        }
      }
      for (let i = 0; i < bonds.length; i++) {
        if (!mobileBond[i]) continue;
        const b = bonds[i], p = rotated[b.from], q = rotated[b.to];
        for (const j of atomGrid.query(p, q, reference * 0.25)) {
          if (j !== b.from && j !== b.to && atomNearBond(atoms[j], p, q, reference)) return false;
        }
        for (const j of bondGrid.query(p, q)) {
          const other = bonds[j];
          if (bondsOverlap(p, q, atoms[other.from], atoms[other.to], reference)) return false;
        }
      }
      return true;
    };
    for (let angleDegrees = -move.limit; angleDegrees <= move.limit; angleDegrees += 2) {
      if (angleDegrees === 0 || (move.limit === 180 && angleDegrees === 180)) continue;
      if (++trials > MAX_LAYOUT_REPAIR_TRIALS) return [];
      work();
      const angle = angleDegrees * Math.PI / 180;
      const c = Math.cos(angle), s = Math.sin(angle), p = atoms[move.pivot];
      const rotated = atoms.map((a, i) => moving.has(i) ? {
        x: p.x + (a.x - p.x) * c - (a.y - p.y) * s,
        y: p.y + (a.x - p.x) * s + (a.y - p.y) * c
      } : { ...a });
      const angles = adjacent[move.pivot].map(i => Math.atan2(rotated[i].y - p.y, rotated[i].x - p.x));
      if (angles.some((a, i) => angles.slice(i + 1).some(b =>
        Math.acos(Math.max(-1, Math.min(1, Math.cos(a - b)))) < Math.PI / 6 - 1e-9))) continue;
      if (!locallyClear(rotated)) continue;
      // Local checks plus rigid-part invariants establish zero hard defects. Reuse that
      // snapshot: scoring recomputes bond/ring metrics, never global pair geometry or topology.
      let orientation: LayoutOrientation | undefined;
      let labelGeometry: LayoutLabelGeometry | undefined;
      let defects = Infinity;
      const orientations = options.conventionalOrientation
        ? conventionalLayoutOrientations(rotated, bonds, options.belowSign, topology)
        : [{ atoms: rotated, angleDegrees: 0, ringSystemAtoms: [], rank: 0 }];
      for (const candidate of orientations) {
        work(atoms.length + 1);
        const a = candidate.angleDegrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const points = rotated.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
        const labels = checkLabels(points, candidate.angleDegrees);
        const count = labels.labelBondOverlaps.length + labels.labelLabelOverlaps.length;
        if (count < defects) { defects = count; orientation = candidate; labelGeometry = labels; }
        if (!defects) break;
      }
      if (defects) continue;
      const points = orientation?.atoms ?? rotated;
      const quality = evaluateLayoutQuality(points, bonds, reference, topology, {
        ...nearestPairs(rotated), overlappingAtoms: [], atomBondOverlaps: [],
        crossings: [], collinearBondOverlaps: []
      }, [], [], labelGeometry);
      if (quality.passes || quality.passesRelaxed) repairs.push({ atoms: points, quality,
        kind: move.kind, pivot: move.pivot, movedAtoms: move.movedAtoms, angleDegrees,
        ...(options.conventionalOrientation && orientation ? { rotationDegrees: orientation.angleDegrees, orientationRank: orientation.rank } : {}) });
    }
  }
  return repairs.sort(compareLayoutRepairs);
}
