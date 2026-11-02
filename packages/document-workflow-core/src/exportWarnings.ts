import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { nativeAtomValidationState, nativeBondOrderResolution } from "./atoms";

/** Validate the authored graph independently of cached metadata and badge acknowledgement.
 * Call before expanding labels or merging molecules so drawn atom indices agree across formats.
 */
export function nativeMoleculeExportWarnings(molecule: MoleculeObject): ExportWarning[] {
  const resolution = nativeBondOrderResolution(molecule.atoms, molecule.bonds);
  return molecule.atoms.flatMap((atom, index): ExportWarning[] => {
    const state = nativeAtomValidationState(atom, molecule.bonds, atom.formalCharge, molecule.atoms, resolution);
    if (state.valid) return [];
    const name = `${atom.element.trim() || "Atom"}${index + 1}`;
    const reason = state.invalidReason ?? "has invalid valence.";
    // Most short diagnostics begin with the element/label. Add its one-based drawn index
    // while retaining the validator's wording for every kind of problem.
    const prefix = [atom.element, state.element].find(label => label && reason.startsWith(label));
    const message = prefix ? name + reason.slice(prefix.length) : `${name}: ${reason}`;
    return [{ code: "export.invalid_structure", message, severity: "warning", objectId: molecule.id }];
  });
}

export function nativeDocumentExportWarnings(document: ChemDraftDocument): ExportWarning[] {
  return document.pages.flatMap(page => page.objects.flatMap(object =>
    object.type === "molecule" ? nativeMoleculeExportWarnings(object) : []));
}
