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
  ])("puts %s's only proton loss where an amide N-H actually is, well above pH 12", async (_n, smiles) => {
    // This test has now said three things, and the history is the point. Urea was once reported as a
    // TETRAPROTIC ACID titrating at pH 4. Then, with the forest, every rung carried an interval of
    // +/-5 to +/-7 and no curve was drawn at all — the honest answer for a model that did not know.
    //
    // The network does know. Acetamide's N-H comes out at 14.97 +/- 0.46 where the real value is about
    // 15 to 17, and the forest said 10.64. So a curve IS drawn now, and it belongs there: a step above
    // pH 12 is real chemistry that a titration in water simply cannot reach, which is the same reason
    // imidazole's tabulated 14.4 is reported rather than suppressed.
    //
    // Urea reads 14.80 against a real value nearer 26 — still wrong, and much less wrong than 10.68.
    const results = await assess(smiles);
    const scored = results.find((entry) => entry.sites.length > 0);
    expect(scored, "the sites should be reported").toBeDefined();
    for (const site of scored!.sites) {
      expect(site.acidCharge, "an amide nitrogen must still get no basicity").toBeLessThanOrEqual(0);
      if (site.pKa !== null) {
        expect(site.pKa, `${smiles} put an amide N-H inside the aqueous window`).toBeGreaterThan(12);
      }
    }
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

/**
 * Azole tautomers, which are ONE substance and now give one answer.
 *
 * The protomer axis was closed first: every drawing of glycine gives the same pair, because the ladder is
 * built from a canonical protomer. The TAUTOMER axis was left open, and `tautomerPolicy: "as-drawn"` said
 * so — but that policy was written with keto/enol in mind, where the two forms are arguably different
 * compounds a chemist chose between. An azole 1,3-H shift is not that. 4-methylimidazole and
 * 5-methylimidazole interconvert far faster than any titration, share one tabulated pKa of 7.5, and
 * nobody means anything by drawing one rather than the other. As drawn they scored 7.48 and 7.69, with
 * their N-H values 0.39 apart, and methylpyrazole's 1.05 apart.
 *
 * Closing it needed the vendored WASM rebuilt: MinimalLib ships no tautomer support at all, so vendor
 * patch #7 links MolStandardize and exposes `get_canonical_tautomer_molblock`. The pKa ladder is then
 * built from the tautomer RDKit scores as canonical (Sitzmann et al. 2010) — a published, deterministic
 * heuristic that picks a representative rather than averaging over the population, which is the honest
 * description of what it buys: one substance, one answer, not a better answer.
 */
describe("azole tautomers, one substance and one answer", () => {
  const PAIRS: Array<[string, string, string]> = [
    ["4- vs 5-methylimidazole", "Cc1c[nH]cn1", "Cc1cnc[nH]1"],
    ["4- vs 5-methylpyrazole", "Cc1cc[nH]n1", "Cc1ccn[nH]1"],
    ["benzimidazole N1 vs N3", "c1ccc2[nH]cnc2c1", "c1ccc2nc[nH]c2c1"],
    ["1,2,4-triazole", "c1nc[nH]n1", "c1n[nH]cn1"],
    ["4- vs 5-methylbenzimidazole", "Cc1ccc2[nH]cnc2c1", "Cc1ccc2nc[nH]c2c1"],
    ["3- vs 5-methyl-1,2,4-triazole", "Cc1nc[nH]n1", "Cc1n[nH]cn1"]
  ];

  it("gives both drawings of each pair the same values", async () => {
    for (const [name, a, b] of PAIRS) {
      const first = await values(a);
      const second = await values(b);
      expect(first.length, `${name} produced no values`).toBeGreaterThan(0);
      expect(
        close(first, second),
        `${name}: [${first.map((v) => v.toFixed(2)).join(", ")}] vs [${second.map((v) => v.toFixed(2)).join(", ")}]`
      ).toBe(true);
    }
  }, 1_800_000);

  it("leaves keto/enol alone, because those two forms are not one substance", async () => {
    // The clause that keeps this narrow. Canonicalising EVERY tautomer was tried first and silently
    // deleted acetylacetone's only answer: RDKit's canonical form is the diketone, whose acidic proton is
    // a CARBON acid the site table does not cover, so the enol went from one macroscopic value to none.
    // A chemist drawing the enol means the enol. Only an N-to-N hydrogen shift is accepted, so these
    // keep the values they had — and they are good ones.
    const enols: Array<[string, string, number]> = [
      ["acetylacetone enol", "CC(O)=CC(=O)C", 8.9],
      ["dimedone enol", "CC1(C)CC(O)=CC(=O)C1", 5.23]
    ];
    for (const [name, smiles, literature] of enols) {
      const got = await values(smiles);
      expect(got.length, `${name} lost its site`).toBe(1);
      expect(got[0]!, `${name} against literature ${literature}`).toBeCloseTo(literature, 0);
    }
    // The diketone itself has neither an O-H nor an N-H — its acidic proton is on carbon — so it
    // reports nothing, and always did. That is the site table's documented limit, not a regression.
    expect(await values("CC(=O)CC(=O)C")).toHaveLength(0);
    // An O-to-N shift is the same category and is likewise refused: 2-hydroxypyridine keeps its own
    // ladder rather than being answered as 2-pyridone.
    expect((await values("Oc1ccccn1")).length).toBeGreaterThan(0);
  }, 1_800_000);
});
