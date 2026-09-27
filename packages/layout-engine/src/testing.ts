import type { MoleculeAtom, MoleculeBond } from "@chemdraft/chem-core";

import type { PageSvgElementFragment, PageSvgFragment } from "./index";

/** Flatten a planned SVG fragment tree into its element fragments, dropping text leaves. */
export function elementFragments(fragment: PageSvgFragment): PageSvgElementFragment[] {
  if (fragment.kind === "text") {
    return [];
  }
  return [fragment, ...fragment.children.flatMap(elementFragments)];
}

type FixtureBond = readonly [from: number, to: number, kekuleOrder: 1 | 2, aromatic: boolean];

/**
 * A molecule written twice: `aromatic` has its ring bonds as order `aromatic` (a type-4 MOL paste),
 * `kekule` has the same bonds at a hand-written Kekulé pattern. Both must count the same.
 */
export interface AromaticFixture {
  readonly name: string;
  /** The formula a chemist would write. */
  readonly formula: string;
  readonly atoms: readonly MoleculeAtom[];
  readonly aromatic: readonly MoleculeBond[];
  readonly kekule: readonly MoleculeBond[];
  /** Expected drawn label for each heteroatom, by atom id. */
  readonly heteroatomLabels: Readonly<Record<string, string>>;
}

function aromaticFixture(
  name: string,
  formula: string,
  elements: readonly string[],
  bonds: readonly FixtureBond[],
  heteroatomLabels: Record<string, string>
): AromaticFixture {
  const atoms: MoleculeAtom[] = elements.map((element, index) => ({
    id: `a${index}`,
    element,
    x: index * 10,
    y: (index % 2) * 10,
    formalCharge: 0
  }));
  const bond = ([from, to, order]: FixtureBond, index: number, aromatic: boolean): MoleculeBond => ({
    id: `b${index}`,
    fromAtomId: `a${from}`,
    toAtomId: `a${to}`,
    order: aromatic ? "aromatic" : order === 2 ? "double" : "single"
  });
  return {
    name,
    formula,
    atoms,
    aromatic: bonds.map((spec, index) => bond(spec, index, spec[3])),
    kekule: bonds.map((spec, index) => bond(spec, index, false)),
    heteroatomLabels
  };
}

const ring = (size: number, doubles: readonly number[]): FixtureBond[] =>
  Array.from({ length: size }, (_, index): FixtureBond => [index, (index + 1) % size, doubles.includes(index) ? 2 : 1, true]);

/** The aromatic cases of record for label/formula agreement (AGENTS.md §10). */
export const aromaticFixtures: readonly AromaticFixture[] = [
  aromaticFixture("benzene", "C6H6", ["C", "C", "C", "C", "C", "C"], ring(6, [0, 2, 4]), {}),
  aromaticFixture("naphthalene", "C10H8", Array.from({ length: 10 }, () => "C"), [
    [0, 1, 2, true], [1, 2, 1, true], [2, 3, 2, true], [3, 4, 1, true], [4, 5, 2, true], [5, 0, 1, true],
    [4, 6, 1, true], [6, 7, 2, true], [7, 8, 1, true], [8, 9, 2, true], [9, 5, 1, true]
  ], {}),
  aromaticFixture("pyrrole", "C4H5N", ["N", "C", "C", "C", "C"], ring(5, [1, 3]), { a0: "NH" }),
  aromaticFixture("indole", "C8H7N", ["N", "C", "C", "C", "C", "C", "C", "C", "C"], [
    [0, 1, 1, true], [1, 2, 2, true], [2, 3, 1, true], [3, 8, 1, true], [8, 0, 1, true],
    [3, 4, 2, true], [4, 5, 1, true], [5, 6, 2, true], [6, 7, 1, true], [7, 8, 2, true]
  ], { a0: "NH" }),
  aromaticFixture("imidazole", "C3H4N2", ["C", "N", "C", "C", "N"], ring(5, [0, 2]), { a1: "N", a4: "NH" }),
  aromaticFixture("2-pyridone", "C5H5NO", ["N", "C", "C", "C", "C", "C", "O"], [
    ...ring(6, [2, 4]), [1, 6, 2, false]
  ], { a0: "NH", a6: "O" }),
  aromaticFixture("thiophene", "C4H4S", ["S", "C", "C", "C", "C"], ring(5, [1, 3]), { a0: "S" }),
  aromaticFixture("furan", "C4H4O", ["O", "C", "C", "C", "C"], ring(5, [1, 3]), { a0: "O" }),
  aromaticFixture("pyridine", "C5H5N", ["N", "C", "C", "C", "C", "C"], ring(6, [0, 2, 4]), { a0: "N" }),
  // Fused and exocyclic at once: C2 carries the C=O, so it takes no ring double bond and N1 keeps its H.
  aromaticFixture("quinolin-2(1H)-one", "C9H7NO", ["N", "C", "C", "C", "C", "C", "C", "C", "C", "C", "O"], [
    [0, 1, 1, true], [1, 2, 1, true], [2, 3, 2, true], [3, 4, 1, true], [4, 9, 1, true], [9, 0, 1, true],
    [4, 5, 2, true], [5, 6, 1, true], [6, 7, 2, true], [7, 8, 1, true], [8, 9, 2, true], [1, 10, 2, false]
  ], { a0: "NH", a10: "O" })
];

/** An all-carbon aromatic five-ring: five atoms that each need a double bond, so no Kekulé pattern. */
export function unresolvableAromaticRing(): { atoms: MoleculeAtom[]; bonds: MoleculeBond[] } {
  const atoms: MoleculeAtom[] = Array.from({ length: 5 }, (_, index) => ({
    id: `u${index}`, element: "C", x: index * 10, y: (index % 2) * 10, formalCharge: 0
  }));
  const bonds: MoleculeBond[] = atoms.map((atom, index) => ({
    id: `ub${index}`, fromAtomId: atom.id, toAtomId: atoms[(index + 1) % atoms.length]!.id, order: "aromatic"
  }));
  return { atoms, bonds };
}
