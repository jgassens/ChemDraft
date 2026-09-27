import type { MoleculeAtom, MoleculeBond } from "@chemdraft/chem-core";

export { kekuleSearchWorkForTesting } from "./valence";

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
  // The N–H is drawn as an explicit H atom: with no hydrogen stated anywhere, imidazole's two
  // tautomers fit the bonds equally and the H placement is a (badged) guess — see valence.test.ts.
  aromaticFixture("imidazole", "C3H4N2", ["C", "N", "C", "C", "N", "H"], [...ring(5, [0, 2]), [4, 5, 1, false]], {
    a1: "N",
    a4: "N"
  }),
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

export interface TestMolecule {
  atoms: MoleculeAtom[];
  bonds: MoleculeBond[];
}

export interface TestSmilesOptions {
  /**
   * How a bracket atom's stated hydrogens reach the molecule: as the atom's `hydrogenCount` (the
   * default, as a CDXML NumHydrogens import stores them) or as explicit H atoms.
   */
  readonly bracketHydrogens?: "count" | "atoms";
  /** Number the atoms last-to-first, to show a result does not follow atom-id order. */
  readonly reverseIds?: boolean;
}

const testSmilesOrganic = ["Cl", "Br", "B", "C", "N", "O", "P", "S", "F", "I"];
const testSmilesAromatic = ["se", "as", "b", "c", "n", "o", "p", "s"];

/**
 * A native molecule from a SMILES-like string, FOR TESTS ONLY. Lowercase atoms bond to each other
 * with order `aromatic`, which is what a type-4 MOL paste delivers. Hydrogens deliberately do NOT
 * follow SMILES: a bare `n` says nothing about its H, exactly as a type-4 bond says nothing, and only
 * a bracket atom (`[nH]`, `[n]`) states it. `->` is a dative (dashed) bond from its left atom.
 * Supports the organic subset, bracket atoms with H count and charge, branches, ring closures
 * (digits and `%nn`), explicit `-` `=` `#` `:`, and `.`.
 */
export function testMoleculeFromSmiles(smiles: string, options: TestSmilesOptions = {}): TestMolecule {
  interface ParsedAtom { element: string; aromatic: boolean; charge: number; hydrogens?: number }
  type Order = MoleculeBond["order"];
  const parsed: ParsedAtom[] = [];
  const parsedBonds: { from: number; to: number; order?: Order; dative: boolean }[] = [];
  const branches: number[] = [];
  const openRings = new Map<string, { atom: number; order?: Order; dative: boolean }>();
  let previous = -1;
  let pendingOrder: Order | undefined;
  let pendingDative = false;
  const addAtom = (atom: ParsedAtom): void => {
    const index = parsed.push(atom) - 1;
    if (previous >= 0) parsedBonds.push({ from: previous, to: index, order: pendingOrder, dative: pendingDative });
    pendingOrder = undefined;
    pendingDative = false;
    previous = index;
  };
  const elementOf = (symbol: string): string => `${symbol[0]!.toUpperCase()}${symbol.slice(1)}`;
  let position = 0;
  while (position < smiles.length) {
    const char = smiles[position]!;
    const rest = smiles.slice(position);
    if (char === "(") { branches.push(previous); position += 1; continue; }
    if (char === ")") { previous = branches.pop()!; position += 1; continue; }
    if (char === ".") { previous = -1; position += 1; continue; }
    if (rest.startsWith("->")) { pendingOrder = "single"; pendingDative = true; position += 2; continue; }
    const explicitOrder = ({ "-": "single", "=": "double", "#": "triple", ":": "aromatic" } as const)[char as "-"];
    if (explicitOrder) { pendingOrder = explicitOrder; position += 1; continue; }
    if (char === "[") {
      const end = smiles.indexOf("]", position);
      const body = smiles.slice(position + 1, end);
      const match = /^\d*([A-Z][a-z]?|se|as|[bcnops])(H\d*)?(\+\+|--|[+-]\d*)?$/.exec(body);
      if (!match) throw new Error(`Unsupported bracket atom [${body}] in test SMILES ${smiles}`);
      const [, symbol, hydrogens, charge] = match;
      const chargeValue = !charge ? 0
        : charge === "++" ? 2 : charge === "--" ? -2
        : (charge[0] === "-" ? -1 : 1) * (charge.length > 1 ? Number(charge.slice(1)) : 1);
      addAtom({
        element: elementOf(symbol!),
        aromatic: symbol === symbol!.toLowerCase(),
        charge: chargeValue,
        hydrogens: hydrogens ? (hydrogens.length > 1 ? Number(hydrogens.slice(1)) : 1) : 0
      });
      position = end + 1;
      continue;
    }
    if (/[0-9%]/.test(char)) {
      const label = char === "%" ? smiles.slice(position + 1, position + 3) : char;
      position += char === "%" ? 3 : 1;
      const open = openRings.get(label);
      if (open) {
        parsedBonds.push({ from: open.atom, to: previous, order: pendingOrder ?? open.order, dative: pendingDative || open.dative });
        openRings.delete(label);
      } else {
        openRings.set(label, { atom: previous, order: pendingOrder, dative: pendingDative });
      }
      pendingOrder = undefined;
      pendingDative = false;
      continue;
    }
    const aromatic = testSmilesAromatic.find((symbol) => rest.startsWith(symbol));
    const organic = testSmilesOrganic.find((symbol) => rest.startsWith(symbol));
    const symbol = organic ?? aromatic;
    if (!symbol) throw new Error(`Unsupported character "${char}" in test SMILES ${smiles}`);
    addAtom({ element: elementOf(symbol), aromatic: symbol === aromatic && !organic, charge: 0 });
    position += symbol.length;
  }
  if (openRings.size > 0) throw new Error(`Unclosed ring in test SMILES ${smiles}`);

  const count = parsed.length;
  const idOf = (index: number): string => `a${options.reverseIds ? count - 1 - index : index}`;
  const atoms: MoleculeAtom[] = parsed.map((atom, index) => ({
    id: idOf(index),
    element: atom.element,
    x: index * 10,
    y: (index % 2) * 10,
    formalCharge: atom.charge,
    ...(atom.aromatic && atom.hydrogens !== undefined && options.bracketHydrogens !== "atoms"
      ? { hydrogenCount: atom.hydrogens }
      : {})
  }));
  const bonds: MoleculeBond[] = parsedBonds.map((bond, index) => {
    const order: Order = bond.order ?? (parsed[bond.from]!.aromatic && parsed[bond.to]!.aromatic ? "aromatic" : "single");
    return {
      id: `b${index}`,
      fromAtomId: idOf(bond.from),
      toAtomId: idOf(bond.to),
      order,
      ...(bond.dative ? { display: { bondStyle: "dashed" as const } } : {})
    };
  });
  if (options.bracketHydrogens === "atoms") {
    parsed.forEach((atom, index) => {
      for (let hydrogen = 0; hydrogen < (atom.hydrogens ?? 0); hydrogen += 1) {
        const id = `h${index}_${hydrogen}`;
        atoms.push({ id, element: "H", x: index * 10 + 5, y: 20 + hydrogen * 5, formalCharge: 0 });
        bonds.push({ id: `hb${index}_${hydrogen}`, fromAtomId: idOf(index), toAtomId: id, order: "single" });
      }
    });
  }
  return { atoms, bonds };
}

/**
 * Porphine (meso "C") or phthalocyanine (meso "N", `benzo`), every ring bond aromatic. Pyrrole
 * nitrogens are `n0`…`n3`, meso atoms `m0`…`m3`. `nh` states an N–H (as `hydrogenCount`) on the
 * listed pyrrole nitrogens and none on the others; left out, nothing about hydrogens is stated.
 */
export function porphyrinoid(meso: "C" | "N", benzo: boolean, nh?: readonly number[]): TestMolecule {
  const atoms: MoleculeAtom[] = [];
  const bonds: MoleculeBond[] = [];
  const atom = (id: string, element: string, extra: Partial<MoleculeAtom> = {}): string => {
    atoms.push({ id, element, x: atoms.length * 10, y: (atoms.length % 3) * 10, formalCharge: 0, ...extra });
    return id;
  };
  const bond = (from: string, to: string): void => {
    bonds.push({ id: `b${bonds.length}`, fromAtomId: from, toAtomId: to, order: "aromatic" });
  };
  for (let unit = 0; unit < 4; unit += 1) {
    const nitrogen = atom(`n${unit}`, "N", nh ? { hydrogenCount: nh.includes(unit) ? 1 : 0 } : {});
    const alphaLeft = atom(`u${unit}a`, "C");
    const alphaRight = atom(`u${unit}b`, "C");
    const betaLeft = atom(`u${unit}c`, "C");
    const betaRight = atom(`u${unit}d`, "C");
    bond(alphaLeft, nitrogen);
    bond(nitrogen, alphaRight);
    bond(alphaLeft, betaLeft);
    bond(betaLeft, betaRight);
    bond(betaRight, alphaRight);
    if (benzo) {
      const ring = [betaLeft, atom(`u${unit}e`, "C"), atom(`u${unit}f`, "C"), atom(`u${unit}g`, "C"), atom(`u${unit}h`, "C"), betaRight];
      for (let index = 0; index < ring.length - 1; index += 1) bond(ring[index]!, ring[index + 1]!);
    }
    atom(`m${unit}`, meso);
  }
  for (let unit = 0; unit < 4; unit += 1) {
    bond(`u${unit}b`, `m${unit}`);
    bond(`m${unit}`, `u${(unit + 1) % 4}a`);
  }
  return { atoms, bonds };
}

/**
 * `rings` five-membered rings fused in a line, a nitrogen at each ring's free apex, every bond
 * aromatic: 2 of them is pyrrolo[3,2-b]pyrrole. A family that grows one open N per ring, for the
 * search-cost test.
 */
export function fusedPyrroleLadder(rings: number): TestMolecule {
  const atoms: MoleculeAtom[] = [];
  const bonds: MoleculeBond[] = [];
  const atom = (id: string, element: string): string => {
    atoms.push({ id, element, x: atoms.length * 10, y: (atoms.length % 2) * 10, formalCharge: 0 });
    return id;
  };
  const bond = (from: string, to: string): void => {
    bonds.push({ id: `b${bonds.length}`, fromAtomId: from, toAtomId: to, order: "aromatic" });
  };
  let top = atom("t0", "C");
  let bottom = atom("d0", "C");
  bond(top, bottom);
  for (let ring = 1; ring <= rings; ring += 1) {
    const nextTop = atom(`t${ring}`, "C");
    const nextBottom = atom(`d${ring}`, "C");
    const apex = atom(`n${ring}`, "N");
    bond(nextTop, nextBottom);
    if (ring % 2 === 1) {
      bond(top, apex);
      bond(apex, nextTop);
      bond(bottom, nextBottom);
    } else {
      bond(bottom, apex);
      bond(apex, nextBottom);
      bond(top, nextTop);
    }
    top = nextTop;
    bottom = nextBottom;
  }
  return { atoms, bonds };
}

/** Raw connection-table fixture, deliberately independent of the production MOL writer/resolver. */
export function rawMolfileFixture(atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]): string {
  const i3 = (value: number) => String(value).padStart(3);
  const indices = new Map(atoms.map((atom, index) => [atom.id, index + 1]));
  const lines = ["Raw aromatic fixture", "  ChemDraft test", "",
    `${i3(atoms.length)}${i3(bonds.length)}  0  0  0  0  0  0  0  0999 V2000`];
  for (const atom of atoms) lines.push(
    [atom.x, -atom.y, 0].map((v) => v.toFixed(4).padStart(10)).join("") +
    ` ${atom.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`
  );
  for (const bond of bonds) lines.push(
    `${i3(indices.get(bond.fromAtomId)!)}${i3(indices.get(bond.toAtomId)!)}${i3({ single: 1, double: 2, triple: 3, aromatic: 4, unknown: 1 }[bond.order])}  0  0  0  0`
  );
  atoms.forEach((atom, index) => {
    if (atom.formalCharge) lines.push(`M  CHG  1${String(index + 1).padStart(4)}${String(atom.formalCharge).padStart(4)}`);
  });
  return [...lines, "M  END", ""].join("\n");
}
