/** Engine-independent geometry checks. Indices refer to the supplied atom order. */
export interface LayoutPoint { x: number; y: number }
export interface LayoutBond { from: number; to: number }
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
          else block.forEach(edge => cyclicEdges.add(edge));
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
  return { rings: smallest, cycleRank: bonds.length - atomCount + components,
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
  topology?: LayoutTopology, geometry?: LayoutGeometry
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
  const rings: LayoutRingQuality[] = smallest.rings.map(ids => {
    if (ids.length !== 5 && ids.length !== 6) return { atoms: ids };
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
  let hasBridgedRings = rings.length > smallest.cycleRank;
  for (const [i, j] of smallest.ringPairs) {
    const sharedEdges = [...edges[i]].filter(edge => edges[j].has(edge));
    if (sharedEdges.length > 1) hasBridgedRings = true;
    // Rings sharing a bridge path rather than one bond are bridged, not fused.
    if (sharedEdges.length !== 1) continue;
    const [p, q] = sharedEdges[0].split(":").map(id => atoms[Number(id)]);
    if (cross(p, q, centroid(rings[i].atoms)) * cross(p, q, centroid(rings[j].atoms)) > epsilon ** 2) {
      fusedSideDefects.push([i, j]);
    }
  }
  const hardDefects = overlappingAtoms.length + crossings.length + atomBondOverlaps.length + collinearBondOverlaps.length;
  const ringError = Math.max(0, ...rings.map(ring => ring.maxAngleError ?? 0));
  const bridgeBonds = smallest.bridgeBonds;
  const bridges = new Set(bridgeBonds);
  const regularRings = ringError <= 10 + 1e-9 && fusedSideDefects.length === 0;
  const softScore = bondLengthStdDev + Math.abs(1 - minBondLength) + Math.abs(maxBondLength - 1) + ringError / 180 + fusedSideDefects.length;
  return { referenceBondLength: reference, minBondLength, maxBondLength, bondLengthStdDev,
    crossings, collinearBondOverlaps, overlappingAtoms, atomBondOverlaps, nearestAtomPairDistance, nearestNonBondedAtomPairDistance,
    rings, fusedSideDefects, hasBridgedRings, hardDefects, softScore,
    bridgeBonds, maxBridgeLength: Math.max(0, ...bridgeBonds.map(i => fractions[i])),
    passesRelaxed: hardDefects === 0 && regularRings && fractions.every((length, i) =>
      length >= 0.9 - 1e-9 && length <= (bridges.has(i) ? MAX_BRIDGE_STRETCH : 1.1) + 1e-9),
    passes: hardDefects === 0 && minBondLength >= 0.9 - 1e-9 && maxBondLength <= 1.1 + 1e-9 &&
      regularRings };
}

/** Negative means a is better; hard defects always outrank the soft geometry score. */
export function compareLayoutQuality(a: LayoutQuality, b: LayoutQuality): number {
  return a.hardDefects - b.hardDefects || a.softScore - b.softScore;
}
