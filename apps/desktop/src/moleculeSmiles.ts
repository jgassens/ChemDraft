import { isDativeBond, moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { nativeMoleculeUnspellableLabels, nativeSingleBondGraphSmiles } from "./documentWorkflow";

type ComputeStructureIdentifiers = typeof import("@chemdraft/rdkit-adapter/identifiers").computeStructureIdentifiers;

export async function loadStructureIdentifiers(): Promise<ComputeStructureIdentifiers | undefined> {
  try {
    const { registerRdkitWasmLoader } = await import("./rdkitWasmLoader");
    registerRdkitWasmLoader();
    const { computeStructureIdentifiers } = await import("@chemdraft/rdkit-adapter/identifiers");
    return computeStructureIdentifiers;
  } catch {
    // Export remains available through the native writer, with stereo loss disclosed below.
    return undefined;
  }
}

export async function moleculeSmiles(
  molecule: MoleculeObject,
  index: number,
  warnings: ExportWarning[],
  computeStructureIdentifiers: ComputeStructureIdentifiers | undefined,
  molfile?: string
): Promise<string> {
  // Both the V2000 input to RDKit and the native fallback approximate these features.
  const dativeBondCount = molecule.bonds.filter(isDativeBond).length;
  if (dativeBondCount > 0) {
    warnings.push({
      code: "export.smiles_dative_bond",
      message: `SMILES has no dative/coordination bond: ${dativeBondCount} dashed bond(s) written as plain single.`,
      severity: "warning",
      objectId: molecule.id
    });
  }
  for (const label of nativeMoleculeUnspellableLabels(molecule)) {
    warnings.push({
      code: "export.smiles_atom_label",
      message: `Atom label "${label}" cannot be spelled as a single SMILES atom; written as a dummy atom [*].`,
      severity: "warning",
      objectId: molecule.id
    });
  }
  if (computeStructureIdentifiers) {
    try {
      const writerWarnings: string[] = [];
      const identifiers = await computeStructureIdentifiers(
        molfile ?? moleculeToMolfileV2000(molecule, { fromDocFrame: true, warnings: writerWarnings })
      );
      if (identifiers?.smiles) {
        // Only report these losses when the engine's molfile route supplied the output.
        // The native fallback can spell some condensed labels that V2000 cannot.
        warnings.push(...writerWarnings.map((message): ExportWarning => ({
          code: "export.smiles_v2000_loss",
          message,
          severity: "warning",
          objectId: molecule.id
        })));
        return identifiers.smiles;
      }
    } catch {
      // A failed engine load or parse falls back per molecule, without dropping its record.
    }
  }
  if (moleculeHasSmilesStereo(molecule)) {
    warnings.push({
      code: "export.smiles_stereo_dropped",
      message: `Stereochemistry could not be written to SMILES for molecule ${index + 1}; the structure engine was unavailable.`,
      severity: "warning",
      objectId: molecule.id
    });
  }
  if (molecule.structureFormat === "smiles" && molecule.structure) return molecule.structure;
  return nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds);
}

/** The native graph writer has neither tetrahedral nor double-bond stereo notation. */
function moleculeHasSmilesStereo(molecule: MoleculeObject): boolean {
  const heavyAtomIds = new Set(molecule.atoms
    .filter((atom) => !["H", "D", "T"].includes(atom.element))
    .map((atom) => atom.id));
  const hasOtherHeavyNeighbor = (atomId: string, otherEndId: string): boolean =>
    molecule.bonds.some((bond) => !isDativeBond(bond) && (
      (bond.fromAtomId === atomId && bond.toAtomId !== otherEndId && heavyAtomIds.has(bond.toAtomId)) ||
      (bond.toAtomId === atomId && bond.fromAtomId !== otherEndId && heavyAtomIds.has(bond.fromAtomId))
    ));
  return molecule.bonds.some((bond) =>
    bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed" ||
    (bond.order === "double" &&
      hasOtherHeavyNeighbor(bond.fromAtomId, bond.toAtomId) &&
      hasOtherHeavyNeighbor(bond.toAtomId, bond.fromAtomId))
  );
}
