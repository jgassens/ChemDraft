/**
 * The site-centred message-passing network, evaluated in-process.
 *
 * This is the half of the GNN that ships. `vendor/pka-model/pka_gnn.py` trains it; this file runs it,
 * in plain TypeScript, with no framework and no second runtime — which was the actual objection to a
 * network all along. The forest it replaces is 6 MB of packed decision trees; these weights are about
 * a quarter of that, because a network stores what it learned rather than every split it made.
 *
 * **The arithmetic is deliberately dull.** Gather, scatter-add, matrix-multiply, ReLU. No attention,
 * no normalisation layers, nothing whose exact semantics differ between frameworks. Every operation
 * here has one obvious implementation, which is what makes the parity fixture able to hold the two
 * sides to 1e-5 of each other.
 *
 * **The features come from code that was already checked twice.** Aromaticity is `siteContext`, ring
 * membership is `ringMembership`, and bond-in-ring is `shareARing` — the same bounded cycle walk
 * `aromaticity.cycles_through` performs in Python. Those are the three that could plausibly disagree,
 * and all three already have a parity history. Element, charge, hydrogen count, degree and bond order
 * are read straight off the graph both sides share.
 *
 * One trap avoided: bond-in-ring is NOT "both atoms are in a ring". Biphenyl's central bond joins two
 * ring atoms and lies in no ring, and RDKit's own `IsInRing()` — which has no counterpart here — would
 * have been the tempting thing to train against.
 */
import { ringMembership, type PkaMolecularGraph } from "./pkaModel";
import gnnJson from "../vendor/pka-model/site-pka-gnn.json";
import intervalJson from "../vendor/pka-model/interval-calibration.json";
import { cyclesThrough, distancesFrom, shareARing, siteContext } from "./pkaAromaticity";

/** Element one-hot order. Shared with the trainer; reordering silently rebinds every first-layer weight. */
const ELEMENTS = ["N", "O", "C", "S", "P", "F", "Cl", "Br", "I"] as const;

const CHARGE_SLOTS = 6;
const CHARGE_OFFSET = 2;
const HYDROGEN_SLOTS = 6;
const DEGREE_SLOTS = 5;

export interface GnnWeights {
  architecture: {
    elements: string[]; atomFeatures: number; bondFeatures: number;
    hidden: number; layers: number; ensemble: number;
    /**
     * Site-relative features and radial pooling, and everything needed to rebuild them.
     *
     * Absent or false means the acid-only architecture this file shipped first, so an older artifact
     * still loads unchanged. Present means the trainer wrote the partition it pooled by, rather than
     * this file guessing — `gnn_infer.py` used to build its network from whatever module constant
     * happened to be in the checkout, and threw size mismatches the moment an artifact disagreed. An
     * artifact that describes its own shape can be scored by a runtime nobody edited to match it.
     */
    siteShells?: boolean;
    readsConjugateBase?: boolean;
    distanceBuckets?: number | null;
    ringSizeBuckets?: number | null;
    shellBounds?: number[][] | null;
    electronegativity?: Record<string, number> | null;
  };
  /** One weight set per ensemble member. Their mean is the estimate; their spread is the interval. */
  members: Record<string, number[][] | number[]>[];
  training: {
    samples: number; cvMae: number; grouping: string; groups: number;
    baselinePredictTheMean: number; hidden: number; layers: number; epochs: number;
    ensemble: number; spreadCorrelation: number; spreadMultiplier: number;
    intervalQuartiles: number[];
  };
}

function oneHot(into: number[], value: number, slots: number): void {
  for (let i = 0; i < slots; i += 1) into.push(i === value ? 1 : 0);
}

/**
 * The site-relative feature set, as the artifact declares it.
 *
 * Resolved once per prediction rather than read field-by-field, so a half-written artifact fails loudly
 * here instead of silently producing a feature vector of the wrong width — which the readout would
 * happily consume as though the columns meant something else.
 */
interface ShellConfig {
  distanceBuckets: number;
  ringSizeBuckets: number;
  shellBounds: number[][];
  electronegativity: Record<string, number>;
}

/** Pauling's value for an element the table does not carry. Mirrors Python's `.get(symbol, 2.20)`. */
const DEFAULT_ELECTRONEGATIVITY = 2.2;

function shellConfigOf(architecture: GnnWeights["architecture"]): ShellConfig | undefined {
  if (architecture.siteShells !== true) return undefined;
  const { distanceBuckets, ringSizeBuckets, shellBounds, electronegativity } = architecture;
  if (
    typeof distanceBuckets !== "number" || typeof ringSizeBuckets !== "number" ||
    !Array.isArray(shellBounds) || electronegativity == null
  ) {
    throw new Error("pKa artifact declares siteShells but omits the shape it pools by");
  }
  return { distanceBuckets, ringSizeBuckets, shellBounds, electronegativity };
}

/** Atom features, bond features and the directed edge list — the trainer's `featurise`, exactly. */
export function gnnFeatures(graph: PkaMolecularGraph, site: number, shells?: ShellConfig): {
  atoms: number[][];
  bonds: number[][];
  src: number[];
  dst: number[];
  /** Which radial shell each atom pools into. Empty when the architecture pools globally. */
  shellOfAtom: number[];
} {
  const context = siteContext(graph);
  const adjacency = context.adjacency;
  const inRing = ringMembership(graph);

  const chiOf = (i: number): number =>
    shells?.electronegativity[graph.atoms[i]?.element ?? ""] ?? DEFAULT_ELECTRONEGATIVITY;

  const bonds: number[][] = [];
  const src: number[] = [];
  const dst: number[] = [];
  for (const bond of graph.bonds) {
    const [a, b] = bond.atoms;
    const inRingBond = shareARing(adjacency, a, b);
    // An AROMATIC bond's order is not Kekule-invariant — RDKit in Python and MinimalLib here choose
    // different structures for the same ring, so one calls a bond single and the other double. It is
    // therefore flagged and its order withheld. A non-aromatic order IS invariant and is kept.
    const aromaticBond =
      context.aromatic[a] === true && context.aromatic[b] === true && inRingBond;
    const feature: number[] = [aromaticBond ? 1 : 0];
    if (aromaticBond) feature.push(0, 0, 0);
    else oneHot(feature, Math.round(bond.order) - 1, 3);
    feature.push(inRingBond ? 1 : 0);
    // Bond polarisation, appended ONCE before both pushes. The two directions share this array by
    // reference, which is exactly what the trainer does: it walks its already-doubled edge list and
    // writes the same |Δχ| for each direction. Appending after the pushes would land it twice.
    if (shells) feature.push(Math.abs(chiOf(a) - chiOf(b)) / 2);
    // Both directions, in the trainer's order: messages flow each way.
    src.push(a); dst.push(b); bonds.push(feature);
    src.push(b); dst.push(a); bonds.push(feature);
  }

  // BFS hop count to the site, and the trap that comes with reusing `distancesFrom`: it neither clips
  // nor names the unreachable. The trainer initialises every atom to `far` and stops walking there, so
  // an atom eight bonds out and an atom in a detached fragment BOTH read `far`. A Map that simply omits
  // the unreachable would read `undefined`, and `undefined` one-hots to all zeros — a fifth state the
  // trained weights have never seen.
  const far = shells ? shells.distanceBuckets - 1 : 0;
  const reached = shells ? distancesFrom(adjacency, site) : undefined;

  const atoms: number[][] = [];
  for (let i = 0; i < graph.atoms.length; i += 1) {
    const atom = graph.atoms[i]!;
    const element = ELEMENTS.indexOf(atom.element as (typeof ELEMENTS)[number]);
    const row: number[] = [];
    oneHot(row, element, ELEMENTS.length);
    row.push(element < 0 ? 1 : 0);
    oneHot(row, atom.charge + CHARGE_OFFSET, CHARGE_SLOTS);
    oneHot(row, atom.hydrogens, HYDROGEN_SLOTS);
    oneHot(row, (adjacency[i] ?? []).length, DEGREE_SLOTS);
    row.push(context.aromatic[i] === true ? 1 : 0, inRing[i] === true ? 1 : 0);
    row.push(i === site ? 1 : 0);
    if (shells) {
      oneHot(row, Math.min(reached!.get(i) ?? far, far), shells.distanceBuckets);
      // Smallest cycle THROUGH this atom, from the same bounded walk the trainer uses — so a ring
      // larger than `MAX_RING` is invisible to both sides rather than to one. Acyclic one-hots to all
      // zeros, which is the trainer's `-1` index.
      const cycles = cyclesThrough(adjacency, i);
      const smallest = cycles.length === 0
        ? 0
        : cycles.reduce((least, cycle) => Math.min(least, cycle.length), Infinity);
      oneHot(
        row,
        smallest === 0 ? -1 : Math.max(0, Math.min(smallest - 3, shells.ringSizeBuckets - 1)),
        shells.ringSizeBuckets
      );
      row.push(chiOf(i) / 4);
    }
    atoms.push(row);
  }

  // One scatter target per shell, in the trainer's order, so the readout receives position rather
  // than one undifferentiated global sum.
  const shellOfAtom: number[] = [];
  if (shells) {
    for (let i = 0; i < graph.atoms.length; i += 1) {
      const d = Math.min(reached!.get(i) ?? far, far);
      const found = shells.shellBounds.findIndex(([lo, hi]) => d >= lo! && d <= hi!);
      shellOfAtom.push(found < 0 ? shells.shellBounds.length - 1 : found);
    }
  }
  return { atoms, bonds, src, dst, shellOfAtom };
}

/** `y = x W^T + b`, the layout `nn.Linear` stores. */
function linear(x: readonly number[], weight: number[][], bias: number[]): number[] {
  const out = new Array<number>(weight.length);
  for (let o = 0; o < weight.length; o += 1) {
    const row = weight[o]!;
    let sum = bias[o]!;
    for (let i = 0; i < row.length; i += 1) sum += row[i]! * x[i]!;
    out[o] = sum;
  }
  return out;
}

const relu = (v: number[]): number[] => v.map((x) => (x > 0 ? x : 0));

/**
 * One member's forward pass.
 *
 * Mirrors `SitePkaNet.forward` line for line: embed, then `layers` rounds of message and update, then
 * a readout over the site atom concatenated with the summed graph.
 */
function forward(
  w: Record<string, number[][] | number[]>,
  architecture: GnnWeights["architecture"],
  features: ReturnType<typeof gnnFeatures>,
  site: number
): number {
  const { atoms, bonds, src, dst } = features;
  const { hidden, layers } = architecture;
  const matrix = (name: string) => w[name] as number[][];
  const vector = (name: string) => w[name] as number[];

  let h = atoms.map((row) => relu(linear(row, matrix("embed.weight"), vector("embed.bias"))));

  for (let layer = 0; layer < layers; layer += 1) {
    const messageWeight = matrix(`message.${layer}.weight`);
    const messageBias = vector(`message.${layer}.bias`);
    // Scatter-add, which is `index_add_`: every edge contributes to its destination.
    const gathered = h.map(() => new Array<number>(hidden).fill(0));
    for (let e = 0; e < src.length; e += 1) {
      const carried = [...h[src[e]!]!, ...bonds[e]!];
      const message = relu(linear(carried, messageWeight, messageBias));
      const target = gathered[dst[e]!]!;
      for (let k = 0; k < hidden; k += 1) target[k] += message[k]!;
    }
    const updateWeight = matrix(`update.${layer}.weight`);
    const updateBias = vector(`update.${layer}.bias`);
    h = h.map((node, i) => relu(linear([...node, ...gathered[i]!], updateWeight, updateBias)));
  }

  // Radial pooling when the artifact declares it: one sum per shell, concatenated in shell order,
  // which is what `index_add_` into a (graphs x shells, hidden) buffer viewed as (graphs, shells*hidden)
  // produces. Otherwise the single global sum this file shipped with.
  const shellCount = features.shellOfAtom.length > 0 ? architecture.shellBounds!.length : 1;
  const pooled = new Array<number>(hidden * shellCount).fill(0);
  for (let i = 0; i < h.length; i += 1) {
    const base = shellCount === 1 ? 0 : features.shellOfAtom[i]! * hidden;
    const node = h[i]!;
    for (let k = 0; k < hidden; k += 1) pooled[base + k] += node[k]!;
  }

  const joined = [...h[site]!, ...pooled];
  const first = relu(linear(joined, matrix("readout.0.weight"), vector("readout.0.bias")));
  return linear(first, matrix("readout.2.weight"), vector("readout.2.bias"))[0]!;
}

/**
 * One site's pKa, and how much the ensemble disagrees about it.
 *
 * The same shape `predictSitePkaWithSpread` returned for the forest, and for the same reason: the
 * interval is not decoration. It decides the confidence ring in the figure, whether a rung is solid
 * enough to be a step in a titration curve, and how the model is weighted against the Hammett
 * relationship. Members share every feature, so the graph is built once and reused.
 */
export function predictWithGnn(
  model: GnnWeights,
  graph: PkaMolecularGraph,
  site: number
): { value: number; spread: number } {
  const features = gnnFeatures(graph, site, shellConfigOf(model.architecture));
  const votes = model.members.map((member) => forward(member, model.architecture, features, site));
  const mean = votes.reduce((sum, v) => sum + v, 0) / votes.length;
  const variance = votes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / votes.length;
  return { value: mean, spread: intervalFor(Math.sqrt(variance), graph.atoms[site]?.element) };
}

/**
 * The interval for one ensemble deviation, read off the calibration curve.
 *
 * This replaces multiplying the deviation by one constant. That constant was chosen so the interval
 * covers 68% of errors across the whole corpus, and it does — but conditionally it was wrong in both
 * directions, which is the way that matters, because a reader looks at one molecule and not at a
 * corpus. Measured by decile of the reported interval, coverage ran 50.1% at the confident end to
 * 85.6% at the loose end against a claimed 68%: too tight exactly where a reader trusts it most.
 *
 * No multiplier can fix that, because the relationship is CONCAVE. Doubling the ensemble's
 * disagreement does not double the error — there is a floor, since members trained on one corpus share
 * its blind spots and perfect agreement is not zero error, and a ceiling, since a wildly disagreeing
 * ensemble is saying "no idea" rather than being wrong by that much.
 *
 * `interval-calibration.json` holds the empirical quantile of |error| within equal-count bins of the
 * deviation, measured out-of-fold. Every bin lands at 68.0% by construction. Linear interpolation
 * between bin centres, clamped outside them — conservative at the top, honest at the bottom.
 *
 * **`element` selects the stratum, and it is not optional in spirit.** The deviation was the whole
 * taxonomy, and conditioned on the ionizing atom it under-covered CARBON by nine points — 59.2% against
 * a claimed 68%, where nitrogen ran 68.1% and oxygen 68.5%. A carbon acid is harder than a nitrogen at
 * the same ensemble disagreement, so one pooled curve hands it an interval calibrated on molecules that
 * are not like it. Mondrian conformal prediction allows any partition as the taxonomy; carbon gets its
 * own curve, measured on held-out folds at 67.9%. See `interval_calibrate.py` for the full table and for
 * why per-ELEMENT strata were tried and rejected (449 carbon rows over 12 bins overshoot to 71%).
 *
 * Omitting `element` falls back to the pooled curve. That is the conservative reading rather than a
 * silent carbon default: a caller who does not know the element gets what the whole corpus agreed on.
 */
export function intervalFor(deviation: number, element?: string): number {
  const points = strataFor(element);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (!Number.isFinite(deviation) || deviation <= first.spread) return first.interval;
  if (deviation >= last.spread) return last.interval;
  for (let i = 1; i < points.length; i += 1) {
    const above = points[i]!;
    if (deviation <= above.spread) {
      const below = points[i - 1]!;
      const span = above.spread - below.spread;
      const t = span === 0 ? 0 : (deviation - below.spread) / span;
      return below.interval + t * (above.interval - below.interval);
    }
  }
  return last.interval;
}

type CalibrationCurve = { spread: number; interval: number; samples: number; coverage: number }[];

/** How an ensemble deviation becomes a reported interval. See `intervalFor`. */
const INTERVAL_CALIBRATION = intervalJson as unknown as {
  targetCoverage: number;
  achievedCoverage: number;
  worstBinDeviation: number;
  samples: number;
  /** Quartiles of the calibrated interval over the corpus — the figure's confidence bands. */
  intervalQuartiles: number[];
  /** Measured coverage per ionizing element under the stratified taxonomy. */
  coverageByElement?: Record<string, number>;
  /** How many sites each element's coverage figure rests on — a tolerance has to know. */
  samplesByElement?: Record<string, number>;
  /** The pooled curve, used when the element is unknown. */
  points: CalibrationCurve;
  /** The taxonomy: `carbon` and `other`. */
  strata?: Record<string, CalibrationCurve>;
};

/**
 * Which calibration curve an element reads.
 *
 * Falls back to the pooled curve when the artifact predates the stratified taxonomy, so a calibration
 * regenerated by an older `interval_calibrate.py` still produces the intervals it was fitted for rather
 * than throwing.
 */
function strataFor(element?: string): CalibrationCurve {
  const strata = INTERVAL_CALIBRATION.strata;
  if (!strata || element === undefined) return INTERVAL_CALIBRATION.points;
  return strata[element === "C" ? "carbon" : "other"] ?? INTERVAL_CALIBRATION.points;
}

export const PKA_INTERVAL_CALIBRATION = INTERVAL_CALIBRATION;

/** The shipped model. */
const GNN = gnnJson as unknown as GnnWeights;

export const PKA_GNN_TRAINING = GNN.training;

/**
 * The estimate every site value in this method comes from.
 *
 * Drop-in for the forest's `predictSitePkaWithSpread`, with one difference worth stating: it takes the
 * GRAPH rather than a feature vector. The forest needed whole-molecule descriptors — average mass,
 * polar surface area, Crippen logP — and that is exactly the channel through which a sodium counterion
 * moved acetic acid's answer by 0.1 without appearing anywhere in the result. A message-passing network
 * reads the molecule itself, so that channel no longer exists.
 */
export function predictSitePka(
  graph: PkaMolecularGraph,
  site: number
): { value: number; spread: number } {
  return predictWithGnn(GNN, graph, site);
}
