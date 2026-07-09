import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { estimateCarbonShift, estimateProtonShift } from "../providers/ocl/functionalGroupFallback";

function mol(smiles: string): OCL.Molecule {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return molecule;
}

describe("functional-group fallback estimates", () => {
  it("puts an aldehyde proton near 9.7 and its carbon near 192", () => {
    const acetaldehyde = mol("CC=O"); // atom 1 = aldehyde carbon
    expect(estimateProtonShift(acetaldehyde, 1)).toBe(9.7);
    expect(estimateCarbonShift(acetaldehyde, 1)).toBe(192);
  });

  it("estimates aromatic, C–O and generic sp³ protons", () => {
    expect(estimateProtonShift(mol("c1ccccc1"), 0)).toBe(7.3); // aromatic C–H
    expect(estimateProtonShift(mol("CCO"), 1)).toBe(3.6); // O–CH2
    expect(estimateProtonShift(mol("CCCC"), 1)).toBe(1.3); // generic sp³
  });

  it("separates ketone (~205) from acid/ester (~172) carbonyls", () => {
    expect(estimateCarbonShift(mol("CC(=O)C"), 1)).toBe(205); // ketone
    expect(estimateCarbonShift(mol("CC(=O)O"), 1)).toBe(172); // carboxylic acid (two oxygens)
  });
});
