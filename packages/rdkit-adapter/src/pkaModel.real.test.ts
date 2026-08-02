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
  PKA_MODEL_FEATURE_NAMES,
  PKA_MODEL_TRAINING,
  predictSitePka,
  ringMembership,
  siteFeatures,
  type PkaMolecularGraph
} from "./pkaModel";
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
