/**
 * Adduct m/z against the real engine (PLANS.md §9, Release 2).
 *
 * The pinned numbers here are the point: an m/z that is wrong in the fourth decimal is worse than no
 * m/z at all, because it looks right. Aspirin's [M+H]⁺ and [M+Na]⁺ are values anyone can check against
 * a published table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildAnalysisReport, type AnalysisResult, type AnalysisRun } from "@chemdraft/analysis-core";

import { analyzeStructure, rdkitAnalysisContracts, resolveIonComponentMasses } from "./analysis";
import { ensureRdkit, resetRdkitForTesting } from "./conformer";
import {
  ADDUCTS,
  NEUTRAL_LOSSES,
  PROTON_SMILES,
  adductMethodId,
  adductMz,
  neutralLossMethodId
} from "./mass";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});

afterAll(() => {
  resetRdkitForTesting();
});

const ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O";

let counter = 0;
function analyze(value: string, options: Record<string, unknown> = {}): Promise<AnalysisRun> {
  counter += 1;
  return analyzeStructure({
    format: "smiles",
    value,
    runId: `mass-${counter}`,
    startedAt: "2026-07-30T12:00:00.000Z",
    ...options
  } as never);
}

function result(run: AnalysisRun, id: string): AnalysisResult {
  const found = run.results.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Run carried no "${id}".`);
  return found;
}

function mz(run: AnalysisRun, adductId: string): number | null {
  const found = result(run, `rdkit.mz.${adductId}`);
  if (found.kind !== "scalar") throw new Error(`${adductId} is a ${found.kind}`);
  return found.value;
}

describe("ion component masses come from the engine", () => {
  it("reads the proton, not hydrogen", async () => {
    // The distinction that makes the whole series correct without a CODATA constant: RDKit's [H+] is
    // already one electron lighter than [H], so M ± mass([H+]) needs no electron bookkeeping of ours.
    const masses = resolveIonComponentMasses((await ensureRdkit()) as never);
    expect(masses.get(PROTON_SMILES)).toBe(1.00727645209);
    expect(masses.get("[Na+]")).toBe(22.98922070009);
    expect(masses.get("[NH4+]")).toBe(18.03382554809);
    expect(masses.get("[Cl-]")).toBe(34.96940125991);
  });

  it("memoises per module rather than re-parsing every call", async () => {
    const module = (await ensureRdkit()) as never;
    expect(resolveIonComponentMasses(module)).toBe(resolveIonComponentMasses(module));
  });
});

describe("aspirin adduct series", () => {
  it("matches published m/z values", async () => {
    const run = await analyze(ASPIRIN);

    expect(mz(run, "M+H")).toBeCloseTo(181.049535, 6);
    expect(mz(run, "M+Na")).toBeCloseTo(203.031479, 6);
    expect(mz(run, "M+K")).toBeCloseTo(219.005417, 6);
    expect(mz(run, "M+NH4")).toBeCloseTo(198.076084, 6);
    expect(mz(run, "M-H")).toBeCloseTo(179.034982, 6);
    expect(mz(run, "M+Cl")).toBeCloseTo(215.011660, 6);
  });

  it("divides by the charge magnitude for multiply-charged ions", async () => {
    const run = await analyze(ASPIRIN);
    const singly = mz(run, "M+H")!;
    const doubly = mz(run, "M+2H")!;

    // [M+2H]²⁺ is (M + 2 protons) / 2, which is roughly half the singly-charged value — and exactly
    // (singly + proton) / 2.
    expect(doubly).toBeCloseTo(91.028406, 6);
    expect(doubly * 2 - singly).toBeCloseTo(1.00727645209, 8);
  });

  it("keeps [M−H]⁻ exactly one proton below the neutral mass", async () => {
    const run = await analyze(ASPIRIN);
    const neutral = result(run, "rdkit.monoisotopic-mass");
    const anion = mz(run, "M-H")!;
    expect(neutral.kind === "scalar" && neutral.value! - anion).toBeCloseTo(1.00727645209, 8);
  });

  it("renders to four decimals — the precision an m/z is quoted to", async () => {
    const report = buildAnalysisReport(await analyze(ASPIRIN));
    const ions = report.sections.find((section) => section.title.startsWith("Ions (m/z)"));
    expect(ions?.kind).toBe("keyValue");
    const rows = ions?.kind === "keyValue" ? ions.rows : [];
    // The label is the ion notation alone — the unit symbol supplies the "m/z", so a public name that
    // repeated it rendered as "[M+H]⁺ m/z … 181.0495 m/z".
    expect(rows.find((entry) => entry.label === "[M+H]⁺")?.value).toBe("181.0495 m/z");
    expect(rows.find((entry) => entry.label === "[M−H]⁻")?.value).toBe("179.0350 m/z");
  });

  it("gives ions their own report section rather than mixing them into Composition", async () => {
    // Grouped by unit dimension: an m/z is not a mass, and putting them in one list invites reading
    // one as the other.
    const report = buildAnalysisReport(await analyze(ASPIRIN));
    const composition = report.sections.find((section) => section.title.startsWith("Composition"));
    const labels = composition?.kind === "keyValue" ? composition.rows.map((entry) => entry.label) : [];
    expect(labels).toContain("Monoisotopic mass");
    expect(labels.every((label) => !label.includes("m/z"))).toBe(true);
  });

  it("makes no intensity claim anywhere in the section", async () => {
    // Positions only. Which ions a spectrum actually shows depends on source, solvent, and analyte.
    const report = buildAnalysisReport(await analyze(ASPIRIN));
    const ions = report.sections.find((section) => section.title.startsWith("Ions (m/z)"))!;
    const text = JSON.stringify(ions.kind === "keyValue" ? ions.rows : ions).toLowerCase();
    for (const forbidden of ["intensity", "abundance", "relative", "base peak"]) {
      expect(text.includes(forbidden), `report claims "${forbidden}"`).toBe(false);
    }
  });
});

describe("declining", () => {
  it("declines every adduct for a structure that is already charged", async () => {
    // [M+…] names an adduct of a neutral M. For an imidazolium cation there is no such M, so the
    // notation does not apply — `not-applicable`, because nothing is missing from the method.
    const run = await analyze("Cn1cc[nH+]c1");
    for (const adduct of ADDUCTS) {
      const found = result(run, adductMethodId(adduct));
      expect(found.status, `${adduct.label}`).toBe("not-applicable");
      expect(found.kind === "scalar" && found.value).toBeNull();
      expect(found.warnings[0]?.code).toBe("mass.charged_input");
    }
  });

  it("still answers for a zwitterion, whose net charge is zero", async () => {
    const run = await analyze("[NH3+]CC(=O)[O-]");
    expect(result(run, "rdkit.mz.M+H").status).toBe("ok");
    expect(mz(run, "M+H")).toBeCloseTo(76.039304, 5);
  });

  it("puts declined adducts in the report's Not computed section", async () => {
    const report = buildAnalysisReport(await analyze("Cn1cc[nH+]c1"));
    const declined = report.sections.find((section) => section.title.startsWith("Not computed"));
    const rows = declined?.kind === "table" ? declined.rows : [];
    expect(rows.some((cells) => cells[0].includes("[M+H]") && cells[1] === "not-applicable")).toBe(true);
  });
});

describe("adductMz arithmetic", () => {
  const masses = new Map([
    [PROTON_SMILES, 1.00727645209],
    ["[Na+]", 22.98922070009]
  ]);

  it("declines rather than guessing when a component mass is missing", () => {
    const potassium = ADDUCTS.find((adduct) => adduct.id === "M+K")!;
    expect(adductMz(180, potassium, masses)).toBeUndefined();
  });

  it("declines when the proton mass is missing and protons must be removed", () => {
    const deprotonated = ADDUCTS.find((adduct) => adduct.id === "M-H")!;
    expect(adductMz(180, deprotonated, new Map())).toBeUndefined();
  });

  it("computes additions and removals from the same proton mass", () => {
    const protonated = ADDUCTS.find((adduct) => adduct.id === "M+H")!;
    const deprotonated = ADDUCTS.find((adduct) => adduct.id === "M-H")!;
    expect(adductMz(180, protonated, masses)).toBeCloseTo(181.00727645, 8);
    expect(adductMz(180, deprotonated, masses)).toBeCloseTo(178.99272355, 8);
  });
});

describe("neutral losses — bookkeeping, not fragmentation prediction", () => {
  it("computes [M+H−H₂O]⁺ as one proton up and one water down", async () => {
    const run = await analyze(ASPIRIN);
    const protonated = mz(run, "M+H")!;
    const dehydrated = mz(run, "M+H-H2O")!;
    // Water's monoisotopic mass, from the engine like every other component.
    expect(protonated - dehydrated).toBeCloseTo(18.010564684, 8);
    expect(dehydrated).toBeCloseTo(163.038971, 5);
  });

  it("offers CO and CO₂ losses for a carboxylic acid", async () => {
    const run = await analyze(ASPIRIN);
    expect(result(run, "rdkit.mz.M+H-CO").status).toBe("ok");
    expect(result(run, "rdkit.mz.M+H-CO2").status).toBe("ok");
    expect(mz(run, "M+H-CO2")).toBeCloseTo(137.059705, 5);
  });

  it("declines a loss the composition cannot supply", async () => {
    // Benzene has no oxygen and no nitrogen, so water, ammonia, CO, CO₂ and the rest are arithmetic
    // nonsense rather than unlikely fragmentations.
    const run = await analyze("c1ccccc1");
    for (const id of ["M+H-H2O", "M+H-NH3", "M+H-CO", "M+H-CO2", "M+H-HCl"]) {
      const found = result(run, `rdkit.mz.${id}`);
      expect(found.status, id).toBe("not-applicable");
      expect(found.warnings[0]?.code).toBe("mass.loss_impossible");
      expect(found.applicability.reasons[0]).toMatch(/not compositionally possible/);
    }
  });

  it("gates on composition only, and says so rather than implying chemistry", async () => {
    // Acetone's only oxygen is a ketone, so a water loss is chemically unlikely — but it IS
    // compositionally possible, and the contract is explicit that this check cannot tell the
    // difference.
    const run = await analyze("CC(C)=O");
    expect(result(run, "rdkit.mz.M+H-H2O").status).toBe("ok");

    const contract = rdkitAnalysisContracts().find((entry) => entry.id === "rdkit.mz.M+H-H2O")!;
    expect(contract.conventions.join(" ")).toMatch(/BOOKKEEPING, NOT FRAGMENTATION PREDICTION/);
    expect(contract.conventions.join(" ")).toMatch(/all ketones/);
  });

  it("declines every loss for an already-charged structure", async () => {
    const run = await analyze("Cn1cc[nH+]c1");
    for (const loss of NEUTRAL_LOSSES) {
      const found = result(run, neutralLossMethodId(loss));
      expect(found.status, loss.label).toBe("not-applicable");
    }
  });

  it("lists losses beside the adducts in the Ions section", async () => {
    const report = buildAnalysisReport(await analyze(ASPIRIN));
    const ions = report.sections.find((section) => section.title.startsWith("Ions (m/z)"))!;
    const labels = ions.kind === "keyValue" ? ions.rows.map((entry) => entry.label) : [];
    expect(labels).toContain("[M+H]⁺");
    expect(labels).toContain("[M+H−H₂O]⁺");
  });
});
