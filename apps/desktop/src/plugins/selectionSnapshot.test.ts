import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";

import { buildPluginSelectionSnapshot, computeObjectFingerprint, pluginFacingStructure } from "./selectionSnapshot";

// Minimal document shape exercised by buildPluginSelectionSnapshot (id, pages[].id, page.objects,
// object.type/id/structureFormat/structure, selection.objectIds). Cast to the full type for focus.
function documentWith(selection: string[]): ChemDraftDocument {
  return {
    id: "doc1",
    selection: { objectIds: selection },
    pages: [
      {
        id: "p1",
        objects: [
          { id: "m1", type: "molecule", structureFormat: "smiles", structure: "c1ccccc1" },
          { id: "t1", type: "text", text: "note" },
          { id: "m2", type: "molecule", structureFormat: "molfile-v2000", structure: "mol block" }
        ]
      }
    ]
  } as unknown as ChemDraftDocument;
}

describe("buildPluginSelectionSnapshot", () => {
  it("maps selected molecules with identity, format, and a source fingerprint, in selection order", () => {
    const snapshot = buildPluginSelectionSnapshot(documentWith(["m2", "m1"]));

    expect(snapshot.objectIds).toEqual(["m2", "m1"]);
    expect(snapshot.molecules.map((molecule) => molecule.objectId)).toEqual(["m2", "m1"]);

    const [first] = snapshot.molecules;
    expect(first).toMatchObject({
      objectId: "m2",
      documentId: "doc1",
      pageId: "p1",
      structureFormat: "molfile-v2000",
      structure: "mol block"
    });
    expect(first.sourceFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("excludes unselected objects and non-molecules", () => {
    const snapshot = buildPluginSelectionSnapshot(documentWith(["m1", "t1"]));
    expect(snapshot.molecules.map((molecule) => molecule.objectId)).toEqual(["m1"]);
  });

  it("produces a stable fingerprint for unchanged input and a different one after an edit", () => {
    const before = buildPluginSelectionSnapshot(documentWith(["m1"])).molecules[0].sourceFingerprint;
    const again = buildPluginSelectionSnapshot(documentWith(["m1"])).molecules[0].sourceFingerprint;
    expect(again).toBe(before);

    const edited = documentWith(["m1"]);
    (edited.pages[0].objects[0] as { structure: string }).structure = "CCO";
    expect(buildPluginSelectionSnapshot(edited).molecules[0].sourceFingerprint).not.toBe(before);
  });
});

describe("pluginFacingStructure", () => {
  // Fused bicyclic (naphthalene skeleton): the hand-rolled SMILES writer collapses this to a bare
  // atom concatenation that OCL reads as a straight-chain alkane. The molfile keeps the real graph.
  const naphthalene = {
    id: "m",
    type: "molecule",
    structureFormat: "smiles",
    structure: "CCCCCCCCCC", // what the lossy writer produced — decane, the bug
    atoms: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, element: "C", x: i, y: i % 2, formalCharge: 0 })),
    bonds: [
      [0, 1, "double"], [1, 2, "single"], [2, 3, "double"], [3, 4, "single"], [4, 5, "single"],
      [5, 6, "double"], [6, 7, "single"], [7, 8, "double"], [8, 9, "single"], [9, 0, "single"], [4, 9, "double"]
    ].map(([f, t, order], i) => ({ id: `b${i}`, fromAtomId: `a${f}`, toAtomId: `a${t}`, order }))
  } as unknown as Parameters<typeof pluginFacingStructure>[0];

  it("serializes a live atom/bond graph to a lossless V2000 molfile, not the lossy structure string", () => {
    const facing = pluginFacingStructure(naphthalene);
    expect(facing.structureFormat).toBe("molfile-v2000");
    expect(facing.structure).toContain("V2000");
    expect(facing.structure).toContain("M  END");
    // V2000 counts line declares 10 atoms + 11 bonds; and it is NOT the collapsed SMILES.
    expect(facing.structure).not.toBe("CCCCCCCCCC");
    expect(facing.structure).toContain(" 10 11  0  0");
  });

  it("passes through the existing structure when there is no atom graph (e.g. a SMILES import)", () => {
    expect(pluginFacingStructure({ structureFormat: "smiles", structure: "c1ccccc1", atoms: [] } as never)).toEqual({
      structureFormat: "smiles",
      structure: "c1ccccc1"
    });
  });

  it("is used by buildPluginSelectionSnapshot so graph-bearing molecules reach the plugin as molfiles", () => {
    const document = {
      id: "doc",
      selection: { objectIds: ["m"] },
      pages: [{ id: "p", objects: [naphthalene] }]
    } as unknown as ChemDraftDocument;
    const molecule = buildPluginSelectionSnapshot(document).molecules[0];
    expect(molecule.structureFormat).toBe("molfile-v2000");
    expect(molecule.structure).toContain("M  END");
  });
});

describe("computeObjectFingerprint", () => {
  it("matches the selection snapshot fingerprint for the same object (regardless of selection)", () => {
    const selected = buildPluginSelectionSnapshot(documentWith(["m1"])).molecules[0];
    expect(computeObjectFingerprint(documentWith([]), "m1")).toBe(selected.sourceFingerprint);
  });

  it("changes after an edit and is undefined for a missing object", () => {
    const before = computeObjectFingerprint(documentWith([]), "m1");
    const edited = documentWith([]);
    (edited.pages[0].objects[0] as { structure: string }).structure = "CCO";
    expect(computeObjectFingerprint(edited, "m1")).not.toBe(before);
    expect(computeObjectFingerprint(documentWith([]), "does-not-exist")).toBeUndefined();
  });
});
