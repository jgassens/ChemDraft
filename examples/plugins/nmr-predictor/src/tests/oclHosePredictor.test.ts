import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { NmrPredictionOptions } from "../domain/contracts";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { buildNmrDatabase } from "../providers/ocl/buildDatabase";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";

const OPTIONS: NmrPredictionOptions = { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true };

function makeSd(smiles: string, carbons: { atom: number; shift: number }[]): string {
  const molfile = OCL.Molecule.fromSmiles(smiles).toMolfile();
  const assignment = carbons.map((carbon, index) => `s${index}, ${carbon.shift}, ${carbon.atom}\\`).join("\n");
  const spectrum = carbons.map((carbon, index) => `${carbon.shift}, L=s${index}\\`).join("\n");
  return `${molfile}\n> <NMREDATA_ASSIGNMENT>\n${assignment}\n\n> <NMREDATA_1D_13C>\n${spectrum}\n\n$$$$\n`;
}

function predict(predictor: OclHosePredictor, smiles: string) {
  return predictor.predict({ structure: { format: "smiles", value: smiles }, nuclei: ["13C"], options: OPTIONS });
}

describe("OclHosePredictor", () => {
  it("round-trips a built database: querying the training molecule returns its shifts", async () => {
    const database = buildNmrDatabase(
      makeSd("CCC", [
        { atom: 1, shift: 15.5 },
        { atom: 2, shift: 16.1 },
        { atom: 3, shift: 15.5 }
      ]),
      { provenance: { name: "test", version: "1", source: "s", license: "l", attribution: "a", note: "n" }, now: () => "t" }
    );
    const predictor = new OclHosePredictor({ database, now: () => "t" });
    const result = await predict(predictor, "CCC");

    expect(result.resonances.map((resonance) => resonance.deltaPpm).sort((a, b) => a - b)).toEqual([15.5, 16.1]);
    const methyls = result.resonances.find((resonance) => resonance.deltaPpm === 15.5);
    expect(methyls?.equivalentNuclei).toBe(2);
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.resonances[0].evidence?.matchedSphere).toBeGreaterThanOrEqual(1);
    expect(() => NmrPredictionResultSchema.parse(result)).not.toThrow();
  });

  it("warns instead of fabricating when nothing matches", async () => {
    const database = buildNmrDatabase(makeSd("CCC", [{ atom: 2, shift: 16.1 }]), {
      provenance: { name: "test", version: "1", source: "s", license: "l", attribution: "a", note: "n" }
    });
    const predictor = new OclHosePredictor({ database });
    // A silicon environment shares no code with the propane-only database.
    const result = await predict(predictor, "C[Si](C)(C)C");
    expect(result.warnings.map((warning) => warning.code)).toContain("NMR_NO_FRAGMENT_MATCH");
  });

  it("uses the bundled NMRShiftDB2 database (lazy-loaded) and surfaces its provenance", async () => {
    const predictor = new OclHosePredictor({ now: () => "t" });
    expect(await predictor.getCapabilities()).toMatchObject({ id: "chemdraft.ocl-hose", supportsUncertainty: true });

    const result = await predict(predictor, "CC(=O)C"); // acetone — its methyls are well represented
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.backend.dataVersion).toContain("NMRShiftDB2");
    expect(result.backend.license).toBeTruthy();
    expect(result.backend.attribution).toBeTruthy();
    expect(result.resonances.length).toBeGreaterThan(0);
    for (const resonance of result.resonances) {
      // stdev is present for n>=2 reference populations and omitted for singletons; sampleCount is always real.
      const sd = resonance.uncertainty?.standardDeviationPpm;
      expect(sd === undefined || typeof sd === "number").toBe(true);
      expect(resonance.evidence?.sampleCount).toBeGreaterThan(0);
    }
  });

  it("emits 2D depiction geometry whose atom indices align with resonance atomRefs (ADR-0015)", async () => {
    const predictor = new OclHosePredictor({ now: () => "t" });
    const result = await predict(predictor, "CC(=O)C"); // acetone — 3 C + 1 O heavy atoms
    const depiction = result.depiction;
    expect(depiction).toBeDefined();
    if (!depiction) return;

    expect(depiction.atoms).toHaveLength(4);
    expect(depiction.bonds.length).toBeGreaterThanOrEqual(3);
    const atomIndices = new Set(depiction.atoms.map((atom) => atom.index));

    // Every predicted atom ref resolves to a real depiction atom, so the panel can cross-highlight it.
    for (const resonance of result.resonances) {
      for (const ref of resonance.atomRefs) {
        expect(atomIndices.has(ref.sourceAtomIndex)).toBe(true);
      }
    }
    // Bonds reference real atoms and carry single/double/triple orders.
    for (const bond of depiction.bonds) {
      expect(atomIndices.has(bond.from)).toBe(true);
      expect(atomIndices.has(bond.to)).toBe(true);
      expect(bond.order).toBeGreaterThanOrEqual(1);
      expect(bond.order).toBeLessThanOrEqual(3);
    }
  });
});
