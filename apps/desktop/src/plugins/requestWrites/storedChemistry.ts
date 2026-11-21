import { clearStoredCtabReference, storedCtabReference } from "@chemdraft/plugin-host";
import type { Anchor, MoleculeObject } from "@chemdraft/chem-core";
import { chemicalIdentitySource, moleculeSmiles, nativeSingleBondGraphMetadata } from "@chemdraft/document-workflow-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { nativeElementFromAtomLabel, nativeEnhancedStereoAtomIndicators } from "@chemdraft/layout-engine";
import { refreshNativeSingleBondGraph } from "../../documentWorkflow";
import { validateInspectionSource } from "../depiction/structureInspection";
import { inspectMolecule, inspectSmiles, type StructureInspectionContext } from "./structureIdentity";
import { ChemistryRefusal } from "./chemistryRefusal";
import { assertStoredCtabStereo, verifyWrittenBonds } from "./storedStereo";

export const stableRecord = (record: unknown) =>
  JSON.stringify(record, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const attachmentIdentity = <T extends { attachmentPoints: Anchor[] }>({ attachmentPoints, ...group }: T) =>
  ({ ...group, attachmentPoints: attachmentPoints.map(({ point, ...anchor }) => anchor) });
export const withoutGeometry = ({ x, y, width, height, style, rotation, transform, atoms, bonds, superatoms, rGroups,
  ...record }: MoleculeObject) => ({
  ...record, atoms: atoms.map(({ x, y, labelOffset, labelVisible, warningSuppressed, ...atom }) => atom),
  bonds: bonds.map(({ display, ...bond }) => ({ ...bond, bondStyle: display?.bondStyle === "bold" ? undefined : display?.bondStyle })),
  superatoms: superatoms.map(attachmentIdentity), rGroups: rGroups.map(attachmentIdentity)
});

const abbreviationRecords = (molecule: MoleculeObject) => {
  const { atoms, superatoms, rGroups } = withoutGeometry(molecule);
  return stableRecord({ superatoms, rGroups, atoms: atoms.filter(atom =>
    atom.schemeAbbreviation || atom.labelLiteral || !nativeElementFromAtomLabel(atom.element))
    .map(({ id, element, labelLiteral, schemeAbbreviation, labelBondSide }) =>
      ({ id, element, labelLiteral, schemeAbbreviation, labelBondSide })) });
};
const retainedCompatibility = (molecule: MoleculeObject) => {
  if (!molecule.compatibility) return undefined;
  const { smiles, ...unknown } = molecule.compatibility.unknown;
  return stableRecord({ ...molecule.compatibility, unknown });
};

function hasExtraCtabFields(structure: string, format: "molfile-v2000" | "molfile-v3000") {
  const lines = structure.split(/\r?\n/);
  if (format === "molfile-v2000") {
    const counts = lines[3]!;
    const afterBonds = 4 + Number(counts.slice(0, 3)) + Number(counts.slice(3, 6));
    // Alias lines, M RAD (including its spin multiplicity), S-groups and unknown records
    // have no lossless representation in the verifier's graph writer.
    return lines.slice(afterBonds).some(line => line.trim() && !/^M  (?:CHG|ISO|END)\b/.test(line));
  }
  const supportedAttributes = new Set(["CHG", "MASS", "CFG", "VAL"]);
  return lines.slice(4).some(line => {
    if (!line.trim() || /^M  END\s*$/.test(line) ||
        /^M  V30 (BEGIN|END) (CTAB|ATOM|BOND)\s*$/.test(line) || /^M  V30 COUNTS \d+ \d+ 0 0 [01]\s*$/.test(line)) return false;
    if (!/^M  V30 \d+\s/.test(line) || line.trimEnd().endsWith("-")) return true;
    return [...line.matchAll(/(\w+)=/g)].some(match => !supportedAttributes.has(match[1]!));
  });
}

const CLAIM_LABELS = { stereochemistry: "stereo", isotopeLabels: "isotope labels", radicalCount: "radical count",
  totalCharge: "charge", formula: "formula" } as const;

export async function inspectWriteSmiles(context: StructureInspectionContext, value: string) {
  validateInspectionSource({ format: "smiles", structure: value });
  if (value.includes("|")) throw new ChemistryRefusal("the structure carries extended SMILES annotations that can't be checked", "A graph edit cannot verify extended CXSMILES annotations.");
  return inspectSmiles(context, value);
}

/** A retained source has already been compared verbatim, including atom order and group
 * records. Replacing it additionally requires the graph to account for all of its chemistry. */
export async function verifyStoredSources(context: StructureInspectionContext, molecule: MoleculeObject,
  options: { replacementIdentity?: string; graph?: Awaited<ReturnType<typeof inspectMolecule>>; alreadyVerified?: MoleculeObject;
    reference?: MoleculeObject } = {}) {
  const { graph, alreadyVerified, reference } = options;
  const replacementIdentity = graph?.identitySmiles ?? options.replacementIdentity;
  const { structure, structureFormat } = molecule;
  if (replacementIdentity !== undefined && nativeEnhancedStereoAtomIndicators(molecule).length) {
    throw new ChemistryRefusal("its stereo annotations can't be matched to the drawn structure", `The stored annotations of "${molecule.id}" cannot be verified by a plain SMILES chemical edit.`);
  }
  const check = async (format: Exclude<MoleculeObject["structureFormat"], "unknown">, value: string) => {
    validateInspectionSource({ format, structure: value });
    if (replacementIdentity !== undefined && (format === "smiles" ? value.includes("|") : hasExtraCtabFields(value, format))) {
      throw new ChemistryRefusal("the stored structure carries annotations that can't be checked against the drawn atoms", `The stored ${format} of "${molecule.id}" contains annotations the graph writer cannot verify.`);
    }
    const result = await context.chemistry.inspectStructure(format === "smiles" ? "smiles" : "molfile", value);
    if (!result.valid || !result.orderedIdentity ||
        replacementIdentity !== undefined && (result.hasStoredGroups !== false || result.identitySmiles !== replacementIdentity)) {
      throw new ChemistryRefusal("the stored structure doesn't match the drawn atoms", `The stored ${format} of "${molecule.id}" has chemistry the editable graph cannot verify.`);
    }
    if (format !== "smiles" && graph) {
      let referenceMolfile: string | undefined;
      if (reference && reference !== molecule) {
        const serialized = chemicalIdentitySource(reference, [], "v2000");
        if (stableRecord(serialized.molecule.atoms.map(atom => atom.id)) !== stableRecord(graph.atomIds)) {
          throw new ChemistryRefusal("its stereo annotations can't be matched to the drawn structure", "Cannot map the retained stereo coordinates to the editable graph.");
        }
        referenceMolfile = serialized.molfile;
      }
      // The identity check above already required the stored source to read as the graph does.
      assertStoredCtabStereo(value, result.stereoTags, graph, molecule, referenceMolfile, graph.identitySmiles);
    }
  };
  if (structure && !(alreadyVerified?.structureFormat === structureFormat && alreadyVerified.structure === structure)) {
    if (structureFormat === "unknown") throw new ChemistryRefusal("the stored structure's format isn't recognized", `Cannot verify the stored structure format of "${molecule.id}".`);
    await check(structureFormat, structure);
  }
  const cached = molecule.compatibility?.unknown.smiles;
  if (cached !== undefined && cached !== alreadyVerified?.compatibility?.unknown.smiles &&
      !(structureFormat === "smiles" && cached === structure)) {
    if (typeof cached !== "string") throw new ChemistryRefusal("the stored SMILES can't be checked against the drawn atoms", `Cannot verify the cached SMILES of "${molecule.id}".`);
    await check("smiles", cached);
  }
}

/** Superatoms, R-groups and retained compatibility records (other than the cached SMILES) have
 * no counterpart the editable graph can verify, so a write may keep them but never change them. */
export function assertRetainedAnnotationsKept(original: MoleculeObject, molecule: MoleculeObject) {
  if (abbreviationRecords(original) !== abbreviationRecords(molecule) ||
      retainedCompatibility(original) !== retainedCompatibility(molecule)) {
    throw new ChemistryRefusal("it would change an abbreviation or R-group that can't be checked", `The chemical edit cannot verify changes to retained annotations or abbreviations of "${molecule.id}".`);
  }
}

/** A chemistry record the write supplied must state what the graph-derived record states. */
export function assertChemistryClaims(molecule: MoleculeObject, original: MoleculeObject | undefined, record: MoleculeObject) {
  if (!molecule.chemistry || stableRecord(molecule.chemistry) === stableRecord(original?.chemistry)) return;
  for (const key of ["stereochemistry", "isotopeLabels", "radicalCount", "totalCharge", "formula"] as const) {
    const claim = molecule.chemistry[key];
    if (claim !== undefined && (key !== "stereochemistry" || molecule.chemistry.stereochemistry.length > 0) &&
        stableRecord(claim) !== stableRecord(record.chemistry![key])) {
      throw new ChemistryRefusal(`the ${CLAIM_LABELS[key]} doesn't match the drawn structure`, `The stored ${key} of "${molecule.id}" differs from the verified chemical edit.`);
    }
  }
}

/** Only insertions and declared chemical edits reach this writer. Verify both the source
 * being replaced and the graph that will supply the new storage and export records. */
export async function verifiedChemicalRecord(context: StructureInspectionContext, molecule: MoleculeObject,
  graph: Awaited<ReturnType<typeof inspectMolecule>>, previous?: { molecule: MoleculeObject; graph: Awaited<ReturnType<typeof inspectMolecule>> }
): Promise<MoleculeObject> {
  const id = molecule.id;
  if (previous) {
    const original = previous.molecule;
    await verifyStoredSources(context, original, { graph: previous.graph, reference: storedCtabReference(original) });
    assertRetainedAnnotationsKept(original, molecule);
    if (original.chemistry) {
      const native = nativeSingleBondGraphMetadata(original.atoms, original.bonds);
      if (original.chemistry.stereochemistry.length) native.stereochemistry = previous.graph.stereochemistry ?? [];
      if (Object.entries(original.chemistry).some(([key, value]) => stableRecord(value) !== stableRecord(native[key as keyof typeof native]))) {
        throw new ChemistryRefusal("the stored chemistry details don't match the drawn atoms", `The stored chemistry metadata of "${id}" cannot be verified from its native graph.`);
      }
    }
  }
  await verifyStoredSources(context, molecule, { graph, alreadyVerified: previous?.molecule });
  const record = refreshVerifiedMoleculeChemistry(molecule, graph, previous?.molecule.structureFormat);
  assertChemistryClaims(molecule, previous?.molecule, record);
  if (record.structureFormat === "molfile-v3000") {
    await verifyStoredSources(context, record, { graph });
  }
  // Exercise the actual export serializer, including its independent stored-SMILES fallback.
  // The engine path uses the same off-thread inspector as verification.
  const inspectMolfile = async (value: string) => {
    const inspected = await context.chemistry.inspectStructure("molfile", value);
    if (!inspected.valid) throw new Error(inspected.reason);
    return { smiles: inspected.canonicalSmiles };
  };
  const engineExport = await moleculeSmiles(record, 0, [], inspectMolfile);
  if ((await inspectSmiles(context, engineExport)).identitySmiles !== graph.identitySmiles) {
    throw new ChemistryRefusal("exporting it as SMILES would change the structure", `The exported SMILES would change the chemistry of "${id}".`);
  }
  const fallbackWarnings: ExportWarning[] = [];
  const fallback = await moleculeSmiles(record, 0, fallbackWarnings, undefined);
  const fallbackIdentity = (await inspectSmiles(context, fallback)).identitySmiles;
  // The native fallback can omit stereo. RDKit already verified the isomeric storage and engine export.
  // Still require the fallback to preserve all other chemistry and reject conflicting stereo.
  if (fallbackIdentity !== graph.identitySmiles &&
      !(fallbackWarnings.some(warning => warning.code === "export.smiles_stereo_dropped") &&
        graph.stereochemistry?.length && fallbackIdentity === graph.identityFacts?.withoutStereo)) {
    throw new ChemistryRefusal("exporting it as SMILES would change the structure", `The exported SMILES would change the chemistry of "${id}".`);
  }

  return record;
}

/** Refresh metadata through the canvas edit path and store the isomeric identity RDKit read. */
export function refreshVerifiedMoleculeChemistry(molecule: MoleculeObject, graph: Awaited<ReturnType<typeof inspectMolecule>>,
  previousFormat?: MoleculeObject["structureFormat"]): MoleculeObject {
  verifyWrittenBonds(molecule, graph);
  const { id } = molecule;
  const { chemistry } = refreshNativeSingleBondGraph(molecule, molecule.atoms, molecule.bonds);
  if (!chemistry || chemistry.formula !== graph.formula) {
    throw new ChemistryRefusal("the formula doesn't match the drawn atoms", `The native formula of "${id}" differs from the normalized graph's formula.`);
  }
  if (graph.formalCharge !== undefined && chemistry.totalCharge !== graph.formalCharge) {
    throw new ChemistryRefusal("the charge doesn't match the drawn atoms", `The native charge of "${id}" differs from the normalized graph's charge.`);
  }
  const explicitUnknown = molecule.bonds.some(bond => bond.stereo === "either" || bond.display?.bondStyle === "wavy");
  // Keep source CTAB stereo on its atom/bond, including annotations plain SMILES cannot store.
  const format = molecule.structureFormat.startsWith("molfile-") ? molecule.structureFormat :
    previousFormat?.startsWith("molfile-") ? previousFormat : explicitUnknown ? "molfile-v2000" : "smiles";
  const structure = format === "molfile-v3000" ? chemicalIdentitySource(molecule, [], "v3000").molfile :
    format === "molfile-v2000" ? graph.molfile : graph.identitySmiles;
  const compatibility = clearStoredCtabReference(molecule.compatibility);
  return { ...molecule, chemistry: { ...chemistry, stereochemistry: graph.stereochemistry ?? [] },
    structureFormat: format, structure,
    ...(compatibility && { compatibility: "smiles" in compatibility.unknown
      ? { ...compatibility, unknown: { ...compatibility.unknown, smiles: graph.identitySmiles } } : compatibility })
  };
}
