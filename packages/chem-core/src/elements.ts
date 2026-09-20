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
