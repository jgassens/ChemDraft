import { inspectHydrogenNormalizedIdentity } from "@chemdraft/document-workflow-core";
import { compositionFromRdkitJson, type RdkitMinimalModule, type RdkitJson } from "@chemdraft/rdkit-adapter";
import type { AssistantStructureInspection } from "../assistant/AssistantToolContext";

/** Worker-only inspection. The comparison itself belongs to document-workflow-core. */
export function inspectStructureInWorker(
  module: Pick<RdkitMinimalModule, "get_mol">, value: string, stereoReference?: string
): AssistantStructureInspection {
  const identity = inspectHydrogenNormalizedIdentity(module, value, stereoReference);
  if (!identity.valid) return identity;
  const molecule = module.get_mol(value, JSON.stringify({ removeHs: false }));
  if (!molecule) return { valid: false, reason: "RDKit could not parse the structure." };
  try {
    const canonicalSmiles = molecule.get_smiles?.();
    if (!molecule.get_json || !canonicalSmiles) throw new Error("RDKit structure inspection is unavailable.");
    const graph: RdkitJson = JSON.parse(molecule.get_json());
    const composition = compositionFromRdkitJson(graph);
    return { valid: true, canonicalSmiles, identitySmiles: identity.canonicalSmiles,
      identityFacts: identity.facts, formula: composition.formula, warnings: [],
      heavyAtoms: graph.molecules.reduce((count, mol) => count + mol.atoms.filter(atom =>
        (atom.z ?? graph.defaults?.atom?.z ?? 6) !== 1).length, 0) };
  } finally { molecule.delete(); }
}
