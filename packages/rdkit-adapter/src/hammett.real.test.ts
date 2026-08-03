/**
 * Parity between the TypeScript Hammett estimator and the Python that measured it.
 *
 * The accuracy figures this method reports — MAE 0.158 over 85 sites — were measured by
 * `vendor/pka-model/hammett.py`. They only describe the shipped code if the shipped code computes the
 * same thing, so `vendor/pka-model/hammett-parity.json` pins all 85 estimates and every decline branch
 * against it. Substituent identification and ring perception are the fragile parts: both are graph
 * algorithms written twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureRdkit, resetRdkitForTesting } from "./conformer";
import { estimateHammettPka, hammettApplies } from "./hammett";
import type { PkaMolecularGraph } from "./pkaModel";
import fixture from "../vendor/pka-model/hammett-parity.json";
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

async function graphFor(smiles: string): Promise<PkaMolecularGraph> {
  const rdkit = (await ensureRdkit()) as unknown as { get_mol(s: string): unknown };
  const mol = rdkit.get_mol(smiles) as { get_json(): string; get_descriptors(): string; delete(): void };
  try {
    const json = JSON.parse(mol.get_json()) as {
      defaults?: { atom?: { z?: number; chg?: number; impHs?: number }; bond?: { bo?: number } };
      molecules: { atoms: { z?: number; chg?: number; impHs?: number }[]; bonds: { atoms: number[]; bo?: number }[] }[];
    };
    const defaults = json.defaults ?? {};
    const molecule = json.molecules[0]!;
    return {
      atoms: molecule.atoms.map((atom) => ({
        element: ELEMENT_BY_Z[atom.z ?? defaults.atom?.z ?? 6] ?? "X",
        charge: atom.chg ?? defaults.atom?.chg ?? 0,
        hydrogens: atom.impHs ?? defaults.atom?.impHs ?? 0
      })),
      bonds: molecule.bonds.map((bond) => ({
        atoms: [bond.atoms[0]!, bond.atoms[1]!] as [number, number],
        order: bond.bo ?? defaults.bond?.bo ?? 1
      })),
      descriptors: JSON.parse(mol.get_descriptors()) as Record<string, number>
    };
  } finally {
    mol.delete();
  }
}

const estimates = fixture.filter((entry) => "pKa" in entry) as {
  smiles: string; atomIdx: number; pKa: number; series: string; sigmaSum: number; observed: number;
}[];
const declines = fixture.filter((entry) => "declined" in entry) as {
  smiles: string; atomIdx: number; declined: string; branch: string;
}[];

describe("parity with the measurement", () => {
  it.each(estimates.map((entry, index) => [index, entry.smiles] as const))(
    "reproduces the Python estimate for %i (%s)",
    async (index) => {
      const entry = estimates[index]!;
      const outcome = estimateHammettPka(await graphFor(entry.smiles), entry.atomIdx);
      expect(hammettApplies(outcome), `declined: ${JSON.stringify(outcome)}`).toBe(true);
      if (!hammettApplies(outcome)) return;
      expect(outcome.series).toBe(entry.series);
      expect(outcome.sigmaSum).toBeCloseTo(entry.sigmaSum, 6);
      expect(outcome.pKa).toBeCloseTo(entry.pKa, 6);
    }
  );

  it.each(declines.map((entry, index) => [index, entry.branch, entry.smiles] as const))(
    "declines %i for the same reason (%s: %s)",
    async (index) => {
      // A decline that drifts into an estimate is the dangerous direction — it would put a confident
      // number on chemistry the relationship does not describe.
      const entry = declines[index]!;
      const outcome = estimateHammettPka(await graphFor(entry.smiles), entry.atomIdx);
      expect(hammettApplies(outcome)).toBe(false);
      if (hammettApplies(outcome)) return;
      expect(outcome.declined).toBe(entry.declined);
    }
  );
});

/** The one neutral -OH oxygen, so a test never depends on hand-counting SMILES positions. */
function hydroxylIndex(graph: PkaMolecularGraph): number {
  const index = graph.atoms.findIndex(
    (atom) => atom.element === "O" && atom.charge === 0 && atom.hydrogens === 1
  );
  if (index < 0) throw new Error("no neutral hydroxyl in this structure");
  return index;
}

describe("against the literature it came from", () => {
  // Independent of the fixture: these are textbook values, and getting them right is what the whole
  // method is for.
  it.each([
    ["Oc1ccccc1", 9.95, "phenol"],
    ["O=[N+]([O-])c1ccc(O)cc1", 7.12, "4-nitrophenol (sigma-minus applies)"],
    ["Clc1ccc(O)cc1", 9.44, "4-chlorophenol"],
    ["O=C(O)c1ccccc1", 4.2, "benzoic acid"],
    ["O=C(O)c1cccc([N+](=O)[O-])c1", 3.49, "3-nitrobenzoic acid"],
    ["O=C(O)c1ccc(OC)cc1", 4.47, "4-methoxybenzoic acid"]
  ])("puts %s within reach of its measured value (%s)", async (smiles, expected) => {
    const graph = await graphFor(smiles as string);
    const outcome = estimateHammettPka(graph, hydroxylIndex(graph));
    expect(hammettApplies(outcome)).toBe(true);
    if (!hammettApplies(outcome)) return;
    expect(outcome.pKa).toBeCloseTo(expected as number, 1);
  });

  it.each([
    ["aniline", "Nc1ccccc1", 4.6],
    ["pyridine", "c1ccncc1", 5.25],
    ["4-chloropyridine", "Clc1ccncc1", 3.83],
    ["4-methoxyaniline", "COc1ccc(N)cc1", 5.36]
  ])("gives %s its conjugate acid's pKa from the neutral form", async (_name, smiles, expected) => {
    // The app sees molecules as drawn, which for a base is the neutral form; the training labels carry
    // the cation. Both must reach the same number, and it is the conjugate acid's.
    const graph = await graphFor(smiles as string);
    const nitrogen = graph.atoms.findIndex((atom) => atom.element === "N");
    const outcome = estimateHammettPka(graph, nitrogen);
    expect(hammettApplies(outcome)).toBe(true);
    if (!hammettApplies(outcome)) return;
    expect(outcome.transition).toBe("basic");
    expect(Math.abs(outcome.pKa - (expected as number))).toBeLessThan(0.5);
  });

  it("reaches the measured pKa of every site in the fixture", async () => {
    // The claim in the module header, held to end-to-end rather than taken on trust.
    let total = 0;
    let worst = 0;
    for (const entry of estimates) {
      const outcome = estimateHammettPka(await graphFor(entry.smiles), entry.atomIdx);
      if (!hammettApplies(outcome)) throw new Error(`declined ${entry.smiles}`);
      const error = Math.abs(outcome.pKa - entry.observed);
      total += error;
      worst = Math.max(worst, error);
    }
    expect(total / estimates.length).toBeLessThan(0.25);
    // Was 1.0 when only benzoic and phenol shipped. The two nitrogen series reach further and cost a
    // little: the worst case is a para-nitroaniline, where the NEUTRAL amine is stabilised by
    // through-conjugation into the nitro group and plain sigma understates the shift. A sigma-minus
    // treatment for anilines would fix it; until that is measured, the limit says what the method
    // actually does.
    expect(worst).toBeLessThan(2.0);
  });
});

describe("what it refuses", () => {
  it("declines a fused ring rather than treating the fusion as a substituent", async () => {
    // 2-naphthol used to slip through the fused-ring test and decline only because its fused ring had
    // no tabulated constant. That is luck, not a check: a fusion that happened to key to something in
    // the table would have been scored as a substituent.
    const outcome = estimateHammettPka(await graphFor("Oc1ccc2ccccc2c1"), 0);
    expect(hammettApplies(outcome)).toBe(false);
    if (!hammettApplies(outcome)) expect(outcome.declined).toBe("ring is fused");
  });

  it("keeps a biaryl, which is not fused", async () => {
    // The same test must not reject 4-phenylphenol: only the ipso carbon reaches the second ring.
    const outcome = estimateHammettPka(await graphFor("Oc1ccc(-c2ccccc2)cc1"), 0);
    expect(hammettApplies(outcome)).toBe(true);
  });

  it("declines an ortho substituent instead of using a meta constant for it", async () => {
    const cresol = await graphFor("Cc1ccccc1O");
    const outcome = estimateHammettPka(cresol, hydroxylIndex(cresol));
    expect(hammettApplies(outcome)).toBe(false);
    if (!hammettApplies(outcome)) expect(outcome.declined).toBe("ortho substituent");
  });

  it("declines a substituent it has no constant for", async () => {
    const odd = await graphFor("Oc1ccc([Se]C#N)cc1");
    const outcome = estimateHammettPka(odd, hydroxylIndex(odd));
    expect(hammettApplies(outcome)).toBe(false);
    if (!hammettApplies(outcome)) expect(outcome.declined).toMatch(/no sigma constant/);
  });

  it("does not mistake a protonated thio-acid for a benzoic acid", async () => {
    // The detection bug that cost the benzoic series a factor of twenty in accuracy.
    const outcome = estimateHammettPka(await graphFor("Cc1ccc(C(=[OH+])S)cc1"), 6);
    expect(hammettApplies(outcome)).toBe(false);
  });

  it("declines an aliphatic acid entirely", async () => {
    const acetic = await graphFor("CC(=O)O");
    const outcome = estimateHammettPka(acetic, hydroxylIndex(acetic));
    expect(hammettApplies(outcome)).toBe(false);
    if (!hammettApplies(outcome)) expect(outcome.declined).toBe("not a benzoic acid or phenol");
  });
});

describe("what it shows its working for", () => {
  it("names the substituents and the constant used for each", async () => {
    // A chemist can check a Hammett estimate by hand if they can see the terms. A bare number is not
    // checkable, and this method's value is that it IS.
    const nitrophenol = await graphFor("O=[N+]([O-])c1ccc(O)cc1");
    const outcome = estimateHammettPka(nitrophenol, hydroxylIndex(nitrophenol));
    expect(hammettApplies(outcome)).toBe(true);
    if (!hammettApplies(outcome)) return;
    expect(outcome.substituents).toHaveLength(1);
    expect(outcome.substituents[0]!.name).toBe("nitro");
    expect(outcome.substituents[0]!.position).toBe("para");
    // sigma-para-minus, not the plain 0.78: the phenolate conjugates into the nitro group.
    expect(outcome.substituents[0]!.sigma).toBeCloseTo(1.27, 6);
    expect(outcome.sigmaSum).toBeCloseTo(1.27, 6);
  });

  it("sums several substituents", async () => {
    const dichlorophenol = await graphFor("Clc1cc(Cl)cc(O)c1");
    const outcome = estimateHammettPka(dichlorophenol, hydroxylIndex(dichlorophenol));
    expect(hammettApplies(outcome)).toBe(true);
    if (!hammettApplies(outcome)) return;
    expect(outcome.substituents.map((entry) => entry.position)).toEqual(["meta", "meta"]);
    expect(outcome.sigmaSum).toBeCloseTo(0.74, 6);
  });
});
