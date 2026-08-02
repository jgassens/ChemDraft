/**
 * Parity between the TypeScript inference path and the Python that trained the model.
 *
 * This is the test the whole port depends on. A feature computed even slightly differently here than
 * in training feeds the forest a number that means something else, and the model answers confidently
 * anyway — there is no error, just a wrong pKa. `vendor/pka-model/parity-fixture.json` pins ten real
 * molecules' feature vectors and predictions as scikit-learn produced them, so drift on either side
 * fails here rather than in someone's chemistry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureRdkit, resetRdkitForTesting } from "./conformer";
import {
  PKA_MODEL_CALIBRATION,
  PKA_MODEL_FEATURE_NAMES,
  PKA_MODEL_TRAINING,
  predictSitePka,
  predictSitePkaWithSpread,
  ringMembership,
  siteFeatures,
  type PkaMolecularGraph
} from "./pkaModel";
import calibrationPairs from "../vendor/pka-model/calibration-pairs.json";
import fixture from "../vendor/pka-model/parity-fixture.json";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});
afterAll(() => {
  resetRdkitForTesting();
});

const ELEMENT_BY_Z: Record<number, string> = {
  1: "H", 5: "B", 6: "C", 7: "N", 8: "O", 9: "F", 14: "Si", 15: "P", 16: "S",
  17: "Cl", 34: "Se", 35: "Br", 53: "I", 11: "Na", 19: "K", 12: "Mg", 20: "Ca"
};

/** Build the model's graph view from the engine, exactly as the analysis path will. */
async function graphFor(smiles: string): Promise<PkaMolecularGraph> {
  const rdkit = (await ensureRdkit()) as unknown as { get_mol(s: string): unknown };
  const mol = rdkit.get_mol(smiles) as { get_json(): string; get_descriptors(): string; delete(): void };
  try {
    const json = JSON.parse(mol.get_json()) as {
      defaults?: { atom?: { z?: number; chg?: number; impHs?: number }; bond?: { bo?: number } };
      molecules: { atoms: { z?: number; chg?: number; impHs?: number }[]; bonds: { atoms: number[]; bo?: number }[] }[];
    };
    const defaults = json.defaults ?? {};
    const dz = defaults.atom?.z ?? 6;
    const dchg = defaults.atom?.chg ?? 0;
    const dh = defaults.atom?.impHs ?? 0;
    const dbo = defaults.bond?.bo ?? 1;
    const molecule = json.molecules[0]!;
    return {
      atoms: molecule.atoms.map((atom) => ({
        element: ELEMENT_BY_Z[atom.z ?? dz] ?? "X",
        charge: atom.chg ?? dchg,
        hydrogens: atom.impHs ?? dh
      })),
      bonds: molecule.bonds.map((bond) => ({
        atoms: [bond.atoms[0]!, bond.atoms[1]!] as [number, number],
        order: bond.bo ?? dbo
      })),
      descriptors: JSON.parse(mol.get_descriptors()) as Record<string, number>
    };
  } finally {
    mol.delete();
  }
}

describe("feature parity with the training pipeline", () => {
  it.each(fixture.map((entry, index) => [index, entry.acid] as const))(
    "reproduces scikit-learn's features for fixture %i (%s)",
    async (index) => {
      const entry = fixture[index]!;
      const graph = await graphFor(entry.acid);
      const features = siteFeatures(graph, entry.atomIdx, ringMembership(graph));

      expect(features).toHaveLength(entry.features.length);
      for (let i = 0; i < features.length; i += 1) {
        expect(
          features[i],
          `feature "${PKA_MODEL_FEATURE_NAMES[i]}" differs from training`
        ).toBeCloseTo(entry.features[i]!, 4);
      }
    }
  );

  it.each(fixture.map((entry, index) => [index, entry.acid] as const))(
    "reproduces scikit-learn's prediction for fixture %i (%s)",
    async (index) => {
      const entry = fixture[index]!;
      const graph = await graphFor(entry.acid);
      const predicted = predictSitePka(siteFeatures(graph, entry.atomIdx, ringMembership(graph)));
      // Tight: the forest is deterministic arithmetic, so anything beyond rounding is a real defect.
      expect(predicted).toBeCloseTo(entry.prediction, 3);
    }
  );
});

describe("per-site confidence", () => {
  it.each(fixture.map((entry, index) => [index, entry.acid] as const))(
    "reproduces scikit-learn's tree disagreement for fixture %i (%s)",
    async (index) => {
      // The spread is only meaningful if it is the same number the calibration was measured on.
      const entry = fixture[index]!;
      const graph = await graphFor(entry.acid);
      const prediction = predictSitePkaWithSpread(siteFeatures(graph, entry.atomIdx, ringMembership(graph)));
      expect(prediction.treeDisagreement).toBeCloseTo(entry.treeDisagreement, 3);
    }
  );

  it("scales the interval to the disagreement it was calibrated against", async () => {
    const graph = await graphFor("Oc1ccccc1");
    const prediction = predictSitePkaWithSpread(siteFeatures(graph, 0, ringMembership(graph)));
    expect(prediction.spread).toBeCloseTo(
      PKA_MODEL_CALIBRATION.spreadMultiplier * prediction.treeDisagreement,
      9
    );
    expect(prediction.spread).toBeGreaterThan(0);
  });
});

/**
 * The calibration is what makes the interval mean anything, so it is checked against its own
 * evidence rather than trusted.
 *
 * Deliberately NOT tested by picking a "familiar" molecule and an "unusual" one and asserting the
 * first gets the tighter interval — that was tried, and it failed for a real reason: a perfluorinated
 * carboxylic acid, chosen as the oddity, drew *more* agreement than phenol, because carboxylic acids
 * are dense in the training data and the trees all put it low. Discrimination is a property of the
 * population, not a promise about any given pair, and testing it as an anecdote would have encoded a
 * claim the model does not make.
 */
describe("the calibration behind the interval", () => {
  const pairs = calibrationPairs.pairs as [number, number][];
  const mae = (rows: [number, number][]) =>
    rows.reduce((sum, [, error]) => sum + error, 0) / rows.length;

  it("recomputes the published summary from the held-out pairs", () => {
    // The figures the app shows must be the ones the measurement produced. Editing the summary by
    // hand — to round a number up, or to keep a stale figure after retraining — fails here.
    expect(pairs).toHaveLength(PKA_MODEL_CALIBRATION.samples);
    // Slack of two samples, not an arbitrary decimal place: the pairs are stored rounded to 4 dp, so
    // a site sitting exactly on the coverage boundary can round to the other side of it.
    const slack = 2 / pairs.length;
    for (const [multiplier, published] of Object.entries(PKA_MODEL_CALIBRATION.coverage)) {
      const covered =
        pairs.filter(([sd, error]) => error <= Number(multiplier) * sd).length / pairs.length;
      expect(Math.abs(covered - published), `coverage at ${multiplier} sd`).toBeLessThan(slack);
    }
  });

  it("separates the sites worth trusting from the ones that need checking", () => {
    // The claim the interval rests on: sorted by how much the trees disagreed, the least-disagreeing
    // quarter is far more accurate than the most. If a retrain kills that signal, the interval is
    // decoration and this fails rather than shipping quietly.
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const quarter = Math.floor(sorted.length / 4);
    const best = mae(sorted.slice(0, quarter));
    const worst = mae(sorted.slice(-quarter));

    expect(best).toBeLessThan(1.0);
    expect(worst).toBeGreaterThan(1.8);
    expect(worst / best).toBeGreaterThan(3);
    expect(best).toBeCloseTo(PKA_MODEL_CALIBRATION.quartileMae[0]!, 2);
    expect(worst).toBeCloseTo(PKA_MODEL_CALIBRATION.quartileMae[3]!, 2);
  });

  it("is measured out of fold, and says so", () => {
    // In-fold the forest agrees with itself and every interval would look excellent.
    expect(PKA_MODEL_CALIBRATION.measurement).toMatch(/out-of-fold/);
    expect(PKA_MODEL_CALIBRATION.measurement).toMatch(/scaffold-grouped/);
  });
});

describe("ring membership", () => {
  it("finds the ring atoms of a fused system and no others", async () => {
    // Naphthalene with a pendant chain: the ten ring atoms survive pruning, the chain does not.
    const graph = await graphFor("CCc1ccc2ccccc2c1");
    const ring = ringMembership(graph);
    expect(ring.filter(Boolean)).toHaveLength(10);
    expect(ring[0]).toBe(false);
    expect(ring[1]).toBe(false);
  });

  it("reports no ring atoms for an acyclic molecule", async () => {
    const graph = await graphFor("CCC(=O)O");
    expect(ringMembership(graph).some(Boolean)).toBe(false);
  });
});

describe("the model itself", () => {
  it("carries the training provenance its results will cite", () => {
    expect(PKA_MODEL_TRAINING.samples).toBe(3031);
    expect(PKA_MODEL_TRAINING.cvMae).toBeLessThan(1.5);
    expect(PKA_MODEL_FEATURE_NAMES).toHaveLength(45);
  });

  it("refuses a feature vector of the wrong length rather than predicting from it", () => {
    // A silent shape mismatch is how a reordered feature list becomes a confident wrong pKa.
    expect(() => predictSitePka([1, 2, 3])).toThrow(/expects 45 features/);
  });
});
