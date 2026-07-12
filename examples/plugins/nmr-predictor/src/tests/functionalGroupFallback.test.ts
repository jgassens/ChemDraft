import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import {
  estimateCarbonShift,
  estimateCarbonShiftWithApplicability
} from "../providers/ocl/functionalGroupFallback";

function mol(smiles: string): OCL.Molecule {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return molecule;
}

describe("functional-group fallback estimates", () => {
  it("puts an aldehyde carbon near 192 with explicit estimator provenance", () => {
    const acetaldehyde = mol("CC=O"); // atom 1 = aldehyde carbon
    expect(estimateCarbonShift(acetaldehyde, 1)).toBe(192);
    expect(estimateCarbonShiftWithApplicability(acetaldehyde, 1)).toMatchObject({
      applicable: true,
      ppm: 192,
      estimator: {
        id: "chemdraft.functional-group-rules",
        version: "1.1.0",
        method: "carbonyl-aldehyde"
      }
    });
  });

  it("separates ketone (~205) from acid/ester (~172) carbonyls", () => {
    expect(estimateCarbonShift(mol("CC(=O)C"), 1)).toBe(205); // ketone
    expect(estimateCarbonShift(mol("CC(=O)O"), 1)).toBe(172); // carboxylic acid (two oxygens)
  });
});
