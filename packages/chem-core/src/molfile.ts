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
 *   - `unknown` bond order has no V2000 encoding and is written as single (code 1).
 *   - Dative (dashed single) bonds have no V2000 encoding: V2000 writes them as single bonds with
 *     a warning; V3000 preserves them as bond type 9 (coordination), which CTfile-aware parsers
 *     read back as dative. Dashed display on another bond order is omitted with a warning rather
 *     than replacing that bond's chemical order with a coordination bond.
 *   - An atom label that is not an element symbol (a condensed label like "CH3", an
 *     abbreviation like "Ph") writes as a dummy atom ("*") with a warning — the group the label
 *     spells is not represented in the molfile. Consumers inside the app that RANK atoms (CIP
 *     perception, the plugin hand-off) ask for `abbreviations: "rgroup"` instead; see the option.
 *   - Coordinates ≥1e6 / counts >999 cannot fit V2000's fixed columns; the writer trims
 *     coordinate precision to preserve alignment and throws on >999 atoms/bonds.
 */

import { isMetalSymbol } from "./elements";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

export interface MolfileWriteOptions {
  /** Negate y on write (ChemDraft document y-down → molfile y-up). Default false. */
  fromDocFrame?: boolean;
  /**
   * Collects concise, human-readable notes about lossy emissions — V2000 dative bonds flattened
   * to single, incompatible dashed display omitted, non-element labels written as dummy atoms
   * (AGENTS.md §5.7/§14: never degrade quietly). Callers that cannot surface warnings (the 3D-spin
   * relayout, stereo perception) omit it and get the previous behavior.
   */
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
}

const BOND_ORDER_CODE: Record<MoleculeBond["order"], number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 4,
  unknown: 1
};

/**
 * A dashed single bond depicts a dative/coordination interaction (zero covalent valence on either
 * atom). V3000 spells it as bond type 9, the CTfile coordination type, so the file round-trips;
 * V2000 has no coordination type, so there it degrades to a plain single bond and the writer warns.
 * Requiring single order prevents display styling on a multiple bond from deleting its bond order.
 */
export function isDativeBond(bond: MoleculeBond): boolean {
  return bond.order === "single" && bond.display?.bondStyle === "dashed";
}

function v3000BondTypeCode(bond: MoleculeBond): number {
  return isDativeBond(bond) ? 9 : BOND_ORDER_CODE[bond.order];
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
function warnUnsupportedDashedBondStyles(bonds: readonly MoleculeBond[], warnings?: string[]): void {
  for (const bond of bonds) {
    if (bond.display?.bondStyle === "dashed" && bond.order !== "single") {
      const code = BOND_ORDER_CODE[bond.order];
      const emittedOrder = code === 1 ? "single" : code === 2 ? "double" : code === 3 ? "triple" : "aromatic";
      const article = bond.order === "aromatic" || bond.order === "unknown" ? "an" : "a";
      warnings?.push(
        `Dashed display on ${article} ${bond.order} bond is not a coordination bond; written as bond type ${code} (${emittedOrder}), dashed style not preserved.`
      );
    }
  }
}

/**
 * Every IUPAC element symbol plus CTfile's D, T and dummy atom "*". The molfile atom column must hold
 * one of these — never a display label. chem-core keeps its own table because the app's element
 * list (`nativeElementSymbols` in documentWorkflow) lives above the package boundary.
 */
const MOLFILE_ATOM_SYMBOLS = new Set([
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
  "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
  "D", "T", "*"
]);

/** Explicit valence stops a reader adding hydrogens to a literal element label. */
function literalAtomValences(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  format: "V2000" | "V3000",
  warnings?: string[]
): Map<string, number> {
  const valences = new Map(atoms
    .filter((atom) => atom.labelLiteral === true && atom.element !== "*" && MOLFILE_ATOM_SYMBOLS.has(atom.element))
    .map((atom) => [atom.id, 0]));
  if (valences.size === 0) return valences;
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  for (const bond of bonds) {
    // Aromatic type 4 is a code, not four covalent bonds. V2000 emits dative as single; V3000
    // readers count a coordination bond only at its acceptor, so its donor gets no extra H.
    const order = bond.order === "aromatic" ? 1.5 : BOND_ORDER_CODE[bond.order];
    const dative = format === "V3000" && isDativeBond(bond);
    const [from, to] = dative ? v3000BondAtomIds(bond, atomById) : [bond.fromAtomId, bond.toAtomId];
    if (valences.has(from)) valences.set(from, valences.get(from)! + (dative ? 0 : order));
    if (valences.has(to)) valences.set(to, valences.get(to)! + order);
  }
  for (const [id, valence] of valences) {
    // CTfile's explicit valence is an integer from 1 to 14, plus a zero-valence sentinel. An
    // unrepresentable sum (one aromatic bond, 1.5) gets no field and a warning rather than a
    // rounded value that would invent hydrogens — or an exception that would abort the whole
    // export, cleanup or 3D pass this writer is feeding.
    if (!Number.isInteger(valence) || valence > 14) {
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
  atoms: readonly { element: string }[],
  options: MolfileWriteOptions
): { symbols: string[]; rgroups: { atomNumber: number; rgroup: number }[] } {
  const rgroupByLabel = new Map<string, number>();
  const rgroups: { atomNumber: number; rgroup: number }[] = [];
  const symbols = atoms.map((atom, index) => {
    // A literal "*" label (a pasted dummy atom) is a valid molfile symbol, but in rgroup mode it
    // must not pass through: OpenChemLib reads "*" as a carbon, which is exactly the misranking
    // this mode exists to prevent. It is a group the file does not spell, like any other label.
    if (MOLFILE_ATOM_SYMBOLS.has(atom.element) && !(options.abbreviations === "rgroup" && atom.element === "*")) {
      return atom.element;
    }
    if (options.abbreviations === "rgroup") {
      let rgroup = rgroupByLabel.get(atom.element);
      if (rgroup === undefined) {
        rgroup = rgroupByLabel.size + 1;
        rgroupByLabel.set(atom.element, rgroup);
      }
      rgroups.push({ atomNumber: index + 1, rgroup });
      options.warnings?.push(
        `Atom label "${atom.element}" is not an element symbol; written as R-group placeholder R${rgroup} — the label's group is not represented in the molfile.`
      );
      return "R#";
    }
    options.warnings?.push(
      `Atom label "${atom.element}" is not an element symbol; written as a dummy atom (*) — the label's group is not represented in the molfile.`
    );
    return "*";
  });
  return { symbols, rgroups };
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
export function moleculeToMolfileV2000(mol: MoleculeObject, options: MolfileWriteOptions = {}): string {
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
  warnUnsupportedDashedBondStyles(writableBonds, options.warnings);
  if (dativeBondCount > 0) {
    options.warnings?.push(
      `V2000 has no coordination bond type: ${dativeBondCount} dative (dashed) bond${dativeBondCount === 1 ? "" : "s"} written as plain single. Export V3000 to preserve ${dativeBondCount === 1 ? "it" : "them"}.`
    );
  }

  const lines: string[] = ["", "  ChemDraft", ""];
  lines.push(`${i3(atoms.length)}${i3(writableBonds.length)}  0  0  ${chiralFlag}  0  0  0  0  0999 V2000`);

  const { symbols, rgroups } = molfileAtomSymbols(atoms, options);
  const literalValences = literalAtomValences(atoms, writableBonds, "V2000", options.warnings);
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
    lines.push(`${i3(from)}${i3(to)}${i3(BOND_ORDER_CODE[bond.order])}${i3(wedgeStereoFlag(bond))}  0  0  0`);
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
  return lines.join("\n") + "\n";
}

/**
 * V3000 (extended) molblock. No 999-atom ceiling and explicit per-atom CHG fields, so it is the
 * "MOL Text" flavor Copy As offers alongside the classic V2000 form.
 */
export function moleculeToMolfileV3000(mol: MoleculeObject, options: MolfileWriteOptions = {}): string {
  const ySign = options.fromDocFrame ? -1 : 1;
  const atoms = mol.atoms;
  const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index + 1] as const)); // 1-based
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const writableBonds = mol.bonds.filter(
    (bond) => atomIndex.has(bond.fromAtomId) && atomIndex.has(bond.toAtomId)
  );
  const hasStereo = writableBonds.some((bond) => wedgeStereoFlag(bond) !== 0);
  warnUnsupportedDashedBondStyles(writableBonds, options.warnings);

  const lines: string[] = [
    "",
    "  ChemDraft",
    "",
    "  0  0  0  0  0  0  0  0  0  0999 V3000",
    "M  V30 BEGIN CTAB",
    `M  V30 COUNTS ${atoms.length} ${writableBonds.length} 0 0 ${hasStereo ? 1 : 0}`,
    "M  V30 BEGIN ATOM"
  ];

  const { symbols, rgroups } = molfileAtomSymbols(atoms, options);
  const literalValences = literalAtomValences(atoms, writableBonds, "V3000", options.warnings);
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
      `M  V30 ${index + 1} ${v3000BondTypeCode(bond)} ${atomIndex.get(from)!} ${atomIndex.get(to)!}${config}`
    );
  });
  lines.push("M  V30 END BOND", "M  V30 END CTAB", "M  END");
  return lines.join("\n") + "\n";
}

function round4(value: number): string {
  return Number(value.toFixed(4)).toString();
}
