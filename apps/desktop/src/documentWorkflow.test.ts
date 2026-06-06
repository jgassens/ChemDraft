import { describe, expect, it } from "vitest";
import { applyPatches, type ChemDraftDocument, type ElectronMarkObject, type MoleculeObject, type TextObject } from "@chemdraft/chem-core";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import {
  applyChargeToolAtPoint,
  applyClipboardPastePayload,
  applyChargeToolAtNativeAtom,
  applyColorToDocumentObjects,
  applyColorToNativeMoleculePart,
  applyToolbarColorToSelection,
  applyAnalysisToSelectedMolecule,
  applyEditorSaveResultToSelectedMolecule,
  applyEditorSaveResultToSelectedObject,
  applyFreeformSingleBondToolAtPoint,
  applyNativeBondDisplayStyleTarget,
  applyNativeCarbonylAtAtomTarget,
  applyNativeAtomElementTarget,
  applyNativeDoubleBondSideTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget,
  applyNativeMoleculeDeleteTarget,
  applyNativeTemplateToolAtTarget,
  applySingleBondToolAtPoint,
  applySingleBondToolAtNativeAtom,
  cleanUpNativeMolecules2d,
  cleanUpSelectedNativeMolecule2d,
  createNativeSavePayload,
  createNativeSingleBondMolecule,
  createPhase4Document,
  deleteSelectedDocumentObjects,
  exportPhase4Svg,
  findNativeMoleculeDeleteHit,
  findNativeMoleculeAtomHit,
  getSelectedMolecule,
  insertAdapterFallbackMolecule,
  insertNativeTextObject,
  insertNativeMolfileMolecule,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
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
  nativeBondStyleForToolCommand,
  nativeElementFromAtomLabel,
  nativeElementFromKeyboardKey,
  nativeTemplateForToolCommand,
  normalizeNativeAtomElementLabel,
  nativeMoleculeInvalidAtomStates,
  nativeMoleculeTransformState,
  openNativeDocument,
  previewNativeMoleculeBondGrowth,
  previewNativeMoleculeFreeformBondGrowth,
  moveDocumentObject,
  moveNativeMoleculeParts,
  nativeTextObjectMinimumDimensions,
  nativeTextObjectSizeForText,
  reorderNativeMoleculeParts,
  reorderSelectedDocumentObject,
  resolveToolbarColorSelection,
  resizeNativeMoleculeParts,
  rotateDocumentObject,
  rotateNativeMoleculeObjectAroundPoint,
  rotateNativeMoleculeParts,
  resizeNativeMoleculeObject,
  resizeNativeTextObjectBox,
  selectAllDocumentObjects,
  updateNativeTextObjectScript,
  updateNativeTextObjectScriptRange,
  updateNativeTextObjectStyle,
  updateNativeTextObjectStyleRange,
  updateNativeTextObjectText
} from "./documentWorkflow";

function selectedMolecule(document: ChemDraftDocument): MoleculeObject {
  const molecule = getSelectedMolecule(document);
  if (!molecule) {
    throw new Error("Expected selected molecule.");
  }
  return molecule;
}

function moleculeById(document: ChemDraftDocument, objectId: string): MoleculeObject {
  const molecule = document.pages
    .flatMap((page) => page.objects)
    .find((object): object is MoleculeObject => object.id === objectId && object.type === "molecule");
  if (!molecule) {
    throw new Error(`Expected molecule "${objectId}".`);
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
    ["atom_002", -60],
    ["atom_003", 0],
    ["atom_004", 60],
    ["atom_005", 0]
  ].reduce((current, [atomId, angle]) => growFromAtom(current, String(atomId), Number(angle)), document);
}

function growHeptaneChain(document: ChemDraftDocument): ChemDraftDocument {
  return growFromAtom(growHexaneChain(document), "atom_006", -60);
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

function moleculeAtom(molecule: MoleculeObject, atomId: string): MoleculeObject["atoms"][number] {
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  if (!atom) {
    throw new Error(`Expected atom "${atomId}".`);
  }

  return atom;
}

function moleculeBondLength(molecule: MoleculeObject, bondId: string): number {
  const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
  if (!bond) {
    throw new Error(`Expected bond "${bondId}".`);
  }

  return pointDistance(moleculeAtom(molecule, bond.fromAtomId), moleculeAtom(molecule, bond.toAtomId));
}

function expectChairCyclohexaneSilhouette(molecule: MoleculeObject): void {
  molecule.bonds.forEach((bond) => {
    expect(moleculeBondLength(molecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
  });

  expectMoleculeHasChairCyclohexaneRing(molecule);
}

function expectMoleculeHasChairCyclohexaneRing(molecule: MoleculeObject): void {
  expect(testSixMemberCarbonRings(molecule).some((ring) => isChairCyclohexaneRing(molecule, ring))).toBe(true);
}

function isChairCyclohexaneRing(molecule: MoleculeObject, ring: TestRingCycle): boolean {
  const turns = ringTurnAngles(molecule, ring);
  const expectedTurns = [30, 30, 75, 75, 135, 135];

  return expectedTurns.every((expectedTurn, index) => {
    const turn = turns[index];
    return turn !== undefined && Math.abs(turn - expectedTurn) < 2;
  });
}

function ringTurnAngles(molecule: MoleculeObject, ring: TestRingCycle): number[] {
  const directions = ring.atomIds.map((atomId, index) => {
    const nextAtomId = ring.atomIds[(index + 1) % ring.atomIds.length] ?? atomId;
    const atom = moleculeAtom(molecule, atomId);
    const nextAtom = moleculeAtom(molecule, nextAtomId);
    return Math.atan2(nextAtom.y - atom.y, nextAtom.x - atom.x) * 180 / Math.PI;
  });

  return directions
    .map((direction, index) => Math.abs(normalizeSignedDegrees((directions[(index + 1) % directions.length] ?? direction) - direction)))
    .sort((left, right) => left - right);
}

function normalizeSignedDegrees(angle: number): number {
  const normalized = ((angle % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
}

function moleculeBond(molecule: MoleculeObject, bondId: string): MoleculeObject["bonds"][number] {
  const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
  if (!bond) {
    throw new Error(`Expected bond "${bondId}".`);
  }

  return bond;
}

function pointCentroid(points: readonly { x: number; y: number }[]): { x: number; y: number } {
  return points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 }
  );
}

function expectedDoubleBondSideTowardPoint(
  molecule: MoleculeObject,
  bondId: string,
  point: { x: number; y: number }
): "left" | "right" {
  const bond = moleculeBond(molecule, bondId);
  const fromAtom = moleculeAtom(molecule, bond.fromAtomId);
  const toAtom = moleculeAtom(molecule, bond.toAtomId);
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return "left";
  }

  const normal = { x: -dy / length, y: dx / length };
  const midpoint = { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };
  const score = (point.x - midpoint.x) * normal.x + (point.y - midpoint.y) * normal.y;
  return score >= 0 ? "left" : "right";
}

function expectDoubleBondInsideRing(
  molecule: MoleculeObject,
  bondId: string,
  ringAtomIds: readonly string[]
): void {
  const ringCenter = pointCentroid(ringAtomIds.map((atomId) => moleculeAtom(molecule, atomId)));
  const bond = moleculeBond(molecule, bondId);

  expect(bond.order).toBe("double");
  expect(bond.display?.doubleBondSide).toBe(expectedDoubleBondSideTowardPoint(molecule, bondId, ringCenter));
}

interface TestRingCycle {
  atomIds: string[];
  bondIds: string[];
}

function testSixMemberCarbonRings(molecule: MoleculeObject): TestRingCycle[] {
  const carbonAtomIds = new Set(molecule.atoms.filter((atom) => atom.element === "C").map((atom) => atom.id));
  const adjacency = new Map<string, { atomId: string; bondId: string }[]>();
  molecule.bonds.forEach((bond) => {
    if (!carbonAtomIds.has(bond.fromAtomId) || !carbonAtomIds.has(bond.toAtomId)) {
      return;
    }

    adjacency.set(bond.fromAtomId, [
      ...(adjacency.get(bond.fromAtomId) ?? []),
      { atomId: bond.toAtomId, bondId: bond.id }
    ]);
    adjacency.set(bond.toAtomId, [
      ...(adjacency.get(bond.toAtomId) ?? []),
      { atomId: bond.fromAtomId, bondId: bond.id }
    ]);
  });

  const rings = new Map<string, TestRingCycle>();
  const visit = (startAtomId: string, atomId: string, atomIds: string[], bondIds: string[]) => {
    if (atomIds.length === 6) {
      const closingBond = (adjacency.get(atomId) ?? []).find((edge) => edge.atomId === startAtomId);
      if (closingBond) {
        const nextBondIds = [...bondIds, closingBond.bondId];
        const key = [...nextBondIds].sort().join("|");
        rings.set(key, { atomIds, bondIds: nextBondIds });
      }
      return;
    }

    (adjacency.get(atomId) ?? []).forEach((edge) => {
      if (edge.atomId === startAtomId || atomIds.includes(edge.atomId)) {
        return;
      }

      visit(startAtomId, edge.atomId, [...atomIds, edge.atomId], [...bondIds, edge.bondId]);
    });
  };

  [...carbonAtomIds].forEach((atomId) => {
    visit(atomId, atomId, [atomId], []);
  });

  return [...rings.values()];
}

function expectAromaticDoubleBondsAreInternalPerimeterBonds(molecule: MoleculeObject): void {
  const rings = testSixMemberCarbonRings(molecule);
  const bondMembership = new Map<string, TestRingCycle[]>();
  rings.forEach((ring) => {
    ring.bondIds.forEach((bondId) => {
      bondMembership.set(bondId, [...(bondMembership.get(bondId) ?? []), ring]);
    });
  });

  molecule.bonds.filter((bond) => bond.order === "double").forEach((bond) => {
    const owningRings = bondMembership.get(bond.id) ?? [];
    expect(owningRings).toHaveLength(1);
    expectDoubleBondInsideRing(molecule, bond.id, owningRings[0]?.atomIds ?? []);
  });
}

function moleculeBondTarget(molecule: MoleculeObject, bondId: string) {
  const bond = moleculeBond(molecule, bondId);
  return {
    objectId: molecule.id,
    kind: "bond" as const,
    bondId: bond.id,
    fromAtomId: bond.fromAtomId,
    toAtomId: bond.toAtomId,
    distanceToPointer: 0
  };
}

function moleculeAtomTarget(molecule: MoleculeObject, atomId: string) {
  const atom = moleculeAtom(molecule, atomId);
  return {
    objectId: molecule.id,
    kind: "atom" as const,
    atomId: atom.id,
    distanceToPointer: 0
  };
}

function moleculeBondMidpoint(molecule: MoleculeObject, bondId: string): { x: number; y: number } {
  const bond = moleculeBond(molecule, bondId);
  const fromAtom = moleculeAtom(molecule, bond.fromAtomId);
  const toAtom = moleculeAtom(molecule, bond.toAtomId);

  return {
    x: (fromAtom.x + toAtom.x) / 2,
    y: (fromAtom.y + toAtom.y) / 2
  };
}

function rightmostSixMemberRingPerimeterBondId(molecule: MoleculeObject): string {
  const rings = testSixMemberCarbonRings(molecule);
  const membership = new Map<string, number>();
  rings.forEach((ring) => {
    ring.bondIds.forEach((bondId) => {
      membership.set(bondId, (membership.get(bondId) ?? 0) + 1);
    });
  });

  const perimeterBonds = molecule.bonds
    .filter((bond) => membership.get(bond.id) === 1)
    .map((bond) => ({ bond, midpoint: moleculeBondMidpoint(molecule, bond.id) }))
    .sort((a, b) => b.midpoint.x - a.midpoint.x || a.bond.id.localeCompare(b.bond.id));
  const bondId = perimeterBonds[0]?.bond.id;
  if (!bondId) {
    throw new Error("Expected at least one six-membered ring perimeter bond");
  }

  return bondId;
}

function atomDegree(molecule: MoleculeObject, atomId: string): number {
  return molecule.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId).length;
}

function expectUsableNativeMoleculeGraph(
  molecule: MoleculeObject,
  context = molecule.id,
  options: { minimumAtomDistancePx?: number } = {}
): void {
  const atomIds = new Set(molecule.atoms.map((atom) => atom.id));
  const minimumAtomDistancePx = options.minimumAtomDistancePx ?? 0.5;

  expect(molecule.atoms.length).toBeGreaterThan(0);
  expect(molecule.bonds.length).toBeGreaterThan(0);
  expect(molecule.atoms.every((atom) =>
    atom.id.length > 0 &&
    atom.element.length > 0 &&
    Number.isFinite(atom.x) &&
    Number.isFinite(atom.y)
  )).toBe(true);
  expect(molecule.bonds.every((bond) =>
    bond.id.length > 0 &&
    bond.fromAtomId !== bond.toAtomId &&
    atomIds.has(bond.fromAtomId) &&
    atomIds.has(bond.toAtomId)
  )).toBe(true);
  expect(molecule.structure.length).toBeGreaterThan(0);
  expect(molecule.chemistry?.atomCount).toBe(molecule.atoms.length);
  expect(molecule.chemistry?.bondCount).toBe(molecule.bonds.length);
  molecule.atoms.forEach((atom, index) => {
    molecule.atoms.slice(index + 1).forEach((otherAtom) => {
      expect(
        Math.hypot(atom.x - otherAtom.x, atom.y - otherAtom.y),
        `${context} ${molecule.id} ${atom.id}/${otherAtom.id}`
      ).toBeGreaterThan(minimumAtomDistancePx);
    });
  });
}

function moleculeAngleDegrees(molecule: MoleculeObject, leftAtomId: string, centerAtomId: string, rightAtomId: string): number {
  const left = moleculeAtom(molecule, leftAtomId);
  const center = moleculeAtom(molecule, centerAtomId);
  const right = moleculeAtom(molecule, rightAtomId);
  const leftAngle = Math.atan2(left.y - center.y, left.x - center.x);
  const rightAngle = Math.atan2(right.y - center.y, right.x - center.x);
  const delta = Math.abs(((rightAngle - leftAngle) * 180 / Math.PI + 540) % 360 - 180);

  return delta;
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

function setNativeBondOrder(
  document: ChemDraftDocument,
  bondId: string,
  order: "double" | "triple"
): ChemDraftDocument {
  const molecule = selectedMolecule(document);
  const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
  if (!bond) {
    throw new Error(`Expected bond "${bondId}".`);
  }

  return applyNativeMoleculeBondOrderValueTarget(document, {
    objectId: molecule.id,
    kind: "bond",
    bondId: bond.id,
    fromAtomId: bond.fromAtomId,
    toAtomId: bond.toAtomId,
    distanceToPointer: 0
  }, order);
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

  it("selects all canvas objects on the active page", () => {
    const blank = createPhase4Document("Select All Fixture");
    const withBond = insertNativeSingleBondMolecule(blank, { x: 200, y: 220 });
    const withText = insertNativeTextObject(withBond, { x: 280, y: 260 }, "note");
    const selected = selectAllDocumentObjects(withText, withText.pages[0].id);
    const objectIds = withText.pages[0].objects.map((object) => object.id);

    expect(selectAllDocumentObjects(blank, blank.pages[0].id)).toBe(blank);
    expect(selected.selection).toEqual({
      pageId: withText.pages[0].id,
      objectIds
    });
    expect(selectAllDocumentObjects(selected, selected.pages[0].id)).toBe(selected);
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

  it("moves one native atom and stretches its connected bond", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Atom Drag Stretch"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const atom1 = molecule.atoms.find((atom) => atom.id === "atom_001");
    const atom2 = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!atom1 || !atom2) {
      throw new Error("Expected single-bond atom fixture.");
    }

    const moved = moveNativeMoleculeParts(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002"
    }, { x: 38, y: -26 });
    const movedMolecule = selectedMolecule(moved);
    const movedAtom1 = movedMolecule.atoms.find((atom) => atom.id === "atom_001");
    const movedAtom2 = movedMolecule.atoms.find((atom) => atom.id === "atom_002");
    if (!movedAtom1 || !movedAtom2) {
      throw new Error("Expected moved single-bond atom fixture.");
    }

    expect(movedAtom1).toMatchObject({ x: atom1.x, y: atom1.y });
    expect(movedAtom2).toMatchObject({ x: atom2.x + 38, y: atom2.y - 26 });
    expect(pointDistance(movedAtom1, movedAtom2)).toBeGreaterThan(pointDistance(atom1, atom2));
    expect(movedMolecule.bonds).toEqual(molecule.bonds);
    expect(movedMolecule.structure).toBe(molecule.structure);
    expect(movedMolecule.chemistry).toEqual(molecule.chemistry);
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

  it("rotates a selected native molecule around its center without changing chemical identity", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Rotate Fixture"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const center = {
      x: molecule.x + molecule.width / 2,
      y: molecule.y + molecule.height / 2
    };
    const rotated = rotateDocumentObject(document, molecule.id, 90);
    const rotatedMolecule = selectedMolecule(rotated);

    expect(rotatedMolecule.id).toBe(molecule.id);
    expect(rotatedMolecule.rotation).toBe(0);
    expect(nativeMoleculeTransformState(rotatedMolecule).rotationDegrees).toBe(90);
    expect(rotatedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(rotatedMolecule.bonds).toEqual(molecule.bonds);
    expect(rotatedMolecule.structure).toBe(molecule.structure);
    expect(rotatedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(rotated.selection.objectIds).toEqual([molecule.id]);
    molecule.atoms.forEach((atom, index) => {
      const rotatedAtom = rotatedMolecule.atoms[index];
      expect(rotatedAtom?.x).toBeCloseTo(center.x - (atom.y - center.y), 3);
      expect(rotatedAtom?.y).toBeCloseTo(center.y + (atom.x - center.x), 3);
      expect(pointDistance(atom, center)).toBeCloseTo(pointDistance(rotatedAtom ?? atom, center), 3);
    });
  });

  it("keeps a freshly placed single bond chemically intact when rotated before placement commit", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Rotated Bond Placement"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const center = {
      x: ((molecule.atoms[0]?.x ?? 0) + (molecule.atoms[1]?.x ?? 0)) / 2,
      y: ((molecule.atoms[0]?.y ?? 0) + (molecule.atoms[1]?.y ?? 0)) / 2
    };
    const rotated = rotateNativeMoleculeObjectAroundPoint(document, molecule.id, center, 90);
    const rotatedMolecule = selectedMolecule(rotated);

    expect(rotatedMolecule.atoms).toHaveLength(2);
    expect(rotatedMolecule.bonds).toEqual(molecule.bonds);
    expect(rotatedMolecule.structure).toBe(molecule.structure);
    expect(rotatedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(nativeMoleculeTransformState(rotatedMolecule).rotationDegrees).toBe(90);
    expect(rotatedMolecule.atoms[0]?.x).toBeCloseTo(center.x, 3);
    expect(rotatedMolecule.atoms[0]?.y).toBeCloseTo(center.y - nativeBondLengthPx / 2, 3);
    expect(rotatedMolecule.atoms[1]?.x).toBeCloseTo(center.x, 3);
    expect(rotatedMolecule.atoms[1]?.y).toBeCloseTo(center.y + nativeBondLengthPx / 2, 3);
  });

  it("keeps a freshly placed ring template chemically intact when rotated before placement commit", () => {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Rotated Template Placement"),
      { x: 260, y: 260 },
      "cyclohexane"
    );
    const molecule = selectedMolecule(document);
    const rotated = rotateNativeMoleculeObjectAroundPoint(document, molecule.id, { x: 260, y: 260 }, 30);
    const rotatedMolecule = selectedMolecule(rotated);

    expect(rotatedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(rotatedMolecule.bonds).toEqual(molecule.bonds);
    expect(rotatedMolecule.structure).toBe(molecule.structure);
    expect(rotatedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(nativeMoleculeTransformState(rotatedMolecule).rotationDegrees).toBe(30);
    expect(rotatedMolecule.atoms.some((atom, index) =>
      Math.abs(atom.x - (molecule.atoms[index]?.x ?? atom.x)) > 0.1 ||
      Math.abs(atom.y - (molecule.atoms[index]?.y ?? atom.y)) > 0.1
    )).toBe(true);
    rotatedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(rotatedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
  });

  it("resizes a selected native molecule symmetrically without changing chemical identity", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Resize Molecule Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = {
      x: molecule.x + molecule.width / 2,
      y: molecule.y + molecule.height / 2
    };
    const resized = resizeNativeMoleculeObject(document, molecule.id, { x: 1.5, y: 1.5 });
    const resizedMolecule = selectedMolecule(resized);

    expect(resizedMolecule.id).toBe(molecule.id);
    expect(resizedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(resizedMolecule.bonds).toEqual(molecule.bonds);
    expect(resizedMolecule.structure).toBe(molecule.structure);
    expect(resizedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(nativeMoleculeTransformState(resizedMolecule)).toEqual({
      scaleX: 1.5,
      scaleY: 1.5,
      rotationDegrees: 0
    });
    expect(resized.selection.objectIds).toEqual([molecule.id]);
    molecule.atoms.forEach((atom, index) => {
      const resizedAtom = resizedMolecule.atoms[index];
      expect(resizedAtom?.x).toBeCloseTo(center.x + (atom.x - center.x) * 1.5, 3);
      expect(resizedAtom?.y).toBeCloseTo(center.y + (atom.y - center.y) * 1.5, 3);
    });
  });

  it("resizes selected native molecule fragments without breaking bonds", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Resize Fragment Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const atom1 = moleculeAtom(molecule, "atom_001");
    const atom2 = moleculeAtom(molecule, "atom_002");
    const atom3 = moleculeAtom(molecule, "atom_003");
    const resized = resizeNativeMoleculeParts(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002"
    }, { x: 2, y: 0.6 });
    const resizedMolecule = selectedMolecule(resized);

    expect(resizedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(resizedMolecule.bonds).toEqual(molecule.bonds);
    expect(resizedMolecule.structure).toBe(molecule.structure);
    expect(resizedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(moleculeAtom(resizedMolecule, "atom_001")).toEqual(atom1);
    expect(pointDistance(moleculeAtom(resizedMolecule, "atom_002"), atom2)).toBeGreaterThan(0);
    expect(pointDistance(moleculeAtom(resizedMolecule, "atom_003"), atom3)).toBeGreaterThan(0);
    expect(moleculeBondLength(resizedMolecule, "bond_001")).not.toBeCloseTo(nativeBondLengthPx, 2);
    expect(moleculeBondLength(resizedMolecule, "bond_002")).not.toBeCloseTo(nativeBondLengthPx, 2);

    const cleaned = cleanUpSelectedNativeMolecule2d(resized);
    const cleanedMolecule = selectedMolecule(cleaned);
    expect(cleanedMolecule.bonds).toEqual(molecule.bonds);
    expect(cleanedMolecule.structure).toBe(molecule.structure);
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
    expect(moleculeAngleDegrees(cleanedMolecule, "atom_001", "atom_002", "atom_003")).toBeCloseTo(120, 2);
  });

  it("rotates selected native molecule fragments without breaking bonds", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Rotate Fragment Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const atom1 = moleculeAtom(molecule, "atom_001");
    const atom2 = moleculeAtom(molecule, "atom_002");
    const atom3 = moleculeAtom(molecule, "atom_003");
    const rotated = rotateNativeMoleculeParts(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002"
    }, 90);
    const rotatedMolecule = selectedMolecule(rotated);

    expect(rotatedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(rotatedMolecule.bonds).toEqual(molecule.bonds);
    expect(rotatedMolecule.structure).toBe(molecule.structure);
    expect(rotatedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(moleculeAtom(rotatedMolecule, "atom_001")).toEqual(atom1);
    expect(pointDistance(moleculeAtom(rotatedMolecule, "atom_002"), atom2)).toBeGreaterThan(0);
    expect(pointDistance(moleculeAtom(rotatedMolecule, "atom_003"), atom3)).toBeGreaterThan(0);
    expect(moleculeBondLength(rotatedMolecule, "bond_001")).not.toBeCloseTo(nativeBondLengthPx, 2);

    const cleaned = cleanUpSelectedNativeMolecule2d(rotated);
    const cleanedMolecule = selectedMolecule(cleaned);
    expect(cleanedMolecule.bonds).toEqual(molecule.bonds);
    expect(cleanedMolecule.structure).toBe(molecule.structure);
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
    expect(moleculeAngleDegrees(cleanedMolecule, "atom_001", "atom_002", "atom_003")).toBeCloseTo(120, 2);
  });

  it("stretches a selected native molecule independently on X and Y without changing bonds", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Stretch Molecule Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = {
      x: molecule.x + molecule.width / 2,
      y: molecule.y + molecule.height / 2
    };
    const stretched = resizeNativeMoleculeObject(document, molecule.id, { x: 1.75, y: 0.6 });
    const stretchedMolecule = selectedMolecule(stretched);

    expect(stretchedMolecule.bonds).toEqual(molecule.bonds);
    expect(stretchedMolecule.structure).toBe(molecule.structure);
    expect(nativeMoleculeTransformState(stretchedMolecule)).toEqual({
      scaleX: 1.75,
      scaleY: 0.6,
      rotationDegrees: 0
    });
    molecule.atoms.forEach((atom, index) => {
      const stretchedAtom = stretchedMolecule.atoms[index];
      expect(stretchedAtom?.x).toBeCloseTo(center.x + (atom.x - center.x) * 1.75, 3);
      expect(stretchedAtom?.y).toBeCloseTo(center.y + (atom.y - center.y) * 0.6, 3);
    });
  });

  it("cleans up a stretched native carbon chain to 120-degree 2D geometry", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Chain Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const stretched = resizeNativeMoleculeObject(document, molecule.id, { x: 2.2, y: 0.35 });
    const stretchedMolecule = selectedMolecule(stretched);
    const cleaned = cleanUpSelectedNativeMolecule2d(stretched);
    const cleanedMolecule = selectedMolecule(cleaned);

    expect(cleanedMolecule.id).toBe(molecule.id);
    expect(cleanedMolecule.atoms.map((atom) => atom.id)).toEqual(stretchedMolecule.atoms.map((atom) => atom.id));
    expect(cleanedMolecule.bonds).toEqual(stretchedMolecule.bonds);
    expect(cleanedMolecule.structure).toBe(stretchedMolecule.structure);
    expect(cleanedMolecule.chemistry).toEqual(stretchedMolecule.chemistry);
    expect(cleaned.selection.objectIds).toEqual([molecule.id]);
    expect(nativeMoleculeTransformState(cleanedMolecule)).toEqual({
      scaleX: 1,
      scaleY: 1,
      rotationDegrees: 0
    });
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
    expect(moleculeAngleDegrees(cleanedMolecule, "atom_001", "atom_002", "atom_003")).toBeCloseTo(120, 2);
  });

  it("cleans up every selected native molecule instead of only the first selected structure", () => {
    let document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Multi-Selection Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const firstMoleculeId = selectedMolecule(document).id;

    document = growFromAtom(
      insertNativeSingleBondMolecule(document, { x: 360, y: 320 }),
      "atom_002",
      60
    );
    const secondMoleculeId = selectedMolecule(document).id;

    const distorted = applyPatches(
      resizeNativeMoleculeObject(
        resizeNativeMoleculeObject(document, firstMoleculeId, { x: 2.4, y: 0.35 }),
        secondMoleculeId,
        { x: 0.45, y: 2.2 }
      ),
      [{ op: "setSelection", pageId: document.pages[0].id, objectIds: [firstMoleculeId, secondMoleculeId] }]
    );
    const cleaned = cleanUpSelectedNativeMolecule2d(distorted);
    const firstCleaned = moleculeById(cleaned, firstMoleculeId);
    const secondCleaned = moleculeById(cleaned, secondMoleculeId);

    expect(cleaned.selection.objectIds).toEqual([firstMoleculeId, secondMoleculeId]);
    [firstCleaned, secondCleaned].forEach((molecule) => {
      expect(nativeMoleculeTransformState(molecule)).toEqual({
        scaleX: 1,
        scaleY: 1,
        rotationDegrees: 0
      });
      molecule.bonds.forEach((bond) => {
        expect(moleculeBondLength(molecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
      });
      expect(moleculeAngleDegrees(molecule, "atom_001", "atom_002", "atom_003")).toBeCloseTo(120, 2);
    });
  });

  it("cleans up a selected fragment owner even when object selection is empty", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Fragment Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const distorted = applyPatches(
      resizeNativeMoleculeObject(document, molecule.id, { x: 2.1, y: 0.4 }),
      [{ op: "setSelection", pageId: document.pages[0].id, objectIds: [] }]
    );
    const cleaned = cleanUpNativeMolecules2d(distorted, [molecule.id]);
    const cleanedMolecule = moleculeById(cleaned, molecule.id);

    expect(cleaned.selection.objectIds).toEqual([]);
    expect(nativeMoleculeTransformState(cleanedMolecule)).toEqual({
      scaleX: 1,
      scaleY: 1,
      rotationDegrees: 0
    });
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
  });

  it("cleans up sp1 native geometry as linear while preserving chemistry", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Alkyne Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const alkyne = applyNativeMoleculeBondOrderValueTarget(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002",
      fromAtomId: "atom_002",
      toAtomId: "atom_003",
      distanceToPointer: 0
    }, "triple");
    const stretched = resizeNativeMoleculeObject(alkyne, molecule.id, { x: 1.7, y: 0.45 });
    const cleaned = cleanUpSelectedNativeMolecule2d(stretched);
    const cleanedMolecule = selectedMolecule(cleaned);

    expect(cleanedMolecule.bonds.find((bond) => bond.id === "bond_002")?.order).toBe("triple");
    expect(cleanedMolecule.structure).toBe(selectedMolecule(stretched).structure);
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
    expect(moleculeAngleDegrees(cleanedMolecule, "atom_001", "atom_002", "atom_003")).toBeCloseTo(180, 3);
  });

  it("cleans up allene central sp native geometry as linear", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Allene Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const firstDouble = setNativeBondOrder(document, "bond_001", "double");
    const allene = setNativeBondOrder(firstDouble, "bond_002", "double");
    const stretched = resizeNativeMoleculeObject(allene, selectedMolecule(allene).id, { x: 1.45, y: 0.5 });
    const cleaned = cleanUpSelectedNativeMolecule2d(stretched);
    const cleanedMolecule = selectedMolecule(cleaned);

    expect(cleanedMolecule.structure).toBe("C=C=C");
    expect(cleanedMolecule.chemistry?.formula).toBe("C3H4");
    expect(cleanedMolecule.bonds).toEqual(selectedMolecule(allene).bonds);
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
    expect(moleculeAngleDegrees(cleanedMolecule, "atom_001", "atom_002", "atom_003")).toBeCloseTo(180, 3);
  });

  it("cleans up a distorted cyclohexane ring as a regular 2D ring", () => {
    const openRing = [
      ["atom_002", 60],
      ["atom_003", 120],
      ["atom_004", 180],
      ["atom_005", 240]
    ].reduce(
      (current, [atomId, angle]) => growFromAtom(current, String(atomId), Number(angle)),
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Cyclohexane"), { x: 300, y: 300 })
    );
    const ring = selectedMolecule(openRing);
    const firstAtom = moleculeAtom(ring, "atom_001");
    const terminalAtom = moleculeAtom(ring, "atom_006");
    const closingAngle = Math.atan2(firstAtom.y - terminalAtom.y, firstAtom.x - terminalAtom.x);
    const closingPoint = {
      x: terminalAtom.x + Math.cos(closingAngle) * nativeAtomHitRadiusPx * 0.65,
      y: terminalAtom.y + Math.sin(closingAngle) * nativeAtomHitRadiusPx * 0.65
    };
    const closedRing = applySingleBondToolAtPoint(openRing, closingPoint);
    const closedMolecule = selectedMolecule(closedRing);
    const distorted = resizeNativeMoleculeObject(closedRing, closedMolecule.id, { x: 1.9, y: 0.55 });
    const cleaned = cleanUpSelectedNativeMolecule2d(distorted);
    const cleanedMolecule = selectedMolecule(cleaned);

    expect(cleanedMolecule.atoms.map((atom) => atom.id)).toEqual(closedMolecule.atoms.map((atom) => atom.id));
    expect(cleanedMolecule.bonds).toEqual(closedMolecule.bonds);
    expect(cleanedMolecule.structure).toBe("C1CCCCC1");
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 3);
    });
    expect(moleculeAngleDegrees(cleanedMolecule, "atom_002", "atom_001", "atom_006")).toBeCloseTo(120, 2);
    expect(nativeMoleculeTransformState(cleanedMolecule)).toEqual({
      scaleX: 1,
      scaleY: 1,
      rotationDegrees: 0
    });
  });

  it("cleans up a distorted cyclohexene ring as a regular 2D ring", () => {
    const openRing = [
      ["atom_002", 60],
      ["atom_003", 120],
      ["atom_004", 180],
      ["atom_005", 240]
    ].reduce(
      (current, [atomId, angle]) => growFromAtom(current, String(atomId), Number(angle)),
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Cyclohexene"), { x: 300, y: 300 })
    );
    const ring = selectedMolecule(openRing);
    const firstAtom = moleculeAtom(ring, "atom_001");
    const terminalAtom = moleculeAtom(ring, "atom_006");
    const closingAngle = Math.atan2(firstAtom.y - terminalAtom.y, firstAtom.x - terminalAtom.x);
    const closingPoint = {
      x: terminalAtom.x + Math.cos(closingAngle) * nativeAtomHitRadiusPx * 0.65,
      y: terminalAtom.y + Math.sin(closingAngle) * nativeAtomHitRadiusPx * 0.65
    };
    const closedRing = applySingleBondToolAtPoint(openRing, closingPoint);
    const closedMolecule = selectedMolecule(closedRing);
    const cyclohexene = applyNativeMoleculeBondOrderValueTarget(closedRing, {
      objectId: closedMolecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    }, "double");
    const distorted = rotateNativeMoleculeParts(
      resizeNativeMoleculeParts(cyclohexene, {
        objectId: closedMolecule.id,
        kind: "bond",
        bondId: "bond_001"
      }, { x: 4.19, y: 4.19 }),
      {
        objectId: closedMolecule.id,
        kind: "bond",
        bondId: "bond_001"
      },
      -48
    );
    const cleaned = cleanUpSelectedNativeMolecule2d(distorted);
    const cleanedMolecule = selectedMolecule(cleaned);

    expect(cleanedMolecule.atoms.map((atom) => atom.id)).toEqual(closedMolecule.atoms.map((atom) => atom.id));
    expect(cleanedMolecule.bonds).toEqual(selectedMolecule(cyclohexene).bonds);
    expect(cleanedMolecule.structure).toBe("C1=CCCCC1");
    cleanedMolecule.bonds.forEach((bond) => {
      expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(nativeBondLengthPx, 2);
    });
    expect(moleculeAngleDegrees(cleanedMolecule, "atom_002", "atom_001", "atom_006")).toBeCloseTo(120, 2);
    expect(nativeMoleculeTransformState(cleanedMolecule)).toEqual({
      scaleX: 1,
      scaleY: 1,
      rotationDegrees: 0
    });
  });

  it("keeps native molecule transform readouts cumulative across repeated operations", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Cumulative Transform Fixture"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const firstResize = resizeNativeMoleculeObject(document, molecule.id, { x: 2, y: 2 });
    const firstMolecule = selectedMolecule(firstResize);
    expect(nativeMoleculeTransformState(firstMolecule)).toEqual({
      scaleX: 2,
      scaleY: 2,
      rotationDegrees: 0
    });

    const secondResize = resizeNativeMoleculeObject(firstResize, molecule.id, { x: 1.5, y: 0.5 });
    const secondMolecule = selectedMolecule(secondResize);
    expect(nativeMoleculeTransformState(secondMolecule)).toEqual({
      scaleX: 3,
      scaleY: 1,
      rotationDegrees: 0
    });

    const firstRotate = rotateDocumentObject(secondResize, molecule.id, 45);
    const firstRotatedMolecule = selectedMolecule(firstRotate);
    expect(nativeMoleculeTransformState(firstRotatedMolecule)).toEqual({
      scaleX: 3,
      scaleY: 1,
      rotationDegrees: 45
    });

    const secondRotate = rotateDocumentObject(firstRotate, molecule.id, 30);
    const secondRotatedMolecule = selectedMolecule(secondRotate);
    expect(nativeMoleculeTransformState(secondRotatedMolecule)).toEqual({
      scaleX: 3,
      scaleY: 1,
      rotationDegrees: 75
    });
    expect(secondRotatedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(secondRotatedMolecule.bonds).toEqual(molecule.bonds);
    expect(secondRotatedMolecule.structure).toBe(molecule.structure);
  });

  it("rotates selected text boxes in the page plane", () => {
    const document = insertNativeTextObject(createPhase4Document("Rotate Text"), { x: 120, y: 140 }, "label");
    const text = getSelectedTextObject(document);
    if (!text) {
      throw new Error("Expected selected text object.");
    }
    const rotated = rotateDocumentObject(document, text.id, 37.5);
    const rotatedText = getSelectedTextObject(rotated);

    expect(rotatedText).toMatchObject({
      id: text.id,
      type: "text",
      text: "label",
      x: text.x,
      y: text.y,
      width: text.width,
      height: text.height,
      rotation: 37.5
    });
  });

  it("extends the selected native single bond into one connected molecule graph", () => {
    const withBond = insertNativeSingleBondMolecule(createPhase4Document("Chain Fixture"), { x: 200, y: 220 });
    const extended = growFromAtom(withBond, "atom_002", 0);
    const secondAtomX = 200 + nativeBondLengthPx / 2;
    const expectedThirdAtom = {
      x: secondAtomX + Math.cos(60 * Math.PI / 180) * nativeBondLengthPx,
      y: 220 + Math.sin(60 * Math.PI / 180) * nativeBondLengthPx
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
      ["atom_002", -60],
      ["atom_003", 0],
      ["atom_004", 60]
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
    const ghostAngle = neighborAngle + 120 * Math.PI / 180;
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
        -60
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

  it("lets guided 120-degree growth close cyclohexane or grow away from the ring", () => {
    const openRing = [
      ["atom_002", 60],
      ["atom_003", 120],
      ["atom_004", 180],
      ["atom_005", 240]
    ].reduce(
      (current, [atomId, angle]) => growFromAtom(current, String(atomId), Number(angle)),
      insertNativeSingleBondMolecule(createPhase4Document("Guided Cyclohexane"), { x: 300, y: 300 })
    );
    const molecule = selectedMolecule(openRing);
    const firstAtom = molecule.atoms.find((atom) => atom.id === "atom_001");
    const terminalAtom = molecule.atoms.find((atom) => atom.id === "atom_006");
    if (!firstAtom || !terminalAtom) {
      throw new Error("Expected open cyclohexane terminal atoms.");
    }

    const steerDistance = nativeAtomHitRadiusPx * 0.65;
    const closingAngle = Math.atan2(firstAtom.y - terminalAtom.y, firstAtom.x - terminalAtom.x);
    const outwardAngle = Math.PI;
    const closingPoint = {
      x: terminalAtom.x + Math.cos(closingAngle) * steerDistance,
      y: terminalAtom.y + Math.sin(closingAngle) * steerDistance
    };
    const outwardPoint = {
      x: terminalAtom.x + Math.cos(outwardAngle) * steerDistance,
      y: terminalAtom.y + Math.sin(outwardAngle) * steerDistance
    };
    const closingPreview = previewNativeMoleculeBondGrowth(
      molecule,
      closingPoint,
      openRing.pages[0].width,
      openRing.pages[0].height
    );
    const outwardPreview = previewNativeMoleculeBondGrowth(
      molecule,
      outwardPoint,
      openRing.pages[0].width,
      openRing.pages[0].height
    );
    const closed = applySingleBondToolAtPoint(openRing, closingPoint);
    const grownAway = applySingleBondToolAtPoint(openRing, outwardPoint);
    const closedMolecule = selectedMolecule(closed);
    const grownAwayMolecule = selectedMolecule(grownAway);

    expect(closingPreview).toMatchObject({ atomId: "atom_006", targetAtomId: "atom_001" });
    expect(outwardPreview?.targetAtomId).toBeUndefined();
    expect(closedMolecule.atoms).toHaveLength(6);
    expect(closedMolecule.bonds).toHaveLength(6);
    expect(closedMolecule.bonds.at(-1)).toMatchObject({
      fromAtomId: "atom_006",
      toAtomId: "atom_001",
      order: "single"
    });
    expect(closedMolecule.structure).toBe("C1CCCCC1");
    expect(closedMolecule.chemistry).toMatchObject({ formula: "C6H12", atomCount: 6, bondCount: 6 });
    expectNoDuplicateAtomPositions(closedMolecule);
    expect(grownAwayMolecule.atoms).toHaveLength(7);
    expect(grownAwayMolecule.bonds).toHaveLength(6);
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
    const neopentane = [-120, 120, 180].reduce(
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

  it("makes hovered carbon labels explicit with implicit hydrogens when pressing C", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Explicit Carbon"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const explicitCarbon = applyNativeAtomElementTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    }, "C");
    const nextMolecule = selectedMolecule(explicitCarbon);
    const atom = nextMolecule.atoms.find((candidate) => candidate.id === "atom_001");
    if (!atom) {
      throw new Error("Expected explicit carbon atom.");
    }

    expect(atom).toMatchObject({ element: "C", labelVisible: true });
    expect(nativeAtomDisplayLabel(atom, nextMolecule.bonds)).toBe("CH3");
    expect(nextMolecule.chemistry).toMatchObject({ formula: "C2H6", atomCount: 2, bondCount: 1 });
  });

  it("labels isolated neutral common atoms with implicit hydrogens", () => {
    expect(nativeAtomDisplayLabel({ id: "atom_001", element: "C", x: 0, y: 0, formalCharge: 0 }, [])).toBe("CH4");
    expect(nativeAtomDisplayLabel({ id: "atom_001", element: "N", x: 0, y: 0, formalCharge: 0 }, [])).toBe("NH3");
    expect(nativeAtomDisplayLabel({ id: "atom_001", element: "O", x: 0, y: 0, formalCharge: 0 }, [])).toBe("OH2");
  });

  it("allows hovered atom element changes that exceed valence and marks them invalid", () => {
    const neopentane = [-120, 120, 180].reduce(
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

  it("sets hovered bond order directly from numeric keys", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Direct Bond Orders"), { x: 200, y: 220 });
    const doubleBond = setNativeBondOrder(document, "bond_001", "double");
    const tripleBond = setNativeBondOrder(doubleBond, "bond_001", "triple");

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

  it("adds a carbonyl from a hovered carbon with K without over-valencing carbon", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Carbonyl Key"), { x: 240, y: 260 });
    const molecule = selectedMolecule(document);
    const carbon = molecule.atoms.find((atom) => atom.id === "atom_001");
    if (!carbon) {
      throw new Error("Expected carbonyl source atom.");
    }

    const carbonyl = applyNativeCarbonylAtAtomTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: carbon.id,
      distanceToPointer: 0
    }, {
      x: carbon.x,
      y: carbon.y - nativeAtomHitRadiusPx
    });
    const carbonylMolecule = selectedMolecule(carbonyl);
    const oxygen = carbonylMolecule.atoms.find((atom) => atom.element === "O");
    const carbonylBond = carbonylMolecule.bonds.find((bond) =>
      bond.order === "double" && bond.fromAtomId === carbon.id && bond.toAtomId === oxygen?.id
    );
    const secondAttempt = applyNativeCarbonylAtAtomTarget(carbonyl, {
      objectId: carbonylMolecule.id,
      kind: "atom",
      atomId: carbon.id,
      distanceToPointer: 0
    });

    expect(oxygen).toBeDefined();
    expect(carbonylBond).toMatchObject({ order: "double" });
    expect(oxygen?.y).toBeLessThan(carbon.y);
    expect(carbonylMolecule.structure).toContain("=O");
    expect(carbonylMolecule.chemistry).toMatchObject({ formula: "C2H4O", atomCount: 3, bondCount: 2 });
    expect(secondAttempt).toEqual(carbonyl);
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
    expect(normalizeNativeAtomElementLabel("iPr")).toBe("iPr");
    expect(nativeElementFromAtomLabel("cl")).toBe("Cl");
    expect(nativeElementFromAtomLabel("Br")).toBe("Br");
    expect(nativeElementFromAtomLabel("Xx")).toBeUndefined();
  });

  it("updates hovered atom labels to full element symbols and accepts generic labels", () => {
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
    const generic = applyNativeAtomElementTarget(chloride, target, "Xx");
    const genericMolecule = selectedMolecule(generic);
    const yGeneric = applyNativeAtomElementTarget(generic, target, "Y");
    const yMolecule = selectedMolecule(yGeneric);

    expect(labeled.atoms.find((atom) => atom.id === "atom_001")).toMatchObject({ element: "Cl" });
    expect(nativeAtomDisplayLabel(labeled.atoms[0], labeled.bonds)).toBe("Cl");
    expect(nativeMoleculeInvalidAtomStates(labeled)).toEqual([]);
    expect(genericMolecule.atoms.find((atom) => atom.id === "atom_001")).toMatchObject({ element: "Xx" });
    expect(nativeAtomDisplayLabel(genericMolecule.atoms[0], genericMolecule.bonds)).toBe("Xx");
    expect(nativeMoleculeInvalidAtomStates(genericMolecule)).toEqual([]);
    expect(yMolecule.atoms.find((atom) => atom.id === "atom_001")).toMatchObject({ element: "Y" });
    expect(nativeMoleculeInvalidAtomStates(yMolecule)).toEqual([]);
  });

  it("keeps actual element labels valence-checked after atom relabeling", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Atom Label Valence"), { x: 300, y: 300 });
    const molecule = selectedMolecule(document);
    const withBranches = [45, 135, -90].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      document
    );
    const target = {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    } as const;
    const nitrogen = applyNativeAtomElementTarget(withBranches, target, "N");
    const nitrogenMolecule = selectedMolecule(nitrogen);

    expect(nitrogenMolecule.atoms.find((atom) => atom.id === "atom_001")).toMatchObject({ element: "N" });
    expect(nativeMoleculeInvalidAtomStates(nitrogenMolecule)[0]).toMatchObject({
      atomId: "atom_001",
      element: "N",
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

  it("updates native text script spans without changing chemistry objects", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Text Script"), { x: 300, y: 300 });
    const withText = insertNativeTextObject(document, { x: 120, y: 140 }, "H2O");
    const textObject = getSelectedTextObject(withText);
    if (!textObject) {
      throw new Error("Expected inserted text object to be selected.");
    }

    const scripted = updateNativeTextObjectScript(withText, textObject.id, "subscript");
    const typed = updateNativeTextObjectText(scripted, textObject.id, "H2SO4");
    const molecule = scripted.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    const scriptedText = getSelectedTextObject(scripted);
    const typedText = getSelectedTextObject(typed);

    expect(scriptedText?.spans).toEqual([{ text: "H2O", script: "subscript", style: {} }]);
    expect(typedText?.spans).toEqual([{ text: "H2SO4", script: "subscript", style: {} }]);
    expect(scriptedText?.text).toBe("H2O");
    expect(molecule?.atoms).toHaveLength(2);
    expect(molecule?.bonds).toHaveLength(1);
  });

  it("updates only the selected text range and preserves mixed spans while typing", () => {
    const withText = insertNativeTextObject(createPhase4Document("Text Range Style"), { x: 120, y: 140 }, "H2SO4");
    const textObject = getSelectedTextObject(withText);
    if (!textObject) {
      throw new Error("Expected inserted text object to be selected.");
    }

    const scripted = updateNativeTextObjectScriptRange(withText, textObject.id, { start: 1, end: 2 }, "subscript");
    const colored = updateNativeTextObjectStyleRange(scripted, textObject.id, { start: 3, end: 4 }, { color: "#b3261e" });
    const typed = updateNativeTextObjectText(colored, textObject.id, "H2SO4+");
    const updated = getSelectedTextObject(typed);

    expect(updated?.spans).toEqual([
      { text: "H", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: "S", script: "normal", style: {} },
      { text: "O", script: "normal", style: { color: "#b3261e" } },
      { text: "4+", script: "normal", style: {} }
    ]);
  });

  it("applies a selected color to selected molecule drawing and selected text", () => {
    const withMolecule = insertNativeSingleBondMolecule(
      createPhase4Document("Selected Color"),
      { x: 300, y: 300 }
    );
    const molecule = selectedMolecule(withMolecule);
    const withText = insertNativeTextObject(withMolecule, { x: 120, y: 140 }, "label");
    const textObject = getSelectedTextObject(withText);
    if (!textObject) {
      throw new Error("Expected inserted text object to be selected.");
    }

    const selected = applyPatches(withText, [{
      op: "setSelection",
      pageId: withText.pages[0].id,
      objectIds: [molecule.id, textObject.id]
    }]);
    const colored = applyColorToDocumentObjects(selected, "#1f5fbf");
    const coloredMolecule = moleculeById(colored, molecule.id);
    const coloredText = colored.pages[0].objects.find((object): object is TextObject => object.id === textObject.id && object.type === "text");

    expect(coloredMolecule.style).toMatchObject({
      bondColor: "#1f5fbf",
      atomLabelColor: "#1f5fbf"
    });
    expect(coloredText?.style).toMatchObject({ color: "#1f5fbf" });
    expect(colored.selection.objectIds).toEqual([molecule.id, textObject.id]);
  });

  it("applies selected colors to native molecule atom labels and bonds without recoloring the whole molecule", () => {
    const document = insertNativeSingleBondMolecule(
      createPhase4Document("Selected Part Color"),
      { x: 300, y: 300 }
    );
    const molecule = selectedMolecule(document);
    const atomId = molecule.atoms[0]?.id;
    const bondId = molecule.bonds[0]?.id;
    if (!atomId || !bondId) {
      throw new Error("Expected native molecule atom and bond.");
    }

    const atomColored = applyColorToNativeMoleculePart(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId
    }, "#c75c12");
    const bondColored = applyColorToNativeMoleculePart(atomColored, {
      objectId: molecule.id,
      kind: "bond",
      bondId
    }, "#b3261e");
    const coloredMolecule = selectedMolecule(bondColored);

    expect(coloredMolecule.style).toMatchObject({
      atomLabelColors: { [atomId]: "#c75c12" },
      bondColors: { [bondId]: "#b3261e" }
    });
    expect(coloredMolecule.style.bondColor).toBe(molecule.style.bondColor);
    expect(coloredMolecule.style.atomLabelColor).toBe(molecule.style.atomLabelColor);
  });

  it("applies toolbar colors to a selected molecule object", () => {
    const document = insertNativeSingleBondMolecule(
      createPhase4Document("Toolbar Molecule Color"),
      { x: 300, y: 300 }
    );
    const molecule = selectedMolecule(document);
    const result = applyToolbarColorToSelection(document, "#b3261e", {
      objectIds: [molecule.id]
    });
    const coloredMolecule = moleculeById(result.document, molecule.id);

    expect(result.targetedSelection).toBe(true);
    expect(result.changed).toBe(true);
    expect(coloredMolecule.style).toMatchObject({
      bondColor: "#b3261e",
      atomLabelColor: "#b3261e"
    });
  });

  it("applies toolbar colors to a selected native molecule fragment", () => {
    const document = insertNativeSingleBondMolecule(
      createPhase4Document("Toolbar Fragment Color"),
      { x: 300, y: 300 }
    );
    const molecule = selectedMolecule(document);
    const atomId = molecule.atoms[0]?.id;
    const bondId = molecule.bonds[0]?.id;
    if (!atomId || !bondId) {
      throw new Error("Expected native molecule atom and bond.");
    }

    const result = applyToolbarColorToSelection(document, "#c75c12", {
      objectIds: [],
      moleculePart: { objectId: molecule.id, kind: "parts", atomIds: [atomId], bondIds: [bondId] }
    });
    const coloredMolecule = moleculeById(result.document, molecule.id);

    expect(result.targetedSelection).toBe(true);
    expect(result.changed).toBe(true);
    expect(coloredMolecule.style).toMatchObject({
      atomLabelColors: { [atomId]: "#c75c12" },
      bondColors: { [bondId]: "#c75c12" }
    });
    expect(coloredMolecule.style.bondColor).toBe(molecule.style.bondColor);
  });

  it("applies toolbar colors to a selected text range only", () => {
    const document = insertNativeTextObject(
      createPhase4Document("Toolbar Text Range Color"),
      { x: 120, y: 140 },
      "H2O"
    );
    const textObject = getSelectedTextObject(document);
    if (!textObject) {
      throw new Error("Expected inserted text object to be selected.");
    }

    const result = applyToolbarColorToSelection(document, "#1f5fbf", {
      objectIds: [],
      textRange: { objectId: textObject.id, range: { start: 1, end: 2 } }
    });
    const coloredText = result.document.pages[0].objects.find(
      (object): object is TextObject => object.id === textObject.id && object.type === "text"
    );

    expect(result.targetedSelection).toBe(true);
    expect(result.changed).toBe(true);
    expect(coloredText?.style.color).toBe(textObject.style.color);
    expect(coloredText?.spans).toEqual([
      { text: "H", script: "normal", style: {} },
      { text: "2", script: "normal", style: { color: "#1f5fbf" } },
      { text: "O", script: "normal", style: {} }
    ]);
  });

  it("resolves toolbar color fallback selections only while targets still exist", () => {
    const document = insertNativeSingleBondMolecule(
      createPhase4Document("Toolbar Fallback Color"),
      { x: 300, y: 300 }
    );
    const molecule = selectedMolecule(document);
    const fallback = { objectIds: [molecule.id] };

    expect(resolveToolbarColorSelection(document, { objectIds: [] }, fallback)).toEqual(fallback);

    const deleted = applyPatches(document, [{ op: "removeObject", objectId: molecule.id }]);
    expect(resolveToolbarColorSelection(deleted, { objectIds: [] }, fallback)).toEqual({ objectIds: [] });
    expect(resolveToolbarColorSelection(document, { objectIds: [] })).toEqual({ objectIds: [] });
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

  it("lets text boxes stretch vertically and preserves an explicit text area while text changes", () => {
    const document = insertNativeTextObject(
      createPhase4Document("Resizable Text Height"),
      { x: 120, y: 140 },
      "short note",
      { fontSizePx: 18 }
    );
    const text = getSelectedTextObject(document);
    if (!text) {
      throw new Error("Expected selected text object.");
    }
    const taller = resizeNativeTextObjectBox(document, text.id, { y: text.y - 18, height: text.height + 48 });
    const tallerText = getSelectedTextObject(taller);
    if (!tallerText) {
      throw new Error("Expected selected resized text object.");
    }
    const changed = updateNativeTextObjectText(taller, tallerText.id, "a much longer note that would normally reflow");
    const changedText = getSelectedTextObject(changed);

    expect(tallerText.y).toBe(text.y - 18);
    expect(tallerText.height).toBe(text.height + 48);
    expect(tallerText.style.textBoxSizingMode).toBe("fixed-size");
    expect(changedText?.width).toBe(tallerText.width);
    expect(changedText?.height).toBe(tallerText.height);
  });

  it("deletes selected native text objects without touching chemistry objects", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Delete Text"), { x: 300, y: 300 });
    const withText = insertNativeTextObject(document, { x: 120, y: 140 }, "delete me");
    const text = getSelectedTextObject(withText);
    if (!text) {
      throw new Error("Expected selected text object.");
    }
    const deleted = deleteSelectedDocumentObjects(withText);

    expect(deleted.pages[0].objects.some((object) => object.id === text.id)).toBe(false);
    expect(deleted.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule")).toHaveLength(1);
    expect(deleted.selection.objectIds).toEqual([]);
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
        -60
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
      -60
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
        -60
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
      -120,
      120,
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
    const neopentane = [-120, 120, 180].reduce(
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
    const neopentane = [-120, 120, 180].reduce(
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
    const neopentane = [-120, 120, 180].reduce(
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
    const neopentane = [-120, 120, 180].reduce(
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
    const neopentane = [-120, 120, 180].reduce(
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
    const withTertButylStem = growFromAtom(withMethyl, "atom_004", -60);
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

  it("maps native stereobond and template toolbar commands onto owned drawing behavior", () => {
    expect(nativeBondStyleForToolCommand("tool.bond")).toBe("solid");
    expect(nativeBondStyleForToolCommand("tool.wedgeBond")).toBe("wedge");
    expect(nativeBondStyleForToolCommand("tool.hashedBond")).toBe("hashed");
    expect(nativeBondStyleForToolCommand("tool.dashedBond")).toBe("dashed");
    expect(nativeBondStyleForToolCommand("tool.boldBond")).toBe("bold");
    expect(nativeTemplateForToolCommand("tool.cyclopentane")).toBe("cyclopentane");
    expect(nativeTemplateForToolCommand("tool.cyclohexane")).toBe("cyclohexane");
    expect(nativeTemplateForToolCommand("tool.benzene")).toBe("benzene");
    expect(nativeTemplateForToolCommand("tool.chairCyclohexaneA")).toBe("chairCyclohexaneA");
    expect(nativeTemplateForToolCommand("tool.chairCyclohexaneB")).toBe("chairCyclohexaneB");
  });

  it("preserves styled bond display metadata when placing and restyling native bonds", () => {
    const document = insertNativeSingleBondMolecule(
      createPhase4Document("Wedge Bond"),
      { x: 200, y: 220 },
      { bondStyle: "wedge" }
    );
    const molecule = selectedMolecule(document);

    expect(molecule.bonds[0].display?.bondStyle).toBe("wedge");

    const bond = molecule.bonds[0];
    const dashed = applyNativeBondDisplayStyleTarget(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: bond.id,
      fromAtomId: bond.fromAtomId,
      toAtomId: bond.toAtomId,
      distanceToPointer: 0
    }, "dashed");

    expect(selectedMolecule(dashed).bonds[0].display?.bondStyle).toBe("dashed");
  });

  it("applies styled bond metadata to freeform native bond growth", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Hashed Growth"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const sourceAtom = molecule.atoms.find((atom) => atom.id === "atom_002");
    if (!sourceAtom) {
      throw new Error("Expected source atom.");
    }

    const next = applyFreeformSingleBondToolAtPoint(
      document,
      molecule.id,
      sourceAtom.id,
      { x: sourceAtom.x + nativeBondLengthPx, y: sourceAtom.y },
      { forceCustomLength: true, bondStyle: "hashed" }
    );
    const grown = selectedMolecule(next);

    expect(grown.bonds).toHaveLength(2);
    expect(grown.bonds[1].display?.bondStyle).toBe("hashed");
  });

  it("inserts native ring and chair templates as real molecule graphs", () => {
    const cyclopentane = selectedMolecule(insertNativeTemplateMolecule(
      createPhase4Document("Cyclopentane Template"),
      { x: 260, y: 260 },
      "cyclopentane"
    ));
    const cyclohexane = selectedMolecule(insertNativeTemplateMolecule(
      createPhase4Document("Cyclohexane Template"),
      { x: 260, y: 260 },
      "cyclohexane"
    ));
    const benzene = selectedMolecule(insertNativeTemplateMolecule(
      createPhase4Document("Benzene Template"),
      { x: 260, y: 260 },
      "benzene"
    ));
    const chair = selectedMolecule(insertNativeTemplateMolecule(
      createPhase4Document("Chair Template"),
      { x: 260, y: 260 },
      "chairCyclohexaneA"
    ));
    const alternateChair = selectedMolecule(insertNativeTemplateMolecule(
      createPhase4Document("Alternate Chair Template"),
      { x: 260, y: 260 },
      "chairCyclohexaneB"
    ));

    expect(cyclopentane.atoms).toHaveLength(5);
    expect(cyclopentane.bonds).toHaveLength(5);
    expect(cyclopentane.chemistry?.formula).toBe("C5H10");
    expect(cyclohexane.atoms).toHaveLength(6);
    expect(cyclohexane.bonds).toHaveLength(6);
    expect(cyclohexane.chemistry?.formula).toBe("C6H12");
    expect(benzene.atoms).toHaveLength(6);
    expect(benzene.bonds.filter((bond) => bond.order === "double")).toHaveLength(3);
    expect(benzene.chemistry?.formula).toBe("C6H6");
    expectAromaticDoubleBondsAreInternalPerimeterBonds(benzene);
    expect(chair.bonds).toHaveLength(6);
    expect(chair.chemistry?.formula).toBe("C6H12");
    expect(alternateChair.bonds).toHaveLength(6);
    expect(alternateChair.chemistry?.formula).toBe("C6H12");
    expectChairCyclohexaneSilhouette(chair);
    expectChairCyclohexaneSilhouette(alternateChair);
  });

  it("fuses benzene template bond clicks into naphthalene and anthracene graphs", () => {
    let document = insertNativeTemplateMolecule(
      createPhase4Document("Anthracene Template Stress"),
      { x: 360, y: 320 },
      "benzene"
    );
    const benzene = selectedMolecule(document);

    document = applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(benzene, "bond_001"),
      moleculeBondMidpoint(benzene, "bond_001"),
      "benzene"
    );
    const naphthalene = selectedMolecule(document);

    expect(document.pages[0].objects.filter((object) => object.type === "molecule")).toHaveLength(1);
    expect(naphthalene.atoms).toHaveLength(10);
    expect(naphthalene.bonds).toHaveLength(11);
    expect(naphthalene.bonds.filter((bond) => bond.order === "double")).toHaveLength(5);
    expect(naphthalene.chemistry).toMatchObject({ formula: "C10H8", atomCount: 10, bondCount: 11 });
    naphthalene.bonds.forEach((bond) => {
      expect(moleculeBondLength(naphthalene, bond.id)).toBeCloseTo(nativeBondLengthPx, 2);
    });
    expect(moleculeBond(naphthalene, "bond_001").order).toBe("single");
    expectAromaticDoubleBondsAreInternalPerimeterBonds(naphthalene);
    expectNoDuplicateAtomPositions(naphthalene);

    const naphthaleneExtensionBondId = rightmostSixMemberRingPerimeterBondId(naphthalene);
    document = applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(naphthalene, naphthaleneExtensionBondId),
      moleculeBondMidpoint(naphthalene, naphthaleneExtensionBondId),
      "benzene"
    );
    const anthracene = selectedMolecule(document);

    expect(document.pages[0].objects.filter((object) => object.type === "molecule")).toHaveLength(1);
    expect(anthracene.atoms).toHaveLength(14);
    expect(anthracene.bonds).toHaveLength(16);
    expect(anthracene.bonds.filter((bond) => bond.order === "double")).toHaveLength(7);
    expect(anthracene.chemistry).toMatchObject({ formula: "C14H10", atomCount: 14, bondCount: 16 });
    anthracene.bonds.forEach((bond) => {
      expect(moleculeBondLength(anthracene, bond.id)).toBeCloseTo(nativeBondLengthPx, 2);
    });
    expect(moleculeBond(anthracene, naphthaleneExtensionBondId).order).toBe("single");
    expectAromaticDoubleBondsAreInternalPerimeterBonds(anthracene);
    expectNoDuplicateAtomPositions(anthracene);

    const anthraceneExtensionBondId = rightmostSixMemberRingPerimeterBondId(anthracene);
    document = applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(anthracene, anthraceneExtensionBondId),
      moleculeBondMidpoint(anthracene, anthraceneExtensionBondId),
      "benzene"
    );
    const tetracene = selectedMolecule(document);

    expect(document.pages[0].objects.filter((object) => object.type === "molecule")).toHaveLength(1);
    expect(tetracene.atoms).toHaveLength(18);
    expect(tetracene.bonds).toHaveLength(21);
    expect(tetracene.bonds.filter((bond) => bond.order === "double")).toHaveLength(9);
    expect(tetracene.chemistry).toMatchObject({ formula: "C18H12", atomCount: 18, bondCount: 21 });
    expect(moleculeBond(tetracene, anthraceneExtensionBondId).order).toBe("single");
    expectAromaticDoubleBondsAreInternalPerimeterBonds(tetracene);
    expectNoDuplicateAtomPositions(tetracene);
  });

  it("fuses benzene onto saturated cyclohexane as an aromatic ring with internal double bonds", () => {
    let document = insertNativeTemplateMolecule(
      createPhase4Document("Benzene Fused Cyclohexane"),
      { x: 360, y: 320 },
      "cyclohexane"
    );
    const cyclohexane = selectedMolecule(document);

    document = applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(cyclohexane, "bond_001"),
      moleculeBondMidpoint(cyclohexane, "bond_001"),
      "benzene"
    );
    const fused = selectedMolecule(document);
    const benzeneRingAtomIds = ["atom_001", "atom_002", "atom_007", "atom_008", "atom_009", "atom_010"];

    expect(document.pages[0].objects.filter((object) => object.type === "molecule")).toHaveLength(1);
    expect(fused.atoms).toHaveLength(10);
    expect(fused.bonds).toHaveLength(11);
    expect(fused.bonds.filter((bond) => bond.order === "double")).toHaveLength(3);
    expect(moleculeBond(fused, "bond_001").order).toBe("single");
    expect(fused.chemistry).toMatchObject({ formula: "C10H12", atomCount: 10, bondCount: 11 });
    expectAromaticDoubleBondsAreInternalPerimeterBonds(fused);
    fused.bonds.filter((bond) => bond.order === "double").forEach((bond) => {
      expectDoubleBondInsideRing(fused, bond.id, benzeneRingAtomIds);
    });
    expectNoDuplicateAtomPositions(fused);
  });

  it("fuses cyclohexane template bond clicks and creates spiro rings from atom clicks", () => {
    let document = insertNativeTemplateMolecule(
      createPhase4Document("Cyclohexane Template Fusion"),
      { x: 360, y: 320 },
      "cyclohexane"
    );
    const cyclohexane = selectedMolecule(document);

    document = applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(cyclohexane, "bond_001"),
      moleculeBondMidpoint(cyclohexane, "bond_001"),
      "cyclohexane"
    );
    const fusedCyclohexane = selectedMolecule(document);

    expect(fusedCyclohexane.atoms).toHaveLength(10);
    expect(fusedCyclohexane.bonds).toHaveLength(11);
    expect(fusedCyclohexane.chemistry).toMatchObject({ formula: "C10H18", atomCount: 10, bondCount: 11 });
    expect(atomDegree(fusedCyclohexane, "atom_001")).toBe(3);
    expect(atomDegree(fusedCyclohexane, "atom_002")).toBe(3);
    expectNoDuplicateAtomPositions(fusedCyclohexane);

    const spiroDocument = applyNativeTemplateToolAtTarget(
      insertNativeTemplateMolecule(
        createPhase4Document("Cyclohexane Spiro Template"),
        { x: 360, y: 320 },
        "cyclohexane"
      ),
      moleculeAtomTarget(cyclohexane, "atom_001"),
      moleculeAtom(cyclohexane, "atom_001"),
      "cyclohexane"
    );
    const spiroCyclohexane = selectedMolecule(spiroDocument);

    expect(spiroCyclohexane.atoms).toHaveLength(11);
    expect(spiroCyclohexane.bonds).toHaveLength(12);
    expect(spiroCyclohexane.chemistry).toMatchObject({ formula: "C11H20", atomCount: 11, bondCount: 12 });
    expect(atomDegree(spiroCyclohexane, "atom_001")).toBe(4);
    expectNoDuplicateAtomPositions(spiroCyclohexane);
  });

  it("applies chair templates to bond and atom targets as chair silhouettes", () => {
    let fusedDocument = insertNativeTemplateMolecule(
      createPhase4Document("Chair Template Fusion"),
      { x: 360, y: 320 },
      "cyclohexane"
    );
    const baseCyclohexane = selectedMolecule(fusedDocument);

    fusedDocument = applyNativeTemplateToolAtTarget(
      fusedDocument,
      moleculeBondTarget(baseCyclohexane, "bond_001"),
      moleculeBondMidpoint(baseCyclohexane, "bond_001"),
      "chairCyclohexaneA"
    );
    const fusedChair = selectedMolecule(fusedDocument);

    expect(fusedChair.atoms).toHaveLength(10);
    expect(fusedChair.bonds).toHaveLength(11);
    expect(fusedChair.chemistry).toMatchObject({ formula: "C10H18", atomCount: 10, bondCount: 11 });
    expect(atomDegree(fusedChair, "atom_001")).toBe(3);
    expect(atomDegree(fusedChair, "atom_002")).toBe(3);
    expectMoleculeHasChairCyclohexaneRing(fusedChair);
    expectNoDuplicateAtomPositions(fusedChair);

    let spiroDocument = insertNativeTemplateMolecule(
      createPhase4Document("Chair Template Spiro"),
      { x: 360, y: 320 },
      "cyclohexane"
    );
    const spiroBase = selectedMolecule(spiroDocument);

    spiroDocument = applyNativeTemplateToolAtTarget(
      spiroDocument,
      moleculeAtomTarget(spiroBase, "atom_001"),
      moleculeAtom(spiroBase, "atom_001"),
      "chairCyclohexaneB"
    );
    const spiroChair = selectedMolecule(spiroDocument);

    expect(spiroChair.atoms).toHaveLength(11);
    expect(spiroChair.bonds).toHaveLength(12);
    expect(spiroChair.chemistry).toMatchObject({ formula: "C11H20", atomCount: 11, bondCount: 12 });
    expect(atomDegree(spiroChair, "atom_001")).toBe(4);
    expectMoleculeHasChairCyclohexaneRing(spiroChair);
    expectNoDuplicateAtomPositions(spiroChair);
  });

  it("stress-tests 100 mixed native drawing, transform, color, and cleanup workflows", () => {
    const baseTemplates = ["cyclohexane", "benzene", "chairCyclohexaneA", "chairCyclohexaneB"] as const;
    const fusedTemplates = ["benzene", "chairCyclohexaneA", "chairCyclohexaneB", "cyclohexane"] as const;
    const colors = ["#1d7f68", "#b3261e", "#1f5fbf", "#c75c12", "#4f5f68"] as const;

    Array.from({ length: 100 }, (_, index) => {
      let document = insertNativeTemplateMolecule(
        createPhase4Document(`Native UX Stress ${index + 1}`),
        { x: 300 + index % 5 * 12, y: 300 + index % 4 * 10 },
        baseTemplates[index % baseTemplates.length]
      );
      let molecule = selectedMolecule(document);
      const fusedBondId = molecule.bonds[index % molecule.bonds.length]?.id ?? "bond_001";

      document = applyNativeTemplateToolAtTarget(
        document,
        moleculeBondTarget(molecule, fusedBondId),
        moleculeBondMidpoint(molecule, fusedBondId),
        fusedTemplates[index % fusedTemplates.length]
      );
      molecule = selectedMolecule(document);

      const spiroAtom = molecule.atoms.find((atom) => atomDegree(molecule, atom.id) < 4);
      if (spiroAtom && index % 3 === 0) {
        document = applyNativeTemplateToolAtTarget(
          document,
          moleculeAtomTarget(molecule, spiroAtom.id),
          moleculeAtom(molecule, spiroAtom.id),
          fusedTemplates[(index + 1) % fusedTemplates.length]
        );
        molecule = selectedMolecule(document);
      }

      const editableBond = molecule.bonds[index % molecule.bonds.length];
      if (editableBond && index % 4 === 0) {
        document = applyNativeMoleculeBondOrderValueTarget(document, {
          objectId: molecule.id,
          kind: "bond",
          bondId: editableBond.id,
          fromAtomId: editableBond.fromAtomId,
          toAtomId: editableBond.toAtomId,
          distanceToPointer: 0
        }, index % 8 === 0 ? "double" : "single");
        molecule = selectedMolecule(document);
      }

      document = resizeNativeMoleculeObject(document, molecule.id, {
        x: 0.7 + index % 5 * 0.22,
        y: 0.65 + index % 7 * 0.16
      });
      molecule = selectedMolecule(document);
      document = rotateNativeMoleculeObjectAroundPoint(
        document,
        molecule.id,
        { x: molecule.x + molecule.width / 2, y: molecule.y + molecule.height / 2 },
        (index % 12) * 17 - 90
      );
      molecule = selectedMolecule(document);

      const fragmentBond = molecule.bonds[(index + 1) % molecule.bonds.length];
      if (fragmentBond) {
        document = rotateNativeMoleculeParts(document, {
          objectId: molecule.id,
          kind: "bond",
          bondId: fragmentBond.id
        }, (index % 9) * 11 - 44);
        document = resizeNativeMoleculeParts(document, {
          objectId: molecule.id,
          kind: "bond",
          bondId: fragmentBond.id
        }, {
          x: 0.85 + index % 4 * 0.18,
          y: 0.75 + index % 3 * 0.22
        });
        molecule = selectedMolecule(document);
      }

      const objectColor = applyToolbarColorToSelection(document, colors[index % colors.length], {
        objectIds: [molecule.id]
      });
      expect(objectColor.changed).toBe(true);
      document = objectColor.document;
      molecule = selectedMolecule(document);

      const atomId = molecule.atoms[index % molecule.atoms.length]?.id;
      const bondId = molecule.bonds[index % molecule.bonds.length]?.id;
      if (atomId && bondId) {
        const partColor = applyToolbarColorToSelection(document, colors[(index + 2) % colors.length], {
          objectIds: [],
          moleculePart: { objectId: molecule.id, kind: "parts", atomIds: [atomId], bondIds: [bondId] }
        });
        expect(partColor.changed).toBe(true);
        document = partColor.document;
        molecule = selectedMolecule(document);
      }

      if (index % 2 === 0) {
        document = cleanUpSelectedNativeMolecule2d(document);
        molecule = selectedMolecule(document);
        molecule.bonds.forEach((bond) => {
          expect(moleculeBondLength(molecule, bond.id), `stress case ${index + 1} bond ${bond.id}`).toBeCloseTo(nativeBondLengthPx, 2);
        });
      }

      expectUsableNativeMoleculeGraph(molecule, `stress case ${index + 1}`, {
        minimumAtomDistancePx: index % 2 === 0 ? nativeBondLengthPx * 0.25 : 0.5
      });
      return molecule;
    });
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
