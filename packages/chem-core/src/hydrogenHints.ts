import { isDativeBond } from "./molfile";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

/** An imported H count describes the imported graph, not subsequent chemical edits. */
export function clearChangedAtomHydrogenHints(
  previous: Pick<MoleculeObject, "atoms" | "bonds">,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeAtom[] {
  const changed = new Set<string>();
  const oldBonds = new Map(previous.bonds.map((bond) => [bond.id, bond]));
  for (const bond of bonds) {
    const old = oldBonds.get(bond.id);
    oldBonds.delete(bond.id);
    const sameEndpoints = old && (
      (old.fromAtomId === bond.fromAtomId && old.toAtomId === bond.toAtomId) ||
      (old.fromAtomId === bond.toAtomId && old.toAtomId === bond.fromAtomId)
    );
    if (!old || !sameEndpoints ||
      old.order !== bond.order || isDativeBond(old) !== isDativeBond(bond)) {
      changed.add(bond.fromAtomId);
      changed.add(bond.toAtomId);
      if (old) { changed.add(old.fromAtomId); changed.add(old.toAtomId); }
    }
  }
  for (const bond of oldBonds.values()) {
    changed.add(bond.fromAtomId);
    changed.add(bond.toAtomId);
  }
  const oldAtoms = new Map(previous.atoms.map((atom) => [atom.id, atom]));
  return atoms.map((atom) => {
    const old = oldAtoms.get(atom.id);
    if (atom.hydrogenCount === undefined || !old ||
      (!changed.has(atom.id) && atom.element === old.element && atom.formalCharge === old.formalCharge)) return atom;
    const { hydrogenCount: _importedCount, ...unhinted } = atom;
    return unhinted;
  });
}
