/**
 * Per-atom aromaticity and site context, computed from the Kekulé graph so training and inference
 * agree exactly.
 *
 * **Why not RDKit's own flag.** MinimalLib's `get_json()` is Kekulé-ised and carries no aromaticity.
 * A feature trained on RDKit's `GetIsAromatic()` would therefore mean something different here than it
 * did in training, and the model would answer confidently on a number it had never seen — which is why
 * aromaticity was left out of the original feature set entirely. This computes it instead, from bond
 * orders alone, by a rule small enough to write twice and check against itself:
 *
 *     sp2 ring atom carrying any double bond      -> 1 electron
 *     ring heteroatom with a lone pair, no double -> 2 electrons
 *
 * aromatic when every ring atom qualifies, none carries a double bond to an exocyclic HETEROATOM, and
 * pi is 4n+2. Counted per atom rather than per internal bond so the answer does not depend on which
 * Kekulé structure the engine chose — see `ringIsAromatic`.
 *
 * Benzene 6, pyridine 6, pyrrole and imidazole 4+2, naphthalene 6 either way. Cyclohexene has sp3
 * atoms and is rejected; p-benzoquinone's carbonyls drain it. Verified against chemistry on fifteen
 * rings including indole, furan, tetrazole, quinoline and thiophene.
 *
 * `vendor/pka-model/aromaticity.py` is the counterpart the model was trained with, and the parity
 * fixture pins the two together.
 */
import type { PkaMolecularGraph } from "./pkaModel";

/** Rings bigger than this are not aromatic in any chemistry this method sees, and cost time to walk. */
const MAX_RING = 8;

export interface SiteContextGraph {
  adjacency: number[][];
  bondOrder: (i: number, j: number) => number;
  aromatic: boolean[];
  /** Aromatic, carries a hydrogen, and has no double bond of its own — the pyrrole-type nitrogen. */
  pyrroleType: boolean[];
}

function bondOrderLookup(graph: PkaMolecularGraph): (i: number, j: number) => number {
  const key = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);
  const orders = new Map<string, number>();
  for (const bond of graph.bonds) orders.set(key(bond.atoms[0], bond.atoms[1]), bond.order);
  return (i, j) => orders.get(key(i, j)) ?? 0;
}

function adjacencyOf(graph: PkaMolecularGraph): number[][] {
  const adjacency: number[][] = Array.from({ length: graph.atoms.length }, () => []);
  for (const bond of graph.bonds) {
    adjacency[bond.atoms[0]]!.push(bond.atoms[1]);
    adjacency[bond.atoms[1]]!.push(bond.atoms[0]);
  }
  return adjacency;
}

/** Every simple cycle through `start`, up to `MAX_RING` atoms. */
function cyclesThrough(adjacency: number[][], start: number): number[][] {
  const out: number[][] = [];
  const seen = new Set<string>();
  const walk = (path: number[]): void => {
    const last = path[path.length - 1]!;
    for (const next of adjacency[last]!) {
      if (next === start && path.length >= 3) {
        const key = [...path].sort((a, b) => a - b).join(",");
        if (!seen.has(key)) {
          seen.add(key);
          out.push([...path]);
        }
      } else if (!path.includes(next) && path.length < MAX_RING) {
        walk([...path, next]);
      }
    }
  };
  walk([start]);
  return out;
}

/**
 * Hückel count done PER ATOM, which is what makes it Kekulé-invariant.
 *
 * Counting double bonds *inside* the ring is not invariant: in a fused system the shared bond belongs
 * to whichever ring the Kekulé assignment gave it, so naphthalene's two rings can come out with three
 * and two internal doubles — and RDKit in Python and MinimalLib in the browser do not always choose
 * the same assignment. That mismatch is real and the parity fixture caught it. Counting each atom's
 * own contribution removes the choice:
 *
 *     sp2 ring atom carrying any double bond      -> 1 electron
 *     ring heteroatom with a lone pair, no double -> 2 electrons
 *
 * The exocyclic clause rejects only a double bond to a HETEROATOM. That is what disqualifies
 * p-benzoquinone, whose carbonyls drain the ring; a double bond to a fused carbon partner is ordinary
 * aromatic chemistry and must not be rejected with it.
 */
function ringIsAromatic(
  graph: PkaMolecularGraph,
  adjacency: number[][],
  order: (i: number, j: number) => number,
  cycle: readonly number[]
): boolean {
  const ring = new Set(cycle);
  let pi = 0;
  for (const i of cycle) {
    const atom = graph.atoms[i]!;
    const hasOwnDouble = adjacency[i]!.some((j) => order(i, j) > 1);
    // sp3 centre: not part of a flat system.
    if (adjacency[i]!.length + atom.hydrogens >= 4 && !hasOwnDouble) return false;
    // C=O / C=S draining the ring.
    if (adjacency[i]!.some((j) => order(i, j) > 1 && !ring.has(j) && graph.atoms[j]!.element !== "C")) {
      return false;
    }
    if (hasOwnDouble) pi += 1;
    else if (atom.element === "N" || atom.element === "O" || atom.element === "S") pi += 2;
    else return false; // neither sp2 nor a donor: conjugation breaks here
  }
  return pi % 4 === 2;
}

/** Aromaticity and the pyrrole-type flag for every atom. */
export function siteContext(graph: PkaMolecularGraph): SiteContextGraph {
  const adjacency = adjacencyOf(graph);
  const order = bondOrderLookup(graph);
  const aromatic = new Array<boolean>(graph.atoms.length).fill(false);

  for (let i = 0; i < graph.atoms.length; i += 1) {
    if (aromatic[i]) continue;
    for (const cycle of cyclesThrough(adjacency, i)) {
      if (ringIsAromatic(graph, adjacency, order, cycle)) {
        for (const j of cycle) aromatic[j] = true;
        break;
      }
    }
  }

  const pyrroleType = graph.atoms.map((atom, i) => {
    const hasOwnDouble = adjacency[i]!.some((j) => order(i, j) > 1);
    return aromatic[i] === true && atom.hydrogens > 0 && !hasOwnDouble;
  });

  return { adjacency, bondOrder: order, aromatic, pyrroleType };
}

/**
 * Whether some ring contains both atoms.
 *
 * Used to spot two ionizable sites in one aromatic ring, whose combination is a tautomer rather than a
 * separate species. Reuses the same bounded cycle walk the aromaticity test does, so the two agree on
 * what a ring is.
 */
export function shareARing(adjacency: number[][], a: number, b: number): boolean {
  if (a === b) return false;
  return cyclesThrough(adjacency, a).some((cycle) => cycle.includes(b));
}

/** Topological distance from `start` to every atom it can reach. */
export function distancesFrom(adjacency: number[][], start: number): Map<number, number> {
  const distance = new Map<number, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const i = queue.shift()!;
    for (const j of adjacency[i]!) {
      if (distance.has(j)) continue;
      distance.set(j, distance.get(i)! + 1);
      queue.push(j);
    }
  }
  return distance;
}

/** Radii the local-environment counts are taken at. Order fixed by the trained model. */
const RADII = [1, 2, 3, 4, 6] as const;
const HALOGENS = new Set(["F", "Cl", "Br", "I"]);
/** Stand-in distance when a molecule has no polar atom or no charge at all. */
const NO_SUCH_ATOM = 12;

/**
 * Context measured OUTWARD FROM THE SITE rather than over the whole molecule.
 *
 * The nine whole-molecule descriptors were the model's only sense of context, and on a monofunctional
 * molecule they double as a description of the site itself — which is what the model learned. Give it
 * a polyfunctional molecule and they describe somebody else's functional group: histidine's imidazole
 * predicted 7.18 against a measured 13.10, while bare imidazole predicted 14.68 against 14.40. Same
 * site, same local environment, different molecule.
 *
 * These count the same kinds of thing inside a topological radius, so context stays available but
 * belongs to this site. Worth 0.21 log units of MAE on Murcko-grouped folds, and most of it on exactly
 * the polyfunctional molecules the mechanism predicted.
 */
export function localEnvironmentFeatures(
  graph: PkaMolecularGraph,
  context: SiteContextGraph,
  site: number
): number[] {
  const distance = distancesFrom(context.adjacency, site);
  const out: number[] = [];

  for (const radius of RADII) {
    const near: number[] = [];
    for (const [atom, d] of distance) if (d > 0 && d <= radius) near.push(atom);

    // Counted per ATOM, not per bond. Counting double bonds inside a radius is not Kekulé-invariant:
    // a radius covering part of an aromatic ring sees a different number of them depending on which
    // Kekulé structure the engine chose, and the two engines do not always choose the same one — the
    // parity fixture caught exactly that on a phthalimide. "Carries a multiple bond" is a property of
    // the atom and does not move.
    const unsaturated = near.filter((i) =>
      context.adjacency[i]!.some((j) => context.bondOrder(i, j) > 1)
    ).length;

    out.push(
      near.length,
      near.filter((i) => ["N", "O", "S"].includes(graph.atoms[i]!.element)).length,
      near.filter((i) => HALOGENS.has(graph.atoms[i]!.element)).length,
      near.filter((i) => graph.atoms[i]!.charge > 0).length,
      near.filter((i) => graph.atoms[i]!.charge < 0).length,
      near.filter((i) => graph.atoms[i]!.hydrogens > 0 && ["N", "O", "S"].includes(graph.atoms[i]!.element)).length,
      near.filter((i) => context.aromatic[i]).length,
      unsaturated
    );
  }

  // How far away the rest of the molecule's polar chemistry sits. A carboxyl four bonds off is a
  // different situation from one bonded directly, and no whole-molecule descriptor can say which.
  let nearestPolar = NO_SUCH_ATOM;
  let nearestCharge = NO_SUCH_ATOM;
  let eccentricity = 0;
  for (const [atom, d] of distance) {
    if (d > eccentricity) eccentricity = d;
    if (d === 0) continue;
    if (["N", "O", "S"].includes(graph.atoms[atom]!.element)) nearestPolar = Math.min(nearestPolar, d);
    if (graph.atoms[atom]!.charge !== 0) nearestCharge = Math.min(nearestCharge, d);
  }
  out.push(nearestPolar, nearestCharge, eccentricity, graph.atoms.length - distance.size);
  return out;
}
