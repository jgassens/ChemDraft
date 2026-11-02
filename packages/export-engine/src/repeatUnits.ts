import { bracketPairs, type ChemDraftDocument, type DocumentObject, type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "./results";

/** Molecular graph formats currently omit repeat-unit semantics, even when the atoms survive. */
export function repeatUnitExportWarnings(document: ChemDraftDocument, format: string, scope?: {
  objects: readonly DocumentObject[];
  molecules: readonly MoleculeObject[];
}): ExportWarning[] {
  const objects = scope && new Set(scope.objects);
  const molecules = scope && new Set(scope.molecules);
  return document.pages.flatMap(page => [...bracketPairs(page.objects.filter(object => !objects || objects.has(object))).values()].flatMap(pair => {
    if (!pair.some(object => object.repeatUnit || object.bracketKind === "polymer")) return [];
    const members = new Set(pair.flatMap(object => object.containedObjectIds));
    const left = Math.min(...pair.map(object => object.x));
    const top = Math.min(...pair.map(object => object.y));
    const right = Math.max(...pair.map(object => object.x + object.width));
    const bottom = Math.max(...pair.map(object => object.y + object.height));
    const containsExportedMolecule = page.objects.some(object => object.type === "molecule" && (!molecules || molecules.has(object)) &&
      (members.has(object.id) || (object.x >= left && object.y >= top && object.x + object.width <= right && object.y + object.height <= bottom)));
    if (!containsExportedMolecule) return [];
    return [{ code: "export.repeat_unit_not_represented", severity: "warning" as const, objectId: pair[0].id,
      message: `${format} export does not represent repeat units: polymer brackets and their repeat labels are omitted; only the drawn molecular graph is written.` }];
  }));
}
