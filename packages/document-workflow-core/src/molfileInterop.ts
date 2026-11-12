import {
  moleculeToMolfileV2000, moleculeToMolfileV3000,
  type MoleculeObject, type MolfileWriteOptions, type MolfileWriteResult
} from "@chemdraft/chem-core";
import { molfileCoordinateScale } from "@chemdraft/layout-engine";

/** External 2D MOL/SDF units. Call after label expansion, once per complete CTAB.
 * Supply the source nominal bond length for bondless/degenerate records.
 * Internal and stored molfiles continue to use the raw native writers directly.
 */
export function moleculeToInteropMolfile(
  molecule: MoleculeObject,
  flavor: "v2000" | "v3000",
  nominalBondLength: number,
  options: Omit<MolfileWriteOptions, "coordinateScale">
): MolfileWriteResult {
  const { scale } = molfileCoordinateScale(molecule.atoms, molecule.bonds, 1.5, nominalBondLength);
  const write = flavor === "v2000" ? moleculeToMolfileV2000 : moleculeToMolfileV3000;
  return write(molecule, { ...options, coordinateScale: scale });
}
