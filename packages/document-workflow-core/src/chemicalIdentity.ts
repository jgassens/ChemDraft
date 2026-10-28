import type { MoleculeObject } from "@chemdraft/chem-core";
import type { RdkitJsMol, RdkitMinimalModule } from "@chemdraft/rdkit-adapter";
import { stereoPerceptionMolfile } from "./molecule";
import { markV2000UnspecifiedDoubleBonds, sourceBondSemantics } from "./sourceBondSemantics";

/** With stereoReference, compare on that input's specified stereo; ignore additional output stereo. */
export type InspectChemicalIdentity = (
  format: "smiles" | "molfile", value: string, stereoReference?: string
) => Promise<
  { valid: true; canonicalSmiles: string } | { valid: false; reason: string }
>;

/** Remove ordinary explicit H equally on both sides; RDKit retains isotope-labelled hydrogens. */
export function inspectHydrogenNormalizedIdentity(
  module: Pick<RdkitMinimalModule, "get_mol">, value: string, stereoReference?: string
): Awaited<ReturnType<InspectChemicalIdentity>> {
  const molecule = module.get_mol(value, JSON.stringify({ removeHs: true }));
  if (!molecule) return { valid: false, reason: "RDKit could not verify the structure." };
  try {
    const canonicalSmiles = molecule.get_smiles?.();
    if (!canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
    return { valid: true, canonicalSmiles: stereoReference && canonicalSmiles !== stereoReference
      ? identityOnSpecifiedStereo(module, molecule, canonicalSmiles, stereoReference) : canonicalSmiles };
  } finally { molecule.delete(); }
}

/** Match whole graphs with RDKit, including every stereo element the source specifies. Neither
 * atom order nor bond order in a depiction is assumed to be the same as the source SMILES. */
function identityOnSpecifiedStereo(
  module: Pick<RdkitMinimalModule, "get_mol">, output: RdkitJsMol, actual: string, reference: string
): string {
  const withoutStereo = (smiles: string) => smiles.replace(/@+|[\\/]/g, "");
  const parse = (value: string) => module.get_mol(value, JSON.stringify({ removeHs: true }));
  const source = parse(reference);
  const sourcePlain = parse(withoutStereo(reference));
  const outputPlain = parse(withoutStereo(actual));
  try {
    // This equality requires atoms, H counts, radicals, isotopes, charges, connectivity and orders
    // to match exactly. Substructure matching alone would also accept proper subgraphs.
    if (!source || !sourcePlain || !outputPlain) throw new Error("RDKit could not verify the structure.");
    const sourceIdentity = sourcePlain.get_smiles?.(), outputIdentity = outputPlain.get_smiles?.();
    if (!sourceIdentity || !outputIdentity) throw new Error("RDKit did not return a canonical SMILES.");
    if (sourceIdentity !== outputIdentity) return actual;
    const matcher = output as RdkitJsMol & {
      get_substruct_matches?(query: RdkitJsMol, options: string): string;
    };
    if (!matcher.get_substruct_matches || !source.get_molblock || !output.get_molblock) {
      throw new Error("RDKit could not establish atom/bond correspondence for stereo verification.");
    }
    // Chirality-aware full-graph matches allow extra output stereo only where the source has none.
    // RDKit checks tetrahedral and E/Z stereo, and handles symmetry without an atom-order guess.
    const matches = JSON.parse(matcher.get_substruct_matches(source,
      JSON.stringify({ useChirality: true, maxMatches: 1 }))) as { atoms: number[]; bonds: number[] }[];
    const match = matches[0];
    if (!match) return actual;
    if (!Array.isArray(match.atoms) || !Array.isArray(match.bonds) ||
      [...match.atoms, ...match.bonds].some(index => !Number.isInteger(index) || index < 0)) {
      throw new Error("RDKit could not establish atom/bond correspondence for stereo verification.");
    }
    const semantics = sourceBondSemantics(source.get_molblock());
    const unspecified = new Set(semantics.unspecifiedDoubleBondIndices.map(index => {
      const mapped = match.bonds[index];
      if (!Number.isInteger(mapped)) {
        throw new Error("RDKit could not establish bond correspondence for unspecified E/Z.");
      }
      return mapped!;
    }));
    // Keep the same unknown-E/Z CTAB policy as the CLI, including native 'either' bonds.
    const masked = parse(markV2000UnspecifiedDoubleBonds(output.get_molblock(), unspecified));
    try {
      if (!masked) throw new Error("RDKit could not verify the stereo-masked structure.");
      const maskedMatcher = masked as typeof matcher;
      const verified = JSON.parse(maskedMatcher.get_substruct_matches!(source,
        JSON.stringify({ useChirality: true, maxMatches: 1 }))) as unknown[];
      // Extra tetrahedral stereo is also unspecified in the source and must not become a mismatch.
      return verified.length ? reference : actual;
    } finally { masked?.delete(); }
  } finally {
    source?.delete(); sourcePlain?.delete(); outputPlain?.delete();
  }
}

export class ChemicalIdentityMismatchError extends Error {
  readonly difference: string;

  constructor(moleculeId: string, source: string, output: string) {
    const tokens = (smiles: string, pattern: RegExp) =>
      [...smiles.matchAll(pattern)].map(match => match[0]).sort().join(",");
    const differs = (pattern: RegExp) => tokens(source, pattern) !== tokens(output, pattern);
    const differences = [
      differs(/\[\d+[A-Za-z]+/g) ? "isotope labels or their positions" : undefined,
      differs(/[+-]\d*/g) ? "charges" : undefined,
      differs(/@+|[\\/]/g) ? "stereochemistry" : undefined
    ].filter(Boolean);
    const difference = differences.join(", ") || "chemical identity";
    super(`Canonical SMILES mismatch for ${moleculeId}; refusing a change to chemical identity ` +
      `(${difference}): ${source} -> ${output}.`);
    this.name = "ChemicalIdentityMismatchError";
    this.difference = difference;
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
  const output = await inspect("molfile", molfile, source.canonicalSmiles);
  if (!output.valid) throw new Error(output.reason);
  if (!output.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  if (source.canonicalSmiles !== output.canonicalSmiles) {
    throw new ChemicalIdentityMismatchError(molecule.id, source.canonicalSmiles, output.canonicalSmiles);
  }
}
