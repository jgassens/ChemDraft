import { medianLength } from "./pageScale";

/** Measure the entire CTAB, including disconnected components, without mutation.
 * fallbackBondLength is explicit and in input units, also covering zero-length bonds.
 */
export function molfileCoordinateScale(
  atoms: readonly { id: string; x: number; y: number }[],
  bonds: readonly { fromAtomId: string; toAtomId: string }[],
  targetBondLength: number,
  fallbackBondLength: number
): { medianBondLength: number | undefined; scale: number } {
  if (![targetBondLength, fallbackBondLength].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("MOL coordinate scaling requires finite positive target and fallback bond lengths.");
  }
  for (const atom of atoms) {
    if (!Number.isFinite(atom.x) || !Number.isFinite(atom.y)) {
      throw new Error(`MOL coordinate scaling failed: atom ${atom.id} has non-finite coordinates.`);
    }
  }
  const atomById = new Map(atoms.map(atom => [atom.id, atom]));
  const medianBondLength = medianLength(bonds.flatMap(bond => {
    const from = atomById.get(bond.fromAtomId), to = atomById.get(bond.toAtomId);
    const length = from && to ? Math.hypot(from.x - to.x, from.y - to.y) : 0;
    return Number.isFinite(length) && length > 0 ? [length] : [];
  }));
  const scale = targetBondLength / (medianBondLength ?? fallbackBondLength);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("MOL coordinate scale is not finite and positive.");
  return { medianBondLength, scale };
}
