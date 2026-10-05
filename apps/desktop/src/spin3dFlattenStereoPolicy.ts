import { UnknownBondOrderError, type MoleculeObject } from "@chemdraft/chem-core";
import type { StereoPerceiver } from "./documentWorkflow";

/** Optional perception failures may fall back; unknown chemistry must refuse rotation. */
export function buildSpin3dFlattenStereoOptions(
  molecule: MoleculeObject,
  perceive: StereoPerceiver | undefined,
  perceptionMolfile: () => string
): { stereoCenterAtomIds?: ReadonlySet<string>; perceiveStereo?: StereoPerceiver } {
  // Refuse even before the optional perceiver has loaded.
  const unknownBondIds = molecule.bonds.filter((bond) => bond.order === "unknown").map((bond) => bond.id);
  if (unknownBondIds.length > 0) throw new UnknownBondOrderError(unknownBondIds);
  if (!perceive) return {};
  try {
    const molfile = perceptionMolfile();
    const perAtom = perceive(molfile);
    let stereoCenterAtomIds: ReadonlySet<string> | undefined;
    if (perAtom.length === molecule.atoms.length) {
      const ids = new Set<string>();
      molecule.atoms.forEach((atom, index) => {
        if (perAtom[index]?.isStereoCenter) ids.add(atom.id);
      });
      stereoCenterAtomIds = ids;
    }
    return { stereoCenterAtomIds, perceiveStereo: perceive };
  } catch (error) {
    if (error instanceof UnknownBondOrderError) throw error;
    return {};
  }
}
