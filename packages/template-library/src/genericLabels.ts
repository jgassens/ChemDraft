import { abbreviationForBondedElementLabel } from "./abbreviations";

/**
 * Generic atom labels: placeholders a chemist draws on purpose to mean "some group" — an R-group,
 * a halogen X, an unknown "?". They are not structures, so they count nothing in a formula and
 * export as placeholders, but they are not mistakes either: the unrecognised-label badge must
 * never fire on them. Matching is case-sensitive, like the abbreviation table.
 *
 * A label that is an element symbol is the element, whatever this says ("Y" is yttrium); the label
 * parser checks elements first. The exceptions are element symbols chemists write on bonds, which
 * `bondedElementLabelMeaning` lists: on a bonded atom "Ar" is aryl (a placeholder), and "Ac", "Pr"
 * and "Ts" are the abbreviation table's acetyl, n-propyl and tosyl.
 *
 * "Z" is left out on purpose: it is also the old peptide abbreviation for Cbz, so it is flagged as
 * unrecognized rather than silently accepted.
 */
const genericAtomLabels: ReadonlySet<string> = new Set([
  // Halogen, and the molfile query letters: any atom, heteroatom, metal.
  "X", "A", "Q", "M",
  // Mechanism and synthesis placeholders: nucleophile, electrophile, leaving and protecting group.
  "Nu", "E", "LG", "PG",
  // Unknown, and the dummy atom a pasted SMILES or molfile can carry.
  "?", "*"
]);

/** R, R', R'', and numbered R-groups R1–R99 (no R0, and no leading zero: R01 is not R1). */
const rGroupLabel = /^R(?:[1-9]\d?|'{1,2})?$/;

export function isGenericAtomLabel(label: string): boolean {
  const trimmed = label.trim();
  return rGroupLabel.test(trimmed) || genericAtomLabels.has(trimmed);
}

/**
 * Whether an element-symbol label is a generic placeholder on an atom with bonds: "Ar", aryl.
 * Unbonded, it is argon. Exact case only.
 */
export function isBondedGenericAtomLabel(label: string): boolean {
  return label.trim() === "Ar";
}

/**
 * What an element-symbol label means on an atom with bonds, when that is not the element: "aryl"
 * for "Ar", and the group's name for the table's bonded spellings ("Ts" → tosyl). Undefined for every
 * other label. The one list both the label reader and the file writers consult, so a CDXML file
 * cannot say tennessine where the formula says tosyl.
 */
export function bondedElementLabelMeaning(label: string): string | undefined {
  if (isBondedGenericAtomLabel(label)) return "aryl";
  return abbreviationForBondedElementLabel(label)?.name;
}
