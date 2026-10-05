import type { ChemDraftDocument } from "@chemdraft/chem-core";
import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { unresolvableAromaticRing } from "@chemdraft/layout-engine/testing";
import { createStructureSourceFingerprint } from "@chemdraft/plugin-api";

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

function documentWithUnknownOrderBond(selection: string[]): ChemDraftDocument {
  const document = documentWith(selection);
  Object.assign(document.pages[0]!.objects[0]!, {
    structure: "",
    atoms: [
      { id: "a1", element: "C", x: 10, y: 20, formalCharge: 0 },
      { id: "a2", element: "O", x: 30, y: 20, formalCharge: 0 }
    ],
    bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "unknown" }]
  });
  return document;
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
  it("preserves unresolved type-4 bonds and surfaces one ring warning to the host", () => {
    const source = documentWith(["m1"]);
    const molecule = source.pages[0]!.objects[0];
    Object.assign(molecule, unresolvableAromaticRing());
    const warnings: string[] = [];
    const snapshot = buildPluginSelectionSnapshot(source, warnings);
    expect(parseMolfileGraph(snapshot.molecules[0]!.structure).bonds.map((bond) => bond.order))
      .toEqual(Array(5).fill("aromatic"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("atoms u0, u1, u2, u3, u4");
    expect(warnings[0]).toContain("preserved as type 4");
  });
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

  it("hands an abbreviated label to the plugin as an R-group, never as a dummy carbon", () => {
    const anisole = {
      id: "m", type: "molecule", structureFormat: "smiles", structure: "",
      atoms: [
        { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a1", element: "OMe", x: 1, y: 0, formalCharge: 0 }
      ],
      bonds: [{ id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" }]
    } as unknown as Parameters<typeof pluginFacingStructure>[0];
    const facing = pluginFacingStructure(anisole);
    expect(facing.structure).toContain(" R# ");
    expect(facing.structure).toContain("M  RGP  1   2   1");
    expect(facing.structure).not.toContain(" *  ");
  });

  it("spells a condensed label with its hydrogens, so the plugin's OpenChemLib reads the molecule drawn", () => {
    const ethanol = {
      id: "m", type: "molecule", structureFormat: "smiles", structure: "",
      atoms: [
        { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a1", element: "C", x: 14, y: 0, formalCharge: 0 },
        { id: "a2", element: "OH", x: 28, y: 0, formalCharge: 0 }
      ],
      bonds: [
        { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" },
        { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }
      ]
    } as unknown as Parameters<typeof pluginFacingStructure>[0];
    const facing = pluginFacingStructure(ethanol);
    expect(facing.structure).not.toContain("R#");
    expect(OCL.Molecule.fromMolfile(facing.structure).getMolecularFormula().formula).toBe("C2H6O");
  });

  it("hands an aromatic-order pyrrole NH over as N–H on its Kekulé orders, never as an NH2", () => {
    // Counted at 1.5 per aromatic bond, the stated hydrogen would ride on a valence of 4, which
    // OpenChemLib honours as an NH2 — a molecule the user did not draw. On the Kekulé orders the
    // ring bonds at N are single, so the valence is 3 and the reader sees pyrrole.
    const ring = ["a0", "a1", "a2", "a3", "a4"];
    const pyrrole = {
      id: "m", type: "molecule", structureFormat: "smiles", structure: "",
      atoms: ring.map((id, i) => ({
        id, element: i === 0 ? "NH" : "C", x: 14 * Math.cos((2 * Math.PI * i) / 5), y: 14 * Math.sin((2 * Math.PI * i) / 5), formalCharge: 0
      })),
      bonds: ring.map((id, i) => ({ id: `b${i}`, fromAtomId: id, toAtomId: ring[(i + 1) % 5], order: "aromatic" }))
    } as unknown as Parameters<typeof pluginFacingStructure>[0];
    const warnings: string[] = [];
    const facing = pluginFacingStructure(pyrrole, warnings);
    expect(facing.structure).not.toContain(" R# ");
    const parsed = OCL.Molecule.fromMolfile(facing.structure);
    expect(parsed.getAllAtoms()).toBe(5);
    expect(parsed.getMolecularFormula().formula).toBe("C4H5N");
    expect(warnings).toEqual([]);
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

  it("keys an empty stored structure from its coordinate-free live graph", () => {
    const source = documentWithUnknownOrderBond(["m1"]);
    const before = buildPluginSelectionSnapshot(source).molecules[0]!.sourceFingerprint;
    expect(computeObjectFingerprint(source, "m1")).toBe(before);

    const elementChanged = documentWithUnknownOrderBond(["m1"]);
    (elementChanged.pages[0]!.objects[0] as { atoms: Array<{ element: string }> }).atoms[1]!.element = "N";
    expect(buildPluginSelectionSnapshot(elementChanged).molecules[0]!.sourceFingerprint).not.toBe(before);

    const bondChanged = documentWithUnknownOrderBond(["m1"]);
    (bondChanged.pages[0]!.objects[0] as { bonds: Array<{ order: string }> }).bonds[0]!.order = "double";
    expect(computeObjectFingerprint(bondChanged, "m1")).not.toBe(before);

    const moved = documentWithUnknownOrderBond(["m1"]);
    (moved.pages[0]!.objects[0] as { atoms: Array<{ x: number; y: number }> }).atoms.forEach((atom) => {
      atom.x += 100;
      atom.y -= 50;
    });
    expect(buildPluginSelectionSnapshot(moved).molecules[0]!.sourceFingerprint).toBe(before);
  });

  it("keeps the existing non-empty structure fingerprint unchanged", () => {
    const document = documentWith(["m1"]);
    const expected = createStructureSourceFingerprint({
      documentId: document.id,
      pageId: document.pages[0]!.id,
      objectId: "m1",
      structureFormat: "smiles",
      structure: "c1ccccc1"
    });
    expect(buildPluginSelectionSnapshot(document).molecules[0]!.sourceFingerprint).toBe(expected);
    expect(computeObjectFingerprint(document, "m1")).toBe(expected);
  });
});
