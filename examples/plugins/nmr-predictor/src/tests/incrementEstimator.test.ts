import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { incrementProtonShift } from "../providers/ocl/incrementEstimator";

function molecule(smiles: string): OCL.Molecule {
  const mol = OCL.Molecule.fromSmiles(smiles);
  mol.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return mol;
}

function aromaticShifts(smiles: string): number[] {
  const mol = molecule(smiles);
  const shifts: number[] = [];
  for (let atom = 0; atom < mol.getAllAtoms(); atom += 1) {
    if (mol.getAtomicNo(atom) === 6 && mol.isAromaticAtom(atom) && mol.getAllHydrogens(atom) > 0) {
      shifts.push(incrementProtonShift(mol, atom));
    }
  }
  return shifts.sort((a, b) => a - b);
}

describe("incrementProtonShift", () => {
  it("applies aromatic ortho/meta/para increments (nitrobenzene: ortho downfield, meta up)", () => {
    const shifts = aromaticShifts("O=[N+]([O-])c1ccccc1");
    expect(Math.max(...shifts)).toBeGreaterThan(8.0); // ortho-H (lit ~8.2)
    expect(Math.min(...shifts)).toBeLessThan(7.5); // meta-H (lit ~7.5)
  });

  it("keeps electron-rich rings upfield of benzene (anisole ortho-H < 7.26)", () => {
    expect(Math.min(...aromaticShifts("COc1ccccc1"))).toBeLessThan(7.0);
  });

  it("applies Shoolery aliphatic increments (ethylbenzene CH₂ ≈ 2.5)", () => {
    const mol = molecule("CCc1ccccc1");
    // atom 1 is the benzylic CH₂
    const ch2 = incrementProtonShift(mol, 1);
    expect(ch2).toBeGreaterThan(2.2);
    expect(ch2).toBeLessThan(2.9);
  });

  it("reuses the coarse base for an aldehyde CHO (~9.7)", () => {
    const mol = molecule("O=Cc1ccccc1");
    // the CHO carbon
    const cho = [...Array(mol.getAllAtoms()).keys()].find(
      (a) => mol.getAtomicNo(a) === 6 && mol.getAllHydrogens(a) === 1 && !mol.isAromaticAtom(a)
    )!;
    expect(incrementProtonShift(mol, cho)).toBeGreaterThan(9.0);
  });
});
