/**
 * A Hammett linear free-energy relationship: the second, independent pKa estimator.
 *
 * **Why a second method at all.** A single model's confidence is self-reported. Two methods that
 * disagree tell you something a lone one cannot, and the disagreement here is a far better error
 * signal than the forest's internal variance — r = 0.85 against actual error, versus 0.42 for tree
 * disagreement on the same sites.
 *
 * **Where its numbers come from — and it is not this project's training set.** The substituent
 * constants are Hansch, Leo & Taft's compilation (Chem. Rev. 91 (1991) 165–195) and the reaction
 * constants are the classical fitted rho values. Nothing here was fitted to Dwar-iBond, which is the
 * whole point: a second method trained on the same data would agree with the first by construction and
 * its agreement would carry no information.
 *
 * **Accuracy, measured on the 85 Dwar-iBond sites it applies to: MAE 0.158 log units**, every one
 * inside 1.0, against 0.42 for the forest on those same sites. Split by series, benzoic acids score
 * 0.073 and phenols 0.227.
 *
 * **Read the benzoic figure with care.** Sigma was *defined* by benzoic acid ionisation — rho is 1.00
 * there by construction — so 0.073 largely measures that the compilation is self-consistent, not that
 * the method generalises. The phenol number (0.227) is the honest one: sigma came from benzoic acids
 * and is applied here to a different reaction series with an independently fitted rho.
 *
 * **It applies to 2.8% of sites and declines on the rest**, which is the correct behaviour for an LFER
 * — the relationship is a statement about a substituent series, not a general predictor. Ortho
 * substituents, fused rings, and substituents with no tabulated constant are all refused rather than
 * approximated.
 *
 * **Parity.** Every step works from the same graph view the model uses — no aromaticity flags (RDKit's
 * JSON is Kekulé-ised and carries none), no SMILES writer, no ring perception beyond a few lines.
 * `vendor/pka-model/hammett.py` is the line-for-line counterpart that measured the figures above, and
 * `vendor/pka-model/hammett-parity.json` pins the two together over all 85 estimates and every decline
 * branch.
 */
import type { PkaMolecularGraph } from "./pkaModel";
import sigmaJson from "../vendor/pka-model/hammett-sigma.json";

const SIGMA = sigmaJson as unknown as {
  /** Shell signature -> [sigma_meta, sigma_para, human-readable name]. */
  sigma: Record<string, [number, number, string]>;
  /** Shell signature -> [sigma_para_minus, name]. */
  sigmaParaMinus: Record<string, [number, string]>;
};

/** pKa of the unsubstituted parent, and the series' reaction constant. */
const SERIES = {
  benzoic: { pKa0: 4.2, rho: 1.0 },
  phenol: { pKa0: 9.95, rho: 2.23 }
} as const;

export type HammettSeries = keyof typeof SERIES;

export interface HammettSubstituent {
  position: "meta" | "para";
  /** The substituent's common name, for a report a chemist can check. */
  name: string;
  sigma: number;
}

export interface HammettEstimate {
  pKa: number;
  series: HammettSeries;
  sigmaSum: number;
  substituents: HammettSubstituent[];
}

/** Why the relationship does not apply here. Always a reason, never a silent absence. */
export interface HammettDeclined {
  declined: string;
}

export type HammettOutcome = HammettEstimate | HammettDeclined;

export function hammettApplies(outcome: HammettOutcome): outcome is HammettEstimate {
  return !("declined" in outcome);
}

function adjacency(graph: PkaMolecularGraph): number[][] {
  const adj: number[][] = Array.from({ length: graph.atoms.length }, () => []);
  for (const bond of graph.bonds) {
    adj[bond.atoms[0]]!.push(bond.atoms[1]);
    adj[bond.atoms[1]]!.push(bond.atoms[0]);
  }
  return adj;
}

function bondOrder(graph: PkaMolecularGraph, i: number, j: number): number {
  for (const bond of graph.bonds) {
    const [a, b] = bond.atoms;
    if ((a === i && b === j) || (a === j && b === i)) return bond.order;
  }
  return 0;
}

/** Every 6-cycle through `start`, as an ordered atom list. */
function sixCycles(adj: number[][], start: number): number[][] {
  const out: number[][] = [];
  const seen = new Set<string>();
  const walk = (path: number[]): void => {
    if (path.length === 6) {
      if (adj[path[5]!]!.includes(start)) {
        const key = [...path].sort((a, b) => a - b).join(",");
        if (!seen.has(key)) {
          seen.add(key);
          out.push([...path]);
        }
      }
      return;
    }
    for (const next of adj[path[path.length - 1]!]!) {
      if (!path.includes(next)) walk([...path, next]);
    }
  };
  walk([start]);
  return out;
}

/**
 * A six-membered all-carbon ring through `ipso`, chosen deterministically.
 *
 * Note what this does NOT check: bond orders. RDKit picks one Kekulé structure out of several, and for
 * naphthalene the one it picks leaves the substituted ring with two internal double bonds rather than
 * three — and the Python and WASM bindings do not always pick the same one. Any test that reads the
 * alternation pattern is therefore a coin flip, and this method's parity fixture would fail on it.
 * Ring identity is decided here on connectivity alone, which every Kekulé form agrees on; the
 * aromaticity question is asked separately by `isBenzene`.
 */
function carbonSixCycle(graph: PkaMolecularGraph, adj: number[][], ipso: number): number[] | null {
  const cycles = sixCycles(adj, ipso).filter((cycle) =>
    cycle.every((i) => graph.atoms[i]!.element === "C" && graph.atoms[i]!.charge === 0)
  );
  if (cycles.length === 0) return null;
  const keyOf = (cycle: number[]) => [...cycle].sort((a, b) => a - b).join(",");
  let best = cycles[0]!;
  for (const cycle of cycles) if (keyOf(cycle) < keyOf(best)) best = cycle;
  return best;
}

/**
 * Every ring atom sp2, with no double bond leaving the ring.
 *
 * Kekulé-independent: it asks whether each atom has three connections and a valence of four, not where
 * the double bonds happen to have been drawn. The exocyclic clause is what keeps p-benzoquinone out —
 * its carbonyl carbons are sp2 with a valence of four and would otherwise read as a benzene ring,
 * earning a quinol a phenol's reaction constant.
 */
function isBenzene(graph: PkaMolecularGraph, adj: number[][], cycle: readonly number[]): boolean {
  const ring = new Set(cycle);
  for (const i of cycle) {
    const atom = graph.atoms[i]!;
    if (adj[i]!.length + atom.hydrogens !== 3) return false;
    const valence = adj[i]!.reduce((sum, j) => sum + bondOrder(graph, i, j), 0) + atom.hydrogens;
    if (valence !== 4) return false;
    if (adj[i]!.some((j) => bondOrder(graph, i, j) === 2 && !ring.has(j))) return false;
  }
  return true;
}

/**
 * Cut the ring's own bonds; if any two ring atoms remain connected, the ring is fused or bridged.
 *
 * Biphenyl survives (only the ipso carbon reaches the second ring, so no two ring atoms end up joined);
 * naphthalene does not (its bridgeheads stay connected through the other ring). The search starts from
 * EVERY ring atom — starting only at the first means never starting at a bridgehead, and 2-naphthol
 * then passes, declining later only by the luck of its fused ring having no tabulated constant.
 */
function isFused(adj: number[][], cycle: number[]): boolean {
  const ring = new Set(cycle);
  const cut = new Set<string>();
  for (let k = 0; k < 6; k += 1) {
    cut.add(`${cycle[k]}-${cycle[(k + 1) % 6]}`);
    cut.add(`${cycle[(k + 1) % 6]}-${cycle[k]}`);
  }
  for (const start of cycle) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const i = queue.shift()!;
      for (const j of adj[i]!) {
        if (cut.has(`${i}-${j}`) || seen.has(j)) continue;
        if (ring.has(j)) return true;
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return false;
}

/**
 * A parity-safe identity for the branch hanging off `attach`.
 *
 * Not a SMILES — there is no writer on this side. Instead, BFS shells outward from the attachment
 * atom, each shell a sorted list of (element, charge, hydrogen count, degree). Keeping shell 0 distinct
 * is what separates -NHC(=O)CH3 from -C(=O)NHCH3: identical atom multisets, quite different sigma.
 */
function shellKey(
  graph: PkaMolecularGraph,
  adj: number[][],
  ring: readonly number[],
  ipsoGroup: ReadonlySet<number>,
  attach: number
): string {
  const seen = new Set<number>([...ring, ...ipsoGroup, attach]);
  const shells: string[] = [];
  let frontier = [attach];
  while (frontier.length > 0 && shells.length < 4) {
    shells.push(
      frontier
        .map((i) => {
          const atom = graph.atoms[i]!;
          const charge = atom.charge >= 0 ? `+${atom.charge}` : `${atom.charge}`;
          return `${atom.element}${charge}h${atom.hydrogens}d${adj[i]!.length}`;
        })
        .sort()
        .join(",")
    );
    const next: number[] = [];
    for (const i of frontier) {
      for (const j of adj[i]!) {
        if (seen.has(j)) continue;
        seen.add(j);
        next.push(j);
      }
    }
    frontier = next;
  }
  return shells.join("|");
}

/**
 * Estimate the pKa of an aryl -OH by its substituents, or say why the relationship does not reach it.
 *
 * `atomIndex` is the oxygen that ionises — the same index the site scan reports.
 */
export function estimateHammettPka(
  graph: PkaMolecularGraph,
  atomIndex: number
): HammettOutcome {
  const atom = graph.atoms[atomIndex];
  if (!atom) return { declined: "no atom at that index" };
  if (atom.element !== "O") return { declined: "site is not an oxygen" };
  // The site oxygen must be the HYDROXYL: neutral, one hydrogen, singly bonded. Read loosely, this
  // matches the carbonyl of a protonated thio-acid (Cc1ccc(C(=[OH+])S)cc1), whose acidity is ten log
  // units from a benzoic acid's — measured, not hypothetical: that error put the benzoic series at
  // MAE 1.73 instead of 0.073.
  if (atom.charge !== 0 || atom.hydrogens !== 1) return { declined: "site oxygen is not a neutral -OH" };

  const adj = adjacency(graph);
  if (adj[atomIndex]!.some((j) => bondOrder(graph, atomIndex, j) !== 1)) {
    return { declined: "site oxygen is not singly bonded" };
  }

  let series: HammettSeries | null = null;
  let ipso = -1;
  let ring: number[] = [];
  let ipsoGroup = new Set<number>();

  for (const neighbour of adj[atomIndex]!) {
    if (graph.atoms[neighbour]!.element !== "C") continue;

    const direct = carbonSixCycle(graph, adj, neighbour);
    if (direct) {
      series = "phenol";
      ipso = neighbour;
      ring = direct;
      ipsoGroup = new Set([atomIndex]);
      break;
    }

    // A carboxyl carbon and nothing else: exactly =O, -OH and the ring. A third heteroatom makes it
    // some other functional group with an entirely different reaction constant.
    const others = adj[neighbour]!.filter((m) => m !== atomIndex);
    const carbonyl = others.filter(
      (m) => graph.atoms[m]!.element === "O" && bondOrder(graph, neighbour, m) === 2
    );
    const aryl = others
      .filter((m) => graph.atoms[m]!.element === "C")
      .map((m) => [m, carbonSixCycle(graph, adj, m)] as const)
      .filter((entry): entry is readonly [number, number[]] => entry[1] !== null);
    if (others.length === 2 && carbonyl.length === 1 && aryl.length === 1) {
      series = "benzoic";
      ipso = aryl[0]![0];
      ring = aryl[0]![1];
      ipsoGroup = new Set([atomIndex, neighbour, carbonyl[0]!]);
      break;
    }
  }
  if (!series) return { declined: "not a benzoic acid or phenol" };
  // Fused FIRST, then aromaticity. Both orders are safe, but only this one gives the same answer
  // whichever Kekulé structure the engine handed over.
  if (isFused(adj, ring)) return { declined: "ring is fused" };
  if (!isBenzene(graph, adj, ring)) return { declined: "ring is not benzene" };

  const start = ring.indexOf(ipso);
  const order = [...ring.slice(start), ...ring.slice(0, start)];
  const substituents: HammettSubstituent[] = [];
  let sigmaSum = 0;

  for (let position = 1; position < order.length; position += 1) {
    const atomAt = order[position]!;
    const branches = adj[atomAt]!.filter((j) => !ring.includes(j) && !ipsoGroup.has(j));
    if (branches.length === 0) continue;

    const distance = Math.min(position, 6 - position);
    // Ortho is outside the relationship, not merely less accurate: the substituent's steric and
    // field effects at 1,2 are not what sigma measures, and there is no ortho constant to use.
    if (distance === 1) return { declined: "ortho substituent" };

    for (const branch of branches) {
      const key = shellKey(graph, adj, ring, ipsoGroup, branch);
      const tabulated = SIGMA.sigma[key];
      if (!tabulated) return { declined: `no sigma constant for ${key}` };

      // sigma-para-minus, phenols only and para only. When the phenolate's charge delocalises straight
      // into a para -M substituent, plain sigma understates it — p-nitrophenol comes out at 8.21
      // against a measured 7.13. A benzoic acid's carboxylate is insulated from the ring by its
      // carbonyl, so there is no through-conjugation there to correct for.
      const throughConjugated =
        distance === 3 && series === "phenol" ? SIGMA.sigmaParaMinus[key] : undefined;
      const sigma = throughConjugated ? throughConjugated[0] : tabulated[distance === 2 ? 0 : 1];

      sigmaSum += sigma;
      substituents.push({ position: distance === 2 ? "meta" : "para", name: tabulated[2], sigma });
    }
  }

  const { pKa0, rho } = SERIES[series];
  return { pKa: pKa0 - rho * sigmaSum, series, sigmaSum, substituents };
}
