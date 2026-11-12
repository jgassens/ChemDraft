/**
 * The number explicitly drawn on a native R-group atom. Native numbered labels are R1–R99,
 * without leading zeroes. R, R' and R'' remain unnumbered; ids and attachment anchors never
 * supply a number. The label stays in MoleculeAtom.element and RGroupDisplay.label.
 */
export function rGroupNumberFromLabel(label: string): number | undefined {
  const match = /^R([1-9]\d?)$/.exec(label.trim());
  return match ? Number(match[1]) : undefined;
}
