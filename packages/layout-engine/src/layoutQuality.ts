/** Engine-independent geometry checks. Indices refer to the supplied atom order. */
export interface LayoutPoint { x: number; y: number }
export interface LayoutBond { from: number; to: number }
export interface LayoutLabelBox { atom: number; x: number; y: number; width: number; height: number }

/** Extra clearance beyond renderer padding, in bond lengths. */
export const LABEL_CLEARANCE_PADDING = 0.04;
export interface LayoutRingQuality {
  atoms: number[];
  /** Degrees, including reflex interior angles. Only five- and six-rings have this metric. */
  maxAngleError?: number;
}
export interface LayoutQuality {
  referenceBondLength: number;
  minBondLength: number;
  maxBondLength: number;
  bondLengthStdDev: number;
  crossings: [number, number][];
  collinearBondOverlaps: [number, number][];
  overlappingAtoms: [number, number][];
  /** [atom index, bond index], excluding endpoints. */
  atomBondOverlaps: [number, number][];
  /** Fraction of referenceBondLength; Infinity when there are fewer than two atoms. */
  nearestAtomPairDistance: number;
  /** As above, excluding directly bonded pairs. */
  nearestNonBondedAtomPairDistance: number;
  rings: LayoutRingQuality[];
  fusedSideDefects: [number, number][];
  /** Topology requiring a bridged/cage depiction: shortest rings share a multi-bond path, or
   * redundant shortest faces outnumber the graph's independent cycles (e.g. cubane). */
  hasBridgedRings: boolean;
  labelBondOverlaps: [number, number][];
  labelLabelOverlaps: [number, number][];
  /** Unpadded box-to-segment distance in bond lengths. */
  smallestLabelBondClearance: number;
  hardDefects: number;
  softScore: number;
  passes: boolean;
  /** Acyclic bonds whose endpoints belong to different ring systems (bond indices). */
  bridgeBonds: number[];
  maxBridgeLength: number;
  passesRelaxed: boolean;
}

// A stretched inter-ring bridge clears peri substituents without deforming either ring system.
export const MAX_BRIDGE_STRETCH = 1.6;

const cross = (a: LayoutPoint, b: LayoutPoint, c: LayoutPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const distance = (a: LayoutPoint, b: LayoutPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

/** Strict interior proximity: endpoints are covered by the atom-pair overlap check. */
export function atomNearBond(p: LayoutPoint, a: LayoutPoint, b: LayoutPoint, reference: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  if (length2 === 0) return false;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2;
  return t > 1e-10 && t < 1 - 1e-10 &&
    Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) < 0.25 * reference;
}

export function bondsOverlap(p: LayoutPoint, q: LayoutPoint, r: LayoutPoint, s: LayoutPoint, reference: number): boolean {
  const epsilon = 1e-10 * reference ** 2;
  const opposite = (x: number, y: number) => (x > epsilon && y < -epsilon) || (x < -epsilon && y > epsilon);
  if (opposite(cross(p, q, r), cross(p, q, s)) && opposite(cross(r, s, p), cross(r, s, q))) return true;
  if (Math.abs(cross(p, q, r)) > epsilon || Math.abs(cross(p, q, s)) > epsilon) return false;
  const dx = q.x - p.x, dy = q.y - p.y, length2 = dx * dx + dy * dy;
  if (length2 === 0) return false;
  const u = ((r.x - p.x) * dx + (r.y - p.y) * dy) / length2;
  const v = ((s.x - p.x) * dx + (s.y - p.y) * dy) / length2;
  return Math.min(1, Math.max(u, v)) - Math.max(0, Math.min(u, v)) > 1e-10;
}

/** Geometry-independent snapshot, shared by all rigid-repair trials for one candidate. */
export interface LayoutTopology {
  rings: number[][];
  cycleRank: number;
  bridgeBonds: number[];
  acyclicBonds: number[];
  adjacent: { atom: number; bond: number }[][];
  ringPairs: [number, number][];
  ringSystems: number[][];
  bridgedRingIndices: Set<number>;
  bridgedBondIndices: Set<number>;
}

/** One deterministic shortest path per edge (O(E(V+E))), never every tied path.
 * Fixed-size chordless faces retain surrounded five/six-rings and cubane's six faces.
 * This bounded walk is polynomial too; it never enumerates larger composite cycles. */
export function prepareLayoutTopology(atomCount: number, bonds: readonly LayoutBond[]): LayoutTopology {
  const adjacent: { atom: number; bond: number }[][] = Array.from({ length: atomCount }, () => []);
  bonds.forEach(({ from, to }, bond) => {
    adjacent[from].push({ atom: to, bond });
    adjacent[to].push({ atom: from, bond });
  });
  adjacent.forEach(edges => edges.sort((a, b) => a.atom - b.atom || a.bond - b.bond));
  // Tarjan edge blocks identify cyclic systems and true acyclic edges independently of
  // which shortest cycles won ties. Spiro blocks share an atom, never an edge.
  const discovery = Array<number>(atomCount).fill(-1), low = [...discovery];
  const stack: number[] = [], acyclicBonds: number[] = [];
  const cyclicEdges = new Set<number>();
  const cyclicBlocks: number[][] = [];
  let time = 0, components = 0;
  const visit = (node: number, parentEdge: number) => {
    discovery[node] = low[node] = time++;
    for (const { atom: next, bond } of adjacent[node]) {
      if (bond === parentEdge) continue;
      if (discovery[next] === -1) {
        stack.push(bond);
        visit(next, bond);
        low[node] = Math.min(low[node], low[next]);
        if (low[next] >= discovery[node]) {
          const block: number[] = [];
          let edge: number;
          do { edge = stack.pop()!; block.push(edge); } while (edge !== bond);
          if (block.length === 1) acyclicBonds.push(bond);
          else { cyclicBlocks.push(block); block.forEach(edge => cyclicEdges.add(edge)); }
        }
      } else if (discovery[next] < discovery[node]) {
        stack.push(bond);
        low[node] = Math.min(low[node], discovery[next]);
      }
    }
  };
  for (let i = 0; i < atomCount; i++) if (discovery[i] === -1) { components++; visit(i, -1); }
  const parent = Array.from({ length: atomCount }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const ringAtoms = new Set<number>();
  for (const edge of cyclicEdges) {
    const { from, to } = bonds[edge];
    parent[root(from)] = root(to);
    ringAtoms.add(from); ringAtoms.add(to);
  }
  const bridgeBonds = acyclicBonds.filter(i => {
    const { from, to } = bonds[i];
    return ringAtoms.has(from) && ringAtoms.has(to) && root(from) !== root(to);
  }).sort((a, b) => a - b);
  const rings = new Map<string, number[]>();
  bonds.forEach(({ from, to }, excluded) => {
    const previous = Array<number>(atomCount).fill(-1);
    const queue = [from];
    previous[from] = from;
    for (let head = 0; head < queue.length && previous[to] === -1; head++) {
      for (const edge of adjacent[queue[head]]) {
        if (edge.bond === excluded || previous[edge.atom] !== -1) continue;
        previous[edge.atom] = queue[head];
        queue.push(edge.atom);
      }
    }
    if (previous[to] === -1) return;
    const path = [to];
    while (path[path.length - 1] !== from) path.push(previous[path[path.length - 1]]);
    if (path.length < 3) return;
    const key = path.map((atom, i) => pairKey(atom, path[(i + 1) % path.length])).sort().join("|");
    rings.set(key, path);
  });
  const adjacentAtoms = adjacent.map(edges => new Set(edges.map(edge => edge.atom)));
  const addSmallCycle = (path: number[]) => {
    const key = path.map((atom, i) => pairKey(atom, path[(i + 1) % path.length])).sort().join("|");
    rings.set(key, path);
  };
  const walk = (path: number[]) => {
    const tail = path[path.length - 1];
    for (const next of adjacentAtoms[tail]) {
      if (next <= path[0] || path.includes(next)) continue;
      // A chord to an earlier interior vertex rules out this whole branch.
      if (path.slice(1, -1).some(atom => adjacentAtoms[next].has(atom))) continue;
      const extended = [...path, next];
      if (extended.length >= 3 && adjacentAtoms[next].has(path[0])) addSmallCycle(extended);
      else if (extended.length < 6) walk(extended);
    }
  };
  adjacent.forEach((_, start) => walk([start]));

  const bondIndex = new Map(bonds.map((bond, i) => [pairKey(bond.from, bond.to), i]));
  const vector = (ring: number[]) => ring.reduce((bits, atom, i) =>
    bits ^ (1n << BigInt(bondIndex.get(pairKey(atom, ring[(i + 1) % ring.length]))!)), 0n);
  const basis = new Map<number, bigint>();
  const reduce = (bits: bigint): bigint => {
    while (bits !== 0n) {
      const pivot = bits.toString(2).length - 1;
      const row = basis.get(pivot);
      if (row === undefined) return bits;
      bits ^= row;
    }
    return bits;
  };
  const ordered = [...rings.values()].sort((a, b) => a.length - b.length);
  const smallest: number[][] = [];
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].length === ordered[start].length) end++;
    const group = ordered.slice(start, end);
    smallest.push(...group.filter(ring => reduce(vector(ring)) !== 0n));
    // Add this length only after judging every tie against strictly shorter cycles.
    for (const ring of group) {
      const row = reduce(vector(ring));
      if (row !== 0n) basis.set(row.toString(2).length - 1, row);
    }
    start = end;
  }
  const byAtom: number[][] = Array.from({ length: atomCount }, () => []);
  smallest.forEach((ring, i) => ring.forEach(atom => byAtom[atom].push(i)));
  const pairs = new Map<string, [number, number]>();
  for (const ids of byAtom) for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    pairs.set(pairKey(ids[a], ids[b]), [ids[a], ids[b]]);
  }
  const ringEdges = smallest.map(ring => new Set(ring.map((atom, i) =>
    bondIndex.get(pairKey(atom, ring[(i + 1) % ring.length]))!)));
  const bridgedRingIndices = new Set<number>(), bridgedBondIndices = new Set<number>();
  const ringSystems = cyclicBlocks.map(block => [...new Set(block.flatMap(i => [bonds[i].from, bonds[i].to]))].sort((a, b) => a - b));
  cyclicBlocks.forEach((block, index) => {
    const edges = new Set(block);
    const members = ringEdges.flatMap((ring, i) => [...ring].every(edge => edges.has(edge)) ? [i] : []);
    // Simple fused faces share one edge; spiro faces occupy separate Tarjan blocks.
    const bridged = members.length > block.length - ringSystems[index].length + 1 ||
      block.some(edge => members.filter(i => ringEdges[i].has(edge)).length > 2) || members.some((a, i) =>
      members.slice(i + 1).some(b => {
        const sharedAtoms = smallest[a].filter(atom => smallest[b].includes(atom)).length;
        const sharedEdges = [...ringEdges[a]].filter(edge => ringEdges[b].has(edge)).length;
        return sharedEdges > 1 || (sharedAtoms > 1 && sharedEdges !== 1);
      }));
    if (bridged) { members.forEach(i => bridgedRingIndices.add(i)); block.forEach(i => bridgedBondIndices.add(i)); }
  });
  return { ringSystems, bridgedRingIndices, bridgedBondIndices, rings: smallest, cycleRank: bonds.length - atomCount + components,
    bridgeBonds, acyclicBonds: acyclicBonds.sort((a, b) => a - b), adjacent,
    ringPairs: [...pairs.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
}

/** Hard-geometry snapshot for a previously screened rigid rotation. This permits repair to
 * reuse invariant geometry and score only moved-versus-stationary pairs on each trial. */
export type LayoutGeometry = Pick<LayoutQuality, "overlappingAtoms" | "crossings" | "collinearBondOverlaps" |
  "atomBondOverlaps" | "nearestAtomPairDistance" | "nearestNonBondedAtomPairDistance">;

/** All distances and bond statistics are fractions of the reference (default: mean bond length).
 * Invalid/nonfinite geometry is refused rather than accidentally receiving a passing verdict. */
export function evaluateLayoutQuality(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[], referenceBondLength?: number,
  topology?: LayoutTopology, geometry?: LayoutGeometry, labelBoxes: readonly LayoutLabelBox[] = [],
  // Host-placed coordination pockets may intentionally touch labels on a metal/donor pair.
  // This exempts only those label pairs, never atom centres or label/bond clearance.
  labelLabelExemptions: readonly (readonly [number, number])[] = [],
  labelGeometry?: LayoutLabelGeometry
): LayoutQuality {
  if (atoms.some(a => !Number.isFinite(a.x) || !Number.isFinite(a.y)) || bonds.some(b =>
    !Number.isInteger(b.from) || !Number.isInteger(b.to) || b.from === b.to ||
    b.from < 0 || b.to < 0 || b.from >= atoms.length || b.to >= atoms.length)) {
    throw new Error("Layout quality requires finite coordinates and valid bond endpoints.");
  }
  const lengths = bonds.map(b => distance(atoms[b.from], atoms[b.to]));
  // A collapsed layout still needs a useful overlap count. With no measurable bond use one unit.
  const reference = referenceBondLength ?? (mean(lengths) || 1);
  if (!Number.isFinite(reference) || reference <= 0) throw new Error("Layout reference bond length must be positive.");
  const fractions = lengths.map(length => length / reference);
  const avg = mean(fractions);
  const minBondLength = fractions.length ? Math.min(...fractions) : 1;
  const maxBondLength = fractions.length ? Math.max(...fractions) : 1;
  const bondLengthStdDev = Math.sqrt(mean(fractions.map(length => (length - avg) ** 2)));
  // Scale the orientation tolerance so the verdict is invariant under uniform scaling.
  const epsilon = 1e-10 * reference ** 2;
  let overlappingAtoms: [number, number][] = [];
  let nearestAtomPairDistance = Infinity;
  let nearestNonBondedAtomPairDistance = Infinity;
  const bondedPairs = new Set(bonds.map(b => pairKey(b.from, b.to)));
  if (!geometry) atoms.forEach((a, i) => {
    for (let j = i + 1; j < atoms.length; j++) {
      const d = distance(a, atoms[j]) / reference;
      nearestAtomPairDistance = Math.min(nearestAtomPairDistance, d);
      if (!bondedPairs.has(pairKey(i, j))) nearestNonBondedAtomPairDistance = Math.min(nearestNonBondedAtomPairDistance, d);
      if (d < 0.5) overlappingAtoms.push([i, j]);
    }
  });
  let crossings: [number, number][] = [];
  let collinearBondOverlaps: [number, number][] = [];
  if (!geometry) bonds.forEach((a, i) => {
    for (let j = i + 1; j < bonds.length; j++) {
      const b = bonds[j];
      const p = atoms[a.from], q = atoms[a.to], r = atoms[b.from], t = atoms[b.to];
      if (bondsOverlap(p, q, r, t, reference)) {
        if (Math.abs(cross(p, q, r)) <= epsilon && Math.abs(cross(p, q, t)) <= epsilon) collinearBondOverlaps.push([i, j]);
        else crossings.push([i, j]);
      }
    }
  });
  let atomBondOverlaps: [number, number][] = [];
  if (!geometry) atoms.forEach((p, i) => bonds.forEach((b, j) => {
    if (i !== b.from && i !== b.to && atomNearBond(p, atoms[b.from], atoms[b.to], reference)) atomBondOverlaps.push([i, j]);
  }));
  if (geometry) ({ overlappingAtoms, crossings, collinearBondOverlaps, atomBondOverlaps,
    nearestAtomPairDistance, nearestNonBondedAtomPairDistance } = geometry);
  const smallest = topology ?? prepareLayoutTopology(atoms.length, bonds);
  const rings: LayoutRingQuality[] = smallest.rings.map((ids, index) => {
    if (smallest.bridgedRingIndices.has(index) || (ids.length !== 5 && ids.length !== 6)) return { atoms: ids };
    const points = ids.map(i => atoms[i]);
    // Signed area and turn distinguish a reflex interior angle from its acute supplement.
    const area = points.reduce((sum, p, i) => sum + cross(points[0], p, points[(i + 1) % points.length]), 0);
    const ideal = 180 - 360 / ids.length;
    const errors = points.map((p, i) => {
      const prev = points[(i + points.length - 1) % points.length];
      const next = points[(i + 1) % points.length];
      const denominator = distance(prev, p) * distance(next, p);
      if (denominator === 0 || Math.abs(area) < epsilon) return 180;
      const cosine = ((prev.x - p.x) * (next.x - p.x) + (prev.y - p.y) * (next.y - p.y)) / denominator;
      const small = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
      const interior = cross(prev, p, next) * area < 0 ? 360 - small : small;
      return Math.abs(interior - ideal);
    });
    return { atoms: ids, maxAngleError: Math.max(...errors) };
  });
  const edges = rings.map(ring => new Set(ring.atoms.map((a, i) => pairKey(a, ring.atoms[(i + 1) % ring.atoms.length]))));
  const centroid = (ids: number[]) => ({ x: mean(ids.map(i => atoms[i].x)), y: mean(ids.map(i => atoms[i].y)) });
  const fusedSideDefects: [number, number][] = [];
  const hasBridgedRings = smallest.bridgedRingIndices.size > 0;
  for (const [i, j] of smallest.ringPairs) {
    const sharedEdges = [...edges[i]].filter(edge => edges[j].has(edge));
    if (smallest.bridgedRingIndices.has(i) || smallest.bridgedRingIndices.has(j)) continue;
    // Rings sharing a bridge path rather than one bond are bridged, not fused.
    if (sharedEdges.length !== 1) continue;
    const [p, q] = sharedEdges[0].split(":").map(id => atoms[Number(id)]);
    if (cross(p, q, centroid(rings[i].atoms)) * cross(p, q, centroid(rings[j].atoms)) > epsilon ** 2) {
      fusedSideDefects.push([i, j]);
    }
  }
  const { labelBondOverlaps, labelLabelOverlaps, smallestLabelBondClearance } = labelGeometry ??
    prepareLayoutLabelEvaluator(atoms, bonds, labelBoxes, reference, undefined, undefined, labelLabelExemptions)();
  const hardDefects = overlappingAtoms.length + crossings.length + atomBondOverlaps.length + collinearBondOverlaps.length +
    labelBondOverlaps.length + labelLabelOverlaps.length;
  const ringError = Math.max(0, ...rings.map(ring => ring.maxAngleError ?? 0));
  const bridgeBonds = smallest.bridgeBonds;
  const bridges = new Set(bridgeBonds);
  const regularRings = ringError <= 10 + 1e-9 && fusedSideDefects.length === 0;
  const softScore = bondLengthStdDev + Math.abs(1 - minBondLength) + Math.abs(maxBondLength - 1) + ringError / 180 + fusedSideDefects.length;
  return { referenceBondLength: reference, minBondLength, maxBondLength, bondLengthStdDev,
    crossings, collinearBondOverlaps, overlappingAtoms, atomBondOverlaps, nearestAtomPairDistance, nearestNonBondedAtomPairDistance,
    rings, fusedSideDefects, hasBridgedRings, labelBondOverlaps, labelLabelOverlaps, smallestLabelBondClearance, hardDefects, softScore,
    bridgeBonds, maxBridgeLength: Math.max(0, ...bridgeBonds.map(i => fractions[i])),
    passesRelaxed: hardDefects === 0 && regularRings && fractions.every((length, i) =>
      smallest.bridgedBondIndices.has(i) || (length >= 0.9 - 1e-9 && length <= (bridges.has(i) ? MAX_BRIDGE_STRETCH : 1.1) + 1e-9)),
    passes: hardDefects === 0 && fractions.every((length, i) => smallest.bridgedBondIndices.has(i) ||
      (length >= 0.9 - 1e-9 && length <= 1.1 + 1e-9)) &&
      regularRings };
}

/** Negative means a is better; hard defects always outrank the soft geometry score. */
export function compareLayoutQuality(a: LayoutQuality, b: LayoutQuality): number {
  return a.hardDefects - b.hardDefects || a.softScore - b.softScore;
}

/** Exact distance from an axis-aligned label box to a bond centreline. */
export function labelBoxBondDistance(box: LayoutLabelBox, a: LayoutPoint, b: LayoutPoint): number {
  let low = 0, high = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, box.x, box.x + box.width],
    [a.y, b.y - a.y, box.y, box.y + box.height]]) {
    if (Math.abs(delta) < 1e-15) { if (start < min || start > max) { high = -1; break; } }
    else {
      const t0 = (min - start) / delta, t1 = (max - start) / delta;
      low = Math.max(low, Math.min(t0, t1)); high = Math.min(high, Math.max(t0, t1));
    }
  }
  if (low <= high) return 0;
  const pointBox = (p: LayoutPoint) => Math.hypot(Math.max(box.x - p.x, 0, p.x - box.x - box.width),
    Math.max(box.y - p.y, 0, p.y - box.y - box.height));
  const pointSegment = (p: LayoutPoint) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  return Math.min(pointBox(a), pointBox(b), ...[box.x, box.x + box.width].flatMap(x =>
    [box.y, box.y + box.height].map(y => pointSegment({ x, y }))));
}

/** Shared uniform index for rigid repair and label clearance. Large sparse queries scan
 * occupied items instead of walking an unbounded rectangle of empty grid cells. */
export class LayoutSpatialGrid {
  private cells = new Map<string, number[]>();
  private ids = new Set<number>();
  private oversized = new Set<number>();
  constructor(private size: number) {}
  private bounds(a: LayoutPoint, b: LayoutPoint, margin: number) {
    return [Math.floor((Math.min(a.x, b.x) - margin) / this.size),
      Math.floor((Math.max(a.x, b.x) + margin) / this.size),
      Math.floor((Math.min(a.y, b.y) - margin) / this.size),
      Math.floor((Math.max(a.y, b.y) + margin) / this.size)];
  }
  add(id: number, a: LayoutPoint, b = a) {
    this.ids.add(id);
    const [x0, x1, y0, y1] = this.bounds(a, b, 0);
    // A very long bond or large label stays queryable without filling its entire frame.
    if (![x0, x1, y0, y1].every(Number.isSafeInteger) ||
        (x1 - x0 + 1) * (y1 - y0 + 1) > 1024) { this.oversized.add(id); return; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x}:${y}`, cell = this.cells.get(key);
      if (cell) cell.push(id); else this.cells.set(key, [id]);
    }
  }
  query(a: LayoutPoint, b = a, margin = 0): Set<number> {
    const [x0, x1, y0, y1] = this.bounds(a, b, margin);
    if (![x0, x1, y0, y1].every(Number.isSafeInteger) ||
        (x1 - x0 + 1) * (y1 - y0 + 1) > Math.max(16, this.cells.size * 4)) return new Set(this.ids);
    const ids = new Set(this.oversized);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      for (const id of this.cells.get(`${x}:${y}`) ?? []) ids.add(id);
    }
    return ids;
  }
}

export type LayoutLabelGeometry = Pick<LayoutQuality,
  "labelBondOverlaps" | "labelLabelOverlaps" | "smallestLabelBondClearance">;

/** Index the stationary part once per orientation. Each swing visits only mobile labels,
 * mobile bonds and their spatial neighbours. Upright text within the moving fragment is
 * checked too: rotating its atom centres does not rotate its axis-aligned boxes. */
export function prepareLayoutLabelEvaluator(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[], boxes: readonly LayoutLabelBox[], reference: number,
  moving: ReadonlySet<number> = new Set(), work: () => void = () => {},
  exemptions: readonly (readonly [number, number])[] = [],
  // Stationary attachment atoms can acquire a different label when a neighbour swings.
  changingLabels: ReadonlySet<number> = moving
): (points?: readonly LayoutPoint[], labels?: readonly LayoutLabelBox[]) => LayoutLabelGeometry {
  if (!boxes.length) return () => ({ labelBondOverlaps: [], labelLabelOverlaps: [], smallestLabelBondClearance: Infinity });
  const padding = LABEL_CLEARANCE_PADDING * reference;
  const exempt = new Set(exemptions.map(([a, b]) => pairKey(a, b)));
  const mobileBonds = bonds.map(b => moving.has(b.from) || moving.has(b.to));
  const fixedBonds = new LayoutSpatialGrid(reference), fixedLabels = new LayoutSpatialGrid(reference);
  const fixedBondIds: number[] = [], fixedLabelIds: number[] = [];
  const corner = (b: LayoutLabelBox) => ({ x: b.x + b.width, y: b.y + b.height });
  bonds.forEach((b, i) => {
    if (!mobileBonds[i]) { fixedBondIds.push(i); fixedBonds.add(i, atoms[b.from], atoms[b.to]); }
  });
  boxes.forEach((b, i) => {
    work();
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 0 || b.height < 0 ||
        !Number.isInteger(b.atom) || b.atom < 0 || b.atom >= atoms.length) throw new Error("Layout label boxes must be finite with valid atom indices.");
    if (!changingLabels.has(b.atom)) { fixedLabelIds.push(i); fixedLabels.add(i, b, corner(b)); }
  });
  const scan = (points: readonly LayoutPoint[], labels: readonly LayoutLabelBox[], dynamic: boolean,
    baseline?: LayoutLabelGeometry): LayoutLabelGeometry => {
    const labelBondOverlaps: [number, number][] = [...(baseline?.labelBondOverlaps ?? [])];
    const labelLabelOverlaps: [number, number][] = [...(baseline?.labelLabelOverlaps ?? [])];
    let clearance = baseline ? baseline.smallestLabelBondClearance * reference : Infinity;
    const bondContact = (i: number, j: number) => {
      work();
      const box = labels[i], b = bonds[j];
      if (b.from === box.atom || b.to === box.atom) return;
      clearance = Math.min(clearance, labelBoxBondDistance(box, points[b.from], points[b.to]));
      if (labelBoxBondDistance({ ...box, x: box.x - padding, y: box.y - padding,
        width: box.width + 2 * padding, height: box.height + 2 * padding }, points[b.from], points[b.to]) === 0)
        labelBondOverlaps.push([box.atom, j]);
    };
    const labelContact = (i: number, j: number) => {
      work();
      const a = labels[i], b = labels[j];
      if (a.atom === b.atom || exempt.has(pairKey(a.atom, b.atom))) return;
      if (a.x <= b.x + b.width + padding && b.x <= a.x + a.width + padding &&
          a.y <= b.y + b.height + padding && b.y <= a.y + a.height + padding)
        labelLabelOverlaps.push(i < j ? [a.atom, b.atom] : [b.atom, a.atom]);
    };
    const scanLabels = (ids: number[], grid: LayoutSpatialGrid, bondIds: number[], labelGrid: LayoutSpatialGrid,
      labelFilter: (i: number, j: number) => boolean) => {
      for (const i of ids) {
        work();
        const box = labels[i];
        // Seed an exact upper bound; the query includes every bond that can lower the
        // minimum, as well as every possible padded contact.
        if (!Number.isFinite(clearance)) {
          const j = bondIds.find(j => { work(); return bonds[j].from !== box.atom && bonds[j].to !== box.atom; });
          if (j !== undefined) clearance = labelBoxBondDistance(box, points[bonds[j].from], points[bonds[j].to]);
        }
        for (const j of grid.query(box, corner(box), Math.max(padding, Number.isFinite(clearance) ? clearance : 0))) bondContact(i, j);
        for (const j of labelGrid.query(box, corner(box), padding)) if (labelFilter(i, j)) labelContact(i, j);
      }
    };
    if (!dynamic) {
      scanLabels(fixedLabelIds, fixedBonds, fixedBondIds, fixedLabels, (i, j) => j > i);
    } else {
      const mobileBondGrid = new LayoutSpatialGrid(reference), mobileLabelGrid = new LayoutSpatialGrid(reference);
      const mobileBondIds: number[] = [], mobileLabelIds: number[] = [];
      bonds.forEach((b, i) => {
        if (mobileBonds[i]) { work(); mobileBondIds.push(i); mobileBondGrid.add(i, points[b.from], points[b.to]); }
      });
      labels.forEach((b, i) => {
        if (changingLabels.has(b.atom)) { work(); mobileLabelIds.push(i); mobileLabelGrid.add(i, b, corner(b)); }
      });
      scanLabels(mobileLabelIds, fixedBonds, fixedBondIds, fixedLabels, () => true);
      scanLabels(mobileLabelIds, mobileBondGrid, mobileBondIds, mobileLabelGrid, (i, j) => j > i);
      // The other direction: a stationary label touched by a swinging bond.
      for (const j of mobileBondIds) {
        work();
        const b = bonds[j];
        if (!Number.isFinite(clearance)) {
          const i = fixedLabelIds.find(i => { work(); return boxes[i].atom !== b.from && boxes[i].atom !== b.to; });
          if (i !== undefined) clearance = labelBoxBondDistance(labels[i], points[b.from], points[b.to]);
        }
        for (const i of fixedLabels.query(points[b.from], points[b.to], Math.max(padding, Number.isFinite(clearance) ? clearance : 0))) bondContact(i, j);
      }
    }
    const order = new Map(labels.map((b, i) => [b.atom, i]));
    labelBondOverlaps.sort((a, b) => order.get(a[0])! - order.get(b[0])! || a[1] - b[1]);
    labelLabelOverlaps.sort((a, b) => order.get(a[0])! - order.get(b[0])! || order.get(a[1])! - order.get(b[1])!);
    return { labelBondOverlaps, labelLabelOverlaps, smallestLabelBondClearance: clearance / reference };
  };
  const baseline = scan(atoms, boxes, false);
  return (points = atoms, labels = boxes) => moving.size || changingLabels.size ? scan(points, labels, true, baseline) : baseline;
}
