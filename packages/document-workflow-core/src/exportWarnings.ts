import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { nativeAtomValenceForCharge, nativeElementFromAtomLabel } from "@chemdraft/layout-engine";
import { nativeAtomValidationState, nativeBondOrderResolution } from "./atoms";

/** Evidence from diagnostics actually emitted by the SMILES route, never a validity override. */
export interface SmilesProblemEvidence {
  inferredRadicals: Map<string, number>;
  chargeSeparatedNitro: Set<string>;
}

/** Validate the authored graph independently of cached metadata and badge acknowledgement.
 * Call before expanding labels or merging molecules so drawn atom indices agree across formats.
 */
export function nativeMoleculeExportWarnings(molecule: MoleculeObject, evidence?: SmilesProblemEvidence): ExportWarning[] {
  const resolution = nativeBondOrderResolution(molecule.atoms, molecule.bonds);
  return molecule.atoms.flatMap((atom, index): ExportWarning[] => {
    const state = nativeAtomValidationState(atom, molecule.bonds, atom.formalCharge, molecule.atoms, resolution);
    if (state.valid) return [];
    const inferred = evidence?.inferredRadicals.get(atom.id);
    const element = nativeElementFromAtomLabel(atom.element);
    // Only a complete valence deficit is accounted for by the radical diagnostic. Revalidate
    // the hypothetical count so aromatic uncertainty, label problems and excess valence survive.
    if (inferred !== undefined && element && inferred > (atom.markRadicals ?? 0) &&
        (resolution.bondOrderUsage.get(atom.id) ?? 0) + inferred === nativeAtomValenceForCharge(element, atom.formalCharge) &&
        nativeAtomValidationState({ ...atom, markRadicals: inferred }, molecule.bonds,
          atom.formalCharge, molecule.atoms, resolution).valid) return [];
    if (evidence?.chargeSeparatedNitro.has(atom.id) && element === "N" &&
        atom.formalCharge === 0 && (atom.markRadicals ?? 0) === 0 && state.valenceUsed === 5 &&
        !state.unresolvedAromatic && !state.tautomerGuessed) return [];
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
