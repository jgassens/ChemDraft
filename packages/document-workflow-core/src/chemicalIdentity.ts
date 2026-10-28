import type { MoleculeObject } from "@chemdraft/chem-core";
import type { RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import { stereoPerceptionMolfile } from "./molecule";

export type InspectChemicalIdentity = (format: "smiles" | "molfile", value: string) => Promise<
  { valid: true; canonicalSmiles: string } | { valid: false; reason: string }
>;

/** Remove ordinary explicit H equally on both sides; RDKit retains isotope-labelled hydrogens. */
export function inspectHydrogenNormalizedIdentity(
  module: Pick<RdkitMinimalModule, "get_mol">, value: string
): Awaited<ReturnType<InspectChemicalIdentity>> {
  const molecule = module.get_mol(value, JSON.stringify({ removeHs: true }));
  if (!molecule) return { valid: false, reason: "RDKit could not verify the structure." };
  try {
    const canonicalSmiles = molecule.get_smiles?.();
    if (!canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
    return { valid: true, canonicalSmiles };
  } finally { molecule.delete(); }
}

export class ChemicalIdentityMismatchError extends Error {
  constructor(moleculeId: string) {
    super(`Canonical SMILES mismatch for ${moleculeId}; refusing a change to chemical identity ` +
      "(including radical or isotope loss).");
    this.name = "ChemicalIdentityMismatchError";
  }
}

/** Verify the actual native graph, including stereo and isotope positions, with the caller's engine. */
export async function assertMoleculeMatchesSmiles(
  molecule: MoleculeObject,
  input: string,
  inspect: InspectChemicalIdentity
): Promise<void> {
  const source = await inspect("smiles", input);
  if (!source.valid) throw new Error(source.reason);
  if (!source.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  const warnings: string[] = [];
  const molfile = stereoPerceptionMolfile(molecule, warnings);
  if (warnings.length) throw new Error(warnings.join(" "));
  const output = await inspect("molfile", molfile);
  if (!output.valid) throw new Error(output.reason);
  if (!output.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  if (source.canonicalSmiles !== output.canonicalSmiles) {
    throw new ChemicalIdentityMismatchError(molecule.id);
  }
}
