// The atom-label grammar: what a label's text means — an element, one heavy atom spelled with its
// hydrogens, a table abbreviation or an element carrying them, a placeholder, a bare formula, or
// unrecognized text. Pure text in, reading out: no geometry and no document. It lives in
// layout-engine so the drawn label can place and turn a group by the same reading the chemistry
// uses: one implementation (AGENTS.md §9). `@chemdraft/document-workflow-core` re-exports every
// name and keeps what is built on the reading: valence verdicts, validation and expansion.

import {
  abbreviationBondedSpellings,
  abbreviationForBondedElementLabel,
  abbreviationForLabel,
  abbreviationSpellings,
  abbreviationSpellingSuggestion,
  isBondedGenericAtomLabel,
  isGenericAtomLabel,
  type AbbreviationDefinition
} from "@chemdraft/template-library";

import { nativeElementFromAtomLabel, type NativeElementSymbol } from "./valence";

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

export const nativeAtomMaxValence: Partial<Record<NativeElementSymbol, number>> = {
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

/** What a label spells when it names a group. */
export type NativeLabelGroup =
  | {
      kind: "abbreviation";
      label: string;
      definition: AbbreviationDefinition;
    }
  | {
      /** One element carrying stated hydrogens and abbreviations, all bonded to it: "NMe2", "CH2Ph". */
      kind: "composite";
      label: string;
      head: string;
      hydrogens: number;
      /** One entry per substituent, repeated for a count: "NMe2" lists Me twice. */
      substituents: readonly AbbreviationDefinition[];
    };

/** The atom a group's label bonds connect to, as the group itself defines it. */
export interface NativeLabelGroupAttachment {
  element: string;
  /** Valence the attachment atom already uses inside the group: its bonds there plus its hydrogens. */
  internalValence: number;
  /** Formal charge the attachment atom carries inside the group (nitro's N⁺). */
  charge: number;
  /** The free valence the table states; a composite's follows from its head instead. */
  declaredAttachmentCount?: number;
}

export function nativeLabelGroupAttachment(group: NativeLabelGroup): NativeLabelGroupAttachment {
  if (group.kind === "composite") {
    return { element: group.head, internalValence: group.hydrogens + group.substituents.length, charge: 0 };
  }
  const { definition } = group;
  const attachment = definition.atoms[0]!;
  const bondValence = definition.bonds
    .filter(([from, to]) => from === 0 || to === 0)
    .reduce((sum, [, , order]) => sum + order, 0);
  return {
    element: attachment.element,
    internalValence: bondValence + attachment.hydrogens,
    charge: attachment.charge ?? 0,
    declaredAttachmentCount: definition.attachmentCount
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
  /**
   * The side of the label its bonds reach: "right" when every bonded neighbour lies to the label's
   * right, the same test that draws a hydroxyl as "HO". A cyano label reads from its left end, so
   * with its bond on the right it means the other isomer — "CN–R" isocyano, "SCN–R" an
   * isothiocyanate, "OCN–R" an isocyanate — and is declined to a bare formula instead
   * (`sideDependentSpellings`). Unset reads the label left to right, as written for a bond on its left.
   * Callers reading a stored atom pass `nativeLabelBondSide`.
   */
  bondSide?: "left" | "right";
}

/**
 * Whether a label's meaning depends on the side its bond comes from: cyano ("CN") and the
 * composites ending in it ("SCN", "OCN", "CH2CN") read as their cyano group with the bond on the
 * left and as a bare formula with it on the right (`sideDependentSpellings`).
 */
export function nativeLabelReadingDependsOnBondSide(label: string): boolean {
  return nativeAtomLabelReading(label, { bondSide: "left" }).kind === "group" &&
    nativeAtomLabelReading(label, { bondSide: "right" }).kind !== "group";
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
  if (definition && !(context.bondSide === "right" && sideDependentSpellings.has(trimmed))) {
    return { kind: "group", group: { kind: "abbreviation", label: trimmed, definition } };
  }
  const spelled = nativeSingleHeavyElementLabelValence(trimmed);
  if (spelled) {
    return { kind: "spelled", ...spelled };
  }
  const composite = nativeCompositeLabelGroup(trimmed, context.bondSide);
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
 * Spellings whose meaning depends on which end faces the bond. Cyano is "CN" with its C toward the
 * bond, so it is read only where that holds: as the whole label or the last token after its head
 * ("SCN", "CH2CN"), and only when the bond does not come from the label's right. Written before
 * its head ("CNO", "CNS", "CNCH2") or with its bond on the right ("CN–R", "SCN–R"), its N faces
 * the bond — isocyano, isothiocyanate, isocyanate — so the label stays a bare formula rather than
 * become the wrong isomer.
 */
const sideDependentSpellings: ReadonlySet<string> = new Set(["CN"]);

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
 * structure, so the label stays unrecognized instead. Nor is a side-dependent spelling ("CN") read
 * anywhere but last, after its head, or at all with the bond on the label's right
 * (`sideDependentSpellings`).
 *
 * A substituent in a composite is bonded to the head by definition, so the bonded-only spellings
 * count as groups here: "NHAc" is an acetamide N, "OTs" a tosylate O, "NPr2" a dipropylamino N.
 */
function nativeCompositeLabelGroup(label: string, bondSide?: "left" | "right"): NativeLabelGroup | undefined {
  return readCompositeLabel(label, bondSide)?.group;
}

/**
 * `nativeCompositeLabelGroup`, also returning the label's tokens in the order they were read, each
 * with its count: "NHBoc" is ["N", "H", "Boc"], "NMe2" is ["N", "Me2"]. The drawn label reverses them
 * for a bond on its right ("BocHN", "Me2N").
 */
function readCompositeLabel(
  label: string,
  bondSide?: "left" | "right"
): { group: NativeLabelGroup; tokens: string[] } | undefined {
  let head: NativeElementSymbol | undefined;
  let headEnd = -1;
  let hydrogens = 0;
  const substituents: AbbreviationDefinition[] = [];
  const tokens: string[] = [];
  let index = 0;
  const readCount = (): number | undefined => {
    const digits = /^\d*/.exec(label.slice(index))![0];
    index += digits.length;
    if (digits.length === 0) return 1;
    const count = Number(digits);
    return count >= 1 && count <= 4 ? count : undefined;
  };
  while (index < label.length) {
    const tokenStart = index;
    const spelling = compositeTokenSpellings.find((candidate) => label.startsWith(candidate, index));
    if (spelling) {
      if (index === headEnd && spelling.startsWith("O")) return undefined;
      index += spelling.length;
      const definition = (abbreviationForLabel(spelling) ?? abbreviationForBondedElementLabel(spelling))!;
      const count = readCount();
      if (count === undefined || definition.attachmentCount !== 1) return undefined;
      if (
        sideDependentSpellings.has(spelling) &&
        (head === undefined || index < label.length || bondSide === "right")
      ) return undefined;
      for (let copy = 0; copy < count; copy += 1) substituents.push(definition);
      tokens.push(label.slice(tokenStart, index));
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
    tokens.push(label.slice(tokenStart, index));
    if (symbolElement === "H") {
      hydrogens += count;
      continue;
    }
    if (head !== undefined || count !== 1 || nativeAtomValence[symbolElement] === undefined) return undefined;
    head = symbolElement;
    headEnd = index;
  }
  return head !== undefined && substituents.length > 0
    ? { group: { kind: "composite", label, head, hydrogens, substituents }, tokens }
    : undefined;
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
export function parseCondensedLabelFormula(label: string): Map<string, number> | undefined {
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

/** The characters of a drawn group label that sit on its atom: its first or last `length`. */
export interface AtomLabelAnchor {
  side: "start" | "end";
  length: number;
}

/**
 * How a group label is drawn when its bond comes from `bondSide` (the side test that draws a hydroxyl
 * as "HO"): the text, and which of its characters sit on the atom.
 *
 * The atom the group's bonds reach (`nativeLabelGroupAttachment`) sits on the atom when the label
 * spells it at the end its bond comes from: the O of "OMe", the C of "CO2Me", the N of "NHBoc". A
 * label that spells it at the far end is drawn turned round, token by token ("MeO", "MeO2C",
 * "BocHN", "Me2N"), but only when the turned text reads as the same group: "SCN" is never drawn
 * "CNS", and "COMe", whose reversal would read as something else, stays as typed. A label that does
 * not spell its attachment ("Ph", "Boc", "TMS"), or that cannot be turned, puts the letter nearest the
 * bond on the atom. Undefined for a label that is not a group, or whose bond-end character is not a
 * letter: those keep the centred layout.
 *
 * Display only. The stored label, and what it means, never change.
 */
export function nativeGroupLabelDisplay(
  label: string,
  bondSide: "left" | "right"
): { text: string; anchor: AtomLabelAnchor } | undefined {
  const reading = nativeAtomLabelReading(label, { bonded: true, bondSide });
  if (reading.kind !== "group") return undefined;
  const wanted = bondSide === "right" ? "end" : "start";
  const symbol = nativeLabelGroupAttachment(reading.group).element;
  const spelledAt = spelledAttachmentEnd(label, symbol);
  if (spelledAt === wanted) {
    return { text: label, anchor: { side: wanted, length: symbol.length } };
  }
  if (spelledAt !== undefined) {
    const turned = turnedGroupLabel(label, reading.group, symbol, wanted, bondSide);
    if (turned !== undefined) {
      return { text: turned, anchor: { side: wanted, length: symbol.length } };
    }
  }
  const bondEnd = wanted === "start" ? label.slice(0, 1) : label.slice(-1);
  return /^[A-Za-z]$/.test(bondEnd) ? { text: label, anchor: { side: wanted, length: 1 } } : undefined;
}

/** Which end of a label spells `symbol` as a whole token: "C" starts "CO2Me" but not "Cl". */
function spelledAttachmentEnd(label: string, symbol: string): "start" | "end" | undefined {
  if (/^[A-Z][a-z]?/.exec(label)?.[0] === symbol) return "start";
  if (/[A-Z][a-z]?$/.exec(label)?.[0] === symbol) return "end";
  return undefined;
}

/**
 * The group label turned round so `symbol` is at the `wanted` end, or undefined when the turned text
 * would not read as the same group. A composite reverses its tokens ("NHBoc" → "BocHN") and must
 * read back with the same head, hydrogens and substituents. A table abbreviation takes the one of its
 * own spellings with the same characters and the attachment at that end ("CO2Me" → "MeO2C",
 * "COOMe" → "MeOOC"); "COMe" has none ("MeCO" bonds at its C in the middle).
 */
function turnedGroupLabel(
  label: string,
  group: NativeLabelGroup,
  symbol: string,
  wanted: "start" | "end",
  bondSide: "left" | "right"
): string | undefined {
  const sameCharacters = (left: string, right: string) =>
    [...left].sort().join("") === [...right].sort().join("");
  if (group.kind === "abbreviation") {
    const { definition } = group;
    return [definition.label, ...definition.aliases].find((spelling) =>
      spelling !== label &&
      sameCharacters(spelling, label) &&
      spelledAttachmentEnd(spelling, symbol) === wanted &&
      abbreviationForLabel(spelling) === definition
    );
  }
  const read = readCompositeLabel(label, bondSide);
  if (!read) return undefined;
  const turned = [...read.tokens].reverse().join("");
  const back = readCompositeLabel(turned, bondSide)?.group;
  if (back?.kind !== "composite" || spelledAttachmentEnd(turned, symbol) !== wanted) return undefined;
  const definitions = (substituents: readonly AbbreviationDefinition[]) =>
    substituents.map((definition) => definition.label).sort().join(",");
  return back.head === group.head &&
    back.hydrogens === group.hydrogens &&
    definitions(back.substituents) === definitions(group.substituents)
    ? turned
    : undefined;
}
