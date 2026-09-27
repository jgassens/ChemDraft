// Element table, valence arithmetic, and bond-order resolution for native molecules.
//
// This is the ONE implementation of "how many bonds does this atom use". The drawn label
// (`atomDisplayLabel`), the stored formula, the valence badge, the growth hotkeys and the native
// SMILES writer all count through it, so a label and the formula beside it cannot disagree (AGENTS.md
// §5.26). `@chemdraft/document-workflow-core` re-exports these names; it never carries a copy.

import { isDativeBond, type MoleculeAtom, type MoleculeBond } from "@chemdraft/chem-core";

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
  const usage = new Map(atoms.map((atom) => [atom.id, 0]));
  nativeBondOrderResolution(atoms, bonds).bonds.forEach((bond) => {
    const value = nativeBondValenceContribution(bond);
    usage.set(bond.fromAtomId, (usage.get(bond.fromAtomId) ?? 0) + value);
    usage.set(bond.toAtomId, (usage.get(bond.toAtomId) ?? 0) + value);
  });

  return usage;
}

/**
 * Covalent slots one atom uses, with aromatic bonds counted at their Kekulé orders. `atoms` is the
 * whole molecule: resolving an aromatic bond needs every ring atom's element and charge. Without
 * it an aromatic bond cannot be resolved and counts as unresolved (see `nativeBondOrderResolution`).
 */
export function nativeAtomBondOrderUsage(
  atomId: string,
  bonds: readonly MoleculeBond[],
  atoms: readonly MoleculeAtom[] = []
): number {
  return nativeBondOrderResolution(atoms, bonds).bonds.reduce((sum, bond) => (
    bond.fromAtomId === atomId || bond.toAtomId === atomId
      ? sum + nativeBondValenceContribution(bond)
      : sum
  ), 0);
}

export interface NativeBondOrderResolution {
  /**
   * The input bonds, index-aligned, with every aromatic bond rewritten: to its Kekulé order where
   * the ring system resolves, and to single where it does not. The input array itself when it holds
   * no aromatic bond, so already-kekulized molecules are counted exactly as before.
   */
  readonly bonds: readonly MoleculeBond[];
  /** Bond id → Kekulé order, for each aromatic bond that resolved. */
  readonly kekuleOrders: ReadonlyMap<string, 1 | 2>;
  /**
   * Atoms on an aromatic bond that did not resolve — outside any ring, in a ring system with no
   * Kekulé pattern, or touching an atom missing from `atoms`. Their bonds count as single, and the
   * valence check flags every one of these atoms so the guess is never silent.
   */
  readonly unresolvedAtomIds: ReadonlySet<string>;
  /** Aromatic bonds outside any ring. */
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
  atomFields: readonly (string | number | undefined)[];
  result: NativeBondOrderResolution;
}

const BOND_FIELDS = 4;
const ATOM_FIELDS = 4;

function bondFieldsOf(bonds: readonly MoleculeBond[]): (string | undefined)[] {
  return bonds.flatMap((bond) => [bond.order, bond.fromAtomId, bond.toAtomId, bond.display?.bondStyle]);
}

function atomFieldsOf(atoms: readonly MoleculeAtom[]): (string | number | undefined)[] {
  return atoms.flatMap((atom) => [atom.id, atom.element, atom.formalCharge, atom.markRadicals]);
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
      entry.bondFields[offset + 3] !== bond.display?.bondStyle
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
      entry.atomFields[offset + 3] !== atom.markRadicals
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
 * its atoms land in `unresolvedAtomIds`, which the valence check turns into a badge.
 */
export function nativeBondOrderResolution(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): NativeBondOrderResolution {
  if (!bonds.some((bond) => bond.order === "aromatic")) {
    return {
      bonds,
      kekuleOrders: emptyResolvedOrders,
      unresolvedAtomIds: emptyAtomIds,
      nonRingAromaticBondCount: 0,
      unresolvedAromaticBondCount: 0
    };
  }
  const cached = resolutionCache.get(bonds);
  if (cached && cachedResolutionMatches(cached, atoms, bonds)) {
    return cached.result;
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
    bonds: resolvedBonds,
    kekuleOrders,
    unresolvedAtomIds,
    nonRingAromaticBondCount: kekulized.nonRing,
    unresolvedAromaticBondCount: kekulized.unresolved
  };
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

/** Node-visit budget for one ring system's matching search; past it the system is reported. */
const KEKULE_SEARCH_BUDGET = 200000;

/**
 * Assign alternating single/double orders to the aromatic bonds so the result is a valid Kekulé
 * structure. Returns the bonds with every resolvable aromatic bond rewritten, plus how many
 * aromatic bonds were left as they are because they sit outside any ring (`nonRing`) or belong to
 * a ring system with no assignment (`unresolved`); those stay `aromatic` in the returned bonds.
 *
 * Ring membership is judged on the covalent graph, not the aromatic bonds alone, so a ring whose
 * aromatic run is closed by an explicit single or double bond (one bond of a pasted benzene redrawn
 * as double) still resolves.
 *
 * Each atom on a ring aromatic bond either takes exactly one double bond or none. The app's own
 * valence model decides what an atom CAN do: with no spare slot beyond its bonds (furan's O,
 * thiophene's S, N-methylpyrrole's N) it takes none and keeps its lone pair. A neutral carbon
 * (or boron) with a spare slot must take one — a ring carbon holds no lone pair. Everything
 * else with a spare slot is flexible: pyridine's N, pyrrole's N–H, a C⁻, an O⁺. The search
 * per ring system finds a perfect matching over the must-take atoms plus as many flexible atoms
 * as possible — pyridazine's two adjacent nitrogens pair with each other, pyrrole's lone N is
 * the one atom left out of a five-ring, tropylium's C⁺ likewise, and the cyclopentadienyl C⁻
 * keeps its hydrogen. An atom left out keeps the hydrogen count the valence model gives it.
 * Ring systems are solved independently so one unresolvable ring never spoils another, and the
 * search stops at the first assignment that leaves no flexible atom out. A ring system with an atom
 * missing from `atoms` cannot be judged and is reported unresolved rather than guessed.
 */
export function kekulizeNativeAromaticBonds(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): { bonds: MoleculeBond[]; nonRing: number; unresolved: number } {
  const aromaticIndices = bonds.flatMap((bond, index) => bond.order === "aromatic" ? [index] : []);
  if (aromaticIndices.length === 0) {
    return { bonds: [...bonds], nonRing: 0, unresolved: 0 };
  }
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const otherEnd = (index: number, atomId: string): string =>
    bonds[index]!.fromAtomId === atomId ? bonds[index]!.toAtomId : bonds[index]!.fromAtomId;

  // Ring membership on the covalent graph: a bond is a bridge (in no ring) when removing it
  // disconnects its ends. Bridges are written single; only ring bonds enter the matching.
  const covalentByAtom = new Map<string, number[]>();
  bonds.forEach((bond, index) => {
    if (isDativeBond(bond)) return;
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      covalentByAtom.set(atomId, [...(covalentByAtom.get(atomId) ?? []), index]);
    }
  });
  const connectedWithout = (skip: number, from: string, to: string): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const atomId = queue.pop()!;
      if (atomId === to) return true;
      for (const index of covalentByAtom.get(atomId) ?? []) {
        if (index === skip) continue;
        const next = otherEnd(index, atomId);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };
  const ringIndices = aromaticIndices.filter((index) =>
    connectedWithout(index, bonds[index]!.fromAtomId, bonds[index]!.toAtomId)
  );
  const nonRing = aromaticIndices.length - ringIndices.length;
  const ringByAtom = new Map<string, number[]>();
  for (const index of ringIndices) {
    for (const atomId of [bonds[index]!.fromAtomId, bonds[index]!.toAtomId]) {
      ringByAtom.set(atomId, [...(ringByAtom.get(atomId) ?? []), index]);
    }
  }

  // Valence already spent on everything but ring aromatic bonds (a non-ring aromatic bond
  // counts as the single it becomes), then each atom's class. An atom that already carries an
  // explicit double or triple bond has its π bond and takes no second one from the ring, even when
  // its arithmetic would allow it: one bond of a pasted benzene redrawn as double must not turn
  // its carbons into ring allenes.
  const spent = new Map<string, number>();
  const hasExplicitMultiple = new Set<string>();
  const ringIndexLookup = new Set(ringIndices);
  bonds.forEach((bond, index) => {
    if (ringIndexLookup.has(index)) return;
    const value = bond.order === "aromatic" || bond.order === "unknown" ? 1 : nativeBondValenceContribution(bond);
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      spent.set(atomId, (spent.get(atomId) ?? 0) + value);
      if (bond.order === "double" || bond.order === "triple") hasExplicitMultiple.add(atomId);
    }
  });
  type AtomClass = "must" | "never" | "flex";
  const classOf = new Map<string, AtomClass>();
  const missingAtomIds = new Set<string>();
  for (const atomId of ringByAtom.keys()) {
    const atom = atomById.get(atomId);
    if (!atom) {
      missingAtomIds.add(atomId);
      classOf.set(atomId, "never");
      continue;
    }
    const element = nativeElementFromAtomLabel(atom.element);
    if (!element || hasExplicitMultiple.has(atomId)) {
      classOf.set(atomId, "never");
      continue;
    }
    const spare = nativeAtomValenceForCharge(element, atom.formalCharge)
      - (spent.get(atomId) ?? 0) - (ringByAtom.get(atomId)?.length ?? 0) - (atom.markRadicals ?? 0);
    classOf.set(atomId, kekuleAtomClass(element, atom.formalCharge, spare));
  }
  // Deterministic search: neighbours in id order, whatever order the bond array arrived in.
  for (const [atomId, indices] of ringByAtom) {
    ringByAtom.set(atomId, [...indices].sort((left, right) => otherEnd(left, atomId).localeCompare(otherEnd(right, atomId))));
  }

  // Ring systems: connected components of the ring aromatic bonds, solved one at a time.
  const doubleIndices = new Set<number>();
  const unresolvedIndices = new Set<number>();
  const ringIndexSet = new Set(ringIndices);
  const assignedAtoms = new Set<string>();
  for (const seedAtomId of ringByAtom.keys()) {
    if (assignedAtoms.has(seedAtomId)) continue;
    const systemAtoms: string[] = [];
    const queue = [seedAtomId];
    assignedAtoms.add(seedAtomId);
    while (queue.length > 0) {
      const atomId = queue.pop()!;
      systemAtoms.push(atomId);
      for (const index of ringByAtom.get(atomId) ?? []) {
        const next = otherEnd(index, atomId);
        if (!assignedAtoms.has(next)) {
          assignedAtoms.add(next);
          queue.push(next);
        }
      }
    }
    const systemBonds = new Set(systemAtoms.flatMap((atomId) => ringByAtom.get(atomId) ?? []));
    const solution = systemAtoms.some((atomId) => missingAtomIds.has(atomId))
      ? undefined
      : kekuleMatching(systemAtoms, classOf, ringByAtom, otherEnd);
    if (solution) {
      for (const index of solution) doubleIndices.add(index);
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
    unresolved: unresolvedIndices.size
  };
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
function kekuleAtomClass(element: NativeElementSymbol, formalCharge: number, spare: number): "must" | "never" | "flex" {
  if (spare < 1) return "never";
  // A B⁻ is carbon-like (boratabenzene's B⁻ takes a double bond); every other anion holds a pair.
  if (formalCharge < 0) return element === "B" ? "must" : "never";
  if (formalCharge > 0) return element === "C" || element === "B" ? "never" : "must";
  if (element === "C" || element === "B") return "must";
  return element === "N" || element === "P" || element === "As" ? "flex" : "never";
}

/**
 * Branch-and-bound matching for one ring system: every "must" atom takes exactly one bond, no
 * "never" atom takes any, and as few "flex" atoms as possible are left out. Returns the chosen
 * bond indices, or undefined when no assignment covers the must atoms — or when the visit budget
 * ran out before an assignment leaving no flexible atom out was found, since a provisional best
 * is then unproven and must not reach the document silently.
 */
function kekuleMatching(
  systemAtoms: readonly string[],
  classOf: ReadonlyMap<string, "must" | "never" | "flex">,
  ringByAtom: ReadonlyMap<string, readonly number[]>,
  otherEnd: (index: number, atomId: string) => string
): Set<number> | undefined {
  const order = [
    ...systemAtoms.filter((atomId) => classOf.get(atomId) === "must"),
    ...systemAtoms.filter((atomId) => classOf.get(atomId) === "flex")
  ].sort((left, right) => (classOf.get(left) === classOf.get(right) ? left.localeCompare(right) : classOf.get(left) === "must" ? -1 : 1));
  const matched = new Set<string>();
  const chosen = new Set<number>();
  let best: Set<number> | undefined;
  let bestLeftOut = Number.POSITIVE_INFINITY;
  let visits = 0;
  let exhausted = false;
  const search = (position: number, leftOut: number): void => {
    if (best && bestLeftOut === 0) return;
    if (leftOut >= bestLeftOut) return;
    if (visits++ > KEKULE_SEARCH_BUDGET) {
      exhausted = true;
      return;
    }
    let index = position;
    while (index < order.length && matched.has(order[index]!)) index += 1;
    if (index >= order.length) {
      bestLeftOut = leftOut;
      best = new Set(chosen);
      return;
    }
    const atomId = order[index]!;
    for (const bondIndex of ringByAtom.get(atomId) ?? []) {
      const other = otherEnd(bondIndex, atomId);
      if (matched.has(other) || classOf.get(other) === "never") continue;
      matched.add(atomId);
      matched.add(other);
      chosen.add(bondIndex);
      search(index + 1, leftOut);
      chosen.delete(bondIndex);
      matched.delete(atomId);
      matched.delete(other);
    }
    if (classOf.get(atomId) === "flex") {
      matched.add(atomId);
      search(index + 1, leftOut + 1);
      matched.delete(atomId);
    }
  };
  search(0, 0);
  return exhausted && bestLeftOut > 0 ? undefined : best;
}
