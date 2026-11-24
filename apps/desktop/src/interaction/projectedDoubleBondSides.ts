import type { MoleculeObject } from "@chemdraft/chem-core";
import { doubleBondRendersSymmetric, isDefaultCenteredDoubleBond, reconcileRingDoubleBondSides,
  ringInteriorDoubleBondSides, smallestRingAtomIdsByBondId } from "@chemdraft/layout-engine";
import { defaultDoubleBondSide } from "@chemdraft/document-workflow-core";

/** Store the same offsets for the live projection and the flattened drawing. */
export function projectedDoubleBondSides(molecule: MoleculeObject, before = molecule): MoleculeObject["bonds"] {
  const rings = smallestRingAtomIdsByBondId(molecule);
  const ringSides = ringInteriorDoubleBondSides(molecule, rings);
  const atoms = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  return reconcileRingDoubleBondSides(before, molecule, rings).map((bond) => {
    if (bond.order !== "double" || bond.display?.doubleBondSide === "center") return bond;
    if (rings.has(bond.id)) {
      const inside = ringSides.get(bond.id);
      if (!inside || bond.display?.doubleBondSide !== undefined) return bond;
      return { ...bond, display: { ...bond.display, doubleBondSide: inside } };
    }
    // A user-selected side on a Center-default bond is a display choice, not a ring-interior hint.
    if (isDefaultCenteredDoubleBond(molecule, bond) &&
      (bond.display?.doubleBondSide === "left" || bond.display?.doubleBondSide === "right")) return bond;
    const from = atoms.get(bond.fromAtomId);
    const to = atoms.get(bond.toAtomId);
    const display = { ...bond.display };
    // Baking an explicit side would turn a symmetric straddle into a one-sided bond.
    if (from && to && doubleBondRendersSymmetric(from, to, molecule, bond, undefined)) {
      delete display.doubleBondSide;
    } else {
      display.doubleBondSide = defaultDoubleBondSide(molecule, bond);
    }
    return { ...bond, display: Object.keys(display).length ? display : undefined };
  });
}
