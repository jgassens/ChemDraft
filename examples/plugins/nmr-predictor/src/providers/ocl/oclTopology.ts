import type * as OCL from "openchemlib";

/** Small shared OCL topology queries used by both bounded rule estimators. */
export function maxBondOrderTo(molecule: OCL.Molecule, atom: number, element: number): number {
  let max = 0;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getAtomicNo(molecule.getConnAtom(atom, i)) === element) {
      max = Math.max(max, molecule.getBondOrder(molecule.getConnBond(atom, i)));
    }
  }
  return max;
}

export function countBondedTo(molecule: OCL.Molecule, atom: number, element: number): number {
  let count = 0;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getAtomicNo(molecule.getConnAtom(atom, i)) === element) count += 1;
  }
  return count;
}

export function isCarbonyl(molecule: OCL.Molecule, atom: number): boolean {
  return molecule.getAtomicNo(atom) === 6 && maxBondOrderTo(molecule, atom, 8) === 2;
}

export function isAldehyde(molecule: OCL.Molecule, atom: number): boolean {
  return isCarbonyl(molecule, atom) && molecule.getAllHydrogens(atom) === 1;
}

/** Whether every atom in the connected aromatic bond system containing `start` is carbon. Checking
 * the whole component (rather than one smallest ring) catches fused heteroarenes such as quinoline. */
export function aromaticComponentIsCarbocyclic(molecule: OCL.Molecule, start: number): boolean {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const atom = queue.shift() as number;
    if (molecule.getAtomicNo(atom) !== 6) return false;
    for (let index = 0; index < molecule.getConnAtoms(atom); index += 1) {
      const bond = molecule.getConnBond(atom, index);
      const neighbor = molecule.getConnAtom(atom, index);
      if (!molecule.isAromaticBond(bond) || seen.has(neighbor)) continue;
      seen.add(neighbor);
      queue.push(neighbor);
    }
  }
  return true;
}
