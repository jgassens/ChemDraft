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

  it("uses the bundled NMRShiftDB2 database and surfaces its provenance", async () => {
    const predictor = new OclHosePredictor({ now: () => "t" });
    expect(predictor.getCapabilities()).toMatchObject({ id: "chemdraft.ocl-hose", supportsUncertainty: true });
    expect(predictor.provenance.name).toContain("NMRShiftDB2");

    const result = await predict(predictor, "CC(=O)C"); // acetone — its methyls are well represented
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.backend.license).toBeTruthy();
    expect(result.backend.attribution).toBeTruthy();
    expect(result.resonances.length).toBeGreaterThan(0);
    // Every resonance carries dispersion + a matched sphere from real reference data.
    for (const resonance of result.resonances) {
      expect(resonance.uncertainty?.standardDeviationPpm).toBeTypeOf("number");
      expect(resonance.evidence?.sampleCount).toBeGreaterThan(0);
    }
  });
});
