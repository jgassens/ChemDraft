import type { MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import {
  nativeAtomBondOrderUsage, nativeAtomChargeSupportsValence, nativeAtomLabelFreeValence,
  nativeAtomLabelReading, nativeLabelBondSide, type NativeAtomLabelReading
} from "./atoms";

/** The validation/ring-template admission measure, including Kekulé orders and radicals. */
export function nativeAtomExternalValence(molecule: MoleculeObject, atom: MoleculeAtom): number {
  return nativeAtomBondOrderUsage(atom.id, molecule.bonds, molecule.atoms) + (atom.markRadicals ?? 0);
}

export interface LabelOnBondedAtomDecision {
  /** unchanged means the existing zero/one-bond label path needs no special handling. */
  kind: "unchanged" | "relabel" | "substituent";
  bondCount: number;
  external: number;
  reading: NativeAtomLabelReading["kind"];
  freeValence?: number;
  reason?: "one-bond" | "generic" | "heavy-hydrogen" | "source-valence";
}

/** Decide using the atom and molecule BEFORE typing, never an intermediate draft atom. */
export function labelOnBondedAtom(
  label: string, atom: MoleculeAtom, molecule: MoleculeObject
): LabelOnBondedAtomDecision {
  const bondCount = molecule.bonds.filter(b => b.fromAtomId === atom.id || b.toAtomId === atom.id).length;
  const external = nativeAtomExternalValence(molecule, atom);
  const context = { bonded: bondCount > 0 };
  const reading = nativeAtomLabelReading(label, context).kind;
  // An attached label is a new neutral atom; the source retains its own charge.
  const freeValence = nativeAtomLabelFreeValence(label, 0, context);
  const base = { bondCount, external, reading, freeValence };
  if (bondCount < 2) return { ...base, kind: "unchanged" };
  if (freeValence !== undefined && freeValence === external) return { ...base, kind: "relabel" };
  const reason = reading === "generic" ? "generic" : reading === "heavy-hydrogen" ? "heavy-hydrogen"
    : freeValence === 1 ? "one-bond" : undefined;
  if (!reason) return { ...base, kind: "relabel" };

  // #83 distinguishes an imported element (Ac/Pr/Ts/Ar) from the typed group spelling,
  // and a cyano label's recorded bond side from the side its current geometry suggests.
  const sourceBonds = molecule.bonds.filter(b => b.fromAtomId === atom.id || b.toAtomId === atom.id);
  const bondSide = nativeLabelBondSide(atom, sourceBonds, molecule.atoms);
  const sourceContext = { bonded: true, typed: atom.labelLiteral === true, ...(bondSide ? { bondSide } : {}) };
  const source = nativeAtomLabelReading(atom.element, sourceContext);
  const sourceFree = nativeAtomLabelFreeValence(atom.element, atom.formalCharge, sourceContext);
  const supports = source.kind === "element"
    ? nativeAtomChargeSupportsValence(source.element, external + 1, atom.formalCharge)
    : source.kind === "heavy-hydrogen" ? external + 1 <= 1
    : sourceFree === undefined || external + 1 <= sourceFree;
  return supports ? { ...base, kind: "substituent", reason }
    : { ...base, kind: "relabel", reason: "source-valence" };
}
