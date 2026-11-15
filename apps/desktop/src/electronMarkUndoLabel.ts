import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { NativeElectronMarkSpec } from "./documentWorkflow";

/** Name the actual edit: an opposite-sign press reduces a charge, even on a radical ion. */
export function electronMarkUndoLabel(before: ChemDraftDocument, after: ChemDraftDocument, spec: NativeElectronMarkSpec): string {
  const magnitude = (document: ChemDraftDocument) => document.pages.reduce((total, page) => total +
    page.objects.reduce((sum, object) => sum + (object.type === "electron-mark" && object.markKind === spec.kind
      ? spec.kind === "charge" ? Math.abs(object.charge ?? 0) : 1 : 0), 0), 0);
  const noun = spec.kind === "charge" ? "Charge" : spec.kind === "radical-dot" ? "Radical" : "Lone Pair";
  return `${magnitude(after) < magnitude(before) ? "Remove" : "Add"} ${noun}`;
}
