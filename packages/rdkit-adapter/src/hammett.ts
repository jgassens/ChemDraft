/**
 * A Hammett linear free-energy relationship: the second, independent pKa estimator.
 *
 * **Why a second method at all.** A single model's confidence is self-reported. Two methods that
 * disagree tell you something a lone one cannot, and the disagreement here is a far better error
 * signal than the forest's internal variance — r = 0.87 against actual error, versus 0.52 for tree
 * disagreement on the same sites.
 *
 * **Where its numbers come from — and it is not this project's training set.** The substituent
 * constants are Hansch, Leo & Taft's compilation (Chem. Rev. 91 (1991) 165–195) and the reaction
 * constants are the classical fitted rho values. Nothing here was fitted to Dwar-iBond, which is the
 * whole point: a second method trained on the same data would agree with the first by construction and
 * its agreement would carry no information.
 *
 * **Accuracy, measured on the 155 Dwar-iBond sites it applies to: MAE 0.195 log units**, against 0.56
 * for the forest on those same sites. By series: benzoic 0.073, phenol 0.227, anilinium 0.219,
 * pyridinium 0.271.
 *
 * **Read the benzoic figure with care.** Sigma was *defined* by benzoic acid ionisation — rho is 1.00
 * there by construction — so 0.073 largely measures that the compilation is self-consistent, not that
 * the method generalises. The phenol number (0.227) is the honest one: sigma came from benzoic acids
 * and is applied here to a different reaction series with an independently fitted rho.
 *
 * **It applies to 5.1% of sites and declines on the rest**, which is the correct behaviour for an LFER
 * — the relationship is a statement about a substituent series, not a general predictor. Ortho
 * substituents, fused rings, and substituents with no tabulated constant are all refused rather than
 * approximated.
 *
 * **Parity.** Every step works from the same graph view the model uses — no aromaticity flags (RDKit's
 * JSON is Kekulé-ised and carries none), no SMILES writer, no ring perception beyond a few lines.
 * `vendor/pka-model/hammett.py` is the line-for-line counterpart that measured the figures above, and
 * `vendor/pka-model/hammett-parity.json` pins the two together over all 155 estimates and every
 * decline branch.
 *
 * **Known limitation.** Anilines with a para -M substituent read high: 4-nitroaniline comes out at
 * 2.35 against a measured 1.00, because the NEUTRAL amine is stabilised by through-conjugation into
 * the nitro group and plain sigma does not capture it. Phenols get a sigma-minus treatment for exactly
 * this; anilines would need their own, and it has not been measured.
 */
import { siteContext } from "./pkaAromaticity";
import type { PkaMolecularGraph } from "./pkaModel";
import sigmaJson from "../vendor/pka-model/hammett-sigma.json";

const SIGMA = sigmaJson as unknown as {
  /** Shell signature -> [sigma_meta, sigma_para, human-readable name]. */
  sigma: Record<string, [number, number, string]>;
  /** Shell signature -> [sigma_para_minus, name]. */
  sigmaParaMinus: Record<string, [number, string]>;
};

/**
 * pKa of the unsubstituted parent, the series' reaction constant, and which equilibrium it describes.
 *
 * The two basic series report the pKa of the CONJUGATE ACID — the anilinium and the pyridinium — which
 * is the number meant by "aniline's pKa". They are computed straight from the neutral form's
 * substituents, because rho and pKa0 already belong to the cation; no microstate has to be built.
 *
 * Every constant is from the physical-organic literature (Jaffe 1953; Perrin's compilations), none
 * fitted here. Measured on the Dwar-iBond sites each reaches: benzoic 0.073, phenol 0.227, anilinium
 * 0.219, pyridinium 0.271.
 */
const SERIES = {
  benzoic: { pKa0: 4.2, rho: 1.0, transition: "acidic" },
  phenol: { pKa0: 9.95, rho: 2.23, transition: "acidic" },
  anilinium: { pKa0: 4.6, rho: 2.89, transition: "basic" },
  pyridinium: { pKa0: 5.25, rho: 5.9, transition: "basic" }
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
  /** Acidic series report the drawn proton leaving; basic ones report the conjugate acid. */
  transition: "acidic" | "basic";
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
 * A six-membered ring through `ipso` whose atoms are all carbon except at most `allowNitrogen` of them.
 *
 * Pyridine needs the exception: its reaction constant is defined for substituents at the 3- and 4-
 * positions relative to the ring nitrogen, so the nitrogen IS the ipso atom and the ring is not
 * carbocyclic.
 *
 * Note what this does NOT check: bond orders. RDKit picks one Kekulé structure out of several, and for
 * naphthalene the one it picks leaves the substituted ring with two internal double bonds rather than
 * three — and the Python and WASM bindings do not always pick the same one. Any test that reads the
 * alternation pattern is therefore a coin flip, and this method's parity fixture would fail on it.
 * Ring identity is decided here on connectivity alone, which every Kekulé form agrees on; the
 * aromaticity question is asked separately by `isBenzene`.
 */
function carbonSixCycle(
  graph: PkaMolecularGraph,
  adj: number[][],
  ipso: number,
  allowNitrogen = 0
): number[] | null {
  const cycles = sixCycles(adj, ipso).filter(
    (cycle) =>
      cycle.every((i) => i === ipso || graph.atoms[i]!.charge === 0) &&
      cycle.filter((i) => graph.atoms[i]!.element === "N").length <= allowNitrogen &&
      cycle.every((i) => graph.atoms[i]!.element === "C" || graph.atoms[i]!.element === "N")
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
 * The two BASIC series: an aniline's nitrogen, and a pyridine-type ring nitrogen.
 *
 * Both report their conjugate acid's pKa, which is the number a chemist means. No microstate is built:
 * rho and pKa0 already belong to the cation, so the neutral form's substituents are all that is needed.
 *
 * The ring must be AROMATIC, checked through the same Hückel count the model's features use. Skipping
 * that was the first version's bug and it was not subtle — cyclohexylammonium read as an anilinium and
 * N-ethylpiperidinium as a pyridinium, which put the two series at MAE 0.45 and 1.78. With the check
 * they measure 0.219 and 0.271.
 */
function nitrogenSeries(graph: PkaMolecularGraph, atomIndex: number): HammettOutcome {
  const atom = graph.atoms[atomIndex]!;
  // Charge-agnostic on purpose. The training labels carry the ACID microstate, so their aniline and
  // pyridine sites are cations; the app sees the neutral form it was drawn as. Both name the same
  // equilibrium and give the same sigma sum, so both are accepted and the value returned is the
  // conjugate acid's either way.
  if (atom.charge !== 0 && atom.charge !== 1) {
    return { declined: "site nitrogen carries an unexpected charge" };
  }

  const adj = adjacency(graph);
  const { aromatic } = siteContext(graph);

  // Aniline: a nitrogen hanging off an aromatic carbocycle, protonated at N.
  if (atom.hydrogens >= 1 && adj[atomIndex]!.length === 1) {
    const ipso = adj[atomIndex]![0]!;
    if (graph.atoms[ipso]!.element === "C" && aromatic[ipso]) {
      const ring = carbonSixCycle(graph, adj, ipso);
      if (ring && ring.every((i) => aromatic[i])) {
        return sumOverRing(graph, adj, "anilinium", ipso, ring, new Set([atomIndex]));
      }
    }
  }

  // Pyridine: the nitrogen is IN the ring and is itself the ipso position. Neutral pyridine carries no
  // hydrogen there; its conjugate acid carries one. Both are the same equilibrium from opposite sides.
  const pyridineLike =
    (atom.charge === 0 && atom.hydrogens === 0) || (atom.charge === 1 && atom.hydrogens === 1);
  if (pyridineLike && aromatic[atomIndex]) {
    const ring = carbonSixCycle(graph, adj, atomIndex, 1);
    if (ring && ring.every((i) => aromatic[i]) && ring.filter((i) => graph.atoms[i]!.element === "N").length === 1) {
      return sumOverRing(graph, adj, "pyridinium", atomIndex, ring, new Set([atomIndex]));
    }
  }

  return { declined: "not an aniline or a pyridine-type nitrogen" };
}

/**
 * Walk the ring from `ipso` and sum sigma over the substituents, or decline with the reason.
 *
 * Shared by all four series: the arithmetic is identical, only rho and pKa0 differ.
 */
function sumOverRing(
  graph: PkaMolecularGraph,
  adj: number[][],
  series: HammettSeries,
  ipso: number,
  ring: number[],
  ipsoGroup: Set<number>
): HammettOutcome {
  if (isFused(adj, ring)) return { declined: "ring is fused" };

  const start = ring.indexOf(ipso);
  const order = [...ring.slice(start), ...ring.slice(0, start)];
  const substituents: HammettSubstituent[] = [];
  let sigmaSum = 0;

  for (let position = 1; position < order.length; position += 1) {
    const atomAt = order[position]!;
    const branches = adj[atomAt]!.filter((j) => !ring.includes(j) && !ipsoGroup.has(j));
    if (branches.length === 0) continue;

    const distance = Math.min(position, 6 - position);
    if (distance === 1) return { declined: "ortho substituent" };

    for (const branch of branches) {
      const key = shellKey(graph, adj, ring, ipsoGroup, branch);
      const tabulated = SIGMA.sigma[key];
      if (!tabulated) return { declined: `no sigma constant for ${key}` };

      // sigma-para-minus applies only where the product anion conjugates into the substituent: the
      // phenolate. Without it p-nitrophenol comes out at 8.21 against a measured 7.13. A benzoic
      // acid's carboxylate is insulated from the ring by its carbonyl, and an anilinium or pyridinium
      // is a CATION losing a proton with nothing to delocalise — so plain sigma is right for those.
      const throughConjugated =
        distance === 3 && series === "phenol" ? SIGMA.sigmaParaMinus[key] : undefined;
      const sigma = throughConjugated ? throughConjugated[0] : tabulated[distance === 2 ? 0 : 1];

      sigmaSum += sigma;
      substituents.push({ position: distance === 2 ? "meta" : "para", name: tabulated[2], sigma });
    }
  }

  const { pKa0, rho, transition } = SERIES[series];
  return { pKa: pKa0 - rho * sigmaSum, series, transition, sigmaSum, substituents };
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
  if (atom.element === "N") return nitrogenSeries(graph, atomIndex);
  if (atom.element !== "O") return { declined: "site is neither an oxygen nor a nitrogen" };
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
  // The oxygen series additionally require a CARBOCYCLIC aromatic ring, which the nitrogen series do
  // not — a pyridine ring is aromatic and is not benzene. Checked before the shared walk, and after
  // the fused test, because only that order gives the same answer whichever Kekulé structure the
  // engine handed over.
  if (isFused(adj, ring)) return { declined: "ring is fused" };
  if (!isBenzene(graph, adj, ring)) return { declined: "ring is not benzene" };
  return sumOverRing(graph, adj, series, ipso, ring, ipsoGroup);
}

