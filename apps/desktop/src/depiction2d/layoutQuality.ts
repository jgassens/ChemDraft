import type { MoleculeObject } from "@chemdraft/chem-core";
import { evaluateLayoutQuality, moleculeLayoutLabelBoxes, type LayoutQuality } from "@chemdraft/layout-engine";

/** Shared geometry check; paste requests skeleton contacts without planning text boxes. */
export function nativeMoleculeLayoutQuality(molecule: MoleculeObject, includeLabels = true): LayoutQuality {
  const indices = new Map(molecule.atoms.map((atom, i) => [atom.id, i]));
  return evaluateLayoutQuality(molecule.atoms, molecule.bonds.map(bond => ({
    from: indices.get(bond.fromAtomId)!, to: indices.get(bond.toAtomId)!
  })), undefined, undefined, undefined, includeLabels ? moleculeLayoutLabelBoxes(molecule) : []);
}
