/**
 * The trained per-site pKa model: features, forest evaluation, and the parity rule that keeps them
 * honest.
 *
 * **Provenance.** Trained here on 3,031 per-site labels derived from the open Dwar-iBond set
 * (DataWarrior + iBond, per-row attributed) that Uni-pKa distributes under Apache-2.0. Each label
 * comes from an acid/base microstate pair differing at exactly one atom — that atom is the site, and
 * every extracted index was verified to be the one whose proton count or charge actually changed. No
 * value here is inherited from another predictor: the supervised signal is measured pKa throughout.
 * §8's requirement is therefore satisfiable honestly, and results carry
 * `basis: "experimentally-trained-model"`.
 *
 * **Accuracy: MAE 1.17 log units** under scaffold-grouped 5-fold cross-validation, against 2.94 for
 * predicting the dataset mean. Grouped by canonical skeleton so a scaffold cannot appear in both
 * train and test — an ungrouped split would score better and mean less.
 *
 * **Why a random forest with JSON weights rather than something stronger.** The product is a
 * TypeScript desktop app, so inference must run in-process. A forest evaluates in a few lines here,
 * its weights are inspectable, and there is no second runtime to bundle. A GNN would score better and
 * could not ship.
 *
 * **The parity rule.** Every feature below must be computable IDENTICALLY from what MinimalLib
 * exposes. RDKit's JSON is Kekulé-ised and carries no per-atom aromaticity flag, so aromaticity is
 * absent from the feature set entirely rather than approximated — a feature that means something
 * different at inference time than it did in training is worse than one that does not exist. Ring
 * membership is included because it *is* exactly reproducible, by pruning degree-1 atoms until none
 * remain. `vendor/pka-model/parity-fixture.json` pins ten molecules' features and predictions against
 * the Python that trained the model, so a drift in either direction fails a test.
 */
import forestJson from "../vendor/pka-model/site-pka-forest.json";

/** Elements the one-hot features cover, in the order the model was trained on. Do not reorder. */
const ELEMENTS = ["N", "O", "C", "S", "P", "F", "Cl", "Br", "I"] as const;

interface PackedTree {
  /** Split feature per node; -1 marks a leaf. */
  f: number[];
  t: number[];
  l: number[];
  r: number[];
  v: number[];
}

interface PackedForest {
  featureNames: string[];
  trees: PackedTree[];
  training: { samples: number; cvMae: number; trees: number; maxDepth: number; minSamplesLeaf: number };
}

const FOREST = forestJson as PackedForest;

export const PKA_MODEL_TRAINING = FOREST.training;
export const PKA_MODEL_FEATURE_NAMES: readonly string[] = FOREST.featureNames;

/** The molecule shape these features are computed from — RDKit's `get_json()` output. */
export interface PkaMolecularGraph {
  atoms: { element: string; charge: number; hydrogens: number }[];
  bonds: { atoms: [number, number]; order: number }[];
  /** Whole-molecule descriptors, keyed as `get_descriptors()` names them. */
  descriptors: Record<string, number>;
}

/**
 * Ring membership by leaf pruning.
 *
 * Repeatedly drop atoms with fewer than two remaining connections; whatever survives lies on a cycle.
 * Chosen over anything smarter because it is trivially identical in Python and TypeScript, which is
 * the only property that matters for a model feature.
 */
export function ringMembership(graph: PkaMolecularGraph): boolean[] {
  const count = graph.atoms.length;
  const adjacency: number[][] = Array.from({ length: count }, () => []);
  for (const bond of graph.bonds) {
    adjacency[bond.atoms[0]]!.push(bond.atoms[1]);
    adjacency[bond.atoms[1]]!.push(bond.atoms[0]);
  }
  const degree = adjacency.map((list) => list.length);
  const alive = new Array<boolean>(count).fill(true);

  let changed = true;
  while (changed) {
    changed = false;
    for (let atom = 0; atom < count; atom += 1) {
      if (!alive[atom] || degree[atom]! > 1) continue;
      alive[atom] = false;
      changed = true;
      for (const neighbour of adjacency[atom]!) {
        if (alive[neighbour]) degree[neighbour] = degree[neighbour]! - 1;
      }
    }
  }
  return alive;
}

function descriptor(graph: PkaMolecularGraph, name: string): number {
  return graph.descriptors[name] ?? 0;
}

/**
 * Build the 45-element feature vector for one site.
 *
 * The order is the order the model was trained on and must not change; `PKA_MODEL_FEATURE_NAMES`
 * carries the names, and a test asserts the two stay the same length.
 */
export function siteFeatures(graph: PkaMolecularGraph, atomIndex: number, ring: boolean[]): number[] {
  const atom = graph.atoms[atomIndex];
  if (!atom) throw new Error(`No atom at index ${atomIndex}`);

  const neighbours: number[] = [];
  let doubleBonds = 0;
  let tripleBonds = 0;
  let bondOrderSum = 0;
  for (const bond of graph.bonds) {
    const [a, b] = bond.atoms;
    if (a !== atomIndex && b !== atomIndex) continue;
    neighbours.push(a === atomIndex ? b : a);
    bondOrderSum += bond.order;
    if (bond.order === 2) doubleBonds += 1;
    if (bond.order === 3) tripleBonds += 1;
  }

  const shell1 = neighbours.map((index) => graph.atoms[index]!.element);
  const shell2: string[] = [];
  for (const neighbour of neighbours) {
    for (const bond of graph.bonds) {
      const [a, b] = bond.atoms;
      if (a !== neighbour && b !== neighbour) continue;
      const other = a === neighbour ? b : a;
      if (other !== atomIndex) shell2.push(graph.atoms[other]!.element);
    }
  }

  const features: number[] = [];
  for (const element of ELEMENTS) features.push(atom.element === element ? 1 : 0);
  features.push(
    atom.charge,
    ring[atomIndex] ? 1 : 0,
    atom.hydrogens,
    neighbours.length,
    bondOrderSum + atom.hydrogens
  );
  for (const element of ELEMENTS) features.push(shell1.filter((symbol) => symbol === element).length);
  for (const element of ELEMENTS) features.push(shell2.filter((symbol) => symbol === element).length);
  features.push(
    neighbours.filter((index) => graph.atoms[index]!.charge !== 0).length,
    neighbours.filter((index) => ring[index]).length,
    doubleBonds,
    tripleBonds
  );

  const netCharge = graph.atoms.reduce((sum, entry) => sum + entry.charge, 0);
  features.push(
    descriptor(graph, "amw") / 100,
    descriptor(graph, "tpsa") / 100,
    descriptor(graph, "CrippenClogP"),
    descriptor(graph, "NumHBD"),
    descriptor(graph, "NumHBA"),
    descriptor(graph, "NumRings"),
    descriptor(graph, "NumAromaticRings"),
    netCharge,
    descriptor(graph, "NumHeavyAtoms") / 10
  );
  return features;
}

/** Walk one packed tree. */
function evaluateTree(tree: PackedTree, features: readonly number[]): number {
  let node = 0;
  // `f[node] < 0` marks a leaf, matching scikit-learn's TREE_UNDEFINED convention.
  while (tree.f[node]! >= 0) {
    node = features[tree.f[node]!]! <= tree.t[node]! ? tree.l[node]! : tree.r[node]!;
  }
  return tree.v[node]!;
}

/** The forest's prediction: the mean over its trees, exactly as scikit-learn averages them. */
export function predictSitePka(features: readonly number[]): number {
  if (features.length !== FOREST.featureNames.length) {
    throw new Error(
      `pKa model expects ${FOREST.featureNames.length} features, received ${features.length}.`
    );
  }
  let total = 0;
  for (const tree of FOREST.trees) total += evaluateTree(tree, features);
  return total / FOREST.trees.length;
}
