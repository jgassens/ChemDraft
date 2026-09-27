// Element tables, valence and charge rules, and atom validation for native molecules.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import {
  type ChemicalMetadata,
  type CompatibilityWarning,
  isDativeBond,
  type MoleculeAtom,
  type MoleculeBond
} from "@chemdraft/chem-core";
import {
  dativeDeprotonationCount,
  nativeAtomChargeIsExpressible,
  nativeAtomValenceForCharge
} from "@chemdraft/layout-engine";

export const nativeElementSymbols = [
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

export type NativeElementSymbol = typeof nativeElementSymbols[number];

export interface NativeAtomValidationState {
  atomId: string;
  element: string;
  valenceUsed: number;
  formalCharge: number;
  expectedFormalCharge?: number;
  valid: boolean;
  invalidReason?: string;
}

const nativeElementSymbolSet = new Set<string>(nativeElementSymbols);

export const nativeAtomValence: Partial<Record<NativeElementSymbol, number>> = {
  H: 1,
  B: 3,
  C: 4,
  N: 3,
  O: 2,
  F: 1,
  Al: 3,
  Si: 4,
  P: 3,
  S: 2,
  Cl: 1,
  Ge: 4,
  As: 3,
  Se: 2,
  Br: 1,
  Sn: 4,
  Te: 2,
  I: 1
};

const nativeAtomMaxValence: Partial<Record<NativeElementSymbol, number>> = {
  H: 1,
  B: 4,
  C: 4,
  N: 4,
  O: 3,
  F: 1,
  Al: 4,
  Si: 4,
  P: 5,
  S: 6,
  // The heavy halogens reach the hypervalent I(III)/I(V)/I(VII) family — periodinanes and
  // PhI(OAc)2 are everyday reagents, not drawing errors.
  Cl: 7,
  Ge: 4,
  As: 5,
  Se: 6,
  Br: 7,
  Sn: 4,
  Te: 6,
  I: 7
};

/**
 * Sanity ceilings for the d-block: roughly the highest coordination number each metal reaches in
 * isolable complexes — generous on purpose, and not a hard literature record (La is listed at
 * 10, yet [La(NO3)6]3- is 12-coordinate). Transition metals have VARIABLE oxidation states and
 * dative/eta bonding, so no single "correct" valence exists to check a drawing against — V(II)
 * through V(V) are all real, V(CO)6 has six bonds at oxidation state zero, and a bare metal atom
 * is a legitimate species (catalysts). The only honest complaint is a bond count beyond anything
 * plausible, so metals flag hypervalence past this ceiling and are never flagged hypovalent or
 * naked. In practice the growth tools cap every atom at `nativeAtomInvalidGrowthLimit` (8), so
 * ceilings above 8 (Tc/Re/W at 9, La at 10) are unreachable by drawing and act as documentation
 * of intent for imported structures.
 */
const nativeMetalMaxCoordination: Partial<Record<NativeElementSymbol, number>> = {
  Sc: 7, Ti: 8, V: 7, Cr: 7, Mn: 7, Fe: 7, Co: 7, Ni: 7, Cu: 6, Zn: 6,
  Y: 9, Zr: 8, Nb: 8, Mo: 8, Tc: 9, Ru: 8, Rh: 7, Pd: 6, Ag: 6, Cd: 7,
  La: 10, Hf: 8, Ta: 8, W: 9, Re: 9, Os: 9, Ir: 8, Pt: 6, Au: 6, Hg: 6
};

// Standard atomic weights; exact = the most abundant isotope's mass.
/**
 * Standard atomic weight (IUPAC abridged) and the exact mass of the most abundant isotope, for
 * EVERY element the label parser can produce — the type is a complete `Record`, so adding a
 * symbol to `nativeElementSymbols` without a mass here fails to compile. It used to be a partial
 * table with a `?? 0` fallback, and the formula would list an atom (CH3Li, an MgBr label) whose
 * mass the molecular weight silently omitted. Elements with no stable isotope carry the mass
 * number and exact mass of their longest-lived isotope, the usual convention for a weight.
 */
const nativeAtomMass: Record<NativeElementSymbol, { average: number; exact: number }> = {
  H: { average: 1.008, exact: 1.00782503223 },
  He: { average: 4.0026, exact: 4.00260325413 },
  Li: { average: 6.94, exact: 7.0160034366 },
  Be: { average: 9.0122, exact: 9.012183065 },
  B: { average: 10.81, exact: 11.00930536 },
  C: { average: 12.011, exact: 12 },
  N: { average: 14.007, exact: 14.00307400443 },
  O: { average: 15.999, exact: 15.99491461957 },
  F: { average: 18.998, exact: 18.99840316273 },
  Ne: { average: 20.18, exact: 19.9924401762 },
  Na: { average: 22.99, exact: 22.989769282 },
  Mg: { average: 24.305, exact: 23.985041697 },
  Al: { average: 26.982, exact: 26.98153853 },
  Si: { average: 28.085, exact: 27.97692653465 },
  P: { average: 30.974, exact: 30.97376199842 },
  S: { average: 32.06, exact: 31.9720711744 },
  Cl: { average: 35.45, exact: 34.968852682 },
  Ar: { average: 39.948, exact: 39.9623831237 },
  K: { average: 39.098, exact: 38.9637064864 },
  Ca: { average: 40.078, exact: 39.962590863 },
  Sc: { average: 44.956, exact: 44.95590828 },
  Ti: { average: 47.867, exact: 47.94794198 },
  V: { average: 50.942, exact: 50.94395704 },
  Cr: { average: 51.996, exact: 51.94050623 },
  Mn: { average: 54.938, exact: 54.93804391 },
  Fe: { average: 55.845, exact: 55.93493633 },
  Co: { average: 58.933, exact: 58.93319429 },
  Ni: { average: 58.693, exact: 57.93534241 },
  Cu: { average: 63.546, exact: 62.92959772 },
  Zn: { average: 65.38, exact: 63.92914201 },
  Ga: { average: 69.723, exact: 68.9255735 },
  Ge: { average: 72.63, exact: 73.921177761 },
  As: { average: 74.922, exact: 74.92159457 },
  Se: { average: 78.971, exact: 79.9165218 },
  Br: { average: 79.904, exact: 78.9183376 },
  Kr: { average: 83.798, exact: 83.9114977282 },
  Rb: { average: 85.468, exact: 84.9117897379 },
  Sr: { average: 87.62, exact: 87.9056125 },
  Y: { average: 88.906, exact: 88.9058403 },
  Zr: { average: 91.224, exact: 89.9046977 },
  Nb: { average: 92.906, exact: 92.906373 },
  Mo: { average: 95.95, exact: 97.90540482 },
  Tc: { average: 98, exact: 97.9072124 },
  Ru: { average: 101.07, exact: 101.9043441 },
  Rh: { average: 102.906, exact: 102.905498 },
  Pd: { average: 106.42, exact: 105.9034804 },
  Ag: { average: 107.868, exact: 106.9050916 },
  Cd: { average: 112.414, exact: 113.90336509 },
  In: { average: 114.818, exact: 114.903878776 },
  Sn: { average: 118.71, exact: 119.90220163 },
  Sb: { average: 121.76, exact: 120.903812 },
  Te: { average: 127.6, exact: 129.906222748 },
  I: { average: 126.904, exact: 126.9044719 },
  Xe: { average: 131.293, exact: 131.9041550856 },
  Cs: { average: 132.905, exact: 132.905451961 },
  Ba: { average: 137.327, exact: 137.905247 },
  La: { average: 138.905, exact: 138.9063563 },
  Ce: { average: 140.116, exact: 139.9054431 },
  Pr: { average: 140.908, exact: 140.9076576 },
  Nd: { average: 144.242, exact: 141.907729 },
  Pm: { average: 145, exact: 144.9127559 },
  Sm: { average: 150.36, exact: 151.9197397 },
  Eu: { average: 151.964, exact: 152.921238 },
  Gd: { average: 157.25, exact: 157.9241123 },
  Tb: { average: 158.925, exact: 158.9253547 },
  Dy: { average: 162.5, exact: 163.9291819 },
  Ho: { average: 164.93, exact: 164.9303288 },
  Er: { average: 167.259, exact: 165.9302995 },
  Tm: { average: 168.934, exact: 168.9342179 },
  Yb: { average: 173.045, exact: 173.9388664 },
  Lu: { average: 174.967, exact: 174.9407752 },
  Hf: { average: 178.486, exact: 179.946557 },
  Ta: { average: 180.948, exact: 180.9479958 },
  W: { average: 183.84, exact: 183.95093092 },
  Re: { average: 186.207, exact: 186.9557501 },
  Os: { average: 190.23, exact: 191.961477 },
  Ir: { average: 192.217, exact: 192.9629216 },
  Pt: { average: 195.084, exact: 194.9647917 },
  Au: { average: 196.967, exact: 196.96656879 },
  Hg: { average: 200.592, exact: 201.9706434 },
  Tl: { average: 204.38, exact: 204.9744278 },
  Pb: { average: 207.2, exact: 207.9766525 },
  Bi: { average: 208.98, exact: 208.9803991 },
  Po: { average: 209, exact: 208.9824308 },
  At: { average: 210, exact: 209.9871479 },
  Rn: { average: 222, exact: 222.0175782 },
  Fr: { average: 223, exact: 223.019736 },
  Ra: { average: 226, exact: 226.0254103 },
  Ac: { average: 227, exact: 227.0277523 },
  Th: { average: 232.038, exact: 232.0380558 },
  Pa: { average: 231.036, exact: 231.0358842 },
  U: { average: 238.029, exact: 238.0507884 },
  Np: { average: 237, exact: 237.0481736 },
  Pu: { average: 244, exact: 244.0642053 },
  Am: { average: 243, exact: 243.0613813 },
  Cm: { average: 247, exact: 247.0703541 },
  Bk: { average: 247, exact: 247.0703073 },
  Cf: { average: 251, exact: 251.0795886 },
  Es: { average: 252, exact: 252.08298 },
  Fm: { average: 257, exact: 257.0951061 },
  Md: { average: 258, exact: 258.0984315 },
  No: { average: 259, exact: 259.10103 },
  Lr: { average: 266, exact: 266.11983 },
  Rf: { average: 267, exact: 267.12179 },
  Db: { average: 268, exact: 268.12567 },
  Sg: { average: 269, exact: 269.12863 },
  Bh: { average: 270, exact: 270.13336 },
  Hs: { average: 269, exact: 269.13375 },
  Mt: { average: 278, exact: 278.15631 },
  Ds: { average: 281, exact: 281.16451 },
  Rg: { average: 282, exact: 282.16912 },
  Cn: { average: 285, exact: 285.17712 },
  Nh: { average: 286, exact: 286.18221 },
  Fl: { average: 289, exact: 289.19042 },
  Mc: { average: 290, exact: 290.19598 },
  Lv: { average: 293, exact: 293.20449 },
  Ts: { average: 294, exact: 294.21046 },
  Og: { average: 294, exact: 294.21392 }
};

/** The atomic masses behind the formula's molecular weight; throws on a symbol the table lacks. */
export function nativeElementMass(element: string): { average: number; exact: number } {
  // Heavy hydrogen is a label, not an element in the table, but it has a definite mass.
  if (element === "D") return { average: 2.014102, exact: 2.014102 };
  if (element === "T") return { average: 3.016049, exact: 3.016049 };
  const mass = nativeAtomMass[element as NativeElementSymbol];
  if (!mass) {
    throw new Error(`No atomic mass for element symbol "${element}".`);
  }
  return mass;
}

export const nativeBondOrderValue: Record<MoleculeBond["order"], number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 1,
  unknown: 1
};

export function normalizeNativeAtomElementLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const elementCandidate = `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1).toLowerCase()}`;
  return nativeElementSymbolSet.has(elementCandidate) ? elementCandidate : trimmed;
}

export function nativeElementFromAtomLabel(value: string): NativeElementSymbol | undefined {
  const normalized = normalizeNativeAtomElementLabel(value);
  return nativeElementSymbolSet.has(normalized) ? normalized as NativeElementSymbol : undefined;
}

export function nativeAtomValidationState(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[],
  effectiveFormalCharge = atom.formalCharge
): NativeAtomValidationState {
  const element = nativeElementFromAtomLabel(atom.element);
  // Unpaired electrons from associated radical marks occupy bonding slots like bonds do.
  const valenceUsed = nativeAtomBondOrderUsage(atom.id, bonds) + (atom.markRadicals ?? 0);

  // The user dismissed this atom's warning from the context menu — report it valid so no
  // badge renders and no warning is stored, whatever the arithmetic says.
  if (atom.warningSuppressed === true) {
    return {
      atomId: atom.id,
      element: element ?? (atom.element.trim() || "(blank)"),
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: true
    };
  }

  if (!element) {
    const symbol = atom.element.trim() || "(blank)";
    // A literal condensed label spelling one heavy element plus hydrogens ("NH2", "OH2",
    // "CH3") is checkable: its own hydrogens count toward the valence, so a naked typed
    // "OH2" is complete water while a naked neutral "CH3" is a flagged methyl fragment.
    // Multi-heavy labels ("CO2H") and abbreviations ("OMe") are superatoms — not checked.
    if (atom.labelLiteral === true) {
      const spelled = nativeSingleHeavyElementLabelValence(symbol);
      if (spelled && !nativeLiteralAtomValenceComplete(spelled.element, valenceUsed + spelled.hydrogens, effectiveFormalCharge)) {
        return {
          atomId: atom.id,
          element: symbol,
          valenceUsed,
          formalCharge: effectiveFormalCharge,
          valid: false,
          invalidReason: `${symbol} atom ${atom.id} accounts for ${valenceUsed + spelled.hydrogens} of ${nativeAtomValenceForCharge(spelled.element, effectiveFormalCharge)} bonds.`
        };
      }
    }
    return {
      atomId: atom.id,
      element: symbol,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: true
    };
  }

  if (nativeAtomValence[element] === undefined || nativeAtomMaxValence[element] === undefined) {
    // Transition metals: variable oxidation states make hypovalence unjudgeable (a bare Pd is
    // a catalyst, not an error), but a bond count beyond the element's highest known
    // coordination number is a drawing mistake worth the badge.
    const metalCeiling = nativeMetalMaxCoordination[element];
    // Coordination counts ligand attachments, including dashed dative contacts, rather than
    // covalent valence; radical slots still occupy one site just as they do in valence checking.
    const coordinationUsed = bonds.reduce((count, bond) => (
      bond.fromAtomId === atom.id || bond.toAtomId === atom.id ? count + 1 : count
    ), atom.markRadicals ?? 0);
    if (metalCeiling !== undefined && coordinationUsed > metalCeiling) {
      return {
        atomId: atom.id,
        element,
        valenceUsed,
        formalCharge: effectiveFormalCharge,
        valid: false,
        invalidReason: `${element} atom ${atom.id} has ${coordinationUsed} bonds; ${element} is not known beyond ${metalCeiling}-coordinate.`
      };
    }
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: true
    };
  }

  if (nativeAtomFormalChargeForValence(element, valenceUsed) === undefined && !nativeAtomChargeSupportsValence(element, valenceUsed, effectiveFormalCharge)) {
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: false,
      invalidReason: `${element} atom ${atom.id} has unsupported valence ${valenceUsed}.`
    };
  }

  if (!nativeAtomChargeSupportsValence(element, valenceUsed, effectiveFormalCharge)) {
    const expectedFormalCharge = nativeAtomSuggestedChargeForValence(element, valenceUsed);
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      ...(expectedFormalCharge === undefined ? {} : { expectedFormalCharge }),
      valid: false,
      invalidReason: expectedFormalCharge === undefined
        ? `${element} atom ${atom.id} has charge ${effectiveFormalCharge}, unsupported for valence ${valenceUsed}.`
        : `${element} atom ${atom.id} has charge ${effectiveFormalCharge}, expected ${expectedFormalCharge} for valence ${valenceUsed}.`
    };
  }

  // A literal label (typed with the text tool) has no implicit hydrogens to fill the
  // remainder, so its drawn bonds (plus radicals) must land on a complete valence state by
  // themselves — a lone typed "N" is a flagged hypovalent atom until three bonds arrive.
  // This is the ONLY path that can produce a hypovalent atom: drawn atoms and hotkey
  // relabels keep the skeletal implicit-hydrogen convention and never trip it.
  if (atom.labelLiteral === true && !nativeLiteralAtomValenceComplete(element, valenceUsed, effectiveFormalCharge)) {
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: false,
      invalidReason: `${element} atom ${atom.id} has ${valenceUsed} of ${nativeAtomValenceForCharge(element, effectiveFormalCharge)} bonds.`
    };
  }

  return {
    atomId: atom.id,
    element,
    valenceUsed,
    formalCharge: effectiveFormalCharge,
    expectedFormalCharge: effectiveFormalCharge,
    valid: true
  };
}

/**
 * Parse an arbitrary atom label as a condensed formula of known elements ("CH3" → C1 H3,
 * "CO2H" → C1 O2 H1). Undefined when any token is not a plain element symbol ("OMe", "Ph",
 * "R1") — those abbreviations contribute nothing rather than a wrong count.
 *
 * Honest limitation: a label that DOES tokenize into element symbols is counted as those
 * elements, so abbreviations that collide with element symbols are miscounted — "OAc" reads as
 * O + Ac (actinium), "Ts" as tennessine, "Pr" as praseodymium, "Am"/"No" likewise. That affects
 * only the formula/mass bookkeeping here; valence never consults this parse
 * (`nativeSingleHeavyElementLabelValence` applies its own stricter check).
 */
function parseCondensedLabelFormula(label: string): Map<string, number> | undefined {
  const trimmed = label.trim();
  if (!/^(?:[A-Z][a-z]?\d*)+$/.test(trimmed)) {
    return undefined;
  }

  const counts = new Map<string, number>();
  for (const token of trimmed.matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    if (!token[1]) {
      continue;
    }
    const element = nativeElementFromAtomLabel(token[1]);
    if (!element) {
      return undefined;
    }
    counts.set(element, (counts.get(element) ?? 0) + (token[2] ? Number(token[2]) : 1));
  }

  return counts.size > 0 ? counts : undefined;
}

export function nativeSingleBondGraphMetadata(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ChemicalMetadata {
  const elementCounts = new Map<string, number>();
  const valenceUsage = atomBondOrderUsageMap(atoms, bonds);
  const totalCharge = atoms.reduce((sum, atom) => sum + atom.formalCharge, 0);
  const radicalCount = atoms.reduce((sum, atom) => sum + (atom.markRadicals ?? 0), 0);
  const warnings = nativeInvalidAtomWarnings(atoms, bonds);

  atoms.forEach((atom) => {
    if (atom.element === "D" || atom.element === "T") {
      // Heavy hydrogen keeps its own symbol in the formula (CH3D) and its own mass, matching
      // the [2H]/[3H] the SMILES writer spells for the same atom.
      elementCounts.set(atom.element, (elementCounts.get(atom.element) ?? 0) + 1);
      return;
    }
    const element = nativeElementFromAtomLabel(atom.element);
    if (!element) {
      // A condensed label is its own recipe — count exactly what it spells, no implicit H.
      parseCondensedLabelFormula(atom.element)?.forEach((count, labelElement) => {
        elementCounts.set(labelElement, (elementCounts.get(labelElement) ?? 0) + count);
      });
      return;
    }
    elementCounts.set(element, (elementCounts.get(element) ?? 0) + 1);

    // A literal label (typed with the text tool) contributes exactly what it says — the
    // formula must not invent hydrogens for it: a lone typed "C" is C, not CH4. Drawn atoms
    // keep the skeletal convention and count their implicit hydrogens.
    const valenceUsed = valenceUsage.get(atom.id) ?? 0;
    if (element !== "H" && atom.labelLiteral !== true) {
      const implicitHydrogens = Math.max(0, nativeImplicitHydrogenCount(
        element,
        valenceUsed,
        atom.formalCharge,
        atom.markRadicals ?? 0
      ) - dativeDeprotonationCount(atom, bonds, atoms));
      elementCounts.set("H", (elementCounts.get("H") ?? 0) + implicitHydrogens);
    }
  });

  // Every key is an element the label parser produced, and the table covers every element the
  // parser knows, so a miss here is a programming error and throws — never a silent 0 that
  // leaves the weight short by an atom the formula lists.
  const averageMass = [...elementCounts.entries()].reduce(
    (sum, [element, count]) => sum + nativeElementMass(element).average * count,
    0
  );
  const exactMass = [...elementCounts.entries()].reduce(
    (sum, [element, count]) => sum + nativeElementMass(element).exact * count,
    0
  );

  return {
    formula: formulaFromElementCounts(elementCounts),
    averageMass: Number(averageMass.toFixed(3)),
    exactMass: Number(exactMass.toFixed(5)),
    atomCount: atoms.length,
    bondCount: bonds.length,
    totalCharge,
    radicalCount,
    isotopeLabels: [],
    stereochemistry: [],
    warnings
  };
}

function formulaFromElementCounts(counts: ReadonlyMap<string, number>): string {
  const carbonCount = counts.get("C") ?? 0;
  const remainingElements = [...counts.keys()]
    .filter((element) => element !== "C" && element !== "H")
    .sort();
  const orderedElements = carbonCount > 0
    ? ["C", "H", ...remainingElements]
    : [...counts.keys()].sort();

  return orderedElements
    .map((element) => ({ element, count: counts.get(element) ?? 0 }))
    .filter(({ count }) => count > 0)
    .map(({ element, count }) => `${element}${count === 1 ? "" : count}`)
    .join("") || "C0H0";
}

/**
 * Implicit hydrogens for the molecular formula, from the SAME derivation the drawn label uses.
 *
 * This counted against the neutral valence table and ignored `formalCharge`, so once
 * `atomDisplayLabel` became charge-aware the two disagreed: methoxide drew as "O-" with no hydrogen
 * while the formula still reported CH4O. A formula that contradicts the depiction beside it is
 * worse than either being wrong alone, and AGENTS.md 5.26 puts atom-label content in layout-engine.
 */
export function nativeImplicitHydrogenCount(
  element: NativeElementSymbol,
  valenceUsed: number,
  formalCharge: number,
  radicals = 0
): number {
  return Math.max(0, nativeAtomValenceForCharge(element, formalCharge) - valenceUsed - radicals);
}

/**
 * Whether an atom of this element can legally carry `formalCharge` at `valenceUsed` drawn bonds.
 *
 * The octet-derived bond capacity (`nativeAtomValenceForCharge`, the same derivation the drawn
 * label and formula use) fills any shortfall with implicit hydrogens, so any usage at or below
 * that capacity is fine: O⁻ with one bond is a drawn alkoxide/carboxylate, not an error — the
 * old single-expected-charge rule flagged exactly that. The canonical-charge arm keeps the
 * hypervalent neutrals (P(V), S(IV), S(VI)) that the octet count cannot express.
 */
export function nativeAtomChargeSupportsValence(
  element: NativeElementSymbol,
  valenceUsed: number,
  formalCharge: number
): boolean {
  // Elements outside the covalent valence tables (transition metals, alkali/alkaline-earth)
  // have variable oxidation states the octet math cannot bound: any charge mark associates —
  // a solid-bonded Zn still takes its 2+.
  if (nativeAtomValence[element] === undefined || nativeAtomMaxValence[element] === undefined) {
    return true;
  }

  const maxValence = nativeAtomMaxValence[element];
  if (maxValence !== undefined && valenceUsed > maxValence) {
    return false;
  }

  // nativeAtomValenceForCharge collapses to 0 both when the charge legitimately leaves no room
  // for more bonds (H+ has none) AND when the charge itself isn't chemically expressible (a
  // carbon can't lose 12 electrons) — the two must not be conflated, or a zero-valence atom
  // (valenceUsed 0) trivially "supports" any charge magnitude via 0 <= 0.
  if (!nativeAtomChargeIsExpressible(element, formalCharge)) {
    return false;
  }

  return valenceUsed <= nativeAtomValenceForCharge(element, formalCharge) ||
    nativeAtomFormalChargeForValence(element, valenceUsed) === formalCharge;
}

/** The smallest-magnitude charge that would make `valenceUsed` legal — the fix a charge tool offers. */
function nativeAtomSuggestedChargeForValence(
  element: NativeElementSymbol,
  valenceUsed: number
): number | undefined {
  const candidate = [0, -1, 1, -2, 2].find((charge) =>
    nativeAtomChargeSupportsValence(element, valenceUsed, charge)
  );
  return candidate ?? nativeAtomFormalChargeForValence(element, valenceUsed);
}

/**
 * Whether a bond count is a COMPLETE H-free valence state for this element/charge — the test
 * literal (text-typed) atoms must pass, since nothing fills their remainder with implicit
 * hydrogens. Complete means the octet-derived count for the charge, or any bond count whose
 * canonical charge for that count matches (`nativeAtomFormalChargeForValence`): the neutral
 * hypervalent states the octet arithmetic cannot express (P(V), As(V), the S/Se/Te (IV)/(VI)
 * family, halogen (III)/(V)/(VII)) and charged states like ammonium. That list is illustrative,
 * not exhaustive.
 */
function nativeLiteralAtomValenceComplete(
  element: NativeElementSymbol,
  valenceUsed: number,
  formalCharge: number
): boolean {
  if (valenceUsed === nativeAtomValenceForCharge(element, formalCharge)) {
    return true;
  }
  return valenceUsed > (nativeAtomValence[element] ?? 0) &&
    nativeAtomFormalChargeForValence(element, valenceUsed) === formalCharge;
}

/**
 * Read a condensed label as ONE heavy element plus its spelled hydrogens ("NH2" → N + 2,
 * "OH" → O + 1). Undefined for anything else — multiple heavy atoms, abbreviations, pure-H
 * labels — which stay unchecked superatoms.
 */
export function nativeSingleHeavyElementLabelValence(
  label: string
): { element: NativeElementSymbol; hydrogens: number } | undefined {
  const counts = parseCondensedLabelFormula(label);
  if (!counts) {
    return undefined;
  }

  const heavyElements = [...counts.keys()].filter((element) => element !== "H");
  const heavy = heavyElements[0];
  if (heavyElements.length !== 1 || counts.get(heavy) !== 1) {
    return undefined;
  }
  const element = heavy as NativeElementSymbol;
  if (nativeAtomValence[element] === undefined || nativeAtomMaxValence[element] === undefined) {
    return undefined;
  }

  return { element, hydrogens: counts.get("H") ?? 0 };
}

export function nativeAtomFormalChargeForValence(
  element: NativeElementSymbol,
  valenceUsed: number
): number | undefined {
  const neutralValence = nativeAtomValence[element];
  const maxValence = nativeAtomMaxValence[element];
  if (neutralValence === undefined || maxValence === undefined) {
    return undefined;
  }

  if (valenceUsed < 0 || valenceUsed > maxValence) {
    return undefined;
  }

  if (valenceUsed <= neutralValence) {
    return 0;
  }

  if ((element === "B" || element === "Al") && valenceUsed === 4) {
    return -1;
  }

  if ((element === "N" || element === "O") && valenceUsed === neutralValence + 1) {
    return 1;
  }

  if ((element === "P" || element === "As") && valenceUsed === 4) {
    return 1;
  }

  // Neutral hypervalent states: P(V)/As(V), the S/Se/Te (IV) and (VI) families, and the heavy
  // halogens' (III)/(V)/(VII) — lambda-3/-5 iodanes up through periodate.
  if ((element === "P" || element === "As") && valenceUsed === 5) {
    return 0;
  }

  if ((element === "S" || element === "Se" || element === "Te") && (valenceUsed === 4 || valenceUsed === 6)) {
    return 0;
  }

  if ((element === "Cl" || element === "Br" || element === "I") && (valenceUsed === 3 || valenceUsed === 5 || valenceUsed === 7)) {
    return 0;
  }

  return undefined;
}

function nativeInvalidAtomWarnings(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): CompatibilityWarning[] {
  return atoms
    .map((atom) => nativeAtomValidationState(atom, bonds))
    .filter((state) => !state.valid)
    .map((state) => ({
      code: "chemistry.invalid_valence",
      message: state.invalidReason ?? `${state.element} atom ${state.atomId} has invalid valence.`,
      objectId: state.atomId
    }));
}

/**
 * A dashed single bond depicts a dative or partial interaction — a coordinate bond to a metal, a
 * hydrogen bond, a forming/breaking bond — and occupies no covalent valence slot on either
 * atom: pyridine's N keeps its three bonds and no badge while dash-bonded to a zinc.
 */
export function nativeBondValenceContribution(bond: MoleculeBond): number {
  return isDativeBond(bond) ? 0 : nativeBondOrderValue[bond.order] ?? 1;
}

export function atomBondOrderUsageMap(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ReadonlyMap<string, number> {
  const usage = new Map(atoms.map((atom) => [atom.id, 0]));
  bonds.forEach((bond) => {
    const value = nativeBondValenceContribution(bond);
    usage.set(bond.fromAtomId, (usage.get(bond.fromAtomId) ?? 0) + value);
    usage.set(bond.toAtomId, (usage.get(bond.toAtomId) ?? 0) + value);
  });

  return usage;
}

export function nativeAtomBondOrderUsage(atomId: string, bonds: readonly MoleculeBond[]): number {
  return bonds.reduce((sum, bond) => (
    bond.fromAtomId === atomId || bond.toAtomId === atomId
      ? sum + nativeBondValenceContribution(bond)
      : sum
  ), 0);
}
