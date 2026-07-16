import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { collectCarbonEnvironments, describeAtomEnvironment } from "../providers/fixture/fixtureEnvironment";

function molecule(smiles: string): OCL.Molecule {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return mol;
}

describe("fixture environment codes", () => {
  it("gives all six benzene carbons the same environment code (symmetry → equivalence)", () => {
    const codes = new Set(collectCarbonEnvironments(molecule("c1ccccc1")).map((env) => env.environmentCode));
    expect(codes.size).toBe(1);
  });

  it("distinguishes toluene's five unique carbons", () => {
    const codes = new Set(collectCarbonEnvironments(molecule("Cc1ccccc1")).map((env) => env.environmentCode));
    expect(codes.size).toBe(5);
  });

  it("is deterministic for repeated calls on equivalent inputs", () => {
    const a = describeAtomEnvironment(molecule("CCO"), 0).environmentCode;
    const b = describeAtomEnvironment(molecule("CCO"), 0).environmentCode;
    expect(a).toBe(b);
  });

  it("marks aromatic atoms and reflects hydrogen count in the code", () => {
    const benzeneCarbon = describeAtomEnvironment(molecule("c1ccccc1"), 0);
    expect(benzeneCarbon.aromatic).toBe(true);
    expect(benzeneCarbon.hydrogenCount).toBe(1);
    expect(benzeneCarbon.environmentCode.startsWith("Ca")).toBe(true);
  });
});
