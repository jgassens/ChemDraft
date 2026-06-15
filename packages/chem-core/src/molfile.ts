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
 *   - Isotopes (`M  ISO`) and radicals (`M  RAD`) are not represented in `MoleculeAtom`
 *     and are therefore not written. A round-trip through this writer loses them.
 *   - `unknown` bond order has no V2000 encoding and is written as single (code 1).
 *   - Coordinates ≥1e6 / counts >999 cannot fit V2000's fixed columns; the writer trims
 *     coordinate precision to preserve alignment and throws on >999 atoms/bonds.
 */

import type { MoleculeBond, MoleculeObject } from "./schemas";

export interface MolfileWriteOptions {
  /** Negate y on write (ChemDraft document y-down → molfile y-up). Default false. */
  fromDocFrame?: boolean;
}

const BOND_ORDER_CODE: Record<MoleculeBond["order"], number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 4,
  unknown: 1
};

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

  const lines: string[] = ["", "  ChemDraft", ""];
  lines.push(`${i3(atoms.length)}${i3(writableBonds.length)}  0  0  ${chiralFlag}  0  0  0  0  0999 V2000`);

  for (const atom of atoms) {
    const x = f10_4(atom.x);
    const y = f10_4(ySign * atom.y);
    const z = f10_4(0);
    lines.push(`${x}${y}${z} ${atom.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`);
  }

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

  lines.push("M  END");
  return lines.join("\n") + "\n";
}
