/**
 * Every element symbol in atomic-number order: `elementSymbols[Z - 1]` is element Z, from H (1) to
 * Og (118). The native model's one ordered table: format readers and writers map atomic numbers
 * through it, so a format never carries its own partial list (CDXML once knew H–Ca, Br and I and
 * imported every other numbered element as carbon).
 */
export const elementSymbols = [
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
  "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
  "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
  "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
  "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
  "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
  "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
  "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
  "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
  "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
  "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds",
  "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og"
] as const;

const atomicNumberBySymbol = new Map<string, number>(elementSymbols.map((symbol, index) => [symbol, index + 1]));

/** The symbol of element `atomicNumber` (an integer 1–118), or undefined for anything else. */
export function elementSymbolForAtomicNumber(atomicNumber: number): string | undefined {
  return Number.isInteger(atomicNumber) ? elementSymbols[atomicNumber - 1] : undefined;
}

/** The atomic number of a plain, case-sensitive element symbol ("Fe" → 26), or undefined. */
export function atomicNumberForElementSymbol(symbol: string): number | undefined {
  return atomicNumberBySymbol.get(symbol);
}

// Metals used to identify the acceptor of a coordination bond. Metalloids (B, Si, Ge, As, Sb,
// Te) are deliberately absent; being outside an organic valence table does not make an atom metal.
const METAL_SYMBOLS = new Set([
  "Li", "Na", "K", "Rb", "Cs", "Fr",
  "Be", "Mg", "Ca", "Sr", "Ba", "Ra",
  "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
  "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
  "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
  "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn",
  "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu",
  "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr",
  "Al", "Ga", "In", "Sn", "Tl", "Pb", "Bi", "Po"
]);

/** Whether a plain, case-sensitive element symbol names a metal. */
export function isMetalSymbol(symbol: string): boolean {
  return METAL_SYMBOLS.has(symbol);
}
