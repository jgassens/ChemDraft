import * as OCL from "openchemlib";

import type { NmrStructureBond, NmrStructureDepiction } from "../../domain/contracts";

/**
 * Build a chemistry-agnostic 2D depiction (indexed atom points + bond lines) from the predictor's
 * OpenChemLib molecule, for the desktop's interactive linked figure (ADR-0015). Atom indices are the
 * molecule's own indices — identical to those used in resonance `atomRefs` — so the panel cross-links
 * peaks to atoms with no re-derivation and no second molecule build.
 *
 * Coordinates are invented for a clean, non-overlapping 2D layout (SMILES input carries none, like
 * ChemDraw's own ChemNMR output structure). Returns `undefined` if there is nothing to draw or layout
 * fails, so a prediction never depends on depiction succeeding. This module carries the only runtime
 * OpenChemLib import on the depiction path; it is reachable solely through `OclHosePredictor`, which
 * the desktop loads lazily / in the worker, so it stays out of the main bundle (see ADR-0014/M10).
 */
export function buildStructureDepiction(molecule: OCL.Molecule): NmrStructureDepiction | undefined {
  const atomCount = molecule.getAllAtoms();
  if (atomCount === 0) {
    return undefined;
  }
  try {
    molecule.inventCoordinates();
  } catch {
    return undefined;
  }

  const atoms = Array.from({ length: atomCount }, (_unused, atom) => ({
    index: atom,
    x: round(molecule.getAtomX(atom)),
    y: round(molecule.getAtomY(atom)),
    element: OCL.Molecule.cAtomLabel[molecule.getAtomicNo(atom)] ?? `Z${molecule.getAtomicNo(atom)}`
  }));

  const bonds: NmrStructureBond[] = [];
  for (let bond = 0; bond < molecule.getAllBonds(); bond += 1) {
    const order = molecule.getBondOrder(bond);
    bonds.push({
      from: molecule.getBondAtom(0, bond),
      to: molecule.getBondAtom(1, bond),
      // Clamp to single/double/triple; aromatic/other orders render as single lines.
      order: order >= 1 && order <= 3 ? order : 1
    });
  }

  return { atoms, bonds };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
