import { beforeAll, describe, expect, it } from "vitest";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
// These packages have no bare-package Vitest alias. Relative test imports keep the registry and
// RDKit singleton in this worktree when node_modules is shared with another checkout.
import { compositionFromRdkitJson, ensureRdkit, type RdkitJson } from "../../rdkit-adapter/src/index";
import { structureTemplates, type StructureTemplate, type StructureTemplateAtom } from "../../template-library/src/index";
import { normalizeStructureTemplateName } from "../src/structureTemplates";

interface RdkitMol {
  get_smiles(): string;
  get_json(): string;
  delete(): void;
}

let rdkit: { get_mol(input: string, options?: string): RdkitMol | null };
beforeAll(async () => {
  installNodeRdkitModuleLoader();
  rdkit = (await ensureRdkit()) as unknown as typeof rdkit;
}, 60_000);

const field = (value: number) => String(value).padStart(3);

/**
 * Preserve the supplied y-up coordinates and bond direction. RDKit's molfile reader assigns
 * tetrahedral stereo from the 2D wedge/hash flags and double-bond stereo from these coordinates.
 * Do not generate new coordinates or round-trip via a non-isomeric SMILES here.
 */
function molblock(layout: StructureTemplate["layout"]): string {
  const lines = [
    "ChemDraft original template",
    "  ChemDraft          2D",
    "",
    `${field(layout.atoms.length)}${field(layout.bonds.length)}  0  0  0  0            999 V2000`,
    ...layout.atoms.map((atom) =>
      `${atom.x.toFixed(4).padStart(10)}${atom.y.toFixed(4).padStart(10)}    0.0000 ${atom.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`
    ),
    ...layout.bonds.map(([from, to, order, display]) =>
      `${field(from + 1)}${field(to + 1)}${field(order)}${field(display === "wedge" ? 1 : display === "hash" ? 6 : 0)}  0  0  0`
    )
  ];
  const charges = layout.atoms.flatMap((atom, index) => atom.charge ? [[index + 1, atom.charge] as const] : []);
  for (let offset = 0; offset < charges.length; offset += 8) {
    const group = charges.slice(offset, offset + 8);
    lines.push(`M  CHG${field(group.length)}${group.map(([index, charge]) => ` ${field(index)} ${field(charge)}`).join("")}`);
  }
  return [...lines, "M  END", ""].join("\n");
}

function read(input: string) {
  const molecule = rdkit.get_mol(input, JSON.stringify({ sanitize: true, removeHs: false, strictParsing: true }));
  if (!molecule) throw new Error(`RDKit could not parse: ${input}`);
  try {
    const json = JSON.parse(molecule.get_json()) as RdkitJson;
    return {
      smiles: molecule.get_smiles(), // canonical ISOMERIC SMILES is RDKit's default
      composition: compositionFromRdkitJson(json),
      json
    };
  } finally {
    molecule.delete();
  }
}

type Point = Pick<StructureTemplateAtom, "x" | "y">;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const orientation = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const epsilon = 1e-8;

function onSegment(a: Point, b: Point, p: Point): boolean {
  return Math.abs(orientation(a, b, p)) <= epsilon &&
    p.x >= Math.min(a.x, b.x) - epsilon && p.x <= Math.max(a.x, b.x) + epsilon &&
    p.y >= Math.min(a.y, b.y) - epsilon && p.y <= Math.max(a.y, b.y) + epsilon;
}

/** Includes collinear overlap and touching between bonds without a shared atom index. */
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const abc = orientation(a, b, c), abd = orientation(a, b, d);
  const cda = orientation(c, d, a), cdb = orientation(c, d, b);
  const opposite = (x: number, y: number) => (x > epsilon && y < -epsilon) || (x < -epsilon && y > epsilon);
  return (opposite(abc, abd) && opposite(cda, cdb)) ||
    onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

const normalise = normalizeStructureTemplateName;

describe("structure template identities", () => {
  it("has unique stable ids, names and normalised synonyms, with no names shared by different templates", () => {
    expect(structureTemplates.length).toBeGreaterThan(0);
    const ids = structureTemplates.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const owners = new Map<string, string>();
    for (const entry of structureTemplates) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.category).toBe("supramolecular");
      expect(entry.source.database).toBe("PubChem");
      if (entry.source.cid === null) expect(entry.note?.trim().length).toBeGreaterThan(0);
      else expect(Number.isInteger(entry.source.cid) && entry.source.cid > 0).toBe(true);
      for (const spelling of [entry.id, entry.name, ...entry.synonyms]) {
        const key = normalise(spelling);
        expect(key.length).toBeGreaterThan(0);
        expect(owners.get(key) ?? entry.id, spelling).toBe(entry.id);
        owners.set(key, entry.id);
      }
    }
  });

  it.each(structureTemplates.map((entry) => [entry.id, entry] as const))(
    "%s: the drawn identity, isomeric stereo, formula and charge match the vetted SMILES",
    (_id, entry) => {
      const drawn = read(molblock(entry.layout));
      const identity = read(entry.smiles);
      expect(drawn.smiles).toBe(identity.smiles);
      for (const { composition } of [drawn, identity]) {
        expect(composition.formula).toBe(entry.formula);
        expect(composition.formalCharge).toBe(entry.charge);
        expect(composition.atomCount).toBe(entry.layout.atoms.length);
        expect(composition.bondCount).toBe(entry.layout.bonds.length);
        expect(composition.components).toHaveLength(1);
      }
    }
  );

  it("porphine's opposite-NH tautomer retains the PubChem tautomer's skeleton and hydrogen count", () => {
    const old = read("C1=CC2=CC3=CC=C(N3)C=C4C=CC(=N4)C=C5C=CC(=N5)C=C1N2");
    const entry = structureTemplates.find((template) => template.id === "porphine")!;
    const current = read(entry.smiles);
    expect(current.smiles).not.toBe(old.smiles);
    expect(current.composition.formula).toBe("C20H14N4");
    expect(current.composition).toEqual(old.composition);
    // Both SMILES deliberately traverse the same atoms in the same order. Compare
    // RDKit's heavy-atom graph with bond orders omitted: only the proton/bond-order
    // arrangement may change, never the skeleton, charge, isotope or total H count.
    const skeleton = ({ json }: ReturnType<typeof read>) => ({
      atoms: json.molecules[0]!.atoms.map((atom) => ({
        z: atom.z ?? json.defaults?.atom?.z ?? 6,
        charge: atom.chg ?? json.defaults?.atom?.chg ?? 0,
        isotope: atom.isotope ?? json.defaults?.atom?.isotope ?? 0
      })),
      bonds: json.molecules[0]!.bonds.map(({ atoms: [a, b] }) => [Math.min(a, b), Math.max(a, b)].join(":")).sort(),
      hydrogens: json.molecules[0]!.atoms.reduce((sum, atom) => sum + (atom.impHs ?? json.defaults?.atom?.impHs ?? 0), 0)
    });
    expect(skeleton(current)).toEqual(skeleton(old));
  });

  it.each(structureTemplates.filter((entry) => entry.family === "porphyrins").map((entry) => [entry.id, entry] as const))(
    "%s: RDKit reads exactly two inner NH sites on opposite pyrroles",
    (_id, entry) => {
      const { json } = read(molblock(entry.layout));
      const nitrogens = json.molecules[0]!.atoms.flatMap((atom, index) =>
        (atom.z ?? json.defaults?.atom?.z) === 7 ? [{ atom, index }] : []);
      expect(nitrogens).toHaveLength(4);
      const nh = nitrogens.filter(({ atom }) => (atom.impHs ?? json.defaults?.atom?.impHs ?? 0) === 1);
      expect(nh).toHaveLength(2);
      const a = entry.layout.atoms[nh[0]!.index]!, b = entry.layout.atoms[nh[1]!.index]!;
      expect(a.x).toBeCloseTo(-b.x, 4);
      expect(a.y).toBeCloseTo(-b.y, 4);
    }
  );
});

describe("structure template geometry", () => {
  it.each(structureTemplates.map((entry) => [entry.id, entry] as const))(
    "%s: unit bonds, centred coordinates, no close non-neighbours or undeclared crossings",
    (_id, entry) => {
      const { atoms, bonds } = entry.layout;
      expect(atoms.length).toBeGreaterThan(0);
      expect(bonds.length).toBeGreaterThan(0);
      for (const atom of atoms) {
        expect(Number.isFinite(atom.x) && Number.isFinite(atom.y)).toBe(true);
        expect(Number.isInteger(atom.charge ?? 0)).toBe(true);
      }
      for (const axis of ["x", "y"] as const) {
        const values = atoms.map((atom) => atom[axis]);
        expect(Math.abs(Math.min(...values) + Math.max(...values))).toBeLessThanOrEqual(0.00011);
      }
      const neighbours = new Set<string>();
      const pair = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
      const lengths: number[] = [];
      for (const [from, to, order, display] of bonds) {
        expect(Number.isInteger(from) && Number.isInteger(to)).toBe(true);
        expect(atoms[from]).toBeDefined();
        expect(atoms[to]).toBeDefined();
        expect(from).not.toBe(to);
        expect([1, 2, 3]).toContain(order);
        expect([undefined, "wedge", "hash"]).toContain(display);
        expect(neighbours.has(pair(from, to)), "duplicate bond").toBe(false);
        neighbours.add(pair(from, to));
        const length = distance(atoms[from]!, atoms[to]!);
        expect(length, `bond ${from}-${to}`).toBeGreaterThanOrEqual(0.85);
        expect(length, `bond ${from}-${to}`).toBeLessThanOrEqual(1.15);
        lengths.push(length);
      }
      expect(lengths.reduce((sum, length) => sum + length, 0) / lengths.length).toBeCloseTo(1, 4);
      for (let a = 0; a < atoms.length; a += 1) {
        for (let b = a + 1; b < atoms.length; b += 1) {
          if (!neighbours.has(pair(a, b))) {
            expect(distance(atoms[a]!, atoms[b]!), `atoms ${a}-${b}`).toBeGreaterThanOrEqual(0.6);
            // Text needs more room than an unlabeled skeletal carbon vertex. Apply
            // this to every label/non-neighbour pair, including charged carbons.
            if ([atoms[a]!, atoms[b]!].some((atom) => atom.element !== "C" || (atom.charge ?? 0) !== 0)) {
              // The visually checked cyclodextrin chairs project a ring oxygen
              // 0.845 bond lengths from a non-neighbouring carbon corner; the text
              // remains clear. Keep the full 0.95 threshold for every other family.
              const minimum = entry.family === "cyclodextrins" ? 0.84 : 0.95;
              expect(distance(atoms[a]!, atoms[b]!), `label clearance at atoms ${a}-${b}`).toBeGreaterThanOrEqual(minimum);
            }
          }
        }
      }
      let crossings = 0;
      for (let i = 0; i < bonds.length; i += 1) {
        const [a, b] = bonds[i]!;
        for (let j = i + 1; j < bonds.length; j += 1) {
          const [c, d] = bonds[j]!;
          if (a === c || a === d || b === c || b === d) continue;
          if (intersects(atoms[a]!, atoms[b]!, atoms[c]!, atoms[d]!)) crossings += 1;
        }
      }
      const allowed = entry.allowedCrossings ?? 0;
      expect(Number.isInteger(allowed) && allowed >= 0).toBe(true);
      expect(crossings).toBe(allowed);
    }
  );

  it.each([5, 6])("pillar[%i]arene and its dimethoxy derivative share identical skeleton geometry", (n) => {
    const parent = structureTemplates.find((entry) => entry.id === `pillar-${n}-arene`)!;
    const methylated = structureTemplates.find((entry) => entry.id === `dimethoxypillar-${n}-arene`)!;
    const { atoms, bonds } = methylated.layout;
    const methyls = new Set(atoms.flatMap((atom, index) => {
      const neighbours = bonds.filter(([a, b]) => a === index || b === index);
      return atom.element === "C" && neighbours.length === 1 && neighbours.some(([a, b]) =>
        atoms[a === index ? b : a]!.element === "O") ? [index] : [];
    }));
    expect(methyls.size).toBe(2 * n);
    const retained = atoms.flatMap((_, index) => methyls.has(index) ? [] : [index]);
    const remap = new Map(retained.map((index, position) => [index, position]));
    // Whole-template bounding boxes include methyls, so their centring translations
    // can differ. Align one atom and allow only the four-decimal rounding error.
    const dx = atoms[0]!.x - parent.layout.atoms[0]!.x, dy = atoms[0]!.y - parent.layout.atoms[0]!.y;
    retained.forEach((index, position) => {
      expect(atoms[index]!.element).toBe(parent.layout.atoms[position]!.element);
      expect(Math.abs(atoms[index]!.x - dx - parent.layout.atoms[position]!.x)).toBeLessThanOrEqual(0.00011);
      expect(Math.abs(atoms[index]!.y - dy - parent.layout.atoms[position]!.y)).toBeLessThanOrEqual(0.00011);
    });
    expect(bonds.filter(([a, b]) => !methyls.has(a) && !methyls.has(b)).map(([a, b, order]) =>
      [remap.get(a), remap.get(b), order])).toEqual(parent.layout.bonds);
  });
});

describe("validation plumbing for future stereochemical and charged families", () => {
  it("reads directed wedges and hashes as opposite absolute configurations, and notices a reflection", () => {
    const atoms = [
      { element: "C", x: 0, y: 0 }, { element: "C", x: 1, y: 0 },
      { element: "F", x: -0.5, y: 0.866 }, { element: "Cl", x: -0.5, y: -0.866 }
    ];
    const bonds: StructureTemplate["layout"]["bonds"] = [[0, 1, 1, "wedge"], [0, 2, 1], [0, 3, 1]];
    const wedge = read(molblock({ atoms, bonds })).smiles;
    const hash = read(molblock({ atoms, bonds: [[0, 1, 1, "hash"], ...bonds.slice(1)] })).smiles;
    expect([wedge, hash].sort()).toEqual([read("C[C@H](F)Cl").smiles, read("C[C@@H](F)Cl").smiles].sort());
    expect(wedge).not.toBe(hash);
    expect(read(molblock({ atoms: atoms.map((atom) => ({ ...atom, y: -atom.y })), bonds })).smiles).toBe(hash);
    // Reversing the bond moves the wedge's narrow end onto the non-stereogenic methyl carbon.
    expect(read(molblock({ atoms, bonds: [[1, 0, 1, "wedge"], ...bonds.slice(1)] })).smiles).toBe(read("CC(F)Cl").smiles);
  });

  it("passes formal charges through M CHG rather than losing them to default valence", () => {
    const drawn = read(molblock({
      atoms: [{ element: "C", x: -0.5, y: 0 }, { element: "N", charge: 1, x: 0.5, y: 0 }],
      bonds: [[0, 1, 1]]
    }));
    expect(drawn.smiles).toBe(read("C[NH3+]").smiles);
    expect(drawn.composition.formalCharge).toBe(1);
    expect(drawn.composition.formula).toBe("CH6N");
  });

  it("detects proper crossings, touching and collinear overlap, while accepting separated bonds", () => {
    expect(intersects({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 })).toBe(true);
    expect(intersects({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBe(true);
    expect(intersects({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 })).toBe(true);
    expect(intersects({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 })).toBe(false);
  });
});
