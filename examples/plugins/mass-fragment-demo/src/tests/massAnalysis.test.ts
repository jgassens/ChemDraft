import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { analyzeMass, MassAnalysisError, parseFormulaCounts } from "../massAnalysis";

describe("analyzeMass", () => {
  it("computes formula, monoisotopic and average mass for benzene", () => {
    const report = analyzeMass({ format: "smiles", value: "c1ccccc1" });
    expect(report.formula).toBe("C6H6");
    expect(report.monoisotopicMass).toBeCloseTo(78.047, 2);
    expect(report.averageMass).toBeCloseTo(78.11, 1);
  });

  it("lists common ESI adduct m/z (positive and negative mode)", () => {
    const { ions } = analyzeMass({ format: "smiles", value: "c1ccccc1" });
    const by = (species: string) => ions.find((ion) => ion.species === species);
    expect(by("[M+H]+")?.mz).toBeCloseTo(79.0542, 2);
    expect(by("[M+Na]+")?.mz).toBeCloseTo(101.0362, 2);
    expect(by("[M-H]-")?.charge).toBe(-1);
    expect(by("[M-H]-")?.mz).toBeCloseTo(77.0397, 2);
  });

  it("captures the strong M+2 signature of a polychlorinated compound", () => {
    const report = analyzeMass({ format: "smiles", value: "ClC(Cl)Cl" }); // chloroform, 3× Cl
    expect(report.formula).toBe("CHCl3");
    const m2 = report.isotopePattern.find((peak) => peak.label === "M+2");
    expect(m2?.relativeIntensity).toBeGreaterThan(90); // ~96%: the chloroform isotope fingerprint
  });

  it("analyzes a V2000 molfile — the lossless format the selection boundary now emits", () => {
    const molfile = OCL.Molecule.fromSmiles("CCO").toMolfile();
    const report = analyzeMass({ format: "molfile-v2000", value: molfile });
    expect(report.formula).toBe("C2H6O");
    expect(report.monoisotopicMass).toBeCloseTo(46.0419, 2);
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
