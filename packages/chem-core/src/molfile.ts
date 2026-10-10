/**
 * Minimal V2000 molfile writer (Phase 5.0).
 *
 * Serializes a `MoleculeObject`'s graph + 2D coordinates + wedge/hash stereo into a
 * V2000 molblock that both OpenChemLib and RDKit parse. It is the inverse of the
 * app's molfile import and the bridge that lets the 3D-spin pipeline hand a drawn
 * molecule to the conformer engine and write the flattened result back into
 * `molecule.structure`.
 *
 * Two hard contracts:
 *   1. ATOM ORDER is preserved exactly (`mol.atoms` order == molblock atom order),
 *      so `ConformerAtomMapping.coords3dByOriginalAtom` (indexed by original atom)
 *      stays aligned after a round-trip through the engine.
 *   2. FRAME. The math/molfile frame is y-UP; ChemDraft documents are y-DOWN. Pass
 *      `fromDocFrame: true` to negate y on write (doc → molfile). Wedge/hash styles
 *      are NEVER swapped — only y is negated. (See the coordinate-frame contract in
 *      docs/architecture/3d-spin-flatten.md.)
 *
 * Field widths mirror `tools/rdkit-oracle/oracle.py` `_build_molblock`, which is
 * proven against RDKit in the Phase 1C/2 tests.
 *
 * Known limitations (the native model does not carry these, so they cannot be emitted):
 *   - Isotopes (`M  ISO`) are not represented in `MoleculeAtom` and are therefore not written.
 *     A round-trip through this writer loses them.
 *   - `unknown` bond order is written as type 8 (any) in both formats, with a warning. Readers
 *     treat it as a query bond with no chemical order; chemistry and 3D engine callers must use
 *     `unknownBondOrders: "refuse"`. Geometry-only layout requires tested query-bond support.
 *   - Dative (dashed single) bonds have no V2000 encoding: V2000 writes them as single bonds with
 *     a warning; V3000 preserves them as bond type 9 (coordination), which CTfile-aware parsers
 *     read back as dative. Dashed display on another bond order is omitted with a warning rather
 *     than replacing that bond's chemical order with a coordination bond.
 *   - An atom label that is not an element symbol (a condensed label like "CH3", an
 *     abbreviation like "Ph") writes as a dummy atom ("*") with a warning — the group the label
 *     spells is not represented in the molfile. Consumers inside the app that RANK atoms (CIP
 *     perception, the plugin hand-off) ask for `abbreviations: "rgroup"` instead; see the option.
 *   - A literal (text-typed) atom on an unknown-order or unresolved aromatic bond gets no explicit
 *     valence field, with a warning; resolved aromatic bonds count at the caller's Kekulé orders.
 *   - Coordinates ≥1e6 / counts >999 cannot fit V2000's fixed columns; the writer trims
 *     coordinate precision to preserve alignment and throws on >999 atoms/bonds.
 */

import { bridgeBondIndices } from "./bondGraph";
import { elementSymbols, isMetalSymbol } from "./elements";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

export interface MolfileWriteOptions {
  /** Preserve unknown orders as query type 8 (default), or refuse before writing engine input. */
  unknownBondOrders?: "any" | "refuse";
  /** Negate y on write (ChemDraft document y-down → molfile y-up). Default false. */
  fromDocFrame?: boolean;
  /** Optional legacy collector. Warnings are also ALWAYS returned in MolfileWriteResult. */
  warnings?: string[];
  /**
   * How an atom whose label is not an element symbol ("Ph", "CH3", "CO2H") is written.
   *
   * - `"dummy"` (default): the CTfile dummy atom "*". Right for a file that leaves the app —
   *   every reader parses it — but OpenChemLib reads "*" as a CARBON, so inside the app it is
   *   wrong for anything that ranks substituents: a center bearing "Ph" and a methyl reads as
   *   two identical carbons and stops being a stereocenter.
   * - `"rgroup"`: an R-group pseudo-atom — `R#` with an `M  RGP` entry (V2000) or `RGROUPS=`
   *   (V3000) — numbered per distinct label in first-seen order, so equal labels rank equal and
   *   different labels rank apart from each other and from every element. Still a standard
   *   molfile. OpenChemLib tells R1–R16 apart (a seventeenth label reads as "?", still no
   *   element) and honours only the V2000 form, so perception must use V2000.
   *
   * Either way the group itself is not represented, and the writer warns.
   */
  abbreviations?: "dummy" | "rgroup";
  /**
   * Bond id → the order (1 or 2) each aromatic bond takes in a Kekulé structure. These orders are
   * written in both formats, preserving the resolved ring N–H tautomer as well as literal atom
   * valences. chem-core has no valence model: callers use layout-engine's
   * `nativeBondOrderResolution(...).kekuleOrders`. An unresolved bond stays type 4 (aromatic) with a
   * warning, and an adjacent literal atom gets no valence field (its sum is not known).
   */
  kekuleBondOrders: ReadonlyMap<string, number>;
  /**
   * Spells a condensed label as one element carrying a stated number of hydrogens ("OH" → O with
   * one, "NH2" → N with two), or returns undefined. A spelled atom is written as that element with
   * an explicit valence of its bond-order sum plus those hydrogens, so a reader counts exactly the
   * hydrogens the label names — never a placeholder, never its own default valence. Aromatic bonds
   * count at their `kekuleBondOrders` order. When the valence cannot say it exactly — an aromatic
   * bond has no resolved order, a bond has unknown order, or the sum passes 14 — the label is not
   * spelled and takes the placeholder path with a warning instead. Label parsing lives with the caller (the app's
   * condensed-label grammar is above this package).
   */
  spellLabel?: (label: string) => { element: string; hydrogens: number } | undefined;
}

const BOND_ORDER_CODE: Record<MoleculeBond["order"], number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 4,
  unknown: 8
};

// CTfile type codes are not valence contributions: aromatic and query bonds need resolved orders.
const BOND_VALENCE_INCREMENT: Record<MoleculeBond["order"], number | undefined> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: undefined,
  unknown: undefined
};

/** An engine cannot assign chemical meaning to an unknown-order bond. Callers add context. */
export class UnknownBondOrderError extends Error {
  readonly bondIds: string[];

  constructor(bondIds: readonly string[]) {
    super(`${bondIds.length === 1 ? "Bond" : "Bonds"} ${bondIds.join(", ")} ${bondIds.length === 1 ? "has" : "have"} an unknown bond order.`);
    this.name = "UnknownBondOrderError";
    this.bondIds = [...bondIds];
  }
}

function handleUnknownBondOrders(mol: MoleculeObject, options: MolfileWriteOptions): void {
  const ids = mol.bonds.filter((bond) => bond.order === "unknown").map((bond) => bond.id);
  if (ids.length === 0) return;
  const error = new UnknownBondOrderError(ids);
  if (options.unknownBondOrders === "refuse") throw error;
  options.warnings?.push(error.message.slice(0, -1) +
    "; written as bond type 8 (any), which readers treat as a query bond with no chemical order.");
}

/**
 * A dashed single bond depicts a dative/coordination interaction (zero covalent valence on either
 * atom). V3000 spells it as bond type 9, the CTfile coordination type, so the file round-trips;
 * V2000 has no coordination type, so there it degrades to a plain single bond and the writer warns.
 * Requiring single order prevents display styling on a multiple bond from deleting its bond order.
 */
export function isDativeBond(bond: MoleculeBond): boolean {
  return bond.order === "single" && bond.display?.bondStyle === "dashed";
}

export interface MolfileWriteResult {
  contents: string;
  warnings: string[];
}

function resolvedMolfileBondCode(bond: MoleculeBond, options: MolfileWriteOptions): number {
  if (bond.order !== "aromatic") return BOND_ORDER_CODE[bond.order];
  const order = options.kekuleBondOrders.get(bond.id);
  return order === 1 || order === 2 ? order : 4;
}

/** One note per unresolved ring system, including mixed aromatic/explicit ring bonds. */
function warnUnresolvedAromaticBonds(
  atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[], options: MolfileWriteOptions
): void {
  const unresolved = bonds.filter((bond) => bond.order === "aromatic" &&
    ![1, 2].includes(options.kekuleBondOrders.get(bond.id) ?? 0));
  if (unresolved.length === 0) return;
  const otherEnd = (index: number, id: string): string =>
    bonds[index]!.fromAtomId === id ? bonds[index]!.toAtomId : bonds[index]!.fromAtomId;
  const bridges = bridgeBondIndices(bonds, otherEnd, (bond) => !isDativeBond(bond));
  const adjacency = new Map<string, string[]>();
  bonds.forEach((bond, index) => {
    if (bridges.has(index) || isDativeBond(bond)) return;
    for (const [from, to] of [[bond.fromAtomId, bond.toAtomId], [bond.toAtomId, bond.fromAtomId]] as const) {
      const neighbours = adjacency.get(from) ?? [];
      neighbours.push(to);
      adjacency.set(from, neighbours);
    }
  });
  const seen = new Set<string>();
  const unresolvedIds = new Set(unresolved.flatMap((bond) => [bond.fromAtomId, bond.toAtomId]));
  const literalIds = new Set(atoms.filter((atom) => atom.labelLiteral && unresolvedIds.has(atom.id)).map((atom) => atom.id));
  for (const bond of unresolved) {
    if (seen.has(bond.fromAtomId) && seen.has(bond.toAtomId)) continue;
    const system = new Set([bond.fromAtomId, bond.toAtomId]);
    const queue = [...system];
    for (let i = 0; i < queue.length; i += 1) {
      for (const next of adjacency.get(queue[i]!) ?? []) {
        if (system.has(next)) continue;
        system.add(next);
        queue.push(next);
      }
    }
    for (const id of system) seen.add(id);
    const ids = [...system].sort();
    const literal = ids.filter((id) => literalIds.has(id));
    options.warnings?.push(
      `Aromatic bonds at atoms ${ids.join(", ")} have no resolved Kekulé order; preserved as type 4 (aromatic).` +
      (literal.length > 0 ? ` Literal atoms ${literal.join(", ")} are written without a valence field, so a reader may add hydrogens.` : "")
    );
  }
}

function v3000BondAtomIds(bond: MoleculeBond, atomById: ReadonlyMap<string, MoleculeAtom>): [string, string] {
  // CTfile type 9 is directional: donor first, acceptor second. Drawing from the metal must not
  // turn an amine donor into an acceptor and cost it a hydrogen when a chemistry engine reads it.
  if (isDativeBond(bond) && isMetalSymbol(atomById.get(bond.fromAtomId)!.element) &&
    !isMetalSymbol(atomById.get(bond.toAtomId)!.element)) {
    return [bond.toAtomId, bond.fromAtomId];
  }
  return [bond.fromAtomId, bond.toAtomId];
}

/**
 * A dashed display on a non-single bond cannot mean coordination without destroying its chemical
 * order. Keep the order and report the lost display style instead of silently changing chemistry.
 */
function warnUnsupportedDashedBondStyles(bonds: readonly MoleculeBond[], options: MolfileWriteOptions): void {
  for (const bond of bonds) {
    if (bond.display?.bondStyle === "dashed" && bond.order !== "single") {
      const code = resolvedMolfileBondCode(bond, options);
      const emittedOrder = code === 1 ? "single" : code === 2 ? "double" : code === 3 ? "triple" : code === 8 ? "any" : "aromatic";
      const article = bond.order === "aromatic" || bond.order === "unknown" ? "an" : "a";
      options.warnings?.push(
        `Dashed display on ${article} ${bond.order} bond is not a coordination bond; written as bond type ${code} (${emittedOrder}), dashed style not preserved.`
      );
    }
  }
}

/**
 * Every IUPAC element symbol plus CTfile's D, T and dummy atom "*". The molfile atom column must hold
 * one of these — never a display label. Built from the native model's ordered element table; the
 * app's own list (layout-engine's `nativeElementSymbols`) lives above this package boundary.
 */
const MOLFILE_ATOM_SYMBOLS = new Set<string>([...elementSymbols, "D", "T", "*"]);

/**
 * What one bond adds to the explicit valence of each of its atoms, as a reader of `format` counts
 * it, or undefined for an unknown-order bond or an aromatic bond with no resolved Kekulé order.
 * Aromatic type 4 and query type 8 are codes, not counts: an aromatic bond is single or double
 * depending on the ring's Kekulé pattern, and 1.5 per
 * bond matched that only by accident (a benzene C, 3) and was wrong elsewhere (a furan O read 3, a
 * fused C 4.5). V2000 emits dative as single; V3000 readers count a coordination bond only at its
 * acceptor, so its donor gets nothing. Shared by the literal-valence pass and the spell guard so
 * the two can never disagree.
 */
function bondValenceIncrements(
  bond: MoleculeBond,
  atomById: ReadonlyMap<string, MoleculeAtom>,
  format: "V2000" | "V3000",
  kekuleBondOrders: ReadonlyMap<string, number>
): [[string, number], [string, number]] | undefined {
  const kekuleOrder = bond.order === "aromatic" ? kekuleBondOrders.get(bond.id) : undefined;
  if (bond.order === "aromatic" && kekuleOrder !== 1 && kekuleOrder !== 2) return undefined;
  const order = kekuleOrder ?? BOND_VALENCE_INCREMENT[bond.order];
  if (order === undefined) return undefined;
  const dative = format === "V3000" && isDativeBond(bond);
  const [from, to] = dative ? v3000BondAtomIds(bond, atomById) : [bond.fromAtomId, bond.toAtomId];
  return [[from, dative ? 0 : order], [to, order]];
}

/** The largest explicit valence the CTfile valence field holds (V2000 vvv, V3000 VAL=). */
const MAX_EXPLICIT_VALENCE = 14;

/** Explicit valence stops a reader adding hydrogens to a literal element label. */
function literalAtomValences(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  format: "V2000" | "V3000",
  warnings: string[] | undefined,
  kekuleBondOrders: ReadonlyMap<string, number>,
  spelledHydrogens: ReadonlyMap<string, number> = new Map()
): Map<string, number> {
  const valences = new Map(atoms
    .filter((atom) => atom.labelLiteral === true && atom.element !== "*" && MOLFILE_ATOM_SYMBOLS.has(atom.element))
    .map((atom) => [atom.id, 0]));
  // A spelled condensed label starts from the hydrogens it names; its bonds are added below.
  for (const [id, hydrogens] of spelledHydrogens) {
    valences.set(id, hydrogens);
  }
  if (valences.size === 0) return valences;
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const unresolved = new Set<string>();
  const unknownContact = new Set<string>();
  for (const bond of bonds) {
    const increments = bondValenceIncrements(bond, atomById, format, kekuleBondOrders);
    if (!increments) {
      unresolved.add(bond.fromAtomId);
      unresolved.add(bond.toAtomId);
      if (bond.order === "unknown") {
        unknownContact.add(bond.fromAtomId);
        unknownContact.add(bond.toAtomId);
      }
      continue;
    }
    for (const [id, increment] of increments) {
      if (valences.has(id)) valences.set(id, valences.get(id)! + increment);
    }
  }
  const unknownLiteralIds = [...unknownContact].filter((id) => valences.has(id)).sort();
  if (unknownLiteralIds.length > 0) {
    warnings?.push(
      `Literal atoms ${unknownLiteralIds.join(", ")} have an unknown-order bond; written without a valence field, so a reader may add hydrogens.`
    );
  }
  for (const id of unresolved) {
    if (!valences.has(id)) continue;
    // The unknown-contact and ring-system warnings report the omitted literal-atom valences.
    valences.delete(id);
  }
  for (const [id, valence] of valences) {
    // CTfile's explicit valence is an integer from 1 to 14, plus a zero-valence sentinel. An
    // unrepresentable sum gets no field and a warning rather than a clamped value that would
    // invent hydrogens — or an exception that would abort the whole export, cleanup or 3D pass
    // this writer is feeding.
    if (!Number.isInteger(valence) || valence > MAX_EXPLICIT_VALENCE) {
      const atom = atomById.get(id)!;
      warnings?.push(
        `Literal atom "${atom.element}" has a bond-order sum of ${valence}, which the ${format} valence field cannot hold; written without it, so a reader may add hydrogens.`
      );
      valences.delete(id);
    }
  }
  return valences;
}

/**
 * The symbols for the molfile atom column, in atom order, plus the R-group assignments that
 * `abbreviations: "rgroup"` produced. A label that is not an element symbol (a condensed label
 * like "CH3", an abbreviation like "Ph") written verbatim is an invalid molfile — and at four or
 * more characters it overflows V2000's fixed 3-char column, corrupting every field that follows.
 * Write a placeholder and warn instead (AGENTS.md §5.7/§14): the dummy atom "*" by default, or an
 * R-group numbered per distinct label so readers keep the labels apart (see the option).
 */
function molfileAtomSymbols(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  format: "V2000" | "V3000",
  options: MolfileWriteOptions
): {
  symbols: string[];
  rgroups: { atomNumber: number; rgroup: number }[];
  /** Hydrogens stated by each atom `spellLabel` spelled, keyed by atom id. */
  spelledHydrogens: Map<string, number>;
} {
  const rgroupByLabel = new Map<string, number>();
  const rgroups: { atomNumber: number; rgroup: number }[] = [];
  const spelledHydrogens = new Map<string, number>();
  // Bond-order sums and unresolved bond contact, computed only when a label might be spelled: a
  // spelled atom's hydrogens are carried by its explicit valence, so the sum decides whether
  // spelling is even possible.
  let bondValence: Map<string, { sum: number; unresolvedAromatic: boolean; unknownOrder: boolean }> | undefined;
  const bondValenceOf = (atomId: string) => {
    if (!bondValence) {
      const valence = new Map<string, { sum: number; unresolvedAromatic: boolean; unknownOrder: boolean }>();
      const entryOf = (id: string) => {
        const entry = valence.get(id) ?? { sum: 0, unresolvedAromatic: false, unknownOrder: false };
        valence.set(id, entry);
        return entry;
      };
      const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
      for (const bond of bonds) {
        const increments = bondValenceIncrements(bond, atomById, format, options.kekuleBondOrders);
        if (!increments) {
          for (const id of [bond.fromAtomId, bond.toAtomId]) {
            const entry = entryOf(id);
            if (bond.order === "unknown") entry.unknownOrder = true;
            else entry.unresolvedAromatic = true;
          }
          continue;
        }
        for (const [id, increment] of increments) entryOf(id).sum += increment;
      }
      bondValence = valence;
    }
    return bondValence.get(atomId) ?? { sum: 0, unresolvedAromatic: false, unknownOrder: false };
  };
  const symbols = atoms.map((atom, index) => {
    // A literal "*" label (a pasted dummy atom) is a valid molfile symbol, but in rgroup mode it
    // must not pass through: OpenChemLib reads "*" as a carbon, which is exactly the misranking
    // this mode exists to prevent. It is a group the file does not spell, like any other label.
    if (MOLFILE_ATOM_SYMBOLS.has(atom.element) && !(options.abbreviations === "rgroup" && atom.element === "*")) {
      return atom.element;
    }
    const spelled = options.spellLabel?.(atom.element);
    // Why a label that spells cleanly still cannot be written as its element, if it cannot.
    let unspellable: string | undefined;
    if (
      spelled &&
      spelled.element !== "*" &&
      MOLFILE_ATOM_SYMBOLS.has(spelled.element) &&
      Number.isInteger(spelled.hydrogens) &&
      spelled.hydrogens >= 0
    ) {
      // A spelled label is only as good as the explicit valence that carries its hydrogens. An
      // unknown-order or unresolved aromatic bond leaves that valence unknown, and a sum past the
      // field's ceiling cannot be written at all. Writing the bare element in either case lets the
      // reader pick its own hydrogen count (AGENTS.md §5.7), so fall through to the placeholder,
      // which at least says the group is not represented.
      const { sum, unresolvedAromatic, unknownOrder } = bondValenceOf(atom.id);
      if (unknownOrder) {
        unspellable = "it has an unknown-order bond, so the hydrogen count it states cannot be carried by an explicit valence";
      } else if (unresolvedAromatic) {
        unspellable = "it has an aromatic bond with no resolved Kekulé order, so the hydrogen count it states cannot be carried by an explicit valence";
      } else if (sum + spelled.hydrogens > MAX_EXPLICIT_VALENCE) {
        unspellable = `its bond orders and stated hydrogens sum to ${sum + spelled.hydrogens}, past the ${format} valence field's limit of ${MAX_EXPLICIT_VALENCE}`;
      } else {
        spelledHydrogens.set(atom.id, spelled.hydrogens);
        return spelled.element;
      }
    }
    const reason = unspellable ? `; it cannot be written as ${spelled!.element} because ${unspellable}` : "";
    if (options.abbreviations === "rgroup") {
      let rgroup = rgroupByLabel.get(atom.element);
      if (rgroup === undefined) {
        rgroup = rgroupByLabel.size + 1;
        rgroupByLabel.set(atom.element, rgroup);
      }
      rgroups.push({ atomNumber: index + 1, rgroup });
      options.warnings?.push(
        `Atom label "${atom.element}" is not an element symbol${reason}; written as R-group placeholder R${rgroup} — the label's group is not represented in the molfile.`
      );
      return "R#";
    }
    options.warnings?.push(
      `Atom label "${atom.element}" is not an element symbol${reason}; written as a dummy atom (*) — the label's group is not represented in the molfile.`
    );
    return "*";
  });
  return { symbols, rgroups, spelledHydrogens };
}

function f10_4(value: number): string {
  // Guard -0 and non-finite so the column never corrupts.
  const safe = Number.isFinite(value) ? value + 0 : 0;
  let text = safe.toFixed(4);
  if (text.length > 10) {
    // Coordinate too large for the fixed 10-char column: drop decimal places so the
    // column stays exactly 10 wide rather than shifting every field that follows.
    text = safe.toFixed(Math.max(0, 4 - (text.length - 10)));
    if (text.length > 10) {
      text = text.slice(0, 10); // pathological magnitude — clamp width to preserve alignment
    }
  }
  return text.padStart(10);
}

function i3(value: number): string {
  // Never exceed the fixed 3-char column: a wider value would shift the counts line and
  // every subsequent column. Callers guard atom/bond counts to ≤999 (the V2000 limit), so
  // truncation here is purely defensive against an unexpected overflow.
  const text = String(Math.trunc(value));
  return text.length > 3 ? text.slice(-3) : text.padStart(3);
}

function i4(value: number): string {
  return String(value).padStart(4);
}

function wedgeStereoFlag(bond: MoleculeBond): number {
  const style = bond.display?.bondStyle;
  if (style === "wedge") return 1; // up (narrow end at fromAtomId)
  if (style === "hashed") return 6; // down
  return 0;
}

/**
 * MDL `RAD` atom-radical code from the drawn unpaired-electron count. One dot is an ordinary
 * (doublet) radical; two dots on the same atom is written as a triplet, the conventional reading
 * when spin pairing isn't tracked separately (matching how other drawing tools serialize it).
 * 0 means "not a radical" and is never written as a property line.
 */
function mdlRadicalCode(markRadicals: number | undefined): number {
  if (!markRadicals || markRadicals <= 0) return 0;
  return markRadicals === 1 ? 2 : 3;
}

/**
 * Serialize `mol` to a V2000 molblock. Atoms are written in `mol.atoms` order with
 * 1-based bond indices; wedge/hash become bond stereo flags (1/6) at the narrow end
 * (`fromAtomId`); nonzero formal charges become `M  CHG` lines.
 */
export function moleculeToMolfileV2000(mol: MoleculeObject, options: MolfileWriteOptions): MolfileWriteResult {
  const warningsOut = options.warnings;
  const warnings: string[] = [];
  options = { ...options, warnings };
  handleUnknownBondOrders(mol, options);
  const ySign = options.fromDocFrame ? -1 : 1;
  const atoms = mol.atoms;
  const bonds = mol.bonds;

  const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index + 1] as const)); // 1-based

  // Drop dangling bonds (endpoint not in the atom list) BEFORE writing the counts line, so
  // the declared bond count matches the number of bond lines actually emitted — otherwise a
  // fixed-width parser reads atom/property lines as phantom bonds.
  const writableBonds = bonds.filter(
    (bond) => atomIndex.has(bond.fromAtomId) && atomIndex.has(bond.toAtomId)
  );

  // V2000 atom/bond counts live in 3-char columns: values >999 cannot be represented and
  // would corrupt the whole molblock. Refuse rather than emit a silently-broken file.
  if (atoms.length > 999 || writableBonds.length > 999) {
    throw new Error(
      `V2000 supports at most 999 atoms and 999 bonds (got ${atoms.length} atoms, ${writableBonds.length} bonds).`
    );
  }

  const hasStereo = writableBonds.some((bond) => wedgeStereoFlag(bond) !== 0);
  const chiralFlag = hasStereo ? 1 : 0;

  const dativeBondCount = writableBonds.filter(isDativeBond).length;
  warnUnsupportedDashedBondStyles(writableBonds, options);
  warnUnresolvedAromaticBonds(atoms, writableBonds, options);
  if (dativeBondCount > 0) {
    options.warnings?.push(
      `V2000 has no coordination bond type: ${dativeBondCount} dative (dashed) bond${dativeBondCount === 1 ? "" : "s"} written as plain single. Export V3000 to preserve ${dativeBondCount === 1 ? "it" : "them"}.`
    );
  }

  const lines: string[] = ["", "  ChemDraft", ""];
  lines.push(`${i3(atoms.length)}${i3(writableBonds.length)}  0  0  ${chiralFlag}  0  0  0  0  0999 V2000`);

  const { symbols, rgroups, spelledHydrogens } = molfileAtomSymbols(atoms, writableBonds, "V2000", options);
  const literalValences = literalAtomValences(
    atoms, writableBonds, "V2000", options.warnings, options.kekuleBondOrders, spelledHydrogens
  );
  atoms.forEach((atom, index) => {
    const x = f10_4(atom.x);
    const y = f10_4(ySign * atom.y);
    const z = f10_4(0);
    const valence = literalValences.get(atom.id);
    const valenceCode = valence === undefined ? 0 : valence === 0 ? 15 : valence;
    // vvv occupies columns 49–51, after mass, charge, parity, H count and stereo-care.
    lines.push(`${x}${y}${z} ${symbols[index]!.padEnd(3)} 0  0  0  0  0${i3(valenceCode)}  0  0  0  0  0  0`);
  });

  for (const bond of writableBonds) {
    const from = atomIndex.get(bond.fromAtomId)!;
    const to = atomIndex.get(bond.toAtomId)!;
    lines.push(`${i3(from)}${i3(to)}${i3(resolvedMolfileBondCode(bond, options))}${i3(wedgeStereoFlag(bond))}  0  0  0`);
  }

  // Charge property lines: up to 8 (atom, charge) pairs per "M  CHG" line.
  const charged = atoms
    .map((atom, index) => ({ atomNumber: index + 1, charge: atom.formalCharge }))
    .filter((entry) => entry.charge !== 0);
  for (let i = 0; i < charged.length; i += 8) {
    const chunk = charged.slice(i, i + 8);
    const body = chunk.map((entry) => `${i4(entry.atomNumber)}${i4(entry.charge)}`).join("");
    lines.push(`M  CHG${i3(chunk.length)}${body}`);
  }

  // Radical property lines: same up-to-8-pairs-per-line shape as M CHG above.
  const radicals = atoms
    .map((atom, index) => ({ atomNumber: index + 1, radicalCode: mdlRadicalCode(atom.markRadicals) }))
    .filter((entry) => entry.radicalCode !== 0);
  for (let i = 0; i < radicals.length; i += 8) {
    const chunk = radicals.slice(i, i + 8);
    const body = chunk.map((entry) => `${i4(entry.atomNumber)}${i4(entry.radicalCode)}`).join("");
    lines.push(`M  RAD${i3(chunk.length)}${body}`);
  }

  // R-group property lines: (atom, R-group number) pairs, the CTfile "M  RGP" shape. Only ever
  // present when `abbreviations: "rgroup"` placed an "R#" atom.
  for (let i = 0; i < rgroups.length; i += 8) {
    const chunk = rgroups.slice(i, i + 8);
    const body = chunk.map((entry) => `${i4(entry.atomNumber)}${i4(entry.rgroup)}`).join("");
    lines.push(`M  RGP${i3(chunk.length)}${body}`);
  }

  lines.push("M  END");
  warningsOut?.push(...warnings);
  return { contents: lines.join("\n") + "\n", warnings };
}

/**
 * V3000 (extended) molblock. No 999-atom ceiling and explicit per-atom CHG fields, so it is the
 * "MOL Text" flavor Copy As offers alongside the classic V2000 form.
 */
export function moleculeToMolfileV3000(mol: MoleculeObject, options: MolfileWriteOptions): MolfileWriteResult {
  const warningsOut = options.warnings;
  const warnings: string[] = [];
  options = { ...options, warnings };
  handleUnknownBondOrders(mol, options);
  const ySign = options.fromDocFrame ? -1 : 1;
  const atoms = mol.atoms;
  const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index + 1] as const)); // 1-based
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const writableBonds = mol.bonds.filter(
    (bond) => atomIndex.has(bond.fromAtomId) && atomIndex.has(bond.toAtomId)
  );
  const hasStereo = writableBonds.some((bond) => wedgeStereoFlag(bond) !== 0);
  warnUnsupportedDashedBondStyles(writableBonds, options);
  warnUnresolvedAromaticBonds(atoms, writableBonds, options);

  const lines: string[] = [
    "",
    "  ChemDraft",
    "",
    "  0  0  0  0  0  0  0  0  0  0999 V3000",
    "M  V30 BEGIN CTAB",
    `M  V30 COUNTS ${atoms.length} ${writableBonds.length} 0 0 ${hasStereo ? 1 : 0}`,
    "M  V30 BEGIN ATOM"
  ];

  const { symbols, rgroups, spelledHydrogens } = molfileAtomSymbols(atoms, writableBonds, "V3000", options);
  const literalValences = literalAtomValences(
    atoms, writableBonds, "V3000", options.warnings, options.kekuleBondOrders, spelledHydrogens
  );
  const rgroupByAtomNumber = new Map(rgroups.map((entry) => [entry.atomNumber, entry.rgroup]));
  atoms.forEach((atom, index) => {
    const charge = atom.formalCharge !== 0 ? ` CHG=${atom.formalCharge}` : "";
    const radicalCode = mdlRadicalCode(atom.markRadicals);
    const radical = radicalCode !== 0 ? ` RAD=${radicalCode}` : "";
    const rgroup = rgroupByAtomNumber.get(index + 1);
    const rgroups30 = rgroup !== undefined ? ` RGROUPS=(1 ${rgroup})` : "";
    const valence = literalValences.get(atom.id);
    const valence30 = valence !== undefined ? ` VAL=${valence === 0 ? -1 : valence}` : "";
    lines.push(
      `M  V30 ${index + 1} ${symbols[index]!} ${round4(atom.x)} ${round4(ySign * atom.y)} 0 0${charge}${radical}${rgroups30}${valence30}`
    );
  });

  lines.push("M  V30 END ATOM", "M  V30 BEGIN BOND");
  writableBonds.forEach((bond, index) => {
    const [from, to] = v3000BondAtomIds(bond, atomById);
    const stereo = wedgeStereoFlag(bond);
    const config = stereo === 1 ? " CFG=1" : stereo === 6 ? " CFG=3" : "";
    lines.push(
      `M  V30 ${index + 1} ${isDativeBond(bond) ? 9 : resolvedMolfileBondCode(bond, options)} ${atomIndex.get(from)!} ${atomIndex.get(to)!}${config}`
    );
  });
  lines.push("M  V30 END BOND", "M  V30 END CTAB", "M  END");
  warningsOut?.push(...warnings);
  return { contents: lines.join("\n") + "\n", warnings };
}

function round4(value: number): string {
  return Number(value.toFixed(4)).toString();
}
