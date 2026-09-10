import { describe, expect, it } from "vitest";
import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import {
  createPhase4Document,
  insertSmilesMoleculeGrid,
  type PastedStructureDepiction
} from "./documentWorkflow";
import { exportStructureListSdf, exportStructureListSmi, readingOrderMolecules } from "./structureListExport";

function moleculeAt(id: string, x: number, y: number, width = 100, height = 100): MoleculeObject {
  return {
    id, type: "molecule", x, y, width, height, rotation: 0, style: {},
    structureFormat: "smiles", structure: "CC",
    atoms: [
      { id: "a1", element: "C", x, y, formalCharge: 0 },
      { id: "a2", element: "C", x: x + width, y: y + height, formalCharge: 0 }
    ],
    bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }],
    superatoms: [], rGroups: []
  };
}

function documentWith(molecules: MoleculeObject[], selectedIds: string[] = []): ChemDraftDocument {
  const document = createPhase4Document("Document title is not a molecule name");
  return {
    ...document,
    pages: [{ ...document.pages[0], objects: molecules }],
    selection: { ...document.selection, objectIds: selectedIds }
  };
}

function pastedGrid() {
  const entries = [11, 7, 9, 8, 10, 6].map((atomCount) => {
    const depiction: PastedStructureDepiction = {
      atoms: Array.from({ length: atomCount }, (_, index) => ({
        element: "C", x: index * 1.5, y: index * 1.5, charge: 0
      })),
      bonds: Array.from({ length: atomCount - 1 }, (_, index) => ({
        from: index, to: index + 1, order: "single", wedge: null
      }))
    };
    return { smiles: "C".repeat(atomCount), depiction };
  });
  const result = insertSmilesMoleculeGrid(createPhase4Document("Grid"), { x: 24, y: 24 }, entries);
  expect(result).toMatchObject({ columns: 3, rows: 2 });
  // Storage/z-order and selection order must not determine export order.
  const document: ChemDraftDocument = {
    ...result.document,
    pages: [{ ...result.document.pages[0], objects: [...result.document.pages[0].objects].reverse() }],
    selection: { ...result.document.selection, objectIds: [...result.objectIds].reverse() }
  };
  return { document, entries, objectIds: result.objectIds };
}

describe("readingOrderMolecules", () => {
  it("keeps a slightly lower, far-left molecule in its neighbours' row", () => {
    const left = moleculeAt("left", 0, 20);
    const middle = moleculeAt("middle", 300, 0);
    const right = moleculeAt("right", 600, 10);
    const lowerLeft = moleculeAt("lowerLeft", 0, 200);
    const lowerRight = moleculeAt("lowerRight", 600, 200);
    const input = [lowerRight, right, middle, lowerLeft, left];
    const before = structuredClone(input);
    expect(readingOrderMolecules(input)).toEqual([left, middle, right, lowerLeft, lowerRight]);
    expect(input).toEqual(before);
  });

  it("uses centres rather than top/left edges and the median rather than an outlier height", () => {
    const tall = moleculeAt("tall", 20, -440, 40, 1000); // centre (40, 60)
    const wide = moleculeAt("wide", 0, 0, 400, 100); // centre (200, 50)
    const right = moleculeAt("right", 300, 0);
    const nextRow = moleculeAt("next", 0, 100);
    expect(readingOrderMolecules([nextRow, right, wide, tall])).toEqual([tall, wide, right, nextRow]);
  });

  it("averages the middle heights for an even count and uses a strict half-height threshold", () => {
    const top = moleculeAt("top", 500, 0, 100, 80); // centre y = 40
    const left = moleculeAt("left", 0, 29, 100, 120); // centre y = 89; median height = 100
    expect(readingOrderMolecules([top, left])).toEqual([left, top]);
    expect(readingOrderMolecules([top, { ...left, y: 30 }]).map((molecule) => molecule.id)).toEqual(["top", "left"]);
  });

  it("does not chain small offsets across row bands", () => {
    const top = moleculeAt("top", 500, 0);
    const near = moleculeAt("near", 200, 40);
    const lower = moleculeAt("lower", 0, 80);
    expect(readingOrderMolecules([lower, near, top])).toEqual([near, top, lower]);
  });

  it("handles empty lists and zero-height molecules in aligned rows", () => {
    const left = moleculeAt("left", 0, 10, 100, 0);
    const right = moleculeAt("right", 200, 10, 100, 0);
    const below = moleculeAt("below", 0, 11, 100, 0);
    expect(readingOrderMolecules([])).toEqual([]);
    expect(readingOrderMolecules([left])).toEqual([left]);
    expect(readingOrderMolecules([below, right, left])).toEqual([left, right, below]);
  });
});

describe("structure list export", () => {
  it.each([true, false])("exports six pasted grid molecules in paste order (selection: %s)", (selected) => {
    const { document, entries } = pastedGrid();
    if (!selected) document.selection.objectIds = [];
    const before = structuredClone(document);
    const sdf = exportStructureListSdf(document, {});
    const smi = exportStructureListSmi(document);
    expect(sdf).toMatchObject({
      format: "sdf", kind: "text", extension: "sdf", mimeType: "chemical/x-mdl-sdfile", warnings: []
    });
    const records = sdf.contents.split("$$$$\n");
    expect(records.pop()).toBe("");
    expect(records).toHaveLength(6);
    records.forEach((record, index) => {
      expect(record.split("\n")[0]).toBe(`ChemDraft molecule ${index + 1}`);
      expect(record).toContain(`M  END\n> <SMILES>\n${entries[index].smiles}\n\n> <Index>\n${index + 1}\n\n`);
      expect(record).not.toContain("> <Name>");
      const graph = parseMolfileGraph(record.slice(0, record.indexOf("> <SMILES>")));
      expect(graph.atoms).toHaveLength(entries[index].depiction.atoms.length);
      expect(graph.bonds).toHaveLength(entries[index].depiction.bonds.length);
    });
    expect(smi).toEqual({
      format: "smiles", kind: "text", extension: "smi", mimeType: "chemical/x-daylight-smiles", warnings: [],
      contents: entries.map((entry, index) => `${entry.smiles}\t${index + 1}\n`).join("")
    });
    expect(smi.contents.trimEnd().split("\n")).toHaveLength(6);
    expect(smi.contents).not.toContain(".");
    expect(document).toEqual(before);
  });

  it("exports only selected molecules, numbered in reading order from one", () => {
    const { document, entries, objectIds } = pastedGrid();
    document.selection.objectIds = [objectIds[4], objectIds[1]];
    expect(exportStructureListSmi(document).contents).toBe(`${entries[1].smiles}\t1\n${entries[4].smiles}\t2\n`);
    const sdf = exportStructureListSdf(document).contents;
    expect(sdf.match(/^\$\$\$\$$/gm)).toHaveLength(2);
    expect([...sdf.matchAll(/> <SMILES>\n([^\n]+)/g)].map((match) => match[1])).toEqual([entries[1].smiles, entries[4].smiles]);
    expect([...sdf.matchAll(/> <Index>\n(\d+)/g)].map((match) => match[1])).toEqual(["1", "2"]);
  });

  it("does not fall back to the page for selections without editable molecules", () => {
    const editable = moleculeAt("editable", 0, 0);
    const opaque = { ...moleculeAt("opaque", 200, 0), atoms: [], bonds: [] };
    const document = documentWith([editable, opaque]);
    const text = {
      id: "text", type: "text" as const, x: 0, y: 300, width: 100, height: 20,
      rotation: 0, style: {}, text: "Annotation", spans: []
    };
    document.pages[0].objects.push(text);
    for (const objectIds of [[text.id], [opaque.id], ["missing"]]) {
      document.selection.objectIds = objectIds;
      expect(exportStructureListSmi(document).contents).toBe("");
      expect(exportStructureListSdf(document).contents).toBe("");
    }
    document.selection.objectIds = [];
    expect(exportStructureListSmi(document).contents).toBe("CC\t1\n");
    expect(exportStructureListSdf(document).contents.match(/^\$\$\$\$$/gm)).toHaveLength(1);
  });

  it("uses stored SMILES verbatim and falls back to the native graph for other formats", () => {
    const stored = { ...moleculeAt("stored", 0, 0), structure: "C(C)" };
    const native = { ...moleculeAt("native", 200, 0), structureFormat: "unknown" as const, structure: "stale" };
    native.atoms[1].element = "O";
    const document = documentWith([native, stored]);
    expect(exportStructureListSmi(document).contents).toBe("C(C)\t1\nCO\t2\n");
    expect([...exportStructureListSdf(document).contents.matchAll(/> <SMILES>\n([^\n]+)/g)].map((match) => match[1])).toEqual(["C(C)", "CO"]);
  });

  it("uses a nonempty source molfile title as the name and omits names for blank titles", () => {
    const named = { ...moleculeAt("named", 0, 0), structureFormat: "molfile-v2000" as const };
    named.structure = `  Ethane\tstandard  ${moleculeToMolfileV2000(named)}`.replace(/\n/g, "\r\n");
    const unnamed = { ...moleculeAt("unnamed", 200, 0), structureFormat: "molfile-v2000" as const };
    unnamed.structure = ` \t ${moleculeToMolfileV2000(unnamed)}`;
    const document = documentWith([unnamed, named]);
    expect(exportStructureListSmi(document).contents).toBe("CC\tEthane standard\nCC\t2\n");
    const records = exportStructureListSdf(document).contents.split("$$$$\n");
    expect(records[0]).toMatch(/^Ethane standard\n/);
    expect(records[0]).toContain("> <Name>\nEthane standard\n\n");
    expect(records[1]).toMatch(/^ChemDraft molecule 2\n/);
    expect(records[1]).not.toContain("> <Name>");
  });

  it("preserves the V2000 writer's document-frame coordinates, charges and wedge flags", () => {
    const molecule = moleculeAt("stereo", 20, 30);
    molecule.atoms[1].element = "N";
    molecule.atoms[1].formalCharge = 1;
    molecule.bonds[0].display = { bondStyle: "wedge" };
    const sdf = exportStructureListSdf(documentWith([molecule])).contents;
    const graph = parseMolfileGraph(sdf.slice(0, sdf.indexOf("> <SMILES>")));
    expect(graph.atoms.map((atom) => ({ x: atom.x, y: atom.y, charge: atom.formalCharge }))).toEqual([
      { x: 20, y: -30, charge: 0 }, { x: 120, y: -130, charge: 1 }
    ]);
    expect(graph.bonds[0].bondStyle).toBe("wedge");
  });

  it("surfaces molfile writer and native SMILES losses with the molecule id", () => {
    const molecule = { ...moleculeAt("lossy", 0, 0), structureFormat: "unknown" as const };
    molecule.atoms[1].element = "Ph";
    molecule.bonds[0].display = { bondStyle: "dashed" };
    const writerWarnings: string[] = [];
    moleculeToMolfileV2000(molecule, { fromDocFrame: true, warnings: writerWarnings });
    expect(writerWarnings).toHaveLength(2);
    const document = documentWith([molecule]);
    const result = exportStructureListSdf(document);
    for (const message of writerWarnings) {
      expect(result.warnings).toContainEqual({
        code: "export.sdf_v2000_loss", message, severity: "warning", objectId: molecule.id
      });
    }
    const smi = exportStructureListSmi(document);
    expect(smi.contents).toBe("C[*]\t1\n");
    expect(smi.warnings.map((warning) => warning.code)).toEqual(["export.smiles_dative_bond", "export.smiles_atom_label"]);
    expect(smi.warnings.every((warning) => warning.objectId === molecule.id)).toBe(true);
  });

  it("returns an empty text result for an empty page", () => {
    const document = createPhase4Document("Empty");
    expect(exportStructureListSdf(document)).toMatchObject({ contents: "", warnings: [] });
    expect(exportStructureListSmi(document)).toMatchObject({ contents: "", warnings: [] });
  });

  it("propagates V2000 size failures rather than omitting an oversized record", () => {
    const molecule = moleculeAt("large", 0, 0);
    molecule.atoms = Array.from({ length: 1000 }, (_, index) => ({
      id: `a${index}`, element: "C", x: index, y: 0, formalCharge: 0
    }));
    molecule.bonds = [];
    expect(() => exportStructureListSdf(documentWith([molecule]))).toThrow("V2000 supports at most 999 atoms");
  });
});
