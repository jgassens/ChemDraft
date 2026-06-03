import { describe, expect, it } from "vitest";
import { applyPatches, type ChemDraftDocument, type ElectronMarkObject, type MoleculeObject, type TextObject } from "@chemdraft/chem-core";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import {
  applyChargeToolAtPoint,
  applyClipboardPastePayload,
  applyChargeToolAtNativeAtom,
  applyAnalysisToSelectedMolecule,
  applyEditorSaveResultToSelectedMolecule,
  applyEditorSaveResultToSelectedObject,
  applyFreeformSingleBondToolAtPoint,
  applyNativeAtomElementTarget,
  applyNativeDoubleBondSideTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeDeleteTarget,
  applySingleBondToolAtPoint,
  applySingleBondToolAtNativeAtom,
  createNativeSavePayload,
  createNativeSingleBondMolecule,
  createPhase4Document,
  exportPhase4Svg,
  findNativeMoleculeDeleteHit,
  findNativeMoleculeAtomHit,
  getSelectedMolecule,
  insertAdapterFallbackMolecule,
  insertNativeTextObject,
  insertNativeMolfileMolecule,
  insertNativeSingleBondMolecule,
  getSelectedTextObject,
  nativeAtomHitRadiusPx,
  nativeAtomDisplayLabel,
  nativeBondLengthPx,
  nativeChargeAssociationRadiusPx,
  nativeChargeAssociationsForMolecule,
  nativeChargeByAtomIdFromAssociations,
  nativeChargeMarkCenter,
  nativeChargeMarkSizePx,
  nativeChargePlacementPointForAtom,
  nativeElementFromAtomLabel,
  nativeElementFromKeyboardKey,
  normalizeNativeAtomElementLabel,
  nativeMoleculeInvalidAtomStates,
  openNativeDocument,
  previewNativeMoleculeBondGrowth,
  previewNativeMoleculeFreeformBondGrowth,
  moveDocumentObject,
  moveNativeMoleculeParts,
  nativeTextObjectMinimumDimensions,
  nativeTextObjectSizeForText,
  reorderNativeMoleculeParts,
  reorderSelectedDocumentObject,
  resizeNativeTextObjectBox,
  updateNativeTextObjectStyle,
  updateNativeTextObjectText
} from "./documentWorkflow";

function selectedMolecule(document: ChemDraftDocument): MoleculeObject {
  const molecule = getSelectedMolecule(document);
  if (!molecule) {
    throw new Error("Expected selected molecule.");
  }
  return molecule;
}

function growFromAtom(document: ChemDraftDocument, atomId: string, angleDegrees: number): ChemDraftDocument {
  const molecule = selectedMolecule(document);
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  if (!atom) {
    throw new Error(`Expected atom "${atomId}".`);
  }

  const steerDistance = nativeAtomHitRadiusPx * 0.65;
  return applySingleBondToolAtPoint(document, {
    x: atom.x + Math.cos(angleDegrees * Math.PI / 180) * steerDistance,
    y: atom.y + Math.sin(angleDegrees * Math.PI / 180) * steerDistance
  });
}

function growHexaneChain(document: ChemDraftDocument): ChemDraftDocument {
  return [
    ["atom_002", -70.5],
    ["atom_003", 0],
    ["atom_004", 70.5],
    ["atom_005", 0]
  ].reduce((current, [atomId, angle]) => growFromAtom(current, String(atomId), Number(angle)), document);
}

function growHeptaneChain(document: ChemDraftDocument): ChemDraftDocument {
  return growFromAtom(growHexaneChain(document), "atom_006", -70.5);
}

function atomDegreeMap(molecule: MoleculeObject): ReadonlyMap<string, number> {
  const degrees = new Map(molecule.atoms.map((atom) => [atom.id, 0]));
  molecule.bonds.forEach((bond) => {
    degrees.set(bond.fromAtomId, (degrees.get(bond.fromAtomId) ?? 0) + 1);
    degrees.set(bond.toAtomId, (degrees.get(bond.toAtomId) ?? 0) + 1);
  });
  return degrees;
}

function longestPathLength(molecule: MoleculeObject): number {
  const adjacency = new Map(molecule.atoms.map((atom) => [atom.id, [] as string[]]));
  molecule.bonds.forEach((bond) => {
    adjacency.get(bond.fromAtomId)?.push(bond.toAtomId);
    adjacency.get(bond.toAtomId)?.push(bond.fromAtomId);
  });

  return Math.max(...molecule.atoms.flatMap((fromAtom) =>
    molecule.atoms.map((toAtom) => pathLength(fromAtom.id, toAtom.id, adjacency))
  ));
}

function pathLength(fromAtomId: string, toAtomId: string, adjacency: ReadonlyMap<string, readonly string[]>): number {
  const pending: Array<readonly string[]> = [[fromAtomId]];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const path = pending.shift();
    const atomId = path?.[path.length - 1];
    if (!path || !atomId || visited.has(atomId)) {
      continue;
    }
    if (atomId === toAtomId) {
      return path.length;
    }
    visited.add(atomId);
    pending.push(...(adjacency.get(atomId) ?? []).filter((neighborId) => !visited.has(neighborId)).map((neighborId) => [...path, neighborId]));
  }

  return 0;
}

function expectNoDuplicateAtomPositions(molecule: MoleculeObject): void {
  molecule.atoms.forEach((atom, index) => {
    molecule.atoms.slice(index + 1).forEach((otherAtom) => {
      expect(Math.hypot(atom.x - otherAtom.x, atom.y - otherAtom.y)).toBeGreaterThan(nativeBondLengthPx * 0.25);
    });
  });
}

function pointDistance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function cyclopentaneVerticesFromBond(
  molecule: MoleculeObject
): Array<{ x: number; y: number }> {
  const firstAtom = molecule.atoms.find((atom) => atom.id === "atom_001");
  const secondAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
  if (!firstAtom || !secondAtom) {
    throw new Error("Expected starting bond atoms.");
  }

  const bondLength = pointDistance(firstAtom, secondAtom);
  const vertices: Array<{ x: number; y: number }> = [firstAtom, secondAtom];
  [72, 144, 216].forEach((angleDegrees) => {
    const previous = vertices[vertices.length - 1];
    vertices.push({
      x: previous.x + Math.cos(angleDegrees * Math.PI / 180) * bondLength,
      y: previous.y + Math.sin(angleDegrees * Math.PI / 180) * bondLength
    });
  });

  return vertices;
}

function setNativeAtomElement(
  document: ChemDraftDocument,
  atomId: string,
  element: "H" | "B" | "C" | "N" | "O" | "F" | "P" | "S" | "I"
): ChemDraftDocument {
  const molecule = selectedMolecule(document);
  return applyNativeAtomElementTarget(document, {
    objectId: molecule.id,
    kind: "atom",
    atomId,
    distanceToPointer: 0
  }, element);
}

function cycleNativeBondOrder(document: ChemDraftDocument, bondId: string): ChemDraftDocument {
  const molecule = selectedMolecule(document);
  const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
  if (!bond) {
    throw new Error(`Expected bond "${bondId}".`);
  }

  return applyNativeMoleculeBondOrderTarget(document, {
    objectId: molecule.id,
    kind: "bond",
    bondId: bond.id,
    fromAtomId: bond.fromAtomId,
    toAtomId: bond.toAtomId,
    distanceToPointer: 0
  });
}

function attachExplicitHydrogen(
  document: ChemDraftDocument,
  sourceAtomId: string,
  angleDegrees: number
): ChemDraftDocument {
  const molecule = selectedMolecule(document);
  const sourceAtom = molecule.atoms.find((atom) => atom.id === sourceAtomId);
  if (!sourceAtom) {
    throw new Error(`Expected source atom "${sourceAtomId}".`);
  }

  const hydrogenBondLength = nativeBondLengthPx * 0.7;
  const withHydrogenBond = applyFreeformSingleBondToolAtPoint(
    document,
    molecule.id,
    sourceAtomId,
    {
      x: sourceAtom.x + Math.cos(angleDegrees * Math.PI / 180) * hydrogenBondLength,
      y: sourceAtom.y + Math.sin(angleDegrees * Math.PI / 180) * hydrogenBondLength
    },
    { forceCustomLength: true }
  );
  const hydrogenAtomId = selectedMolecule(withHydrogenBond).atoms.at(-1)?.id;
  if (!hydrogenAtomId) {
    throw new Error("Expected explicit hydrogen atom.");
  }

  return setNativeAtomElement(withHydrogenBond, hydrogenAtomId, "H");
}

function averagePoint(points: readonly { x: number; y: number }[]): { x: number; y: number } {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

const clipboardEtheneMolfile = [
  "Clipboard ethene",
  "  ChemDraft",
  "",
  "  2  1  0  0  0  0            999 V2000",
  "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0  0  0  0",
  "M  END"
].join("\n");

const chemdrawMacClipboardMolfile = lengthPrefixedClipboardMolfile([
  "  ChemDraw06022613552D",
  "  6  5  0  0  0  0  0  0  0  0999 V2000",
  "   -1.7862   -0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "   -1.0717    0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "   -0.3572   -0.2062    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.3572    0.2062    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.0717   -0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.7862    0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0        0",
  "  2  3  1  0        0",
  "  3  4  1  0        0",
  "  4  5  1  0        0",
  "  5  6  1  0        0",
  "M  END"
]);

const chemdrawMacClipboardRxnfile = lengthPrefixedClipboardMolfile([
  "$RXN",
  "      ChemDraw 0602202615382D",
  "  1  1",
  "$MOL",
  "  ChemDraw06022615382D",
  "  2  1  0  0  0  0            999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.5600    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0        0",
  "M  END",
  "$MOL",
  "  ChemDraw06022615382D",
  "  2  1  0  0  0  0            999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.5600    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0        0",
  "M  END"
]);

describe("Phase 4 document workflow", () => {
  it("creates a real blank native document and inserts an adapter-backed fallback molecule", () => {
    const document = createPhase4Document("Phase 4 Fixture.chemdraft");
    const withObject = insertAdapterFallbackMolecule(document);

    expect(document.pages[0].objects).toEqual([]);
    expect(withObject.pages[0].objects).toHaveLength(1);
    expect(withObject.pages[0].objects[0]).toMatchObject({
      type: "molecule",
      structureFormat: "smiles",
      structure: "CCO",
      compatibility: {
        sourceFormat: "editor-adapter-fallback"
      }
    });
    expect(withObject.selection.objectIds).toEqual([withObject.pages[0].objects[0].id]);
    expect(getSelectedMolecule(withObject)?.structure).toBe("CCO");
  });

  it("saves and opens the Phase 4 native document subset", () => {
    const document = applySingleBondToolAtPoint(
      insertAdapterFallbackMolecule(createPhase4Document("Round Trip")),
      { x: 600, y: 600 }
    );
    const payload = createNativeSavePayload(document);
    const reopened = openNativeDocument(payload.contents);

    expect(payload.filename).toBe("Round-Trip.chemdraft");
    expect(payload.mimeType).toBe("application/vnd.chemdraft+json");
    expect(reopened).toEqual(document);
  });

  it("creates and inserts a real native single-bond molecule through document patches", () => {
    const document = createPhase4Document("Bond Fixture");
    const molecule = createNativeSingleBondMolecule(document, { x: 200, y: 220 });
    const withBond = insertNativeSingleBondMolecule(document, { x: 200, y: 220 });

    expect(molecule).toMatchObject({
      type: "molecule",
      structureFormat: "smiles",
      structure: "CC",
      atoms: [
        { id: "atom_001", element: "C", x: 200 - nativeBondLengthPx / 2, y: 220, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 200 + nativeBondLengthPx / 2, y: 220, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }],
      chemistry: {
        formula: "C2H6",
        atomCount: 2,
        bondCount: 1,
        totalCharge: 0
      },
      style: {
        stylePresetId: "chemdraft.synthetic",
        bondLengthPx: nativeBondLengthPx,
        source: "chemdraft-native-drawing",
        drawingPrimitive: "single-bond"
      }
    });
    expect(document.pages[0].objects).toEqual([]);
    expect(withBond.pages[0].objects).toHaveLength(1);
    expect(withBond.pages[0].objects[0]).toMatchObject({ id: "mol_bond_001", structure: "CC" });
    expect(withBond.selection.objectIds).toEqual(["mol_bond_001"]);
  });

  it("reorders the selected document object for layer controls", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Layer Fixture"), { x: 200, y: 220 });
    const second = insertNativeSingleBondMolecule(first, { x: 230, y: 220 });
    const selectedId = second.selection.objectIds[0];
    const backward = reorderSelectedDocumentObject(second, "backward");
    const front = reorderSelectedDocumentObject(backward, "front");

    expect(second.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_001", "mol_bond_002"]);
    expect(backward.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_002", "mol_bond_001"]);
    expect(backward.selection.objectIds).toEqual([selectedId]);
    expect(front.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_001", "mol_bond_002"]);
    expect(front.selection.objectIds).toEqual([selectedId]);
  });

  it("reorders selected native molecule atom and bond parts without changing chemical identity", () => {
    const base = createPhase4Document("Internal Depth Fixture");
    const molecule = {
      id: "mol_depth",
      type: "molecule",
      x: 100,
      y: 100,
      width: 120,
      height: 80,
      rotation: 0,
      style: {},
      structureFormat: "smiles",
      structure: "CCCC",
      atoms: [
        { id: "atom_001", element: "C", x: 112, y: 140, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 148, y: 120, formalCharge: 0 },
        { id: "atom_003", element: "C", x: 184, y: 140, formalCharge: 0 },
        { id: "atom_004", element: "C", x: 220, y: 120, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
        { id: "bond_bridge", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
        { id: "bond_right", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" }
      ],
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule },
      { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
    ]);
    const atomForward = reorderNativeMoleculeParts(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002"
    }, "front");
    const bondBackward = reorderNativeMoleculeParts(atomForward, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_bridge"
    }, "back");

    expect(selectedMolecule(document).bonds.map((bond) => bond.id)).toEqual(["bond_left", "bond_bridge", "bond_right"]);
    expect(selectedMolecule(atomForward).bonds.map((bond) => bond.id)).toEqual(["bond_right", "bond_left", "bond_bridge"]);
    expect(selectedMolecule(bondBackward).bonds.map((bond) => bond.id)).toEqual(["bond_bridge", "bond_right", "bond_left"]);
    expect(selectedMolecule(bondBackward).atoms.map((atom) => atom.id)).toEqual(
      selectedMolecule(document).atoms.map((atom) => atom.id)
    );
    expect(selectedMolecule(bondBackward).bonds).toEqual(
      expect.arrayContaining(selectedMolecule(document).bonds.map((bond) => expect.objectContaining({ id: bond.id })))
    );
    expect(bondBackward.selection.objectIds).toEqual([molecule.id]);
  });

  it("moves selected native molecule atoms while connected unselected atoms stay anchored", () => {
    const base = createPhase4Document("Partial Molecule Drag Fixture");
    const molecule = {
      id: "mol_partial_drag",
      type: "molecule",
      x: 100,
      y: 100,
      width: 140,
      height: 80,
      rotation: 0,
      style: {},
      structureFormat: "smiles",
      structure: "C=CC=C",
      atoms: [
        { id: "atom_001", element: "C", x: 112, y: 140, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 148, y: 120, formalCharge: 0 },
        { id: "atom_003", element: "C", x: 184, y: 140, formalCharge: 0 },
        { id: "atom_004", element: "C", x: 220, y: 120, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
        { id: "bond_bridge", fromAtomId: "atom_002", toAtomId: "atom_003", order: "double" },
        { id: "bond_right", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" }
      ],
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule },
      { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
    ]);
    const moved = moveNativeMoleculeParts(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_bridge"
    }, { x: 64, y: -72 });
    const movedMolecule = selectedMolecule(moved);
    const originalAtomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
    const atomById = new Map(movedMolecule.atoms.map((atom) => [atom.id, atom]));
    const originalAtom = (atomId: string) => {
      const atom = originalAtomById.get(atomId);
      if (!atom) {
        throw new Error(`Expected original atom "${atomId}".`);
      }
      return atom;
    };
    const movedAtom = (atomId: string) => {
      const atom = atomById.get(atomId);
      if (!atom) {
        throw new Error(`Expected moved atom "${atomId}".`);
      }
      return atom;
    };

    expect(movedAtom("atom_001")).toMatchObject({ x: 112, y: 140 });
    expect(movedAtom("atom_004")).toMatchObject({ x: 220, y: 120 });
    expect(movedAtom("atom_002")).toMatchObject({ x: 212, y: 48 });
    expect(movedAtom("atom_003")).toMatchObject({ x: 248, y: 68 });
    expect(pointDistance(movedAtom("atom_001"), movedAtom("atom_002"))).toBeGreaterThan(
      pointDistance(originalAtom("atom_001"), originalAtom("atom_002"))
    );
    expect(pointDistance(movedAtom("atom_003"), movedAtom("atom_004"))).toBeGreaterThan(
      pointDistance(originalAtom("atom_003"), originalAtom("atom_004"))
    );
    expect(movedMolecule.bonds).toEqual(molecule.bonds);
    expect(movedMolecule.structure).toBe(molecule.structure);
    expect(moved.selection.objectIds).toEqual([molecule.id]);
  });

  it("moves a native molecule object without detaching atoms from page coordinates", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Move Fixture"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const moved = moveDocumentObject(document, molecule.id, { x: molecule.x + 80, y: molecule.y + 40 });
    const movedMolecule = selectedMolecule(moved);

    expect(movedMolecule.id).toBe(molecule.id);
    expect(movedMolecule.x).toBeCloseTo(molecule.x + 80, 3);
    expect(movedMolecule.y).toBeCloseTo(molecule.y + 40, 3);
    expect(movedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(movedMolecule.atoms[0]?.x).toBeCloseTo((molecule.atoms[0]?.x ?? 0) + 80, 3);
    expect(movedMolecule.atoms[0]?.y).toBeCloseTo((molecule.atoms[0]?.y ?? 0) + 40, 3);
    expect(movedMolecule.atoms[1]?.x).toBeCloseTo((molecule.atoms[1]?.x ?? 0) + 80, 3);
    expect(movedMolecule.atoms[1]?.y).toBeCloseTo((molecule.atoms[1]?.y ?? 0) + 40, 3);
    expect(movedMolecule.bonds).toEqual(molecule.bonds);
    expect(movedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(moved.selection.objectIds).toEqual([molecule.id]);
  });

  it("extends the selected native single bond into one connected molecule graph", () => {
    const withBond = insertNativeSingleBondMolecule(createPhase4Document("Chain Fixture"), { x: 200, y: 220 });
    const extended = growFromAtom(withBond, "atom_002", 0);
    const secondAtomX = 200 + nativeBondLengthPx / 2;
    const expectedThirdAtom = {
      x: secondAtomX + Math.cos(70.5 * Math.PI / 180) * nativeBondLengthPx,
      y: 220 + Math.sin(70.5 * Math.PI / 180) * nativeBondLengthPx
    };

    expect(extended.pages[0].objects).toHaveLength(1);
    expect(extended.selection.objectIds).toEqual(["mol_bond_001"]);
    expect(getSelectedMolecule(extended)).toMatchObject({
      id: "mol_bond_001",
      structure: "CCC",
      atoms: [
        { id: "atom_001", element: "C", x: 200 - nativeBondLengthPx / 2, y: 220 },
        { id: "atom_002", element: "C", x: secondAtomX, y: 220 },
        { id: "atom_003", element: "C" }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" }
      ],
      chemistry: {
        formula: "C3H8",
        atomCount: 3,
        bondCount: 2,
        totalCharge: 0
      }
    });
    expect(getSelectedMolecule(extended)?.atoms[2]?.x).toBeCloseTo(expectedThirdAtom.x, 3);
    expect(getSelectedMolecule(extended)?.atoms[2]?.y).toBeCloseTo(expectedThirdAtom.y, 3);
    expect(getSelectedMolecule(withBond)?.structure).toBe("CC");
  });

  it("starts a separate bond when a selected molecule click does not hit an extendable atom", () => {
    const withBond = insertNativeSingleBondMolecule(createPhase4Document("Atom-only Growth"), { x: 200, y: 220 });
    const next = applySingleBondToolAtPoint(withBond, { x: 200, y: 220 });

    expect(next.pages[0].objects).toHaveLength(2);
    expect(next.selection.objectIds).toEqual(["mol_bond_002"]);
  });

  it("highlights hovered atoms for native bond growth even when later edits may exceed valence", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Atom Hit"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const terminalAtom = molecule.atoms.find((atom) => atom.id === "atom_002");

    expect(findNativeMoleculeAtomHit(molecule, terminalAtom ?? { x: 0, y: 0 })).toMatchObject({
      atomId: "atom_002",
      degree: 1,
      availableBonds: 7
    });
    expect(findNativeMoleculeAtomHit(molecule, {
      x: terminalAtom?.x ?? 0,
      y: (terminalAtom?.y ?? 0) + nativeAtomHitRadiusPx + 1
    })).toBeUndefined();
  });

  it("previews the exact steered growth direction that a click will commit", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Steered Preview"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const terminalAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!terminalAtom) {
      throw new Error("Expected terminal atom.");
    }
    const upwardPoint = { x: terminalAtom.x + 4, y: terminalAtom.y - 4 };
    const downwardPoint = { x: terminalAtom.x + 4, y: terminalAtom.y + 4 };
    const upwardPreview = previewNativeMoleculeBondGrowth(molecule, upwardPoint, 816, 1056);
    const downwardPreview = previewNativeMoleculeBondGrowth(molecule, downwardPoint, 816, 1056);
    const upwardDocument = applySingleBondToolAtPoint(document, upwardPoint);
    const downwardDocument = applySingleBondToolAtPoint(document, downwardPoint);
    const upwardAtom = selectedMolecule(upwardDocument).atoms.at(-1);
    const downwardAtom = selectedMolecule(downwardDocument).atoms.at(-1);

    expect(upwardPreview).toMatchObject({ atomId: "atom_002", availableBonds: 7 });
    expect(downwardPreview).toMatchObject({ atomId: "atom_002", availableBonds: 7 });
    expect(upwardPreview?.candidateDirections).toHaveLength(2);
    expect(downwardPreview?.candidateDirections).toHaveLength(2);
    expect(upwardPreview?.candidateDirections.some((direction) => direction.y < 0)).toBe(true);
    expect(upwardPreview?.candidateDirections.some((direction) => direction.y > 0)).toBe(true);
    expect(upwardPreview?.newAtomPoint.y).toBeLessThan(220);
    expect(downwardPreview?.newAtomPoint.y).toBeGreaterThan(220);
    expect(upwardAtom).toMatchObject(upwardPreview?.newAtomPoint ?? {});
    expect(downwardAtom).toMatchObject(downwardPreview?.newAtomPoint ?? {});
  });

  it("lets the ghost terminal direction commit when it points into soft-crowded geometry", () => {
    const document = [
      ["atom_002", -70.5],
      ["atom_003", 0],
      ["atom_004", 70.5]
    ].reduce(
      (current, [atomId, angle]) => growFromAtom(current, String(atomId), Number(angle)),
      insertNativeSingleBondMolecule(createPhase4Document("Crowded Ghost Direction"), { x: 240, y: 260 })
    );
    const molecule = selectedMolecule(document);
    const terminalAtom = molecule.atoms.find((atom) => atom.id === "atom_005");
    const neighborAtom = molecule.atoms.find((atom) => atom.id === "atom_004");
    if (!terminalAtom || !neighborAtom) {
      throw new Error("Expected chain terminal atoms.");
    }

    const neighborAngle = Math.atan2(neighborAtom.y - terminalAtom.y, neighborAtom.x - terminalAtom.x);
    const ghostAngle = neighborAngle + 109.5 * Math.PI / 180;
    const clickPoint = {
      x: terminalAtom.x + Math.cos(ghostAngle) * nativeAtomHitRadiusPx * 0.65,
      y: terminalAtom.y + Math.sin(ghostAngle) * nativeAtomHitRadiusPx * 0.65
    };
    const preview = previewNativeMoleculeBondGrowth(molecule, clickPoint, 816, 1056);
    const next = applySingleBondToolAtPoint(document, clickPoint);
    const nextAtom = selectedMolecule(next).atoms.at(-1);

    expect(preview?.candidateDirections.length).toBeGreaterThanOrEqual(2);
    expect(preview?.direction.x).toBeCloseTo(Math.cos(ghostAngle), 3);
    expect(preview?.direction.y).toBeCloseTo(Math.sin(ghostAngle), 3);
    expect(nextAtom).toMatchObject(preview?.newAtomPoint ?? {});
  });

  it("previews and commits free-angle drag at the default C-C bond length before breakaway", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Freeform Bond"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const sourceAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!sourceAtom) {
      throw new Error("Expected source atom.");
    }
    const releasePoint = { x: sourceAtom.x + 14, y: sourceAtom.y + 6 };
    const preview = previewNativeMoleculeFreeformBondGrowth(molecule, "atom_002", releasePoint, 816, 1056);
    const freeform = applyFreeformSingleBondToolAtPoint(document, molecule.id, "atom_002", releasePoint);
    const freeformMolecule = selectedMolecule(freeform);
    const newAtom = freeformMolecule.atoms.at(-1);

    expect(preview).toMatchObject({
      atomId: "atom_002",
      availableBonds: 7,
      customLength: false,
      lengthAngstrom: 1.56
    });
    expect(pointDistance(preview?.newAtomPoint ?? releasePoint, molecule.atoms[1])).toBeCloseTo(nativeBondLengthPx, 3);
    expect(preview?.newAtomPoint).not.toEqual(releasePoint);
    expect(newAtom).toMatchObject({
      element: "C",
      x: preview?.newAtomPoint.x,
      y: preview?.newAtomPoint.y
    });
    expect(freeformMolecule.bonds.at(-1)).toMatchObject({
      fromAtomId: "atom_002",
      toAtomId: newAtom?.id,
      order: "single"
    });
    expect(freeformMolecule.structure).toBe("CCC");
  });

  it("breaks freeform drag into custom length after a larger pull", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Custom Freeform Bond"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const sourceAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!sourceAtom) {
      throw new Error("Expected source atom.");
    }
    const releasePoint = { x: sourceAtom.x + 46, y: sourceAtom.y + 16 };
    const preview = previewNativeMoleculeFreeformBondGrowth(molecule, "atom_002", releasePoint, 816, 1056);
    const freeform = applyFreeformSingleBondToolAtPoint(document, molecule.id, "atom_002", releasePoint);
    const newAtom = selectedMolecule(freeform).atoms.at(-1);

    expect(preview).toMatchObject({
      atomId: "atom_002",
      newAtomPoint: releasePoint,
      customLength: true
    });
    expect(preview?.lengthAngstrom).toBeCloseTo(
      pointDistance(sourceAtom, releasePoint) / nativeBondLengthPx * 1.56,
      2
    );
    expect(newAtom).toMatchObject(releasePoint);
  });

  it("keeps unlocked freeform drag custom so it can make shorter bonds", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Short Custom Freeform Bond"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const sourceAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!sourceAtom) {
      throw new Error("Expected source atom.");
    }
    const releasePoint = { x: sourceAtom.x + 6, y: sourceAtom.y + 2 };
    const preview = previewNativeMoleculeFreeformBondGrowth(molecule, "atom_002", releasePoint, 816, 1056, {
      forceCustomLength: true
    });
    const freeform = applyFreeformSingleBondToolAtPoint(document, molecule.id, "atom_002", releasePoint, {
      forceCustomLength: true
    });
    const freeformMolecule = selectedMolecule(freeform);
    const newAtom = freeformMolecule.atoms.at(-1);

    expect(preview).toMatchObject({
      atomId: "atom_002",
      customLength: true,
      newAtomPoint: releasePoint
    });
    expect(preview?.lengthAngstrom).toBeLessThan(1.56);
    expect(pointDistance(newAtom ?? releasePoint, molecule.atoms[1])).toBeLessThan(nativeBondLengthPx);
    expect(newAtom).toMatchObject(releasePoint);
    expect(freeformMolecule.chemistry).toMatchObject({ formula: "C3H8", atomCount: 3, bondCount: 2 });
  });

  it("snaps unlocked freeform drag to another eligible atom instead of adding a carbon", () => {
    const butane = growFromAtom(
      growFromAtom(
        insertNativeSingleBondMolecule(createPhase4Document("Freeform Connect"), { x: 220, y: 260 }),
        "atom_002",
        -70.5
      ),
      "atom_003",
      0
    );
    const molecule = selectedMolecule(butane);
    const split = applyNativeMoleculeDeleteTarget(butane, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002",
      fromAtomId: "atom_002",
      toAtomId: "atom_003",
      distanceToPointer: 0
    });
    const splitMolecule = selectedMolecule(split);
    const targetAtom = splitMolecule.atoms.find((atom) => atom.id === "atom_003");
    if (!targetAtom) {
      throw new Error("Expected atom_003.");
    }

    const preview = previewNativeMoleculeFreeformBondGrowth(
      splitMolecule,
      "atom_002",
      targetAtom,
      816,
      1056,
      { forceCustomLength: true }
    );
    const reconnected = applyFreeformSingleBondToolAtPoint(
      split,
      splitMolecule.id,
      "atom_002",
      targetAtom,
      { forceCustomLength: true }
    );
    const nextMolecule = selectedMolecule(reconnected);

    expect(splitMolecule.structure).toBe("CC.CC");
    expect(preview).toMatchObject({
      atomId: "atom_002",
      targetAtomId: "atom_003",
      customLength: true,
      newAtomPoint: { x: targetAtom.x, y: targetAtom.y }
    });
    expect(nextMolecule.atoms).toHaveLength(4);
    expect(nextMolecule.bonds).toHaveLength(3);
    expect(nextMolecule.bonds.at(-1)).toMatchObject({
      fromAtomId: "atom_002",
      toAtomId: "atom_003",
      order: "single"
    });
    expect(nextMolecule.structure).toBe("CCCC");
    expect(nextMolecule.chemistry).toMatchObject({ formula: "C4H10", atomCount: 4, bondCount: 3 });
  });

  it("builds cyclopentane as a closed freeform ring without deleting bonds", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Cyclopentane"), { x: 260, y: 260 });
    const vertices = cyclopentaneVerticesFromBond(selectedMolecule(document));
    const withThirdAtom = applyFreeformSingleBondToolAtPoint(
      document,
      "mol_bond_001",
      "atom_002",
      vertices[2],
      { forceCustomLength: true }
    );
    const withFourthAtom = applyFreeformSingleBondToolAtPoint(
      withThirdAtom,
      "mol_bond_001",
      "atom_003",
      vertices[3],
      { forceCustomLength: true }
    );
    const withFifthAtom = applyFreeformSingleBondToolAtPoint(
      withFourthAtom,
      "mol_bond_001",
      "atom_004",
      vertices[4],
      { forceCustomLength: true }
    );
    const preview = previewNativeMoleculeFreeformBondGrowth(
      selectedMolecule(withFifthAtom),
      "atom_005",
      vertices[0],
      816,
      1056,
      { forceCustomLength: true }
    );
    const closed = applyFreeformSingleBondToolAtPoint(
      withFifthAtom,
      "mol_bond_001",
      "atom_005",
      vertices[0],
      { forceCustomLength: true }
    );
    const molecule = selectedMolecule(closed);
    const degrees = atomDegreeMap(molecule);
    const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
    const bondLengths = molecule.bonds.map((bond) => {
      const fromAtom = atomById.get(bond.fromAtomId);
      const toAtom = atomById.get(bond.toAtomId);
      if (!fromAtom || !toAtom) {
        throw new Error("Expected cyclopentane bond atoms.");
      }
      return pointDistance(fromAtom, toAtom);
    });

    expect(preview).toMatchObject({
      atomId: "atom_005",
      targetAtomId: "atom_001",
      customLength: true
    });
    expect(molecule.atoms).toHaveLength(5);
    expect(molecule.bonds).toHaveLength(5);
    expect([...degrees.values()]).toEqual([2, 2, 2, 2, 2]);
    expect(molecule.structure).toBe("C1CCCC1");
    expect(molecule.chemistry).toMatchObject({ formula: "C5H10", atomCount: 5, bondCount: 5 });
    bondLengths.forEach((length) => expect(length).toBeCloseTo(nativeBondLengthPx, 1));
    expectNoDuplicateAtomPositions(molecule);
  });

  it("builds tetrahydrofuran with explicit hydrogen labels without deleting bonds", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Tetrahydrofuran"), { x: 260, y: 260 });
    const vertices = cyclopentaneVerticesFromBond(selectedMolecule(document));
    const withThirdAtom = applyFreeformSingleBondToolAtPoint(
      document,
      "mol_bond_001",
      "atom_002",
      vertices[2],
      { forceCustomLength: true }
    );
    const withFourthAtom = applyFreeformSingleBondToolAtPoint(
      withThirdAtom,
      "mol_bond_001",
      "atom_003",
      vertices[3],
      { forceCustomLength: true }
    );
    const withFifthAtom = applyFreeformSingleBondToolAtPoint(
      withFourthAtom,
      "mol_bond_001",
      "atom_004",
      vertices[4],
      { forceCustomLength: true }
    );
    const closedRing = applyFreeformSingleBondToolAtPoint(
      withFifthAtom,
      "mol_bond_001",
      "atom_005",
      vertices[0],
      { forceCustomLength: true }
    );
    const oxygenRing = setNativeAtomElement(closedRing, "atom_003", "O");
    const ringCenter = averagePoint(
      selectedMolecule(oxygenRing).atoms
        .filter((atom) => ["atom_001", "atom_002", "atom_003", "atom_004", "atom_005"].includes(atom.id))
        .map((atom) => ({ x: atom.x, y: atom.y }))
    );
    const thf = ["atom_001", "atom_002", "atom_004", "atom_005"].reduce((current, atomId) => {
      const atom = selectedMolecule(current).atoms.find((candidate) => candidate.id === atomId);
      if (!atom) {
        throw new Error(`Expected THF ring atom "${atomId}".`);
      }

      const outwardAngle = Math.atan2(atom.y - ringCenter.y, atom.x - ringCenter.x) * 180 / Math.PI;
      return [outwardAngle - 28, outwardAngle + 28].reduce(
        (withHydrogens, angle) => attachExplicitHydrogen(withHydrogens, atomId, angle),
        current
      );
    }, oxygenRing);
    const molecule = selectedMolecule(thf);
    const degrees = atomDegreeMap(molecule);

    expect(molecule.atoms).toHaveLength(13);
    expect(molecule.bonds).toHaveLength(13);
    expect(molecule.atoms.filter((atom) => atom.element === "C")).toHaveLength(4);
    expect(molecule.atoms.filter((atom) => atom.element === "O")).toHaveLength(1);
    expect(molecule.atoms.filter((atom) => atom.element === "H")).toHaveLength(8);
    expect(molecule.chemistry).toMatchObject({ formula: "C4H8O", atomCount: 13, bondCount: 13 });
    expect(molecule.structure).toBe("C1([H])([H])C([H])([H])OC([H])([H])C1([H])([H])");
    expect(degrees.get("atom_003")).toBe(2);
    ["atom_001", "atom_002", "atom_004", "atom_005"].forEach((atomId) => {
      expect(degrees.get(atomId)).toBe(4);
    });
    molecule.atoms
      .filter((atom) => atom.element === "H")
      .forEach((atom) => expect(degrees.get(atom.id)).toBe(1));
    expectNoDuplicateAtomPositions(molecule);
  });

  it("freeform-grows over-valent atoms with warnings but still rejects too-short drags", () => {
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Freeform Rejects"), { x: 300, y: 300 })
    );
    const saturated = selectedMolecule(neopentane);
    const saturatedAttempt = applyFreeformSingleBondToolAtPoint(neopentane, saturated.id, "atom_001", { x: 300, y: 420 });
    const overValentMolecule = selectedMolecule(saturatedAttempt);
    const shortBaseline = insertNativeSingleBondMolecule(createPhase4Document("Short Freeform"), { x: 200, y: 220 });
    const shortSourceAtom = selectedMolecule(shortBaseline).atoms.find((atom) => atom.id === "atom_002");
    if (!shortSourceAtom) {
      throw new Error("Expected short freeform source atom.");
    }
    const shortAttempt = applyFreeformSingleBondToolAtPoint(
      shortBaseline,
      "mol_bond_001",
      "atom_002",
      { x: shortSourceAtom.x + 2, y: shortSourceAtom.y + 1 }
    );

    expect(overValentMolecule.atoms).toHaveLength(6);
    expect(overValentMolecule.bonds).toHaveLength(5);
    expect(atomDegreeMap(overValentMolecule).get("atom_001")).toBe(5);
    expect(nativeMoleculeInvalidAtomStates(overValentMolecule)).toMatchObject([
      { atomId: "atom_001", element: "C", valenceUsed: 5, valid: false }
    ]);
    expect(overValentMolecule.chemistry?.warnings).toContainEqual({
      code: "chemistry.invalid_valence",
      message: "C atom atom_001 has unsupported valence 5.",
      objectId: "atom_001"
    });
    expect(shortAttempt).toEqual(shortBaseline);
  });

  it("sets a hovered native atom to a one-letter element through a document patch", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Element Key"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const updated = applyNativeAtomElementTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    }, "O");
    const nextMolecule = selectedMolecule(updated);

    expect(nextMolecule.atoms.find((atom) => atom.id === "atom_002")).toMatchObject({ element: "O" });
    expect(nextMolecule.structure).toBe("CO");
    expect(nextMolecule.chemistry).toMatchObject({ formula: "CH4O", atomCount: 2, bondCount: 1 });
    expect(selectedMolecule(document).atoms.find((atom) => atom.id === "atom_002")).toMatchObject({ element: "C" });
  });

  it("labels isolated neutral common atoms with implicit hydrogens", () => {
    expect(nativeAtomDisplayLabel({ id: "atom_001", element: "C", x: 0, y: 0, formalCharge: 0 }, [])).toBe("CH4");
    expect(nativeAtomDisplayLabel({ id: "atom_001", element: "N", x: 0, y: 0, formalCharge: 0 }, [])).toBe("NH3");
    expect(nativeAtomDisplayLabel({ id: "atom_001", element: "O", x: 0, y: 0, formalCharge: 0 }, [])).toBe("OH2");
  });

  it("allows hovered atom element changes that exceed valence and marks them invalid", () => {
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Valence Reject"), { x: 300, y: 300 })
    );
    const molecule = selectedMolecule(neopentane);
    const changed = applyNativeAtomElementTarget(neopentane, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    }, "O");
    const changedMolecule = selectedMolecule(changed);

    expect(changedMolecule.atoms.find((atom) => atom.id === "atom_001")).toMatchObject({ element: "O" });
    expect(nativeMoleculeInvalidAtomStates(changedMolecule)).toMatchObject([
      { atomId: "atom_001", element: "O", valenceUsed: 4, valid: false }
    ]);
    expect(findNativeMoleculeAtomHit(changedMolecule, molecule.atoms.find((atom) => atom.id === "atom_001") ?? { x: 0, y: 0 }))
      .toMatchObject({ atomId: "atom_001", availableBonds: 4 });
  });

  it("cycles a hovered carbon-carbon bond from single to double to triple and back to single", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Bond Orders"), { x: 200, y: 220 });
    const doubleBond = cycleNativeBondOrder(document, "bond_001");
    const tripleBond = cycleNativeBondOrder(doubleBond, "bond_001");
    const singleBond = cycleNativeBondOrder(tripleBond, "bond_001");

    expect(selectedMolecule(doubleBond)).toMatchObject({
      structure: "C=C",
      bonds: [{ id: "bond_001", order: "double", display: { doubleBondSide: "left" } }],
      chemistry: { formula: "C2H4", atomCount: 2, bondCount: 1 }
    });
    expect(selectedMolecule(tripleBond)).toMatchObject({
      structure: "C#C",
      bonds: [{ id: "bond_001", order: "triple" }],
      chemistry: { formula: "C2H2", atomCount: 2, bondCount: 1 }
    });
    expect(selectedMolecule(tripleBond).bonds[0].display).toBeUndefined();
    expect(selectedMolecule(singleBond)).toMatchObject({
      structure: "CC",
      bonds: [{ id: "bond_001", order: "single" }],
      chemistry: { formula: "C2H6", atomCount: 2, bondCount: 1 }
    });
    expect(selectedMolecule(singleBond).bonds[0].display).toBeUndefined();
  });

  it("moves the secondary line side of a double bond without changing chemistry", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Double Bond Side"), { x: 200, y: 220 });
    const doubleBond = cycleNativeBondOrder(document, "bond_001");
    const molecule = selectedMolecule(doubleBond);
    const changed = applyNativeDoubleBondSideTarget(
      doubleBond,
      {
        objectId: molecule.id,
        kind: "bond",
        bondId: "bond_001",
        fromAtomId: "atom_001",
        toAtomId: "atom_002",
        distanceToPointer: 0
      },
      { x: 200, y: 190 }
    );

    expect(selectedMolecule(changed).bonds[0]).toMatchObject({
      id: "bond_001",
      order: "double",
      display: { doubleBondSide: "right" }
    });
    expect(selectedMolecule(changed).structure).toBe(selectedMolecule(doubleBond).structure);
    expect(selectedMolecule(changed).chemistry).toEqual(selectedMolecule(doubleBond).chemistry);
  });

  it("defaults cyclic double-bond secondary lines toward the ring interior", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Cyclopentene Display"), { x: 260, y: 260 });
    const vertices = cyclopentaneVerticesFromBond(selectedMolecule(document));
    const withThirdAtom = applyFreeformSingleBondToolAtPoint(
      document,
      "mol_bond_001",
      "atom_002",
      vertices[2],
      { forceCustomLength: true }
    );
    const withFourthAtom = applyFreeformSingleBondToolAtPoint(
      withThirdAtom,
      "mol_bond_001",
      "atom_003",
      vertices[3],
      { forceCustomLength: true }
    );
    const withFifthAtom = applyFreeformSingleBondToolAtPoint(
      withFourthAtom,
      "mol_bond_001",
      "atom_004",
      vertices[4],
      { forceCustomLength: true }
    );
    const closedRing = applyFreeformSingleBondToolAtPoint(
      withFifthAtom,
      "mol_bond_001",
      "atom_005",
      vertices[0],
      { forceCustomLength: true }
    );
    const cyclopentene = cycleNativeBondOrder(closedRing, "bond_001");

    expect(selectedMolecule(cyclopentene).bonds.find((bond) => bond.id === "bond_001")).toMatchObject({
      order: "double",
      display: { doubleBondSide: "left" }
    });
  });

  it("builds a ketone by cycling a carbon-oxygen bond without over-valencing oxygen", () => {
    const propane = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Ketone"), { x: 240, y: 260 }),
      "atom_002",
      0
    );
    const molecule = selectedMolecule(propane);
    const carbonylCarbon = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!carbonylCarbon) {
      throw new Error("Expected center carbon.");
    }

    const withOxygen = applyFreeformSingleBondToolAtPoint(
      propane,
      molecule.id,
      carbonylCarbon.id,
      { x: carbonylCarbon.x, y: carbonylCarbon.y - nativeBondLengthPx },
      { forceCustomLength: true }
    );
    const oxygenAtomId = selectedMolecule(withOxygen).atoms.at(-1)?.id;
    if (!oxygenAtomId) {
      throw new Error("Expected oxygen atom target.");
    }

    const alcohol = setNativeAtomElement(withOxygen, oxygenAtomId, "O");
    const ketone = cycleNativeBondOrder(alcohol, "bond_003");
    const capped = cycleNativeBondOrder(ketone, "bond_003");

    expect(selectedMolecule(ketone).bonds.find((bond) => bond.id === "bond_003")).toMatchObject({ order: "double" });
    expect(selectedMolecule(ketone).structure).toContain("=O");
    expect(selectedMolecule(ketone).chemistry).toMatchObject({ formula: "C3H6O", atomCount: 4, bondCount: 3 });
    expect(capped).toEqual(ketone);
  });

  it("builds furan-like ring valence with oxygen and two double bonds", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Furan"), { x: 260, y: 260 });
    const vertices = cyclopentaneVerticesFromBond(selectedMolecule(document));
    const withThirdAtom = applyFreeformSingleBondToolAtPoint(
      document,
      "mol_bond_001",
      "atom_002",
      vertices[2],
      { forceCustomLength: true }
    );
    const withFourthAtom = applyFreeformSingleBondToolAtPoint(
      withThirdAtom,
      "mol_bond_001",
      "atom_003",
      vertices[3],
      { forceCustomLength: true }
    );
    const withFifthAtom = applyFreeformSingleBondToolAtPoint(
      withFourthAtom,
      "mol_bond_001",
      "atom_004",
      vertices[4],
      { forceCustomLength: true }
    );
    const closedRing = applyFreeformSingleBondToolAtPoint(
      withFifthAtom,
      "mol_bond_001",
      "atom_005",
      vertices[0],
      { forceCustomLength: true }
    );
    const oxygenRing = setNativeAtomElement(closedRing, "atom_003", "O");
    const firstDouble = cycleNativeBondOrder(oxygenRing, "bond_001");
    const furan = cycleNativeBondOrder(firstDouble, "bond_004");
    const oxygenDoubleAttempt = cycleNativeBondOrder(furan, "bond_002");
    const molecule = selectedMolecule(furan);

    expect(molecule.bonds.find((bond) => bond.id === "bond_001")).toMatchObject({ order: "double" });
    expect(molecule.bonds.find((bond) => bond.id === "bond_004")).toMatchObject({ order: "double" });
    expect(molecule.chemistry).toMatchObject({ formula: "C4H4O", atomCount: 5, bondCount: 5 });
    expect(molecule.structure).toContain("=");
    expect(oxygenDoubleAttempt).toEqual(furan);
  });

  it("maps only common single-letter atom keys", () => {
    expect(nativeElementFromKeyboardKey("b")).toBe("B");
    expect(nativeElementFromKeyboardKey("N")).toBe("N");
    expect(nativeElementFromKeyboardKey("o")).toBe("O");
    expect(nativeElementFromKeyboardKey("f")).toBe("F");
    expect(nativeElementFromKeyboardKey("i")).toBe("I");
    expect(nativeElementFromKeyboardKey("v")).toBeUndefined();
    expect(nativeElementFromKeyboardKey("Cl")).toBeUndefined();
    expect(nativeElementFromKeyboardKey("x")).toBeUndefined();
  });

  it("normalizes full atom labels and validates real element symbols", () => {
    expect(normalizeNativeAtomElementLabel("cl")).toBe("Cl");
    expect(nativeElementFromAtomLabel("cl")).toBe("Cl");
    expect(nativeElementFromAtomLabel("Br")).toBe("Br");
    expect(nativeElementFromAtomLabel("Xx")).toBeUndefined();
  });

  it("updates hovered atom labels to full element symbols and flags invalid symbols", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Atom Labels"), { x: 300, y: 300 });
    const molecule = selectedMolecule(document);
    const target = {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    } as const;
    const chloride = applyNativeAtomElementTarget(document, target, "cl");
    const labeled = selectedMolecule(chloride);
    const invalid = applyNativeAtomElementTarget(chloride, target, "Xx");
    const invalidMolecule = selectedMolecule(invalid);

    expect(labeled.atoms.find((atom) => atom.id === "atom_001")).toMatchObject({ element: "Cl" });
    expect(nativeAtomDisplayLabel(labeled.atoms[0], labeled.bonds)).toBe("Cl");
    expect(nativeMoleculeInvalidAtomStates(labeled)).toEqual([]);
    expect(invalidMolecule.atoms.find((atom) => atom.id === "atom_001")).toMatchObject({ element: "Xx" });
    expect(nativeMoleculeInvalidAtomStates(invalidMolecule)[0]).toMatchObject({
      atomId: "atom_001",
      valid: false
    });
  });

  it("creates and edits native text objects without changing chemistry objects", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Text Objects"), { x: 300, y: 300 });
    const withText = insertNativeTextObject(document, { x: 120, y: 140 }, "Yield 82%", {
      fontFamily: "Times New Roman, Times, serif",
      fontSizePx: 24,
      color: "#b3261e",
      textAlign: "center"
    });
    const textObject = getSelectedTextObject(withText);
    if (!textObject) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const renamed = updateNativeTextObjectText(withText, textObject.id, "Yield 91%");
    const styled = updateNativeTextObjectStyle(renamed, textObject.id, {
      letterSpacingPx: 0.8,
      lineHeight: 1.55,
      paragraphSpacingPx: 4,
      fontWeight: 700
    });
    const molecule = styled.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const editedText = styled.pages[0].objects.find((object): object is TextObject => object.id === textObject.id);

    expect(editedText).toMatchObject({
      type: "text",
      text: "Yield 91%",
      style: {
        fontFamily: "Times New Roman, Times, serif",
        fontSizePx: 24,
        color: "#b3261e",
        textAlign: "center",
        letterSpacingPx: 0.8,
        lineHeight: 1.55,
        paragraphSpacingPx: 4,
        fontWeight: 700
      }
    });
    expect(molecule?.atoms).toHaveLength(2);
    expect(molecule?.bonds).toHaveLength(1);
  });

  it("pastes ordinary clipboard text as an editable text object", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Clipboard Text"), { x: 300, y: 300 });
    const result = applyClipboardPastePayload(document, {
      kind: "plain-text",
      text: "reaction conditions: rt, 1 h",
      warnings: []
    }, { x: 96, y: 112 }, {
      fontSizePx: 18,
      color: "#1f5fbf"
    });
    const textObject = getSelectedTextObject(result.document);
    const molecule = result.document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");

    expect(result).toMatchObject({
      status: "Pasted editable text",
      kind: "plain-text",
      editTextObjectId: textObject?.id
    });
    expect(textObject).toMatchObject({
      type: "text",
      text: "reaction conditions: rt, 1 h",
      style: {
        fontSizePx: 18,
        color: "#1f5fbf"
      }
    });
    expect(molecule?.atoms).toHaveLength(2);
    expect(molecule?.bonds).toHaveLength(1);
  });

  it("sizes pasted text boxes to the text block instead of a fixed placeholder frame", () => {
    const document = createPhase4Document("Auto-fit Text Paste");
    const shortResult = applyClipboardPastePayload(document, {
      kind: "plain-text",
      text: "rt",
      warnings: []
    }, { x: 80, y: 90 }, { fontSizePx: 18 });
    const longResult = applyClipboardPastePayload(document, {
      kind: "plain-text",
      text: "reaction conditions: room temperature\nthen reflux overnight",
      warnings: []
    }, { x: 80, y: 90 }, { fontSizePx: 18 });
    const shortText = getSelectedTextObject(shortResult.document);
    const longText = getSelectedTextObject(longResult.document);

    expect(shortText?.width).toBeGreaterThanOrEqual(nativeTextObjectMinimumDimensions.width);
    expect(shortText?.height).toBeGreaterThanOrEqual(nativeTextObjectMinimumDimensions.height);
    expect(shortText?.width).toBeLessThan(80);
    expect(longText?.width).toBeGreaterThan(shortText?.width ?? 0);
    expect(longText?.height).toBeGreaterThan(shortText?.height ?? 0);
  });

  it("lets text boxes stretch from the sides and reflows text within the resized width", () => {
    const document = insertNativeTextObject(
      createPhase4Document("Resizable Text"),
      { x: 120, y: 140 },
      "long reaction note that should wrap after the box is narrowed",
      { fontSizePx: 18 }
    );
    const text = getSelectedTextObject(document);
    if (!text) {
      throw new Error("Expected selected text object.");
    }
    const naturalSize = nativeTextObjectSizeForText(text.text, text.style, {
      maxWidth: document.pages[0].width - text.x
    });
    const narrowed = resizeNativeTextObjectBox(document, text.id, { x: text.x + 24, width: 72 });
    const narrowedText = getSelectedTextObject(narrowed);
    if (!narrowedText) {
      throw new Error("Expected selected resized text object.");
    }
    const shortened = updateNativeTextObjectText(narrowed, narrowedText.id, "short note");
    const shortenedText = getSelectedTextObject(shortened);

    expect(text.width).toEqual(naturalSize.width);
    expect(narrowedText.x).toBe(text.x + 24);
    expect(narrowedText.width).toBe(72);
    expect(narrowedText.height).toBeGreaterThan(text.height);
    expect(narrowedText.style.textBoxSizingMode).toBe("fixed-width");
    expect(shortenedText?.width).toBe(72);
    expect(shortenedText?.height).toBeLessThan(narrowedText.height);
  });

  it("pastes MOL clipboard payloads as native molecule geometry", () => {
    const document = createPhase4Document("Clipboard MOL");
    const result = applyClipboardPastePayload(document, {
      kind: "molfile",
      format: "molfile-v2000",
      text: clipboardEtheneMolfile,
      warnings: []
    }, { x: 260, y: 260 });
    const molecule = selectedMolecule(result.document);

    expect(result).toMatchObject({
      status: "Pasted editable MOL V2000 structure",
      kind: "molfile",
      selectedObjectId: molecule?.id
    });
    expect(molecule?.structureFormat).toBe("molfile-v2000");
    expect(molecule?.structure).toBe(clipboardEtheneMolfile);
    expect(molecule?.atoms).toHaveLength(2);
    expect(molecule?.atoms.map((atom) => atom.element)).toEqual(["C", "O"]);
    expect(molecule?.bonds).toEqual([
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "double" }
    ]);
    expect(molecule?.compatibility?.warnings.map((warning) => warning.code)).toContain("clipboard.molfile_imported");
  });

  it("pastes ChemDraw Mac MOL clipboard payloads as native molecule geometry", () => {
    const detectedPayload = inspectClipboardPayload({
      types: [
        "com.adobe.pdf",
        "com.revvity.chemdraw.cdx-clipboard",
        "com.mdli.molfile",
        "org.opensmiles.smiles"
      ],
      textItems: [
        { type: "com.mdli.molfile", text: chemdrawMacClipboardMolfile },
        { type: "org.opensmiles.smiles", text: "CCOOCC\0" }
      ]
    });
    const result = applyClipboardPastePayload(
      createPhase4Document("ChemDraw Clipboard MOL"),
      detectedPayload,
      { x: 260, y: 260 }
    );
    const molecule = selectedMolecule(result.document);

    expect(result).toMatchObject({
      status: "Pasted editable MOL V2000 structure",
      kind: "molfile",
      selectedObjectId: molecule.id
    });
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["C", "C", "O", "O", "C", "C"]);
    expect(molecule.bonds).toHaveLength(5);
    expect(molecule.structure).toContain("\nM  END");
    expectNoDuplicateAtomPositions(molecule);
  });

  it("lets ChemDraw Mac MOL paste use native atom and bond editing tools", () => {
    const detectedPayload = inspectClipboardPayload({
      types: [
        "com.adobe.pdf",
        "com.revvity.chemdraw.cdx-clipboard",
        "com.mdli.molfile",
        "org.opensmiles.smiles"
      ],
      textItems: [
        { type: "com.mdli.molfile", text: chemdrawMacClipboardMolfile },
        { type: "org.opensmiles.smiles", text: "CCOOCC\0" }
      ]
    });
    const result = applyClipboardPastePayload(
      createPhase4Document("Editable ChemDraw Paste"),
      detectedPayload,
      { x: 260, y: 260 }
    );
    const molecule = selectedMolecule(result.document);
    const degrees = atomDegreeMap(molecule);
    const terminalCarbon = molecule.atoms.find((atom) => atom.element === "C" && (degrees.get(atom.id) ?? 0) <= 1);
    const carbonCarbonBond = molecule.bonds.find((bond) => {
      const fromAtom = molecule.atoms.find((atom) => atom.id === bond.fromAtomId);
      const toAtom = molecule.atoms.find((atom) => atom.id === bond.toAtomId);
      return bond.order === "single" && fromAtom?.element === "C" && toAtom?.element === "C";
    });
    if (!terminalCarbon || !carbonCarbonBond) {
      throw new Error("Expected terminal carbon and C-C bond in pasted ChemDraw MOL fixture.");
    }

    expect(molecule.style.source).toBe("clipboard-molfile");
    expect(findNativeMoleculeAtomHit(molecule, terminalCarbon)).toMatchObject({
      atomId: terminalCarbon.id,
      distance: 0
    });

    const cycledBondDocument = applyNativeMoleculeBondOrderTarget(result.document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: carbonCarbonBond.id,
      fromAtomId: carbonCarbonBond.fromAtomId,
      toAtomId: carbonCarbonBond.toAtomId,
      distanceToPointer: 0
    });
    const cycledBondMolecule = selectedMolecule(cycledBondDocument);
    expect(cycledBondMolecule.bonds.find((bond) => bond.id === carbonCarbonBond.id)?.order).toBe("double");

    const grownDocument = applySingleBondToolAtNativeAtom(result.document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: terminalCarbon.id,
      distanceToPointer: 0
    }, {
      x: terminalCarbon.x - 4,
      y: terminalCarbon.y + 4
    });
    const grown = selectedMolecule(grownDocument);
    const newAtom = grown.atoms.find((atom) => !molecule.atoms.some((previous) => previous.id === atom.id));
    if (!newAtom) {
      throw new Error("Expected native bond growth to add an atom to pasted molecule.");
    }

    expect(grown.atoms).toHaveLength(molecule.atoms.length + 1);
    expect(grown.bonds).toHaveLength(molecule.bonds.length + 1);
    expect(grown.bonds.at(-1)).toMatchObject({
      fromAtomId: terminalCarbon.id,
      toAtomId: newAtom.id,
      order: "single"
    });

    const relabeledDocument = applyNativeAtomElementTarget(grownDocument, {
      objectId: grown.id,
      kind: "atom",
      atomId: newAtom.id,
      distanceToPointer: 0
    }, "N");
    const relabeled = selectedMolecule(relabeledDocument);
    expect(relabeled.atoms.find((atom) => atom.id === newAtom.id)).toMatchObject({ element: "N" });

    const withCharge = applyChargeToolAtNativeAtom(relabeledDocument, 1, {
      objectId: relabeled.id,
      kind: "atom",
      atomId: newAtom.id,
      distanceToPointer: 0
    });
    const chargeMark = withCharge.pages[0].objects.find((object): object is ElectronMarkObject =>
      object.type === "electron-mark" && object.markKind === "charge"
    );
    expect(chargeMark).toMatchObject({ charge: 1 });
    expect(withCharge.selection.objectIds).toEqual([chargeMark?.id]);

    const deletedDocument = applyNativeMoleculeDeleteTarget(relabeledDocument, {
      objectId: relabeled.id,
      kind: "atom",
      atomId: newAtom.id,
      distanceToPointer: 0
    });
    const deleted = selectedMolecule(deletedDocument);
    expect(deleted.atoms).toHaveLength(molecule.atoms.length);
    expect(deleted.bonds).toHaveLength(molecule.bonds.length);
    expect(deleted.atoms.some((atom) => atom.id === newAtom.id)).toBe(false);
  });

  it("pastes editable molecule blocks from ChemDraw Mac RXN wrapper clipboard payloads", () => {
    const detectedPayload = inspectClipboardPayload({
      types: [
        "com.adobe.pdf",
        "com.revvity.chemdraw.cdx-clipboard",
        "com.mdli.molfile",
        "org.opensmiles.smiles"
      ],
      textItems: [
        { type: "com.mdli.molfile", text: chemdrawMacClipboardRxnfile },
        { type: "org.opensmiles.smiles", text: "CO.CC\0" }
      ]
    });
    const result = applyClipboardPastePayload(
      createPhase4Document("ChemDraw Clipboard RXN"),
      detectedPayload,
      { x: 260, y: 260 }
    );
    const molecules = result.document.pages[0].objects
      .filter((object): object is MoleculeObject => object.type === "molecule");

    expect(result).toMatchObject({
      status: "Pasted 2 editable RXN molecule blocks",
      kind: "rxnfile",
      selectedObjectId: molecules[1].id
    });
    expect(result.warnings.map((warning) => warning.code)).toContain("clipboard.rxn_mol_blocks_imported");
    expect(molecules).toHaveLength(2);
    expect(molecules[0].atoms.map((atom) => atom.element)).toEqual(["C", "O"]);
    expect(molecules[1].bonds[0]?.order).toBe("double");
    expectNoDuplicateAtomPositions(molecules[0]);
    expectNoDuplicateAtomPositions(molecules[1]);
  });

  it("lets extracted ChemDraw RXN molecule blocks use native graph editing tools", () => {
    const detectedPayload = inspectClipboardPayload({
      types: [
        "com.adobe.pdf",
        "com.revvity.chemdraw.cdx-clipboard",
        "com.mdli.molfile",
        "org.opensmiles.smiles"
      ],
      textItems: [
        { type: "com.mdli.molfile", text: chemdrawMacClipboardRxnfile },
        { type: "org.opensmiles.smiles", text: "CO.CC\0" }
      ]
    });
    const result = applyClipboardPastePayload(
      createPhase4Document("Editable RXN Paste"),
      detectedPayload,
      { x: 260, y: 260 }
    );
    const molecule = selectedMolecule(result.document);
    const atom = molecule.atoms[0];
    const bond = molecule.bonds[0];
    if (!atom || !bond) {
      throw new Error("Expected selected RXN molecule block with atoms and bonds.");
    }

    expect(molecule.style.source).toBe("clipboard-molfile");
    expect(findNativeMoleculeAtomHit(molecule, atom)).toMatchObject({ atomId: atom.id });

    const withGrownBond = applySingleBondToolAtNativeAtom(result.document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: atom.id,
      distanceToPointer: 0
    }, {
      x: atom.x - 4,
      y: atom.y + 4
    });
    expect(selectedMolecule(withGrownBond).atoms).toHaveLength(molecule.atoms.length + 1);

    const withCycledBond = applyNativeMoleculeBondOrderTarget(result.document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: bond.id,
      fromAtomId: bond.fromAtomId,
      toAtomId: bond.toAtomId,
      distanceToPointer: 0
    });
    expect(selectedMolecule(withCycledBond).bonds.find((candidate) => candidate.id === bond.id)?.order).toBe("triple");
  });

  it("can insert MOL clipboard payloads directly", () => {
    const document = insertNativeMolfileMolecule(
      createPhase4Document("Direct MOL Paste"),
      { x: 240, y: 240 },
      clipboardEtheneMolfile,
      "molfile-v2000"
    );
    const molecule = selectedMolecule(document);

    expect(molecule.atoms).toHaveLength(2);
    expect(molecule.bonds[0]?.order).toBe("double");
    expectNoDuplicateAtomPositions(molecule);
  });

  it("does not fake unsupported CDX, CDXML, RXN, or vector-only clipboard payloads", () => {
    const document = createPhase4Document("Unsupported Clipboard");
    const unsupportedPayloads = [
      {
        kind: "cdxml" as const,
        text: "<CDXML />",
        warnings: [{ code: "clipboard.cdxml_not_implemented", message: "CDXML not implemented." }]
      },
      {
        kind: "cdx" as const,
        warnings: [{ code: "clipboard.cdx_not_implemented", message: "CDX not implemented." }]
      },
      {
        kind: "rxnfile" as const,
        text: "$RXN",
        warnings: [{ code: "clipboard.rxn_not_implemented", message: "RXN not implemented." }]
      },
      {
        kind: "vector-only" as const,
        warnings: [{ code: "clipboard.vector_only", message: "Vector-only payload." }]
      }
    ];

    unsupportedPayloads.forEach((payload) => {
      const result = applyClipboardPastePayload(document, payload, { x: 100, y: 100 });
      expect(result.document).toBe(document);
      expect(result.status).toBe(payload.warnings[0].message);
      expect(result.warnings).toEqual(payload.warnings);
    });
  });

  it("adds a native single bond directly from a hovered atom target", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Hovered Bond Growth"), { x: 300, y: 300 });
    const molecule = selectedMolecule(document);
    const withBond = applySingleBondToolAtNativeAtom(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    });
    const grown = selectedMolecule(withBond);

    expect(grown.atoms).toHaveLength(3);
    expect(grown.bonds).toHaveLength(2);
    expect(grown.bonds.at(-1)).toMatchObject({ fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" });
    expect(grown.chemistry).toMatchObject({ formula: "C3H8", atomCount: 3, bondCount: 2 });
  });

  it("uses the hovered steering point when shortcut-growing a native single bond", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Shortcut Bond Steering"), { x: 300, y: 300 });
    const molecule = selectedMolecule(document);
    const terminalAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!terminalAtom) {
      throw new Error("Expected terminal atom.");
    }
    const target = {
      objectId: molecule.id,
      kind: "atom" as const,
      atomId: terminalAtom.id,
      distanceToPointer: 0
    };
    const upward = applySingleBondToolAtNativeAtom(document, target, {
      x: terminalAtom.x + 4,
      y: terminalAtom.y - 4
    });
    const downward = applySingleBondToolAtNativeAtom(document, target, {
      x: terminalAtom.x + 4,
      y: terminalAtom.y + 4
    });
    const upwardAtom = selectedMolecule(upward).atoms.at(-1);
    const downwardAtom = selectedMolecule(downward).atoms.at(-1);

    expect(upwardAtom?.id).toBe("atom_003");
    expect(downwardAtom?.id).toBe("atom_003");
    expect(upwardAtom?.y).toBeLessThan(terminalAtom.y);
    expect(downwardAtom?.y).toBeGreaterThan(terminalAtom.y);
  });

  it("finds atom delete hits before nearby bond hits", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Delete Hit"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const terminalAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!terminalAtom) {
      throw new Error("Expected terminal atom.");
    }

    expect(findNativeMoleculeDeleteHit(molecule, terminalAtom)).toEqual({
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    });
    expect(findNativeMoleculeDeleteHit(molecule, { x: 200, y: 224 })).toMatchObject({
      kind: "bond",
      bondId: "bond_001",
      terminalAtomId: expect.any(String),
      distanceToPointer: 4
    });
  });

  it("deletes a hovered atom and its incident bonds through a document patch", () => {
    const butane = growFromAtom(
      growFromAtom(
        insertNativeSingleBondMolecule(createPhase4Document("Delete Atom"), { x: 220, y: 260 }),
        "atom_002",
        -70.5
      ),
      "atom_003",
      0
    );
    const deleted = applyNativeMoleculeDeleteTarget(butane, {
      objectId: selectedMolecule(butane).id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    });
    const molecule = selectedMolecule(deleted);

    expect(molecule.atoms.map((atom) => atom.id)).toEqual(["atom_001", "atom_003", "atom_004"]);
    expect(molecule.bonds).toEqual([
      { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" }
    ]);
    expect(molecule.structure).toBe("C.CC");
    expect(molecule.chemistry).toMatchObject({ formula: "C3H10", atomCount: 3, bondCount: 1 });
    expect(getSelectedMolecule(butane)?.atoms).toHaveLength(4);
  });

  it("deletes a terminal bond and the terminal atom together", () => {
    const propane = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Delete Terminal Bond"), { x: 220, y: 260 }),
      "atom_002",
      -70.5
    );
    const molecule = selectedMolecule(propane);
    const deleted = applyNativeMoleculeDeleteTarget(propane, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002",
      fromAtomId: "atom_002",
      toAtomId: "atom_003",
      terminalAtomId: "atom_003",
      distanceToPointer: 0
    });
    const nextMolecule = selectedMolecule(deleted);

    expect(nextMolecule.atoms.map((atom) => atom.id)).toEqual(["atom_001", "atom_002"]);
    expect(nextMolecule.bonds.map((bond) => bond.id)).toEqual(["bond_001"]);
    expect(nextMolecule.structure).toBe("CC");
    expect(nextMolecule.chemistry).toMatchObject({ formula: "C2H6", atomCount: 2, bondCount: 1 });
  });

  it("deletes a middle bond without deleting either carbon", () => {
    const butane = growFromAtom(
      growFromAtom(
        insertNativeSingleBondMolecule(createPhase4Document("Delete Middle Bond"), { x: 220, y: 260 }),
        "atom_002",
        -70.5
      ),
      "atom_003",
      0
    );
    const molecule = selectedMolecule(butane);
    const deleted = applyNativeMoleculeDeleteTarget(butane, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002",
      fromAtomId: "atom_002",
      toAtomId: "atom_003",
      distanceToPointer: 0
    });
    const nextMolecule = selectedMolecule(deleted);

    expect(nextMolecule.atoms).toHaveLength(4);
    expect(nextMolecule.bonds.map((bond) => bond.id)).toEqual(["bond_001", "bond_003"]);
    expect(nextMolecule.structure).toBe("CC.CC");
    expect(nextMolecule.chemistry).toMatchObject({ formula: "C4H12", atomCount: 4, bondCount: 2 });
  });

  it("keeps a single carbon after deleting the only bond, then removes the object when that atom is deleted", () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Delete To Empty"), { x: 220, y: 260 });
    const methane = applyNativeMoleculeDeleteTarget(ethane, {
      objectId: selectedMolecule(ethane).id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      terminalAtomId: "atom_002",
      distanceToPointer: 0
    });
    const methaneMolecule = selectedMolecule(methane);

    expect(methaneMolecule.atoms.map((atom) => atom.id)).toEqual(["atom_001"]);
    expect(methaneMolecule.bonds).toEqual([]);
    expect(methaneMolecule.structure).toBe("C");
    expect(methaneMolecule.chemistry).toMatchObject({ formula: "CH4", atomCount: 1, bondCount: 0 });

    const empty = applyNativeMoleculeDeleteTarget(methane, {
      objectId: methaneMolecule.id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    });

    expect(empty.pages[0].objects).toEqual([]);
    expect(empty.selection.objectIds).toEqual([]);
  });

  it("stress-tests repeated hover-style bond deletion without corrupting carbon counts", () => {
    const hexane = growHexaneChain(
      insertNativeSingleBondMolecule(createPhase4Document("Delete Stress"), { x: 240, y: 320 })
    );
    const split = applyNativeMoleculeDeleteTarget(hexane, {
      objectId: selectedMolecule(hexane).id,
      kind: "bond",
      bondId: "bond_003",
      fromAtomId: "atom_003",
      toAtomId: "atom_004",
      distanceToPointer: 0
    });
    const trimmed = applyNativeMoleculeDeleteTarget(split, {
      objectId: selectedMolecule(split).id,
      kind: "bond",
      bondId: "bond_005",
      fromAtomId: "atom_005",
      toAtomId: "atom_006",
      terminalAtomId: "atom_006",
      distanceToPointer: 0
    });
    const molecule = selectedMolecule(trimmed);
    const degrees = atomDegreeMap(molecule);

    expect(selectedMolecule(hexane).atoms).toHaveLength(6);
    expect(selectedMolecule(split).atoms).toHaveLength(6);
    expect(selectedMolecule(split).bonds).toHaveLength(4);
    expect(selectedMolecule(split).structure).toBe("CCC.CCC");
    expect(molecule.atoms).toHaveLength(5);
    expect(molecule.bonds).toHaveLength(3);
    expect(molecule.structure).toBe("CCC.CC");
    expect(molecule.chemistry).toMatchObject({ formula: "C5H14", atomCount: 5, bondCount: 3 });
    expect(Math.max(...degrees.values())).toBeLessThanOrEqual(4);
  });

  it("builds 2-methylhexane as a branched carbon graph without deleting atoms", () => {
    const hexane = growHexaneChain(
      insertNativeSingleBondMolecule(createPhase4Document("2-methylhexane"), { x: 240, y: 320 })
    );
    const branched = growFromAtom(hexane, "atom_002", 90);
    const molecule = selectedMolecule(branched);
    const degrees = atomDegreeMap(molecule);

    expect(molecule.atoms).toHaveLength(7);
    expect(molecule.bonds).toHaveLength(6);
    expect(molecule.chemistry).toMatchObject({ formula: "C7H16", atomCount: 7, bondCount: 6 });
    expect(degrees.get("atom_002")).toBe(3);
    expect(Math.max(...degrees.values())).toBeLessThanOrEqual(4);
    expect(longestPathLength(molecule)).toBe(6);
    expect(molecule.structure).toBe("CC(C)CCCC");
    expectNoDuplicateAtomPositions(molecule);
  });

  it("builds neopentane around a tetravalent center without rejecting the fourth carbon bond", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Neopentane"), { x: 300, y: 300 });
    const withThreeBranches = [
      -109.5,
      109.5,
      180
    ].reduce((current, angle) => growFromAtom(current, "atom_001", angle), document);
    const molecule = selectedMolecule(withThreeBranches);
    const degrees = atomDegreeMap(molecule);

    expect(molecule.atoms).toHaveLength(5);
    expect(molecule.bonds).toHaveLength(4);
    expect(molecule.chemistry).toMatchObject({ formula: "C5H12", atomCount: 5, bondCount: 4 });
    expect(degrees.get("atom_001")).toBe(4);
    expect([...degrees.values()].filter((degree) => degree === 1)).toHaveLength(4);
    expect(molecule.structure).toBe("CC(C)(C)C");
    expectNoDuplicateAtomPositions(molecule);
    const overValent = growFromAtom(withThreeBranches, "atom_001", 0);
    const overValentMolecule = selectedMolecule(overValent);

    expect(overValentMolecule.atoms).toHaveLength(6);
    expect(overValentMolecule.bonds).toHaveLength(5);
    expect(atomDegreeMap(overValentMolecule).get("atom_001")).toBe(5);
    expect(overValentMolecule.chemistry).toMatchObject({ formula: "C6H15", totalCharge: 0 });
    expect(nativeMoleculeInvalidAtomStates(overValentMolecule)).toMatchObject([
      { atomId: "atom_001", element: "C", valenceUsed: 5, valid: false }
    ]);
  });

  it("deletes neopentane's central carbon into neutral methane fragments", () => {
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Delete Neopentane Center"), { x: 300, y: 300 })
    );
    const deleted = applyNativeMoleculeDeleteTarget(neopentane, {
      objectId: selectedMolecule(neopentane).id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    });
    const molecule = selectedMolecule(deleted);

    expect(molecule.atoms.map((atom) => atom.id)).toEqual(["atom_002", "atom_003", "atom_004", "atom_005"]);
    expect(molecule.bonds).toEqual([]);
    expect(molecule.structure).toBe("C.C.C.C");
    expect(molecule.chemistry).toMatchObject({ formula: "C4H16", atomCount: 4, bondCount: 0, totalCharge: 0 });
    expect(molecule.atoms.map((atom) => nativeAtomDisplayLabel(atom, molecule.bonds))).toEqual([
      "CH4",
      "CH4",
      "CH4",
      "CH4"
    ]);
    expect(molecule.atoms.some((atom) => atom.element === "H")).toBe(false);
  });

  it("marks neutral tetravalent nitrogen invalid until the user resolves the charge", () => {
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Tetravalent Nitrogen"), { x: 300, y: 300 })
    );
    const neutralHypervalent = setNativeAtomElement(neopentane, "atom_001", "N");
    const hypervalentMolecule = selectedMolecule(neutralHypervalent);
    const nitrogen = hypervalentMolecule.atoms.find((atom) => atom.id === "atom_001");

    expect(nitrogen).toMatchObject({ element: "N", formalCharge: 0 });
    expect(hypervalentMolecule.structure).not.toContain("[N+]");
    expect(hypervalentMolecule.chemistry).toMatchObject({ formula: "C4H12N", totalCharge: 0 });
    expect(hypervalentMolecule.chemistry?.warnings).toContainEqual({
      code: "chemistry.invalid_valence",
      message: "N atom atom_001 has charge 0, expected 1 for valence 4.",
      objectId: "atom_001"
    });
    expect(nativeMoleculeInvalidAtomStates(hypervalentMolecule)).toMatchObject([
      { atomId: "atom_001", element: "N", valenceUsed: 4, formalCharge: 0, expectedFormalCharge: 1, valid: false }
    ]);
    expect(nativeAtomDisplayLabel(nitrogen!, hypervalentMolecule.bonds)).toBe("N");

    const neutralAmine = applyNativeMoleculeDeleteTarget(neutralHypervalent, {
      objectId: hypervalentMolecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    });
    const neutralMolecule = selectedMolecule(neutralAmine);
    const neutralNitrogen = neutralMolecule.atoms.find((atom) => atom.id === "atom_001");

    expect(neutralNitrogen).toMatchObject({ element: "N", formalCharge: 0 });
    expect(neutralMolecule.chemistry).toMatchObject({ formula: "C3H9N", totalCharge: 0 });
    expect(nativeAtomDisplayLabel(neutralNitrogen!, neutralMolecule.bonds)).toBe("N");
    expect(neutralMolecule.atoms.find((atom) => atom.id === "atom_002")).toBeUndefined();
  });

  it("places and moves charge marks that resolve nearby hypervalent atoms only while close", () => {
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Movable Charge Resolution"), { x: 300, y: 300 })
    );
    const neutralHypervalent = setNativeAtomElement(neopentane, "atom_001", "N");
    const hypervalentMolecule = selectedMolecule(neutralHypervalent);
    const nitrogen = hypervalentMolecule.atoms.find((atom) => atom.id === "atom_001");
    if (!nitrogen) {
      throw new Error("Expected hypervalent nitrogen.");
    }
    expect(nativeMoleculeInvalidAtomStates(hypervalentMolecule)).toHaveLength(1);

    const withCharge = applyChargeToolAtPoint(neutralHypervalent, 1, {
      x: nitrogen.x + 11,
      y: nitrogen.y - 11
    });
    const chargeMark = withCharge.pages[0].objects.find((object): object is ElectronMarkObject =>
      object.type === "electron-mark" && object.markKind === "charge"
    );
    if (!chargeMark) {
      throw new Error("Expected inserted charge mark.");
    }

    expect(withCharge.selection.objectIds).toEqual([chargeMark.id]);
    expect(chargeMark.charge).toBe(1);
    expect(nativeChargeMarkCenter(chargeMark)).toMatchObject({
      x: nitrogen.x + 11,
      y: nitrogen.y - 11
    });

    const resolvedMolecule = withCharge.pages[0].objects.find((object): object is MoleculeObject =>
      object.id === hypervalentMolecule.id && object.type === "molecule"
    );
    if (!resolvedMolecule) {
      throw new Error("Expected molecule after charge insertion.");
    }
    const associations = nativeChargeAssociationsForMolecule(resolvedMolecule, withCharge.pages[0].objects);
    const chargeByAtomId = nativeChargeByAtomIdFromAssociations(associations);

    expect(associations).toMatchObject([
      { chargeObjectId: chargeMark.id, atomId: "atom_001", moleculeId: resolvedMolecule.id, charge: 1 }
    ]);
    expect(nativeMoleculeInvalidAtomStates(resolvedMolecule, chargeByAtomId)).toEqual([]);
    expect(nativeMoleculeInvalidAtomStates(resolvedMolecule)).toHaveLength(1);

    const movedAway = moveDocumentObject(withCharge, chargeMark.id, { x: nitrogen.x + 120, y: nitrogen.y + 80 });
    const movedCharge = movedAway.pages[0].objects.find((object): object is ElectronMarkObject =>
      object.id === chargeMark.id && object.type === "electron-mark"
    );
    const movedMolecule = movedAway.pages[0].objects.find((object): object is MoleculeObject =>
      object.id === hypervalentMolecule.id && object.type === "molecule"
    );
    if (!movedCharge || !movedMolecule) {
      throw new Error("Expected moved charge and molecule.");
    }

    expect(nativeChargeAssociationsForMolecule(movedMolecule, movedAway.pages[0].objects)).toEqual([]);
    expect(nativeMoleculeInvalidAtomStates(movedMolecule)).toHaveLength(1);
    expect(nativeChargeMarkCenter(movedCharge)).toMatchObject({
      x: movedCharge.x + movedCharge.width / 2,
      y: movedCharge.y + movedCharge.height / 2
    });
  });

  it("places atom-targeted charges into an open space that resolves matching hypervalence", () => {
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Atom Target Charge"), { x: 300, y: 300 })
    );
    const neutralHypervalent = setNativeAtomElement(neopentane, "atom_001", "N");
    const hypervalentMolecule = selectedMolecule(neutralHypervalent);
    const nitrogen = hypervalentMolecule.atoms.find((atom) => atom.id === "atom_001");
    if (!nitrogen) {
      throw new Error("Expected hypervalent nitrogen.");
    }
    const placement = nativeChargePlacementPointForAtom(
      hypervalentMolecule,
      nitrogen.id,
      neutralHypervalent.pages[0].objects,
      neutralHypervalent.pages[0].width,
      neutralHypervalent.pages[0].height
    );
    if (!placement) {
      throw new Error("Expected native charge placement.");
    }

    const withCharge = applyChargeToolAtNativeAtom(neutralHypervalent, 1, {
      objectId: hypervalentMolecule.id,
      kind: "atom",
      atomId: nitrogen.id,
      distanceToPointer: 0
    });
    const chargeMark = withCharge.pages[0].objects.find((object): object is ElectronMarkObject =>
      object.type === "electron-mark" && object.markKind === "charge"
    );
    const resolvedMolecule = withCharge.pages[0].objects.find((object): object is MoleculeObject =>
      object.id === hypervalentMolecule.id && object.type === "molecule"
    );
    if (!chargeMark || !resolvedMolecule) {
      throw new Error("Expected atom-targeted charge and molecule.");
    }

    expect(withCharge.selection.objectIds).toEqual([chargeMark.id]);
    expect(nativeChargeMarkCenter(chargeMark)).toMatchObject(placement);
    expect(pointDistance(nativeChargeMarkCenter(chargeMark), nitrogen)).toBeGreaterThan(nativeChargeMarkSizePx);
    expect(pointDistance(nativeChargeMarkCenter(chargeMark), nitrogen)).toBeLessThanOrEqual(nativeChargeAssociationRadiusPx);
    const chargeByAtomId = nativeChargeByAtomIdFromAssociations(
      nativeChargeAssociationsForMolecule(resolvedMolecule, withCharge.pages[0].objects)
    );
    expect(chargeByAtomId.get(nitrogen.id)).toBe(1);
    expect(nativeMoleculeInvalidAtomStates(resolvedMolecule, chargeByAtomId)).toEqual([]);
  });

  it("places atom-targeted charges away from the only existing bond when space is obvious", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Open Charge Placement"), { x: 300, y: 300 });
    const molecule = selectedMolecule(document);
    const leftAtom = molecule.atoms.find((atom) => atom.id === "atom_001");
    if (!leftAtom) {
      throw new Error("Expected left atom.");
    }
    const placement = nativeChargePlacementPointForAtom(
      molecule,
      leftAtom.id,
      document.pages[0].objects,
      document.pages[0].width,
      document.pages[0].height
    );

    expect(placement?.x).toBeLessThan(leftAtom.x);
  });

  it("uses negative charge marks to resolve neutral tetravalent boron", () => {
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Boron Charge Resolution"), { x: 300, y: 300 })
    );
    const neutralBorate = setNativeAtomElement(neopentane, "atom_001", "B");
    const molecule = selectedMolecule(neutralBorate);
    const boron = molecule.atoms.find((atom) => atom.id === "atom_001");
    if (!boron) {
      throw new Error("Expected hypervalent boron.");
    }

    expect(nativeMoleculeInvalidAtomStates(molecule)).toMatchObject([
      { atomId: "atom_001", element: "B", valenceUsed: 4, formalCharge: 0, expectedFormalCharge: -1, valid: false }
    ]);

    const withNegativeCharge = applyChargeToolAtPoint(neutralBorate, -1, {
      x: boron.x + 11,
      y: boron.y - 11
    });
    const resolvedMolecule = withNegativeCharge.pages[0].objects.find((object): object is MoleculeObject =>
      object.id === molecule.id && object.type === "molecule"
    );
    if (!resolvedMolecule) {
      throw new Error("Expected resolved boron molecule.");
    }
    const chargeByAtomId = nativeChargeByAtomIdFromAssociations(
      nativeChargeAssociationsForMolecule(resolvedMolecule, withNegativeCharge.pages[0].objects)
    );

    expect(chargeByAtomId.get("atom_001")).toBe(-1);
    expect(nativeMoleculeInvalidAtomStates(resolvedMolecule, chargeByAtomId)).toEqual([]);
  });

  it("builds 3-methyl-4-tert-butylheptane with correct connectivity and geometry slots", () => {
    const heptane = growHeptaneChain(
      insertNativeSingleBondMolecule(createPhase4Document("3-methyl-4-tert-butylheptane"), { x: 320, y: 420 })
    );
    const withMethyl = growFromAtom(heptane, "atom_003", 240);
    const withTertButylStem = growFromAtom(withMethyl, "atom_004", -70.5);
    const tertButylCenterId = selectedMolecule(withTertButylStem).atoms.at(-1)?.id;
    if (!tertButylCenterId) {
      throw new Error("Expected tert-butyl branch center.");
    }
    const finalDocument = [0, 120, 240].reduce(
      (current, angle) => growFromAtom(current, tertButylCenterId, angle),
      withTertButylStem
    );
    const molecule = selectedMolecule(finalDocument);
    const degrees = atomDegreeMap(molecule);

    expect(molecule.atoms).toHaveLength(12);
    expect(molecule.bonds).toHaveLength(11);
    expect(molecule.chemistry).toMatchObject({ formula: "C12H26", atomCount: 12, bondCount: 11 });
    expect(degrees.get("atom_003")).toBe(3);
    expect(degrees.get("atom_004")).toBe(3);
    expect(degrees.get(tertButylCenterId)).toBe(4);
    expect(Math.max(...degrees.values())).toBeLessThanOrEqual(4);
    expect(longestPathLength(molecule)).toBe(7);
    expect(molecule.structure).toBe("CCC(C)C(C(C)(C)(C))CCC");
    expectNoDuplicateAtomPositions(molecule);
  });

  it("starts a separate bond when the click is away from the selected molecule terminals", () => {
    const withBond = insertNativeSingleBondMolecule(createPhase4Document("Separate Bonds"), { x: 200, y: 220 });
    const next = applySingleBondToolAtPoint(withBond, { x: 600, y: 600 });

    expect(next.pages[0].objects).toHaveLength(2);
    expect(next.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_001", "mol_bond_002"]);
    expect(next.selection.objectIds).toEqual(["mol_bond_002"]);
  });

  it("exports the Phase 4 subset as SVG", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("SVG Fixture"));
    const result = exportPhase4Svg(document);

    expect(result.format).toBe("svg");
    expect(result.contents).toContain('aria-label="SVG Fixture"');
    expect(result.contents).toContain('data-object-type="molecule"');
    expect(result.contents).toContain("CCO");
  });

  it("exports native single-bond molecules as bond geometry", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Bond SVG"), { x: 200, y: 220 });
    const result = exportPhase4Svg(document);

    expect(result.contents).toContain('data-chem-primitive="single-bond"');
    expect(result.contents).toContain('data-structure="CC"');
    expect(result.contents).toContain("<line");
    expect(result.contents).not.toContain(">CC</text>");
  });

  it("exports connected native molecule graphs as connected bond geometry", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Chain SVG"), { x: 200, y: 220 }),
      "atom_002",
      0
    );
    const result = exportPhase4Svg(document);

    expect(result.contents).toContain('data-chem-primitive="connected-carbon-chain"');
    expect(result.contents).toContain('data-structure="CCC"');
    expect(result.contents).toContain('data-atom-count="3"');
    expect(result.contents).toContain('data-bond-count="2"');
    expect(result.contents.match(/data-bond-id="/g)?.length).toBe(4);
    expect(result.contents.match(/stroke="#ffffff"/g)?.length).toBe(2);
    expect(result.contents.match(/stroke="#000000"/g)?.length).toBe(2);
  });

  it("applies Phase 5 chemistry analysis to the selected molecule through a document patch", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("Analysis Fixture"));
    const analyzed = applyAnalysisToSelectedMolecule(document, {
      input: { format: "smiles", value: "CCO" },
      validation: { valid: true, errors: [], warnings: [] },
      properties: {
        formula: "C2H6O",
        averageMass: 46.069,
        exactMass: 46.0419,
        totalCharge: 0,
        atomCount: 3,
        bondCount: 2,
        stereochemistry: []
      },
      warnings: []
    });

    expect(getSelectedMolecule(analyzed)?.chemistry).toMatchObject({
      formula: "C2H6O",
      averageMass: 46.069,
      exactMass: 46.0419,
      atomCount: 3,
      bondCount: 2,
      totalCharge: 0
    });
    expect(getSelectedMolecule(document)?.chemistry).toBeUndefined();
  });

  it("applies an editor adapter save result through a selected-object document patch", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("Editor Fixture"));
    const selected = getSelectedMolecule(document);
    if (!selected) {
      throw new Error("Expected fixture molecule to be selected.");
    }

    const updated = applyEditorSaveResultToSelectedObject(document, {
      object: {
        ...selected,
        structureFormat: "molfile-v3000",
        structure: "updated-molfile"
      },
      warnings: []
    });

    expect(getSelectedMolecule(updated)).toMatchObject({
      id: selected.id,
      structureFormat: "molfile-v3000",
      structure: "updated-molfile"
    });
    expect(getSelectedMolecule(document)).toMatchObject({
      id: selected.id,
      structureFormat: "smiles",
      structure: "CCO"
    });
  });

  it("applies editor saves only to the selected molecule while preserving page state", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Editor Preserve"), { x: 200, y: 220 });
    const selected = getSelectedMolecule(document);
    if (!selected) {
      throw new Error("Expected fixture molecule to be selected.");
    }
    const conditionText: TextObject = {
      id: "text_001",
      type: "text",
      x: 420,
      y: 220,
      width: 160,
      height: 30,
      rotation: 0,
      style: {},
      text: "rt, 1 h",
      spans: []
    };
    const withOtherObject = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0].id, object: conditionText },
      { op: "setSelection", pageId: document.pages[0].id, objectIds: [selected.id] }
    ]);

    const updated = applyEditorSaveResultToSelectedMolecule(withOtherObject, {
      object: {
        ...selected,
        structureFormat: "molfile-v3000",
        structure: "edited-molfile-v3000"
      },
      warnings: []
    });

    expect(updated.pages[0].layout).toEqual(withOtherObject.pages[0].layout);
    expect(updated.pages[0].objects).toHaveLength(2);
    expect(updated.pages[0].objects[1]).toEqual(conditionText);
    expect(updated.selection).toEqual(withOtherObject.selection);
    expect(getSelectedMolecule(updated)).toMatchObject({
      id: selected.id,
      structureFormat: "molfile-v3000",
      structure: "edited-molfile-v3000"
    });
    expect(getSelectedMolecule(withOtherObject)?.structure).toBe("CC");
  });

  it("syncs Ketcher V3000 saves into the selected molecule preview graph", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Ketcher Sync"), { x: 200, y: 220 });
    const selected = getSelectedMolecule(document);
    if (!selected) {
      throw new Error("Expected fixture molecule to be selected.");
    }

    const v3000 = [
      "-INDIGO-05312621362D",
      "",
      "  0  0  0  0  0  0  0  0  0  0  0 V3000",
      "M  V30 BEGIN CTAB",
      "M  V30 COUNTS 3 2 0 0 0",
      "M  V30 BEGIN ATOM",
      "M  V30 1 C 7.81996 -2.80117 0.0 0",
      "M  V30 2 C 8.81996 -2.80117 0.0 0",
      "M  V30 3 C 9.81996 -2.80117 0.0 0",
      "M  V30 END ATOM",
      "M  V30 BEGIN BOND",
      "M  V30 1 1 1 2",
      "M  V30 2 1 2 3",
      "M  V30 END BOND",
      "M  V30 END CTAB",
      "M  END"
    ].join("\n");

    const updated = applyEditorSaveResultToSelectedMolecule(document, {
      object: {
        ...selected,
        structureFormat: "molfile-v3000",
        structure: v3000
      },
      warnings: []
    });
    const molecule = getSelectedMolecule(updated);
    const previewCenterX = selected.x + selected.width / 2;

    expect(molecule).toMatchObject({
      id: selected.id,
      structureFormat: "molfile-v3000",
      structure: v3000,
      style: { source: "ketcher-adapter" },
      atoms: [
        { id: "atom_001", element: "C", x: previewCenterX - nativeBondLengthPx, y: 220 },
        { id: "atom_002", element: "C", x: previewCenterX, y: 220 },
        { id: "atom_003", element: "C", x: previewCenterX + nativeBondLengthPx, y: 220 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
        { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" }
      ]
    });
    expect(molecule?.style.drawingPrimitive).toBeUndefined();
    expect(molecule?.chemistry).toBeUndefined();
    expect(updated.selection).toEqual(document.selection);
  });

  it("rejects editor saves when the selected object is not a molecule", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Wrong Selection"), { x: 200, y: 220 });
    const selected = getSelectedMolecule(document);
    if (!selected) {
      throw new Error("Expected fixture molecule to be selected.");
    }
    const conditionText: TextObject = {
      id: "text_001",
      type: "text",
      x: 420,
      y: 220,
      width: 160,
      height: 30,
      rotation: 0,
      style: {},
      text: "rt, 1 h",
      spans: []
    };
    const withTextSelected = applyPatches(document, [
      { op: "addObject", pageId: document.pages[0].id, object: conditionText },
      { op: "setSelection", pageId: document.pages[0].id, objectIds: [conditionText.id] }
    ]);

    expect(() =>
      applyEditorSaveResultToSelectedMolecule(withTextSelected, {
        object: {
          ...selected,
          structureFormat: "molfile-v3000",
          structure: "edited-molfile-v3000"
        },
        warnings: []
      })
    ).toThrow("no molecule is selected");
    expect(withTextSelected.pages[0].objects[0]).toEqual(selected);
  });
});

function lengthPrefixedClipboardMolfile(lines: readonly string[]): string {
  return lines.map((line) => `\0${String.fromCharCode(line.length)}${line}`).join("");
}
