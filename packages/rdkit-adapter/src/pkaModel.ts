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
 * **Accuracy: MAE 1.62 log units** under Bemis-Murcko-scaffold-grouped 5-fold cross-validation,
 * against 2.94 for predicting the dataset mean.
 *
 * That figure was 1.18 until the grouping was checked, and the correction is worth stating because the
 * mistake is easy to repeat. Folds were grouped by CANONICAL SMILES, which reads like a scaffold split
 * and is not one — it separates identical molecules and nothing else, 3,030 groups for 3,031 rows. So
 * every congeneric series in Dwar-iBond was split across folds and each held-out row kept near-twins in
 * training. Murcko scaffolds give 1,167 groups and MAE 1.62; external data the model has never seen
 * (Novartis + SAMPL, n=38) gives 1.24, between the two. `vendor/pka-model/pka_train.py` now carries the
 * grouping, and it is vendored precisely so this cannot go unread again.
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
import calibrationJson from "../vendor/pka-model/calibration.json";
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
  training: {
    samples: number; cvMae: number; cvRmse: number;
    trees: number; maxDepth: number; minSamplesLeaf: number;
    /** How folds were held out. The figure above means nothing without it. */
    grouping: string; groups: number;
    baselinePredictTheMean: number;
  };
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

/**
 * What the disagreement signal was measured to be worth, out of fold.
 *
 * Read from the measurement rather than typed here, so the figures shown to a user cannot drift away
 * from the ones the model actually earned. `calibration-pairs.json` holds the 3,031 out-of-fold
 * (disagreement, error) pairs behind these four numbers, and a test recomputes the summary from them
 * — a hand-edited claim fails.
 */
export const PKA_MODEL_CALIBRATION = calibrationJson as {
  /** How it was measured, in one line, for anything that reports the figures. */
  measurement: string;
  samples: number;
  /** Pearson r between tree disagreement and actual absolute error. */
  correlation: number;
  /** MAE within each quartile of disagreement, lowest first. */
  quartileMae: number[];
  /** How folds were held out. Every figure here is meaningless without it. */
  grouping: string;
  groups: number;
  /** Fraction of held-out errors inside +/- k*sd, keyed by k. */
  coverage: Record<string, number>;
  spreadMultiplier: number;
  /** Interval widths at the 25th/50th/75th percentile, the bands `quartileMae` was measured over. */
  intervalQuartiles: number[];
};

/**
 * How wide the interval is drawn relative to the trees' disagreement.
 *
 * 1.5 because that is the multiplier whose coverage is closest to a conventional ~80% interval;
 * `PKA_MODEL_CALIBRATION.coverage` records what each candidate actually delivered.
 */
const SPREAD_MULTIPLIER = PKA_MODEL_CALIBRATION.spreadMultiplier;

export interface SitePkaPrediction {
  value: number;
  /** Standard deviation across the forest's trees — the raw disagreement signal. */
  treeDisagreement: number;
  /** A calibrated ~80% interval half-width, `SPREAD_MULTIPLIER * treeDisagreement`. */
  spread: number;
}

/**
 * The forest's prediction, and how much its trees disagreed about it.
 *
 * The disagreement is the useful part. A single global error figure says the same thing about every
 * molecule; tree variance says something about THIS one, and it is predictive rather than decorative
 * — see `PKA_MODEL_CALIBRATION` for what it was measured to be worth out of fold.
 *
 * It is a population property and not a per-molecule guarantee. It says where the training data was
 * dense, which is not the same as where the model is right: an unusual molecule can still draw
 * confident agreement from trees that are all extrapolating the same way, and a common one can draw
 * a wide interval because its class genuinely spans a wide range. Read a narrow interval as "many
 * similar sites were seen", not as "this value is correct".
 */
export function predictSitePkaWithSpread(features: readonly number[]): SitePkaPrediction {
  if (features.length !== FOREST.featureNames.length) {
    throw new Error(
      `pKa model expects ${FOREST.featureNames.length} features, received ${features.length}.`
    );
  }
  const votes = FOREST.trees.map((tree) => evaluateTree(tree, features));
  const value = votes.reduce((sum, vote) => sum + vote, 0) / votes.length;
  // Population sd, matching numpy's default ddof=0 — the calibration above was measured with it.
  const variance = votes.reduce((sum, vote) => sum + (vote - value) ** 2, 0) / votes.length;
  const treeDisagreement = Math.sqrt(variance);
  return { value, treeDisagreement, spread: SPREAD_MULTIPLIER * treeDisagreement };
}

/** The forest's prediction: the mean over its trees, exactly as scikit-learn averages them. */
export function predictSitePka(features: readonly number[]): number {
  return predictSitePkaWithSpread(features).value;
}
