/**
 * A pKa must not depend on how the molecule was drawn.
 *
 * This is the test that would have caught the whole class, and it did not exist. Measured before the
 * state model was rebuilt: neutral glycine gave 2.13/9.07, its zwitterion — the form a chemist draws at
 * pH 7 — gave NOTHING, and each singly-charged drawing gave one of the two values. Acetate gave nothing
 * while acetic acid gave 4.50. Sodium and iron shifted acetic acid's answer by 0.1 without any warning.
 * Acetamide, urea, aniline and pyridinium were all reported as zwitterions.
 *
 * Each of those is a one-line assertion here.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure } from "./analysis";
import { installRealRdkitModuleLoader } from "./testing";
import { IONIZATION_SITES_METHOD_ID } from "./ionization";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

let counter = 0;

interface Assessment {
  status: string;
  interpretationId: string;
  macroscopic?: { pKa: number[]; zwitterionic: boolean };
  sites: { ionizableAtomIndex: number; acidCharge: number; pKa: number | null }[];
}

/** Every ionization result in the run, in the order the pipeline produced them. */
async function assess(smiles: string): Promise<Assessment[]> {
  counter += 1;
  const run = await analyzeStructure({
    format: "smiles",
    value: smiles,
    runId: `inv-${counter}`,
    startedAt: "2026-08-03T00:00:00.000Z"
  } as never);
  return run.results
    .filter((result) => result.methodId === IONIZATION_SITES_METHOD_ID && result.kind === "ionization")
    .map((result) => result as unknown as Assessment);
}

/** The values a reader would actually be shown, from whichever interpretation carried them. */
async function values(smiles: string): Promise<number[]> {
  const scored = (await assess(smiles)).find((entry) => entry.macroscopic);
  return scored?.macroscopic?.pKa ?? [];
}

const close = (a: number[], b: number[]) =>
  a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) < 0.01);

describe("one molecular family, one answer", () => {
  it("gives all four drawings of glycine the same macroscopic pair", async () => {
    // The case the user caught: the zwitterion is how glycine exists at pH 7, and it returned
    // `not-applicable` with zero sites because the scan found no proton to remove and no lone pair to
    // add — every site was already in the state it would have moved to.
    const neutral = await values("NCC(=O)O");
    expect(neutral).toHaveLength(2);
    for (const drawing of ["[NH3+]CC(=O)[O-]", "[NH3+]CC(=O)O", "NCC(=O)[O-]"]) {
      expect(await values(drawing), `${drawing} disagrees with the neutral drawing`).toSatisfy(
        (got: number[]) => close(got, neutral)
      );
    }
  });

  it("gives acetate acetic acid's value", async () => {
    const acid = await values("CC(=O)O");
    expect(acid).toHaveLength(1);
    expect(close(await values("CC(=O)[O-]"), acid)).toBe(true);
  });

  it("gives pyridinium pyridine's value", async () => {
    expect(close(await values("c1cc[nH+]cc1"), await values("c1ccncc1"))).toBe(true);
  });

  it("keeps a nitro group while canonicalizing the carboxylate beside it", async () => {
    // The hole the incremental strip fell into. Removing the nitro oxygen's charge yields
    // `O=[N+](O)Ar` — a valid molecule, and a different compound — so 4-nitrophenol lost the
    // substituent its Hammett series depends on. A charge balanced by a bonded opposite charge is a
    // valence requirement, not a protonation state, and is left alone.
    const acid = await values("O=[N+]([O-])c1ccc(C(=O)O)cc1");
    expect(acid.length).toBeGreaterThan(0);
    expect(close(await values("O=[N+]([O-])c1ccc(C(=O)[O-])cc1"), acid)).toBe(true);
  });

  it("still reaches a consensus on 4-nitrophenol, whose nitro must survive to be a substituent", async () => {
    const [result] = await assess("O=[N+]([O-])c1ccc(O)cc1");
    expect(result?.sites.some((site) => site.pKa !== null)).toBe(true);
  });
});

describe("a pKa belongs to one species", () => {
  it("declines a salt as drawn and answers on the organic fragment", async () => {
    // Measured before the guard: acetic acid 4.50, with sodium 4.62, with iron 4.57 — all `ok`, no
    // warning. The model reads whole-molecule descriptors, so the counterion leaks in through mass,
    // polar surface area and logP without ever appearing in the result.
    const plain = await values("CC(=O)O");
    for (const salt of ["CC(=O)O.[Na+]", "CC(=O)O.[Fe]"]) {
      const results = await assess(salt);
      expect(results[0]!.status, `${salt} was answered as drawn`).toBe("unsupported");
      const derived = results.find((entry) => entry.interpretationId !== "source");
      expect(derived, `${salt} offered no fallback`).toBeDefined();
      expect(close(derived!.macroscopic!.pKa, plain)).toBe(true);
    }
  });

  it("refuses to build a titration curve across two co-drawn molecules", async () => {
    // The worst measured case: phenol and acetic acid drawn side by side produced a macroscopic ladder
    // of 4.99 and 10.93 — a two-step titration for a species that does not exist.
    const results = await assess("Oc1ccccc1.CC(=O)O");
    expect(results[0]!.status).toBe("unsupported");
    expect(results[0]!.macroscopic).toBeUndefined();
  });

  it("catches a duplicated component, which a component COUNT would miss", async () => {
    // `CC(=O)O.CC(=O)O` collapses to one composition entry with multiplicity 2, so a predicate on
    // `components.length` reads it as a single molecule. It used to report 4.53/6.12 — a diprotic acid.
    const results = await assess("CC(=O)O.CC(=O)O");
    expect(results[0]!.status).toBe("unsupported");
  });
});

describe("what is and is not a zwitterion", () => {
  it.each([
    ["aniline", "Nc1ccccc1"],
    ["pyridinium", "c1cc[nH+]cc1"],
    ["ethylenediamine", "NCCN"],
    ["succinic acid", "OC(=O)CCC(=O)O"]
  ])("does not call %s a zwitterion", async (_name, smiles) => {
    const scored = (await assess(smiles)).find((entry) => entry.macroscopic);
    expect(scored?.macroscopic?.zwitterionic).toBe(false);
  });

  it.each([
    ["acetamide", "CC(N)=O"],
    ["urea", "NC(N)=O"]
  ])("draws no titration curve at all for %s, and says why", async (_name, smiles) => {
    // Stronger than "not a zwitterion", and the better answer. An amide has no aqueous pKa between 2
    // and 12; the model knows it does not know, carrying intervals of +/-5 to +/-7 on every rung. Urea
    // used to be reported as a tetraprotic acid titrating at pH 4. Now the sites are still shown with
    // their intervals — nothing is hidden — but no curve is drawn through them.
    const results = await assess(smiles);
    const scored = results.find((entry) => entry.sites.length > 0);
    expect(scored, "the sites themselves should still be reported").toBeDefined();
    expect(scored!.sites.length).toBeGreaterThan(0);
    expect(scored!.macroscopic, "a curve was drawn through values this uncertain").toBeUndefined();
  });

  it.each([
    ["glycine", "NCC(=O)O"],
    ["alanine", "CC(N)C(=O)O"],
    ["histidine", "NC(Cc1c[nH]cn1)C(=O)O"]
  ])("still calls %s a zwitterion", async (_name, smiles) => {
    const scored = (await assess(smiles)).find((entry) => entry.macroscopic);
    expect(scored?.macroscopic?.zwitterionic).toBe(true);
  });
});

describe("no atom holds two charges at once", () => {
  it.each([
    ["aniline", "Nc1ccccc1"],
    ["acetamide", "CC(N)=O"],
    ["urea", "NC(N)=O"],
    ["histidine", "NC(Cc1c[nH]cn1)C(=O)O"]
  ])("reports %s's rungs as a contiguous ladder per atom", async (_name, smiles) => {
    const scored = (await assess(smiles)).find((entry) => entry.sites.length > 0);
    expect(scored).toBeDefined();
    const byAtom = new Map<number, number[]>();
    for (const site of scored!.sites) {
      byAtom.set(site.ionizableAtomIndex, [...(byAtom.get(site.ionizableAtomIndex) ?? []), site.acidCharge]);
    }
    for (const [atom, charges] of byAtom) {
      const rungs = [...new Set(charges)].sort((a, b) => a - b);
      expect(rungs, `atom ${atom} repeats an acid charge`).toHaveLength(charges.length);
      expect(
        rungs.length === 1 || rungs[rungs.length - 1]! - rungs[0]! === rungs.length - 1,
        `atom ${atom}'s rungs are not contiguous: ${rungs.join(", ")}`
      ).toBe(true);
    }
  });
});
