import type { MoleculeObject } from "@chemdraft/chem-core";
import { doubleBondRendersSymmetric, isAcyclicCarbonHeteroatomDoubleBond, ringInteriorDoubleBondSides } from "@chemdraft/layout-engine";
import { defaultDoubleBondSide } from "@chemdraft/document-workflow-core";

/** Recompute double-bond sides after projection, preserving explicit Center. */
export function projectedDoubleBondSides(molecule: MoleculeObject): MoleculeObject["bonds"] {
  const ringSides = ringInteriorDoubleBondSides(molecule);
  const atoms = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  return molecule.bonds.map((bond) => {
    if (bond.order !== "double" || bond.display?.doubleBondSide === "center") return bond;
    // A user-selected side on an acyclic C=X is a display choice, not a ring-interior hint.
    if (isAcyclicCarbonHeteroatomDoubleBond(molecule, bond) &&
      (bond.display?.doubleBondSide === "left" || bond.display?.doubleBondSide === "right")) return bond;
    const from = atoms.get(bond.fromAtomId);
    const to = atoms.get(bond.toAtomId);
    const display = { ...bond.display };
    // Baking an explicit side would turn a symmetric straddle into a one-sided bond.
    if (from && to && doubleBondRendersSymmetric(from, to, molecule, bond, ringSides.get(bond.id))) {
      delete display.doubleBondSide;
    } else {
      display.doubleBondSide = defaultDoubleBondSide(molecule, bond);
    }
    return { ...bond, display };
  });
}
