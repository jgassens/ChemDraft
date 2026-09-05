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
 *     spells is not represented in the molfile.
 *   - Coordinates ≥1e6 / counts >999 cannot fit V2000's fixed columns; the writer trims
 *     coordinate precision to preserve alignment and throws on >999 atoms/bonds.
 */

import type { MoleculeBond, MoleculeObject } from "./schemas";

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
   * V2000 only: write dative (dashed single) bonds as bond type 9, the CTfile coordination type,
   * instead of flattening them to single with a warning. V2000 proper has no such type, so this is
   * NOT for interchange files; it is for layout engines that understand it (OpenChemLib reads 9 as
   * its metal-ligand bond and keeps those bonds out of ring perception, which is what makes a
   * coordination complex lay out as ligands around a metal instead of a tangle of chelate rings).
   */
  coordinationBondsAsType9?: boolean;
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
function isDativeBond(bond: MoleculeBond): boolean {
  return bond.order === "single" && bond.display?.bondStyle === "dashed";
}

function v3000BondTypeCode(bond: MoleculeBond): number {
  return isDativeBond(bond) ? 9 : BOND_ORDER_CODE[bond.order];
}

/**
 * A dashed display on a non-single bond cannot mean coordination without destroying its chemical
 * order. Keep the order and report the lost display style instead of silently changing chemistry.
 */
function warnUnsupportedDashedBondStyles(bonds: readonly MoleculeBond[], warnings?: string[]): void {
  for (const bond of bonds) {
    if (bond.display?.bondStyle === "dashed" && bond.order !== "single") {
      warnings?.push(
        `Dashed display on a ${bond.order} bond is not a coordination bond; written as a ${bond.order} bond, dashed style not preserved.`
      );
    }
  }
}

/**
 * Every IUPAC element symbol plus the CTfile dummy atom "*". The molfile atom column must hold
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
  "*"
]);

/**
 * The symbol for the molfile atom column. A label that is not an element symbol (a condensed
 * label like "CH3", an abbreviation like "Ph") written verbatim is an invalid molfile — and at
 * four or more characters it overflows V2000's fixed 3-char column, corrupting every field that
 * follows. Write a dummy atom and warn instead (AGENTS.md §5.7/§14).
 */
function molfileAtomSymbol(atom: { element: string }, warnings?: string[]): string {
  if (MOLFILE_ATOM_SYMBOLS.has(atom.element)) {
    return atom.element;
  }
  warnings?.push(
    `Atom label "${atom.element}" is not an element symbol; written as a dummy atom (*) — the label's group is not represented in the molfile.`
  );
  return "*";
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
  if (dativeBondCount > 0 && !options.coordinationBondsAsType9) {
    options.warnings?.push(
      `V2000 has no coordination bond type: ${dativeBondCount} dative (dashed) bond${dativeBondCount === 1 ? "" : "s"} written as plain single. Export V3000 to preserve ${dativeBondCount === 1 ? "it" : "them"}.`
    );
  }

  const lines: string[] = ["", "  ChemDraft", ""];
  lines.push(`${i3(atoms.length)}${i3(writableBonds.length)}  0  0  ${chiralFlag}  0  0  0  0  0999 V2000`);

  for (const atom of atoms) {
    const x = f10_4(atom.x);
    const y = f10_4(ySign * atom.y);
    const z = f10_4(0);
    lines.push(`${x}${y}${z} ${molfileAtomSymbol(atom, options.warnings).padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`);
  }

  for (const bond of writableBonds) {
    const from = atomIndex.get(bond.fromAtomId)!;
    const to = atomIndex.get(bond.toAtomId)!;
    const bondCode = options.coordinationBondsAsType9 && isDativeBond(bond) ? 9 : BOND_ORDER_CODE[bond.order];
    lines.push(`${i3(from)}${i3(to)}${i3(bondCode)}${i3(wedgeStereoFlag(bond))}  0  0  0`);
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

  atoms.forEach((atom, index) => {
    const charge = atom.formalCharge !== 0 ? ` CHG=${atom.formalCharge}` : "";
    const radicalCode = mdlRadicalCode(atom.markRadicals);
    const radical = radicalCode !== 0 ? ` RAD=${radicalCode}` : "";
    lines.push(
      `M  V30 ${index + 1} ${molfileAtomSymbol(atom, options.warnings)} ${round4(atom.x)} ${round4(ySign * atom.y)} 0 0${charge}${radical}`
    );
  });

  lines.push("M  V30 END ATOM", "M  V30 BEGIN BOND");
  writableBonds.forEach((bond, index) => {
    const stereo = wedgeStereoFlag(bond);
    const config = stereo === 1 ? " CFG=1" : stereo === 6 ? " CFG=3" : "";
    lines.push(
      `M  V30 ${index + 1} ${v3000BondTypeCode(bond)} ${atomIndex.get(bond.fromAtomId)!} ${atomIndex.get(bond.toAtomId)!}${config}`
    );
  });
  lines.push("M  V30 END BOND", "M  V30 END CTAB", "M  END");
  return lines.join("\n") + "\n";
}

function round4(value: number): string {
  return Number(value.toFixed(4)).toString();
}
