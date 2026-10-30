import type { MoleculeObject } from "@chemdraft/chem-core";
import type { perceiveDoubleBondStereoFromMolfile } from "@chemdraft/ocl-adapter";

export type DoubleBondStereoReader = typeof perceiveDoubleBondStereoFromMolfile;

/** OCL owns stereogenicity, including equivalent ligands, rings and aromaticity.
 * Map endpoints through its parser's atom map (explicit Hs may be reordered),
 * rather than assuming that engine and native bond indices match. */
export function perceivedSpecifiedDoubleBondIds(
  molecule: MoleculeObject, molfile: string, reader: DoubleBondStereoReader
): ReadonlySet<string> {
  const perceived = reader(molfile);
  const indices = new Map(molecule.atoms.map((atom, index) => [atom.id, index]));
  return new Set(molecule.bonds.flatMap(bond => {
    if (bond.order !== "double" || bond.stereo === "either") return [];
    const from = indices.get(bond.fromAtomId), to = indices.get(bond.toAtomId);
    if (from === undefined || to === undefined) return [];
    return perceived.some(bond => (bond.from === from && bond.to === to) || (bond.from === to && bond.to === from))
      ? [bond.id] : [];
  }));
}

/** Ligand-relative 2D stereo, independent of CIP priorities and atom traversal. The same
 * ligand ids are used before/after projection; reflection flips both sides together.
 * This is a conservative geometry guard, not a second chemical stereo perceiver. */
export function doubleBondStereoState(molecule: MoleculeObject): Map<string, "either" | -1 | 0 | 1> {
  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  const neighbors = new Map<string, string[]>();
  for (const bond of molecule.bonds) {
    for (const [a, b] of [[bond.fromAtomId, bond.toAtomId], [bond.toAtomId, bond.fromAtomId]]) {
      const adjacent = neighbors.get(a) ?? [];
      adjacent.push(b);
      neighbors.set(a, adjacent);
    }
  }
  const states = new Map<string, "either" | -1 | 0 | 1>();
  for (const bond of molecule.bonds) {
    if (bond.order !== "double") continue;
    if (bond.stereo === "either") { states.set(bond.id, "either"); continue; }
    const a = atoms.get(bond.fromAtomId);
    const b = atoms.get(bond.toAtomId);
    if (!a || !b) continue;
    const left = (neighbors.get(a.id) ?? []).filter(id => id !== b.id).sort()[0];
    const right = (neighbors.get(b.id) ?? []).filter(id => id !== a.id).sort()[0];
    if (!left || !right) continue; // terminal double bond, including C=O
    const side = (id: string, origin: typeof a) => {
      const ligand = atoms.get(id);
      if (!ligand) return 0;
      const dx = b.x - a.x, dy = b.y - a.y;
      const lx = ligand.x - origin.x, ly = ligand.y - origin.y;
      const cross = (dx * ly - dy * lx) / (Math.hypot(dx, dy) * Math.hypot(lx, ly));
      return !Number.isFinite(cross) || Math.abs(cross) < 1e-5 ? 0 : Math.sign(cross);
    };
    states.set(bond.id, side(left, a) * side(right, b) as -1 | 0 | 1);
  }
  return states;
}
