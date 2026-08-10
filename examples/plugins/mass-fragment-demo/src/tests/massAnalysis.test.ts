import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { analyzeMass, MassAnalysisError, parseFormulaCounts } from "../massAnalysis";

describe("analyzeMass", () => {
  it("computes formula, monoisotopic and average mass for benzene", () => {
    const report = analyzeMass({ format: "smiles", value: "c1ccccc1" });
    expect(report.formula).toBe("C6H6");
    expect(report.netCharge).toBe(0);
    expect(report.monoisotopicMass).toBe(78.047);
    expect(report.averageMass).toBe(78.11);
  });

  it("lists common ESI adduct m/z (positive and negative mode)", () => {
    const { ions } = analyzeMass({ format: "smiles", value: "c1ccccc1" });
    const by = (species: string) => ions.find((ion) => ion.species === species);
    expect(by("[M+H]+")?.mz).toBe(79.0542);
    expect(by("[M+Na]+")?.mz).toBe(101.0362);
    expect(by("[M-H]-")?.charge).toBe(-1);
    expect(by("[M-H]-")?.mz).toBe(77.0397);
  });

  it("reports an already charged structure as its native ion without neutral-precursor adducts", () => {
    const report = analyzeMass({ format: "smiles", value: "C[N+](C)(C)C" });

    expect(report.formula).toBe("C4H12N");
    expect(report.netCharge).toBe(1);
    expect(report.monoisotopicMass).toBe(74.0964); // neutral-atom sum minus one electron
    expect(report.ions).toEqual([{ species: "[M]+", mz: 74.0964, charge: 1 }]);
    expect(report.ions.some((ion) => ion.species === "[M+H]+")).toBe(false);
  });

  it("applies the electron-mass correction in the opposite direction for anions", () => {
    const report = analyzeMass({ format: "smiles", value: "[Cl-]" });
    expect(report.netCharge).toBe(-1);
    expect(report.ions).toEqual([{ species: "[M]-", mz: 34.9694, charge: -1 }]);
  });

  it("no longer reports an isotope pattern of its own", () => {
    // The retired approximation. Chloroform was this plugin's showcase — a ~96% M+2 from three
    // chlorines — and it is now the host's answer, computed by IsoSpec against a real abundance table
    // rather than estimated here from an eight-element one with no recorded source. The chemistry is
    // covered by `envelope.real.test.ts` in the adapter, against the real engine.
    const report = analyzeMass({ format: "smiles", value: "ClC(Cl)Cl" });
    expect(report.formula).toBe("CHCl3");
    expect(report).not.toHaveProperty("isotopePattern");
  });

  it("analyzes a V2000 molfile — the lossless format the selection boundary now emits", () => {
    const molfile = OCL.Molecule.fromSmiles("CCO").toMolfile();
    const report = analyzeMass({ format: "molfile-v2000", value: molfile });
    expect(report.formula).toBe("C2H6O");
    expect(report.monoisotopicMass).toBe(46.0419);
  });

  it("throws MassAnalysisError on empty input", () => {
    expect(() => analyzeMass({ format: "smiles", value: "   " })).toThrow(MassAnalysisError);
  });
});

describe("parseFormulaCounts", () => {
  it("parses Hill notation with and without explicit counts", () => {
    expect(parseFormulaCounts("C9H8O4")).toEqual({ C: 9, H: 8, O: 4 });
    expect(parseFormulaCounts("CHCl3")).toEqual({ C: 1, H: 1, Cl: 3 });
  });
});
