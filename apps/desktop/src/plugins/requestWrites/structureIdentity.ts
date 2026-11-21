import type { MoleculeObject } from "@chemdraft/chem-core";
import { assertMoleculeMatchesSmiles, chemicalIdentitySource, type ChemicalIdentityFacts } from "@chemdraft/document-workflow-core";
import { inspectStructureOffThread } from "../../depiction2d/identityClient";

export type StereoTags = { CIP_atoms?: [number, string][]; CIP_bonds?: [number, number, string][] };

export type StructureInspection =
  | { valid: true; canonicalSmiles: string; identitySmiles: string; identityFacts?: ChemicalIdentityFacts;
      formula: string; heavyAtoms: number; warnings: string[];
      orderedIdentity?: string; stereoTags?: StereoTags; hasStoredGroups?: boolean;
      stereochemistry?: string[]; formalCharge?: number;
      topology?: { atomCount: number; bonds: [number, number][]; rings: number[][] } }
  | { valid: false; reason: string; code?: "limit" | "unavailable" | "unsupported" };

export interface StructureInspectionContext {
  chemistry: {
    inspectStructure(format: "smiles" | "molfile", value: string, stereoReference?: string): Promise<StructureInspection>;
  };
}

export function desktopWriteInspectionContext(signal?: AbortSignal): StructureInspectionContext {
  return { chemistry: { inspectStructure: (format, value, stereo) =>
    inspectStructureOffThread(format, value, stereo, signal, "writeIdentity") } };
}

export async function inspectSmiles(context: StructureInspectionContext, smiles: string) {
  const result = await context.chemistry.inspectStructure("smiles", smiles);
  if (!result.valid) throw new Error(result.reason);
  if (!Number.isInteger(result.heavyAtoms) || result.heavyAtoms < 0 || result.heavyAtoms > 500) {
    throw new Error(`Structure exceeds the 500 heavy atom limit (${result.heavyAtoms}).`);
  }
  if (!result.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  return result;
}
export async function inspectMolecule(context: StructureInspectionContext, molecule: MoleculeObject) {
  const warnings: string[] = [];
  const { molfile, molecule: serialized } = chemicalIdentitySource(molecule, warnings, "v2000");
  if (warnings.length) throw new Error(warnings.join(" "));
  const result = await context.chemistry.inspectStructure("molfile", molfile);
  if (!result.valid) throw new Error(result.reason);
  if (!result.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  return { ...result, molfile, atomIds: serialized.atoms.map(atom => atom.id) };
}
export async function assertCanonical(
  context: StructureInspectionContext, molecule: MoleculeObject, input: string
) {
  await assertMoleculeMatchesSmiles(molecule, input, async (format, value, stereoReference) => {
    const result = format === "smiles" ? await inspectSmiles(context, value)
      : await context.chemistry.inspectStructure(format, value, stereoReference);
    return result.valid
      ? { valid: true, canonicalSmiles: result.identitySmiles, facts: result.identityFacts } : result;
  });
}
