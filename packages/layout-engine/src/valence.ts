// Element table, valence arithmetic, and bond-order resolution for native molecules.
//
// This is the ONE implementation of "how many bonds does this atom use". The drawn label
// (`atomDisplayLabel`), the stored formula, the valence badge, the growth hotkeys and the native
// SMILES writer all count through it, so a label and the formula beside it cannot disagree (AGENTS.md
// §5.26). `@chemdraft/document-workflow-core` re-exports these names; it never carries a copy.

import { bridgeBondIndices, isDativeBond, isMetalSymbol, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";

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

const nativeElementSymbolSet = new Set<string>(nativeElementSymbols);

/**
 * Two-letter labels that, in any case but the element's own, are the two atoms they spell and not
 * the element they would fold to: each is a group label chemists actually type. "NH" is a ring N–H,
 * not nihonium; "CO" a carbonyl, not cobalt. Twenty-six two-letter symbols split into two
 * one-letter ones in capitals; the other fifteen ("SI", "CU", "NI", "PB", "SN", …) spell nothing a
 * chemist writes, so they keep folding to their element. Kept as a list, reviewed by hand, rather
 * than derived, because the line is chemical judgement (coordinator ruling, 2026-10-10).
 */
const nativeFormulaTwoLetterLabels: ReadonlySet<string> = new Set([
  "BH", // boron with its hydrogen, a borane ring vertex — not bohrium
  "CF", // a fluorinated carbon vertex — not californium
  "CN", // cyano — not copernicium
  "CO", // carbonyl — not cobalt
  "CS", // thiocarbonyl — not caesium
  "HF", // hydrogen fluoride — not hafnium
  "HO", // hydroxyl written right to left — not holmium
  "HS", // thiol written right to left — not hassium
  "NH", // a ring N–H — not nihonium
  "NO", // nitroso — not nobelium
  "PO" // phosphoryl — not polonium
]);

/**
 * The element a typed or stored atom label names, or the label itself (trimmed) when it names none.
 *
 * An exact symbol is that element: "Co" is cobalt, "Nh" is nihonium. Any other case folds to the
 * element ("cl", "CL" → Cl; "si", "SI" → Si) except the group labels in
 * `nativeFormulaTwoLetterLabels`, which stay as typed: "NH" and "nh" read as N + H, "CO" as C + O.
 * Folding used to be blind, so a ring N–H typed as "NH" became nihonium.
 *
 * Stored labels were folded on entry, so a saved document holds exact symbols and opens unchanged.
 */
export function normalizeNativeAtomElementLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (nativeElementSymbolSet.has(trimmed)) {
    return trimmed;
  }

  const elementCandidate = `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1).toLowerCase()}`;
  if (!nativeElementSymbolSet.has(elementCandidate)) {
    return trimmed;
  }
  return nativeFormulaTwoLetterLabels.has(trimmed.toUpperCase()) ? trimmed : elementCandidate;
}

export function nativeElementFromAtomLabel(value: string): NativeElementSymbol | undefined {
  const normalized = normalizeNativeAtomElementLabel(value);
  return nativeElementSymbolSet.has(normalized) ? normalized as NativeElementSymbol : undefined;
}

/** Main-group valence electrons. One table, because the bond count follows from it. */
const nativeAtomValenceElectrons: Partial<Record<NativeElementSymbol, number>> = {
  H: 1,
  B: 3,
  C: 4,
  N: 5,
  O: 6,
  F: 7,
  Al: 3,
  Si: 4,
  P: 5,
  S: 6,
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
 * How many bonds an atom of this element and formal charge wants — and so, after its real bonds are
 * counted, how many implicit hydrogens it carries.
 *
 * Derived rather than looked up, because a formal charge changes the answer and a stored NEUTRAL
 * valence cannot express that. Counting against the neutral value invented hydrogens that are not
 * there: an alkoxide drew as "OH-" and a trisubstituted carbocation as "CH+" — different molecules
 * from the ones on the page.
 *
 * The octet rule states it exactly. An atom with n valence electrons shares its unpaired ones, so
 * it forms `8 - n` bonds once n reaches 4 and `n` below that; a charge simply moves n. That
 * reproduces every neutral value this table used to hold, and gets O- (1 bond), O+ (3), N+ (4),
 * N- (2), C+ (3), C- (3) and B- (4) right on the way. Hydrogen follows the duet rule instead, so
 * it is handled on its own: H+ and H- both take no bonds.
 */
export function nativeAtomValenceForCharge(element: NativeElementSymbol, formalCharge: number): number {
  const electrons = nativeAtomValenceElectrons[element];
  if (electrons === undefined) {
    return 0;
  }
  if (element === "H") {
    return Math.max(0, 1 - Math.abs(formalCharge));
  }
  const adjusted = electrons - formalCharge;
  if (adjusted < 0 || adjusted > 8) {
    return 0;
  }
  return adjusted >= 4 ? 8 - adjusted : adjusted;
}

/**
 * Whether `formalCharge` keeps this element's electron count inside a representable range —
 * distinct from `nativeAtomValenceForCharge` returning 0, which also happens for a charge that
 * legitimately has no room for MORE bonds (H+ and H- both take zero). Without this, a caller that
 * only checks `valenceUsed <= nativeAtomValenceForCharge(...)` can't tell "no more bonds fit" from
 * "this charge doesn't exist" — both collapse to the same 0, and an unbonded atom's valenceUsed of
 * 0 trivially satisfies either one, so charges of arbitrary magnitude appear equally legal.
 *
 * Elements outside the valence-electron table (metals: Na, K, Ca, Fe, ...) have no octet
 * arithmetic to bound them and legitimately carry ionic charges the table cannot express, so
 * they stay permissive — the bound only applies where the octet math actually defines one.
 */
export function nativeAtomChargeIsExpressible(element: NativeElementSymbol, formalCharge: number): boolean {
  const electrons = nativeAtomValenceElectrons[element];
  if (electrons === undefined) {
    return true;
  }
  if (element === "H") {
    return Math.abs(formalCharge) <= 1;
  }
  const adjusted = electrons - formalCharge;
  return adjusted >= 0 && adjusted <= 8;
}

/**
 * Covalent slots per bond order, for a bond read on its own. `aromatic` is 1 here because an
 * aromatic bond has no context-free answer: in benzene it is single or double depending on the
 * Kekulé pattern, and neither 1 nor 1.5 is right for every atom (1 made benzene C6H12; 1.5 drew
 * pyrrole's N–H as a bare N and would badge thiophene's S). Everything that counts an atom's
 * valence goes through `nativeBondOrderResolution` first, which replaces each aromatic bond with
 * its Kekulé order; the 1 only survives for aromatic bonds it could not resolve, and those atoms
 * are flagged (`unresolvedAtomIds`), never counted silently.
 */
export const nativeBondOrderValue: Record<MoleculeBond["order"], number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 1,
  unknown: 1
};

/**
 * A dashed single bond depicts a dative or partial interaction — a coordinate bond to a metal, a
 * hydrogen bond, a forming/breaking bond — and occupies no covalent valence slot on either
 * atom: pyridine's N keeps its three bonds and no badge while dash-bonded to a zinc.
 */
export function nativeBondValenceContribution(bond: MoleculeBond): number {
  return isDativeBond(bond) ? 0 : nativeBondOrderValue[bond.order] ?? 1;
}

/** Covalent slots each atom uses, with aromatic bonds counted at their Kekulé orders. */
export function atomBondOrderUsageMap(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ReadonlyMap<string, number> {
  return nativeBondOrderResolution(atoms, bonds).bondOrderUsage;
}

/**
 * Covalent slots one atom uses, with aromatic bonds counted at their Kekulé orders. `atoms` is the
 * whole molecule, and it is required: resolving an aromatic bond needs every ring atom's element,
 * charge and stated hydrogens, and a caller that could leave it out would get aromatic bonds counted
 * as single with nothing on screen to say so.
 */
export function nativeAtomBondOrderUsage(
  atomId: string,
  bonds: readonly MoleculeBond[],
  atoms: readonly MoleculeAtom[]
): number {
  return nativeBondOrderResolution(atoms, bonds).bondOrderUsage.get(atomId) ?? 0;
}

export interface NativeBondOrderResolution {
  /** Per-molecule indices for label/metadata batches; pass this resolution through the whole batch. */
  readonly atomById: ReadonlyMap<string, MoleculeAtom>;
  readonly bondsByAtom: ReadonlyMap<string, readonly MoleculeBond[]>;
  readonly bondOrderUsage: ReadonlyMap<string, number>;
  /**
   * The input bonds, index-aligned, with every aromatic bond rewritten: to its Kekulé order where
   * the ring system resolves, and to single where it does not. The input array itself when it holds
   * no aromatic bond, so already-kekulized molecules are counted exactly as before.
   */
  readonly bonds: readonly MoleculeBond[];
  /** Bond id → Kekulé order, for each aromatic bond that resolved. */
  readonly kekuleOrders: ReadonlyMap<string, 1 | 2>;
  /**
   * Atoms on an aromatic bond that did not resolve — outside any conjugated ring (including a ring
   * that is otherwise saturated), in a ring system with no Kekulé pattern, or touching an atom
   * missing from `atoms`. Their bonds count as single, and the valence check flags every one of
   * these atoms so the guess is never silent.
   */
  readonly unresolvedAtomIds: ReadonlySet<string>;
  /**
   * Ring atoms whose unstated hydrogen count was inferred or whose five-ring N–H was declined:
   * an inferred N–H, an ambiguous tautomer, or a closed-shell fallback that conflicts with the
   * five-ring rule. The valence check badges all as `chemistry.aromatic_tautomer_guessed`.
   * This includes a forced placement: a unique matching does not make an unstated H observed.
   */
  readonly inferredHydrogenAtomIds: ReadonlySet<string>;
  /**
   * The uncertain subset of inferredHydrogenAtomIds: tied placements, declined five-ring N–H, N
   * whose H the whole-system 4n+2 preference chose over a closed-shell reading with a different H
   * count, or a bounded-search fallback. A uniquely inferred N–H is badged but is not a tautomer guess.
   */
  readonly guessedHydrogenAtomIds: ReadonlySet<string>;
  /** Aromatic bonds outside any conjugated ring. */
  readonly nonRingAromaticBondCount: number;
  /** Aromatic ring bonds in a ring system with no Kekulé pattern. */
  readonly unresolvedAromaticBondCount: number;
}

const emptyResolvedOrders: ReadonlyMap<string, 1 | 2> = new Map();
const emptyAtomIds: ReadonlySet<string> = new Set();

interface ResolutionCacheEntry {
  atoms: readonly MoleculeAtom[];
  bondRefs: readonly MoleculeBond[];
  bondFields: readonly (string | undefined)[];
  atomRefs: readonly MoleculeAtom[];
  atomFields: readonly (string | number | boolean | undefined)[];
  result: NativeBondOrderResolution;
}

const BOND_FIELDS = 5;
const ATOM_FIELDS = 6;

function bondFieldsOf(bonds: readonly MoleculeBond[]): (string | undefined)[] {
  return bonds.flatMap((bond) => [bond.order, bond.fromAtomId, bond.toAtomId, bond.display?.bondStyle, bond.id]);
}

function atomFieldsOf(atoms: readonly MoleculeAtom[]): (string | number | boolean | undefined)[] {
  return atoms.flatMap((atom) => [
    atom.id,
    atom.element,
    atom.formalCharge,
    atom.markRadicals,
    atom.labelLiteral,
    atom.hydrogenCount
  ]);
}

/**
 * One resolution per molecule, not per atom: the label planner asks once for every atom, and a
 * Kekulé search per atom would make rendering quadratic in the ring size. Keyed on the bonds array
 * (documents are replaced, not mutated), and checked field by field against what the search read,
 * so an array edited in place is re-resolved rather than served stale.
 */
const resolutionCache = new WeakMap<readonly MoleculeBond[], ResolutionCacheEntry>();

function cachedResolutionMatches(
  entry: ResolutionCacheEntry,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): boolean {
  if (entry.atoms !== atoms || entry.bondRefs.length !== bonds.length || entry.atomRefs.length !== atoms.length) {
    return false;
  }
  for (let index = 0; index < bonds.length; index += 1) {
    const bond = bonds[index]!;
    const offset = index * BOND_FIELDS;
    if (
      entry.bondRefs[index] !== bond ||
      entry.bondFields[offset] !== bond.order ||
      entry.bondFields[offset + 1] !== bond.fromAtomId ||
      entry.bondFields[offset + 2] !== bond.toAtomId ||
      entry.bondFields[offset + 3] !== bond.display?.bondStyle ||
      entry.bondFields[offset + 4] !== bond.id
    ) {
      return false;
    }
  }
  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index]!;
    const offset = index * ATOM_FIELDS;
    if (
      entry.atomRefs[index] !== atom ||
      entry.atomFields[offset] !== atom.id ||
      entry.atomFields[offset + 1] !== atom.element ||
      entry.atomFields[offset + 2] !== atom.formalCharge ||
      entry.atomFields[offset + 3] !== atom.markRadicals ||
      entry.atomFields[offset + 4] !== atom.labelLiteral ||
      entry.atomFields[offset + 5] !== atom.hydrogenCount
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Replace every aromatic bond with the order it takes in a Kekulé structure, once per molecule.
 *
 * Aromatic bonds arrive only from outside — a MOL/RXN paste with type-4 bonds, CDXML Order=1.5, a
 * Ketcher V3000 save — and no single per-bond number counts them right for every atom (see
 * `nativeBondOrderValue`). Kekulizing first does: benzene is C6H6, pyrrole's N keeps its H, and
 * thiophene's S takes no double bond. The same resolution feeds the drawn label, the formula, the
 * valence check and the SMILES writer, so they agree.
 *
 * A bond the search cannot resolve counts as single — the order the SMILES writer also writes — and
 * its atoms land in `unresolvedAtomIds`, which the valence check turns into a badge. Where the
 * bonds fit more than one arrangement of ring N–H, one is picked and its atoms land in
 * `guessedHydrogenAtomIds`. The valence check badges all `inferredHydrogenAtomIds`, including
 * uniquely inferred N–H and declined five-ring H.
 */
export function nativeBondOrderResolution(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): NativeBondOrderResolution {
  const cached = resolutionCache.get(bonds);
  if (cached && cachedResolutionMatches(cached, atoms, bonds)) {
    return cached.result;
  }
  if (!bonds.some((bond) => bond.order === "aromatic")) {
    return cacheResolution(atoms, bonds, {
      ...indexResolvedGraph(atoms, bonds),
      bonds,
      kekuleOrders: emptyResolvedOrders,
      unresolvedAtomIds: emptyAtomIds,
      inferredHydrogenAtomIds: emptyAtomIds,
      guessedHydrogenAtomIds: emptyAtomIds,
      nonRingAromaticBondCount: 0,
      unresolvedAromaticBondCount: 0
    });
  }

  const kekulized = kekulizeNativeAromaticBonds(atoms, bonds);
  const kekuleOrders = new Map<string, 1 | 2>();
  const unresolvedAtomIds = new Set<string>();
  const resolvedBonds = kekulized.bonds.map((bond, index) => {
    if (bonds[index]!.order !== "aromatic") {
      return bond;
    }
    if (bond.order === "aromatic") {
      unresolvedAtomIds.add(bond.fromAtomId);
      unresolvedAtomIds.add(bond.toAtomId);
      return { ...bond, order: "single" as const };
    }
    kekuleOrders.set(bond.id, bond.order === "double" ? 2 : 1);
    return bond;
  });
  const result: NativeBondOrderResolution = {
    ...indexResolvedGraph(atoms, resolvedBonds),
    bonds: resolvedBonds,
    kekuleOrders,
    unresolvedAtomIds,
    inferredHydrogenAtomIds: kekulized.inferred,
    guessedHydrogenAtomIds: kekulized.guessed,
    nonRingAromaticBondCount: kekulized.nonRing,
    unresolvedAromaticBondCount: kekulized.unresolved
  };
  return cacheResolution(atoms, bonds, result);
}

function cacheResolution(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  result: NativeBondOrderResolution
): NativeBondOrderResolution {
  resolutionCache.set(bonds, {
    atoms,
    bondRefs: [...bonds],
    bondFields: bondFieldsOf(bonds),
    atomRefs: [...atoms],
    atomFields: atomFieldsOf(atoms),
    result
  });
  return result;
}

function indexResolvedGraph(atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]) {
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const bondsByAtom = new Map<string, MoleculeBond[]>();
  const bondOrderUsage = new Map(atoms.map((atom) => [atom.id, 0]));
  for (const bond of bonds) {
    const value = nativeBondValenceContribution(bond);
    for (const id of [bond.fromAtomId, bond.toAtomId]) {
      const incident = bondsByAtom.get(id);
      if (incident) incident.push(bond);
      else bondsByAtom.set(id, [bond]);
      bondOrderUsage.set(id, (bondOrderUsage.get(id) ?? 0) + value);
    }
  }
  return { atomById, bondsByAtom, bondOrderUsage };
}

type AtomClass = "must" | "never" | "flex";

/** Past this many ring N whose role is open, the exhaustive comparison gives way to a greedy one. */
const MAX_EXHAUSTIVE_OPEN_ATOMS = 10;
/**
 * Past this many flexible ring N in one system, even finding which roles the ring forces (two
 * matching tests per atom, each on a graph that grows with their square) is skipped: one matching
 * places them all, and all are reported as guessed.
 */
const MAX_JUDGED_FLEX_ATOMS = 40;
/** Rings up to this size are judged for local aromaticity (5-, 6- and 7-rings; not perimeters). */
const MAX_LOCAL_RING_SIZE = 7;

let kekuleWork = 0;

/**
 * Cumulative matching work (adjacency scans and blossom relabels) since the module loaded. A test
 * reads it before and after a resolution to prove the search stays polynomial without timing it.
 */
export function kekuleSearchWorkForTesting(): number {
  return kekuleWork;
}

interface KekuleOutcome {
  bonds: MoleculeBond[];
  nonRing: number;
  unresolved: number;
  inferred: Set<string>;
  guessed: Set<string>;
}

/**
 * Assign alternating single/double orders to the aromatic bonds so the result is a valid Kekulé
 * structure. Aromatic bonds left `aromatic` in the returned bonds sit outside any conjugated ring
 * (`nonRing`) or belong to a ring system with no assignment (`unresolved`); the caller counts those
 * single and reports them.
 *
 * Ring membership is judged on the conjugated graph: aromatic, double and triple bonds, plus single
 * bonds whose two ends can both carry π electrons (an atom on an aromatic or multiple bond, a
 * heteroatom, a charged or radical atom). So a pasted benzene with one bond redrawn as double still
 * resolves, while an aromatic bond in a ring that is otherwise saturated — cyclohexane with one
 * type-4 bond — is not aromatic at all: it counts single and is flagged, never promoted to double.
 *
 * Each atom on a ring aromatic bond either takes exactly one double bond or none (`kekuleAtomClass`).
 * A neutral ring N (or P, As) with a free slot is the open question: pyridine-type (a double bond,
 * no H) or pyrrole-type (no double bond, an N–H). Whatever the source says about its hydrogens
 * settles it — an explicit H atom, a stated hydrogen count (`hydrogenCount`, from CDXML
 * NumHydrogens), a typed literal label, a charge — and a nitrogen donating to a metal through a
 * dative bond spends its lone pair there, so it is pyridine-type when the ring allows it. Only
 * nitrogens none of that decides are chosen by `solveRingSystem`, and when the choice is not forced
 * the atoms are reported as guessed.
 *
 * Ring systems are solved independently so one unresolvable ring never spoils another. A ring
 * system with an atom missing from `atoms` cannot be judged and is reported unresolved rather than
 * guessed.
 */
function kekulizeNativeAromaticBonds(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): KekuleOutcome {
  const aromaticIndices = bonds.flatMap((bond, index) => bond.order === "aromatic" ? [index] : []);
  if (aromaticIndices.length === 0) {
    return { bonds: [...bonds], nonRing: 0, unresolved: 0, inferred: new Set(), guessed: new Set() };
  }
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const otherEnd = (index: number, atomId: string): string =>
    bonds[index]!.fromAtomId === atomId ? bonds[index]!.toAtomId : bonds[index]!.fromAtomId;

  const touchesAromatic = new Set<string>();
  const hasExplicitMultiple = new Set<string>();
  const metalDonorIds = new Set<string>();
  const covalentByAtom = new Map<string, number[]>();
  const isMetalAtom = (atomId: string): boolean => {
    const element = nativeElementFromAtomLabel(atomById.get(atomId)?.element ?? "");
    return element !== undefined && isMetalSymbol(element);
  };
  bonds.forEach((bond, index) => {
    if (isDativeBond(bond)) {
      // A dashed bond to a metal spends the other atom's lone pair on the metal.
      if (isMetalAtom(bond.toAtomId) && !isMetalAtom(bond.fromAtomId)) metalDonorIds.add(bond.fromAtomId);
      if (isMetalAtom(bond.fromAtomId) && !isMetalAtom(bond.toAtomId)) metalDonorIds.add(bond.toAtomId);
      return;
    }
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      covalentByAtom.set(atomId, [...(covalentByAtom.get(atomId) ?? []), index]);
      if (bond.order === "aromatic") touchesAromatic.add(atomId);
      if (bond.order === "double" || bond.order === "triple") hasExplicitMultiple.add(atomId);
    }
  });

  // An aromatic bond is in a ring only if the ring is conjugated all the way round.
  const piCapable = (atomId: string): boolean => {
    if (touchesAromatic.has(atomId) || hasExplicitMultiple.has(atomId)) return true;
    const atom = atomById.get(atomId);
    if (!atom) return false;
    if (atom.formalCharge !== 0 || (atom.markRadicals ?? 0) > 0) return true;
    const identity = ringAtomIdentity(atom);
    return identity !== undefined && identity.element !== "C" && identity.element !== "H";
  };
  const conjugatedBond = (bond: MoleculeBond): boolean =>
    !isDativeBond(bond) && (
      bond.order === "aromatic" || bond.order === "double" || bond.order === "triple" ||
      (piCapable(bond.fromAtomId) && piCapable(bond.toAtomId))
    );
  const bridges = bridgeBondIndices(bonds, otherEnd, conjugatedBond);
  const ringIndices = aromaticIndices.filter((index) => !bridges.has(index));
  const nonRing = aromaticIndices.length - ringIndices.length;
  const ringByAtom = new Map<string, number[]>();
  for (const index of ringIndices) {
    for (const atomId of [bonds[index]!.fromAtomId, bonds[index]!.toAtomId]) {
      ringByAtom.set(atomId, [...(ringByAtom.get(atomId) ?? []), index]);
    }
  }
  // Context includes explicit ring bonds too. Splitting on aromatic edges alone lost the amide N
  // between xanthine's carbonyls, and therefore its lone pair in the ring electron count.
  const systemByAtom = new Map<string, number[]>();
  bonds.forEach((bond, index) => {
    if (bridges.has(index) || !conjugatedBond(bond)) return;
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      systemByAtom.set(atomId, [...(systemByAtom.get(atomId) ?? []), index]);
    }
  });
  // Deterministic search: neighbours in id order, whatever order the bond array arrived in.
  for (const [atomId, indices] of ringByAtom) {
    ringByAtom.set(atomId, [...indices].sort((left, right) => otherEnd(left, atomId).localeCompare(otherEnd(right, atomId))));
  }

  // Valence already spent on everything but ring aromatic bonds (a non-ring aromatic bond counts as
  // the single it becomes).
  const spent = new Map<string, number>();
  const ringIndexSet = new Set(ringIndices);
  bonds.forEach((bond, index) => {
    if (ringIndexSet.has(index)) return;
    const value = bond.order === "aromatic" || bond.order === "unknown" ? 1 : nativeBondValenceContribution(bond);
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      spent.set(atomId, (spent.get(atomId) ?? 0) + value);
    }
  });

  // Ring systems: connected components of all conjugated ring bonds, solved one at a time.
  const doubleIndices = new Set<number>();
  const unresolvedIndices = new Set<number>();
  const inferred = new Set<string>();
  const guessed = new Set<string>();
  const assignedAtoms = new Set<string>();
  for (const seedAtomId of [...ringByAtom.keys()].sort()) {
    if (assignedAtoms.has(seedAtomId)) continue;
    const systemAtoms: string[] = [];
    const queue = [seedAtomId];
    assignedAtoms.add(seedAtomId);
    while (queue.length > 0) {
      const atomId = queue.pop()!;
      systemAtoms.push(atomId);
      for (const index of systemByAtom.get(atomId) ?? []) {
        const next = otherEnd(index, atomId);
        if (!assignedAtoms.has(next)) {
          assignedAtoms.add(next);
          queue.push(next);
        }
      }
    }
    systemAtoms.sort();
    const systemBonds = new Set(systemAtoms.flatMap((atomId) => ringByAtom.get(atomId) ?? []));
    const solution = systemAtoms.some((atomId) => !atomById.has(atomId))
      ? undefined
      : solveRingSystem(systemAtoms, {
          atomById,
          bonds,
          ringByAtom,
          covalentByAtom,
          spent,
          hasExplicitMultiple,
          metalDonorIds,
          otherEnd
        });
    if (solution) {
      for (const index of solution.doubles) doubleIndices.add(index);
      for (const atomId of solution.inferred) inferred.add(atomId);
      for (const atomId of solution.guessed) guessed.add(atomId);
    } else {
      // The whole system stays `aromatic` here; the caller downgrades it to single and reports it.
      for (const index of systemBonds) unresolvedIndices.add(index);
    }
  }
  return {
    bonds: bonds.map((bond, index) => {
      if (bond.order !== "aromatic") return bond;
      if (doubleIndices.has(index)) return { ...bond, order: "double" };
      if (!ringIndexSet.has(index) || unresolvedIndices.has(index)) return bond;
      return { ...bond, order: "single" };
    }),
    nonRing,
    unresolved: unresolvedIndices.size,
    inferred,
    guessed
  };
}

interface RingSystemContext {
  readonly atomById: ReadonlyMap<string, MoleculeAtom>;
  readonly bonds: readonly MoleculeBond[];
  readonly ringByAtom: ReadonlyMap<string, readonly number[]>;
  readonly covalentByAtom: ReadonlyMap<string, readonly number[]>;
  readonly spent: ReadonlyMap<string, number>;
  readonly hasExplicitMultiple: ReadonlySet<string>;
  readonly metalDonorIds: ReadonlySet<string>;
  readonly otherEnd: (index: number, atomId: string) => string;
}

interface RingAtomRole {
  readonly cls: AtomClass;
  /** A flexible ring N donating to a metal: pyridine-type when the ring allows it. */
  readonly metalDonor: boolean;
  /** π electrons a "never" atom brings to the ring; undefined when that cannot be judged. */
  readonly piElectrons?: number;
}

/**
 * A ring atom's element, and the hydrogens its label spells when it is a typed literal such as
 * "NH". Undefined for a label that names no single element (an abbreviation, an R group).
 */
function ringAtomIdentity(atom: MoleculeAtom): { element: NativeElementSymbol; labelHydrogens: number } | undefined {
  const element = nativeElementFromAtomLabel(atom.element);
  if (element) return { element, labelHydrogens: 0 };
  if (atom.labelLiteral !== true) return undefined;
  const trimmed = atom.element.trim();
  const after = /^([A-Z][a-z]?)H(\d*)$/.exec(trimmed);
  const before = /^H(\d*)([A-Z][a-z]?)$/.exec(trimmed);
  const symbol = after?.[1] ?? before?.[2];
  const count = after ? after[2] : before?.[1];
  const heavy = symbol === undefined ? undefined : nativeElementFromAtomLabel(symbol);
  if (!heavy || heavy === "H") return undefined;
  return { element: heavy, labelHydrogens: count ? Number(count) : 1 };
}

function ringAtomRole(atomId: string, systemAtomSet: ReadonlySet<string>, context: RingSystemContext): RingAtomRole {
  const atom = context.atomById.get(atomId)!;
  const identity = ringAtomIdentity(atom);
  if (!identity) return { cls: "never", metalDonor: false };
  // An atom that already carries an explicit double or triple bond has its π bond and takes no
  // second one from the ring, even when its arithmetic would allow it: one bond of a pasted benzene
  // redrawn as double must not turn its carbons into ring allenes. Its π electron belongs to the
  // ring when that double bond is part of the ring (1), and to the exocyclic group otherwise — a
  // pyridone's C=O carbon brings none (0).
  if (context.hasExplicitMultiple.has(atomId)) {
    const inRing = (context.covalentByAtom.get(atomId) ?? []).some((index) => {
      const order = context.bonds[index]!.order;
      return (order === "double" || order === "triple") && systemAtomSet.has(context.otherEnd(index, atomId));
    });
    return { cls: "never", metalDonor: false, piElectrons: inRing ? 1 : 0 };
  }
  const { element, labelHydrogens } = identity;
  const ringBonds = context.ringByAtom.get(atomId)?.length ?? 0;
  const radicals = atom.markRadicals ?? 0;
  const spent = (context.spent.get(atomId) ?? 0) + labelHydrogens;
  const spare = nativeAtomValenceForCharge(element, atom.formalCharge) - spent - ringBonds - radicals;
  let cls = kekuleAtomClass(element, atom.formalCharge, spare);
  // Explicit single bonds are fixed: this atom cannot acquire a double bond from the matcher.
  if (ringBonds === 0) cls = "never";
  let metalDonor = false;
  if (cls === "flex") {
    // Hydrogen the source stated decides the role outright. A typed literal "N" carries none; a
    // stated count of one or more is an N–H, zero a bare N.
    if (atom.labelLiteral === true) {
      cls = "must";
    } else if (atom.hydrogenCount !== undefined) {
      cls = atom.hydrogenCount > 0 ? "never" : "must";
    } else {
      metalDonor = context.metalDonorIds.has(atomId);
    }
  }
  if (cls !== "never") return { cls, metalDonor };
  const implicitHydrogens = atom.labelLiteral === true ? 0 : Math.max(0, spare);
  return {
    cls,
    metalDonor,
    piElectrons: nonBondingPiElectrons(element, atom.formalCharge, spent + ringBonds + implicitHydrogens, radicals)
  };
}

/**
 * π electrons an sp2 ring atom that takes no ring double bond brings to the ring: what is left of
 * its valence electrons after its σ bonds, less a lone pair in each in-plane orbital its σ bonds do
 * not fill. Furan's O and pyrrole's N–H give 2, a C⁺ or a three-bonded B give 0. Undefined for an
 * element outside the valence table or an atom carrying a radical, which could sit in either orbital.
 */
function nonBondingPiElectrons(
  element: NativeElementSymbol,
  formalCharge: number,
  sigmaBonds: number,
  radicals: number
): number | undefined {
  const electrons = nativeAtomValenceElectrons[element];
  if (electrons === undefined || radicals > 0) return undefined;
  const nonBonding = electrons - formalCharge - sigmaBonds;
  const inPlaneLonePairs = Math.max(0, 3 - sigmaBonds);
  return Math.min(2, Math.max(0, nonBonding - 2 * inPlaneLonePairs));
}

/**
 * What an aromatic ring atom may do in the Kekulé pattern, from its element, charge and the
 * valence it has to spare. "never": takes no double bond and keeps its lone pair (or, for a
 * cation carbon, its empty orbital): any atom with no spare slot, any anion, a C⁺. "must": takes
 * exactly one — a neutral carbon or boron, a B⁻ (carbon-like), and a cationic heteroatom such as pyrylium's O⁺ or
 * an N-alkyl pyridinium N⁺, which has no lone pair left to hold. "flex": the neutral N/P/As
 * with a spare slot, which is pyridine-type or pyrrole-type depending on the ring — the search
 * decides. Charges are never "flex": a C⁺ must not trade its role with a neutral nitrogen.
 */
function kekuleAtomClass(element: NativeElementSymbol, formalCharge: number, spare: number): AtomClass {
  if (spare < 1) return "never";
  // A B⁻ is carbon-like (boratabenzene's B⁻ takes a double bond); every other anion holds a pair.
  if (formalCharge < 0) return element === "B" ? "must" : "never";
  if (formalCharge > 0) return element === "C" || element === "B" ? "never" : "must";
  if (element === "C" || element === "B") return "must";
  return element === "N" || element === "P" || element === "As" ? "flex" : "never";
}

interface RingSystemSolution {
  readonly doubles: readonly number[];
  readonly inferred: readonly string[];
  readonly guessed: readonly string[];
}

/**
 * Solve one ring system: every "must" atom takes exactly one double bond, no "never" atom takes any,
 * and each open ("flex") nitrogen either takes one (pyridine-type) or stays out and keeps an N–H
 * (pyrrole-type). Which nitrogens stay out is chosen by, in order:
 *
 *  1. closed-shell matching under the source's explicit constraints;
 *  2. N–H only in five-membered rings needing it for aromaticity, when a matching allows it;
 *  3. otherwise the maximum-matching H count, with a badge if closure requires other N–H;
 *  4. no hydrogens outside small rings, then the most aromatic local circuits.
 *
 * Only step 2 may add H to the maximum-matching reading. Outside that five-ring exception,
 * neither larger rings nor whole-system electron counts justify extra H. Every inferred N–H is badged.
 *
 * When several arrangements tie, one is taken — N–H first on the nitrogen in the
 * smallest ring, then by atom id — and every nitrogen whose role differs between them is reported
 * as guessed. A five-ring N whose H is declined is badged even if it stays bare in every reading.
 *
 * A metal-donor N is tried as pyridine-type first and allowed to keep its N–H (which the dative
 * bond then removes; see `dativeDeprotonationCount`) only when no pattern exists otherwise.
 *
 * Every question is a perfect-matching test on a graph of the ring's atoms (Edmonds' blossom
 * algorithm, polynomial). The exhaustive comparison runs only over nitrogens whose role is actually
 * open, and only up to `MAX_EXHAUSTIVE_OPEN_ATOMS` of them. Independent local circuits have a
 * size-independent exact path; otherwise a capped fallback is explicitly badged.
 */
function solveRingSystem(systemAtoms: readonly string[], context: RingSystemContext): RingSystemSolution | undefined {
  const systemAtomSet = new Set(systemAtoms);
  const roles = new Map(systemAtoms.map((atomId) => [atomId, ringAtomRole(atomId, systemAtomSet, context)] as const));
  const donorsFirst = solveWithRoles(systemAtoms, systemAtomSet, roles, true, context);
  if (donorsFirst) return donorsFirst;
  return [...roles.values()].some((role) => role.metalDonor)
    ? solveWithRoles(systemAtoms, systemAtomSet, roles, false, context)
    : undefined;
}

function solveWithRoles(
  systemAtoms: readonly string[],
  systemAtomSet: ReadonlySet<string>,
  roles: ReadonlyMap<string, RingAtomRole>,
  donorsCovered: boolean,
  context: RingSystemContext
): RingSystemSolution | undefined {
  const classOf = (atomId: string): AtomClass => {
    const role = roles.get(atomId)!;
    return role.cls === "flex" && role.metalDonor && donorsCovered ? "must" : role.cls;
  };
  const mustIds = systemAtoms.filter((atomId) => classOf(atomId) === "must");
  const flexIds = systemAtoms.filter((atomId) => classOf(atomId) === "flex");
  const edges: [bondIndex: number, from: string, to: string][] = [];
  for (const atomId of systemAtoms) {
    if (classOf(atomId) === "never") continue;
    for (const index of context.ringByAtom.get(atomId) ?? []) {
      const other = context.otherEnd(index, atomId);
      if (atomId < other && classOf(other) !== "never") edges.push([index, atomId, other]);
    }
  }
  const matcher = ringMatcher(mustIds, flexIds, edges);

  if (flexIds.length === 0) {
    const doubles = matcher.solve(new Set(), [], "any");
    // No π bonds at all is a saturated ring, not a successful Kekulé assignment. Explicit
    // in-ring multiple bonds may already supply them in a mixed representation.
    const hasPiBond = doubles?.length || systemAtoms.some((id) =>
      context.hasExplicitMultiple.has(id) && roles.get(id)?.piElectrons === 1
    );
    return doubles && hasPiBond ? { doubles, inferred: [], guessed: [] } : undefined;
  }
  // The maximum-matching reading remains the baseline. The owner's only exception is an
  // unstated N–H needed by a FIVE-membered aromatic ring, still subject to closed-shell matching.
  let targetOut = 0;
  let baseline: number[] | undefined;
  for (; targetOut <= flexIds.length; targetOut += 1) {
    baseline = matcher.solve(new Set(), flexIds, { exact: targetOut });
    if (baseline) break;
  }
  if (!baseline) return undefined;
  const smallRings = smallRingsThrough(systemAtoms, systemAtomSet, context);
  const rings = smallRings.flatMap((ring) => {
    let base = 0;
    for (const atomId of ring) {
      const cls = classOf(atomId);
      const electrons = cls === "never" ? roles.get(atomId)!.piElectrons : 1;
      if (electrons === undefined) return [];
      base += electrons;
    }
    return [{ atoms: ring, base, flex: ring.filter((atomId) => classOf(atomId) === "flex") }];
  });
  const smallestRing = new Map<string, number>();
  for (const ring of smallRings) {
    for (const atomId of ring) {
      if (classOf(atomId) === "flex") smallestRing.set(atomId, Math.min(smallestRing.get(atomId) ?? Infinity, ring.length));
    }
  }
  const localScore = (out: ReadonlySet<string>): number => rings.filter((ring) =>
    (ring.base + ring.flex.filter((atomId) => out.has(atomId)).length) % 4 === 2
  ).length;

  // ringAtomRole already applies each atom's stated H/charge/label to that atom alone. Other
  // atoms' source information must not suppress an unstated five-ring N–H or its badge.
  const fiveRings = rings.filter((ring) => ring.atoms.length === 5 && ring.base % 4 !== 2);
  const fiveRingCandidates = flexIds.filter((id) => context.atomById.get(id)!.element === "N" &&
    !context.metalDonorIds.has(id) && fiveRings.some((ring) => ring.flex.includes(id)));
  const fiveRingReading = solveFiveRingHydrogens(flexIds, fiveRingCandidates, fiveRings, matcher, baseline, systemAtomSet,
    systemAtoms.reduce((sum, id) => sum + (classOf(id) === "never" ? roles.get(id)!.piElectrons ?? NaN : 1), 0),
    context);
  if (fiveRingReading) return fiveRingReading;
  // A failed five-ring reading declines H at every eligible site. Carry those badges through
  // every fallback, including when only a six-ring N–H is forced out (xanthine).
  const fallback = (doubles: readonly number[], out: Iterable<string>, uncertain: readonly string[] = []): RingSystemSolution => {
    const unstated = (ids: Iterable<string>): string[] => [...new Set(ids)].filter((id) => !context.metalDonorIds.has(id));
    const guessed = unstated([...uncertain, ...fiveRingCandidates]);
    return { doubles, inferred: unstated([...out, ...guessed]), guessed };
  };
  if (targetOut === 0) return fallback(baseline, []);

  // A common large case has one open N per small ring (fused pyrrole ladders). When the local
  // circuits independently agree on every N and a matching exists, that is the same optimum an
  // exhaustive comparison would find, regardless of the search cap.
  {
    const desired = new Map<string, boolean>();
    let consistent = true;
    for (const ring of rings) {
      if (ring.flex.length !== 1) continue;
      const id = ring.flex[0]!;
      const out = (ring.base + 1) % 4 === 2;
      if (!out && ring.base % 4 !== 2) continue;
      if (desired.has(id) && desired.get(id) !== out) consistent = false;
      desired.set(id, out);
    }
    if (consistent && desired.size === flexIds.length) {
      const out = new Set(flexIds.filter((id) => desired.get(id)));
      const doubles = matcher.solve(out, [], "any");
      if (out.size === targetOut && doubles && localScore(out) === rings.length) {
        return fallback(doubles, out);
      }
    }
  }
  if (flexIds.length > MAX_JUDGED_FLEX_ATOMS) {
    // Beyond the bounded exact/local paths the reading remains explicitly uncertain.
    return fallback(baseline, flexIds, flexIds);
  }

  // Roles the ring system forces whatever else happens (an atom that can only stay out, or only take
  // a double bond), then the ones still open.
  const forcedOut = new Set<string>();
  const open: string[] = [];
  for (const atomId of flexIds) {
    const others = flexIds.filter((other) => other !== atomId);
    const canStayOut = matcher.solve(new Set([atomId]), others, { exact: targetOut - 1 }) !== undefined;
    const canTakeDouble = matcher.solve(new Set(), others, { exact: targetOut }) !== undefined;
    if (canStayOut && canTakeDouble) open.push(atomId);
    else if (canStayOut) forcedOut.add(atomId);
  }
  open.sort((left, right) =>
    (smallestRing.get(left) ?? Infinity) - (smallestRing.get(right) ?? Infinity) || left.localeCompare(right)
  );
  const finish = (out: ReadonlySet<string>, guessed: readonly string[]): RingSystemSolution | undefined => {
    if (out.size !== targetOut) return undefined;
    const doubles = matcher.solve(out, [], { exact: 0 });
    // Closure can require an N–H outside a five-ring (e.g. pyridone). Keep the closed shell and
    // badge the inferred H. A metal donor's H is removed by dativeDeprotonationCount, not guessed.
    return doubles ? fallback(doubles, out, guessed) : undefined;
  };
  if (open.length === 0) return finish(forcedOut, []);

  if (open.length > MAX_EXHAUSTIVE_OPEN_ATOMS) {
    // Keep the baseline H count even in the bounded fallback; every open placement is badged.
    const out = new Set(forcedOut);
    // Each step keeps a completion with exactly `goal` N–H possible: N–H here when the rest still
    // fits, a double bond otherwise (then every completion must give it one).
    const goal = targetOut - forcedOut.size;
    let placed = 0;
    open.forEach((atomId, position) => {
      out.add(atomId);
      if (placed < goal && matcher.solve(out, open.slice(position + 1), { exact: goal - placed - 1 })) {
        placed += 1;
        return;
      }
      out.delete(atomId);
    });
    return finish(out, open);
  }

  // Compare placements of the fixed H count: prefer ring N–H over meso bridges, then local
  // aromatic circuits. Whole-system 4n+2 is deliberately absent: it cannot choose an H count.
  type Key = readonly [noStrayHydrogens: number, localRings: number];
  const compare = (left: Key, right: Key): number => left[0] - right[0] || left[1] - right[1];
  const distances = ringDistances(flexIds, systemAtomSet, context);
  // Among arrangements the chemistry cannot tell apart, the one whose N–H sit furthest apart —
  // porphine's trans pair, not the cis — then the first found (N–H on the earlier nitrogen).
  const spread = (out: ReadonlySet<string>): number => {
    const hydrogens = [...out];
    let nearest = Number.MAX_SAFE_INTEGER;
    for (let left = 0; left < hydrogens.length; left += 1) {
      for (let right = left + 1; right < hydrogens.length; right += 1) {
        nearest = Math.min(nearest, distances.get(hydrogens[left]!)?.get(hydrogens[right]!) ?? Number.MAX_SAFE_INTEGER);
      }
    }
    return nearest;
  };
  let best: { key: Key; spread: number; out: Set<string> } | undefined;
  let tiedOut = new Set<string>();
  let tiedIn = new Set<string>();
  const out = new Set(forcedOut);
  const visit = (position: number): void => {
    if (position === open.length) {
      const local = localScore(out);
      const stray = [...out].filter((atomId) => !smallestRing.has(atomId)).length;
      const key: Key = [-stray, local];
      const comparison = best ? compare(key, best.key) : 1;
      if (comparison > 0) {
        best = { key, spread: spread(out), out: new Set(out) };
        tiedOut = new Set(open.filter((atomId) => out.has(atomId)));
        tiedIn = new Set(open.filter((atomId) => !out.has(atomId)));
      } else if (comparison === 0 && best) {
        for (const atomId of open) (out.has(atomId) ? tiedOut : tiedIn).add(atomId);
        const candidateSpread = spread(out);
        if (candidateSpread > best.spread) best = { key, spread: candidateSpread, out: new Set(out) };
      }
      return;
    }
    const atomId = open[position]!;
    const rest = open.slice(position + 1);
    // N–H first, so among equals the first arrangement found keeps the H on the earlier nitrogen.
    out.add(atomId);
    if (matcher.solve(out, rest, { exact: targetOut - out.size })) visit(position + 1);
    out.delete(atomId);
    if (matcher.solve(out, rest, { exact: targetOut - out.size })) visit(position + 1);
  };
  visit(0);
  const chosen = best as { key: Key; spread: number; out: Set<string> } | undefined;
  if (!chosen) return undefined;
  // Only atoms that differ between tied readings are uncertain. Meso aza nitrogens in
  // phthalocyanine are bare in every tied reading, so they must not inherit the inner N badges.
  const guessed = open.filter((atomId) => tiedOut.has(atomId) && tiedIn.has(atomId));
  return finish(chosen.out, guessed);
}

interface LocalAromaticRing {
  readonly atoms: readonly string[];
  readonly base: number;
  readonly flex: readonly string[];
}

/**
 * The five-ring exception to minimum-H matching. Only N whose lone pair can complete a five-ring
 * participates; every other open atom must take a double bond. Prefer a 4n+2 conjugated system,
 * then satisfied five-rings and fewer inferred H, with a spread-out deterministic tautomer. A partially
 * satisfied macrocycle is allowed (porphine has only two pyrrole-type N), but never an open shell.
 * Where the 4n+2 criterion alone picks the H count, the N it decided are guessed (see README).
 */
function solveFiveRingHydrogens(
  flexIds: readonly string[],
  candidates: readonly string[],
  fiveRings: readonly LocalAromaticRing[],
  matcher: RingMatcher,
  baseline: number[],
  systemAtomSet: ReadonlySet<string>,
  systemPiBase: number,
  context: RingSystemContext
): RingSystemSolution | undefined {
  if (candidates.length === 0) return undefined;
  const candidateSet = new Set(candidates);
  const aromatic = (ring: LocalAromaticRing, out: ReadonlySet<string>): boolean =>
    (ring.base + ring.flex.filter((id) => out.has(id)).length) % 4 === 2;
  const needed = (out: ReadonlySet<string>): boolean => [...out].every((id) =>
    fiveRings.some((ring) => ring.flex.includes(id) && aromatic(ring, out)));
  const allOut = new Set(candidates);
  const systemAromatic = (out: ReadonlySet<string>): boolean => (systemPiBase + out.size) % 4 === 2;
  // Independent pyrrole rings, including arbitrarily long fused ladders, have an exact linear
  // constraint path: every eligible N is required and one matching proves simultaneous closure.
  if (fiveRings.every((ring) => ring.flex.filter((id) => candidateSet.has(id)).length === 1)) {
    const doubles = matcher.solve(allOut, [], { exact: 0 });
    if (doubles && systemAromatic(allOut) && needed(allOut) && fiveRings.every((ring) => aromatic(ring, allOut))) {
      return { doubles, inferred: candidates, guessed: [] };
    }
  }
  // Keep the existing bounded-search contract for highly entangled large systems. The caller's
  // maximum-matching fallback remains closed-shell; badge every unresolved five-ring choice.
  if (candidates.length > MAX_EXHAUSTIVE_OPEN_ATOMS) {
    const uncertain = flexIds.filter((id) => !context.metalDonorIds.has(id));
    return { doubles: baseline, inferred: uncertain, guessed: uncertain };
  }
  const distances = ringDistances(candidates, systemAtomSet, context);
  const spread = (out: ReadonlySet<string>): number => {
    let nearest = Number.MAX_SAFE_INTEGER;
    for (const left of out) for (const right of out) {
      if (left !== right) nearest = Math.min(nearest, distances.get(left)?.get(right) ?? Number.MAX_SAFE_INTEGER);
    }
    return nearest;
  };
  let best: { system: boolean; score: number; out: Set<string>; doubles: number[]; spread: number } | undefined;
  // Closed-shell readings the 4n+2 criterion ranks below any system-aromatic one. Where it picks a
  // system-aromatic reading over one of these with a different H count, that choice is the
  // preference's, not the ring's: the atoms the two readings disagree on are guessed, not inferred.
  const nonSystemReadings: Set<string>[] = [];
  const tiedOut = new Set<string>();
  const tiedIn = new Set<string>();
  const out = new Set<string>();
  const visit = (position: number): void => {
    if (position < candidates.length) {
      const id = candidates[position]!;
      const rest = candidates.slice(position + 1);
      out.add(id);
      if (matcher.solve(out, rest, "any")) visit(position + 1);
      out.delete(id);
      if (matcher.solve(out, rest, "any")) visit(position + 1);
      return;
    }
    if (!needed(out)) return;
    const doubles = matcher.solve(out, [], { exact: 0 });
    if (!doubles) return;
    const system = systemAromatic(out);
    if (!system) nonSystemReadings.push(new Set(out));
    const score = fiveRings.filter((ring) => aromatic(ring, out)).length;
    const comparison = best ? Number(system) - Number(best.system) || score - best.score || best.out.size - out.size : 1;
    if (comparison < 0) return;
    if (comparison > 0) {
      tiedOut.clear();
      tiedIn.clear();
    }
    for (const id of candidates) (out.has(id) ? tiedOut : tiedIn).add(id);
    const separation = spread(out);
    if (comparison > 0 || (best && separation > best.spread)) {
      best = { system, score, out: new Set(out), doubles, spread: separation };
    }
  };
  visit(0);
  const chosen = best as { system: boolean; score: number; out: Set<string>; doubles: number[] } | undefined;
  if (!chosen) return undefined;
  // Closure wins where a five-ring cannot be made aromatic without an impermissible extra H.
  // Badge those declined sites too: e.g. unhinted guanine cannot gain N1–H in its six-ring.
  const declined = candidates.filter((id) => !fiveRings.some((ring) => ring.flex.includes(id) && aromatic(ring, chosen.out)));
  const preferred = chosen.system
    ? candidates.filter((id) => nonSystemReadings.some((reading) =>
      reading.size !== chosen.out.size && reading.has(id) !== chosen.out.has(id)))
    : [];
  return {
    doubles: chosen.doubles,
    inferred: [...new Set([...tiedOut, ...declined, ...preferred])],
    guessed: [...new Set([...candidates.filter((id) => tiedOut.has(id) && tiedIn.has(id)), ...declined, ...preferred])]
  };
}

/** Bond-count distance between each pair of `atomIds`, walking the system's covalent bonds. */
function ringDistances(
  atomIds: readonly string[],
  systemAtomSet: ReadonlySet<string>,
  context: RingSystemContext
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const start of atomIds) {
    const distance = new Map([[start, 0]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const atomId = queue[head]!;
      for (const index of context.covalentByAtom.get(atomId) ?? []) {
        const next = context.otherEnd(index, atomId);
        if (!systemAtomSet.has(next) || distance.has(next)) continue;
        distance.set(next, distance.get(atomId)! + 1);
        queue.push(next);
      }
    }
    result.set(start, distance);
  }
  return result;
}

/** Every ring of up to `MAX_LOCAL_RING_SIZE` atoms, within the system, through any of `starts`. */
function smallRingsThrough(
  starts: readonly string[],
  systemAtomSet: ReadonlySet<string>,
  context: RingSystemContext
): string[][] {
  const seen = new Set<string>();
  const rings: string[][] = [];
  for (const start of starts) {
    const path = [start];
    const onPath = new Set(path);
    const walk = (atomId: string, viaBond: number): void => {
      for (const index of context.covalentByAtom.get(atomId) ?? []) {
        if (index === viaBond) continue;
        const next = context.otherEnd(index, atomId);
        if (!systemAtomSet.has(next)) continue;
        if (next === start) {
          if (path.length >= 3) {
            const key = [...path].sort().join("\u0000");
            if (!seen.has(key)) {
              seen.add(key);
              rings.push([...path]);
            }
          }
          continue;
        }
        if (onPath.has(next) || path.length >= MAX_LOCAL_RING_SIZE) continue;
        path.push(next);
        onPath.add(next);
        walk(next, index);
        path.pop();
        onPath.delete(next);
      }
    };
    walk(start, -1);
  }
  return rings;
}

interface RingMatcher {
  /**
   * The ring bonds of a Kekulé pattern in which `must` atoms and every flex atom neither `out` nor
   * `open` take one double bond each, `out` flex atoms take none, and of the `open` flex atoms either
   * any number ("any") or exactly `exact` stay out — or undefined when no such pattern exists.
   */
  solve(out: ReadonlySet<string>, open: readonly string[], openOut: "any" | { exact: number }): number[] | undefined;
}

function ringMatcher(
  mustIds: readonly string[],
  flexIds: readonly string[],
  edges: readonly (readonly [bondIndex: number, from: string, to: string])[]
): RingMatcher {
  return {
    solve(out, open, openOut) {
      if (openOut !== "any" && (openOut.exact < 0 || openOut.exact > open.length)) return undefined;
      const vertices = [...mustIds, ...flexIds.filter((atomId) => !out.has(atomId))];
      const indexOf = new Map(vertices.map((atomId, index) => [atomId, index]));
      const adjacency: number[][] = vertices.map(() => []);
      for (const [, from, to] of edges) {
        const left = indexOf.get(from);
        const right = indexOf.get(to);
        if (left === undefined || right === undefined) continue;
        adjacency[left]!.push(right);
        adjacency[right]!.push(left);
      }
      const openIndices = open.map((atomId) => indexOf.get(atomId)!);
      const addVertex = (neighbours: readonly number[]): number => {
        const vertex = adjacency.length;
        adjacency.push([...neighbours]);
        for (const neighbour of neighbours) adjacency[neighbour]!.push(vertex);
        return vertex;
      };
      if (openOut === "any") {
        // Each open atom gets a twin it may pair with instead (staying out); twins of covered open
        // atoms pair among themselves, plus one spare when the parity needs it.
        const twins: number[] = [];
        for (const vertex of openIndices) twins.push(addVertex([vertex, ...twins]));
        if ((vertices.length - open.length) % 2 === 1) addVertex(twins);
      } else {
        // Exactly `exact` open atoms stay out: that many stand-ins, each able to take any one of them.
        for (let count = 0; count < openOut.exact; count += 1) addVertex(openIndices);
      }
      if (adjacency.length % 2 === 1) return undefined;
      const match = maximumMatching(adjacency);
      if (match.includes(-1)) return undefined;
      const taken = new Uint8Array(vertices.length);
      const doubles: number[] = [];
      for (const [bondIndex, from, to] of edges) {
        const left = indexOf.get(from);
        const right = indexOf.get(to);
        if (left === undefined || right === undefined || taken[left] || taken[right] || match[left] !== right) continue;
        taken[left] = 1;
        taken[right] = 1;
        doubles.push(bondIndex);
      }
      return doubles;
    }
  };
}

/**
 * Maximum-cardinality matching in a general graph (Edmonds' blossom algorithm): a greedy start, then
 * one augmenting-path search per unmatched vertex, contracting odd cycles as they appear. O(V³) at
 * worst; ring systems are sparse and the greedy start leaves little to augment.
 */
function maximumMatching(adjacency: readonly (readonly number[])[]): Int32Array {
  const count = adjacency.length;
  const match = new Int32Array(count).fill(-1);
  for (let vertex = 0; vertex < count; vertex += 1) {
    if (match[vertex] !== -1) continue;
    for (const neighbour of adjacency[vertex]!) {
      kekuleWork += 1;
      if (match[neighbour] === -1 && neighbour !== vertex) {
        match[neighbour] = vertex;
        match[vertex] = neighbour;
        break;
      }
    }
  }
  const parent = new Int32Array(count);
  const base = new Int32Array(count);
  const used = new Uint8Array(count);
  const inBlossom = new Uint8Array(count);
  const onPath = new Uint8Array(count);
  const queue = new Int32Array(count);
  const commonBase = (left: number, right: number): number => {
    onPath.fill(0);
    kekuleWork += count;
    let vertex = left;
    for (;;) {
      vertex = base[vertex]!;
      onPath[vertex] = 1;
      if (match[vertex] === -1) break;
      vertex = parent[match[vertex]!]!;
    }
    vertex = right;
    for (;;) {
      vertex = base[vertex]!;
      if (onPath[vertex]) return vertex;
      vertex = parent[match[vertex]!]!;
    }
  };
  const markPath = (start: number, blossomBase: number, startChild: number): void => {
    let vertex = start;
    let child = startChild;
    while (base[vertex] !== blossomBase) {
      inBlossom[base[vertex]!] = 1;
      inBlossom[base[match[vertex]!]!] = 1;
      parent[vertex] = child;
      child = match[vertex]!;
      vertex = parent[match[vertex]!]!;
    }
  };
  const augmentingPathEnd = (root: number): number => {
    used.fill(0);
    parent.fill(-1);
    for (let vertex = 0; vertex < count; vertex += 1) base[vertex] = vertex;
    kekuleWork += count;
    used[root] = 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = root;
    while (head < tail) {
      const vertex = queue[head++]!;
      for (const neighbour of adjacency[vertex]!) {
        kekuleWork += 1;
        if (base[vertex] === base[neighbour] || match[vertex] === neighbour) continue;
        if (neighbour === root || (match[neighbour] !== -1 && parent[match[neighbour]!] !== -1)) {
          const blossomBase = commonBase(vertex, neighbour);
          inBlossom.fill(0);
          markPath(vertex, blossomBase, neighbour);
          markPath(neighbour, blossomBase, vertex);
          kekuleWork += count;
          for (let other = 0; other < count; other += 1) {
            if (!inBlossom[base[other]!]) continue;
            base[other] = blossomBase;
            if (!used[other]) {
              used[other] = 1;
              queue[tail++] = other;
            }
          }
        } else if (parent[neighbour] === -1) {
          parent[neighbour] = vertex;
          if (match[neighbour] === -1) return neighbour;
          const next = match[neighbour]!;
          used[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    return -1;
  };
  for (let root = 0; root < count; root += 1) {
    if (match[root] !== -1) continue;
    let vertex = augmentingPathEnd(root);
    while (vertex !== -1) {
      const previous = parent[vertex]!;
      const next = match[previous]!;
      match[vertex] = previous;
      match[previous] = vertex;
      vertex = next;
    }
  }
  return match;
}
