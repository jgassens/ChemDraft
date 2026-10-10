// Element tables, valence and charge rules, atom validation, and atom-label reading for native
// molecules. The validation and tables began as a move from apps/desktop/src/documentWorkflow.ts; see
// this package's README.

import {
  type ChemicalMetadata,
  type CompatibilityWarning,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject
} from "@chemdraft/chem-core";
import {
  dativeDeprotonationCount,
  nativeAtomChargeIsExpressible,
  nativeAtomValenceForCharge,
  nativeBondOrderResolution,
  nativeElementFromAtomLabel,
  type NativeBondOrderResolution,
  type NativeElementSymbol
} from "@chemdraft/layout-engine";
import {
  abbreviationBondedSpellings,
  abbreviationForBondedElementLabel,
  abbreviationForLabel,
  abbreviationSpellings,
  abbreviationSpellingSuggestion,
  bondedElementLabelMeaning,
  isBondedGenericAtomLabel,
  isGenericAtomLabel,
  type AbbreviationDefinition
} from "@chemdraft/template-library";

import {
  expandNativeLabelGroupsInGraph,
  labelGroupBondLength,
  labelGroupOpenDirections,
  nativeLabelGroupAttachment,
  type NativeLabelGroup,
  type NativeLabelGroupExpansionResult
} from "./labelGroups";

// The element table, label parsing and bond-order counting have ONE implementation, in
// layout-engine, because the drawn label counts with them too (AGENTS.md §5.26). These are the same
// functions under the same names, re-exported so existing importers of this package keep working.
export {
  atomBondOrderUsageMap,
  nativeAtomBondOrderUsage,
  nativeBondOrderResolution,
  type NativeBondOrderResolution,
  nativeBondOrderValue,
  nativeBondValenceContribution,
  nativeElementFromAtomLabel,
  type NativeElementSymbol,
  nativeElementSymbols,
  normalizeNativeAtomElementLabel
} from "@chemdraft/layout-engine";


export interface NativeAtomValidationState {
  atomId: string;
  element: string;
  valenceUsed: number;
  formalCharge: number;
  expectedFormalCharge?: number;
  valid: boolean;
  /** Why the badge shows, short enough for the status line ("OMe attaches by 1 bond; this atom has 2."). */
  invalidReason?: string;
  /**
   * The long form of `invalidReason`, naming the atom id and what the label counts as until it is
   * fixed: for logs, export warnings and agents, never the status line (AGENTS.md §13). Set by the
   * label checks; the older valence reasons carry their atom id in `invalidReason` itself.
   */
  invalidDetail?: string;
  /**
   * Set when the atom sits on aromatic bonds that could not be resolved into a Kekulé pattern: its
   * valence was counted with those bonds as single, which is a guess the badge has to show.
   */
  unresolvedAromatic?: true;
  /**
   * Set when an unstated ring hydrogen count, tautomer or closed-shell fallback was inferred.
   * A unique placement still gets a badge when the five-ring default supplied its H count.
   */
  tautomerGuessed?: true;
  /** Set when the label is not an element, a condensed formula, an abbreviation or a placeholder. */
  unrecognizedLabel?: true;
}

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

/**
 * `atoms` is the whole molecule: an aromatic bond is counted at its Kekulé order, and resolving
 * that needs every ring atom. Left out, an atom on an aromatic bond is reported unresolved.
 */
export function nativeAtomValidationState(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[],
  effectiveFormalCharge = atom.formalCharge,
  atoms: readonly MoleculeAtom[] = [atom],
  resolution: NativeBondOrderResolution = nativeBondOrderResolution(atoms, bonds)
): NativeAtomValidationState {
  const element = nativeElementFromAtomLabel(atom.element);
  // Unpaired electrons from associated radical marks occupy bonding slots like bonds do.
  const valenceUsed = (resolution.bondOrderUsage.get(atom.id) ?? 0) + (atom.markRadicals ?? 0);

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

  // Aromatic bonds with no Kekulé pattern were counted as single so the formula and label still
  // have a number, but that number is a guess: say so on the atom rather than let it pass.
  // A stated count is a number, not just an N–H toggle. Check it even on charged atoms and
  // on fallback readings; the warning must say exactly which source constraint could not hold.
  // The count was stated to settle an aromatic ring; on an atom with no aromatic bond left it
  // describes a graph that no longer exists, so it is ignored rather than badged. The resolution's
  // bonds are already rewritten, so an aromatic bond shows as a Kekulé order or an unresolved atom.
  const statedCount = atom.hydrogenCount;
  const hint = statedCount !== undefined && (resolution.unresolvedAtomIds.has(atom.id) ||
    (resolution.bondsByAtom.get(atom.id) ?? []).some((bond) => resolution.kekuleOrders.has(bond.id)))
    ? statedCount
    : undefined;
  if (hint !== undefined && element) {
    const resolvedHydrogens = atom.labelLiteral === true ? 0 : Math.max(0,
      nativeAtomValenceForCharge(element, effectiveFormalCharge) - valenceUsed
      - dativeDeprotonationCount(atom, bonds, atoms, resolution));
    if (resolvedHydrogens !== hint) {
      return {
        atomId: atom.id,
        element,
        valenceUsed,
        formalCharge: effectiveFormalCharge,
        valid: false,
        ...(resolution.unresolvedAtomIds.has(atom.id) ? { unresolvedAromatic: true as const } : {}),
        invalidReason: `${element} atom ${atom.id} states ${hint} hydrogens (NumHydrogens), but its bonds and charge resolve to ${resolvedHydrogens}; the stated count could not be honoured.`
      };
    }
  }
  if (resolution.unresolvedAtomIds.has(atom.id)) {
    const symbol = element ?? (atom.element.trim() || "(blank)");
    return {
      atomId: atom.id,
      element: symbol,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: false,
      unresolvedAromatic: true,
      invalidReason: `${symbol} atom ${atom.id} is on aromatic bonds that could not be resolved into alternating single and double bonds; its hydrogen count assumes single bonds.`
    };
  }

  // An unstated N–H, a tautomer choice or a closed-shell fallback is still an inferred hydrogen
  // count, even when only one placement fits (owner decision 2026-09-27).
  if (resolution.inferredHydrogenAtomIds.has(atom.id)) {
    const symbol = element ?? (atom.element.trim() || "(blank)");
    return {
      atomId: atom.id,
      element: symbol,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: false,
      tautomerGuessed: true,
      invalidReason: `${symbol} atom ${atom.id}: the aromatic bonds do not state its hydrogen count, so its hydrogen count was guessed using a closed-shell reading. Draw the H explicitly to settle it.`
    };
  }

  // An element symbol chemists write on bonds ("Ac", "Pr", "Ts"), typed as a label, is that group on
  // a bonded atom, so it is checked as one: a "Ts" with two bonds is a tosyl with one too many, not
  // tennessine. An element from a structure file (no `labelLiteral`) stays the element.
  if (element && atom.labelLiteral === true && (resolution.bondsByAtom.get(atom.id)?.length ?? 0) > 0) {
    const bondedReading = nativeAtomLabelReading(atom.element, { bonded: true, typed: true });
    if (bondedReading.kind === "group") {
      return nativeLabelGroupValidationState(atom, atom.element.trim(), bondedReading.group, valenceUsed, effectiveFormalCharge);
    }
  }

  if (!element) {
    const symbol = atom.element.trim() || "(blank)";
    const reading = nativeAtomLabelReading(atom.element);
    // An abbreviation ("OMe", "Ph") or a composite of one ("NMe2") spells its whole group,
    // hydrogens included, so the label's bonds must fill exactly the group's free valence —
    // whether the label was typed or placed by a hotkey. "OMe" on a ring carbon is an O with
    // three bonds and is flagged like one; a lone "OMe" is an open CH3O fragment.
    if (reading.kind === "group") {
      return nativeLabelGroupValidationState(atom, symbol, reading.group, valenceUsed, effectiveFormalCharge);
    }
    // Not an element, a formula, an abbreviation or a deliberate placeholder: text, not structure.
    // It counts nothing, so the formula beside it is short by whatever it was meant to be — say so.
    if (reading.kind === "unrecognized") {
      return {
        atomId: atom.id,
        element: symbol,
        valenceUsed,
        formalCharge: effectiveFormalCharge,
        valid: false,
        unrecognizedLabel: true,
        invalidReason: reading.suggestion
          ? `${symbol} isn't a known group. Did you mean ${reading.suggestion}?`
          : `${symbol} isn't an element or a known group.`,
        invalidDetail: `Label "${symbol}" on atom ${atom.id} is not an element, a condensed formula or a known abbreviation, so it is text, not structure: it counts nothing in the formula and exports as a placeholder.${
          reading.suggestion ? ` Abbreviations are case-sensitive; did you mean "${reading.suggestion}"?` : ""
        }`
      };
    }
    // A literal condensed label spelling one heavy element plus hydrogens ("NH2", "OH2",
    // "CH3") is checkable: its own hydrogens count toward the valence, so a naked typed
    // "OH2" is complete water while a naked neutral "CH3" is a flagged methyl fragment.
    // Multi-heavy condensed formulas ("CONH2") and generic placeholders ("R") are not checked.
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
    const coordinationUsed = (resolution.bondsByAtom.get(atom.id)?.length ?? 0) + (atom.markRadicals ?? 0);
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

/** How an atom label reads. `nativeAtomLabelReading` tries the readings in this order. */
export type NativeAtomLabelReading =
  /** An element symbol, matched ignoring case ("cl" is chlorine). */
  | { kind: "element"; element: NativeElementSymbol }
  /** Deuterium or tritium. */
  | { kind: "heavy-hydrogen"; element: "D" | "T" }
  /** One heavy element and the hydrogens it states: "OH", "NH2", "CH3". */
  | { kind: "spelled"; element: NativeElementSymbol; hydrogens: number }
  /** A table abbreviation ("OMe") or an element carrying them ("NMe2"); case-sensitive. */
  | { kind: "group"; group: NativeLabelGroup }
  /** A deliberate placeholder ("R", "X", "?"): no structure, and not a mistake. */
  | { kind: "generic" }
  /** A condensed formula with no connectivity the app can read ("CONH2"): counted, never checked. */
  | { kind: "formula"; counts: ReadonlyMap<string, number> }
  /** None of the above ("Ome"): text, not structure, and flagged as such. */
  | { kind: "unrecognized"; suggestion?: string };

/** What the label's atom is attached to, where a reading depends on it. */
export interface NativeAtomLabelContext {
  /** The atom has at least one bond. Decides "Ar": aryl when bonded, argon when not. */
  bonded?: boolean;
  /**
   * The label was entered as text — typed in the label editor or text tool, or a file's text label —
   * rather than stored as an element of a structure. Only a typed "Ar", "Ac", "Pr" or "Ts" means a
   * group: an element read from a molfile, a SMILES or a numeric CDXML `Element` stays that
   * element even on a bond, so a real Ac–Cl bond is never acetyl chloride. Callers reading a stored
   * atom pass its `labelLiteral`; omitted, it counts as typed (a label someone is typing now).
   */
  typed?: boolean;
}

/**
 * What an atom label means to the chemistry. Elements win over everything (so "Ac" is actinium,
 * never acetyl); then the abbreviation table, then one heavy element with its hydrogens, then an
 * element carrying abbreviations, then deliberate placeholders, then a bare condensed formula.
 * Abbreviation matching is case-sensitive (owner decision, 2026-10-10): "OMe" is methoxy, "Ome"
 * is unrecognized text — the suggestion names "OMe" so the message can say so.
 *
 * The exceptions to "elements first" are labels chemists write on bonds that are also element
 * symbols. Typed on an atom with bonds, "Ar" is aryl (a generic placeholder), and "Ac", "Pr" and
 * "Ts" are acetyl, n-propyl and tosyl (the table's `bondedSpellings`). An unbonded one, or one that
 * came from a structure rather than typed text (`context.typed: false`), is the element: argon,
 * actinium, praseodymium, tennessine. Exact case only.
 */
export function nativeAtomLabelReading(label: string, context: NativeAtomLabelContext = {}): NativeAtomLabelReading {
  const trimmed = label.trim();
  if (trimmed === "D" || trimmed === "T") {
    return { kind: "heavy-hydrogen", element: trimmed };
  }
  if (context.bonded === true && context.typed !== false) {
    if (isBondedGenericAtomLabel(trimmed)) {
      return { kind: "generic" };
    }
    // "Ac", "Pr", "Ts" on a bond are acetyl, n-propyl and tosyl, never actinium, praseodymium or
    // tennessine; unbonded, they fall through to their elements below.
    const bondedGroup = abbreviationForBondedElementLabel(trimmed);
    if (bondedGroup) {
      return { kind: "group", group: { kind: "abbreviation", label: trimmed, definition: bondedGroup } };
    }
  }
  const element = nativeElementFromAtomLabel(trimmed);
  if (element) {
    return { kind: "element", element };
  }
  const definition = abbreviationForLabel(trimmed);
  if (definition) {
    return { kind: "group", group: { kind: "abbreviation", label: trimmed, definition } };
  }
  const spelled = nativeSingleHeavyElementLabelValence(trimmed);
  if (spelled) {
    return { kind: "spelled", ...spelled };
  }
  const composite = nativeCompositeLabelGroup(trimmed);
  if (composite) {
    return { kind: "group", group: composite };
  }
  // A blank label only exists mid-edit; it is not a claim about chemistry.
  if (trimmed.length === 0 || isGenericAtomLabel(trimmed)) {
    return { kind: "generic" };
  }
  const counts = parseCondensedLabelFormula(trimmed);
  if (counts) {
    return { kind: "formula", counts };
  }
  const suggestion = abbreviationSpellingSuggestion(trimmed);
  return { kind: "unrecognized", ...(suggestion ? { suggestion } : {}) };
}

/** One-letter halogens, never split off a two-letter symbol to head a composite. */
const splitHeadHalogens: ReadonlySet<string> = new Set(["F", "I"]);

/** Every spelling a composite's substituent can take, longest first: "CO2Me" before "Me". */
const compositeTokenSpellings: readonly string[] = [...abbreviationSpellings, ...abbreviationBondedSpellings]
  .sort((left, right) => right.length - left.length || left.localeCompare(right));

/**
 * Substituent spellings read only after their head, at the end of the label. Written before the
 * head, "CN" puts its N, not its C, next to it: "CNO", "CNS" and "CNCH2" are not cyanato,
 * thiocyanato and cyanomethyl, so they stay bare formulas rather than become the wrong isomer.
 */
const trailingOnlyCompositeSpellings: ReadonlySet<string> = new Set(["CN"]);

/**
 * An element carrying abbreviations, read the way chemists write one: "NMe2", "NHBoc", "OTBS",
 * "CH2Ph", "SiMe3", and right-to-left for a bond on the label's right ("Me2N", "BocHN", "PhCH2").
 * Exactly one heavy element — the head, which every bond to the label reaches — any hydrogens,
 * and at least one table abbreviation, each bonded to the head. Tokens are matched case-sensitively,
 * abbreviations first (longest spelling wins), so "OMe" inside "CH2OMe" is methoxy, not O + "Me".
 *
 * Not read as a group: a second heavy element ("SO2Ph"), a count on the head ("C2H4Ph"), and a
 * head written directly before "O" ("COEt", "SOMe") — there the O is conventionally an oxo group,
 * C(=O)Et, which this grammar does not model; reading it as C–OEt would invent a different
 * structure, so the label stays unrecognized instead. Nor is a trailing-only spelling ("CN") read
 * anywhere but last, after its head (`trailingOnlyCompositeSpellings`).
 *
 * A substituent in a composite is bonded to the head by definition, so the bonded-only spellings
 * count as groups here: "NHAc" is an acetamide N, "OTs" a tosylate O, "NPr2" a dipropylamino N.
 */
function nativeCompositeLabelGroup(label: string): NativeLabelGroup | undefined {
  let head: NativeElementSymbol | undefined;
  let headEnd = -1;
  let hydrogens = 0;
  const substituents: AbbreviationDefinition[] = [];
  let index = 0;
  const readCount = (): number | undefined => {
    const digits = /^\d*/.exec(label.slice(index))![0];
    index += digits.length;
    if (digits.length === 0) return 1;
    const count = Number(digits);
    return count >= 1 && count <= 4 ? count : undefined;
  };
  while (index < label.length) {
    const spelling = compositeTokenSpellings.find((candidate) => label.startsWith(candidate, index));
    if (spelling) {
      if (index === headEnd && spelling.startsWith("O")) return undefined;
      index += spelling.length;
      const definition = (abbreviationForLabel(spelling) ?? abbreviationForBondedElementLabel(spelling))!;
      const count = readCount();
      if (count === undefined || definition.attachmentCount !== 1) return undefined;
      if (trailingOnlyCompositeSpellings.has(spelling) && (head === undefined || index < label.length)) return undefined;
      for (let copy = 0; copy < count; copy += 1) substituents.push(definition);
      continue;
    }
    // An element symbol in its own case; the second letter must be lower case, so "NMe" is N + Me.
    // A lower-case letter that starts an abbreviation belongs to it, not to the symbol, when the
    // two letters could not be a head anyway: "NiPr2" is N + iPr + iPr (nickel has no covalent
    // valence to carry them), "PtBu2" is P + tBu + tBu, and "OtBu" is O + tBu ("Ot" is no element).
    // A symbol that can be a head keeps both letters: "SnMe3" is tin and "SiPr3" silicon, never
    // S + nMe or S + iPr. Nor is a halogen ever the split head: "InBu3" would otherwise become
    // iodine carrying three butyls, which reads as a valid λ3-iodane instead of indium.
    let symbol = /^[A-Z][a-z]?/.exec(label.slice(index))?.[0];
    if (
      symbol?.length === 2 &&
      nativeAtomValence[symbol as NativeElementSymbol] === undefined &&
      !splitHeadHalogens.has(symbol.slice(0, 1)) &&
      compositeTokenSpellings.some((candidate) => /^[a-z]/.test(candidate) && label.startsWith(candidate, index + 1))
    ) {
      symbol = symbol.slice(0, 1);
    }
    const symbolElement = symbol ? nativeElementFromAtomLabel(symbol) : undefined;
    if (!symbol || symbolElement !== symbol) return undefined;
    if (index === headEnd && symbol === "O") return undefined;
    index += symbol.length;
    const count = readCount();
    if (count === undefined) return undefined;
    if (symbolElement === "H") {
      hydrogens += count;
      continue;
    }
    if (head !== undefined || count !== 1 || nativeAtomValence[symbolElement] === undefined) return undefined;
    head = symbolElement;
    headEnd = index;
  }
  return head !== undefined && substituents.length > 0
    ? { kind: "composite", label, head, hydrogens, substituents }
    : undefined;
}

/**
 * Whether a group's label bonds fill its free valence, and what would fix them if not.
 *
 * The attachment atom is judged as a literal atom — the group states all of its hydrogens — at the
 * group's own internal valence plus the label's bonds and radicals, and at the group's charge plus
 * the label's: "OMe" on a ring carbon is an O with three bonds (invalid neutral, valid as O⁺); a lone
 * "OMe" is an O with one (an open fragment), unless a −1 charge makes it methoxide. A metal
 * attachment ("MgBr") follows the metal rule elsewhere in this file: never hypovalent, flagged only
 * past the table's stated free valence.
 */
export function nativeLabelGroupVerdict(
  group: NativeLabelGroup,
  externalValence: number,
  labelCharge: number
): { valid: boolean; expectedBondCount?: number; expectedFormalCharge?: number } {
  if (nativeLabelGroupCompletes(group, externalValence, labelCharge)) {
    return { valid: true };
  }
  const expectedBondCount = nativeLabelGroupFreeValence(group, labelCharge);
  const expectedFormalCharge = [0, -1, 1, -2, 2].find((charge) => nativeLabelGroupCompletes(group, externalValence, charge));
  return {
    valid: false,
    ...(expectedBondCount !== undefined ? { expectedBondCount } : {}),
    ...(expectedFormalCharge !== undefined ? { expectedFormalCharge } : {})
  };
}

/** Whether `externalValence` (bond orders plus radicals) completes the group at the label's charge. */
function nativeLabelGroupCompletes(group: NativeLabelGroup, externalValence: number, labelCharge: number): boolean {
  const attachment = nativeLabelGroupAttachment(group);
  const element = attachment.element as NativeElementSymbol;
  return nativeAtomValence[element] !== undefined && nativeAtomMaxValence[element] !== undefined
    ? nativeLiteralAtomValenceComplete(element, attachment.internalValence + externalValence, attachment.charge + labelCharge)
    : externalValence <= (attachment.declaredAttachmentCount ?? 0);
}

/**
 * The bonds a group takes at a label charge: its free valence — the fewest bonds that complete it.
 * OMe and Ph take 1, NMe and CMe2 take 2, NMe3 takes 0 (and 1 as NMe3⁺), Ms takes 1 (S(VI)), and a
 * metal attachment takes what the table states (MgBr 1). Undefined when no bond count completes
 * the group at that charge.
 */
export function nativeLabelGroupFreeValence(group: NativeLabelGroup, labelCharge = 0): number | undefined {
  const attachment = nativeLabelGroupAttachment(group);
  const element = attachment.element as NativeElementSymbol;
  if (nativeAtomValence[element] === undefined || nativeAtomMaxValence[element] === undefined) {
    return attachment.declaredAttachmentCount;
  }
  return [...Array(nativeAtomInvalidGrowthLimit + 1).keys()]
    .find((external) => nativeLabelGroupCompletes(group, external, labelCharge));
}

/**
 * The bonds a label takes when it states every hydrogen it has: a group's free valence
 * (`nativeLabelGroupFreeValence`), or a spelled label's ("OH" 1, "NH" 2, "CH2" 2). Undefined for an
 * element symbol — an element fills whatever valence its bonds leave with implicit hydrogens, so
 * it has no fixed count — and for labels that are not structure: placeholders ("R"), bare
 * formulas ("CONH2") and unrecognized text ("Ome").
 */
export function nativeAtomLabelFreeValence(
  label: string,
  labelCharge = 0,
  context: NativeAtomLabelContext = {}
): number | undefined {
  const reading = nativeAtomLabelReading(label, context);
  if (reading.kind === "group") {
    return nativeLabelGroupFreeValence(reading.group, labelCharge);
  }
  if (reading.kind === "spelled") {
    return [...Array(nativeAtomInvalidGrowthLimit + 1).keys()]
      .find((external) => nativeLiteralAtomValenceComplete(reading.element, reading.hydrogens + external, labelCharge));
  }
  return undefined;
}

/** The bond ceiling the drawing tools grow any atom to; a group never needs more. */
const nativeAtomInvalidGrowthLimit = 8;

function nativeLabelGroupValidationState(
  atom: MoleculeAtom,
  symbol: string,
  group: NativeLabelGroup,
  valenceUsed: number,
  effectiveFormalCharge: number
): NativeAtomValidationState {
  const verdict = nativeLabelGroupVerdict(group, valenceUsed, effectiveFormalCharge);
  if (verdict.valid) {
    return { atomId: atom.id, element: symbol, valenceUsed, formalCharge: effectiveFormalCharge, valid: true };
  }
  const expected = verdict.expectedBondCount;
  const charge = effectiveFormalCharge === 0
    ? "be neutral"
    : `carry charge ${effectiveFormalCharge > 0 ? "+" : ""}${effectiveFormalCharge}`;
  const bonds = `${expected} bond${expected === 1 ? "" : "s"}`;
  // Short for the status line, which shows the hovered atom ("this atom"); the detail names it.
  const reason = expected === undefined
    ? `${symbol} can't ${charge} with any number of bonds.`
    : expected === 0
      ? `${symbol} takes no bonds; this atom has ${valenceUsed}.`
      : `${symbol} attaches by ${bonds}; this atom has ${valenceUsed}.`;
  const problem = expected === undefined
    ? `"${symbol}" on atom ${atom.id} cannot ${charge}: no number of bonds completes it.`
    : expected === 0
      ? `"${symbol}" is complete by itself and takes no bonds; atom ${atom.id} has ${valenceUsed}.`
      : `"${symbol}" attaches by ${bonds}; atom ${atom.id} has ${valenceUsed}.`;
  return {
    atomId: atom.id,
    element: symbol,
    valenceUsed,
    formalCharge: effectiveFormalCharge,
    ...(verdict.expectedFormalCharge !== undefined && verdict.expectedFormalCharge !== effectiveFormalCharge
      ? { expectedFormalCharge: verdict.expectedFormalCharge }
      : {}),
    valid: false,
    invalidReason: reason,
    invalidDetail: `${problem} Until it does, the group counts nothing in the formula and exports as a placeholder.`
  };
}

/**
 * The labelled atoms whose groups can be written out as real atoms: those whose bonds fill the
 * group's free valence (`nativeLabelGroupVerdict`). A flagged group stays a placeholder everywhere —
 * formula, SMILES, molfile — until it is fixed, so no output claims a structure the badge calls
 * wrong. A dismissed badge does not change that: dismissing silences the warning, not the chemistry.
 */
export function nativeExpandableLabelGroups(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  resolution: NativeBondOrderResolution = nativeBondOrderResolution(atoms, bonds)
): Map<string, NativeLabelGroup> {
  const groups = new Map<string, NativeLabelGroup>();
  for (const atom of atoms) {
    // Bonded and typed, "Ac", "Pr" and "Ts" are groups too (`nativeAtomLabelReading`).
    const bonded = (resolution.bondsByAtom.get(atom.id)?.length ?? 0) > 0;
    const reading = nativeAtomLabelReading(atom.element, { bonded, typed: atom.labelLiteral === true });
    if (reading.kind !== "group" || resolution.unresolvedAtomIds.has(atom.id)) continue;
    const valenceUsed = (resolution.bondOrderUsage.get(atom.id) ?? 0) + (atom.markRadicals ?? 0);
    if (nativeLabelGroupVerdict(reading.group, valenceUsed, atom.formalCharge).valid) {
      groups.set(atom.id, reading.group);
    }
  }
  return groups;
}

/**
 * The molecule's graph with every valid group label written out as real atoms (see
 * `expandNativeLabelGroupsInGraph`): the form the formula, SMILES, molfile and analysis read, so all
 * of them describe the same structure. Drawn atoms keep their ids and indices.
 */
export function expandNativeLabelGroups(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): NativeLabelGroupExpansionResult {
  return expandNativeLabelGroupsWithStatedHydrogens(atoms, bonds, nativeExpandableLabelGroups(atoms, bonds));
}

/**
 * `expandNativeLabelGroupsInGraph`, with each group's stated hydrogens made explicit wherever the
 * valence model would not supply them. A group's attachment atom states its hydrogens ("SHMe" is an
 * S carrying one H); written out as an ordinary atom it gets the model's implicit count instead.
 * The two agree except where the group sits in a hypervalent state the octet count does not reach:
 * "SHMe" on two bonds is an S(IV) with an H, to which the model gives no implicit hydrogen while a
 * molfile reader gives one; "PH3Me" on a bond is a P(V) the model gives one implicit H instead of
 * three. There all the stated hydrogens are written as explicit H atoms — which fills the head's
 * valence, so nothing implicit is added on top — and the formula, the SMILES and every engine count
 * exactly the hydrogens the label states.
 */
function expandNativeLabelGroupsWithStatedHydrogens(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  groups: ReadonlyMap<string, NativeLabelGroup>
): NativeLabelGroupExpansionResult {
  const expanded = expandNativeLabelGroupsInGraph(atoms, bonds, groups);
  if (expanded.expansions.length === 0) {
    return expanded;
  }
  const resolution = nativeBondOrderResolution(expanded.atoms, expanded.bonds);
  const atomById = new Map(expanded.atoms.map((atom) => [atom.id, atom]));
  const usedAtomIds = new Set(expanded.atoms.map((atom) => atom.id));
  const usedBondIds = new Set(expanded.bonds.map((bond) => bond.id));
  const fresh = (used: Set<string>, base: string): string => {
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}_${suffix}`;
    used.add(id);
    return id;
  };
  const addedAtoms: MoleculeAtom[] = [];
  const addedBonds: MoleculeBond[] = [];
  const expansions = expanded.expansions.map((expansion) => {
    const group = groups.get(expansion.atomId);
    const atom = atomById.get(expansion.atomId);
    const element = atom ? nativeElementFromAtomLabel(atom.element) : undefined;
    if (!group || !atom || !element) return expansion;
    const stated = group.kind === "composite" ? group.hydrogens : group.definition.atoms[0]!.hydrogens;
    const implicit = nativeImplicitHydrogenCount(
      element, resolution.bondOrderUsage.get(atom.id) ?? 0, atom.formalCharge, atom.markRadicals ?? 0
    );
    if (stated <= implicit) return expansion;
    // Write every stated hydrogen, not just the shortfall: an explicit H uses a valence slot, so
    // adding only (stated − implicit) would eat the implicit ones it was meant to top up — a neutral
    // C–PH3Me head has one implicit H, and two more explicit ones would leave it with two, not three.
    // With all of them explicit the head's valence is full and the model adds none.
    const missing = stated;
    const neighborAngles = (resolution.bondsByAtom.get(atom.id) ?? [])
      .map((bond) => atomById.get(bond.fromAtomId === atom.id ? bond.toAtomId : bond.fromAtomId))
      .filter((neighbor): neighbor is MoleculeAtom => neighbor !== undefined)
      .map((neighbor) => Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x));
    const length = 0.6 * labelGroupBondLength(expanded.atoms, expanded.bonds);
    const hydrogenIds = labelGroupOpenDirections(neighborAngles, missing).map((direction, index) => {
      const id = fresh(usedAtomIds, `${atom.id}_h${index + 1}`);
      addedAtoms.push({
        id, element: "H", formalCharge: 0,
        x: atom.x + length * Math.cos(direction),
        y: atom.y + length * Math.sin(direction)
      });
      addedBonds.push({ id: fresh(usedBondIds, `${atom.id}_hb${index + 1}`), fromAtomId: atom.id, toAtomId: id, order: "single" });
      return id;
    });
    return { ...expansion, atomIds: [...expansion.atomIds, ...hydrogenIds] };
  });
  return {
    atoms: [...expanded.atoms, ...addedAtoms],
    bonds: [...expanded.bonds, ...addedBonds],
    expansions
  };
}

/**
 * `molecule` with its valid group labels written out (`expandNativeLabelGroups`), for a writer or
 * an engine; the same object when there is nothing to expand. `expansions` doubles as the molfile
 * writer's `superatomGroups`, so a file can carry each group's label beside its atoms, and
 * `placeholderAtoms` is its `placeholderAtoms`: element-symbol labels that stand for a group here.
 */
export function expandNativeMoleculeLabelGroups(molecule: MoleculeObject): {
  molecule: MoleculeObject;
  expansions: NativeLabelGroupExpansionResult["expansions"];
  placeholderAtoms: Map<string, string>;
} {
  const placeholderAtoms = nativeElementLabelPlaceholders(molecule.atoms, molecule.bonds);
  const expanded = expandNativeLabelGroups(molecule.atoms, molecule.bonds);
  return expanded.expansions.length === 0
    ? { molecule, expansions: [], placeholderAtoms }
    : { molecule: { ...molecule, atoms: expanded.atoms, bonds: expanded.bonds }, expansions: expanded.expansions, placeholderAtoms };
}

/**
 * Atoms whose label is an element symbol but which stand for something else on a bond and cannot be
 * written out as atoms, with the reason. A bonded "Ar" is aryl, a placeholder with no structure; a
 * bonded "Ac", "Pr" or "Ts" whose bonds don't fit its group is a flagged group. Counting or exporting
 * either as argon, actinium, praseodymium or tennessine would invent chemistry, so these count
 * nothing and export as warned placeholders, like any other placeholder label. A bonded "Ts" whose
 * bonds do fit is not listed: it is expanded into tosyl like any group.
 */
export function nativeElementLabelPlaceholders(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): Map<string, string> {
  const bonded = new Set(bonds.flatMap((bond) => [bond.fromAtomId, bond.toAtomId]));
  let expandable: ReadonlyMap<string, NativeLabelGroup> | undefined;
  const placeholders = new Map<string, string>();
  for (const atom of atoms) {
    const label = atom.element.trim();
    // Only a typed label carries the bonded meaning; an element from a structure file stays one.
    const meaning = atom.labelLiteral === true ? bondedElementLabelMeaning(label) : undefined;
    if (!bonded.has(atom.id) || meaning === undefined || nativeElementFromAtomLabel(label) === undefined) continue;
    expandable ??= nativeExpandableLabelGroups(atoms, bonds);
    if (!expandable.has(atom.id)) {
      placeholders.set(atom.id, `a bonded "${label}" is ${meaning}, not the element ${label}`);
    }
  }
  return placeholders;
}

/**
 * Parse an arbitrary atom label as a condensed formula of known elements ("CH3" → C1 H3,
 * "CO2H" → C1 O2 H1). Undefined when any token is not a plain element symbol ("OMe", "Ph",
 * "R1"). Groups are read before this ever runs (`nativeAtomLabelReading`), so "OAc" is acetoxy
 * from the abbreviation table, not O + Ac.
 *
 * Honest limitation: a label that is NOT a known group but DOES tokenize into element symbols
 * is counted as those elements, so a group the table lacks whose spelling collides with element
 * symbols is miscounted — "Ts" reads as tennessine, "Pr" as praseodymium, "NHAc" as N + H +
 * actinium. Valence never consults this parse (`nativeSingleHeavyElementLabelValence` applies
 * its own stricter check).
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
  // Aromatic bonds count at their Kekulé orders — the same bonds `atomDisplayLabel` counts, so the
  // formula's hydrogens are the ones the drawing shows.
  const drawnResolution = nativeBondOrderResolution(atoms, bonds);
  const totalCharge = atoms.reduce((sum, atom) => sum + atom.formalCharge, 0);
  const radicalCount = atoms.reduce((sum, atom) => sum + (atom.markRadicals ?? 0), 0);
  const warnings = nativeInvalidAtomWarnings(atoms, bonds, drawnResolution);
  // A valid group label ("OMe", "NMe2") is counted as the real atoms it stands for, through the
  // same per-atom arithmetic below — never as a formula added up by hand — so the formula is the
  // one an engine reads from the exported structure. A flagged group is not expanded and counts
  // nothing, like every other placeholder, until it is fixed.
  const expandableGroups = nativeExpandableLabelGroups(atoms, bonds, drawnResolution);
  const expanded = expandableGroups.size > 0
    ? expandNativeLabelGroupsWithStatedHydrogens(atoms, bonds, expandableGroups)
    : undefined;
  const countedAtoms = expanded?.atoms ?? atoms;
  const countedBonds = expanded?.bonds ?? bonds;
  const resolution = expanded ? nativeBondOrderResolution(countedAtoms, countedBonds) : drawnResolution;
  const valenceUsage = resolution.bondOrderUsage;
  // An element symbol standing for a group (a bonded "Ar", aryl) is a placeholder: it counts nothing.
  const placeholders = nativeElementLabelPlaceholders(atoms, bonds);

  countedAtoms.forEach((atom) => {
    if (placeholders.has(atom.id)) {
      return;
    }
    if (atom.element === "D" || atom.element === "T") {
      // Heavy hydrogen keeps its own symbol in the formula (CH3D) and its own mass, matching
      // the [2H]/[3H] the SMILES writer spells for the same atom.
      elementCounts.set(atom.element, (elementCounts.get(atom.element) ?? 0) + 1);
      return;
    }
    const element = nativeElementFromAtomLabel(atom.element);
    if (!element) {
      // A condensed label is its own recipe — count exactly what it spells, no implicit H.
      // Placeholders, unrecognized text and flagged groups count nothing.
      const reading = nativeAtomLabelReading(atom.element);
      const counts = reading.kind === "formula"
        ? reading.counts
        : reading.kind === "spelled" ? parseCondensedLabelFormula(atom.element) : undefined;
      counts?.forEach((count, labelElement) => {
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
      ) - dativeDeprotonationCount(atom, countedBonds, countedAtoms, resolution));
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
  bonds: readonly MoleculeBond[],
  resolution: NativeBondOrderResolution
): CompatibilityWarning[] {
  return atoms
    .map((atom) => nativeAtomValidationState(atom, bonds, atom.formalCharge, atoms, resolution))
    .filter((state) => !state.valid)
    .map((state) => ({
      code: state.unresolvedAromatic
        ? "chemistry.unresolved_aromatic"
        : state.tautomerGuessed
          ? "chemistry.aromatic_tautomer_guessed"
          : state.unrecognizedLabel ? "chemistry.unrecognized_label" : "chemistry.invalid_valence",
      message: state.invalidDetail ?? state.invalidReason ?? `${state.element} atom ${state.atomId} has invalid valence.`,
      objectId: state.atomId
    }));
}
