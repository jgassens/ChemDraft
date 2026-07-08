import { describe, expect, it } from "vitest";

import type { NmrNucleus, NmrPredictionOptions, NmrPredictionResult } from "../domain/contracts";
import { NmrErrorCodes, isNmrError } from "../domain/errors";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { fingerprintStructureInput } from "../domain/fingerprint";
import { FixtureHosePredictor } from "../providers/fixture/FixtureHosePredictor";

function shiftsOf(result: NmrPredictionResult): number[] {
  return result.resonances.map((resonance) => resonance.deltaPpm).sort((a, b) => a - b);
}

const OPTIONS: NmrPredictionOptions = { statistic: "median", hoseLevels: [2], ignoreLabileHydrogens: true };

function predictor() {
  return new FixtureHosePredictor({ now: () => "2026-07-07T00:00:00.000Z" });
}

function predict(
  smiles: string,
  nuclei: readonly NmrNucleus[],
  extra: { sourceFingerprint?: string; options?: NmrPredictionOptions } = {}
): Promise<NmrPredictionResult> {
  return predictor().predict({
    structure: { format: "smiles", value: smiles },
    nuclei,
    options: extra.options ?? OPTIONS,
    sourceFingerprint: extra.sourceFingerprint
  });
}

function warningCodes(result: NmrPredictionResult): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("FixtureHosePredictor", () => {
  it("advertises fixture capabilities", () => {
    expect(predictor().getCapabilities()).toMatchObject({
      id: "chemdraft.fixture-hose",
      nuclei: ["1H", "13C"],
      supportsUncertainty: true
    });
  });

  it("predicts benzene ¹³C as a single equivalent resonance", async () => {
    const result = await predict("c1ccccc1", ["13C"]);
    expect(result.resonances).toHaveLength(1);
    const [resonance] = result.resonances;
    expect(resonance.nucleus).toBe("13C");
    expect(resonance.deltaPpm).toBe(128.5);
    expect(resonance.equivalentNuclei).toBe(6);
    expect(resonance.atomRefs).toHaveLength(6);
    expect(resonance.evidence?.method).toBe("fixture-fragment");
    expect(result.backend).toMatchObject({ method: "fixture-fragment", dataVersion: expect.any(String) });
    expect(warningCodes(result)).not.toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("predicts benzene ¹H as one six-proton resonance", async () => {
    const result = await predict("c1ccccc1", ["1H"]);
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ nucleus: "1H", deltaPpm: 7.26, equivalentNuclei: 6 });
  });

  it("resolves toluene's five ¹³C environments, methyl included", async () => {
    const result = await predict("Cc1ccccc1", ["13C"]);
    expect(result.resonances).toHaveLength(5);
    const methyl = result.resonances.find((resonance) => resonance.deltaPpm === 21.3);
    // ¹³C equivalence counts carbons: toluene has one methyl carbon (the 3 protons matter for ¹H).
    expect(methyl?.equivalentNuclei).toBe(1);
    expect(warningCodes(result)).not.toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("groups acetone's two equivalent methyls into one resonance", async () => {
    const result = await predict("CC(=O)C", ["13C"]);
    expect(result.resonances).toHaveLength(2);
    const carbonyl = result.resonances.find((resonance) => resonance.deltaPpm === 206.6);
    const methyls = result.resonances.find((resonance) => resonance.deltaPpm === 30.8);
    expect(carbonyl?.equivalentNuclei).toBe(1);
    expect(methyls?.equivalentNuclei).toBe(2);
  });

  it("omits ethanol's labile OH proton and warns", async () => {
    const result = await predict("CCO", ["1H"]);
    expect(result.resonances).toHaveLength(2); // CH3, CH2
    expect(warningCodes(result)).toContain("NMR_LABILE_PROTON_OMITTED");
  });

  it("produces a partial result for a partially-covered molecule (ethylbenzene)", async () => {
    const result = await predict("CCc1ccccc1", ["13C"]);
    // meta/para aromatic carbons match shared codes; ipso/ortho/ethyl carbons do not.
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(warningCodes(result)).toContain("NMR_NO_FRAGMENT_MATCH");
    expect(warningCodes(result)).toContain("NMR_PARTIAL_PREDICTION");
  });

  it("covers anisole ¹³C (methyl, ipso, ortho, meta, para)", async () => {
    const result = await predict("COc1ccccc1", ["13C"]);
    expect(result.resonances).toHaveLength(5);
    expect(result.resonances.find((resonance) => resonance.deltaPpm === 55.1)?.nucleus).toBe("13C"); // OCH3
    expect(result.resonances.find((resonance) => resonance.deltaPpm === 159.6)).toBeDefined(); // ipso C–O
    expect(warningCodes(result)).not.toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("covers acetonitrile ¹³C (methyl + nitrile carbon)", async () => {
    const result = await predict("CC#N", ["13C"]);
    expect(shiftsOf(result)).toEqual([1.9, 118.7]);
    expect(warningCodes(result)).not.toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("covers cyclohexane ¹³C as one six-carbon resonance", async () => {
    const result = await predict("C1CCCCC1", ["13C"]);
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ deltaPpm: 27.0, equivalentNuclei: 6 });
  });

  it("covers p-xylene ¹³C (methyl, ipso, ring CH)", async () => {
    const result = await predict("Cc1ccc(C)cc1", ["13C"]);
    expect(shiftsOf(result)).toEqual([21.3, 129.1, 137.8]);
    expect(warningCodes(result)).not.toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("builds ¹H atomRefs whose element is H and whose counts sum to equivalentNuclei", async () => {
    const result = await predict("CCO", ["1H"]);
    for (const resonance of result.resonances) {
      expect(resonance.atomRefs.every((ref) => ref.element === "H")).toBe(true);
      const summed = resonance.atomRefs.reduce((total, ref) => total + (ref.equivalentCount ?? 0), 0);
      expect(summed).toBe(resonance.equivalentNuclei);
    }
    // ethanol CH3 → one host atom, three equivalent protons.
    const methyl = result.resonances.find((resonance) => resonance.deltaPpm === 1.19);
    expect(methyl?.equivalentNuclei).toBe(3);
    expect(methyl?.atomRefs).toEqual([{ sourceAtomIndex: 0, element: "H", equivalentCount: 3 }]);
  });

  it("is deterministic (same input → identical result)", async () => {
    const first = await predict("Cc1ccccc1", ["13C", "1H"]);
    const second = await predict("Cc1ccccc1", ["13C", "1H"]);
    expect(first).toEqual(second);
  });

  it("emits a schema-valid, serializable result", async () => {
    const result = await predict("CCOC(=O)C", ["13C", "1H"]);
    expect(() => NmrPredictionResultSchema.parse(result)).not.toThrow();
    expect(() => structuredClone(result)).not.toThrow();
  });

  it("echoes a provided source fingerprint, else derives one from the structure", async () => {
    const echoed = await predict("c1ccccc1", ["13C"], { sourceFingerprint: "selection-fp" });
    expect(echoed.sourceFingerprint).toBe("selection-fp");

    const derived = await predict("c1ccccc1", ["13C"]);
    expect(derived.sourceFingerprint).toBe(fingerprintStructureInput({ format: "smiles", value: "c1ccccc1" }));
  });

  it("rejects an aborted signal as cancellation, not provider failure", async () => {
    const error = await predictor()
      .predict(
        { structure: { format: "smiles", value: "c1ccccc1" }, nuclei: ["13C"], options: OPTIONS },
        AbortSignal.abort()
      )
      .catch((caught: unknown) => caught);
    expect(isNmrError(error)).toBe(true);
    expect(isNmrError(error) && error.code).toBe(NmrErrorCodes.PredictionCancelled);
  });
});
