import { inspectHydrogenNormalizedIdentity, unverifiableStereoReason } from "@chemdraft/document-workflow-core";
import { detectMolfileFormat, parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { compositionFromRdkitJson, rdkitHasIndeterminateBonds, stereochemistryLabels,
  type RdkitMinimalModule, type RdkitJson } from "@chemdraft/rdkit-adapter";
import { PluginRequestLimits } from "@chemdraft/plugin-api";
import type { StereoTags, StructureInspection } from "../plugins/requestWrites/structureIdentity";
import type { StructureInspectionDetails } from "./identityProtocol";

type InspectionMolecule = RdkitJson["molecules"][number] & {
  stereoGroups?: { type: string }[];
  substanceGroups?: { properties: { TYPE: string; LABEL?: string; MULT?: string } }[];
};

function hasUnexpectedWriteQueries(graph: RdkitJson, value: string, connectionPointAtomIndices?: readonly number[]): boolean {
  const points = connectionPointAtomIndices && new Set(connectionPointAtomIndices);
  if (points) {
    const atoms = graph.molecules[0]?.atoms;
    const atomicNumber = (atom: NonNullable<typeof atoms>[number]) => atom.z ?? graph.defaults?.atom?.z ?? 6;
    if (graph.molecules.length !== 1 || !atoms || [...points].some(index => !atoms[index]) ||
        atoms.some((atom, index) => (atomicNumber(atom) === 0) !== points.has(index))) return true;
    // Other CTAB pseudoatoms may also arrive as atomic number zero after sanitization.
    const ctab = parseMolfileGraph(value);
    if ([...points].some(index => ctab.atoms[index]?.element !== "*")) return true;
  }
  return graph.molecules.some(mol => (mol.extensions ?? []).some(extension => {
    if (typeof extension !== "object" || extension === null || !("name" in extension) || extension.name !== "rdkitQueries") return false;
    if (!points || "bondQueries" in extension || !("atomQueries" in extension) || !Array.isArray(extension.atomQueries)) return true;
    // RDKit represents a literal CTAB * as an AtomNull query. Only accept that exact query
    // at a position where the drawn graph has an X. Substituent, atom-list and bond queries fail.
    return extension.atomQueries.some((query, index) => {
      if (!query || typeof query !== "object" || Array.isArray(query)) return true;
      const keys = Object.keys(query);
      return keys.length > 0 && !(points.has(index) && keys.length === 2 && query.descr === "AtomNull" && query.tag === 40);
    });
  }));
}

function substanceGroupRefusal(molecules: readonly InspectionMolecule[]): string | undefined {
  for (const molecule of molecules) {
    for (const { properties: { TYPE, LABEL, MULT } } of molecule.substanceGroups ?? []) {
      // Data, generic brackets, and expanded superatoms annotate the existing graph.
      if (TYPE === "DAT" || TYPE === "GEN" || TYPE === "SUP") continue;
      const description = TYPE === "SRU"
        ? `a repeat unit ${LABEL ?? "n"}; polymer formula not computed`
        : TYPE === "MUL" ? `a multiple group x${MULT ?? "?"}`
          : TYPE === "COP" ? "a copolymer group; polymer formula not computed" : `a substance group (${TYPE})`;
      return `The structure contains ${description}; values and molecular graph exports are for one drawn copy only.`;
    }
  }
}

/** Worker-only inspection. The comparison itself belongs to document-workflow-core. */
export function inspectStructureInWorker(
  module: Pick<RdkitMinimalModule, "get_mol">, value: string, stereoReference?: string, details?: StructureInspectionDetails
): StructureInspection {
  if (typeof details === "object" && !detectMolfileFormat(value)) {
    return { valid: false, code: "unsupported", reason: "Connection-point verification requires a molfile." };
  }
  const writeIdentity = details === "writeIdentity" || typeof details === "object";
  const identity = !details || writeIdentity ? inspectHydrogenNormalizedIdentity(module, value, stereoReference) : undefined;
  if (identity?.valid === false) return identity;
  const molecule = module.get_mol(value, JSON.stringify({ removeHs: false }));
  if (!molecule) return { valid: false, reason: "RDKit could not parse the structure." };
  try {
    if (!molecule.get_json || !molecule.get_smiles) {
      if (!details) throw new Error("RDKit structure inspection is unavailable.");
      return { valid: false, code: "unavailable", reason: "RDKit structure inspection is unavailable." };
    }
    const graph: Omit<RdkitJson, "molecules"> & { molecules: InspectionMolecule[] } = JSON.parse(molecule.get_json());
    const heavyAtoms = graph.molecules.reduce((count, mol) => count + mol.atoms.filter(atom => {
      const element = atom.z ?? graph.defaults?.atom?.z ?? 6;
      // The legacy verifier includes placeholders in its bound.
      return details ? element > 1 : element !== 1;
    }).length, 0);
    const atomCount = graph.molecules.reduce((count, mol) => count + mol.atoms.length, 0);
    const bondCount = graph.molecules.reduce((count, mol) => count + mol.bonds.length, 0);
    if (details && (heavyAtoms > PluginRequestLimits.heavyAtoms || atomCount > PluginRequestLimits.atomsPerMolecule ||
        bondCount > PluginRequestLimits.bondsPerMolecule)) {
      return { valid: false, code: "limit", reason: `Structure exceeds inspection limits (${heavyAtoms} heavy atoms, ${atomCount} atoms, ${bondCount} bonds).` };
    }
    if (details === "stereochemistry") {
      const groupRefusal = substanceGroupRefusal(graph.molecules);
      if (groupRefusal) return { valid: false, code: "unsupported", reason: groupRefusal };
      const refusal = unverifiableStereoReason(module, value);
      if (refusal) return { valid: false, reason: refusal };
      if (rdkitHasIndeterminateBonds(graph)) return { valid: false, reason: "The structure has an indeterminate bond order." };
      const groups = graph.molecules.flatMap(mol => mol.stereoGroups ?? []);
      if (groups.some(group => group.type !== "abs")) {
        return { valid: false, reason: "Canonical isomeric SMILES cannot preserve relative stereochemistry groups." };
      }
    }
    const canonicalSmiles = molecule.get_smiles();
    if (!canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
    const composition = compositionFromRdkitJson(graph);
    const result: Extract<StructureInspection, { valid: true }> = {
      valid: true, canonicalSmiles, identitySmiles: identity?.canonicalSmiles ?? canonicalSmiles,
      identityFacts: identity?.facts, formula: composition.formula, heavyAtoms,
      warnings: details === "stereochemistry" && composition.presentElements.includes("*")
        ? ["The formula contains a placeholder (*) with unspecified elemental composition."] : []
    };
    const withStereo = molecule as typeof molecule & { get_stereo_tags?: () => string };
    if (writeIdentity) {
      if (rdkitHasIndeterminateBonds(graph) || hasUnexpectedWriteQueries(graph, value,
        typeof details === "object" ? details.connectionPointAtomIndices : undefined)) {
        return { valid: false, code: "unsupported", reason: "The write cannot verify query atoms or indeterminate bonds." };
      }
      if (!withStereo.get_stereo_tags) return { valid: false, code: "unavailable", reason: "RDKit stereo inspection is unavailable." };
      const tags = withStereo.get_stereo_tags();
      result.stereoTags = JSON.parse(tags) as StereoTags;
      result.stereochemistry = stereochemistryLabels(tags, 0);
      result.formalCharge = composition.formalCharge;
      // Native CTAB order is stable across placements. Keep RDKit's atom-local charges,
      // isotopes, radical electrons and stereo, and its bond stereo and group memberships.
      // Canonical isomeric SMILES alone can hide a swap between symmetry-related sites.
      result.orderedIdentity = JSON.stringify([graph.defaults, graph.molecules.map(mol =>
        [mol.atoms, mol.bonds, mol.stereoGroups, mol.substanceGroups])]);
      result.hasStoredGroups = graph.molecules.some(mol => mol.stereoGroups?.length || mol.substanceGroups?.length);
    }
    if (details === "stereochemistry") {
      if (!withStereo.get_stereo_tags) return { valid: false, code: "unavailable", reason: "RDKit stereo inspection is unavailable." };
      const tags = withStereo.get_stereo_tags();
      const cip = JSON.parse(tags) as StereoTags;
      const unassigned = (cip.CIP_atoms ?? []).filter(([, descriptor]) => descriptor === "(?)").length +
        (cip.CIP_bonds ?? []).filter(([, , descriptor]) => descriptor === "(?)").length;
      result.stereochemistry = stereochemistryLabels(tags, unassigned);
    } else if (details === "topology") {
      const mol = graph.molecules[0];
      if (!mol || graph.molecules.length !== 1) return { valid: false, reason: "RDKit did not return one CTAB graph." };
      const extension = (mol.extensions as { name?: string; atomRings?: number[][] }[] | undefined)
        ?.find(entry => entry.name === "rdkitRepresentation");
      if (!extension) return { valid: false, code: "unavailable", reason: "RDKit ring membership is unavailable." };
      const rings = extension.atomRings ?? [];
      if (rings.length > PluginRequestLimits.heavyAtoms) {
        return { valid: false, code: "limit", reason: "The structure has too many chemical rings." };
      }
      result.topology = { atomCount, bonds: mol.bonds.map(bond => bond.atoms), rings };
    }
    return result;
  } finally { molecule.delete(); }
}
