import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { ExportWarning } from "./results";

/** Molecular graph formats currently omit repeat-unit semantics, even when the atoms survive. */
export function repeatUnitExportWarnings(document: ChemDraftDocument, format: string): ExportWarning[] {
  const seen = new Set<string>();
  return document.pages.flatMap(page => page.objects.flatMap(object => {
    if (object.type !== "bracket" || !(object.repeatUnit || object.bracketKind === "polymer")) return [];
    const key = object.pairId ?? object.id;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ code: "export.repeat_unit_not_represented", severity: "warning" as const, objectId: object.id,
      message: `${format} export does not represent repeat units: polymer brackets and their repeat labels are omitted; only the drawn molecular graph is written.` }];
  }));
}
