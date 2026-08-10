/**
 * Which species the molecule is actually in, at a pH.
 *
 * The last piece of the original scope never attempted, and it costs nothing new: the fold already
 * solves every microstate's free energy, so mass action gives the population directly —
 * `10^(L(s) - n(s)*pH)`, normalised, summed by net charge.
 *
 * **Two quantities, reported separately, because conflating them is a five-order-of-magnitude error.**
 * Glycine is 99.5% net-neutral at pH 7.4 and 3.8e-4% UNCHARGED: the population is a zwitterion carrying
 * +1 on nitrogen and -1 on oxygen, and it does not cross a membrane. A field called "fractionNeutral"
 * would have invited exactly that mistake, so neither is called neutral.
 *
 * **The glycine ratio is a real check on the part of the fold nothing can label.** Those two numbers are
 * the tautomerization constant: 99.537 / 3.8e-4 = 2.6e5, or 10^5.42, against a literature K_z near
 * 10^5.3. That constant depends ENTIRELY on glycine's neutral form — the microstate no titration can
 * populate, the one a rejected corpus put at 2.07 instead of 7.70 — so getting it right is evidence the
 * shipped model's unlabelled microstates are sane, not merely unmeasured.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analyzeStructure } from "./analysis";
import { resetRdkitForTesting } from "./conformer";
import { IONIZATION_SITES_METHOD_ID } from "./ionization";
import { installRealRdkitModuleLoader } from "./testing";
import { PHYSIOLOGICAL_PH } from "./protonation";

beforeAll(() => {
  installRealRdkitModuleLoader();
});
afterAll(() => {
  resetRdkitForTesting();
});

interface Distribution {
  pH: number;
  charges: { charge: number; fraction: number; protonCount: number }[];
  dominantCharge: number;
  fractionNetNeutral: number;
  fractionUncharged: number;
}

async function distribution(smiles: string, runId: string): Promise<Distribution | undefined> {
  const run = await analyzeStructure({
    format: "smiles",
    value: smiles,
    runId,
    startedAt: "2026-08-02T00:00:00.000Z"
  } as never);
  const result = run.results.find((entry) => entry.methodId === IONIZATION_SITES_METHOD_ID);
  if (!result || result.kind !== "ionization") return undefined;
  return (result as { macroscopic?: { distribution?: Distribution } }).macroscopic?.distribution;
}

describe("the species distribution", () => {
  it("puts each molecule in the charge state its chemistry requires at pH 7.4", async () => {
    // Textbook, and the point of reporting this at all: a reader should not have to do the arithmetic.
    const expected: Array<[string, string, number]> = [
      ["acetic acid", "CC(=O)O", -1],
      ["ibuprofen", "CC(C)Cc1ccc(cc1)C(C)C(=O)O", -1],
      ["phenol", "Oc1ccccc1", 0],
      ["caffeine", "Cn1cnc2c1c(=O)n(C)c(=O)n2C", 0],
      ["methylamine", "CN", 1],
      ["pyridine", "c1ccncc1", 0],
      // Amino acids: net charge is what a titration says, and it is not zero for all of them.
      ["glycine", "NCC(=O)O", 0],
      ["lysine", "NCCCCC(N)C(=O)O", 1],
      ["aspartic acid", "NC(CC(=O)O)C(=O)O", -1]
    ];
    const lines: string[] = [];
    for (const [index, [name, smiles, charge]] of expected.entries()) {
      const d = await distribution(smiles, `charge-${index}`);
      expect(d, name).toBeDefined();
      expect(d!.pH).toBe(PHYSIOLOGICAL_PH);
      lines.push(
        `  ${name.padEnd(14)} ` +
          d!.charges.map((c) => `${c.charge > 0 ? "+" : ""}${c.charge}:${(100 * c.fraction).toFixed(2)}%`).join(" ")
      );
      expect(d!.dominantCharge, `${name} dominant charge`).toBe(charge);
    }
    console.log("\n" + lines.join("\n"));
  }, 1_800_000);

  it("sums to one, because a distribution that does not is not one", async () => {
    for (const [index, smiles] of ["NCC(=O)O", "NC(Cc1c[nH]cn1)C(=O)O", "OC(=O)CC(O)(CC(=O)O)C(=O)O",
                                   "CC(=O)O", "NCCCCC(N)C(=O)O"].entries()) {
      const d = await distribution(smiles, `sum-${index}`);
      expect(d, smiles).toBeDefined();
      const total = d!.charges.reduce((sum, c) => sum + c.fraction, 0);
      // Below 1e-4 a charge state is dropped rather than printed as 0.00%, so the sum can fall a
      // hair short of one — never over it, and never enough to matter.
      expect(total, smiles).toBeGreaterThan(0.999);
      expect(total, smiles).toBeLessThanOrEqual(1.0000001);
      // Uncharged is a SUBSET of net-neutral and can never exceed it.
      expect(d!.fractionUncharged).toBeLessThanOrEqual(d!.fractionNetNeutral + 1e-12);
    }
  }, 1_800_000);

  it("does not call a zwitterion neutral", async () => {
    // The distinction this interface exists to make. Glycine's net-zero population is a zwitterion;
    // the uncharged species is five orders of magnitude rarer and is the one that crosses a membrane.
    const glycine = await distribution("NCC(=O)O", "zwitterion-0");
    expect(glycine).toBeDefined();
    expect(glycine!.fractionNetNeutral).toBeGreaterThan(0.9);
    expect(glycine!.fractionUncharged).toBeLessThan(1e-4);
    // Their ratio is the tautomerization constant. Literature K_z for glycine is near 10^5.3; a
    // decade either side is well inside what a 0.7-log-unit site model can promise, and being in
    // this range at all is a check on the microstate no experiment can label.
    const kz = Math.log10(glycine!.fractionNetNeutral / glycine!.fractionUncharged);
    console.log(`\n  glycine log10(K_z) = ${kz.toFixed(2)}  (literature near 5.3)\n`);
    expect(kz).toBeGreaterThan(4.3);
    expect(kz).toBeLessThan(6.3);

    // An ordinary acid has no zwitterion, so the two quantities coincide exactly.
    for (const [index, smiles] of ["CC(=O)O", "Oc1ccccc1", "Cn1cnc2c1c(=O)n(C)c(=O)n2C"].entries()) {
      const d = await distribution(smiles, `plain-${index}`);
      expect(d, smiles).toBeDefined();
      expect(d!.fractionUncharged, smiles).toBeCloseTo(d!.fractionNetNeutral, 9);
    }
  }, 1_800_000);

  it("agrees with the ladder it was derived from", async () => {
    // A single-site acid must put its half-way point at its own pKa: at pH = pKa the two charge states
    // are equally populated. This is the arithmetic check that the Boltzmann weights and the fold's
    // free energies are the same numbers.
    const run = await analyzeStructure({
      format: "smiles",
      value: "CC(=O)O",
      runId: "half",
      startedAt: "2026-08-02T00:00:00.000Z"
    } as never);
    const result = run.results.find((entry) => entry.methodId === IONIZATION_SITES_METHOD_ID);
    expect(result?.kind).toBe("ionization");
    const macro = (result as { macroscopic?: { pKa: number[]; distribution?: Distribution } }).macroscopic;
    expect(macro?.pKa).toHaveLength(1);
    const { speciesDistribution, macroscopicFromSites } = await import("./protonation");
    expect(typeof speciesDistribution).toBe("function");
    expect(typeof macroscopicFromSites).toBe("function");
    // The reported distribution is at 7.4, three log units above acetic acid's 4.30, so the anion must
    // hold essentially all of it — 10^3 to 1.
    const d = macro!.distribution!;
    const anion = d.charges.find((c) => c.charge === -1)!;
    const neutral = d.charges.find((c) => c.charge === 0)!;
    expect(Math.log10(anion.fraction / neutral.fraction)).toBeCloseTo(
      PHYSIOLOGICAL_PH - macro!.pKa[0]!,
      2
    );
  }, 1_800_000);
});
