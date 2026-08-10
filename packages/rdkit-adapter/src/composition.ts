/**
 * Composition from RDKit's sanitized graph (PLANS.md §7).
 *
 * "Formula, formal charge, and elemental composition come from the **sanitized RDKit molecule under a
 * named interpretation** … not an independent native graph walk. Computing a formula looks trivial
 * until the structure carries isotope labels, radicals, explicit vs implicit hydrogens, query atoms,
 * pseudoatoms, unusual valences, disconnected salts, or coordination bonds."
 *
 * The distinction this module respects: reading RDKit's own atom and bond lists out of `get_json()` is
 * *bookkeeping*, and building Hill notation from them is a rendering convention. Re-deciding valence,
 * implicit-hydrogen counts, or aromaticity would be a second molecular interpretation — that is the
 * thing not to build, and nothing here does it. Every hydrogen count, charge, isotope label, and
 * radical count below is RDKit's answer, transcribed.
 *
 * Pure over the JSON, so the whole surface is testable without loading 7.5 MB of WASM.
 */
import type { CompositionComponent, ElementCount } from "@chemdraft/analysis-core";

// --- RDKit JSON (commonchem) ------------------------------------------------------------------

export interface RdkitAtomJson {
  /** Atomic number. Absent means the file-level default, which RDKit writes as carbon. */
  z?: number;
  impHs?: number;
  chg?: number;
  nRad?: number;
  /** Mass number when the atom carries an explicit isotope label; `0`/absent for natural abundance. */
  isotope?: number;
  stereo?: string;
}

export interface RdkitBondJson {
  atoms: [number, number];
  bo?: number;
}

export interface RdkitMoleculeJson {
  atoms: RdkitAtomJson[];
  bonds: RdkitBondJson[];
  /**
   * RDKit's `rdkitRepresentation` block — aromatic atom and bond indices, CIP ranks, ring membership.
   * Declared so its existence is visible, and deliberately untyped because nothing here reads it:
   * every index in it is keyed to the molecule's own numbering, so it cannot survive a subset (see
   * `subsetRdkitJson` in ./interpretations).
   */
  extensions?: unknown[];
}

export interface RdkitJson {
  defaults?: { atom?: RdkitAtomJson; bond?: { bo?: number } };
  molecules: RdkitMoleculeJson[];
}

/**
 * Symbol by atomic number. Element symbols are IUPAC nomenclature, not a licensed data set — this is
 * deliberately *not* an atomic-mass table, because masses come from RDKit's own `amw`/`exactmw` and
 * shipping our own would drag in the NIST Standard Reference Data question §6 flags.
 */
const ELEMENT_SYMBOLS = [
  "", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
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

/**
 * The symbol RDKit writes for a dummy atom — an R-group, an attachment point, a query atom.
 *
 * Atomic number 0 is not a missing element, it is the deliberate absence of one, and `chem-core`
 * treats such atoms as first-class objects a user can draw. This used to throw, and because
 * `compositionFromRdkitJson` runs before any method does, the throw rejected the ENTIRE run: drawing
 * `*c1ccccc1` — which RDKit parses perfectly well — failed every one of the ~62 methods with
 * "No element symbol for atomic number 0", including the ones that never look at elements.
 *
 * Reporting `*` matches what RDKit's own `CalcMolFormula` emits (`C6H5*`), so the formula stays the
 * one a reader cross-checking against RDKit expects, and the methods that genuinely cannot handle a
 * pseudoatom decline through `elementsOutsideParameterization` with their own reasons — one decline
 * per method that means it, rather than one exception for all of them.
 */
const DUMMY_ATOM_SYMBOL = "*";

export function elementSymbol(atomicNumber: number): string {
  if (atomicNumber === 0) return DUMMY_ATOM_SYMBOL;
  const symbol = ELEMENT_SYMBOLS[atomicNumber];
  if (!symbol) throw new Error(`No element symbol for atomic number ${atomicNumber}.`);
  return symbol;
}

// --- element tallies --------------------------------------------------------------------------

/** An element/isotope pair, keyed so labelled and natural-abundance atoms of one element stay apart. */
function tallyKey(symbol: string, isotope: number | undefined): string {
  return isotope ? `${symbol}-${isotope}` : symbol;
}

function addTally(tallies: Map<string, ElementCount>, symbol: string, isotope: number | undefined, count: number): void {
  if (count <= 0) return;
  const key = tallyKey(symbol, isotope);
  const existing = tallies.get(key);
  if (existing) {
    existing.count += count;
    return;
  }
  tallies.set(key, isotope ? { symbol, count, isotope } : { symbol, count });
}

/**
 * Hill notation: carbon first, hydrogen second, everything else alphabetically. With no carbon,
 * every element sorts alphabetically — hydrogen included.
 *
 * Isotope-labelled atoms are emitted as `[13C]` **before** the natural-abundance atoms of the same
 * element, ascending by mass number. That ordering is a convention, not a fact, so the composition
 * method contract names it; it matches what RDKit's own `CalcMolFormula(separateIsotopes=True)`
 * produces, which is the least surprising choice for anyone cross-checking against RDKit.
 */
export function hillFormula(counts: readonly ElementCount[]): string {
  if (counts.length === 0) return "";
  const hasCarbon = counts.some((entry) => entry.symbol === "C");

  const rank = (entry: ElementCount): [number, string, number] => {
    if (hasCarbon && entry.symbol === "C") return [0, "", entry.isotope ?? Number.MAX_SAFE_INTEGER];
    if (hasCarbon && entry.symbol === "H") return [1, "", entry.isotope ?? Number.MAX_SAFE_INTEGER];
    return [2, entry.symbol, entry.isotope ?? Number.MAX_SAFE_INTEGER];
  };

  return [...counts]
    .sort((a, b) => {
      const [groupA, symbolA, isotopeA] = rank(a);
      const [groupB, symbolB, isotopeB] = rank(b);
      if (groupA !== groupB) return groupA - groupB;
      // Code-unit order, NOT `localeCompare`. Element symbols are ASCII, so this is the alphabetical
      // order Hill notation means — and unlike `localeCompare` with no locale argument it gives the
      // same answer on every machine. The default collator resolves from the OS language: under
      // Estonian, Z sorts between S and T and ZnTiO3 renders as OZnTi; under Lithuanian, Y follows I
      // and YBa2Cu3O7 renders as BaCuYO. Verified in JavaScriptCore, the engine the WKWebView
      // actually runs, where the collator follows the Apple language preference rather than LANG.
      // A formula is part of the method contract's stated convention, so it cannot depend on who is
      // reading it.
      if (symbolA !== symbolB) return symbolA < symbolB ? -1 : 1;
      return isotopeA - isotopeB;
    })
    .map((entry) => {
      const symbol = entry.isotope ? `[${entry.isotope}${entry.symbol}]` : entry.symbol;
      return entry.count === 1 ? symbol : `${symbol}${entry.count}`;
    })
    .join("");
}

// --- connected components ----------------------------------------------------------------------

/** Union-find over RDKit's own bond list. Returns one sorted atom-index group per component. */
export function connectedComponents(atomCount: number, bonds: readonly RdkitBondJson[]): number[][] {
  const parent = Array.from({ length: atomCount }, (_unused, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  for (const bond of bonds) {
    const [a, b] = bond.atoms;
    if (a >= atomCount || b >= atomCount) continue;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < atomCount; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  }

  // Sorted by first atom index so component order follows the drawing, not hash order.
  return [...groups.values()].sort((a, b) => a[0]! - b[0]!);
}

// --- the derivation ---------------------------------------------------------------------------

export interface DerivedComposition {
  formula: string;
  formalCharge: number;
  elements: ElementCount[];
  components: CompositionComponent[];
  hasExplicitIsotopes: boolean;
  radicalElectronCount: number;
  /** Distinct element symbols present, for the method-contract element-coverage check. */
  presentElements: string[];
  /** Heavy atoms plus explicit hydrogens — RDKit's atom count, not a recount. */
  atomCount: number;
  bondCount: number;
}

/**
 * Read composition out of RDKit's JSON for one parsed molecule.
 *
 * Hydrogens are counted from `impHs` **plus** explicitly drawn `z: 1` atoms, which is what keeps
 * `[2H]C([2H])([2H])C(=O)O` from reporting four indistinguishable hydrogens: the three deuteriums are
 * explicit atoms carrying `isotope: 2` and tally separately from the acid proton RDKit left implicit.
 *
 * Implicit hydrogens are always protium — an isotope label requires an explicit atom to hang on — so
 * they never inherit their heavy atom's label. That is why the isotope is read per atom rather than
 * applied to the element's whole tally.
 */
export function compositionFromRdkitJson(json: RdkitJson): DerivedComposition {
  const molecule = json.molecules[0];
  if (!molecule) throw new Error("RDKit JSON carried no molecule.");

  const defaults = json.defaults?.atom ?? {};
  const defaultZ = defaults.z ?? 6;
  const defaultImpHs = defaults.impHs ?? 0;
  const defaultCharge = defaults.chg ?? 0;
  const defaultRadicals = defaults.nRad ?? 0;
  const defaultIsotope = defaults.isotope ?? 0;

  const atoms = molecule.atoms.map((atom) => ({
    z: atom.z ?? defaultZ,
    impHs: atom.impHs ?? defaultImpHs,
    chg: atom.chg ?? defaultCharge,
    nRad: atom.nRad ?? defaultRadicals,
    isotope: atom.isotope ?? defaultIsotope
  }));

  const wholeTallies = new Map<string, ElementCount>();
  let formalCharge = 0;
  let radicalElectronCount = 0;
  let hasExplicitIsotopes = false;
  const presentElements = new Set<string>();

  for (const atom of atoms) {
    const symbol = elementSymbol(atom.z);
    presentElements.add(symbol);
    addTally(wholeTallies, symbol, atom.isotope || undefined, 1);
    if (atom.isotope) hasExplicitIsotopes = true;
    if (atom.impHs > 0) {
      addTally(wholeTallies, "H", undefined, atom.impHs);
      presentElements.add("H");
    }
    formalCharge += atom.chg;
    radicalElectronCount += atom.nRad;
  }

  const groups = connectedComponents(atoms.length, molecule.bonds ?? []);

  // Identical components collapse into a multiplicity, so `N.N.Cl[Pt]Cl` reads as "2 × H3N" rather
  // than repeating a row. `sourceAtomIndices` then spans every copy — the highlight covers both
  // ammines, which is what a user clicking that row means.
  const byIdentity = new Map<string, CompositionComponent>();
  for (const group of groups) {
    const tallies = new Map<string, ElementCount>();
    let charge = 0;
    for (const index of group) {
      const atom = atoms[index]!;
      const symbol = elementSymbol(atom.z);
      addTally(tallies, symbol, atom.isotope || undefined, 1);
      if (atom.impHs > 0) addTally(tallies, "H", undefined, atom.impHs);
      charge += atom.chg;
    }
    const elements = [...tallies.values()];
    const formula = hillFormula(elements);
    const identity = `${formula}|${charge}`;
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.multiplicity += 1;
      existing.sourceAtomIndices = [...existing.sourceAtomIndices, ...group].sort((a, b) => a - b);
      continue;
    }
    byIdentity.set(identity, {
      formula,
      charge,
      multiplicity: 1,
      elements,
      sourceAtomIndices: [...group]
    });
  }

  const elements = [...wholeTallies.values()];

  return {
    formula: hillFormula(elements),
    formalCharge,
    elements,
    components: [...byIdentity.values()],
    hasExplicitIsotopes,
    radicalElectronCount,
    presentElements: [...presentElements].sort(),
    atomCount: atoms.length,
    bondCount: molecule.bonds?.length ?? 0
  };
}
