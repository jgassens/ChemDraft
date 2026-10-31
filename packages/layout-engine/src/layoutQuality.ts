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
  overlappingAtoms: [number, number][];
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

/** Symmetrized smallest rings: retain every tied cycle that is not a sum of strictly shorter
 * cycles. Shortest paths supply large rings; bounded chordless-cycle enumeration also finds a
 * five/six-ring completely surrounded by smaller rings (not shortest through any single bond).
 * In cubane this retains all six square faces and excludes composite six-cycles. */
function smallestRings(atomCount: number, bonds: readonly LayoutBond[]): { rings: number[][]; cycleRank: number } {
  const adjacent: { atom: number; bond: number }[][] = Array.from({ length: atomCount }, () => []);
  const parent = Array.from({ length: atomCount }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  let components = atomCount;
  bonds.forEach(({ from, to }, bond) => {
    adjacent[from].push({ atom: to, bond });
    adjacent[to].push({ atom: from, bond });
    const a = root(from), b = root(to);
    if (a !== b) { parent[a] = b; components--; }
  });
  const rings = new Map<string, number[]>();
  bonds.forEach(({ from, to }, excluded) => {
    const depths = Array<number>(atomCount).fill(-1);
    const predecessors: number[][] = Array.from({ length: atomCount }, () => []);
    const queue = [from];
    depths[from] = 0;
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      if (depths[to] !== -1 && depths[node] >= depths[to]) break;
      for (const edge of adjacent[node]) {
        if (edge.bond === excluded) continue;
        const depth = depths[node] + 1;
        if (depths[edge.atom] === -1) {
          depths[edge.atom] = depth;
          queue.push(edge.atom);
        }
        if (depths[edge.atom] === depth) predecessors[edge.atom].push(node);
      }
    }
    if (depths[to] < 2) return;
    const visit = (path: number[]) => {
      const node = path[path.length - 1];
      if (node === from) {
        const key = path.map((atom, i) => pairKey(atom, path[(i + 1) % path.length])).sort().join("|");
        rings.set(key, path);
      } else {
        for (const previous of predecessors[node]) visit([...path, previous]);
      }
    };
    visit([to]);
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
  return { rings: smallest, cycleRank: bonds.length - atomCount + components };
}

/** All distances and bond statistics are fractions of the reference (default: mean bond length).
 * Invalid/nonfinite geometry is refused rather than accidentally receiving a passing verdict. */
export function evaluateLayoutQuality(
  atoms: readonly LayoutPoint[], bonds: readonly LayoutBond[], referenceBondLength?: number
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
  const overlappingAtoms: [number, number][] = [];
  let nearestAtomPairDistance = Infinity;
  let nearestNonBondedAtomPairDistance = Infinity;
  const bondedPairs = new Set(bonds.map(b => pairKey(b.from, b.to)));
  atoms.forEach((a, i) => {
    for (let j = i + 1; j < atoms.length; j++) {
      const d = distance(a, atoms[j]) / reference;
      nearestAtomPairDistance = Math.min(nearestAtomPairDistance, d);
      if (!bondedPairs.has(pairKey(i, j))) nearestNonBondedAtomPairDistance = Math.min(nearestNonBondedAtomPairDistance, d);
      if (d < 0.5) overlappingAtoms.push([i, j]);
    }
  });
  const crossings: [number, number][] = [];
  // Scale the orientation tolerance so the verdict is invariant under uniform scaling.
  const epsilon = 1e-10 * reference ** 2;
  bonds.forEach((a, i) => {
    for (let j = i + 1; j < bonds.length; j++) {
      const b = bonds[j];
      if (new Set([a.from, a.to, b.from, b.to]).size !== 4) continue;
      const [p, q, r, s] = [atoms[a.from], atoms[a.to], atoms[b.from], atoms[b.to]];
      const opposite = (x: number, y: number) => (x > epsilon && y < -epsilon) || (x < -epsilon && y > epsilon);
      if (opposite(cross(p, q, r), cross(p, q, s)) && opposite(cross(r, s, p), cross(r, s, q))) crossings.push([i, j]);
    }
  });
  const smallest = smallestRings(atoms.length, bonds);
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
  rings.forEach((a, i) => {
    for (let j = i + 1; j < rings.length; j++) {
      const sharedEdges = [...edges[i]].filter(edge => edges[j].has(edge));
      if (sharedEdges.length > 1) hasBridgedRings = true;
      // Rings sharing a bridge path rather than one bond are bridged, not fused.
      if (sharedEdges.length !== 1) continue;
      const [p, q] = sharedEdges[0].split(":").map(id => atoms[Number(id)]);
      if (cross(p, q, centroid(a.atoms)) * cross(p, q, centroid(rings[j].atoms)) > epsilon ** 2) {
        fusedSideDefects.push([i, j]);
      }
    }
  });
  const hardDefects = overlappingAtoms.length + crossings.length;
  const ringError = Math.max(0, ...rings.map(ring => ring.maxAngleError ?? 0));
  const ringEdges = new Set(edges.flatMap(group => [...group]));
  const ringAtoms = new Set(rings.flatMap(ring => ring.atoms));
  const parent = atoms.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  bonds.forEach(bond => {
    if (ringEdges.has(pairKey(bond.from, bond.to))) parent[root(bond.from)] = root(bond.to);
  });
  const bridgeBonds = bonds.flatMap((bond, i) =>
    !ringEdges.has(pairKey(bond.from, bond.to)) && ringAtoms.has(bond.from) && ringAtoms.has(bond.to) &&
      root(bond.from) !== root(bond.to) ? [i] : []);
  const bridges = new Set(bridgeBonds);
  const regularRings = ringError <= 10 + 1e-9 && fusedSideDefects.length === 0;
  const softScore = bondLengthStdDev + Math.abs(1 - minBondLength) + Math.abs(maxBondLength - 1) + ringError / 180 + fusedSideDefects.length;
  return { referenceBondLength: reference, minBondLength, maxBondLength, bondLengthStdDev,
    crossings, overlappingAtoms, nearestAtomPairDistance, nearestNonBondedAtomPairDistance,
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
