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

  it("captures the strong M+2 signature of a polychlorinated compound", () => {
    const report = analyzeMass({ format: "smiles", value: "ClC(Cl)Cl" }); // chloroform, 3× Cl
    expect(report.formula).toBe("CHCl3");
    const m2 = report.isotopePattern.find((peak) => peak.label === "M+2");
    expect(m2?.relativeIntensity).toBeGreaterThan(90); // ~96%: the chloroform isotope fingerprint
  });

  it("normalizes sulfur isotope abundance against the monoisotopic isotope", () => {
    const report = analyzeMass({ format: "smiles", value: "CS(C)=O" });
    const m2 = report.isotopePattern.find((peak) => peak.label === "M+2");
    expect(report.isotopePattern[0]).toEqual({ label: "M", relativeIntensity: 100 });
    expect(m2?.relativeIntensity).toBe(4.69);
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
