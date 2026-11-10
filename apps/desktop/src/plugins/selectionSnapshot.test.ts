import { adoptDerivedDocument, applyPatch, createEmptyDocument, type ChemDraftDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import * as OCL from "openchemlib";
import { describe, expect, it, vi } from "vitest";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { unresolvableAromaticRing } from "@chemdraft/layout-engine/testing";
import { createStructureSourceFingerprint } from "@chemdraft/plugin-api";
import * as pluginApi from "@chemdraft/plugin-api";

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

function moleculeWithHydrogen(): MoleculeObject {
  return {
    id: "m1", type: "molecule", structureFormat: "smiles", structure: "[H]C",
    atoms: [
      { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "a2", element: "H", x: 14, y: 0, formalCharge: 0 }
    ],
    bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }]
  } as MoleculeObject;
}

function engineDocumentWith(molecule = moleculeWithHydrogen()): ChemDraftDocument {
  return applyPatch(createEmptyDocument({ id: "doc1", pageId: "p1" }), {
    op: "batch",
    patches: [
      { op: "addObject", pageId: "p1", object: { ...molecule, x: 0, y: 0, width: 14, height: 1 } },
      { op: "setSelection", objectIds: [molecule.id] }
    ]
  });
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
  describe.each([
    { name: "D", atom: { element: "D" }, symbol: "D", mass: 2 },
    { name: "H with isotope 2", atom: { element: "H", isotope: 2 }, symbol: "H", mass: 2 },
    { name: "T", atom: { element: "T" }, symbol: "T", mass: 3 }
  ])("$name", ({ atom, symbol, mass }) => {
    it.each([false, true])("preserves the isotope and its bond with abbreviation expansion %s", (expand) => {
      const molecule = moleculeWithHydrogen();
      Object.assign(molecule.atoms[1]!, atom);
      if (expand) {
        molecule.atoms.push({ id: "a3", element: "OMe", x: -14, y: 0, formalCharge: 0 });
        molecule.bonds.push({ id: "b2", fromAtomId: "a1", toAtomId: "a3", order: "single" });
      }
      const document = documentWith([molecule.id]);
      document.pages[0]!.objects[0] = molecule;
      const warnings: string[] = [];
      const facing = pluginFacingStructure(molecule, warnings);
      expect(buildPluginSelectionSnapshot(document).molecules[0]!.structure).toBe(facing.structure);
      expect(facing.structureFormat).toBe("molfile-v2000");
      const lines = facing.structure.split("\n");
      const atomCount = expand ? 4 : 2;
      const bondCount = expand ? 3 : 1;
      expect(Number(lines[3]!.slice(0, 3))).toBe(atomCount);
      expect(Number(lines[3]!.slice(3, 6))).toBe(bondCount);
      expect(lines.slice(4, 4 + atomCount).map((line) => line.slice(31, 34).trim()))
        .toEqual(expand ? ["C", symbol, "O", "C"] : ["C", symbol]);
      if (symbol === "H") expect(facing.structure).toContain("M  ISO  1   2   2");
      expect(lines.slice(4 + atomCount, 4 + atomCount + bondCount).map((line) => [
        Number(line.slice(0, 3)), Number(line.slice(3, 6)), Number(line.slice(6, 9))
      ])).toEqual(expand ? [[1, 2, 1], [1, 3, 1], [3, 4, 1]] : [[1, 2, 1]]);
      // Read exactly what the plugin receives: the explicit hydrogen remains bonded and heavy.
      const parsed = OCL.Molecule.fromMolfile(facing.structure);
      expect(parsed.getAllAtoms()).toBe(atomCount);
      expect(parsed.getAllBonds()).toBe(bondCount);
      expect(parsed.getAtomicNo(1)).toBe(1);
      expect(parsed.getAtomMass(1)).toBe(mass);
      expect(warnings).toEqual([]);
    });
  });

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

  it("hands an abbreviation over as its atoms, and any other label as an R-group, never a dummy carbon", () => {
    const withLabel = (label: string) => ({
      id: "m", type: "molecule", structureFormat: "smiles", structure: "",
      atoms: [
        { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a1", element: label, x: 1, y: 0, formalCharge: 0 }
      ],
      bonds: [{ id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" }]
    }) as unknown as Parameters<typeof pluginFacingStructure>[0];

    // Dimethyl ether: the plugin's OpenChemLib reads O and C, appended after the drawn atoms.
    const methoxy = pluginFacingStructure(withLabel("OMe")).structure.split("\n");
    expect(methoxy[3]).toContain("  3  2  0");
    expect(methoxy.slice(4, 7).map((line) => line.slice(31, 34).trim())).toEqual(["C", "O", "C"]);
    expect(methoxy.join("\n")).not.toContain("R#");

    // Case matters: "Ome" is text, handed over as an honest R-group placeholder.
    const text = pluginFacingStructure(withLabel("Ome")).structure;
    expect(text).toContain(" R# ");
    expect(text).toContain("M  RGP  1   2   1");
    expect(text).not.toContain(" *  ");
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
  it.each([2, 5000])("hashes an unchanged %i-atom molecule once across repeated renders and selection changes", (size) => {
    const molecule = moleculeWithHydrogen();
    molecule.atoms = Array.from({ length: size }, (_, i) => ({ id: `a${i}`, element: "C", x: i, y: 0, formalCharge: 0 }));
    molecule.bonds = Array.from({ length: size - 1 }, (_, i) => ({
      id: `b${i}`, fromAtomId: `a${i}`, toAtomId: `a${i + 1}`, order: "single"
    }));
    const document = engineDocumentWith(molecule);
    const hash = vi.spyOn(pluginApi, "createStructureSourceFingerprint");
    try {
      const before = computeObjectFingerprint(document, molecule.id);
      expect(hash).toHaveBeenCalledTimes(1);
      for (let render = 0; render < 100; render++) {
        expect(computeObjectFingerprint(document, molecule.id)).toBe(before);
      }
      const deselected = applyPatch(document, { op: "setSelection", objectIds: [] });
      expect(deselected.pages[0]!.objects[0]).toBe(document.pages[0]!.objects[0]);
      expect(computeObjectFingerprint(deselected, molecule.id)).toBe(before);
      // Deterministic work assertion for the large graph; no wall-clock threshold.
      expect(hash).toHaveBeenCalledTimes(1);
      if (size === 2) {
        expect(buildPluginSelectionSnapshot(document).molecules[0]!.sourceFingerprint).toBe(before);
        expect(hash).toHaveBeenCalledTimes(1);
      }
    } finally {
      hash.mockRestore();
    }
  });

  it.each<[string, (molecule: MoleculeObject) => Partial<MoleculeObject>]>([
    ["isotope", m => ({ atoms: m.atoms.map((a, i) => i === 0 ? { ...a, isotope: 13 } : a) })],
    ["charge", m => ({ atoms: m.atoms.map((a, i) => i === 0 ? { ...a, formalCharge: 1 } : a) })],
    ["radical", m => ({ atoms: m.atoms.map((a, i) => i === 0 ? { ...a, markRadicals: 1 } : a) })],
    ["bond", m => ({ bonds: m.bonds.map(b => ({ ...b, order: "double" })) })],
    ["superatom", () => ({ superatoms: [{ label: "Ph", expandedStructureFormat: "smiles", expandedStructure: "c1ccccc1", attachmentPoints: [], warnings: [] }] })],
    ["R-group", () => ({ rGroups: [{ label: "R1", querySemantics: "query", attachmentPoints: [], warnings: [] }] })],
    ["label", m => ({ atoms: m.atoms.map(a => ({ ...a, element: "OMe" })) })],
    ["label bond side", m => ({ atoms: m.atoms.map(a => ({ ...a, labelBondSide: { side: "right", atomId: "a1" } })) })],
    ["chemistry", () => ({ chemistry: { formula: "CH4", isotopeLabels: [], stereochemistry: [], warnings: [] } })]
  ])("invalidates the cache after an immutable %s patch", (_name, changes) => {
    const document = engineDocumentWith();
    const molecule = document.pages[0]!.objects[0] as MoleculeObject;
    const before = computeObjectFingerprint(document, molecule.id);
    const edited = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: changes(molecule) });
    expect(edited.pages[0]!.objects[0]).not.toBe(molecule);
    expect(Object.isFrozen(molecule.atoms[0])).toBe(true);
    expect(computeObjectFingerprint(edited, molecule.id)).not.toBe(before);
    expect(computeObjectFingerprint(document, molecule.id)).toBe(before);
  });

  it("keeps coordinate-only and no-op patches equal after warming the cache", () => {
    const document = engineDocumentWith();
    const molecule = document.pages[0]!.objects[0] as MoleculeObject;
    const before = computeObjectFingerprint(document, molecule.id);
    for (const changes of [{}, {
      atoms: molecule.atoms.map(a => ({ ...a, x: a.x + 100, y: a.y - 50, z: 10, labelOffset: { x: 3, y: 4 } }))
    }]) {
      const edited = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes });
      expect(edited.pages[0]!.objects[0]).not.toBe(molecule);
      expect(computeObjectFingerprint(edited, molecule.id)).toBe(before);
    }
  });

  it("includes document and page identity when a molecule object is shared", () => {
    const document = engineDocumentWith();
    const before = computeObjectFingerprint(document, "m1");
    const otherDocument = adoptDerivedDocument(document, { ...document, id: "other" });
    const otherPage = adoptDerivedDocument(document, {
      ...document,
      pages: document.pages.map(page => ({ ...page, id: "other" })),
      selection: { ...document.selection, pageId: "other" }
    });
    for (const moved of [otherDocument, otherPage]) {
      expect(moved.pages[0]!.objects[0]).toBe(document.pages[0]!.objects[0]);
      expect(computeObjectFingerprint(moved, "m1")).not.toBe(before);
      expect(computeObjectFingerprint(moved, "m1")).toBe(computeObjectFingerprint({ ...moved }, "m1"));
    }
    expect(computeObjectFingerprint(document, "m1")).toBe(before);
  });

  it.each<[string, number, Partial<MoleculeAtom>]>([
    ["H to D", 1, { element: "D" }],
    ["carbon isotope 13", 0, { isotope: 13 }],
    ["charge only", 0, { formalCharge: 1 }],
    ["radical only", 0, { markRadicals: 1 }]
  ])("stales a report after a %s edit even when stored text is unchanged", (_name, atomIndex, edit) => {
    const document = documentWith(["m1"]);
    const molecule = moleculeWithHydrogen();
    document.pages[0]!.objects[0] = molecule;
    const before = buildPluginSelectionSnapshot(document).molecules[0]!;
    expect(computeObjectFingerprint(document, "m1")).toBe(before.sourceFingerprint);
    expect(buildPluginSelectionSnapshot(structuredClone(document)).molecules[0]!.sourceFingerprint)
      .toBe(before.sourceFingerprint);

    Object.assign(molecule.atoms[atomIndex]!, edit);
    expect(molecule.structure).toBe("[H]C");
    const after = buildPluginSelectionSnapshot(document).molecules[0]!;
    expect(after.structure).not.toBe(before.structure);
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(computeObjectFingerprint(document, "m1")).toBe(after.sourceFingerprint);
  });

  it("keeps a live-graph fingerprint stable when only coordinates change", () => {
    const document = documentWith(["m1"]);
    const molecule = moleculeWithHydrogen();
    document.pages[0]!.objects[0] = molecule;
    const before = computeObjectFingerprint(document, "m1");
    molecule.atoms.forEach((atom) => { atom.x += 100; atom.y -= 50; });
    expect(computeObjectFingerprint(document, "m1")).toBe(before);
    expect(buildPluginSelectionSnapshot(document).molecules[0]!.sourceFingerprint).toBe(before);
  });

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

    const superatomChanged = documentWithUnknownOrderBond(["m1"]);
    Object.assign(superatomChanged.pages[0]!.objects[0]!, {
      superatoms: [{ label: "Ph", expandedStructureFormat: "smiles", expandedStructure: "c1ccccc1" }]
    });
    expect(computeObjectFingerprint(superatomChanged, "m1")).not.toBe(before);

    const rGroupChanged = documentWithUnknownOrderBond(["m1"]);
    Object.assign(rGroupChanged.pages[0]!.objects[0]!, {
      rGroups: [{ label: "R1", querySemantics: "query" }]
    });
    expect(computeObjectFingerprint(rGroupChanged, "m1")).not.toBe(before);

    const chemistryChanged = documentWithUnknownOrderBond(["m1"]);
    Object.assign(chemistryChanged.pages[0]!.objects[0]!, { chemistry: { formula: "CO" } });
    expect(computeObjectFingerprint(chemistryChanged, "m1")).not.toBe(before);

    const moved = documentWithUnknownOrderBond(["m1"]);
    (moved.pages[0]!.objects[0] as { atoms: Array<{ x: number; y: number }> }).atoms.forEach((atom) => {
      atom.x += 100;
      atom.y -= 50;
    });
    expect(buildPluginSelectionSnapshot(moved).molecules[0]!.sourceFingerprint).toBe(before);

    // A label's recorded bond side decides what a cyano label means, so a plugin result computed
    // for the other side is stale.
    const sideRecorded = documentWithUnknownOrderBond(["m1"]);
    const sideAtoms = (sideRecorded.pages[0]!.objects[0] as { atoms: Array<{ id: string; labelBondSide?: unknown }> }).atoms;
    sideAtoms[1]!.labelBondSide = { side: "right", atomId: sideAtoms[0]!.id };
    expect(computeObjectFingerprint(sideRecorded, "m1")).not.toBe(before);
  });

  it("keys a recorded label bond side alongside a non-empty stored structure", () => {
    // The stored SMILES need not show which side a cyano label was written with, so the record is
    // included in the live graph key.
    const withAtoms = () => {
      const document = documentWith(["m1"]);
      Object.assign(document.pages[0]!.objects[0]!, {
        atoms: [
          { id: "a1", element: "SCN", x: 30, y: 20, formalCharge: 0 },
          { id: "a2", element: "C", x: 10, y: 20, formalCharge: 0 }
        ],
        bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }]
      });
      return document;
    };
    const before = computeObjectFingerprint(withAtoms(), "m1");
    const recorded = withAtoms();
    const atoms = (recorded.pages[0]!.objects[0] as { atoms: Array<{ id: string; labelBondSide?: unknown }> }).atoms;
    atoms[0]!.labelBondSide = { side: "left", atomId: atoms[1]!.id };
    const left = computeObjectFingerprint(recorded, "m1");
    atoms[0]!.labelBondSide = { side: "right", atomId: atoms[1]!.id };
    const right = computeObjectFingerprint(recorded, "m1");
    expect((recorded.pages[0]!.objects[0] as { structure: string }).structure).not.toBe("");
    expect(left).not.toBe(before);
    expect(right).not.toBe(left);
    expect(buildPluginSelectionSnapshot(recorded).molecules[0]!.sourceFingerprint).toBe(right);
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
