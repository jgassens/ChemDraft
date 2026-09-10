import {
  moleculeToMolfileV2000,
  type ChemDraftDocument,
  type MoleculeObject,
  type MolfileWriteOptions
} from "@chemdraft/chem-core";
import { getExportFormatDescriptor, type ExportWarning, type TextExportResult } from "@chemdraft/export-engine";
import {
  copyAsScopeMolecules,
  nativeMoleculeUnspellableLabels,
  nativeSingleBondGraphSmiles
} from "./documentWorkflow";

/**
 * Read rows top to bottom, then their members left to right. Anchor each band at its
 * topmost centre so a chain of small offsets cannot merge distinct rows. Equal centres
 * still share a row when the median height is zero (e.g. horizontal bonds).
 */
export function readingOrderMolecules(molecules: readonly MoleculeObject[]): MoleculeObject[] {
  if (molecules.length === 0) return [];
  const heights = molecules.map((molecule) => molecule.height).sort((a, b) => a - b);
  const middle = Math.floor(heights.length / 2);
  const medianHeight = heights.length % 2 === 0
    ? (heights[middle - 1] + heights[middle]) / 2
    : heights[middle];
  const centreX = (molecule: MoleculeObject) => molecule.x + molecule.width / 2;
  const centreY = (molecule: MoleculeObject) => molecule.y + molecule.height / 2;
  const bands: { centreY: number; molecules: MoleculeObject[] }[] = [];
  for (const molecule of [...molecules].sort((a, b) => centreY(a) - centreY(b))) {
    const y = centreY(molecule);
    const band = bands[bands.length - 1];
    if (band && (y === band.centreY || y - band.centreY < medianHeight / 2)) {
      band.molecules.push(molecule);
    } else {
      bands.push({ centreY: y, molecules: [molecule] });
    }
  }
  return bands.flatMap((band) => band.molecules.sort((a, b) => centreX(a) - centreX(b)));
}

function structureListMolecules(document: ChemDraftDocument): MoleculeObject[] {
  const selectedIds = new Set(document.selection.objectIds);
  // Copy As intentionally falls back to the page for annotation-only selections and can
  // pull in arrow endpoints. A structure list exports only explicitly selected molecules.
  const molecules = copyAsScopeMolecules(document).filter((molecule) =>
    selectedIds.size === 0 || selectedIds.has(molecule.id)
  );
  return readingOrderMolecules(molecules);
}

function moleculeName(molecule: MoleculeObject): string | undefined {
  // The native schema has no molecule name/title property. A stored molfile's title
  // is a real source name; document titles, formulas and generated ids are not names.
  if (molecule.structureFormat !== "molfile-v2000" && molecule.structureFormat !== "molfile-v3000") {
    return undefined;
  }
  return molecule.structure.split(/\r\n|\r|\n/, 1)[0].replace(/\t/g, " ").trim() || undefined;
}

type ComputeStructureIdentifiers = typeof import("@chemdraft/rdkit-adapter/identifiers").computeStructureIdentifiers;

async function loadStructureIdentifiers(): Promise<ComputeStructureIdentifiers | undefined> {
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

async function moleculeSmiles(
  molecule: MoleculeObject,
  index: number,
  warnings: ExportWarning[],
  computeStructureIdentifiers: ComputeStructureIdentifiers | undefined,
  molfile?: string
): Promise<string> {
  // Both the V2000 input to RDKit and the native fallback approximate these features.
  const dativeBondCount = molecule.bonds.filter((bond) =>
    bond.order === "single" && bond.display?.bondStyle === "dashed"
  ).length;
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
      const identifiers = await computeStructureIdentifiers(
        molfile ?? moleculeToMolfileV2000(molecule, { fromDocFrame: true })
      );
      if (identifiers?.smiles) return identifiers.smiles;
    } catch {
      // A failed engine load or parse falls back per molecule, without dropping its record.
    }
  }
  if (molecule.bonds.some((bond) =>
    bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed"
  )) {
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

export async function exportStructureListSdf(
  document: ChemDraftDocument,
  options: Pick<MolfileWriteOptions, "abbreviations"> = {}
): Promise<TextExportResult> {
  const descriptor = getExportFormatDescriptor("sdf");
  const warnings: ExportWarning[] = [];
  const molecules = structureListMolecules(document);
  const computeStructureIdentifiers = molecules.length > 0 ? await loadStructureIdentifiers() : undefined;
  const records: string[] = [];
  for (const [index, molecule] of molecules.entries()) {
    const name = moleculeName(molecule);
    const writerWarnings: string[] = [];
    const molfile = moleculeToMolfileV2000(molecule, {
      ...options,
      fromDocFrame: true,
      warnings: writerWarnings
    });
    warnings.push(...writerWarnings.map((message): ExportWarning => ({
      code: "export.sdf_v2000_loss",
      message,
      severity: "warning",
      objectId: molecule.id
    })));
    const title = name ?? `ChemDraft molecule ${index + 1}`;
    const smiles = await moleculeSmiles(molecule, index, warnings, computeStructureIdentifiers, molfile);
    records.push(`${title}${molfile.slice(molfile.indexOf("\n"))}`
      + `> <SMILES>\n${smiles}\n\n> <Index>\n${index + 1}\n\n`
      + (name ? `> <Name>\n${name}\n\n` : "")
      + "$$$$\n");
  }
  return {
    format: descriptor.id,
    kind: "text",
    contents: records.join(""),
    mimeType: descriptor.mimeType,
    extension: descriptor.extensions[0],
    warnings
  };
}

export async function exportStructureListSmi(document: ChemDraftDocument): Promise<TextExportResult> {
  const descriptor = getExportFormatDescriptor("smiles");
  const warnings: ExportWarning[] = [];
  const molecules = structureListMolecules(document);
  const computeStructureIdentifiers = molecules.length > 0 ? await loadStructureIdentifiers() : undefined;
  const lines: string[] = [];
  for (const [index, molecule] of molecules.entries()) {
    const smiles = await moleculeSmiles(molecule, index, warnings, computeStructureIdentifiers);
    lines.push(`${smiles}\t${moleculeName(molecule) ?? index + 1}\n`);
  }
  return {
    format: descriptor.id,
    kind: "text",
    contents: lines.join(""),
    mimeType: descriptor.mimeType,
    extension: descriptor.extensions[0],
    warnings
  };
}
