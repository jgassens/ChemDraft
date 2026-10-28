/** Normalize file/engine hydrogen mass numbers to the native D/T element symbols. */
export function normalizeAtomIsotope<T extends { element: string; isotope?: number }>(atom: T): T {
  if (atom.isotope !== undefined &&
      (!Number.isInteger(atom.isotope) || atom.isotope < 1 || atom.isotope > 999)) {
    throw new Error(`Invalid isotope mass number ${atom.isotope} for ${atom.element}.`);
  }
  if ((atom.element === "D" || atom.element === "T") && atom.isotope !== undefined) {
    throw new Error(`${atom.element} must not carry an isotope field.`);
  }
  if (atom.element !== "H" || (atom.isotope !== 2 && atom.isotope !== 3)) return atom;
  const { isotope, ...rest } = atom;
  return { ...rest, element: isotope === 2 ? "D" : "T" } as T;
}
