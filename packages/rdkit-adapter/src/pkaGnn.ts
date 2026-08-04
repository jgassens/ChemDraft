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
import { shareARing, siteContext } from "./pkaAromaticity";

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

/** Atom features, bond features and the directed edge list — the trainer's `featurise`, exactly. */
export function gnnFeatures(graph: PkaMolecularGraph, site: number): {
  atoms: number[][];
  bonds: number[][];
  src: number[];
  dst: number[];
} {
  const context = siteContext(graph);
  const adjacency = context.adjacency;
  const inRing = ringMembership(graph);

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
    // Both directions, in the trainer's order: messages flow each way.
    src.push(a); dst.push(b); bonds.push(feature);
    src.push(b); dst.push(a); bonds.push(feature);
  }

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
    atoms.push(row);
  }
  return { atoms, bonds, src, dst };
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

  const pooled = new Array<number>(hidden).fill(0);
  for (const node of h) for (let k = 0; k < hidden; k += 1) pooled[k] += node[k]!;

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
  const features = gnnFeatures(graph, site);
  const votes = model.members.map((member) => forward(member, model.architecture, features, site));
  const mean = votes.reduce((sum, v) => sum + v, 0) / votes.length;
  const variance = votes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / votes.length;
  return { value: mean, spread: Math.sqrt(variance) * model.training.spreadMultiplier };
}

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
