import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { NmrNucleus, NmrPredictionOptions } from "../domain/contracts";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { buildNmrDatabase } from "../providers/ocl/buildDatabase";
import { atomEnvironmentCodes, environmentKey } from "../providers/ocl/environmentCode";
import type { CompiledNmrDatabase, NmrDatabaseEntry } from "../providers/ocl/localDatabase";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";

const OPTIONS: NmrPredictionOptions = {
  statistic: "median",
  hoseLevels: [4, 3, 2, 1],
  ignoreLabileHydrogens: true
};

const PROVENANCE = {
  name: "test",
  version: "1",
  source: "s",
  license: "l",
  attribution: "a",
  note: "n",
  structureCount: 1,
  entryCount: 0,
  nuclei: ["1H", "13C"] as const,
  generatedAt: "t"
};

function makeSd(smiles: string, carbons: { atom: number; shift: number }[]): string {
  const molfile = OCL.Molecule.fromSmiles(smiles).toMolfile();
  const assignment = carbons.map((carbon, index) => `s${index}, ${carbon.shift}, ${carbon.atom}\\`).join("\n");
  const spectrum = carbons.map((carbon, index) => `${carbon.shift}, L=s${index}\\`).join("\n");
  return `${molfile}\n> <NMREDATA_ASSIGNMENT>\n${assignment}\n\n> <NMREDATA_1D_13C>\n${spectrum}\n\n$$$$\n`;
}

function database(entries: Record<string, NmrDatabaseEntry> = {}): CompiledNmrDatabase {
  return { provenance: { ...PROVENANCE, entryCount: Object.keys(entries).length }, entries };
}

function shallowDatabase(
  smiles: string,
  nucleus: NmrNucleus,
  stats: Partial<Omit<NmrDatabaseEntry, "nucleus" | "sphere">> = {}
): CompiledNmrDatabase {
  return databaseAtSphere(smiles, nucleus, 1, stats);
}

function databaseAtSphere(
  smiles: string,
  nucleus: NmrNucleus,
  sphere: number,
  stats: Partial<Omit<NmrDatabaseEntry, "nucleus" | "sphere">> = {}
): CompiledNmrDatabase {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const entries: Record<string, NmrDatabaseEntry> = {};
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const target = nucleus === "13C" ? molecule.getAtomicNo(atom) === 6 : molecule.getAllHydrogens(atom) > 0;
    if (!target) continue;
    const code = atomEnvironmentCodes(molecule, atom, sphere)[0];
    entries[environmentKey(nucleus, code)] = {
      nucleus,
      sphere,
      n: stats.n ?? 10,
      median: stats.median ?? 8,
      mean: stats.mean ?? 8.5,
      stdev: stats.stdev ?? 0.1,
      min: stats.min ?? 7.8,
      max: stats.max ?? 8.8
    };
  }
  return database(entries);
}

function predict(
  predictor: OclHosePredictor,
  smiles: string,
  nucleus: NmrNucleus = "13C",
  statistic: NmrPredictionOptions["statistic"] = "median"
) {
  return predictor.predict({
    structure: { format: "smiles", value: smiles },
    nuclei: [nucleus],
    options: { ...OPTIONS, statistic }
  });
}

describe("OclHosePredictor", () => {
  it("round-trips a built database: querying the training molecule returns its shifts", async () => {
    const compiled = buildNmrDatabase(
      makeSd("CCC", [
        { atom: 1, shift: 15.5 },
        { atom: 2, shift: 16.1 },
        { atom: 3, shift: 15.5 }
      ]),
      { provenance: { name: "test", version: "1", source: "s", license: "l", attribution: "a", note: "n" }, now: () => "t" }
    );
    const predictor = new OclHosePredictor({ database: compiled, now: () => "t" });
    const result = await predict(predictor, "CCC");

    expect(result.resonances.map((resonance) => resonance.deltaPpm).sort((a, b) => a - b)).toEqual([15.5, 16.1]);
    expect(result.resonances.find((resonance) => resonance.deltaPpm === 15.5)?.equivalentNuclei).toBe(2);
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.resonances[0].evidence?.matchedSphere).toBeGreaterThanOrEqual(1);
    expect(() => NmrPredictionResultSchema.parse(result)).not.toThrow();
  });

  it("emits applicable unmatched rules with exact per-estimate provenance", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "CCC");
    expect(result.warnings.map((warning) => warning.code)).toContain("NMR_RULE_ESTIMATED");
    const estimated = result.resonances.filter((resonance) => resonance.evidence?.method === "rule-estimated");
    expect(estimated.length).toBeGreaterThan(0);
    expect(estimated.every((resonance) => resonance.flags.includes("rule-estimated"))).toBe(true);
    expect(estimated.every((resonance) => resonance.evidence?.estimator?.id === "chemdraft.functional-group-rules")).toBe(true);
    expect(estimated.every((resonance) => resonance.evidence?.estimator?.version === "1.1.0")).toBe(true);
  });

  it("omits unsupported unmatched silicon environments instead of fabricating shifts", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "C[Si](C)(C)C");
    expect(result.resonances).toHaveLength(0);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["NMR_UNSUPPORTED_ELEMENT", "NMR_NO_FRAGMENT_MATCH", "NMR_PARTIAL_PREDICTION"])
    );
    expect(result.warnings.find((warning) => warning.code === "NMR_NO_FRAGMENT_MATCH")?.details).toMatchObject({
      estimateInapplicableReason: "unsupported-substituent"
    });
  });

  it.each([
    ["imine", "CC=N", 1, "unsupported-bonding-environment"],
    ["nitrile", "CC#N", 1, "unsupported-bonding-environment"]
  ])("omits an unmatched multiply bonded heteroatom %s carbon", async (_name, smiles, atom, reason) => {
    const result = await predict(new OclHosePredictor({ database: database() }), smiles);
    expect(
      result.resonances.some((resonance) => resonance.atomRefs.some((ref) => ref.sourceAtomIndex === atom))
    ).toBe(false);
    expect(
      result.warnings.some(
        (warning) =>
          warning.code === "NMR_NO_FRAGMENT_MATCH" &&
          warning.atomIndices?.includes(atom) &&
          warning.details?.estimateInapplicableReason === reason
      )
    ).toBe(true);
  });

  it("does not apply the benzene carbon rule to an unmatched heteroaromatic ring", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "n1ccccc1");
    expect(result.resonances).toHaveLength(0);
    expect(
      result.warnings.some(
        (warning) => warning.details?.estimateInapplicableReason === "heteroaromatic-ring"
      )
    ).toBe(true);
  });

  it("honors options.statistic for both median and mean", async () => {
    const compiled = shallowDatabase("CC", "13C", { median: 11, mean: 19 });
    const predictor = new OclHosePredictor({ database: compiled });
    expect((await predict(predictor, "CC", "13C", "median")).resonances[0].deltaPpm).toBe(11);
    expect((await predict(predictor, "CC", "13C", "mean")).resonances[0].deltaPpm).toBe(19);
  });

  it.each([
    ["pyrimidine", "n1ccncc1"],
    ["dimethyl sulfide", "CSC"],
    ["acetaldimine", "CC=N"]
  ])("preserves the HOSE value and offers no invalid increment for %s", async (_name, smiles) => {
    const predictor = new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 8.66, mean: 8.8 }) });
    const result = await predict(predictor, smiles, "1H");
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(result.resonances.every((resonance) => resonance.deltaPpm === 8.66)).toBe(true);
    expect(result.resonances.every((resonance) => resonance.crossCheck === undefined)).toBe(true);
  });

  it("retains an additive comparison for low-confidence fused carbocyclic PAH matches", async () => {
    const smiles = "c1ccc2ccccc2c1";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 7.8, mean: 7.8 }) }),
      smiles,
      "1H"
    );

    expect(result.resonances.some((resonance) => resonance.crossCheck !== undefined)).toBe(true);
    expect(
      result.resonances
        .filter((resonance) => resonance.crossCheck)
        .every(
          (resonance) =>
            resonance.crossCheck?.estimator?.id === "chemdraft.h1-additive-increment" &&
            resonance.crossCheck.estimator?.version === "1.3.0" &&
            resonance.crossCheck.estimator?.method === "aromatic-substituent-increment"
        )
    ).toBe(true);
    expect(
      result.resonances
        .filter((resonance) => resonance.crossCheck)
        .every((resonance) => resonance.crossCheck?.reason === "weak-applicability")
    ).toBe(true);
  });

  it("offers a second opinion for a specific but high-dispersion 1H match", async () => {
    const predictor = new OclHosePredictor({
      database: databaseAtSphere("CC", "1H", 2, { median: 0.9, mean: 2.0, stdev: 0.5, n: 25 })
    });
    const median = await predict(predictor, "CC", "1H", "median");
    const mean = await predict(predictor, "CC", "1H", "mean");

    expect(median.resonances[0]).toMatchObject({
      deltaPpm: 0.9,
      evidence: { matchedSphere: 2, sampleCount: 25 },
      crossCheck: {
        incrementPpm: 0.9,
        disagrees: false,
        reason: "high-dispersion",
        estimator: { version: "1.3.0", method: "shoolery-alpha-beta-gamma" }
      }
    });
    expect(mean.resonances[0]).toMatchObject({
      deltaPpm: 2.0,
      crossCheck: { incrementPpm: 0.9, disagrees: true, reason: "high-dispersion" }
    });
    expect(() => NmrPredictionResultSchema.parse(median)).not.toThrow();
  });

  it("uses estimator v1.3 provenance for unmatched 1H rule fallbacks", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "CCCO", "1H");
    const estimated = result.resonances.filter((resonance) => resonance.evidence?.method === "rule-estimated");
    expect(estimated.length).toBeGreaterThan(0);
    expect(
      estimated.every((resonance) => {
        const estimator = resonance.evidence?.method === "rule-estimated" ? resonance.evidence.estimator : undefined;
        return (
          estimator?.id === "chemdraft.h1-additive-increment" &&
          estimator.version === "1.3.0" &&
          estimator.method === "shoolery-alpha-beta-gamma"
        );
      })
    ).toBe(true);
  });

  it("keeps an applicable comparison available for a specific low-dispersion match", async () => {
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere("CC", "1H", 2, { stdev: 0.49, n: 25 }) }),
      "CC",
      "1H"
    );
    expect(result.resonances.every((resonance) => resonance.crossCheck?.reason === "routine-applicability")).toBe(true);
    expect(result.resonances.every((resonance) => resonance.crossCheck?.estimator?.version === "1.3.0")).toBe(true);
  });

  it("does not force an inapplicable increment onto a high-dispersion heteroaromatic match", async () => {
    const smiles = "n1ccncc1";
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere(smiles, "1H", 2, { stdev: 0.8, n: 25 }) }),
      smiles,
      "1H"
    );
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(result.resonances.every((resonance) => resonance.crossCheck === undefined)).toBe(true);
  });

  it("preserves normalization warnings and suppresses increment cross-checks for charged structures", async () => {
    const smiles = "C[N+](C)(C)C";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 3.2 }) }),
      smiles,
      "1H"
    );
    expect(result.warnings.map((warning) => warning.code)).toContain("NMR_CHARGED_STRUCTURE");
    expect(result.resonances.every((resonance) => resonance.crossCheck === undefined)).toBe(true);
  });

  it("warns that methylene hydrogens in a stereogenic structure may be nonequivalent without splitting them", async () => {
    const smiles = "C[C@H](F)CO";
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere(smiles, "1H", 2) }),
      smiles,
      "1H"
    );
    const warning = result.warnings.find(
      (candidate) => candidate.code === "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
    );
    expect(warning?.atomIndices).toEqual([3]);
    expect(warning?.message).toContain("does not predict separate diastereotopic values");
    expect(result.resonances.some((resonance) => resonance.atomRefs.some((ref) => ref.sourceAtomIndex === 3))).toBe(true);
    expect(result.resonances.every((resonance) => resonance.atomRefs.length === 1)).toBe(true);
  });

  it("does not raise the diastereotopic disclosure for an achiral acyclic structure", async () => {
    const result = await predict(new OclHosePredictor({ database: databaseAtSphere("CCO", "1H", 2) }), "CCO", "1H");
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
    );
  });

  it("keeps strychnine HOSE-first while exposing its applicable vinylic increment comparison", async () => {
    // ChEBI 28973; this is the user-reported bridged/chiral regression structure from M25.
    const smiles = "[H][C@@]12N3C(=O)C[C@]4([H])OCC=C5CN6CC[C@@]1(c1ccccc13)[C@]6([H])C[C@]5([H])[C@]24[H]";
    const result = await predict(new OclHosePredictor({ now: () => "t" }), smiles, "1H");
    const vinylic = result.resonances.find(
      (resonance) => resonance.crossCheck?.estimator?.method === "functional-class-vinylic"
    );

    expect(vinylic).toMatchObject({
      deltaPpm: 5.84,
      crossCheck: {
        incrementPpm: 5.7,
        disagrees: false,
        reason: "routine-applicability",
        estimator: { version: "1.3.0" }
      }
    });
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
    );
  });

  it("treats a canonical nitro group as a supported table class without an ionic-chemistry warning", async () => {
    const smiles = "O=[N+]([O-])c1ccccc1";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 8.2 }) }),
      smiles,
      "1H"
    );
    expect(result.warnings.map((warning) => warning.code)).not.toContain("NMR_CHARGED_STRUCTURE");
    expect(result.resonances.some((resonance) => resonance.crossCheck?.estimator?.id === "chemdraft.h1-additive-increment")).toBe(true);
  });

  it("splits shallow-code groups when atoms have different increment cross-checks", async () => {
    const smiles = "COc1ccccc1";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 8.5, mean: 8.5 }) }),
      smiles,
      "1H"
    );
    const byCode = new Map<string, typeof result.resonances>();
    for (const resonance of result.resonances) {
      const code = resonance.evidence?.environmentCode ?? "";
      byCode.set(code, [...(byCode.get(code) ?? []), resonance]);
    }
    const split = [...byCode.values()].find(
      (group) => group.length > 1 && new Set(group.map((resonance) => resonance.crossCheck?.incrementPpm)).size > 1
    );
    expect(split).toBeDefined();
    expect(split?.every((resonance) => resonance.crossCheck?.estimator?.id === "chemdraft.h1-additive-increment")).toBe(true);
  });

  it("keeps symmetry-equivalent multiplets grouped when only representative partner indices differ", async () => {
    const smiles = "CC";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 1.2 }) }),
      smiles,
      "1H"
    );

    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ equivalentNuclei: 6, multiplet: { label: "q" } });
    expect(result.resonances[0].atomRefs.map((ref) => ref.sourceAtomIndex).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("uses the bundled NMRShiftDB2 database and surfaces its provenance", async () => {
    const predictor = new OclHosePredictor({ now: () => "t" });
    expect(await predictor.getCapabilities()).toMatchObject({ id: "chemdraft.ocl-hose", supportsUncertainty: true });

    const result = await predict(predictor, "CC(=O)C");
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.backend.dataVersion).toContain("NMRShiftDB2");
    expect(result.backend.license).toBeTruthy();
    expect(result.backend.attribution).toBeTruthy();
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(result.resonances.some((resonance) => resonance.evidence?.method === "hose-fragment")).toBe(true);
    for (const resonance of result.resonances) {
      const sd = resonance.uncertainty?.standardDeviationPpm;
      expect(sd === undefined || typeof sd === "number").toBe(true);
      if (resonance.evidence?.method === "hose-fragment") {
        expect(resonance.evidence.sampleCount).toBeGreaterThan(0);
      }
    }
  });

  it("emits 2D depiction geometry whose atom indices align with resonance atomRefs", async () => {
    const result = await predict(new OclHosePredictor({ now: () => "t" }), "CC(=O)C");
    const depiction = result.depiction;
    expect(depiction).toBeDefined();
    if (!depiction) return;

    expect(depiction.atoms).toHaveLength(4);
    expect(depiction.bonds.length).toBeGreaterThanOrEqual(3);
    const atomIndices = new Set(depiction.atoms.map((atom) => atom.index));
    for (const resonance of result.resonances) {
      for (const ref of resonance.atomRefs) expect(atomIndices.has(ref.sourceAtomIndex)).toBe(true);
    }
    for (const bond of depiction.bonds) {
      expect(atomIndices.has(bond.from)).toBe(true);
      expect(atomIndices.has(bond.to)).toBe(true);
      expect(bond.order).toBeGreaterThanOrEqual(1);
      expect(bond.order).toBeLessThanOrEqual(3);
    }
  });
});
