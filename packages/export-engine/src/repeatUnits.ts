import { bracketChemistryWarnings, type ChemDraftDocument, type DocumentObject, type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "./results";

/** Molecular graph formats currently omit repeat-unit semantics, even when the atoms survive. */
export function repeatUnitExportWarnings(document: ChemDraftDocument, format: string, scope?: {
  objects: readonly DocumentObject[];
  molecules: readonly MoleculeObject[];
}): ExportWarning[] {
  const molecules = scope?.molecules ?? document.pages.flatMap(page =>
    page.objects.filter((object): object is MoleculeObject => object.type === "molecule"));
  const warnings = new Map<string, ExportWarning>();
  for (const molecule of molecules) for (const warning of bracketChemistryWarnings(document, molecule)) {
    warnings.set(warning.objectId, { code: "export.repeat_unit_not_represented", severity: "warning", objectId: warning.objectId,
      message: `${format} export: ${warning.message}` });
  }
  return [...warnings.values()];
}
