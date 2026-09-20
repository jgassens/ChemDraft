import { beforeEach, describe, expect, it, vi } from "vitest";
import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { registerRdkitWasmLoader } from "./rdkitWasmLoader";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import {
  createPhase4Document,
  copyAsSmiles,
  insertSmilesMoleculeGrid,
  type PastedStructureDepiction
} from "./documentWorkflow";
import { exportStructureListSdf, exportStructureListSmi, readingOrderMolecules } from "./structureListExport";

vi.mock("@chemdraft/rdkit-adapter/identifiers", () => ({ computeStructureIdentifiers: vi.fn() }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

beforeEach(() => {
  vi.mocked(computeStructureIdentifiers).mockReset().mockResolvedValue(undefined);
  vi.mocked(registerRdkitWasmLoader).mockReset();
});

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

const exportListCases = [
  { format: "SDF", exportList: exportStructureListSdf },
  { format: "SMI", exportList: exportStructureListSmi }
];

describe("structure list export", () => {
  it.each(exportListCases)("uses RDKit SMILES from the current wedged graph ($format)", async ({ exportList }) => {
    const molecule = moleculeAt("stereo", 20, 30);
    molecule.bonds[0].display = { bondStyle: "wedge" };
    const other = moleculeAt("other", 220, 30);
    const document = documentWith([other, molecule]);
    const before = structuredClone(document);
    vi.mocked(computeStructureIdentifiers)
      .mockResolvedValueOnce({ smiles: "C[C@H](F)Cl" })
      .mockResolvedValueOnce({ smiles: "F/C=C/F" });

    const result = await exportList(document);
    expect(result.contents).toContain("C[C@H](F)Cl");
    expect(result.contents).toContain("F/C=C/F");
    expect(result.warnings).toEqual([]);
    expect(registerRdkitWasmLoader).toHaveBeenCalledOnce();
    expect(computeStructureIdentifiers).toHaveBeenCalledTimes(2);
    expect(computeStructureIdentifiers).toHaveBeenNthCalledWith(1, moleculeToMolfileV2000(molecule, { fromDocFrame: true }));
    expect(computeStructureIdentifiers).toHaveBeenNthCalledWith(2, moleculeToMolfileV2000(other, { fromDocFrame: true }));
    expect(document).toEqual(before);
  });

  it.each(exportListCases)("warns only for wedge/hashed molecules when RDKit cannot supply SMILES ($format)", async ({ exportList }) => {
    const plain = moleculeAt("plain", 0, 0);
    const wedge = { ...moleculeAt("wedge", 200, 0), structureFormat: "unknown" as const };
    wedge.bonds[0].display = { bondStyle: "wedge" };
    const hashed = moleculeAt("hashed", 400, 0);
    hashed.bonds[0].display = { bondStyle: "hashed" };
    const document = documentWith([hashed, wedge, plain]);

    for (const failure of ["missing-smiles", "unparseable", "engine-error", "loader-error"] as const) {
      vi.mocked(registerRdkitWasmLoader).mockReset();
      vi.mocked(computeStructureIdentifiers).mockReset().mockResolvedValue(
        failure === "missing-smiles" ? {} : undefined
      );
      if (failure === "engine-error") {
        vi.mocked(computeStructureIdentifiers).mockRejectedValue(new Error("WASM unavailable"));
      } else if (failure === "loader-error") {
        vi.mocked(registerRdkitWasmLoader).mockImplementation(() => { throw new Error("Loader unavailable"); });
      }

      const result = await exportList(document);
      expect(result.warnings).toEqual([wedge, hashed].map((molecule, index) => ({
        code: "export.smiles_stereo_dropped",
        message: `Stereochemistry could not be written to SMILES for molecule ${index + 2}; the structure engine was unavailable.`,
        severity: "warning",
        objectId: molecule.id
      })));
      if (result.format === "smiles") {
        expect(result.contents).toBe("CC\t1\nCC\t2\nCC\t3\n");
      } else {
        expect([...result.contents.matchAll(/> <SMILES>\n([^\n]+)/g)].map((match) => match[1])).toEqual(["CC", "CC", "CC"]);
      }
      if (failure === "loader-error") expect(computeStructureIdentifiers).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])("exports six pasted grid molecules in paste order (selection: %s)", async (selected) => {
    const { document, entries } = pastedGrid();
    if (!selected) document.selection.objectIds = [];
    const before = structuredClone(document);
    const sdf = await exportStructureListSdf(document, {});
    const smi = await exportStructureListSmi(document);
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

  it("exports only selected molecules, numbered in reading order from one", async () => {
    const { document, entries, objectIds } = pastedGrid();
    document.selection.objectIds = [objectIds[4], objectIds[1]];
    expect((await exportStructureListSmi(document)).contents).toBe(`${entries[1].smiles}\t1\n${entries[4].smiles}\t2\n`);
    const sdf = (await exportStructureListSdf(document)).contents;
    expect(sdf.match(/^\$\$\$\$$/gm)).toHaveLength(2);
    expect([...sdf.matchAll(/> <SMILES>\n([^\n]+)/g)].map((match) => match[1])).toEqual([entries[1].smiles, entries[4].smiles]);
    expect([...sdf.matchAll(/> <Index>\n(\d+)/g)].map((match) => match[1])).toEqual(["1", "2"]);
  });

  it("does not fall back to the page for selections without editable molecules", async () => {
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
      expect((await exportStructureListSmi(document)).contents).toBe("");
      expect((await exportStructureListSdf(document)).contents).toBe("");
    }
    document.selection.objectIds = [];
    expect((await exportStructureListSmi(document)).contents).toBe("CC\t1\n");
    expect((await exportStructureListSdf(document)).contents.match(/^\$\$\$\$$/gm)).toHaveLength(1);
  });

  it("falls back to stored SMILES and the native graph when the engine returns no identifiers", async () => {
    const stored = { ...moleculeAt("stored", 0, 0), structure: "C(C)" };
    const native = { ...moleculeAt("native", 200, 0), structureFormat: "unknown" as const, structure: "stale" };
    native.atoms[1].element = "O";
    const document = documentWith([native, stored]);
    expect((await exportStructureListSmi(document)).contents).toBe("C(C)\t1\nCO\t2\n");
    expect([...(await exportStructureListSdf(document)).contents.matchAll(/> <SMILES>\n([^\n]+)/g)].map((match) => match[1])).toEqual(["C(C)", "CO"]);
  });

  it("uses a nonempty source molfile title as the name and omits names for blank titles", async () => {
    const named = { ...moleculeAt("named", 0, 0), structureFormat: "molfile-v2000" as const };
    named.structure = `  Ethane\tstandard  ${moleculeToMolfileV2000(named)}`.replace(/\n/g, "\r\n");
    const unnamed = { ...moleculeAt("unnamed", 200, 0), structureFormat: "molfile-v2000" as const };
    unnamed.structure = ` \t ${moleculeToMolfileV2000(unnamed)}`;
    const document = documentWith([unnamed, named]);
    expect((await exportStructureListSmi(document)).contents).toBe("CC\tEthane standard\nCC\t2\n");
    const records = (await exportStructureListSdf(document)).contents.split("$$$$\n");
    expect(records[0]).toMatch(/^Ethane standard\n/);
    expect(records[0]).toContain("> <Name>\nEthane standard\n\n");
    expect(records[1]).toMatch(/^ChemDraft molecule 2\n/);
    expect(records[1]).not.toContain("> <Name>");
  });

  it("preserves the V2000 writer's document-frame coordinates, charges and wedge flags", async () => {
    const molecule = moleculeAt("stereo", 20, 30);
    molecule.atoms[1].element = "N";
    molecule.atoms[1].formalCharge = 1;
    molecule.bonds[0].display = { bondStyle: "wedge" };
    const sdf = (await exportStructureListSdf(documentWith([molecule]))).contents;
    const graph = parseMolfileGraph(sdf.slice(0, sdf.indexOf("> <SMILES>")));
    expect(graph.atoms.map((atom) => ({ x: atom.x, y: atom.y, charge: atom.formalCharge }))).toEqual([
      { x: 20, y: -30, charge: 0 }, { x: 120, y: -130, charge: 1 }
    ]);
    expect(graph.bonds[0].bondStyle).toBe("wedge");
  });

  it("surfaces molfile writer and native SMILES losses with the molecule id", async () => {
    const molecule = { ...moleculeAt("lossy", 0, 0), structureFormat: "unknown" as const };
    molecule.atoms[1].element = "Ph";
    molecule.bonds[0].display = { bondStyle: "dashed" };
    const writerWarnings: string[] = [];
    moleculeToMolfileV2000(molecule, { fromDocFrame: true, warnings: writerWarnings });
    expect(writerWarnings).toHaveLength(2);
    const document = documentWith([molecule]);
    const result = await exportStructureListSdf(document);
    for (const message of writerWarnings) {
      expect(result.warnings).toContainEqual({
        code: "export.sdf_v2000_loss", message, severity: "warning", objectId: molecule.id
      });
    }
    const smi = await exportStructureListSmi(document);
    expect(smi.contents).toBe("C[*]\t1\n");
    expect(smi.warnings.map((warning) => warning.code)).toEqual(["export.smiles_dative_bond", "export.smiles_atom_label"]);
    expect(smi.warnings.every((warning) => warning.objectId === molecule.id)).toBe(true);
  });

  it("reports an unknown-order bond on both the engine and native routes", async () => {
    const molecule = { ...moleculeAt("unknown-bond", 0, 0), structureFormat: "unknown" as const };
    molecule.bonds[0].order = "unknown";
    const document = documentWith([molecule]);
    const native = await exportStructureListSmi(document);
    expect(native.contents).toBe("CC\t1\n");
    expect(native.warnings).toEqual([{
      code: "export.smiles_bond_order",
      message: "1 bond of unknown order written to SMILES as single.",
      severity: "warning",
      objectId: molecule.id
    }]);
    vi.mocked(computeStructureIdentifiers).mockResolvedValueOnce({ smiles: "CC" });
    const engine = await exportStructureListSmi(document);
    expect(engine.warnings.map((warning) => warning.code)).toEqual(["export.smiles_bond_order"]);
  });

  it("reports an unresolvable aromatic system only when the native writer produced the SMILES", async () => {
    const molecule = { ...moleculeAt("odd-aromatic", 0, 0), structureFormat: "unknown" as const };
    molecule.atoms = ["a1", "a2", "a3", "a4", "a5"].map((id, index) => ({ id, element: "C", x: index * 10, y: 0, formalCharge: 0 }));
    molecule.bonds = molecule.atoms.map((atom, index) => ({
      id: `b${index}`, fromAtomId: atom.id, toAtomId: molecule.atoms[(index + 1) % 5].id, order: "aromatic" as const
    }));
    const document = documentWith([molecule]);
    const native = await exportStructureListSmi(document);
    expect(native.warnings.map((warning) => warning.code)).toEqual(["export.smiles_bond_order"]);
    expect(native.warnings[0].message).toContain("5 aromatic bonds could not be resolved");
    // RDKit reads the molfile's type-4 bonds itself: no downgrade happened, so no warning.
    vi.mocked(computeStructureIdentifiers).mockResolvedValueOnce({ smiles: "c1cccc1" });
    const engine = await exportStructureListSmi(document);
    expect(engine.warnings).toEqual([]);
  });

  it("returns an empty text result for an empty page", async () => {
    const document = createPhase4Document("Empty");
    expect(await exportStructureListSdf(document)).toMatchObject({ contents: "", warnings: [] });
    expect(await exportStructureListSmi(document)).toMatchObject({ contents: "", warnings: [] });
  });

  it("propagates V2000 size failures rather than omitting an oversized record", async () => {
    const molecule = moleculeAt("large", 0, 0);
    molecule.atoms = Array.from({ length: 1000 }, (_, index) => ({
      id: `a${index}`, element: "C", x: index, y: 0, formalCharge: 0
    }));
    molecule.bonds = [];
    await expect(exportStructureListSdf(documentWith([molecule]))).rejects.toThrow("V2000 supports at most 999 atoms");
  });
});

describe("SMILES export review regressions", () => {
  it("surfaces V2000 label loss in a .smi export even when RDKit returns SMILES", async () => {
    const molecule = moleculeAt("condensed", 0, 0);
    molecule.atoms[1].element = "NH2";
    vi.mocked(computeStructureIdentifiers).mockResolvedValue({ smiles: "*C" });
    const result = await exportStructureListSmi(documentWith([molecule]));
    expect(result.contents).toBe("*C\t1\n");
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "export.smiles_v2000_loss", objectId: molecule.id, message: expect.stringContaining("NH2")
    }));
  });

  it.each(exportListCases)("warns for substituted double-bond stereo in native fallback ($format)", async ({ exportList }) => {
    const molecule = moleculeAt("alkene", 0, 0);
    molecule.atoms = ["F", "C", "C", "F"].map((element, index) => ({
      id: `a${index}`, element, x: index * 30, y: index === 0 ? -30 : index === 3 ? 30 : 0, formalCharge: 0
    }));
    molecule.bonds = ["single", "double", "single"].map((order, index) => ({
      id: `b${index}`, fromAtomId: `a${index}`, toAtomId: `a${index + 1}`, order: order as "single" | "double"
    }));
    molecule.structureFormat = "unknown";
    molecule.structure = "";
    const result = await exportList(documentWith([molecule]));
    expect(result.contents).toContain("FC=CF");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "export.smiles_stereo_dropped", objectId: molecule.id }));
    molecule.atoms[0].element = "H";
    expect((await exportList(documentWith([molecule]))).warnings).toEqual([]);
  });

  it("does not call a dashed double bond dative when copying SMILES", async () => {
    const molecule = moleculeAt("carbonyl", 0, 0);
    molecule.atoms[1].element = "O";
    molecule.bonds[0] = { ...molecule.bonds[0], order: "double", display: { bondStyle: "dashed" } };
    molecule.structureFormat = "unknown";
    const warnings: string[] = [];
    expect(await copyAsSmiles(documentWith([molecule]), warnings)).toBe("C=O");
    expect(warnings).toEqual([]);
  });

  it("uses the RDKit stereo SMILES for Copy As and warns when it must fall back", async () => {
    const molecule = moleculeAt("wedged", 0, 0);
    molecule.bonds[0].display = { bondStyle: "wedge" };
    const document = documentWith([molecule]);
    vi.mocked(computeStructureIdentifiers).mockResolvedValue({ smiles: "C[C@H](F)Cl" });
    const warnings: string[] = [];
    expect(await copyAsSmiles(document, warnings)).toBe("C[C@H](F)Cl");
    expect(warnings).toEqual([]);
    vi.mocked(computeStructureIdentifiers).mockRejectedValue(new Error("WASM unavailable"));
    expect(await copyAsSmiles(document, warnings)).toBe("CC");
    expect(warnings).toEqual([expect.stringContaining("Stereochemistry could not be written")]);
  });

  it("exports a literal singly bonded N without adding hydrogen through real RDKit", async () => {
    const { installRealRdkitModuleLoader } = await import("../../../packages/rdkit-adapter/src/testing");
    const { ensureRdkit, resetRdkitForTesting } = await import("../../../packages/rdkit-adapter/src/conformer");
    const real = await vi.importActual<typeof import("@chemdraft/rdkit-adapter/identifiers")>("@chemdraft/rdkit-adapter/identifiers");
    installRealRdkitModuleLoader();
    vi.mocked(computeStructureIdentifiers).mockImplementation(real.computeStructureIdentifiers);
    try {
      const molecule = moleculeAt("literal", 0, 0);
      molecule.atoms[1] = { ...molecule.atoms[1], element: "N", labelLiteral: true };
      const result = await exportStructureListSmi(documentWith([molecule]));
      expect(result.warnings).toEqual([]);
      const rdkit = await ensureRdkit();
      const parsed = rdkit.get_mol(result.contents.split("\t")[0])!;
      try {
        expect(parsed.get_smiles?.()).toBe("C[N]");
      } finally {
        parsed.delete();
      }
    } finally {
      resetRdkitForTesting();
    }
  });
});
