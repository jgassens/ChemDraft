import { isDeepStrictEqual } from "node:util";
import type { MoleculeSummary } from "./model";
import type { ResonanceGraph } from "./resonance";

export type MappedFeature = "charge" | "isotope" | "radical" | "stereo";
export interface SigmaComparison {
  status: "isomorphic" | "different" | "undetermined";
  changes?: Partial<Record<MappedFeature, [unknown, unknown]>>;
  orders?: [number[], number[]];
}
const edgeKey = (i: number, j: number) => i < j ? `${i}:${j}` : `${j}:${i}`;
const graph = (m: MoleculeSummary): ResonanceGraph | undefined => m.featureAtoms && m.featureBonds
  ? { atoms: m.featureAtoms, bonds: m.featureBonds } : m.species?.graph;

/** Element/H-labelled sigma isomorphism, independent of bond orders and protected
 * features. Joint colour refinement supplies canonical rank classes; a bounded
 * search resolves their automorphisms with ONE mapping for all features together.
 * Missing evidence or an exhausted search never proves bond-order-only loss. */
export function compareSigma(a: MoleculeSummary, b: MoleculeSummary, allowed: ReadonlySet<MappedFeature> = new Set(), cap = 50_000): SigmaComparison | undefined {
  return compareGraphs(a, b, allowed, cap, false);
}

/** Refinement only prunes candidates. Equality requires a complete mapping that
 * preserves element, charge, isotope, H count and every bond order. */
export function compareExactGraph(a: MoleculeSummary, b: MoleculeSummary, cap = 50_000): SigmaComparison["status"] {
  return compareGraphs(a, b, new Set(), cap, true)?.status ?? "undetermined";
}

function compareGraphs(a: MoleculeSummary, b: MoleculeSummary, allowed: ReadonlySet<MappedFeature>, cap: number, exact: boolean): SigmaComparison | undefined {
  const x = graph(a), y = graph(b);
  if (!x || !y) return undefined;
  if (x.atoms.length !== y.atoms.length || x.bonds.length !== y.bonds.length) return { status: "different" };
  let work = 0, exhausted = false;
  const spend = () => { if (++work > cap) exhausted = true; return !exhausted; };
  const adjacency = (g: ResonanceGraph) => {
    const edges = g.atoms.map(() => new Map<number, number>());
    for (const [index, bond] of g.bonds.entries()) {
      const [i, j] = bond.atoms;
      if (!edges[i] || !edges[j] || i === j || edges[i].has(j) || !Number.isFinite(bond.order)) return undefined;
      edges[i].set(j, index); edges[j].set(i, index);
    }
    return edges;
  };
  const aa = adjacency(x), ba = adjacency(y);
  if (!aa || !ba || [...x.atoms, ...y.atoms].some(atom => !Number.isInteger(atom.z) || !Number.isInteger(atom.h) || atom.h < 0
    || exact && (!Number.isInteger(atom.charge) || !Number.isInteger(atom.isotope) || atom.isotope < 0))) return { status: "undetermined" };
  // Exact indexed evidence already proves a common feature-preserving mapping;
  // unchanged large/symmetric graphs do not need to consume the search budget.
  if (isDeepStrictEqual(x, y) && (exact || isDeepStrictEqual(a.tetrahedral, b.tetrahedral) && isDeepStrictEqual(a.doubleBonds, b.doubleBonds))) {
    return { status: "isomorphic", changes: {}, orders: [x.bonds.map(bond => bond.order), y.bonds.map(bond => bond.order)] };
  }
  const ranks = (left: string[], right: string[]) => {
    const keys = [...new Set([...left, ...right])].sort();
    const ids = new Map(keys.map((key, i) => [key, i]));
    return [left.map(key => ids.get(key)!), right.map(key => ids.get(key)!)] as const;
  };
  const labels = (g: ResonanceGraph, edges: Map<number, number>[]) => g.atoms.map((atom, i) => JSON.stringify([
    atom.z, atom.h, edges[i].size, ...(exact ? [atom.charge, atom.isotope] : [])
  ]));
  let [ar, br] = ranks(labels(x, aa), labels(y, ba));
  for (let round = 0; round < x.atoms.length; round++) {
    const refine = (g: ResonanceGraph, colours: number[], edges: Map<number, number>[]) => colours.map((colour, i) => {
      spend();
      return JSON.stringify([colour, [...edges[i]].map(([j, bond]) => JSON.stringify([colours[j], ...(exact ? [g.bonds[bond].order] : [])])).sort()]);
    });
    const [nextA, nextB] = ranks(refine(x, ar, aa), refine(y, br, ba));
    if (exhausted) return { status: "undetermined" };
    const stable = new Set([...ar, ...br]).size === new Set([...nextA, ...nextB]).size;
    ar = nextA; br = nextB;
    if (stable) break;
  }
  if (!isDeepStrictEqual([...ar].sort((u, v) => u - v), [...br].sort((u, v) => u - v))) return { status: "different" };
  const classes = new Map<number, number[]>();
  br.forEach((rank, i) => { const members = classes.get(rank) ?? []; members.push(i); classes.set(rank, members); });
  const candidates = ar.map(rank => classes.get(rank)!);
  const order = x.atoms.map((_, i) => i).sort((i, j) => candidates[i].length - candidates[j].length || aa[j].size - aa[i].size);
  const mapping = x.atoms.map(() => -1), used = new Set<number>();
  const cipA = new Map(a.tetrahedral.map(t => [t.atom, t.cip])), cipB = new Map(b.tetrahedral.map(t => [t.atom, t.cip]));
  const stereo = (m: MoleculeSummary) => new Map(m.doubleBonds.map(bond => [edgeKey(bond.atoms[0], bond.atoms[1]), bond.stereo]));
  const stereoA = stereo(a), stereoB = stereo(b);
  let best: SigmaComparison | undefined, bestScore = Infinity;
  const evaluate = () => {
    if (exact) { best = { status: "isomorphic" }; return true; }
    const changes: NonNullable<SigmaComparison["changes"]> = {};
    for (const feature of ["charge", "isotope", "radical", "stereo"] as const) {
      const left = feature === "stereo"
        ? [x.atoms.map((_, i) => cipA.get(i) ?? ""), x.bonds.map(bond => stereoA.get(edgeKey(...bond.atoms)) ?? "unspecified")]
        : x.atoms.map(atom => atom[feature]);
      const right = feature === "stereo"
        ? [mapping.map(i => cipB.get(i) ?? ""), x.bonds.map(bond => stereoB.get(edgeKey(mapping[bond.atoms[0]], mapping[bond.atoms[1]])) ?? "unspecified")]
        : mapping.map(i => y.atoms[i][feature]);
      if (!isDeepStrictEqual(left, right)) changes[feature] = [left, right];
    }
    const changed = Object.keys(changes) as MappedFeature[];
    const score = changed.filter(feature => !allowed.has(feature)).length * 5 + changed.length;
    if (score < bestScore) {
      bestScore = score;
      best = { status: "isomorphic", changes, orders: [x.bonds.map(bond => bond.order), x.bonds.map(bond => y.bonds[ba[mapping[bond.atoms[0]]].get(mapping[bond.atoms[1]])!].order)] };
    }
    return score === 0;
  };
  const search = (depth: number): boolean => {
    if (!spend()) return false;
    if (depth === order.length) return evaluate();
    const i = order[depth];
    for (const j of candidates[i]) {
      if (!spend()) return false;
      if (used.has(j)) continue;
      let compatible = true;
      for (let n = 0; n < mapping.length; n++) {
        if (!spend()) return false;
        if (mapping[n] >= 0 && (aa[i].has(n) !== ba[j].has(mapping[n]) || exact && aa[i].has(n) &&
          x.bonds[aa[i].get(n)!].order !== y.bonds[ba[j].get(mapping[n])!].order)) { compatible = false; break; }
      }
      if (!compatible) continue;
      mapping[i] = j; used.add(j);
      if (search(depth + 1)) return true;
      mapping[i] = -1; used.delete(j);
      if (exhausted) return false;
    }
    return false;
  };
  search(0);
  return exhausted ? { status: "undetermined" } : best ?? { status: "different" };
}
