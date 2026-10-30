import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import { createEmptyDocument, moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import { applyMoleculeTargetBondLength, createSmilesMolecule } from "../src/molecule";
// These packages have no bare-package Vitest alias. Relative test imports keep the registry and
// RDKit singleton in this worktree when node_modules is shared with another checkout.
import { compositionFromRdkitJson, ensureRdkit, type RdkitJson } from "../../rdkit-adapter/src/index";
import { structureTemplates, type StructureTemplate, type StructureTemplateAtom } from "../../template-library/src/index";
import { normalizeStructureTemplateName, structureTemplateMolecule } from "../src/structureTemplates";
import { renderedLabelClearance } from "../../../tools/template-layouts/label-clearance";

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

function pointToSegmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const squaredLength = dx * dx + dy * dy;
  if (squaredLength === 0) return distance(point, from);
  const fraction = Math.max(0, Math.min(1,
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / squaredLength));
  return distance(point, { x: from.x + fraction * dx, y: from.y + fraction * dy });
}

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

function segmentToSegmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (intersects(a, b, c, d)) return 0;
  return Math.min(
    pointToSegmentDistance(a, c, d), pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b), pointToSegmentDistance(d, a, b)
  );
}

function minimumBondClearance(entry: StructureTemplate) {
  const { atoms, bonds } = entry.layout;
  const mean = bonds.reduce((sum, [a, b]) => sum + distance(atoms[a]!, atoms[b]!), 0) / bonds.length;
  let minimum = Infinity, pair = "", crossings = 0;
  for (let i = 0; i < bonds.length; i += 1) {
    const [a, b] = bonds[i]!;
    for (let j = i + 1; j < bonds.length; j += 1) {
      const [c, d] = bonds[j]!;
      if (a === c || a === d || b === c || b === d) continue;
      if (intersects(atoms[a]!, atoms[b]!, atoms[c]!, atoms[d]!)) {
        crossings += 1;
        if ((entry.allowedCrossings ?? 0) > 0) continue;
      }
      const clearance = segmentToSegmentDistance(atoms[a]!, atoms[b]!, atoms[c]!, atoms[d]!) / mean;
      if (clearance < minimum) {
        minimum = clearance;
        pair = `${a}-${b} and ${c}-${d}`;
      }
    }
  }
  return { minimum, pair, crossings };
}

function assertBondClearance(entry: StructureTemplate) {
  if (entry.projection === "perspective") return;
  const { minimum, pair, crossings } = minimumBondClearance(entry);
  expect(crossings).toBe(entry.allowedCrossings ?? 0);
  // With no nonincident pairs left after exemptions, clearance is unconstrained.
  expect(minimum, `bonds ${pair}`).toBeGreaterThanOrEqual(0.35);
}

const normalise = normalizeStructureTemplateName;

function meanBondLength(molecule: MoleculeObject): number {
  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  return molecule.bonds.reduce((sum, bond) =>
    sum + distance(atoms.get(bond.fromAtomId)!, atoms.get(bond.toAtomId)!), 0) / molecule.bonds.length;
}

function isStretched(entry: StructureTemplate, a: number, b: number): boolean {
  return entry.layout.stretchedBonds?.some(([c, d]) => a === c && b === d || a === d && b === c) ?? false;
}

function longestBondLength(molecule: MoleculeObject, template: StructureTemplate): number {
  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  return Math.max(...molecule.bonds.flatMap((bond, index) => {
    const [a, b] = template.layout.bonds[index]!;
    return isStretched(template, a, b) ? [] : [distance(atoms.get(bond.fromAtomId)!, atoms.get(bond.toAtomId)!)];
  }));
}

describe("structure template drawing defaults", () => {
  it.each(structureTemplates.filter(entry => entry.projection === "perspective"))(
    "$id: resizing retains projection ratios and targets the nominal longest bond", template => {
      const document = createEmptyDocument();
      const before = structureTemplateMolecule(template, { document, centre: { x: 300, y: 300 } });
      document.pages[0]!.objects = [before];
      const after = applyMoleculeTargetBondLength(document, [before.id], 30).pages[0]!.objects[0] as MoleculeObject;
      expect(longestBondLength(after, template)).toBeCloseTo(30, 9);
      expect(after.style.projection).toBe("perspective");
      expect(meanBondLength(after) / longestBondLength(after, template)).toBeCloseTo(meanBondLength(before) / longestBondLength(before, template), 9);
    }
  );

  it.each([undefined, {
    bondLengthPx: 30, bondStrokeWidthPx: 1.2, atomLabelFontSizePx: 12,
    atomLabelFontFamily: "Times", bondLineCap: "round", stylePresetId: "custom"
  }])("matches ordinary SMILES style and target bond length with drawing style %j", drawing => {
    const document = createEmptyDocument();
    if (drawing) document.styles.drawing = drawing;
    const ordinary = createSmilesMolecule(document, { x: 200, y: 200 }, {
      atoms: [{ element: "C", x: 0, y: 0, charge: 0 }, { element: "O", x: 1.5, y: 0, charge: 0 }],
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
    }, "CO");
    const { source: ordinarySource, ...ordinaryStyle } = ordinary.style;
    expect(ordinarySource).toBe("clipboard-smiles");
    expect(meanBondLength(ordinary)).toBeCloseTo(drawing?.bondLengthPx ?? 22, 9);
    // Flat layouts target the mean; projections target the longest bond, never the median.
    for (const template of structureTemplates) {
      const molecule = structureTemplateMolecule(template, { document, centre: { x: 200, y: 200 } });
      const { source, projection, ...style } = molecule.style;
      expect(source).toBe(`structure-template:${template.id}`);
      expect(projection).toBe(template.projection);
      expect(style).not.toHaveProperty("bondBoldWidths");
      expect(style).toEqual(projection === "perspective" && molecule.bonds.some(bond => bond.display?.bondStyle === "bold")
        ? { ...ordinaryStyle, bondBoldWidthPx: 0.136 * (drawing?.bondLengthPx ?? 22) } : ordinaryStyle);
      const measured = template.projection === "perspective" ? longestBondLength(molecule, template) : meanBondLength(molecule);
      expect(Math.abs(measured - meanBondLength(ordinary))).toBeLessThan(1e-9);
    }
  });

  it.each(structureTemplates.filter(entry => entry.projection === "perspective")
    .flatMap(template => [22, 30].map(bondLengthPx => ({ template, bondLengthPx }))))(
    "$template.id: molecule bold width follows the insertion length at $bondLengthPx px", ({ template, bondLengthPx }) => {
      const document = createEmptyDocument();
      document.styles.drawing = { bondLengthPx };
      const molecule = structureTemplateMolecule(template, { document, centre: { x: 300, y: 300 } });
      const boldIds = molecule.bonds.filter(bond => bond.display?.bondStyle === "bold").map(bond => bond.id);
      expect(boldIds.length).toBeGreaterThan(0);
      // Per-bond maps take precedence over the inspector's whole-molecule Bold width.
      expect(molecule.style).not.toHaveProperty("bondBoldWidths");
      expect(molecule.style.bondBoldWidthPx).toBe(0.136 * bondLengthPx);
      const withoutOverride = structuredClone(molecule);
      delete withoutOverride.style.bondBoldWidthPx;
      const identity = (object: MoleculeObject) => {
        const result = read(moleculeToMolfileV2000(object, { fromDocFrame: true }).contents);
        return { smiles: result.smiles, formula: result.composition.formula, charge: result.composition.formalCharge };
      };
      expect(identity(molecule)).toEqual(identity(withoutOverride));
      expect(identity(molecule)).toEqual({ smiles: read(template.smiles).smiles, formula: template.formula, charge: template.charge });
    }
  );

  it("flat templates and projections without bold bonds retain the ordinary bold width", () => {
    const document = createEmptyDocument();
    document.styles.drawing = { bondBoldWidthPx: 7 };
    const perspective = structureTemplates.find(template => template.projection === "perspective")!;
    const unmarked: StructureTemplate = { ...perspective, layout: { ...perspective.layout,
      bonds: perspective.layout.bonds.map(([a, b, order]) => [a, b, order]) } };
    for (const template of [...structureTemplates.filter(entry => !entry.projection), unmarked]) {
      const molecule = structureTemplateMolecule(template, { document, centre: { x: 300, y: 300 } });
      expect(molecule.style).not.toHaveProperty("bondBoldWidths");
      expect(molecule.style.bondBoldWidthPx).toBe(7);
    }
  });

  it.each([structureTemplates[0]!, ...structureTemplates.filter(entry => entry.projection === "perspective")])(
    "$id: explicit style fields override defaults while retaining unspecified fields", template => {
    const document = createEmptyDocument();
    document.styles.drawing = { bondLengthPx: 30, bondStrokeWidthPx: 1.2, atomLabelFontSizePx: 12 };
    const molecule = structureTemplateMolecule(template, {
      document, centre: { x: 200, y: 200 }, style: { bondLengthPx: 36, bondStrokeWidthPx: 3 }
    });
    expect(molecule.style).toMatchObject({ bondLengthPx: 36, bondStrokeWidthPx: 3, atomLabelFontSizePx: 12 });
    if (template.projection === "perspective") {
      expect(molecule.style.bondBoldWidthPx).toBe(0.136 * 36);
    }
    const measured = template.projection === "perspective" ? longestBondLength(molecule, template) : meanBondLength(molecule);
    expect(Math.abs(measured - 36)).toBeLessThan(1e-9);
  });

  it.each(structureTemplates.filter(entry => entry.projection === "perspective"))(
    "$id: an explicit bold width overrides the template width", template => {
      const document = createEmptyDocument();
      const molecule = structureTemplateMolecule(template, {
        document, centre: { x: 300, y: 300 }, style: { bondLengthPx: 30, bondBoldWidthPx: 5 }
      });
      expect(molecule.style.bondBoldWidthPx).toBe(5);
      expect(molecule.style).not.toHaveProperty("bondBoldWidths");
      document.pages[0]!.objects = [molecule];
      const resized = applyMoleculeTargetBondLength(document, [molecule.id], 22).pages[0]!.objects[0] as MoleculeObject;
      expect(resized.style.bondBoldWidthPx).toBe(5);
    }
  );

  it.each(structureTemplates.filter(entry => entry.projection === "perspective")
    .flatMap(template => [22, 36].map(bondLengthPx => ({ template, bondLengthPx }))))(
    "$template.id: resizing from the CLI's 28 px insertion updates bold width to $bondLengthPx px", ({ template, bondLengthPx }) => {
      const document = createEmptyDocument();
      const before = structureTemplateMolecule(template, {
        document, centre: { x: 300, y: 300 }, style: { bondLengthPx: 28 }
      });
      expect(before.style.bondBoldWidthPx).toBe(0.136 * 28);
      document.pages[0]!.objects = [before];
      const after = applyMoleculeTargetBondLength(document, [before.id], bondLengthPx).pages[0]!.objects[0] as MoleculeObject;
      expect(after.style.bondBoldWidthPx).toBe(0.136 * bondLengthPx);
      expect(after.style).not.toHaveProperty("bondBoldWidths");
      expect(longestBondLength(after, template)).toBeCloseTo(bondLengthPx, 9);
      expect(before.style.bondBoldWidthPx).toBe(0.136 * 28);
    }
  );
});

describe("structure template identities", () => {
  it.each(structureTemplates.filter(template => template.projection === "perspective"))(
    "$id: insertion retains exactly the cosmetic depth marks and canonical isomeric identity", template => {
      const molecule = structureTemplateMolecule(template, { document: createEmptyDocument(), centre: { x: 300, y: 300 } });
      const marked = template.layout.bonds.flatMap((bond, index) => bond[3] === "bold" ? [index] : []);
      const inserted = molecule.bonds.flatMap((bond, index) => bond.display?.bondStyle === "bold" ? [index] : []);
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.length).toBeLessThan(template.layout.bonds.length);
      expect(inserted).toEqual(marked);
      for (const [index, bond] of molecule.bonds.entries()) {
        const display = template.layout.bonds[index]![3];
        if (display === "wedge" || display === "hash") {
          expect(bond.display?.bondStyle).toBe(display === "hash" ? "hashed" : "wedge");
        }
        if (bond.display?.bondStyle === "bold") expect(["wedge", "hash"]).not.toContain(display);
      }
      const insertedIdentity = read(moleculeToMolfileV2000(molecule, { fromDocFrame: true }).contents);
      expect(insertedIdentity.smiles).toBe(read(template.smiles).smiles);
      expect(insertedIdentity.composition.formula).toBe(template.formula);
      expect(insertedIdentity.composition.formalCharge).toBe(template.charge);
    }
  );

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
  it.each(["A", "B"])("%s: vertical calixarene C–O stems use depth lengths for n=4/5 and two heights for n=6/8, retaining every clearance gate", variant => {
    const generatorUrl = new URL("../../../tools/template-layouts/calixarenes-pillararenes.mjs", import.meta.url).href;
    const coneUrl = new URL("../../../tools/template-layouts/calixarene-cone.mjs", import.meta.url).href;
    const geometryUrl = new URL("../../../tools/template-layouts/geometry.mjs", import.meta.url).href;
    const inspectionUrl = new URL("../../../tools/template-layouts/inspect-calixarenes.mjs", import.meta.url).href;
    const entries = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { generator } from ${JSON.stringify(generatorUrl)};
      import { calixareneConeModel, coneParametersFor } from ${JSON.stringify(coneUrl)};
      import { projectOrthographic } from ${JSON.stringify(geometryUrl)};
      import { projectionMetrics } from ${JSON.stringify(inspectionUrl)};
      console.log(JSON.stringify(generator.generateTemplates(${JSON.stringify(variant)}).filter(entry => entry.projection === "perspective").map(entry => {
        const n = entry.layout.atoms.filter(atom => atom.element === "O").length, size = entry.layout.atoms.length / n - 1;
        const p = coneParametersFor(n, ${JSON.stringify(variant)}), model = calixareneConeModel(n, size === 11, p);
        const projected = projectOrthographic(model, { elevation: p.elevation, viewerSide: -1, centre: model.centre });
        const depths = Array.from({ length: n }, (_, unit) => projected.atoms.slice(unit * size, unit * size + 6)
          .reduce((sum, atom) => sum + atom.depth / 6, 0));
        return { ...entry, depths, metrics: projectionMetrics(entry.layout, false) };
      })));
    `], { encoding: "utf8" })) as (StructureTemplate & { depths: number[]; metrics: {
      atomClearance: number; labelAtomClearance: number; labelBondClearance: number; minMaxBondRatio: number;
      stretchedLengths: number[];
    } })[];
    expect(entries).toHaveLength(7);
    for (const entry of entries) {
      const { atoms, stretchedBonds } = entry.layout;
      expect(stretchedBonds).toHaveLength(atoms.filter(atom => atom.element === "O").length);
      for (const [from, to] of stretchedBonds!) {
        const carbon = atoms[from]!, oxygen = atoms[to]!;
        expect(carbon.element).toBe("C");
        expect(oxygen.element).toBe("O");
        expect(oxygen.x, `${entry.id}: C–O ${from}-${to}, including bold stems`).toBe(carbon.x);
        expect(oxygen.y).toBeLessThan(carbon.y);
        expect(Math.abs(Math.atan2(oxygen.x - carbon.x, carbon.y - oxygen.y) * 180 / Math.PI))
          .toBeLessThan(1);
      }
      const nominal = Math.max(...entry.layout.bonds.filter(([a, b]) => !isStretched(entry, a, b))
        .map(([a, b]) => distance(atoms[a]!, atoms[b]!)));
      const n = entry.depths.length, size = atoms.length / n - 1;
      const lengths = entry.depths.map((_, unit) => distance(atoms[unit * size]!, atoms[unit * size + 6]!) / nominal);
      if (n === 4 || n === 5) {
        const far = Math.min(...entry.depths), near = Math.max(...entry.depths);
        for (const [unit, depth] of entry.depths.entries()) {
          const t = (depth - far) / (near - far);
          const fraction = n === 5 ? -Math.expm1(-8 * t) / -Math.expm1(-8) : t;
          const short = n === 5 ? 0.79 : 0.78;
          expect(Math.abs(lengths[unit]! - (short + (1.99 - short) * fraction)), `${entry.id}: ring ${unit}`)
            .toBeLessThan(0.0002); // Four-decimal coordinate serialization only.
          for (let other = 0; other < n; other++) {
            if (Math.abs(depth - entry.depths[other]!) < 1e-8) {
              expect(Math.abs(lengths[unit]! - lengths[other]!)).toBeLessThan(0.0002);
            } else if (depth > entry.depths[other]!) expect(lengths[unit]).toBeGreaterThan(lengths[other]!);
          }
        }
      } else {
        const oxygens = stretchedBonds!.map(([, to]) => atoms[to]!);
        expect(new Set(oxygens.map(atom => atom.y)).size).toBe(2);
        expect((Math.max(...oxygens.map(atom => atom.y)) - Math.min(...oxygens.map(atom => atom.y))) / nominal)
          .toBeCloseTo(1.09, 3);
        const bottom = Math.min(...stretchedBonds!.map(([from]) => atoms[from]!.y));
        for (const [unit, depth] of entry.depths.entries()) {
          const expectedY = bottom - nominal * ((n === 6 ? 0.65 : 0.60) + (depth > 0 ? 0 : 1.09));
          expect(Math.abs(atoms[unit * size + 6]!.y - expectedY) / nominal).toBeLessThan(0.0002);
        }
      }
      expect(entry.metrics.atomClearance).toBeGreaterThanOrEqual(0.30);
      expect(entry.metrics.labelAtomClearance).toBeGreaterThanOrEqual(0.95);
      expect(entry.metrics.labelBondClearance).toBeGreaterThanOrEqual(0.75);
      expect(entry.metrics.minMaxBondRatio).toBeGreaterThanOrEqual(0.35);
      for (const length of entry.metrics.stretchedLengths) {
        expect(length).toBeGreaterThanOrEqual(0.35);
        expect(length).toBeLessThanOrEqual(2);
      }
      for (const bondLengthPx of [22, 30]) {
        const molecule = structureTemplateMolecule(entry, {
          document: createEmptyDocument(), centre: { x: 300, y: 300 }, style: { bondLengthPx }
        });
        expect(molecule.style.bondLengthPx).toBe(bondLengthPx);
        const clearances = renderedLabelClearance(molecule);
        expect(clearances.collisions).toEqual([]);
        expect(clearances.labelGapPx).toBeGreaterThanOrEqual(0.15 * bondLengthPx);
        expect(clearances.bondGapPx).toBeGreaterThan(Number(molecule.style.bondStrokeWidthPx) / 2);
      }
    }
  });

  it("the comparison opens and spreads only the two tetramers, retaining the source model and depth marks", () => {
    const generatorUrl = new URL("../../../tools/template-layouts/calixarenes-pillararenes.mjs", import.meta.url).href;
    const coneUrl = new URL("../../../tools/template-layouts/calixarene-cone.mjs", import.meta.url).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { generator } from ${JSON.stringify(generatorUrl)};
      import { calixareneConeModel, coneParametersFor, projectCone } from ${JSON.stringify(coneUrl)};
      console.log(JSON.stringify(["A", "B"].map(variant => {
        const p = coneParametersFor(4, variant);
        return { templates: generator.generateTemplates(variant),
          models: [false, true].map(tertButyl => {
            const model = calixareneConeModel(4, tertButyl, p);
            return { model, layout: projectCone(model, p.elevation, p),
              otherLengths: projectCone(model, p.elevation, { ...p, oxygenLength: { short: 0.85, long: 1.95 } }) };
          }) };
      })));
    `], { encoding: "utf8" })) as { templates: StructureTemplate[];
      models: { model: unknown; layout: StructureTemplate["layout"]; otherLengths: StructureTemplate["layout"] }[] }[];
    const [a, b] = result as [typeof result[number], typeof result[number]];
    expect(a.models.map(entry => entry.model)).toEqual(b.models.map(entry => entry.model));
    expect(b.templates.slice(2)).toEqual(a.templates.slice(2));
    for (const variant of result) for (const entry of variant.models) {
      expect(entry.layout.bonds).toEqual(entry.otherLengths.bonds);
      expect(entry.layout.stretchedBonds).toEqual(entry.otherLengths.stretchedBonds);
      expect(entry.layout.atoms.filter(atom => atom.element === "C"))
        .toEqual(entry.otherLengths.atoms.filter(atom => atom.element === "C"));
      expect(entry.layout.atoms.filter(atom => atom.element === "O"))
        .not.toEqual(entry.otherLengths.atoms.filter(atom => atom.element === "O"));
    }
    for (const [index, entry] of b.models.entries()) {
      const size = index === 0 ? 7 : 11;
      const previous = a.models[index]!.layout;
      expect(entry.layout.bonds).toEqual(previous.bonds);
      const ring = (unit: number) => entry.layout.atoms.slice(unit * size, unit * size + 6);
      const width = (unit: number) => Math.max(...ring(unit).map(atom => atom.x)) - Math.min(...ring(unit).map(atom => atom.x));
      const centre = (unit: number) => ring(unit).reduce((sum, atom) => sum + atom.x / 6, 0);
      expect(centre(3)).toBeGreaterThan(centre(1));
      for (const unit of [0, 1, 2, 3]) {
        const ids = new Set(Array.from({ length: 6 }, (_, vertex) => unit * size + vertex));
        expect(entry.layout.bonds.filter(([from, to, , display]) => ids.has(from) && ids.has(to) && display === "bold"))
          .toHaveLength(unit === 3 ? 6 : 0);
        const junction = 4 * size + unit;
        expect(entry.layout.bonds.filter(([from, to, , display]) => (from === junction || to === junction) && display === "bold"))
          .toHaveLength(unit >= 2 ? 2 : 0);
      }
      const bounds = (axis: "x" | "y") => {
        const values = entry.layout.atoms.map(atom => atom[axis]);
        return Math.max(...values) - Math.min(...values);
      };
      expect(bounds("x")).toBeGreaterThan(bounds("y"));
      for (const unit of [0, 2]) {
        expect(width(unit) / width(3)).toBeGreaterThanOrEqual(0.35);
        expect(width(unit) / width(3)).toBeLessThanOrEqual(0.5);
        const centreX = ring(unit).reduce((sum, atom) => sum + atom.x / 6, 0);
        const oldCentreX = previous.atoms.slice(unit * size, unit * size + 6).reduce((sum, atom) => sum + atom.x / 6, 0);
        expect(Math.abs(centreX)).toBeGreaterThan(Math.abs(oldCentreX));
      }
    }
  });

  it("projects signed midpoint depth, leaves the middle plane normal, and gives stereo priority", () => {
    const moduleUrl = new URL("../../../tools/template-layouts/geometry.mjs", import.meta.url).href;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { projectOrthographic, cueBondDepth, orderBondsByDepth } from ${JSON.stringify(moduleUrl)};
      const model = { atoms: [
        { element: "C", x: 1, y: 4, z: 3 }, { element: "C", x: 3, y: 2, z: 5 },
        { element: "C", x: 1, y: 0, z: 3 }, { element: "C", x: 3, y: 2.1, z: 3 }
      ], bonds: [[0, 1, 1], [1, 2, 1], [1, 3, 1], [0, 2, 1],
        [0, 1, 1, "wedge"], [0, 1, 1, "hash"]] };
      const projected = projectOrthographic(model, { elevation: 0, centre: { x: 1, y: 2, z: 3 } });
      const reversed = projectOrthographic(model, { elevation: 0, centre: { x: 1, y: 2, z: 3 }, viewerSide: -1 });
      console.log(JSON.stringify({ projected, ordered: orderBondsByDepth(projected).bonds, front: cueBondDepth(projected).bonds,
        back: cueBondDepth(reversed).bonds }));
    `], { encoding: "utf8" }));
    expect(result.projected.atoms[0]).toMatchObject({ x: 0, y: 0, depth: 2 });
    expect(result.projected.atoms[1]).toMatchObject({ x: 2, y: 2, depth: 0 });
    expect(result.front).toEqual([[0, 1, 1, "bold"], [1, 2, 1], [1, 3, 1], [0, 2, 1],
      [0, 1, 1, "wedge"], [0, 1, 1, "hash"]]);
    expect(result.back).toEqual([[0, 1, 1], [1, 2, 1, "bold"], [1, 3, 1], [0, 2, 1],
      [0, 1, 1, "wedge"], [0, 1, 1, "hash"]]);
    expect(result.ordered).toEqual([[1, 2, 1], [0, 2, 1], [1, 3, 1], [0, 1, 1],
      [0, 1, 1, "wedge"], [0, 1, 1, "hash"]]);
  });

  it.each(structureTemplates.filter(entry => entry.projection === "perspective"))(
    "$id: normal-style label boxes clear each other and nonincident bonds", template => {
      const molecule = structureTemplateMolecule(template, { document: createEmptyDocument(), centre: { x: 300, y: 300 } });
      const clearances = renderedLabelClearance(molecule);
      expect(clearances.collisions).toEqual([]);
      expect(clearances.labelGapPx).toBeGreaterThan(0);
      expect(clearances.bondGapPx).toBeGreaterThan(Number(molecule.style.bondStrokeWidthPx) / 2);
    }
  );

  it.each(structureTemplates.filter(entry => entry.projection === "perspective"))(
    "$id: padded rendered atom-label boxes have at least 0.15 nominal bond lengths between them", template => {
      for (const bondLengthPx of [22, 30]) {
        const molecule = structureTemplateMolecule(template, {
          document: createEmptyDocument(), centre: { x: 300, y: 300 }, style: { bondLengthPx }
        });
        // The shared helper measures every pair of the renderer's padded label
        // boxes, including implicit hydrogens; atom centres cannot catch OHOH.
        expect(renderedLabelClearance(molecule).labelGapPx,
          `${template.id} at ${bondLengthPx}px`).toBeGreaterThanOrEqual(0.15 * bondLengthPx);
      }
    }
  );

  it("the cone construction has ideal 3D bond lengths and rigid rotationally identical units", () => {
    // Exercise the dependency-free Node generator as Node on either host, without
    // depending on Vite's handling of .mjs generators or a second set of coordinates.
    const moduleUrl = new URL("../../../tools/template-layouts/calixarene-cone.mjs", import.meta.url).href;
    const models = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { calixareneConeModel, coneParametersFor, projectCone } from ${JSON.stringify(moduleUrl)};
      import { projectOrthographic } from ${JSON.stringify(new URL("../../../tools/template-layouts/geometry.mjs", import.meta.url).href)};
      console.log(JSON.stringify([4, 5, 6, 8].flatMap(n => [false, true].map(tertButyl => {
        const parameters = coneParametersFor(n), model = calixareneConeModel(n, tertButyl, parameters);
        return { n, tertButyl, ...model,
          layout: projectCone(model, parameters.elevation, parameters),
          projected: projectOrthographic(model, { elevation: parameters.elevation, viewerSide: -1, centre: model.centre }).atoms,
          depths: projectOrthographic(model, { elevation: parameters.elevation, viewerSide: -1, centre: model.centre }).atoms.map(atom => atom.depth) };
      }))));
    `], { encoding: "utf8" })) as {
      n: number; tertButyl: boolean;
      atoms: { element: string; x: number; y: number; z: number }[];
      bonds: [number, number, number][];
      layout: StructureTemplate["layout"];
      projected: { x: number; y: number }[];
      depths: number[];
    }[];
    for (const model of models) {
      const { n, atoms, bonds } = model;
      const unitSize = model.tertButyl ? 11 : 7;
      expect(atoms).toHaveLength(n * (unitSize + 1));
      if (n === 6) {
        // Both hexamers keep their pre-baseline ring orientations. Small unit
        // translations may clear stems; rotating or shearing a panel may not.
        for (let unit = 0; unit < n; unit++) for (let vertex = 1; vertex < 6; vertex++) {
          const start = unit * unitSize;
          for (const axis of ["x", "y"] as const) {
            expect(model.layout.atoms[start + vertex]![axis] - model.layout.atoms[start]![axis])
              .toBeCloseTo(model.projected[start + vertex]![axis] - model.projected[start]![axis], 12);
          }
        }
      }
      expect(model.layout.stretchedBonds).toHaveLength(n);
      for (const [from, to] of model.layout.stretchedBonds!) {
        if (model.depths.slice(from, from + 6).reduce((sum, depth) => sum + depth, 0) > 0) continue;
        for (let unit = 0; unit < n; unit++) {
          const start = unit * unitSize;
          if (model.depths.slice(start, start + 6).reduce((sum, depth) => sum + depth, 0) <= 0) continue;
          for (let vertex = 0; vertex < 6; vertex++) {
            expect(intersects(model.layout.atoms[from]!, model.layout.atoms[to]!,
              model.layout.atoms[start + vertex]!, model.layout.atoms[start + (vertex + 1) % 6]!),
            `rear C–O ${from}-${to} must not cut front ring ${unit}`).toBe(false);
          }
        }
      }
      for (const [from, to] of bonds) {
        const a = atoms[from]!, b = atoms[to]!;
        expect(Math.abs(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - 1)).toBeLessThan(1e-12);
      }
      for (let unit = 0; unit < n; unit++) {
        const angle = unit * 2 * Math.PI / n, cos = Math.cos(angle), sin = Math.sin(angle);
        // Include each complete aryl/OH/tBu unit and its CH2 bridge.
        const pairs = Array.from({ length: unitSize }, (_, local) => [local, unit * unitSize + local]);
        pairs.push([unitSize * n, unitSize * n + unit]);
        for (const [first, repeated] of pairs) {
          const a = atoms[first!]!, b = atoms[repeated!]!;
          expect(b.element).toBe(a.element);
          expect(Math.hypot(b.x - (a.x * cos - a.y * sin), b.y - (a.x * sin + a.y * cos), b.z - a.z))
            .toBeLessThan(1e-12);
        }
      }
    }
  });

  // The smaller CB portals still need unequal bonds to keep radial inward carbonyls
  // and visibly bent N-CH2-N bridges separate at >= 0.95 atom-label clearance, without crossings.
  // These per-id exceptions retain the absolute 0.85–1.15 check below; larger CB
  // hosts and every other template must satisfy the tighter relative window.
  // Achieved min/max relative to mean: CB[5] 0.85095–1.14870, CB[6] 0.89604–1.11290.
  const nonUniformPortalIds = new Set(["cucurbit-5-uril", "cucurbit-6-uril"]);

  it.each(structureTemplates.filter((entry) => !entry.projection && !nonUniformPortalIds.has(entry.id)).map((entry) => [entry.id, entry] as const))(
    "%s: every bond is within five percent of the template's own mean",
    (_id, entry) => {
      const { atoms, bonds } = entry.layout;
      const lengths = bonds.map(([from, to]) => distance(atoms[from]!, atoms[to]!));
      const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
      lengths.forEach((length, index) => {
        const [from, to] = bonds[index]!;
        expect(length / mean, `bond ${from}-${to} relative to mean`).toBeGreaterThanOrEqual(0.95);
        expect(length / mean, `bond ${from}-${to} relative to mean`).toBeLessThanOrEqual(1.05);
      });
    }
  );

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
      const perspective = entry.projection === "perspective";
      const longest = Math.max(...bonds.filter(([a, b]) => !isStretched(entry, a, b))
        .map(([from, to]) => distance(atoms[from]!, atoms[to]!)));
      const unit = perspective ? longest : 1;
      const pair = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
      const lengths: number[] = [];
      for (const [from, to, order, display] of bonds) {
        expect(Number.isInteger(from) && Number.isInteger(to)).toBe(true);
        expect(atoms[from]).toBeDefined();
        expect(atoms[to]).toBeDefined();
        expect(from).not.toBe(to);
        expect([1, 2, 3]).toContain(order);
        expect([undefined, "wedge", "hash", "bold"]).toContain(display);
        expect(neighbours.has(pair(from, to)), "duplicate bond").toBe(false);
        neighbours.add(pair(from, to));
        const length = distance(atoms[from]!, atoms[to]!);
        expect(length / unit, `bond ${from}-${to}`).toBeGreaterThanOrEqual(perspective ? 0.35 : 0.85);
        expect(length / unit, `bond ${from}-${to}`).toBeLessThanOrEqual(perspective ? isStretched(entry, from, to) ? 2 : 1 : 1.15);
        lengths.push(length);
      }
      if (perspective) expect(Math.abs(longest - 1)).toBeLessThanOrEqual(0.00015);
      else expect(lengths.reduce((sum, length) => sum + length, 0) / lengths.length).toBeCloseTo(1, 4);
      const declared = entry.layout.stretchedBonds ?? [];
      expect(new Set(declared.map(([a, b]) => pair(a, b))).size).toBe(declared.length);
      for (const [a, b] of declared) {
        expect(perspective).toBe(true);
        expect(neighbours.has(pair(a, b)), "declared stretched bond must exist").toBe(true);
      }
      for (let a = 0; a < atoms.length; a += 1) {
        for (let b = a + 1; b < atoms.length; b += 1) {
          if (!neighbours.has(pair(a, b))) {
            // Projection compresses depth: its skeletal clearance is 0.30 longest
            // bonds, while flat templates retain 0.60. Label gates stay unchanged.
            expect(distance(atoms[a]!, atoms[b]!) / unit, `atoms ${a}-${b}`).toBeGreaterThanOrEqual(perspective ? 0.30 : 0.6);
            // Text needs more room than an unlabeled skeletal carbon vertex. Apply
            // this to every label/non-neighbour pair, including charged carbons.
            if ([atoms[a]!, atoms[b]!].some((atom) => atom.element !== "C" || (atom.charge ?? 0) !== 0)) {
              // The visually checked cyclodextrin chairs project a ring oxygen
              // 0.845 bond lengths from a non-neighbouring carbon corner; the text
              // remains clear. Keep the full 0.95 threshold for every other family.
              const minimum = entry.family === "cyclodextrins" ? 0.84 : 0.95;
              expect(distance(atoms[a]!, atoms[b]!) / unit, `label clearance at atoms ${a}-${b}`).toBeGreaterThanOrEqual(minimum);
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
      if (!perspective) expect(crossings).toBe(allowed);
    }
  );

  it.each(structureTemplates.filter(entry => !entry.projection).map((entry) => [entry.id, entry] as const))(
    "%s: nonincident bonds clear each other by at least 0.35 mean bond lengths",
    (_id, entry) => {
      assertBondClearance(entry);
    }
  );

  it("every family's minimum nonincident bond clearance meets the threshold", () => {
    const minima = new Map<string, number>();
    for (const entry of structureTemplates.filter(entry => !entry.projection)) {
      const { minimum } = minimumBondClearance(entry);
      minima.set(entry.family, Math.min(minima.get(entry.family) ?? Infinity, minimum));
    }
    for (const [family, minimum] of minima) {
      expect(Number.isFinite(minimum), family).toBe(true);
      expect(minimum, family).toBeGreaterThanOrEqual(0.35);
    }
  });

  it.each(structureTemplates.map((entry) => [entry.id, entry] as const))(
    "%s: every atom label clears every bond that does not contain it",
    (_id, entry) => {
      const { atoms, bonds } = entry.layout;
      const unit = entry.projection === "perspective"
        ? Math.max(...bonds.filter(([a, b]) => !isStretched(entry, a, b))
          .map(([from, to]) => distance(atoms[from]!, atoms[to]!))) : 1;
      for (const [index, atom] of atoms.entries()) {
        if (atom.element === "C" && (atom.charge ?? 0) === 0) continue;
        for (const [from, to] of bonds) {
          if (index === from || index === to) continue;
          expect(pointToSegmentDistance(atom, atoms[from]!, atoms[to]!) / unit,
            `label ${index} to bond ${from}-${to}`).toBeGreaterThanOrEqual(0.75);
        }
      }
    }
  );

  it.each(structureTemplates.filter((entry) => entry.family === "cucurbiturils").map((entry) => [entry.id, entry] as const))(
    "%s: every carbonyl is radial and every glycoluril/bridge sector is a rigid repeat",
    (_id, entry) => {
      const { atoms } = entry.layout;
      const n = atoms.length / 12;
      expect(Number.isInteger(n)).toBe(true);
      // Odd-membered hosts have a translated bounding-box centre. Recover the
      // rotational centre from the repeated shared methine edges instead.
      const centre = { x: 0, y: 0 };
      for (let unit = 0; unit < n; unit += 1) {
        for (const index of [12 * unit, 12 * unit + 1]) {
          centre.x += atoms[index]!.x / (2 * n);
          centre.y += atoms[index]!.y / (2 * n);
        }
      }
      for (let unit = 0; unit < n; unit += 1) {
        const angle = 2 * Math.PI * unit / n, cos = Math.cos(angle), sin = Math.sin(angle);
        for (let index = 0; index < 12; index += 1) {
          const original = atoms[index]!, repeated = atoms[12 * unit + index]!;
          const x = original.x - centre.x, y = original.y - centre.y;
          expect(repeated.element).toBe(original.element);
          expect(distance(repeated, { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos }),
            `sector ${unit}, atom ${index}`).toBeLessThanOrEqual(0.0002);
        }
        for (const [index, direction] of [[4, -1], [8, 1]] as const) {
          const c = atoms[12 * unit + index]!, o = atoms[12 * unit + index + 1]!;
          const rx = c.x - centre.x, ry = c.y - centre.y;
          const dx = o.x - c.x, dy = o.y - c.y;
          const product = Math.hypot(rx, ry) * Math.hypot(dx, dy);
          expect(Math.abs(rx * dy - ry * dx) / product, `carbonyl at ${12 * unit + index}`)
            .toBeLessThanOrEqual(0.0002);
          expect(direction * (rx * dx + ry * dy)).toBeGreaterThan(0);
          expect(direction * (distance(o, centre) - distance(c, centre))).toBeGreaterThan(0);
        }
      }
    }
  );

  it.each(structureTemplates.filter((entry) => entry.family === "cucurbiturils").map((entry) => [entry.id, entry] as const))(
    "%s: every methylene bridge has a visible, unsquashed bend",
    (_id, entry) => {
      const { atoms, bonds } = entry.layout;
      let bridges = 0;
      for (const [index, atom] of atoms.entries()) {
        if (atom.element !== "C") continue;
        const neighbours = bonds.flatMap(([from, to]) => from === index ? [to] : to === index ? [from] : []);
        if (neighbours.length !== 2 || !neighbours.every((other) => atoms[other]!.element === "N")) continue;
        bridges += 1;
        const [a, b] = neighbours.map((other) => atoms[other]!);
        const cosine = ((a!.x - atom.x) * (b!.x - atom.x) + (a!.y - atom.y) * (b!.y - atom.y)) /
          (distance(a!, atom) * distance(b!, atom));
        const degrees = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
        expect(degrees, `bridge carbon ${index}: avoid a tiny caret`).toBeGreaterThanOrEqual(90);
        expect(degrees, `bridge carbon ${index}: at least 25 degrees off straight`).toBeLessThanOrEqual(155);
      }
      expect(bridges).toBe(atoms.length / 6);
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
  it.each(["wedge", "hash"] as const)("insertion keeps a directed %s beside a cosmetic bold bond", display => {
    const template: StructureTemplate = {
      ...structureTemplates[0]!, smiles: "C[C@H](F)Cl",
      layout: {
        atoms: [
          { element: "C", x: 0, y: 0 }, { element: "C", x: 1, y: 0 },
          { element: "F", x: -0.5, y: 0.866 }, { element: "Cl", x: -0.5, y: -0.866 }
        ],
        bonds: [[0, 1, 1, display], [0, 2, 1, "bold"], [0, 3, 1]]
      }
    };
    const molecule = structureTemplateMolecule(template, { document: createEmptyDocument(), centre: { x: 300, y: 300 } });
    expect(molecule.bonds.map(bond => bond.display?.bondStyle)).toEqual([
      display === "hash" ? "hashed" : "wedge", "bold", undefined
    ]);
    expect(read(moleculeToMolfileV2000(molecule, { fromDocFrame: true }).contents).smiles)
      .toBe(read(molblock(template.layout)).smiles);
  });

  it("exempts a future projection from crossing/bond clearance checks by its field alone", () => {
    const projection: StructureTemplate = {
      ...structureTemplates[0]!, id: "future-projected-cage", projection: "perspective",
      layout: {
        atoms: [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([x, y]) => ({ element: "C", x: x!, y: y! })),
        bonds: [[0, 1, 1], [2, 3, 1]]
      }
    };
    expect(() => assertBondClearance(projection)).not.toThrow();
    expect(() => assertBondClearance({ ...projection, projection: undefined })).toThrow();
  });

  it("exempts exactly declared crossings, while still rejecting a nonintersecting near-miss", () => {
    const crossing: StructureTemplate = {
      ...structureTemplates[0]!, allowedCrossings: 1,
      layout: {
        atoms: [[-1, 0], [1, 0], [0, -1], [0, 1], [3, 0], [5, 0]]
          .map(([x, y]) => ({ element: "C", x: x!, y: y! })),
        bonds: [[0, 1, 1], [2, 3, 1], [4, 5, 1]]
      }
    };
    expect(() => assertBondClearance(crossing)).not.toThrow();
    expect(() => assertBondClearance({ ...crossing, layout: {
      atoms: crossing.layout.atoms.slice(0, 4), bonds: crossing.layout.bonds.slice(0, 2)
    } })).not.toThrow();
    expect(() => assertBondClearance({ ...crossing, allowedCrossings: 0 })).toThrow();
    expect(() => assertBondClearance({ ...crossing, allowedCrossings: 2 })).toThrow();
    const nearMiss: StructureTemplate = {
      ...crossing,
      layout: {
        atoms: [...crossing.layout.atoms, { element: "C", x: 3, y: 0.2 }, { element: "C", x: 5, y: 0.2 }],
        bonds: [...crossing.layout.bonds, [6, 7, 1]]
      }
    };
    expect(minimumBondClearance(nearMiss)).toMatchObject({ crossings: 1, pair: "4-5 and 6-7" });
    expect(() => assertBondClearance(nearMiss)).toThrow();
  });

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

  it("measures interior, endpoint and parallel bond clearance and gives intersections zero clearance", () => {
    const a = { x: 0, y: 0 }, b = { x: 2, y: 0 };
    expect(segmentToSegmentDistance(a, b, { x: 1, y: 0.4 }, { x: 1, y: 2 })).toBeCloseTo(0.4);
    expect(segmentToSegmentDistance(a, b, { x: 3, y: 1 }, { x: 4, y: 2 })).toBeCloseTo(Math.SQRT2);
    expect(segmentToSegmentDistance(a, b, { x: 0.5, y: 0.35 }, { x: 1.5, y: 0.35 })).toBeCloseTo(0.35);
    expect(segmentToSegmentDistance(a, b, { x: 3, y: 0 }, { x: 4, y: 0 })).toBe(1);
    expect(segmentToSegmentDistance(a, b, { x: 1, y: -1 }, { x: 1, y: 1 })).toBe(0);
    expect(segmentToSegmentDistance(a, b, { x: 1, y: 0 }, { x: 3, y: 0 })).toBe(0);
  });
});
