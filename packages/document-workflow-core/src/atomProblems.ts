import type { MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { nativeAtomLabelReading, nativeAtomMaxValence, nativeElementFromAtomLabel } from "@chemdraft/layout-engine";
import { nativeAtomValidationState } from "./atoms";

export type AtomProblemAction = "hydrogens" | "charge" | "ignore" | "restore";
export interface AtomProblemFix { action: AtomProblemAction; label: string; atom: MoleculeAtom }
/** Suggestions are probes of the existing validator, never another set of chemistry rules. */
export function atomProblem(molecule: MoleculeObject, atomId: string) {
  const atom = molecule.atoms.find(a => a.id === atomId);
  if (!atom) return undefined;
  const state = nativeAtomValidationState(atom, molecule.bonds, atom.formalCharge, molecule.atoms);
  if (state.valid) return undefined;
  const valid = (candidate: MoleculeAtom) => nativeAtomValidationState(candidate, molecule.bonds,
    candidate.formalCharge, molecule.atoms.map(a => a.id === atomId ? candidate : a)).valid;
  const fixes: AtomProblemFix[] = [];
  const reading = nativeAtomLabelReading(atom.element, { bonded: molecule.bonds.some(b => b.fromAtomId === atomId || b.toAtomId === atomId), typed: atom.labelLiteral === true });
  const composite = reading.kind === "group" && reading.group.kind === "composite" ? reading.group : undefined;
  const element = reading.kind === "element" || reading.kind === "spelled" ? reading.element
    : composite ? nativeElementFromAtomLabel(composite.head) : undefined;
  if (element) {
    const aromatic = molecule.bonds.some(b => b.order === "aromatic" && (b.fromAtomId === atomId || b.toAtomId === atomId));
    const current = reading.kind === "spelled" ? reading.hydrogens : composite?.hydrogens ?? atom.hydrogenCount ?? 0;
    const counts = Array.from({ length: (nativeAtomMaxValence[element] ?? 0) + 1 }, (_, i) => i)
      .sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
    for (const count of counts) {
      const candidate = { ...atom, hydrogenCount: count,
        ...(aromatic ? {} : { element: `${element}${count ? `H${count === 1 ? "" : count}` : ""}${composite?.substituents.map(s => s.label).join("") ?? ""}`, labelLiteral: true, labelVisible: true }) };
      if (valid(candidate)) {
        fixes.push({ action: "hydrogens", label: `Set explicit hydrogens to ${count}`, atom: candidate }); break;
      }
    }
  }
  if (state.expectedFormalCharge !== undefined && state.expectedFormalCharge !== atom.formalCharge) {
    const candidate = { ...atom, formalCharge: state.expectedFormalCharge };
    if (valid(candidate)) fixes.push({ action: "charge", label: `Set formal charge to ${candidate.formalCharge > 0 ? "+" : ""}${candidate.formalCharge}`, atom: candidate });
  }
  const { warningSuppressed: _suppressed, ...rest } = atom;
  fixes.push(atom.warningSuppressed ? { action: "restore", label: "Restore warning", atom: rest }
    : { action: "ignore", label: "Ignore warning", atom: { ...atom, warningSuppressed: true } });
  return { state, explanation: `${state.element}: ${molecule.bonds.filter(b => b.fromAtomId === atomId || b.toAtomId === atomId).length} bonds, valence ${state.valenceUsed}, formal charge ${state.formalCharge}. ${state.invalidReason ?? "Check this atom's label and bonds."}`, fixes };
}
