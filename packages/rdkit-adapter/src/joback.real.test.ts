/**
 * Joback estimates against the real RDKit SMARTS engine.
 *
 * The pinned values are cross-checked against Caleb Bell's `thermo` (MIT), an independent Python
 * implementation of the same method — the same discipline the isotope envelope uses with RDKit vs
 * IsoSpec, and the OPSIN round-trip uses for naming. Two implementations agreeing is worth more than
 * either matching a number typed into a test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureRdkit, resetRdkitForTesting } from "./conformer";
import {
  fragmentForJoback,
  jobackContracts,
  jobackCriticalPressure,
  jobackCriticalTemperature,
  jobackCriticalVolume,
  jobackNormalBoilingPoint,
  jobackUncertainty,
  JOBACK_TB_METHOD_ID,
  type JobackFragmentation
} from "./joback";
import { installRealRdkitModuleLoader } from "./testing";

beforeAll(() => {
  installRealRdkitModuleLoader();
});
afterAll(() => {
  resetRdkitForTesting();
});

/** Fragment a SMILES through the real engine. */
async function fragment(smiles: string): Promise<JobackFragmentation> {
  const rdkit = (await ensureRdkit()) as unknown as Parameters<typeof fragmentForJoback>[0] & {
    get_mol(s: string): unknown;
  };
  const mol = rdkit.get_mol(smiles) as {
    get_substruct_matches(q: unknown): string;
    get_json(): string;
    delete(): void;
  };
  try {
    const json = JSON.parse(mol.get_json()) as {
      molecules: { atoms: { impHs?: number; chg?: number }[] }[];
      defaults?: { atom?: { impHs?: number; chg?: number } };
    };
    const atoms = json.molecules[0]!.atoms;
    const defaultImpHs = json.defaults?.atom?.impHs ?? 0;
    const defaultCharge = json.defaults?.atom?.chg ?? 0;
    const heavy = atoms.map((_, index) => index);
    // Joback's nA counts hydrogens too, so the implicit ones have to be added back.
    const total = atoms.length + atoms.reduce((sum, a) => sum + (a.impHs ?? defaultImpHs), 0);
    const charges = new Map<number, number>(atoms.map((a, index) => [index, a.chg ?? defaultCharge]));
    return fragmentForJoback(rdkit, mol, heavy, total, charges);
  } finally {
    mol.delete();
  }
}

describe("fragmentation", () => {
  it("assigns every heavy atom of an ordinary organic", async () => {
    // Isobutanol: two -CH3, one >CH-, one -CH2-, one -OH.
    const frag = await fragment("CC(C)CO");
    expect(frag.unassignedAtoms).toEqual([]);
    expect(frag.atomCount).toBe(15); // C4H10O: 5 heavy + 10 hydrogens
    expect(frag.counts.get(1)).toBe(2); // -CH3
  });

  it("lets a specific group outrank the general ones it overlaps", async () => {
    // Acetic acid's carboxyl must be ONE -COOH, not a >C=O plus an -OH sharing the same carbon.
    // The priority column is what makes this true; without it the carbon is counted twice.
    const frag = await fragment("CC(=O)O");
    expect(frag.unassignedAtoms).toEqual([]);
    const totalGroups = [...frag.counts.values()].reduce((sum, n) => sum + n, 0);
    expect(totalGroups).toBe(2); // -CH3 and -COOH
  });
});

describe("estimates, cross-checked against thermo", () => {
  it("gives n-octane its published Joback values", async () => {
    // thermo's Joback for CCCCCCCC: Tb 382.64 K, Tc 546.17 K, Pc 25.35 bar, Vc 483.5 cm3/mol,
    // from the fragmentation {-CH3: 2, -CH2-: 6}.
    const frag = await fragment("CCCCCCCC");
    expect(jobackNormalBoilingPoint(frag)).toMatchObject({ ok: true });
    const tb = jobackNormalBoilingPoint(frag);
    const tc = jobackCriticalTemperature(frag);
    const pc = jobackCriticalPressure(frag);
    const vc = jobackCriticalVolume(frag);
    if (!tb.ok || !tc.ok || !pc.ok || !vc.ok) throw new Error("octane should estimate");

    expect(tb.value).toBeCloseTo(382.64, 1);
    expect(tc.value).toBeCloseTo(546.17, 1);
    expect(pc.value).toBeCloseTo(25.35, 1);
    expect(vc.value).toBeCloseTo(483.5, 1);
    expect(frag.counts.get(1)).toBe(2);
    expect(frag.counts.get(2)).toBe(6);
  });

  it("handles a heteroatom-bearing molecule", async () => {
    // Ethanol, thermo: Tb 337.54 K, Vc 166.5 cm3/mol.
    const frag = await fragment("CCO");
    const tb = jobackNormalBoilingPoint(frag);
    const vc = jobackCriticalVolume(frag);
    if (!tb.ok || !vc.ok) throw new Error("ethanol should estimate");
    expect(tb.value).toBeCloseTo(337.54, 1);
    expect(vc.value).toBeCloseTo(166.5, 1);
  });
});

describe("declining beats summing around a gap", () => {
  it("refuses a structure with an atom no group parameterises", async () => {
    // Boron has no Joback group. Summing the rest would produce a boiling point for a molecule that
    // is not the one asked about -- the same silent-omission failure the isotope envelope refuses and
    // the OpenClatura benchmark found in naming.
    const frag = await fragment("OB(O)c1ccccc1");
    expect(frag.unassignedAtoms.length).toBeGreaterThan(0);

    const tb = jobackNormalBoilingPoint(frag);
    expect(tb.ok).toBe(false);
    if (tb.ok) return;
    expect(tb.reason).toMatch(/matched no parameterised Joback group/);
    expect(tb.unsupportedFeature).toBe("unparameterised group");
  });

  it("refuses a metal-containing structure", async () => {
    const frag = await fragment("[Na+].[O-]C(=O)c1ccccc1");
    expect(jobackNormalBoilingPoint(frag).ok).toBe(false);
    expect(jobackCriticalVolume(frag).ok).toBe(false);
  });

  it("carries the decline through every dependent property", async () => {
    // Tc is computed FROM Tb, so a Tb decline must propagate rather than Tc inventing its own basis.
    const frag = await fragment("OB(O)c1ccccc1");
    expect(jobackCriticalTemperature(frag).ok).toBe(false);
    expect(jobackCriticalPressure(frag).ok).toBe(false);
  });
});

describe("the contracts", () => {
  it("classifies these as predictions with real uncertainty, not descriptors", async () => {
    // §8a's line: a group-contribution estimate is a prediction. Filing it as a descriptor would put
    // an estimated boiling point in the same table as a computed ring count.
    for (const contract of jobackContracts()) {
      expect(contract.classification.claim).toBe("prediction");
      expect(contract.classification.derivation).toBe("fragment-rule");
      expect(contract.accuracyClaims.length).toBeGreaterThan(0);
      expect(contract.accuracyClaims[0]!.metric).toBe("mae");
      expect(contract.citations.some((citation) => citation.id === "joback-1987")).toBe(true);
      // The isomer caveat is the one a reader most needs and is least likely to guess.
      expect(contract.conventions.some((entry) => entry.includes("identical group counts"))).toBe(true);
    }
  });

  it("attaches an uncertainty to every method it defines", () => {
    for (const contract of jobackContracts()) {
      expect(jobackUncertainty(contract.id)).toHaveLength(1);
    }
    expect(jobackUncertainty(JOBACK_TB_METHOD_ID)[0]!.value).toBe(12.9);
    expect(jobackUncertainty("not.a.method")).toEqual([]);
  });
});

describe("in the run", () => {
  it("reports an estimate with its uncertainty, and does not drag the run down when out of range", async () => {
    const { analyzeStructure } = await import("./analysis");
    const run = await analyzeStructure({
      format: "smiles",
      value: "CCCCCCCC",
      runId: "joback-run",
      startedAt: "2026-08-02T00:00:00.000Z"
    } as never);

    const tb = run.results.find((result) => result.methodId === JOBACK_TB_METHOD_ID);
    expect(tb?.kind).toBe("scalar");
    if (tb?.kind !== "scalar") return;
    expect(tb.status).toBe("ok");
    expect(tb.value).toBeCloseTo(382.64, 1);
    // An estimate rendered without its uncertainty reads as a measurement.
    expect(tb.uncertainties).toHaveLength(1);
    expect(tb.uncertainties[0]!.metric).toBe("mae");
  });

  it("separates a capability gap from a correlation that is merely out of range", async () => {
    const { analyzeStructure } = await import("./analysis");

    // C320: the Tc denominator goes negative, which would report a NEGATIVE critical temperature.
    // That is Joback's domain limit working, so it must be `not-applicable` — an `unsupported` here
    // would drag the whole run's status down for a method behaving correctly.
    const huge = await analyzeStructure({
      format: "smiles",
      value: "C".repeat(320),
      runId: "joback-huge",
      startedAt: "2026-08-02T00:00:00.000Z"
    } as never);
    const tc = huge.results.find((result) => result.methodId === "joback.critical-temperature");
    expect(tc?.status).toBe("not-applicable");
    expect(huge.status).toBe("ok");

    // Boron has no Joback group at all. That IS a capability gap, and keeps `unsupported` — the same
    // status Crippen logP gets for sodium.
    const boron = await analyzeStructure({
      format: "smiles",
      value: "OB(O)c1ccccc1",
      runId: "joback-boron",
      startedAt: "2026-08-02T00:00:00.000Z"
    } as never);
    expect(boron.results.find((result) => result.methodId === JOBACK_TB_METHOD_ID)?.status).toBe("unsupported");
  });
});

describe("the report", () => {
  it("renders an estimate with its spread, not as a bare number", async () => {
    // The point of the whole `prediction` classification: "382.6 K" is indistinguishable from a
    // measurement, and a reader has no way to know the method is good to about ±13 K.
    const { analyzeStructure } = await import("./analysis");
    const { buildAnalysisReport, renderReportText } = await import("@chemdraft/analysis-core");

    const run = await analyzeStructure({
      format: "smiles",
      value: "CCCCCCCC",
      runId: "joback-report",
      startedAt: "2026-08-02T00:00:00.000Z"
    } as never);
    const report = buildAnalysisReport(run);
    const text = renderReportText(report);

    expect(text).toContain("382.6 ± 12.9 K");

    // And what the ± means is stated once, as a convention, rather than repeated on every row.
    expect(text).toMatch(/average absolute error over Joback's development set/);
    expect(text).toMatch(/not a confidence interval for this molecule/);
  });

  it("leaves a measured-style descriptor without a spurious spread", async () => {
    // Only methods that actually carry an uncertainty get a `±`. A descriptor gaining one would be
    // the same overstatement in the opposite direction.
    const { analyzeStructure } = await import("./analysis");
    const { buildAnalysisReport } = await import("@chemdraft/analysis-core");
    const run = await analyzeStructure({
      format: "smiles",
      value: "CC(=O)Oc1ccccc1C(=O)O",
      runId: "joback-report-2",
      startedAt: "2026-08-02T00:00:00.000Z"
    } as never);
    const tpsa = run.results.find((result) => result.methodId === "rdkit.tpsa");
    expect(tpsa?.uncertainties).toEqual([]);
    const section = buildAnalysisReport(run).sections.find(
      (entry) => entry.kind === "keyValue" && entry.title.startsWith("Descriptors")
    );
    const row = section?.kind === "keyValue" ? section.rows.find((r) => r.label.includes("TPSA")) : undefined;
    expect(row?.value).not.toContain("±");
  });
});

describe("charged species are outside the method", () => {
  // Joback's increments are fitted to neutral organics, and the group table says so
  // (`knownUnsupportedChemistry`). Nothing enforced it: an aromatic `[nH+]` is X3, H1 and in a ring,
  // so it matched `>NH (ring)` — the PYRROLE-TYPE NEUTRAL nitrogen — and every property came back
  // `ok` and `in-domain`. Pyridinium's 384.67 K sat four kelvin from real pyridine's boiling point,
  // which is what made it dangerous: nothing about the number reads as wrong.
  it("declines an N-protonated aromatic heterocycle and says the charge is why", async () => {
    const frag = await fragment("c1cc[nH+]cc1");
    expect(frag.chargedAtoms).toHaveLength(1);
    expect(frag.unassignedAtoms).toContain(frag.chargedAtoms[0]);

    for (const estimate of [
      jobackNormalBoilingPoint(frag),
      jobackCriticalTemperature(frag),
      jobackCriticalPressure(frag),
      jobackCriticalVolume(frag)
    ]) {
      expect(estimate.ok).toBe(false);
      if (estimate.ok) continue;
      expect(estimate.reason).toMatch(/formal charge/);
      expect(estimate.unsupportedFeature).toBe("ionic or zwitterionic species");
    }
  });

  it("declines an N-alkylated aromatic cation, which used to score on the nonring parameter", async () => {
    // 1-methylpyridinium fragmented to `33x1` — `>N- (nonring)` — because that pattern carried no
    // `!R` guard, so a RING nitrogen was scored with the NONRING increment. Joback publishes no
    // `>N- (ring)` term at all, so there is nothing to fall back to and declining is the answer.
    const frag = await fragment("C[n+]1ccccc1");
    expect(frag.unassignedAtoms.length).toBeGreaterThan(0);
    expect(jobackNormalBoilingPoint(frag).ok).toBe(false);
  });

  it("still scores nitro compounds, whose charge separation is the group as published", async () => {
    // The one genuine exception: `-NO2` is written charge-separated and is net neutral, and its
    // SMARTS names the charges itself. A blanket "no charged atoms" rule would have broken every
    // nitro compound, which is why the exemption is a property of the group rather than of the atom.
    const frag = await fragment("[O-][N+](=O)c1ccccc1");
    expect(frag.unassignedAtoms).toEqual([]);
    const boiling = jobackNormalBoilingPoint(frag);
    expect(boiling.ok).toBe(true);
    if (boiling.ok) expect(boiling.value).toBeGreaterThan(400);
  });

  it("leaves ordinary neutral organics untouched", async () => {
    // The regression guard for the charge rule: pyridine is the neutral twin of the first case.
    const frag = await fragment("c1ccncc1");
    expect(frag.chargedAtoms).toEqual([]);
    expect(frag.unassignedAtoms).toEqual([]);
    expect(jobackNormalBoilingPoint(frag).ok).toBe(true);
  });
});

describe("the critical-pressure correlation declines instead of squaring the sign away", () => {
  // `Pc = (0.113 + 0.0032·nA − Σpc)⁻²`. The guard used to read `base === 0`, which a float sum lands
  // on only by accident — so a NEGATIVE base fell through to `1 / (base * base)`, the square erased
  // the sign, and the method returned a large positive pressure as `ok` with a ±0.31 bar uncertainty.
  it("declines when the base term goes negative", async () => {
    // Hexakis(pentahydroxyphenyl)benzene: 72 heavy atoms, inside the 500-atom budget, every atom
    // assigned. base = -0.1462, which used to report 46.8 bar — an entirely ordinary-looking number.
    const frag = await fragment(
      "Oc1c(O)c(O)c(-c2c(-c3c(O)c(O)c(O)c(O)c3O)c(-c3c(O)c(O)c(O)c(O)c3O)c(-c3c(O)c(O)c(O)c(O)c3O)" +
        "c(-c3c(O)c(O)c(O)c(O)c3O)c2-c2c(O)c(O)c(O)c(O)c2O)c(O)c1O"
    );
    expect(frag.unassignedAtoms).toEqual([]);
    const pressure = jobackCriticalPressure(frag);
    expect(pressure.ok).toBe(false);
    if (!pressure.ok) expect(pressure.kind).toBe("not-applicable");
  });

  it("declines when the base term is positive but too small to be physical", async () => {
    // The sign guard alone does not catch this: base stays positive and the reciprocal square runs
    // away. Decahydroxyanthracene — 24 heavy atoms, every one assigned — gives base = +0.0266 and
    // 1,413 bar. Water, the highest critical pressure among common substances and not even an
    // organic, is 220.6 bar; the highest this correlation gives any ordinary small organic is 68.
    const frag = await fragment("Oc1c(O)c(O)c2c(O)c3c(O)c(O)c(O)c(O)c3c(O)c2c1O");
    expect(frag.unassignedAtoms).toEqual([]);
    const pressure = jobackCriticalPressure(frag);
    expect(pressure.ok).toBe(false);
    if (!pressure.ok) expect(pressure.reason).toMatch(/not a physical critical pressure/);
  });

  it("leaves the highest-pressure molecules the method can legitimately describe alone", async () => {
    // The guard against the guard: the ceiling must sit far enough above real chemistry that nothing
    // Joback can actually score is refused by it. These are the small polar molecules with the
    // highest real critical pressures in the method's reach.
    for (const smiles of ["CO", "OC=O", "CC(=O)O", "OCC(O)CO", "Oc1ccccc1", "CC#N"]) {
      const estimate = jobackCriticalPressure(await fragment(smiles));
      expect(estimate.ok, smiles).toBe(true);
      if (estimate.ok) expect(estimate.value, smiles).toBeLessThan(100);
    }
  });

  it("still reports ordinary molecules", async () => {
    const frag = await fragment("CCCCCCCC");
    const pressure = jobackCriticalPressure(frag);
    expect(pressure.ok).toBe(true);
    if (pressure.ok) expect(pressure.value).toBeCloseTo(25.35, 1);
  });
});
