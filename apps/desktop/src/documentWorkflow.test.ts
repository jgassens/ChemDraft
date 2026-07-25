import { describe, expect, it } from "vitest";
import { projectGraphicObjectPoint } from "@chemdraft/art-engine";
import { perceiveStereoCentersFromMolfile, relayoutMolfile2D } from "@chemdraft/ocl-adapter";
import {
  applyPatch,
  applyPatchWithHistory,
  applyPatches,
  createDocumentHistory,
  deserializeDocument,
  inchesToCssPx,
  moleculeToMolfileV2000,
  mmToCssPx,
  redo,
  serializeDocument,
  undo,
  type ChemDraftDocument,
  type DocumentObject,
  type ElectronMarkObject,
  type GraphicObject,
  type GraphicPaint,
  type GroupObject,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  type PlusObject,
  type TextObject,
  type VisualEffect
} from "@chemdraft/chem-core";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import {
  applyChargeToolAtPoint,
  applyClipboardPastePayload,
  applyImportedPageFitRecommendation,
  applyChargeToolAtNativeAtom,
  applyObjectColorToDocumentObjects,
  applyGraphicObjectColorToSelection,
  applyGraphicObjectEyedropperToSelection,
  applyGraphicObjectEffectColorToSelection,
  applyGraphicObjectEffectOpacityToSelection,
  applyGraphicObjectEffectSizeToSelection,
  applyGraphicObjectEffectToSelection,
  applyVisualEffectColorToSelection,
  applyVisualEffectOpacityToSelection,
  applyVisualEffectSizeToSelection,
  applyVisualEffectToSelection,
  deactivateGraphicObjectEffectForSelection,
  deactivateVisualEffectForSelection,
  addGraphicObjectGradientStopForSelection,
  applyGraphicObjectGradientStopColorForSelection,
  applyGraphicObjectGradientStopOffsetForSelection,
  applyGraphicObjectGradientStopOpacityForSelection,
  deleteGraphicObjectGradientStopForSelection,
  deleteGraphicObjectGradientStopAtIndexForSelection,
  applyGraphicObjectNoneToSelection,
  applyGraphicObjectOpacityToSelection,
  applyGraphicObjectPaintTypeToSelection,
  applyGraphicObjectStrokeStyleToSelection,
  applyMoleculeObjectColorToSelection,
  applyMoleculeObjectOpacityToSelection,
  applyMoleculeObjectPaintTypeToSelection,
  applyMoleculeRingEffect,
  applyMoleculeRingFillColor,
  applyMoleculeRingFillOpacity,
  applyMoleculeBaseStylePatch,
  applyMoleculeAtomIndicatorStylePatch,
  applyMoleculeAtomLabelStylePatch,
  applyMoleculeBondStylePatch,
  applyMoleculeTargetBondLength,
  applyMoleculeTargetBondLengthToBonds,
  applyColorToNativeMoleculePart,
  clearMoleculeRingStyles,
  applyNativeArtBooleanOperationToSelection,
  applyToolbarColorToSelection,
  alignSelectedDocumentObjects,
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
  applyNativeMoleculePartsDelete,
  applyNativeMoleculePartDeleteTarget,
  applyNativeTemplatePlacementPlan,
  applyNativeTemplateToolAtPoint,
  applyNativeTemplateToolAtTarget,
  applyDocumentObjectProjectedPlaneTilt,
  planNativeTemplatePlacement,
  applyNativeMoleculeEngineRelayout,
  applySingleBondToolAtPoint,
  applySingleBondToolAtNativeAtom,
  cleanUpNativeMolecules2d,
  cleanUpSelectedNativeMolecule2d,
  moleculeHasFusedRingSystem,
  createNativeArtGraphicObject,
  createNativeFreehandGraphicObject,
  createNativeSavePayload,
  createNativeSingleBondMolecule,
  createPhase4Document,
  createSelectionClipboardPayload,
  deleteSelectedDocumentObjects,
  documentObjectVisualBounds,
  distributeSelectedDocumentObjects,
  duplicateSelectedDocumentObjects,
  exportPhase4Cdxml,
  exportPhase4Svg,
  findNativeMoleculeDeleteHit,
  findNativeMoleculeAtomHit,
  flipDocumentObjectsAroundPoint,
  groupSelectedDocumentObjects,
  getSelectedMolecule,
  insertNativeArtGraphicObject,
  insertAdapterFallbackMolecule,
  applyFormulaTextFormatting,
  applyNativeChainTool,
  applyReactionArrowToolAtPoint,
  bracketKindForToolCommand,
  formulaSpansFromText,
  insertNativeBracket,
  planNativeChainVertices,
  insertNativeSymbolGlyph,
  insertNativeTextObject,
  nativeArtToolForCommand,
  nativeBracketDefaultSize,
  nativeReactionArrowDefaultLengthPx,
  reactionArrowKindForToolCommand,
  stretchNativeReactionArrowTo,
  symbolGlyphForToolCommand,
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
  nativeMoleculePartBounds,
  nativeMoleculeCenter,
  nativeMoleculeTransformState,
  nativeGraphicCornerRadiusEditPoint,
  nativeGraphicPathEditPoints,
  nativeArtToolIsFreehand,
  nativeFreehandStrokeDocument,
  nativeBezierPathDocument,
  nativePolylinePathDocument,
  openNativeDocument,
  prepareGraphicPathForDirectEdit,
  previewNativeMoleculeBondGrowth,
  previewNativeMoleculeFreeformBondGrowth,
  recommendImportedPageFit,
  setDocumentCustomPageSize,
  moveDocumentObject,
  moveNativeMoleculeParts,
  nativeTextObjectMinimumDimensions,
  nativeTextObjectSizeForText,
  reorderNativeMoleculeParts,
  reorderSelectedDocumentObject,
  resolveGroupedDocumentObjectIds,
  resolveToolbarColorSelection,
  resizeNativeMoleculeParts,
  rotateDocumentObject,
  rotateDocumentObjectsAroundPoint,
  rotateSelectedDocumentObjects90,
  rotateNativeMoleculeObjectAroundPoint,
  rotateNativeMoleculeParts,
  selectedGroupObjectIds,
  tiltNativeMoleculeProjectedPlane,
  tiltNativeMoleculeObjectsProjectedPlane,
  tiltNativeMoleculePartsProjectedPlane,
  tiltPointAroundPageAxis,
  resizeNativeMoleculeObject,
  resizeNativeTextObjectBox,
  moveDocumentObjects,
  reverseGraphicObjectGradientStopsForSelection,
  rotateGraphicObjectGradientStopsForSelection,
  scaleDocumentObjectsAroundPoint,
  selectionBounds,
  selectAllDocumentObjects,
  selectedGraphicObjectIds,
  selectedLayerObjectIds,
  selectedVisualEffectObjectIds,
  selectedArtBooleanEligibleObjectIds,
  selectDocumentObject,
  selectDocumentObjectWithinGroup,
  parseSelectionClipboardPayload,
  pasteSelectionClipboardPayload,
  serializeSelectionClipboardPayload,
  swapGraphicObjectFillAndStroke,
  selectDocumentObjects,
  toggleDocumentObjectSelection,
  ungroupSelectedDocumentObjects,
  updateNativeTextObjectScript,
  updateNativeTextObjectScriptRange,
  updateNativeTextObjectStyle,
  updateNativeTextObjectStyleRange,
  updateNativeTextObjectText,
  updateNativeGraphicCornerRadius,
  updateNativeGraphicLinearGradientHandle,
  updateNativeGraphicMarkerHandle,
  updateNativeGraphicPathHandle,
  updateNativeGraphicRadialGradientHandle,
  nativeSingleBondGraphSmiles
} from "./documentWorkflow";
import * as OCL from "openchemlib";

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

function benzeneRingMolecule(overrides: Partial<MoleculeObject> = {}): MoleculeObject {
  return {
    id: "mol_ring",
    type: "molecule",
    x: 150,
    y: 120,
    width: 120,
    height: 104,
    rotation: 0,
    style: { fillColor: "none" },
    structureFormat: "smiles",
    structure: "c1ccccc1",
    atoms: [
      { id: "atom_001", element: "C", x: 210, y: 120, formalCharge: 0 },
      { id: "atom_002", element: "C", x: 262, y: 150, formalCharge: 0 },
      { id: "atom_003", element: "C", x: 262, y: 210, formalCharge: 0 },
      { id: "atom_004", element: "C", x: 210, y: 240, formalCharge: 0 },
      { id: "atom_005", element: "C", x: 158, y: 210, formalCharge: 0 },
      { id: "atom_006", element: "C", x: 158, y: 150, formalCharge: 0 }
    ],
    bonds: [
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
      { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "single" },
      { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_004", order: "single" },
      { id: "bond_004", fromAtomId: "atom_004", toAtomId: "atom_005", order: "single" },
      { id: "bond_005", fromAtomId: "atom_005", toAtomId: "atom_006", order: "single" },
      { id: "bond_006", fromAtomId: "atom_006", toAtomId: "atom_001", order: "single" }
    ],
    superatoms: [],
    rGroups: [],
    ...overrides
  } satisfies MoleculeObject;
}

function bondLength(molecule: MoleculeObject, bondId: string): number {
  const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
  if (!bond) {
    throw new Error(`Expected bond "${bondId}".`);
  }
  const fromAtom = molecule.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = molecule.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    throw new Error(`Expected atoms for bond "${bondId}".`);
  }
  return Math.hypot(toAtom.x - fromAtom.x, toAtom.y - fromAtom.y);
}

function moleculeAtomCenter(molecule: MoleculeObject): { x: number; y: number } {
  const xs = molecule.atoms.map((atom) => atom.x);
  const ys = molecule.atoms.map((atom) => atom.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2
  };
}

function moleculeVisualEffects(document: ChemDraftDocument, objectId: string): VisualEffect[] | undefined {
  return moleculeById(document, objectId).style.visualEffects as VisualEffect[] | undefined;
}

function moleculeInactiveVisualEffects(document: ChemDraftDocument, objectId: string): VisualEffect[] | undefined {
  return moleculeById(document, objectId).style.inactiveVisualEffects as VisualEffect[] | undefined;
}

function graphicById(document: ChemDraftDocument, objectId: string): GraphicObject {
  const graphic = document.pages
    .flatMap((page) => page.objects)
    .find((object): object is GraphicObject => object.id === objectId && object.type === "graphic");
  if (!graphic) {
    throw new Error(`Expected graphic "${objectId}".`);
  }
  return graphic;
}

function objectStyleById(document: ChemDraftDocument, objectId: string): Record<string, unknown> {
  const object = document.pages
    .flatMap((page) => page.objects)
    .find((candidate) => candidate.id === objectId);
  if (!object) {
    throw new Error(`Expected object "${objectId}".`);
  }
  return object.style;
}

function exportedObjectTag(svg: string, objectId: string): string {
  const escapedObjectId = objectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = svg.match(new RegExp(`<[^>]+data-object-id="${escapedObjectId}"[^>]*>`));
  if (!match) {
    throw new Error(`Expected exported SVG element for "${objectId}".`);
  }
  return match[0];
}

function exportedAttribute(tag: string, attributeName: string): string {
  const escapedAttributeName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\s${escapedAttributeName}="([^"]+)"`));
  if (!match) {
    throw new Error(`Expected exported SVG attribute "${attributeName}".`);
  }
  return match[1];
}

function svgPathCoordinatePairs(pathD: string): { x: number; y: number }[] {
  const values = pathD.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const pairs: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    pairs.push({ x: values[index], y: values[index + 1] });
  }
  return pairs;
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

function translatedPoint(point: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } {
  return {
    x: point.x + dx,
    y: point.y + dy
  };
}

function scaledPoint(
  point: { x: number; y: number },
  oldCenter: { x: number; y: number },
  newCenter: { x: number; y: number },
  scaleX: number,
  scaleY: number
): { x: number; y: number } {
  return {
    x: newCenter.x + (point.x - oldCenter.x) * scaleX,
    y: newCenter.y + (point.y - oldCenter.y) * scaleY
  };
}

function rotatedPointAround(
  point: { x: number; y: number },
  center: { x: number; y: number },
  degrees: number
): { x: number; y: number } {
  const radians = degToRad(degrees);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

function projectGraphicVisualPoint(
  graphic: GraphicObject,
  point: { x: number; y: number }
): { x: number; y: number } {
  return rotatedPointAround(
    projectGraphicObjectPoint(graphic, point),
    {
      x: graphic.x + Math.max(graphic.width, 1) / 2,
      y: graphic.y + Math.max(graphic.height, 1) / 2
    },
    graphic.rotation
  );
}

function expectPointToBeClose(
  actual: { x: number; y: number } | undefined,
  expected: { x: number; y: number },
  precision = 6
): void {
  expect(actual?.x).toBeCloseTo(expected.x, precision);
  expect(actual?.y).toBeCloseTo(expected.y, precision);
}

function degToRad(degrees: number): number {
  return degrees * Math.PI / 180;
}

function pointOnGraphicEllipse(graphic: GraphicObject, radians: number): { x: number; y: number } {
  const center = graphic.data.arcCenter ?? {
    x: graphic.x + graphic.width / 2,
    y: graphic.y + graphic.height / 2
  };
  return {
    x: center.x + Math.cos(radians) * Math.max(graphic.data.arcRadiusX ?? graphic.width / 2 - 4, 1),
    y: center.y + Math.sin(radians) * Math.max(graphic.data.arcRadiusY ?? graphic.height / 2 - 4, 1)
  };
}

function boundsCenter(bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number; z: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    z: 0
  };
}

function expectedProjectedPlanePoint(
  atom: { x: number; y: number; z?: number },
  center: { x: number; y: number; z?: number },
  tiltXRad: number,
  tiltYRad: number,
  rotationDegrees = 0
): { x: number; y: number; z: number } {
  const cx = Math.cos(tiltXRad);
  const sx = Math.sin(tiltXRad);
  const cy = Math.cos(tiltYRad);
  const sy = Math.sin(tiltYRad);
  const zRad = degToRad(rotationDegrees);
  const cz = Math.cos(zRad);
  const sz = Math.sin(zRad);
  const dx = atom.x - center.x;
  const dy = atom.y - center.y;
  const dz = (atom.z ?? 0) - (center.z ?? 0);

  // Mirrors production projectedPlaneRotationMatrix: R_x · R_y · R_z (screen-space tilt).
  return {
    x: center.x + cy * cz * dx - cy * sz * dy + sy * dz,
    y: center.y + (cx * sz + sx * sy * cz) * dx + (cx * cz - sx * sy * sz) * dy - sx * cy * dz,
    z: (center.z ?? 0) + (sx * sz - cx * sy * cz) * dx + (sx * cz + cx * sy * sz) * dy + cx * cy * dz
  };
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
    expect(payload.mimeType).toBe("chemical/x-cdxml");
    expect(payload.contents).toContain("<CDXML");
    expect(payload.warnings).toEqual([]);
    expect(reopened.source).toBe("native-payload");
    expect(reopened.warnings).toEqual([]);
    expect(reopened.document).toEqual(document);
  });

  it("saves and opens per-ring molecule styles", () => {
    const base = createPhase4Document("Ring Style Round Trip");
    const molecule = benzeneRingMolecule();
    const ringKey = "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006";
    const target = { objectId: molecule.id, kind: "ring" as const, ringKey };
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule },
      { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
    ]);
    const styled = applyMoleculeRingEffect(
      applyMoleculeRingFillOpacity(
        applyMoleculeRingFillColor(document, target, "#1f5fbf"),
        target,
        0.54
      ),
      target,
      "shadow"
    );

    const reopened = openNativeDocument(createNativeSavePayload(styled).contents);

    expect(reopened.source).toBe("native-payload");
    expect(reopened.warnings).toEqual([]);
    const reopenedMolecule = moleculeById(reopened.document!, molecule.id);
    const ringStyle = (reopenedMolecule.style.ringStyles as Record<string, Record<string, unknown>>)[ringKey];
    expect(reopenedMolecule.atoms).toEqual(molecule.atoms);
    expect(reopenedMolecule.bonds).toEqual(molecule.bonds);
    expect(ringStyle.fillColor).toBe("#1f5fbf");
    expect(ringStyle.fillOpacity).toBe(0.54);
    expect((ringStyle.visualEffects as VisualEffect[])[0]).toMatchObject({ kind: "shadow" });
  });

  it("recommends a custom page sized exactly to oversized imported content", () => {
    const document = createPhase4Document("Oversized Import");
    const oversizedMolecule: MoleculeObject = {
      id: "mol_oversized_import",
      type: "molecule",
      x: 96,
      y: 120,
      width: 2500,
      height: 1300,
      rotation: 0,
      style: {},
      structureFormat: "unknown",
      structure: "",
      atoms: [],
      bonds: [],
      superatoms: [],
      rGroups: []
    };
    const imported = {
      ...document,
      pages: [{
        ...document.pages[0],
        objects: [oversizedMolecule]
      }]
    };

    const recommendation = recommendImportedPageFit(imported);

    // A custom exact-fit, in the current page's unit (US Letter ⇒ inches), wider than tall.
    expect(recommendation).toMatchObject({
      currentPresetId: "letter",
      currentOrientation: "portrait",
      recommendedPresetId: "custom",
      recommendedOrientation: "landscape"
    });
    expect(recommendation?.recommendedPageTitle).toMatch(/^Custom .+ in$/);
    expect(recommendation?.recommendedLayout.sourceUnit).toBe("inch");
    // The custom layout fully contains the content (rounded up, never clipped).
    expect(recommendation!.recommendedLayout.widthPx).toBeGreaterThanOrEqual(recommendation!.requiredWidthPx);
    expect(recommendation!.recommendedLayout.heightPx).toBeGreaterThanOrEqual(recommendation!.requiredHeightPx);

    const resized = applyImportedPageFitRecommendation(imported, recommendation!);
    expect(resized.pages[0].layout.presetId).toBe("custom");
    expect(resized.pages[0].width).toBeGreaterThanOrEqual(recommendation!.requiredWidthPx);
    expect(resized.pages[0].height).toBeGreaterThanOrEqual(recommendation!.requiredHeightPx);
    // Identity/size preserved; the content is nudged onto the exactly-sized page so it fits.
    const placed = resized.pages[0].objects[0] as MoleculeObject;
    expect(placed).toMatchObject({ id: "mol_oversized_import", type: "molecule", width: 2500, height: 1300 });
    expect(placed.x).toBeGreaterThanOrEqual(0);
    expect(placed.y).toBeGreaterThanOrEqual(0);
    expect(placed.x + placed.width).toBeLessThanOrEqual(resized.pages[0].width + 1e-6);
    expect(placed.y + placed.height).toBeLessThanOrEqual(resized.pages[0].height + 1e-6);
  });

  it("applies a custom page size in inches or millimetres and round-trips through the schema", () => {
    const inches = setDocumentCustomPageSize(createPhase4Document("Custom in"), { width: 13, height: 9, unit: "inch" });
    expect(inches.pages[0].layout).toMatchObject({ presetId: "custom", sourceUnit: "inch", sourceWidth: 13, sourceHeight: 9, orientation: "landscape" });
    expect(inches.pages[0].width).toBeCloseTo(inchesToCssPx(13), 6);
    expect(inches.pages[0].height).toBeCloseTo(inchesToCssPx(9), 6);
    // Survives strict serialize → deserialize (the schema accepts the custom layout).
    expect(deserializeDocument(serializeDocument(inches)).pages[0].layout.sourceWidth).toBe(13);

    const metric = setDocumentCustomPageSize(createPhase4Document("Custom mm"), { width: 300, height: 400, unit: "mm" });
    expect(metric.pages[0].layout).toMatchObject({ presetId: "custom", sourceUnit: "mm", orientation: "portrait" });
    expect(metric.pages[0].width).toBeCloseTo(mmToCssPx(300), 6);
    expect(metric.pages[0].height).toBeCloseTo(mmToCssPx(400), 6);
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

  it("plans zig-zag chain vertices from the drag vector and chain angle", () => {
    const single = planNativeChainVertices({
      start: { x: 100, y: 100 },
      bondLengthPx: 22,
      chainAngleDegrees: 120
    });
    expect(single).toHaveLength(2);

    const reach = 22 * Math.cos((Math.PI / 180) * 30);
    const dragged = planNativeChainVertices({
      start: { x: 100, y: 100 },
      dragPoint: { x: 100 + reach * 4, y: 100 },
      bondLengthPx: 22,
      chainAngleDegrees: 120
    });
    expect(dragged).toHaveLength(5);
    // Every segment has the bond length, and consecutive segments meet at the chain angle.
    for (let index = 1; index < dragged.length; index += 1) {
      const dx = dragged[index].x - dragged[index - 1].x;
      const dy = dragged[index].y - dragged[index - 1].y;
      expect(Math.hypot(dx, dy)).toBeCloseTo(22, 6);
    }
    // Zig-zag alternates above and below the horizontal drag axis.
    expect(dragged[1].y).toBeLessThan(100);
    expect(dragged[2].y).toBeCloseTo(100, 6);
    expect(dragged[3].y).toBeLessThan(100);

    const short = planNativeChainVertices({
      start: { x: 100, y: 100 },
      dragPoint: { x: 103, y: 100 },
      bondLengthPx: 22,
      chainAngleDegrees: 120
    });
    expect(short).toHaveLength(2);
  });

  it("draws a free chain molecule and appends an anchored chain to an existing molecule", () => {
    const blank = createPhase4Document("Chain Fixture");
    const reach = 22 * Math.cos((Math.PI / 180) * 30);
    const free = applyNativeChainTool(blank, { x: 200, y: 220 }, { x: 200 + reach * 3, y: 220 });
    const chain = free.pages[0].objects[0];

    expect(chain.type).toBe("molecule");
    if (chain.type === "molecule") {
      expect(chain.atoms).toHaveLength(4);
      expect(chain.bonds).toHaveLength(3);
      expect(chain.bonds.every((bond) => bond.order === "single")).toBe(true);
    }
    expect(free.selection.objectIds).toEqual([chain.id]);

    const seeded = insertNativeSingleBondMolecule(blank, { x: 300, y: 300 });
    const molecule = seeded.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected a molecule fixture");
    }
    const anchorAtom = molecule.atoms[molecule.atoms.length - 1];
    const grown = applyNativeChainTool(
      seeded,
      { x: anchorAtom.x, y: anchorAtom.y },
      { x: anchorAtom.x + reach * 2, y: anchorAtom.y },
      { objectId: molecule.id, atomId: anchorAtom.id }
    );
    const grownMolecule = grown.pages[0].objects[0];
    if (grownMolecule.type !== "molecule") {
      throw new Error("Expected the grown molecule");
    }
    expect(grownMolecule.atoms).toHaveLength(molecule.atoms.length + 2);
    expect(grownMolecule.bonds).toHaveLength(molecule.bonds.length + 2);
    expect(grown.selection.objectIds).toEqual([molecule.id]);

    expect(applyNativeChainTool(seeded, { x: 0, y: 0 }, undefined, { objectId: "missing", atomId: "atom_001" })).toBe(seeded);
  });

  it("formats formula text spans with subscripts and a superscript charge", () => {
    expect(formulaSpansFromText("H2O")).toEqual([
      { text: "H", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} }
    ]);
    expect(formulaSpansFromText("C6H12O6")).toEqual([
      { text: "C", script: "normal", style: {} },
      { text: "6", script: "subscript", style: {} },
      { text: "H", script: "normal", style: {} },
      { text: "12", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} },
      { text: "6", script: "subscript", style: {} }
    ]);
    expect(formulaSpansFromText("SO42-")).toEqual([
      { text: "SO", script: "normal", style: {} },
      { text: "4", script: "subscript", style: {} },
      { text: "2-", script: "superscript", style: {} }
    ]);
    expect(formulaSpansFromText("Ca2+")).toEqual([
      { text: "Ca", script: "normal", style: {} },
      { text: "2+", script: "superscript", style: {} }
    ]);
    expect(formulaSpansFromText("plain")).toEqual([
      { text: "plain", script: "normal", style: {} }
    ]);
  });

  it("applies formula formatting to selected text objects only", () => {
    const blank = createPhase4Document("Formula Fixture");
    const withText = insertNativeTextObject(blank, { x: 200, y: 200 }, "H2O");
    const formatted = applyFormulaTextFormatting(withText);
    const object = formatted.pages[0].objects[0];

    if (object.type !== "text") {
      throw new Error("Expected a text object");
    }
    expect(object.spans.map((span) => span.script)).toEqual(["normal", "subscript", "normal"]);

    // No selected text objects -> unchanged document.
    expect(applyFormulaTextFormatting(blank)).toBe(blank);
    // Re-applying the same formatting is a no-op.
    expect(applyFormulaTextFormatting(formatted)).toBe(formatted);
  });

  it("maps bracket tool commands and inserts a selected default bracket", () => {
    expect(bracketKindForToolCommand("tool.bracket")).toBe("curly");
    expect(bracketKindForToolCommand("tool.squareBracket")).toBe("square");
    expect(bracketKindForToolCommand("tool.text")).toBeUndefined();

    const blank = createPhase4Document("Bracket Fixture");
    const placed = insertNativeBracket(blank, { x: 200, y: 220 }, "curly");
    const object = placed.pages[0].objects[0];

    expect(object).toMatchObject({
      type: "bracket",
      bracketKind: "curly",
      width: nativeBracketDefaultSize.width,
      height: nativeBracketDefaultSize.height
    });
    if (object.type === "bracket") {
      // Centered on the click point.
      expect(object.x).toBe(200 - nativeBracketDefaultSize.width / 2);
      expect(object.y).toBe(220 - nativeBracketDefaultSize.height / 2);
      expect(object.containedObjectIds).toEqual([]);
    }
    expect(placed.selection.objectIds).toEqual([object.id]);
  });

  it("registers orbital tools as closed art shapes with chemistry command ids", () => {
    const lobe = nativeArtToolForCommand("tool.lobe");
    expect(lobe).toMatchObject({ id: "lobe", graphicKind: "path" });
    expect(lobe?.data.pathClosed).toBe(true);
    expect(lobe?.data.pathNodes).toHaveLength(2);

    const shadedLobe = nativeArtToolForCommand("tool.shadedLobe");
    expect(shadedLobe?.style.fillMode).toBe("gloss");
    expect(shadedLobe?.data.pathClosed).toBe(true);

    const pOrbital = nativeArtToolForCommand("tool.pOrbital");
    expect(pOrbital?.data.pathNodes).toHaveLength(4);
    expect(pOrbital?.data.pathClosed).toBe(true);

    const sOrbital = nativeArtToolForCommand("tool.sOrbital");
    expect(sOrbital).toMatchObject({ graphicKind: "ellipse" });
    expect(sOrbital?.style.fillMode).toBe("gloss");
  });

  it("maps arrow tool commands to reaction-arrow kinds", () => {
    expect(reactionArrowKindForToolCommand("tool.reactionArrow")).toBe("forward");
    expect(reactionArrowKindForToolCommand("tool.resonanceArrow")).toBe("resonance");
    expect(reactionArrowKindForToolCommand("tool.equilibriumArrow")).toBe("equilibrium");
    expect(reactionArrowKindForToolCommand("tool.retroArrow")).toBe("retrosynthesis");
    expect(reactionArrowKindForToolCommand("tool.bond")).toBeUndefined();
  });

  it("inserts a default-length reaction arrow at the click point", () => {
    const blank = createPhase4Document("Arrow Click Fixture");
    const placed = applyReactionArrowToolAtPoint(blank, { x: 200, y: 220 }, "equilibrium");
    const object = placed.pages[0].objects[0];

    expect(object).toMatchObject({
      type: "reaction-arrow",
      arrowKind: "equilibrium",
      start: { kind: "point", point: { x: 200, y: 220 } },
      end: { kind: "point", point: { x: 200 + nativeReactionArrowDefaultLengthPx, y: 220 } }
    });
    expect(placed.selection.objectIds).toEqual([object.id]);
    if (object.type === "reaction-arrow") {
      expect(object.width).toBe(nativeReactionArrowDefaultLengthPx);
      expect(object.height).toBeGreaterThanOrEqual(24);
    }
  });

  it("stretches a placed reaction arrow to the drag point and ignores tiny drags", () => {
    const blank = createPhase4Document("Arrow Stretch Fixture");
    const placed = applyReactionArrowToolAtPoint(blank, { x: 200, y: 220 }, "forward");
    const objectId = placed.selection.objectIds[0];

    const stretched = stretchNativeReactionArrowTo(placed, objectId, { x: 200, y: 220 }, { x: 320, y: 300 });
    const arrow = stretched.pages[0].objects[0];
    expect(arrow).toMatchObject({
      type: "reaction-arrow",
      arrowKind: "forward",
      start: { kind: "point", point: { x: 200, y: 220 } },
      end: { kind: "point", point: { x: 320, y: 300 } }
    });
    if (arrow.type === "reaction-arrow") {
      expect(arrow.x).toBe(200);
      expect(arrow.width).toBe(120);
      expect(arrow.height).toBe(80);
    }

    expect(stretchNativeReactionArrowTo(placed, objectId, { x: 200, y: 220 }, { x: 203, y: 221 })).toBe(placed);
    expect(stretchNativeReactionArrowTo(placed, "missing_object", { x: 0, y: 0 }, { x: 90, y: 0 })).toBe(placed);
  });

  it("maps symbol tool commands to their stamp glyphs", () => {
    expect(symbolGlyphForToolCommand("tool.dagger")).toBe("‡");
    expect(symbolGlyphForToolCommand("tool.symbol")).toBe("°");
    expect(symbolGlyphForToolCommand("tool.symbol.degree")).toBe("°");
    expect(symbolGlyphForToolCommand("tool.symbol.plusMinus")).toBe("±");
    expect(symbolGlyphForToolCommand("tool.symbol.angstrom")).toBe("Å");
    expect(symbolGlyphForToolCommand("tool.symbol.delta")).toBe("Δ");
    expect(symbolGlyphForToolCommand("tool.symbol.centerDot")).toBe("·");
    expect(symbolGlyphForToolCommand("tool.symbol.prime")).toBe("′");
    expect(symbolGlyphForToolCommand("tool.text")).toBeUndefined();
    expect(symbolGlyphForToolCommand("tool.bond")).toBeUndefined();
  });

  it("stamps a symbol glyph as a selected native text object", () => {
    const blank = createPhase4Document("Symbol Stamp Fixture");
    const stamped = insertNativeSymbolGlyph(blank, { x: 240, y: 200 }, "‡");
    const object = stamped.pages[0].objects[0];

    expect(stamped.pages[0].objects).toHaveLength(1);
    expect(object).toMatchObject({ type: "text", text: "‡" });
    expect(stamped.selection.objectIds).toEqual([object.id]);
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

  it("does not rewrite native molecule atom or bond parts for visual depth", () => {
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
    expect(selectedMolecule(atomForward).bonds.map((bond) => bond.id)).toEqual(["bond_left", "bond_bridge", "bond_right"]);
    expect(selectedMolecule(bondBackward).bonds.map((bond) => bond.id)).toEqual(["bond_left", "bond_bridge", "bond_right"]);
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
    const center = nativeMoleculeCenter(molecule);
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

  it("keeps benzene double-bond secondary lines inside the ring after a 90-degree rotation", () => {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Rotated Benzene Display"),
      { x: 260, y: 260 },
      "benzene"
    );
    const molecule = selectedMolecule(document);
    const rotated = rotateNativeMoleculeObjectAroundPoint(document, molecule.id, { x: 260, y: 260 }, 90);
    const rotatedMolecule = selectedMolecule(rotated);

    expect(rotatedMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(rotatedMolecule.structure).toBe(molecule.structure);
    expect(rotatedMolecule.chemistry).toEqual(molecule.chemistry);
    expectAromaticDoubleBondsAreInternalPerimeterBonds(rotatedMolecule);
  });

  it("refreshes cyclic double-bond sides after projected-plane rotation flips screen orientation", () => {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Projected Benzene Display"),
      { x: 260, y: 260 },
      "benzene"
    );
    const molecule = selectedMolecule(document);
    const initialSides = new Map(molecule.bonds.map((bond) => [bond.id, bond.display?.doubleBondSide]));
    const result = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      { x: 260, y: 260 },
      0,
      0,
      { tiltYRad: degToRad(120), persistTransform: true }
    );
    const tiltedMolecule = selectedMolecule(result.document);

    expect(result.changed).toBe(true);
    expect(tiltedMolecule.structure).toBe(molecule.structure);
    expect(tiltedMolecule.chemistry).toEqual(molecule.chemistry);
    expect(tiltedMolecule.bonds.some((bond) =>
      bond.order === "double" && bond.display?.doubleBondSide !== initialSides.get(bond.id)
    )).toBe(true);
    expectAromaticDoubleBondsAreInternalPerimeterBonds(tiltedMolecule);
  });

  it("tilts a point around a horizontal page axis by rigid orthographic projection", () => {
    const tilt = degToRad(60);
    const point = tiltPointAroundPageAxis({ x: 12, y: 20 }, { x: 2, y: 5 }, 0, tilt);

    expect(point.x).toBeCloseTo(12, 6);
    expect(point.y).toBeCloseTo(5 + (20 - 5) * Math.cos(tilt), 6);
    expect(point.z).toBeCloseTo((20 - 5) * Math.sin(tilt), 6);
  });

  it("tilts a point around a vertical page axis by rigid orthographic projection", () => {
    const tilt = degToRad(45);
    const point = tiltPointAroundPageAxis({ x: 20, y: 18 }, { x: 8, y: 3 }, Math.PI / 2, tilt);

    expect(point.x).toBeCloseTo(8 + (20 - 8) * Math.cos(tilt), 6);
    expect(point.y).toBeCloseTo(18, 6);
    expect(point.z).toBeCloseTo(-(20 - 8) * Math.sin(tilt), 6);
  });

  it("tilts around an arbitrary page axis while preserving coordinates along the axis", () => {
    const axis = degToRad(32);
    const center = { x: 100, y: 120 };
    const along = 38;
    const point = {
      x: center.x + Math.cos(axis) * along,
      y: center.y + Math.sin(axis) * along
    };
    const tilted = tiltPointAroundPageAxis(point, center, axis, degToRad(70));

    expect(tilted.x).toBeCloseTo(point.x, 6);
    expect(tilted.y).toBeCloseTo(point.y, 6);
    expect(tilted.z).toBeCloseTo(0, 6);
  });

  it("applies a projected-plane tilt to a whole native molecule without changing chemical identity", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Tilt"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const chemistry = molecule.chemistry;
    if (!chemistry) {
      throw new Error("Expected native molecule chemistry metadata.");
    }
    const enriched = applyPatches(document, [{
      op: "updateObject",
      objectId: molecule.id,
      changes: {
        chemistry: {
          ...chemistry,
          warnings: chemistry.warnings ?? [],
          isotopeLabels: ["13C"],
          radicalCount: 1,
          stereochemistry: ["specified-test-center"]
        },
        atoms: molecule.atoms.map((atom, index) => ({
          ...atom,
          formalCharge: index === 1 ? 1 : atom.formalCharge,
          labelVisible: index === 1 ? true : atom.labelVisible
        }))
      }
    }]);
    const start = selectedMolecule(enriched);
    const center = boundsCenter(start);
    const result = tiltNativeMoleculeProjectedPlane(enriched, start.id, center, 0, degToRad(40));
    const tilted = selectedMolecule(result.document);

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(tilted.id).toBe(start.id);
    expect(tilted.rotation).toBe(start.rotation);
    expect(tilted.transform).toEqual(start.transform);
    expect(tilted.atoms.map((atom) => atom.id)).toEqual(start.atoms.map((atom) => atom.id));
    expect(tilted.atoms.map((atom) => atom.element)).toEqual(start.atoms.map((atom) => atom.element));
    expect(tilted.atoms.map((atom) => atom.formalCharge)).toEqual(start.atoms.map((atom) => atom.formalCharge));
    expect(tilted.atoms.map((atom) => atom.labelVisible)).toEqual(start.atoms.map((atom) => atom.labelVisible));
    expect(tilted.bonds).toEqual(start.bonds);
    expect(tilted.structure).toBe(start.structure);
    expect(tilted.chemistry).toEqual(start.chemistry);
    expect(result.document.selection).toEqual(enriched.selection);
    start.atoms.forEach((atom, index) => {
      const nextAtom = tilted.atoms[index];
      expect(nextAtom?.x).toBeCloseTo(atom.x, 3);
      expect(nextAtom?.y).toBeCloseTo(center.y + (atom.y - center.y) * Math.cos(degToRad(40)), 3);
      expect(nextAtom?.z).toBeCloseTo((atom.y - center.y) * Math.sin(degToRad(40)), 3);
    });
  });

  it("wraps projected-plane tilt after a full turn", () => {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Projected Plane Wrap"),
      { x: 260, y: 260 },
      "cyclohexane"
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const result = tiltNativeMoleculeProjectedPlane(document, molecule.id, center, 0, degToRad(420), {
      persistTransform: true
    });
    const tilted = selectedMolecule(result.document);

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.tiltRad).toBeCloseTo(degToRad(60), 6);
    expect(nativeMoleculeTransformState(tilted).tiltXDegrees).toBe(60);
    molecule.atoms.forEach((atom, index) => {
      const expected = expectedProjectedPlanePoint(atom, center, degToRad(60), 0);
      const nextAtom = tilted.atoms[index];
      expect(nextAtom?.x).toBeCloseTo(atom.x, 3);
      expect(nextAtom?.y).toBeCloseTo(expected.y, 3);
      expect(nextAtom?.z).toBeCloseTo(expected.z, 3);
    });
  });

  it("wraps projected-plane tilt even when clamp refusal is requested", () => {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Projected Plane Wrap Refusal"),
      { x: 260, y: 260 },
      "cyclohexane"
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const result = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(400),
      { mutateWhenClamped: false }
    );
    const tilted = selectedMolecule(result.document);

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.tiltRad).toBeCloseTo(degToRad(40), 6);
    expect(tilted.atoms).not.toEqual(molecule.atoms);
  });

  it("persists projected-plane tilt so a reselected molecule can rotate back to zero", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Persistent Tilt"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const first = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(80),
      { persistTransform: true }
    );
    const tilted = selectedMolecule(first.document);
    const tiltedTransform = nativeMoleculeTransformState(tilted);
    const reselectedCenter = { x: tilted.x + tilted.width / 2, y: tilted.y + tilted.height / 2 };
    const restored = tiltNativeMoleculeProjectedPlane(
      first.document,
      molecule.id,
      reselectedCenter,
      0,
      degToRad(0),
      {
        fromTiltRad: degToRad(tiltedTransform.tiltXDegrees ?? 0),
        persistTransform: true
      }
    );
    const restoredMolecule = selectedMolecule(restored.document);

    expect(first.changed).toBe(true);
    expect(tiltedTransform.tiltXDegrees).toBe(80);
    expect(restored.changed).toBe(true);
    expect(nativeMoleculeTransformState(restoredMolecule).tiltXDegrees ?? 0).toBe(0);
    // Reselection recomputes the pivot from the tilted bounding box (pivots are interaction
    // state, not persisted), so restoring the tilt rigidly translates the molecule by a
    // constant offset. The molecule returns to a flat shape with its geometry intact, which we
    // assert centroid-relative for x/y and via coplanarity in z (same as the X/Y restore test).
    const originalCentroid = averagePoint(molecule.atoms);
    const restoredCentroid = averagePoint(restoredMolecule.atoms);
    const meanRestoredZ =
      restoredMolecule.atoms.reduce((sum, restoredAtom) => sum + (restoredAtom.z ?? 0), 0) /
      restoredMolecule.atoms.length;
    molecule.atoms.forEach((atom, index) => {
      const restoredAtom = restoredMolecule.atoms[index];
      expect((restoredAtom?.x ?? 0) - restoredCentroid.x).toBeCloseTo(atom.x - originalCentroid.x, 2);
      expect((restoredAtom?.y ?? 0) - restoredCentroid.y).toBeCloseTo(atom.y - originalCentroid.y, 2);
      expect((restoredAtom?.z ?? 0) - meanRestoredZ).toBeCloseTo(0, 2);
    });
  });

  it("applies and persists projected-plane X/Y tilt without changing chemical identity", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Two Axis Tilt"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const result = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(35),
      {
        tiltYRad: degToRad(-50),
        persistTransform: true
      }
    );
    const tilted = selectedMolecule(result.document);
    const transform = nativeMoleculeTransformState(tilted);

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.tiltXRad).toBeCloseTo(degToRad(35), 6);
    expect(result.tiltYRad).toBeCloseTo(degToRad(-50), 6);
    expect(transform.tiltXDegrees).toBe(35);
    expect(transform.tiltYDegrees).toBe(-50);
    expect(tilted.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(tilted.bonds).toEqual(molecule.bonds);
    expect(tilted.structure).toBe(molecule.structure);
    expect(tilted.chemistry).toEqual(molecule.chemistry);
    molecule.atoms.forEach((atom, index) => {
      const expected = expectedProjectedPlanePoint(atom, center, degToRad(35), degToRad(-50));
      const nextAtom = tilted.atoms[index];
      expect(nextAtom?.x).toBeCloseTo(expected.x, 3);
      expect(nextAtom?.y).toBeCloseTo(expected.y, 3);
      expect(nextAtom?.z).toBeCloseTo(expected.z, 3);
    });
  });

  it("wraps combined projected-plane X/Y tilt per axis", () => {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Projected Plane Vector Wrap"),
      { x: 260, y: 260 },
      "cyclopentane"
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const result = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(420),
      {
        tiltYRad: degToRad(-370),
        persistTransform: true
      }
    );
    const transform = nativeMoleculeTransformState(selectedMolecule(result.document));

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.tiltXRad).toBeCloseTo(degToRad(60), 6);
    expect(result.tiltYRad).toBeCloseTo(degToRad(-10), 6);
    expect(transform.tiltXDegrees).toBe(60);
    expect(transform.tiltYDegrees).toBe(-10);
    expect(selectedMolecule(result.document).atoms.some((atom, index) =>
      Math.abs((atom.z ?? 0) - (molecule.atoms[index]?.z ?? 0)) > 0.1
    )).toBe(true);
  });

  it("tilts multiple native molecules around the shared selection bounds center", () => {
    const first = insertNativeTemplateMolecule(
      createPhase4Document("Projected Plane Group Tilt"),
      { x: 180, y: 220 },
      "cyclopentane"
    );
    const second = insertNativeTemplateMolecule(first, { x: 360, y: 260 }, "cyclohexane");
    const document = selectAllDocumentObjects(second, second.pages[0].id);
    const molecules = document.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
    const objectIds = molecules.map((molecule) => molecule.id);
    const groupBounds = selectionBounds(document.pages[0].objects, objectIds);
    if (!groupBounds) {
      throw new Error("Expected group selection bounds.");
    }
    const groupCenter = {
      x: groupBounds.centerX,
      y: groupBounds.centerY,
      z: 0
    };
    const result = tiltNativeMoleculeObjectsProjectedPlane(
      document,
      objectIds,
      groupCenter,
      0,
      degToRad(30),
      { tiltYRad: degToRad(-20) }
    );

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.document.selection).toEqual(document.selection);
    molecules.forEach((startMolecule) => {
      const tiltedMolecule = moleculeById(result.document, startMolecule.id);
      expect(tiltedMolecule.atoms.map((atom) => atom.id)).toEqual(startMolecule.atoms.map((atom) => atom.id));
      expect(tiltedMolecule.bonds).toEqual(startMolecule.bonds);
      startMolecule.atoms.forEach((atom, index) => {
        const expected = expectedProjectedPlanePoint(atom, groupCenter, degToRad(30), degToRad(-20));
        const nextAtom = tiltedMolecule.atoms[index];
        expect(nextAtom?.x).toBeCloseTo(expected.x, 3);
        expect(nextAtom?.y).toBeCloseTo(expected.y, 3);
        expect(nextAtom?.z).toBeCloseTo(expected.z, 3);
      });
    });

    const firstMolecule = molecules[0];
    const firstAtom = firstMolecule?.atoms[0];
    const firstTiltedAtom = firstMolecule ? moleculeById(result.document, firstMolecule.id).atoms[0] : undefined;
    if (!firstMolecule || !firstAtom || !firstTiltedAtom) {
      throw new Error("Expected first tilted atom.");
    }
    const localCenterExpected = expectedProjectedPlanePoint(firstAtom, boundsCenter(firstMolecule), degToRad(30), degToRad(-20));
    expect(firstTiltedAtom.x).not.toBeCloseTo(localCenterExpected.x, 1);
  });

  it("applies X/Y tilt in screen space independent of the molecule's Z rotation", () => {
    // Regression for the rotation-matrix order: a vertical/horizontal drag must tilt about
    // the screen axes no matter how the molecule is rotated in-plane. We tilt the same atoms
    // twice — once as a flat molecule (Z=0) and once as a 90°-rotated molecule (from=to=90) —
    // and require an identical screen-space displacement. With a local-frame matrix the
    // rotated molecule would foreshorten along a different axis and the results would diverge.
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Screen Space Tilt"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const flat = tiltNativeMoleculeProjectedPlane(document, molecule.id, center, 0, degToRad(60), {
      tiltYRad: degToRad(-25),
      fromRotationDegrees: 0,
      rotationDegrees: 0
    });
    const rotated = tiltNativeMoleculeProjectedPlane(document, molecule.id, center, 0, degToRad(60), {
      tiltYRad: degToRad(-25),
      fromRotationDegrees: 90,
      rotationDegrees: 90
    });
    const flatMolecule = selectedMolecule(flat.document);
    const rotatedMolecule = selectedMolecule(rotated.document);
    flatMolecule.atoms.forEach((atom, index) => {
      const rotatedAtom = rotatedMolecule.atoms[index];
      expect(rotatedAtom?.x).toBeCloseTo(atom.x, 6);
      expect(rotatedAtom?.y).toBeCloseTo(atom.y, 6);
      expect(rotatedAtom?.z).toBeCloseTo(atom.z ?? 0, 6);
    });
  });

  it("bakes group tilt into geometry without persisting per-member tilt", () => {
    const first = insertNativeTemplateMolecule(
      createPhase4Document("Group Tilt Geometry"),
      { x: 180, y: 220 },
      "cyclopentane"
    );
    const second = insertNativeTemplateMolecule(first, { x: 360, y: 260 }, "cyclohexane");
    const document = selectAllDocumentObjects(second, second.pages[0].id);
    const objectIds = document.pages[0].objects
      .filter((object): object is MoleculeObject => object.type === "molecule")
      .map((molecule) => molecule.id);
    const groupBounds = selectionBounds(document.pages[0].objects, objectIds);
    if (!groupBounds) {
      throw new Error("Expected group selection bounds.");
    }
    const groupCenter = { x: groupBounds.centerX, y: groupBounds.centerY, z: 0 };
    const tilted = tiltNativeMoleculeObjectsProjectedPlane(
      document,
      objectIds,
      groupCenter,
      0,
      degToRad(30),
      { tiltYRad: degToRad(-20) }
    );

    expect(tilted.changed).toBe(true);
    objectIds.forEach((objectId) => {
      const member = moleculeById(tilted.document, objectId);
      // The shared screen-space rotation is baked into geometry (atoms gain depth)...
      expect(member.atoms.some((atom) => Math.abs(atom.z ?? 0) > 0.001)).toBe(true);
      // ...but per-member tilt is NOT persisted: the group rotates about the group center,
      // not each molecule's own center, so persisting tilt would make a reselected member
      // swing about the stale group pivot. Leaving it unset re-tilts about its own center.
      const transform = nativeMoleculeTransformState(member);
      expect(transform.tiltXDegrees ?? 0).toBe(0);
      expect(transform.tiltYDegrees ?? 0).toBe(0);
    });
  });

  it("flattens per-atom depth when cleaning up a tilted molecule back to 2D", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Cleanup Flatten Depth"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const tiltedDocument = tiltNativeMoleculeProjectedPlane(document, molecule.id, center, 0, degToRad(60), {
      tiltYRad: degToRad(40),
      persistTransform: true
    }).document;
    const tiltedMolecule = selectedMolecule(tiltedDocument);
    expect(tiltedMolecule.atoms.some((atom) => Math.abs(atom.z ?? 0) > 0.001)).toBe(true);

    const cleanedDocument = cleanUpSelectedNativeMolecule2d(tiltedDocument);
    const cleanedMolecule = selectedMolecule(cleanedDocument);
    cleanedMolecule.atoms.forEach((atom) => {
      expect(atom.z ?? 0).toBe(0);
    });
    expect(nativeMoleculeTransformState(cleanedMolecule).tiltXDegrees ?? 0).toBe(0);
    expect(nativeMoleculeTransformState(cleanedMolecule).tiltYDegrees ?? 0).toBe(0);
  });

  it("applies and persists projected-plane X/Y/Z rotation without changing chemical identity", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Three Axis Rotate"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const result = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(35),
      {
        tiltYRad: degToRad(-50),
        rotationDegrees: 30,
        persistTransform: true
      }
    );
    const tilted = selectedMolecule(result.document);
    const transform = nativeMoleculeTransformState(tilted);

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.rotationDegrees).toBe(30);
    expect(transform.rotationDegrees).toBe(30);
    expect(transform.tiltXDegrees).toBe(35);
    expect(transform.tiltYDegrees).toBe(-50);
    expect(tilted.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(tilted.bonds).toEqual(molecule.bonds);
    expect(tilted.structure).toBe(molecule.structure);
    expect(tilted.chemistry).toEqual(molecule.chemistry);
    molecule.atoms.forEach((atom, index) => {
      const expected = expectedProjectedPlanePoint(atom, center, degToRad(35), degToRad(-50), 30);
      const nextAtom = tilted.atoms[index];
      expect(nextAtom?.x).toBeCloseTo(expected.x, 3);
      expect(nextAtom?.y).toBeCloseTo(expected.y, 3);
      expect(nextAtom?.z).toBeCloseTo(expected.z, 3);
    });
  });

  it("normalizes persisted projected-plane Z rotation after full-turn drags", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Full Turn Z Rotate"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const result = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      0,
      {
        rotationDegrees: 450,
        persistTransform: true
      }
    );
    const tilted = selectedMolecule(result.document);
    const transform = nativeMoleculeTransformState(tilted);

    expect(result.changed).toBe(true);
    expect(result.rotationDegrees).toBe(90);
    expect(transform.rotationDegrees).toBe(90);
  });

  it("uses persisted projected-plane X/Y tilt to restore a reselected molecule to zero", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Persistent Two Axis Tilt"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const first = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(50),
      {
        tiltYRad: degToRad(-45),
        persistTransform: true
      }
    );
    const tilted = selectedMolecule(first.document);
    const tiltedTransform = nativeMoleculeTransformState(tilted);
    const reselectedCenter = { x: tilted.x + tilted.width / 2, y: tilted.y + tilted.height / 2 };
    const restored = tiltNativeMoleculeProjectedPlane(
      first.document,
      molecule.id,
      reselectedCenter,
      0,
      0,
      {
        fromTiltRad: degToRad(tiltedTransform.tiltXDegrees ?? 0),
        fromTiltYRad: degToRad(tiltedTransform.tiltYDegrees ?? 0),
        tiltYRad: 0,
        persistTransform: true
      }
    );
    const restoredMolecule = selectedMolecule(restored.document);

    expect(tiltedTransform.tiltXDegrees).toBe(50);
    expect(tiltedTransform.tiltYDegrees).toBe(-45);
    expect(restored.changed).toBe(true);
    expect(nativeMoleculeTransformState(restoredMolecule).tiltXDegrees ?? 0).toBe(0);
    expect(nativeMoleculeTransformState(restoredMolecule).tiltYDegrees ?? 0).toBe(0);
    // Reselection recomputes the pivot from the tilted bounding box (pivots are interaction
    // state, not persisted), so restoring a combined X/Y tilt rigidly translates the molecule
    // by a constant offset. The molecule is returned to a flat (coplanar) state with its
    // original shape intact, which we assert centroid-relative for x/y and via coplanarity in z.
    const originalCentroid = averagePoint(molecule.atoms);
    const restoredCentroid = averagePoint(restoredMolecule.atoms);
    const restoredZ = restoredMolecule.atoms.map((restoredAtom) => restoredAtom.z ?? 0);
    const meanRestoredZ = restoredZ.reduce((sum, z) => sum + z, 0) / restoredZ.length;
    molecule.atoms.forEach((atom, index) => {
      const restoredAtom = restoredMolecule.atoms[index];
      expect((restoredAtom?.x ?? 0) - restoredCentroid.x).toBeCloseTo(atom.x - originalCentroid.x, 2);
      expect((restoredAtom?.y ?? 0) - restoredCentroid.y).toBeCloseTo(atom.y - originalCentroid.y, 2);
      expect((restoredAtom?.z ?? 0) - meanRestoredZ).toBeCloseTo(0, 2);
    });
  });

  it("uses the current visual pivot when resetting persisted projected-plane X/Y/Z rotation", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Persistent Three Axis Rotate"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const first = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(50),
      {
        tiltYRad: degToRad(-45),
        rotationDegrees: 135,
        persistTransform: true
      }
    );
    const tilted = selectedMolecule(first.document);
    const tiltedTransform = nativeMoleculeTransformState(tilted);
    const restored = tiltNativeMoleculeProjectedPlane(
      first.document,
      molecule.id,
      { x: tilted.x + tilted.width / 2, y: tilted.y + tilted.height / 2 },
      0,
      0,
      {
        fromTiltRad: degToRad(tiltedTransform.tiltXDegrees ?? 0),
        fromTiltYRad: degToRad(tiltedTransform.tiltYDegrees ?? 0),
        tiltYRad: 0,
        fromRotationDegrees: tiltedTransform.rotationDegrees,
        rotationDegrees: 0,
        persistTransform: true
      }
    );
    const restoredMolecule = selectedMolecule(restored.document);

    expect(tiltedTransform.rotationDegrees).toBe(135);
    expect(tiltedTransform.tiltXDegrees).toBe(50);
    expect(tiltedTransform.tiltYDegrees).toBe(-45);
    expect(restored.changed).toBe(true);
    expect(nativeMoleculeTransformState(restoredMolecule).rotationDegrees).toBe(0);
    expect(nativeMoleculeTransformState(restoredMolecule).tiltXDegrees ?? 0).toBe(0);
    expect(nativeMoleculeTransformState(restoredMolecule).tiltYDegrees ?? 0).toBe(0);
    expect(restoredMolecule.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(restoredMolecule.bonds).toEqual(molecule.bonds);
  });

  it("keeps projected-plane pivots as interaction state instead of persisted molecule state", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Moved Center"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const tiltedDocument = tiltNativeMoleculeProjectedPlane(
      document,
      molecule.id,
      center,
      0,
      degToRad(55),
      {
        tiltYRad: degToRad(45),
        persistTransform: true
      }
    ).document;
    const tilted = selectedMolecule(tiltedDocument);
    const tiltedTransform = nativeMoleculeTransformState(tilted);
    const movedDocument = moveDocumentObject(tiltedDocument, molecule.id, {
      x: tilted.x + 40,
      y: tilted.y + 28
    });
    const moved = selectedMolecule(movedDocument);
    const movedTransform = nativeMoleculeTransformState(moved);
    const restored = tiltNativeMoleculeProjectedPlane(
      movedDocument,
      molecule.id,
      boundsCenter(moved),
      0,
      0,
      {
        fromTiltRad: degToRad(movedTransform.tiltXDegrees ?? 0),
        fromTiltYRad: degToRad(movedTransform.tiltYDegrees ?? 0),
        tiltYRad: 0,
        persistTransform: true
      }
    );
    const restoredMolecule = selectedMolecule(restored.document);
    const restoredTransform = nativeMoleculeTransformState(restoredMolecule);

    // Tilt is persisted, but the pivot is not — it stays interaction state, so moving a
    // tilted molecule leaves its tilt metadata intact and it can still be restored to flat.
    expect(tiltedTransform.tiltXDegrees).toBe(55);
    expect(movedTransform.tiltXDegrees).toBe(55);
    expect(movedTransform.tiltYDegrees).toBe(45);
    expect(restored.changed).toBe(true);
    expect(restoredTransform.tiltXDegrees ?? 0).toBe(0);
    expect(restoredTransform.tiltYDegrees ?? 0).toBe(0);
  });

  it("applies projected-plane tilt to selected native molecule fragments while stretching boundary bonds", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Fragment Tilt"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const atom1 = moleculeAtom(molecule, "atom_001");
    const atom2 = moleculeAtom(molecule, "atom_002");
    const atom3 = moleculeAtom(molecule, "atom_003");
    const target = {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002"
    } as const;
    const bounds = nativeMoleculePartBounds(molecule, target);
    if (!bounds) {
      throw new Error("Expected selected fragment bounds.");
    }
    const center = boundsCenter(bounds);
    const result = tiltNativeMoleculePartsProjectedPlane(document, target, center, 0, degToRad(60));
    const tilted = selectedMolecule(result.document);

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(tilted.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(tilted.bonds).toEqual(molecule.bonds);
    expect(tilted.structure).toBe(molecule.structure);
    expect(tilted.chemistry).toEqual(molecule.chemistry);
    expect(result.document.selection).toEqual(document.selection);
    expect(moleculeAtom(tilted, "atom_001")).toEqual(atom1);
    expect(moleculeAtom(tilted, "atom_002").x).toBeCloseTo(atom2.x, 3);
    expect(moleculeAtom(tilted, "atom_002").y).toBeCloseTo(center.y + (atom2.y - center.y) * Math.cos(degToRad(60)), 3);
    expect(moleculeAtom(tilted, "atom_002").z).toBeCloseTo((atom2.y - center.y) * Math.sin(degToRad(60)), 3);
    expect(moleculeAtom(tilted, "atom_003").x).toBeCloseTo(atom3.x, 3);
    expect(moleculeAtom(tilted, "atom_003").y).toBeCloseTo(center.y + (atom3.y - center.y) * Math.cos(degToRad(60)), 3);
    expect(moleculeAtom(tilted, "atom_003").z).toBeCloseTo((atom3.y - center.y) * Math.sin(degToRad(60)), 3);
    expect(moleculeBondLength(tilted, "bond_001")).not.toBeCloseTo(moleculeBondLength(molecule, "bond_001"), 2);
  });

  it("applies projected-plane Z rotation to selected native molecule fragments while stretching boundary bonds", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Fragment Z Rotate"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const atom1 = moleculeAtom(molecule, "atom_001");
    const atom2 = moleculeAtom(molecule, "atom_002");
    const atom3 = moleculeAtom(molecule, "atom_003");
    const target = {
      objectId: molecule.id,
      kind: "parts" as const,
      atomIds: ["atom_002", "atom_003"],
      bondIds: ["bond_002"]
    };
    const center = {
      x: (atom2.x + atom3.x) / 2,
      y: (atom2.y + atom3.y) / 2
    };
    const result = tiltNativeMoleculePartsProjectedPlane(document, target, center, 0, 0, { rotationDegrees: 90 });
    const tilted = selectedMolecule(result.document);

    expect(result.changed).toBe(true);
    expect(result.rotationDegrees).toBe(90);
    expect(tilted.atoms.map((atom) => atom.id)).toEqual(molecule.atoms.map((atom) => atom.id));
    expect(tilted.bonds).toEqual(molecule.bonds);
    expect(moleculeAtom(tilted, "atom_001")).toEqual(atom1);
    expect(moleculeAtom(tilted, "atom_002").x).toBeCloseTo(center.x - (atom2.y - center.y), 3);
    expect(moleculeAtom(tilted, "atom_002").y).toBeCloseTo(center.y + (atom2.x - center.x), 3);
    expect(moleculeAtom(tilted, "atom_003").x).toBeCloseTo(center.x - (atom3.y - center.y), 3);
    expect(moleculeAtom(tilted, "atom_003").y).toBeCloseTo(center.y + (atom3.x - center.x), 3);
    expect(moleculeBondLength(tilted, "bond_001")).not.toBeCloseTo(moleculeBondLength(molecule, "bond_001"), 2);
  });

  it("wraps projected-plane fragment tilt after a full turn", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Fragment Wrap"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const target = {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_002"
    } as const;
    const bounds = nativeMoleculePartBounds(molecule, target);
    if (!bounds) {
      throw new Error("Expected selected fragment bounds.");
    }
    const result = tiltNativeMoleculePartsProjectedPlane(
      document,
      target,
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      0,
      degToRad(400),
      { mutateWhenClamped: false }
    );

    expect(result.changed).toBe(true);
    expect(result.clamped).toBe(false);
    expect(result.tiltRad).toBeCloseTo(degToRad(40), 6);
    expect(selectedMolecule(result.document).atoms).not.toEqual(molecule.atoms);
  });

  it("projected-plane tilt previews are stable when recomputed from the drag-start molecule", () => {
    const document = growFromAtom(
      insertNativeSingleBondMolecule(createPhase4Document("Projected Plane Stable Preview"), { x: 200, y: 220 }),
      "atom_002",
      -60
    );
    const molecule = selectedMolecule(document);
    const center = boundsCenter(molecule);
    const first = tiltNativeMoleculeProjectedPlane(document, molecule.id, center, 0, degToRad(25)).document;
    const recomputed = tiltNativeMoleculeProjectedPlane(document, molecule.id, center, 0, degToRad(55)).document;
    const accumulated = tiltNativeMoleculeProjectedPlane(first, molecule.id, center, 0, degToRad(55)).document;

    expect(selectedMolecule(recomputed).atoms).not.toEqual(selectedMolecule(accumulated).atoms);
    const secondRecompute = tiltNativeMoleculeProjectedPlane(document, molecule.id, center, 0, degToRad(55)).document;
    expect(selectedMolecule(secondRecompute).atoms).toEqual(selectedMolecule(recomputed).atoms);
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

  it("cleanup strips perspective depth weights left by a 3D flatten", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Cleanup Depth Weights"), { x: 200, y: 220 });
    const molecule = selectedMolecule(document);
    const weighted = applyPatches(document, [{
      op: "updateObject",
      objectId: molecule.id,
      changes: {
        bonds: molecule.bonds.map((bond) => ({
          ...bond,
          display: { ...(bond.display ?? {}), depthWeight: 0.9 }
        }))
      }
    }]);
    const cleaned = cleanUpNativeMolecules2d(weighted, [molecule.id]);
    const cleanedMolecule = moleculeById(cleaned, molecule.id);

    expect(cleanedMolecule.bonds.every((bond) => bond.display?.depthWeight === undefined)).toBe(true);
  });

  describe("fused-ring cleanup contract (2D preserves, engine re-layout rebuilds)", () => {
    function fusedDistortedFixture() {
      let document = insertNativeTemplateMolecule(
        createPhase4Document("Fused Cleanup Fixture"),
        { x: 300, y: 300 },
        "cyclohexane"
      );
      let molecule = selectedMolecule(document);
      const fuseBondId = molecule.bonds[0]?.id ?? "bond_001";
      document = applyNativeTemplateToolAtTarget(
        document,
        moleculeBondTarget(molecule, fuseBondId),
        moleculeBondMidpoint(molecule, fuseBondId),
        "benzene"
      );
      molecule = selectedMolecule(document);
      // A lopsided resize is the "complex structure got worse over time" starting point.
      document = resizeNativeMoleculeObject(document, molecule.id, { x: 1.7, y: 0.55 });
      molecule = selectedMolecule(document);
      return { document, molecule };
    }

    it("2D cleanup preserves a fused-ring system exactly as drawn (the shearing relaxer is gone)", () => {
      const { document, molecule } = fusedDistortedFixture();
      expect(moleculeHasFusedRingSystem(molecule)).toBe(true);

      const cleaned = cleanUpNativeMolecules2d(document, [molecule.id]);
      const cleanedMolecule = moleculeById(cleaned, molecule.id);
      cleanedMolecule.bonds.forEach((bond) => {
        expect(moleculeBondLength(cleanedMolecule, bond.id)).toBeCloseTo(moleculeBondLength(molecule, bond.id), 4);
      });
    });

    it("engine re-layout rebuilds the fused system with uniform bonds at the drawing's own scale", () => {
      const { document, molecule } = fusedDistortedFixture();
      const currentLengths = molecule.bonds.map((bond) => moleculeBondLength(molecule, bond.id));
      const currentMean = currentLengths.reduce((sum, value) => sum + value, 0) / currentLengths.length;

      const relaid = applyNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D);
      const relaidMolecule = moleculeById(relaid, molecule.id);

      const lengths = relaidMolecule.bonds.map((bond) => moleculeBondLength(relaidMolecule, bond.id));
      const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
      // Uniform geometry, scaled to what the user had (mean bond length preserved).
      expect(mean).toBeCloseTo(currentMean, 1);
      lengths.forEach((length) => expect(Math.abs(length - mean) / mean).toBeLessThan(0.05));
      expectUsableNativeMoleculeGraph(relaidMolecule, "engine relayout", {
        minimumAtomDistancePx: mean * 0.5
      });
    });

    it("maps the engine frame back faithfully: y flips, engine wedges replace old ones, other styles survive", () => {
      const document = insertNativeSingleBondMolecule(createPhase4Document("Relayout Mapping"), { x: 200, y: 220 });
      const molecule = selectedMolecule(document);
      const styled = applyPatches(document, [{
        op: "updateObject",
        objectId: molecule.id,
        changes: {
          bonds: molecule.bonds.map((bond) => ({
            ...bond,
            display: { bondStyle: "dashed" as const, depthWeight: 0.9 }
          }))
        }
      }]);

      const engineWedge = applyNativeMoleculeEngineRelayout(styled, molecule.id, () => ({
        atoms: [
          { element: "C", x: 0, y: 0, charge: 0 },
          { element: "C", x: 1.5, y: 0.5, charge: 0 }
        ],
        bonds: [{ from: 0, to: 1, order: "single", wedge: "hashed" }]
      }));
      const wedged = moleculeById(engineWedge, molecule.id);
      // Engine y is UP: the second atom sits ABOVE-right of the first on screen (document y-down).
      expect(wedged.atoms[1].x).toBeGreaterThan(wedged.atoms[0].x);
      expect(wedged.atoms[1].y).toBeLessThan(wedged.atoms[0].y);
      // The engine's parity-derived wedge replaces the old style; depth weights never survive.
      expect(wedged.bonds[0]?.display?.bondStyle).toBe("hashed");
      expect(wedged.bonds[0]?.display?.depthWeight).toBeUndefined();

      const engineNoWedge = applyNativeMoleculeEngineRelayout(styled, molecule.id, () => ({
        atoms: [
          { element: "C", x: 0, y: 0, charge: 0 },
          { element: "C", x: 1.5, y: 0, charge: 0 }
        ],
        bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
      }));
      const unwedged = moleculeById(engineNoWedge, molecule.id);
      // No stereo verdict from the engine → the user's non-stereo decoration is preserved.
      expect(unwedged.bonds[0]?.display?.bondStyle).toBe("dashed");
    });

    it("keeps OCL's directed wedge end so a valid R/S center stays specified", () => {
      const base = createPhase4Document("Directed Stereo Relayout");
      const molecule: MoleculeObject = {
        id: "directed_stereo",
        type: "molecule",
        x: 180.86,
        y: 189,
        width: 38.28,
        height: 33,
        rotation: 0,
        style: {},
        structureFormat: "molfile-v2000",
        structure: "",
        atoms: [
          { id: "center", element: "C", x: 200, y: 200, formalCharge: 0 },
          { id: "fluorine", element: "F", x: 219.14, y: 189, formalCharge: 0 },
          { id: "chlorine", element: "Cl", x: 180.86, y: 189, formalCharge: 0 },
          { id: "bromine", element: "Br", x: 200, y: 222, formalCharge: 0 }
        ],
        bonds: [
          // This ordinary bond is deliberately stored F→C. OCL chooses it as the fresh stereo
          // bond and reverses it to C→F; losing that direction makes the center unspecified.
          { id: "cf", fromAtomId: "fluorine", toAtomId: "center", order: "single" },
          { id: "ccl", fromAtomId: "center", toAtomId: "chlorine", order: "single", display: { bondStyle: "wedge" } },
          { id: "cbr", fromAtomId: "center", toAtomId: "bromine", order: "single" }
        ],
        superatoms: [],
        rGroups: []
      };
      const document = applyPatches(base, [
        { op: "addObject", pageId: base.pages[0].id, object: molecule },
        { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
      ]);
      const before = perceiveStereoCentersFromMolfile(moleculeToMolfileV2000(molecule, { fromDocFrame: true }));
      expect(before[0]?.descriptor).not.toBe("unspecified");

      const relaid = applyNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D);
      const result = moleculeById(relaid, molecule.id);
      const after = perceiveStereoCentersFromMolfile(moleculeToMolfileV2000(result, { fromDocFrame: true }));

      expect(after).toEqual(before);
      expect(result.bonds.find((bond) => bond.id === "cf")).toMatchObject({
        fromAtomId: "center",
        toAtomId: "fluorine",
        display: { bondStyle: expect.stringMatching(/^(wedge|hashed)$/) }
      });
    });

    it("re-lays out a molecule selected on a later page instead of silently no-oping", () => {
      const base = createPhase4Document("Later-page Relayout");
      const molecule = createNativeSingleBondMolecule(base, { x: 200, y: 220 });
      const firstPage = base.pages[0];
      const document: ChemDraftDocument = {
        ...base,
        pages: [firstPage, { ...firstPage, id: "page_002", objects: [molecule] }],
        selection: { pageId: "page_002", objectIds: [molecule.id] }
      };

      const relaid = applyNativeMoleculeEngineRelayout(document, molecule.id, () => ({
        atoms: [
          { element: "C", x: 0, y: 0, charge: 0 },
          { element: "C", x: 1, y: 1, charge: 0 }
        ],
        bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
      }));

      expect(relaid).not.toBe(document);
      expect(relaid.pages[0].objects).toEqual([]);
      expect(moleculeById(relaid, molecule.id).atoms[1]?.y).not.toBe(molecule.atoms[1]?.y);
    });

    it("raises a collapsed nonzero bond to the minimum drawable cleanup scale", () => {
      const base = createPhase4Document("Collapsed Relayout");
      const source = createNativeSingleBondMolecule(base, { x: 200, y: 220 });
      const molecule: MoleculeObject = {
        ...source,
        x: 200,
        y: 220,
        width: 0.002,
        height: 0,
        atoms: [
          { ...source.atoms[0], x: 200, y: 220 },
          { ...source.atoms[1], x: 200.002, y: 220 }
        ]
      };
      const document = applyPatches(base, [
        { op: "addObject", pageId: base.pages[0].id, object: molecule },
        { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
      ]);

      const relaid = applyNativeMoleculeEngineRelayout(document, molecule.id, () => ({
        atoms: [
          { element: "C", x: 0, y: 0, charge: 0 },
          { element: "C", x: 1, y: 0, charge: 0 }
        ],
        bonds: [{ from: 0, to: 1, order: "single", wedge: null }]
      }));
      const result = moleculeById(relaid, molecule.id);
      expect(moleculeBondLength(result, result.bonds[0]?.id ?? "bond_001")).toBeCloseTo(4.5, 3);
    });

    it("commits bond-only cleanup changes even when engine coordinates already match", () => {
      const document = insertNativeSingleBondMolecule(createPhase4Document("Bond-only Relayout"), { x: 200, y: 220 });
      const molecule = selectedMolecule(document);
      const styled = applyPatches(document, [{
        op: "updateObject",
        objectId: molecule.id,
        changes: {
          bonds: molecule.bonds.map((bond) => ({ ...bond, display: { bondStyle: "dashed" as const, depthWeight: 0.8 } }))
        }
      }]);
      const relaid = applyNativeMoleculeEngineRelayout(styled, molecule.id, () => ({
        atoms: molecule.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: -atom.y, charge: atom.formalCharge })),
        bonds: [{ from: 1, to: 0, order: "single", wedge: "wedge" }]
      }));
      const result = moleculeById(relaid, molecule.id);

      expect(relaid).not.toBe(styled);
      expect(result.bonds[0]).toMatchObject({
        fromAtomId: molecule.bonds[0]?.toAtomId,
        toAtomId: molecule.bonds[0]?.fromAtomId,
        display: { bondStyle: "wedge" }
      });
      expect(result.bonds[0]?.display?.depthWeight).toBeUndefined();
    });

    it("refuses an engine result it cannot trust to map back", () => {
      const document = insertNativeSingleBondMolecule(createPhase4Document("Relayout Guard"), { x: 200, y: 220 });
      const molecule = selectedMolecule(document);
      expect(() =>
        applyNativeMoleculeEngineRelayout(document, molecule.id, () => ({
          atoms: [{ element: "C", x: 0, y: 0, charge: 0 }],
          bonds: []
        }))
      ).toThrow(/atoms/);
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
    const colored = applyObjectColorToDocumentObjects(selected, "#1f5fbf");
    const coloredMolecule = moleculeById(colored, molecule.id);
    const coloredText = colored.pages[0].objects.find((object): object is TextObject => object.id === textObject.id && object.type === "text");

    expect(coloredMolecule.style).toMatchObject({
      bondColor: "#1f5fbf",
      atomLabelColor: "#1f5fbf"
    });
    expect(coloredText?.style).toMatchObject({ color: "#1f5fbf" });
    expect(colored.selection.objectIds).toEqual([molecule.id, textObject.id]);
  });

  it("keeps native art graphics editable, persistent, undoable, and warning-backed", () => {
    const document = createPhase4Document("Native Graphic Workflow");
    const inserted = insertNativeArtGraphicObject(document, { x: 220, y: 180 }, "tool.art.roundedRectGloss");
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted art object to be selected.");
    }

    const insertedGraphic = graphicById(inserted, objectId);
    expect(insertedGraphic).toMatchObject({
      type: "graphic",
      graphicKind: "rect",
      data: {
        artToolId: "roundedRectGloss",
        cornerRadiusPx: 7
      },
      style: {
        source: "chemdraft-native-art",
        artToolCommandId: "tool.art.roundedRectGloss",
        fillMode: "gloss",
        strokeColor: "#111111",
        fillColor: "#111111"
      }
    });

    const insertionCandidate = createNativeArtGraphicObject(document, { x: 360, y: 200 }, "tool.art.lineWavy");
    if (!insertionCandidate) {
      throw new Error("Expected native art tool to create a graphic object.");
    }
    const insertedHistory = applyPatchWithHistory(
      createDocumentHistory(document),
      { op: "addObject", pageId: document.pages[0].id, object: insertionCandidate }
    );
    expect(undo(insertedHistory).present.pages[0].objects).toHaveLength(0);
    expect(redo(undo(insertedHistory)).present.pages[0].objects[0]).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      data: {
        artPathKind: "wavy"
      }
    });

    const colored = applyObjectColorToDocumentObjects(inserted, "#1d7f68");
    const coloredGraphic = graphicById(colored, objectId);
    expect(coloredGraphic.style).toMatchObject({
      color: "#1d7f68",
      strokeColor: "#1d7f68",
      fillColor: "#1d7f68"
    });
    const colorHistory = {
      past: [inserted],
      present: colored,
      future: []
    };
    expect(graphicById(undo(colorHistory).present, objectId).style.strokeColor).toBe("#111111");
    expect(graphicById(redo(undo(colorHistory)).present, objectId).style.strokeColor).toBe("#1d7f68");

    const center = {
      x: coloredGraphic.x + coloredGraphic.width / 2,
      y: coloredGraphic.y + coloredGraphic.height / 2
    };
    const stretched = scaleDocumentObjectsAroundPoint(colored, [objectId], center, 1.5, 0.5);
    const stretchedGraphic = graphicById(stretched, objectId);
    expect(stretchedGraphic.width).toBeCloseTo(108, 3);
    expect(stretchedGraphic.height).toBeCloseTo(20, 3);

    const rotated = rotateDocumentObject(stretched, objectId, 37);
    expect(graphicById(rotated, objectId).rotation).toBeCloseTo(37, 3);

    const tilted = applyDocumentObjectProjectedPlaneTilt(rotated, objectId, 21, -13);
    const tiltedGraphic = graphicById(tilted, objectId);
    expect(tiltedGraphic.style).toMatchObject({
      tiltXDegrees: 21,
      tiltYDegrees: -13
    });
    const beyondSixtyTilted = applyDocumentObjectProjectedPlaneTilt(rotated, objectId, 180, -180);
    expect(graphicById(beyondSixtyTilted, objectId).style).toMatchObject({
      tiltXDegrees: 180,
      tiltYDegrees: -180
    });
    const wrappedTilted = applyDocumentObjectProjectedPlaneTilt(rotated, objectId, 420, -370);
    expect(graphicById(wrappedTilted, objectId).style).toMatchObject({
      tiltXDegrees: 60,
      tiltYDegrees: -10
    });
    const transformHistory = {
      past: [colored],
      present: tilted,
      future: []
    };
    expect(graphicById(undo(transformHistory).present, objectId).width).toBeCloseTo(72, 3);
    expect(graphicById(redo(undo(transformHistory)).present, objectId).style.tiltYDegrees).toBe(-13);

    const payload = createNativeSavePayload(tilted);
    const reopened = openNativeDocument(payload.contents);
    expect(reopened.source).toBe("native-payload");
    expect(graphicById(reopened.document ?? document, objectId)).toEqual(tiltedGraphic);

    const svg = exportPhase4Svg(tilted, { includeWarnings: true });
    expect(svg.contents).toContain('data-object-id="' + objectId + '"');
    expect(svg.contents).toContain('id="graphic-gloss-' + objectId + '"');
    expect(svg.contents).toContain('gradientUnits="userSpaceOnUse"');
    expect(svg.contents).toContain('gradientTransform="matrix(');
    expect(svg.contents).toContain('fill="url(#graphic-gloss-' + objectId + ')"');
    expect(svg.warnings).toEqual([]);

    const cdxml = exportPhase4Cdxml(tilted);
    const graphicCdxmlWarnings = cdxml.warnings.filter((warning) => warning.code.startsWith("cdxml.graphic_"));
    expect(cdxml.contents).toContain('GraphicType="Rectangle"');
    expect(cdxml.contents).toContain('RectangleType="RoundEdge"');
    expect(cdxml.contents).toContain('CornerRadius="525"');
    expect(graphicCdxmlWarnings.map((warning) => warning.code)).toEqual([
      "cdxml.graphic_color_approximation",
      "cdxml.graphic_gloss_payload_only",
      "cdxml.graphic_tilt_payload_only"
    ]);
    expect(graphicCdxmlWarnings.every((warning) => warning.objectId === objectId)).toBe(true);
  });

  it("inserts native art arrows as path graphics with an end marker", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Art Arrow"),
      { x: 220, y: 180 },
      "tool.art.arrow"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arrow to be selected.");
    }

    expect(graphicById(inserted, objectId)).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      data: {
        artPathKind: "line",
        artToolId: "arrow",
        markerEnd: { kind: "filled-arrow", sizePx: 10 }
      },
      style: {
        artToolCommandId: "tool.art.arrow",
        strokeLineCap: "butt"
      }
    });
  });

  it("inserts native art polylines as path-node graphics", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Art Polyline"),
      { x: 220, y: 180 },
      "tool.art.polyline"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted polyline to be selected.");
    }

    expect(graphicById(inserted, objectId)).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      x: 172,
      y: 144,
      width: 96,
      height: 72,
      data: {
        artPathKind: "polyline",
        artToolId: "polyline",
        pathNodes: [
          { point: { x: 180, y: 202 } },
          { point: { x: 216, y: 158 } },
          { point: { x: 260, y: 190 } }
        ]
      },
      style: {
        artToolCommandId: "tool.art.polyline",
        strokeColor: "#111111",
        fillColor: "none"
      }
    });
  });

  it("creates native art polylines from clicked path points", () => {
    const inserted = nativePolylinePathDocument(
      createPhase4Document("Native Polyline Path"),
      [
        { x: 160, y: 140 },
        { x: 220, y: 168 },
        { x: 204, y: 224 }
      ],
      "tool.art.polyline"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected clicked polyline to be selected.");
    }

    const graphic = graphicById(inserted, objectId);
    expect(graphic).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      data: {
        artPathKind: "polyline",
        artToolId: "polyline",
        pathClosed: false,
        pathNodes: [
          { point: { x: 160, y: 140 } },
          { point: { x: 220, y: 168 } },
          { point: { x: 204, y: 224 } }
        ]
      },
      style: {
        artToolCommandId: "tool.art.polyline",
        strokeColor: "#111111",
        fillColor: "none"
      }
    });
    expect(graphic.x).toBeLessThanOrEqual(160);
    expect(graphic.y).toBeLessThanOrEqual(140);
    expect(graphic.x + graphic.width).toBeGreaterThanOrEqual(220);
    expect(graphic.y + graphic.height).toBeGreaterThanOrEqual(224);
  });

  it("creates native Bezier paths from Pen nodes and controls", () => {
    const inserted = nativeBezierPathDocument(
      createPhase4Document("Native Pen Path"),
      [
        {
          point: { x: 160, y: 140 },
          outControl: { x: 188, y: 116 }
        },
        {
          point: { x: 240, y: 188 },
          inControl: { x: 212, y: 164 },
          outControl: { x: 268, y: 212 }
        },
        {
          point: { x: 292, y: 148 },
          inControl: { x: 272, y: 172 }
        }
      ],
      "tool.art.pen"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected Pen path to be selected.");
    }

    const graphic = graphicById(inserted, objectId);
    expect(graphic).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      data: {
        artPathKind: "bezier",
        artToolId: "pen",
        pathClosed: false,
        pathNodes: [
          {
            point: { x: 160, y: 140 },
            outControl: { x: 188, y: 116 }
          },
          {
            point: { x: 240, y: 188 },
            inControl: { x: 212, y: 164 },
            outControl: { x: 268, y: 212 }
          },
          {
            point: { x: 292, y: 148 },
            inControl: { x: 272, y: 172 }
          }
        ]
      },
      style: {
        artToolCommandId: "tool.art.pen",
        strokeColor: "#111111",
        fillColor: "none"
      }
    });
    expect(graphic.x).toBeLessThanOrEqual(160);
    expect(graphic.y).toBeLessThanOrEqual(116);
    expect(graphic.x + graphic.width).toBeGreaterThanOrEqual(292);
    expect(graphic.y + graphic.height).toBeGreaterThanOrEqual(212);
  });

  it("creates native freehand pencil and brush strokes from raw pressure points", () => {
    const document = createPhase4Document("Native Freehand Stroke");
    const points = [
      { x: 180, y: 180, pressure: 0.2 },
      { x: 210, y: 194, pressure: 0.85 },
      { x: 244, y: 178, pressure: 0.5 }
    ];

    const pencil = nativeFreehandStrokeDocument(document, points, "tool.art.pencil");
    const objectId = pencil.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted freehand stroke to be selected.");
    }
    const pencilGraphic = graphicById(pencil, objectId);
    const brushGraphic = createNativeFreehandGraphicObject(document, points, "tool.art.brush");

    expect(nativeArtToolIsFreehand("tool.art.pencil")).toBe(true);
    expect(nativeArtToolIsFreehand("tool.art.brush")).toBe(true);
    expect(pencilGraphic).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      data: {
        artPathKind: "freehand",
        artToolId: "pencil",
        freehandOptions: {
          size: 5,
          simulatePressure: false
        },
        freehandPoints: points,
        cachedFreehandPathD: expect.stringMatching(/^M /),
        cachedFreehandPathRevision: expect.any(String)
      },
      style: {
        artToolCommandId: "tool.art.pencil",
        strokeColor: "#111111"
      }
    });
    expect(brushGraphic?.data.freehandOptions?.size).toBeGreaterThan(pencilGraphic.data.freehandOptions?.size ?? 0);
    expect(brushGraphic?.width).toBeGreaterThan(pencilGraphic.width);
    expect(brushGraphic?.height).toBeGreaterThan(pencilGraphic.height);
    expect(nativeFreehandStrokeDocument(document, points.slice(0, 1), "tool.art.pencil")).toBe(document);
  });

  it("moves and scales native freehand point geometry with the object frame", () => {
    const document = createPhase4Document("Native Freehand Transform");
    const points = [
      { x: 180, y: 180, pressure: 0.2 },
      { x: 210, y: 194, pressure: 0.85 },
      { x: 244, y: 178, pressure: 0.5 }
    ];
    const inserted = nativeFreehandStrokeDocument(document, points, "tool.art.pencil");
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted freehand stroke to be selected.");
    }
    const graphic = graphicById(inserted, objectId);
    const dx = 36;
    const dy = -18;

    const moved = moveDocumentObject(inserted, objectId, { x: graphic.x + dx, y: graphic.y + dy });
    const movedGraphic = graphicById(moved, objectId);

    expect(movedGraphic.data.freehandPoints).toHaveLength(points.length);
    movedGraphic.data.freehandPoints?.forEach((point, index) => {
      const expected = translatedPoint(points[index]!, dx, dy);
      expectPointToBeClose(point, expected);
      expect(point.pressure).toBe(points[index]!.pressure);
    });
    expect(movedGraphic.data.cachedFreehandPathD).toBeUndefined();
    expect(movedGraphic.data.cachedFreehandPathRevision).toBeUndefined();

    const oldCenter = {
      x: movedGraphic.x + movedGraphic.width / 2,
      y: movedGraphic.y + movedGraphic.height / 2
    };
    const scaleX = 1.4;
    const scaleY = 0.6;
    const scaled = scaleDocumentObjectsAroundPoint(moved, [objectId], oldCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const newCenter = {
      x: scaledGraphic.x + scaledGraphic.width / 2,
      y: scaledGraphic.y + scaledGraphic.height / 2
    };

    expect(scaledGraphic.data.freehandPoints).toHaveLength(points.length);
    scaledGraphic.data.freehandPoints?.forEach((point, index) => {
      const expected = scaledPoint(movedGraphic.data.freehandPoints![index]!, oldCenter, newCenter, scaleX, scaleY);
      expectPointToBeClose(point, expected);
      expect(point.pressure).toBe(points[index]!.pressure);
    });
    expect(scaledGraphic.data.cachedFreehandPathD).toBeUndefined();
    expect(scaledGraphic.data.cachedFreehandPathRevision).toBeUndefined();
  });

  it("flips native freehand point geometry on the requested axis only", () => {
    const document = createPhase4Document("Native Freehand Flip");
    const points = [
      { x: 180, y: 180, pressure: 0.2 },
      { x: 210, y: 194, pressure: 0.85 },
      { x: 244, y: 178, pressure: 0.5 }
    ];
    const inserted = nativeFreehandStrokeDocument(document, points, "tool.art.pencil");
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted freehand stroke to be selected.");
    }
    const graphic = graphicById(inserted, objectId);
    const center = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };

    const horizontal = flipDocumentObjectsAroundPoint(inserted, [objectId], center, "horizontal");
    const vertical = flipDocumentObjectsAroundPoint(inserted, [objectId], center, "vertical");
    const horizontalGraphic = graphicById(horizontal, objectId);
    const verticalGraphic = graphicById(vertical, objectId);

    horizontalGraphic.data.freehandPoints?.forEach((point, index) => {
      const source = graphic.data.freehandPoints![index]!;
      expectPointToBeClose(point, { x: center.x - (source.x - center.x), y: source.y });
      expect(point.pressure).toBe(source.pressure);
    });
    verticalGraphic.data.freehandPoints?.forEach((point, index) => {
      const source = graphic.data.freehandPoints![index]!;
      expectPointToBeClose(point, { x: source.x, y: center.y - (source.y - center.y) });
      expect(point.pressure).toBe(source.pressure);
    });
    expect(horizontalGraphic.data.freehandPoints?.map((point) => point.x)).not.toEqual(
      verticalGraphic.data.freehandPoints?.map((point) => point.x)
    );
    expect(horizontalGraphic.data.freehandPoints?.map((point) => point.y)).not.toEqual(
      verticalGraphic.data.freehandPoints?.map((point) => point.y)
    );
    expect(horizontalGraphic.rotation).toBe(graphic.rotation);
    expect(verticalGraphic.rotation).toBe(graphic.rotation);
    expect(horizontalGraphic.data.cachedFreehandPathD).toBeUndefined();
    expect(verticalGraphic.data.cachedFreehandPathD).toBeUndefined();
  });

  it("applies freehand color through stroke style instead of the filled-outline implementation detail", () => {
    const document = createPhase4Document("Native Freehand Stroke Color");
    const inserted = nativeFreehandStrokeDocument(document, [
      { x: 180, y: 180, pressure: 0.2 },
      { x: 210, y: 194, pressure: 0.85 },
      { x: 244, y: 178, pressure: 0.5 }
    ], "tool.art.pencil");
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted freehand stroke to be selected.");
    }

    const fillAttempt = applyGraphicObjectColorToSelection(inserted, "fill", "#b3261e");
    const stroked = applyGraphicObjectColorToSelection(fillAttempt, "stroke", "#1d7f68");
    const graphic = graphicById(stroked, objectId);

    expect(graphic.style.fillColor).toBe("none");
    expect(graphic.style.strokeColor).toBe("#1d7f68");
    expect(graphic.style.strokePaint).toEqual({ kind: "solid", color: "#1d7f68", opacity: 1 });
    expect(graphic.style.fillPaint).toBeUndefined();
  });

  it("edits native art arrowhead marker size through workflow helpers", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Art Arrow Marker Edit"),
      { x: 220, y: 180 },
      "tool.art.arrow"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arrow to be selected.");
    }
    const arrow = graphicById(inserted, objectId);
    const end = { x: arrow.x + arrow.width - 3, y: arrow.y + arrow.height - 3 };
    const edited = updateNativeGraphicMarkerHandle(inserted, objectId, "markerEnd", {
      x: end.x - 26,
      y: end.y - 26
    });

    const marker = graphicById(edited, objectId).data.markerEnd;
    expect(marker?.kind).toBe("filled-arrow");
    expect(marker?.sizePx).toBeCloseTo(36.77, 3);
    expect(edited.selection.objectIds).toEqual([objectId]);
  });

  it("applies object-style commands to selected graphics without mutating text or molecules", () => {
    const withGraphic = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Style Selection"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const objectId = withGraphic.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted art object to be selected.");
    }
    const withMolecule = insertNativeSingleBondMolecule(withGraphic, { x: 300, y: 260 });
    const molecule = selectedMolecule(withMolecule);
    const withText = insertNativeTextObject(withMolecule, { x: 120, y: 140 }, "label");
    const textObject = getSelectedTextObject(withText);
    if (!textObject) {
      throw new Error("Expected text object.");
    }
    const selected = applyPatches(withText, [{
      op: "setSelection",
      pageId: withText.pages[0].id,
      objectIds: [objectId, molecule.id, textObject.id]
    }]);

    expect(selectedGraphicObjectIds(selected)).toEqual([objectId]);

    const filled = applyGraphicObjectColorToSelection(selected, "fill", "#1D7F68");
    expect(graphicById(filled, objectId).style).toMatchObject({
      fillColor: "#1d7f68",
      fillPaint: { kind: "solid", color: "#1d7f68", opacity: 1 },
      strokeColor: "#111111"
    });
    expect(moleculeById(filled, molecule.id).style).not.toMatchObject({ fillColor: "#1d7f68" });
    expect(filled.pages[0].objects.find((object): object is TextObject => object.id === textObject.id && object.type === "text")?.style.color).toBe(textObject.style.color);

    const noStroke = applyGraphicObjectNoneToSelection(filled, "stroke");
    expect(graphicById(noStroke, objectId).style).toMatchObject({
      strokeColor: "none",
      strokePaint: { kind: "none" }
    });

    const stroked = applyGraphicObjectColorToSelection(noStroke, "stroke", "#abc");
    const styled = applyGraphicObjectStrokeStyleToSelection(stroked, {
      strokeWidth: 5,
      strokeDasharray: "8 6",
      strokeLineCap: "square",
      strokeLineJoin: "bevel",
      strokeMiterLimit: 6
    });
    expect(graphicById(styled, objectId).style).toMatchObject({
      strokeColor: "#aabbcc",
      strokePaint: { kind: "solid", color: "#aabbcc", opacity: 1 },
      strokeWidth: 5,
      strokeDasharray: "8 6",
      strokeLineCap: "square"
    });
    expect(graphicById(styled, objectId).style.strokeLineJoin).toBeUndefined();
    expect(graphicById(styled, objectId).style.strokeMiterLimit).toBeUndefined();

    const transparent = applyGraphicObjectOpacityToSelection(styled, "fillOpacity", 0.35);
    expect(graphicById(transparent, objectId).style.fillOpacity).toBe(0.35);

    const swapped = swapGraphicObjectFillAndStroke(transparent);
    expect(graphicById(swapped, objectId).style).toMatchObject({
      fillColor: "#aabbcc",
      strokeColor: "#1d7f68"
    });

    const history = { past: [selected], present: swapped, future: [] };
    expect(graphicById(undo(history).present, objectId).style.fillColor).not.toBe("#aabbcc");
    expect(graphicById(redo(undo(history)).present, objectId).style.fillColor).toBe("#aabbcc");
  });

  it("applies Art-toolbar molecule fill, stroke, and opacity without using the main color route", () => {
    const document = insertNativeSingleBondMolecule(
      createPhase4Document("Molecule Art Fill"),
      { x: 260, y: 220 }
    );
    const molecule = selectedMolecule(document);

    const filled = applyMoleculeObjectColorToSelection(document, "fill", "#1D7F68");
    expect(moleculeById(filled, molecule.id).style).toMatchObject({
      fillColor: "#1d7f68",
      fillPaint: { kind: "solid", color: "#1d7f68", opacity: 1 }
    });

    const linear = applyMoleculeObjectPaintTypeToSelection(filled, "fill", "linear-gradient");
    expect(moleculeById(linear, molecule.id).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      units: "object",
      stops: [
        { offset: 0, color: "#1d7f68" },
        { offset: 1, color: "#ffffff" }
      ]
    });

    const movedLinearEnd = updateNativeGraphicLinearGradientHandle(linear, molecule.id, "fill", "end", {
      x: molecule.width * 0.2,
      y: molecule.height * 0.8
    });
    const movedLinearPaint = moleculeById(movedLinearEnd, molecule.id).style.fillPaint as GraphicPaint | undefined;
    expect(movedLinearPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0,
      y1: 0,
      y2: 0.8
    });
    expect(movedLinearPaint?.kind === "linear-gradient" ? movedLinearPaint.x2 : undefined).toBeCloseTo(0.2, 6);

    const addedStop = addGraphicObjectGradientStopForSelection(movedLinearEnd, "fill", [molecule.id]);
    const movedMiddleStop = applyGraphicObjectGradientStopOffsetForSelection(addedStop, "fill", 1, 0.37, [molecule.id]);
    expect(moleculeById(movedMiddleStop, molecule.id).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#1d7f68" },
        { offset: 0.37 },
        { offset: 1, color: "#ffffff" }
      ]
    });

    const radial = applyMoleculeObjectPaintTypeToSelection(filled, "fill", "radial-gradient");
    const radialMolecule = moleculeById(radial, molecule.id);
    const movedRadialRadius = updateNativeGraphicRadialGradientHandle(radial, molecule.id, "fill", "radius", {
      x: radialMolecule.width * 0.38 + Math.max(radialMolecule.width, radialMolecule.height, 1) * 0.25,
      y: radialMolecule.height * 0.32
    });
    const movedRadialPaint = moleculeById(movedRadialRadius, molecule.id).style.fillPaint as GraphicPaint | undefined;
    expect(movedRadialPaint).toMatchObject({
      kind: "radial-gradient",
      cx: 0.38,
      cy: 0.32
    });
    expect(movedRadialPaint?.kind === "radial-gradient" ? movedRadialPaint.r : undefined).toBeCloseTo(0.25, 6);

    const translucent = applyMoleculeObjectOpacityToSelection(movedMiddleStop, "fillOpacity", 0.42);
    expect(moleculeById(translucent, molecule.id).style.fillOpacity).toBe(0.42);

    const stroked = applyMoleculeObjectColorToSelection(translucent, "stroke", "#B3261E");
    expect(moleculeById(stroked, molecule.id).style).toMatchObject({
      bondColor: "#b3261e",
      atomLabelColor: "#b3261e",
      strokeColor: "#b3261e"
    });

    const fadedStroke = applyMoleculeObjectOpacityToSelection(stroked, "strokeOpacity", 0.55);
    expect(moleculeById(fadedStroke, molecule.id).style.strokeOpacity).toBe(0.55);

    const mainToolbarColored = applyObjectColorToDocumentObjects(fadedStroke, "#1648FF", [molecule.id]);
    expect(moleculeById(mainToolbarColored, molecule.id).style).toMatchObject({
      bondColor: "#1648FF",
      atomLabelColor: "#1648FF",
      fillOpacity: 0.42,
      fillPaint: { kind: "linear-gradient" }
    });
    expect(moleculeById(mainToolbarColored, molecule.id).style.fillColor).not.toBe("#1648FF");
  });

  it("applies native gradient paint types to selected graphics and exports matching SVG paint defs", () => {
    const withGraphic = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Gradient Paint Selection"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const objectId = withGraphic.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted art object to be selected.");
    }

    const linearFilled = applyGraphicObjectPaintTypeToSelection(withGraphic, "fill", "linear-gradient");
    expect(graphicById(linearFilled, objectId).style).toMatchObject({
      fillColor: "#111111",
      fillMode: "solid",
      fillPaint: {
        kind: "linear-gradient",
        units: "object",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        stops: [
          { offset: 0, color: "#111111" },
          { offset: 1, color: "#ffffff" }
        ]
      }
    });

    const recoloredLinear = applyGraphicObjectColorToSelection(linearFilled, "fill", "#b3261e");
    expect(graphicById(recoloredLinear, objectId).style).toMatchObject({
      fillColor: "#b3261e",
      fillMode: "solid",
      fillPaint: {
        kind: "linear-gradient",
        stops: [
          { offset: 0, color: "#b3261e" },
          { offset: 1, color: "#ffffff" }
        ]
      }
    });
    const reversedLinear = reverseGraphicObjectGradientStopsForSelection(recoloredLinear, "fill");
    expect(graphicById(reversedLinear, objectId).style).toMatchObject({
      fillColor: "#b3261e",
      fillMode: "solid",
      fillPaint: {
        kind: "linear-gradient",
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#b3261e" }
        ]
      }
    });
    const addedLinearStop = addGraphicObjectGradientStopForSelection(recoloredLinear, "fill");
    expect(graphicById(addedLinearStop, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#b3261e" },
        { offset: 0.5, color: "#d9938f" },
        { offset: 1, color: "#ffffff" }
      ]
    });
    const editedLinearStopColor = applyGraphicObjectGradientStopColorForSelection(addedLinearStop, "fill", 1, "#1d7f68");
    expect(graphicById(editedLinearStopColor, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#b3261e" },
        { offset: 0.5, color: "#1d7f68" },
        { offset: 1, color: "#ffffff" }
      ]
    });
    const editedLinearStopOpacity = applyGraphicObjectGradientStopOpacityForSelection(editedLinearStopColor, "fill", 1, 0.42);
    expect(graphicById(editedLinearStopOpacity, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#b3261e" },
        { offset: 0.5, color: "#1d7f68", opacity: 0.42 },
        { offset: 1, color: "#ffffff" }
      ]
    });
    const editedLinearStopOffset = applyGraphicObjectGradientStopOffsetForSelection(editedLinearStopOpacity, "fill", 1, 0.37);
    expect(graphicById(editedLinearStopOffset, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#b3261e" },
        { offset: 0.37, color: "#1d7f68", opacity: 0.42 },
        { offset: 1, color: "#ffffff" }
      ]
    });
    const rotatedLinearStops = rotateGraphicObjectGradientStopsForSelection(editedLinearStopOffset, "fill");
    expect(graphicById(rotatedLinearStops, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 0.37, color: "#b3261e" },
        { offset: 1, color: "#1d7f68", opacity: 0.42 }
      ]
    });
    const linearGradientGraphic = graphicById(rotatedLinearStops, objectId);
    const movedLinearGradientStart = updateNativeGraphicLinearGradientHandle(
      rotatedLinearStops,
      objectId,
      "fill",
      "start",
      { x: linearGradientGraphic.width * 0.25, y: linearGradientGraphic.height * 0.75 }
    );
    expect(graphicById(movedLinearGradientStart, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0.25,
      y1: 0.75,
      x2: 1,
      y2: 1,
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 0.37, color: "#b3261e" },
        { offset: 1, color: "#1d7f68", opacity: 0.42 }
      ]
    });
    const movedLinearGradientEnd = updateNativeGraphicLinearGradientHandle(
      movedLinearGradientStart,
      objectId,
      "fill",
      "end",
      { x: linearGradientGraphic.width * 1.5, y: -12 }
    );
    expect(graphicById(movedLinearGradientEnd, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0.25,
      y1: 0.75,
      x2: 1,
      y2: 0
    });
    const deletedSelectedLinearStop = deleteGraphicObjectGradientStopAtIndexForSelection(editedLinearStopOpacity, "fill", 1);
    expect(graphicById(deletedSelectedLinearStop, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#b3261e" },
        { offset: 1, color: "#ffffff" }
      ]
    });
    const deletedLinearStop = deleteGraphicObjectGradientStopForSelection(addedLinearStop, "fill");
    expect(graphicById(deletedLinearStop, objectId).style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      stops: [
        { offset: 0, color: "#b3261e" },
        { offset: 1, color: "#ffffff" }
      ]
    });

    const transparentFill = applyGraphicObjectOpacityToSelection(linearFilled, "fillOpacity", 0.35);
    const transparentGraphic = graphicById(transparentFill, objectId);
    const linearSvg = exportPhase4Svg(transparentFill, { includeWarnings: true });
    expect(linearSvg.contents).toContain(`<linearGradient id="graphic-fill-${objectId}"`);
    expect(linearSvg.contents).toContain(`x1="${transparentGraphic.x}"`);
    expect(linearSvg.contents).toContain(`y1="${transparentGraphic.y}"`);
    expect(linearSvg.contents).toContain(`x2="${transparentGraphic.x + transparentGraphic.width}"`);
    expect(linearSvg.contents).toContain(`y2="${transparentGraphic.y + transparentGraphic.height}"`);
    expect(linearSvg.contents).toContain('stop-opacity="0.35"');
    expect(linearSvg.contents).toContain(`fill="url(#graphic-fill-${objectId})"`);
    expect(linearSvg.warnings).toEqual([]);

    const radialStroked = applyGraphicObjectPaintTypeToSelection(transparentFill, "stroke", "radial-gradient");
    expect(graphicById(radialStroked, objectId).style.strokePaint).toMatchObject({
      kind: "radial-gradient",
      units: "object",
      cx: 0.5,
      cy: 0.5,
      r: 0.72,
      fx: 0.32,
      fy: 0.28,
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 1, color: "#111111" }
      ]
    });

    const greenRadialStroke = applyGraphicObjectColorToSelection(radialStroked, "stroke", "#1d7f68");
    expect(graphicById(greenRadialStroke, objectId).style.strokePaint).toMatchObject({
      kind: "radial-gradient",
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 1, color: "#1d7f68" }
      ]
    });
    const reversedRadialStroke = reverseGraphicObjectGradientStopsForSelection(greenRadialStroke, "stroke");
    expect(graphicById(reversedRadialStroke, objectId).style.strokePaint).toMatchObject({
      kind: "radial-gradient",
      stops: [
        { offset: 0, color: "#1d7f68" },
        { offset: 1, color: "#ffffff" }
      ]
    });

    const radialGradientGraphic = graphicById(greenRadialStroke, objectId);
    const movedRadialCenter = updateNativeGraphicRadialGradientHandle(
      greenRadialStroke,
      objectId,
      "stroke",
      "center",
      { x: radialGradientGraphic.width * 0.25, y: radialGradientGraphic.height * 0.7 }
    );
    expect(graphicById(movedRadialCenter, objectId).style.strokePaint).toMatchObject({
      kind: "radial-gradient",
      cx: 0.25,
      cy: 0.7,
      r: 0.72,
      fx: 0.32,
      fy: 0.28,
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 1, color: "#1d7f68" }
      ]
    });
    const movedRadialFocus = updateNativeGraphicRadialGradientHandle(
      movedRadialCenter,
      objectId,
      "stroke",
      "focus",
      { x: radialGradientGraphic.width * 0.65, y: radialGradientGraphic.height * 0.2 }
    );
    expect(graphicById(movedRadialFocus, objectId).style.strokePaint).toMatchObject({
      kind: "radial-gradient",
      cx: 0.25,
      cy: 0.7,
      fx: 0.65,
      fy: 0.2
    });
    const resizedRadial = updateNativeGraphicRadialGradientHandle(
      movedRadialFocus,
      objectId,
      "stroke",
      "radius",
      {
        x: radialGradientGraphic.width * 0.25 + Math.max(radialGradientGraphic.width, radialGradientGraphic.height, 1) * 0.4,
        y: radialGradientGraphic.height * 0.7
      }
    );
    const resizedRadialPaint = graphicById(resizedRadial, objectId).style.strokePaint;
    expect(resizedRadialPaint).toMatchObject({
      kind: "radial-gradient",
      cx: 0.25,
      cy: 0.7,
      fx: 0.65,
      fy: 0.2
    });
    expect(resizedRadialPaint?.kind === "radial-gradient" ? resizedRadialPaint.r : undefined).toBeCloseTo(0.4, 6);

    const radialSvg = exportPhase4Svg(radialStroked, { includeWarnings: true });
    const radialGraphic = graphicById(radialStroked, objectId);
    expect(radialSvg.contents).toContain(`<radialGradient id="graphic-stroke-${objectId}"`);
    expect(radialSvg.contents).toContain(`cx="${radialGraphic.x + radialGraphic.width * 0.5}"`);
    expect(radialSvg.contents).toContain(`cy="${radialGraphic.y + radialGraphic.height * 0.5}"`);
    expect(radialSvg.contents).toContain(`r="${Number((Math.max(radialGraphic.width, radialGraphic.height, 1) * 0.72).toFixed(4))}"`);
    expect(radialSvg.contents).toContain(`stroke="url(#graphic-stroke-${objectId})"`);
    expect(radialSvg.warnings).toEqual([]);

    const glossed = applyGraphicObjectPaintTypeToSelection(radialStroked, "fill", "gloss");
    expect(graphicById(glossed, objectId).style.fillMode).toBe("gloss");

    const recoloredGloss = applyGraphicObjectColorToSelection(glossed, "fill", "#1d7f68");
    expect(graphicById(recoloredGloss, objectId).style).toMatchObject({
      fillColor: "#1d7f68",
      fillMode: "gloss",
      fillPaint: { kind: "solid", color: "#1d7f68", opacity: 0.35 }
    });

    const noFill = applyGraphicObjectPaintTypeToSelection(recoloredGloss, "fill", "none");
    expect(graphicById(noFill, objectId).style).toMatchObject({
      fillColor: "none",
      fillPaint: { kind: "none" }
    });
    expect(graphicById(noFill, objectId).style.fillMode).toBeUndefined();
  });

  it("moves linear gradient endpoint handles when endpoint stop offsets move", () => {
    const withGraphic = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Gradient Endpoint Stop Handles"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const objectId = withGraphic.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted art object to be selected.");
    }

    const linearFilled = applyGraphicObjectPaintTypeToSelection(withGraphic, "fill", "linear-gradient");
    const threeStopGradient = addGraphicObjectGradientStopForSelection(linearFilled, "fill");
    const movedStart = applyGraphicObjectGradientStopOffsetForSelection(threeStopGradient, "fill", 0, 0.25);
    const movedStartPaint = graphicById(movedStart, objectId).style.fillPaint;
    expect(movedStartPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0.25,
      y1: 0.25,
      x2: 1,
      y2: 1
    });
    if (movedStartPaint?.kind !== "linear-gradient") {
      throw new Error("Expected moved start linear gradient paint.");
    }
    expect(movedStartPaint.stops[0]?.offset).toBe(0);
    expect(movedStartPaint.stops[1]?.offset).toBeCloseTo(1 / 3, 6);
    expect(movedStartPaint.stops[2]?.offset).toBe(1);

    const movedEnd = applyGraphicObjectGradientStopOffsetForSelection(threeStopGradient, "fill", 2, 0.75);
    const movedEndPaint = graphicById(movedEnd, objectId).style.fillPaint;
    expect(movedEndPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0,
      y1: 0,
      x2: 0.75,
      y2: 0.75
    });
    if (movedEndPaint?.kind !== "linear-gradient") {
      throw new Error("Expected moved end linear gradient paint.");
    }
    expect(movedEndPaint.stops[0]?.offset).toBe(0);
    expect(movedEndPaint.stops[1]?.offset).toBeCloseTo(2 / 3, 6);
    expect(movedEndPaint.stops[2]?.offset).toBe(1);
  });

  it("flips native graphic gradient coordinates with the art object", () => {
    const document = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Gradient Flip"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const objectId = document.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted art object to be selected.");
    }
    const painted = applyPatches(document, [{
      op: "updateObject",
      objectId,
      changes: {
        style: {
          fillPaint: {
            kind: "linear-gradient",
            units: "object",
            x1: 0.15,
            y1: 0.2,
            x2: 0.85,
            y2: 0.7,
            stops: [
              { offset: 0, color: "#b3261e" },
              { offset: 1, color: "#ffffff" }
            ]
          },
          strokePaint: {
            kind: "radial-gradient",
            units: "object",
            cx: 0.3,
            cy: 0.4,
            r: 0.55,
            fx: 0.2,
            fy: 0.8,
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "#1d7f68" }
            ]
          }
        }
      }
    }]);
    const graphic = graphicById(painted, objectId);
    const center = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };

    const horizontal = flipDocumentObjectsAroundPoint(painted, [objectId], center, "horizontal");
    const horizontalGraphic = graphicById(horizontal, objectId);
    expect(horizontalGraphic.style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0.85,
      y1: 0.2,
      x2: 0.15,
      y2: 0.7,
      stops: [
        { offset: 0, color: "#b3261e" },
        { offset: 1, color: "#ffffff" }
      ]
    });
    expect(horizontalGraphic.style.strokePaint).toMatchObject({
      kind: "radial-gradient",
      cx: 0.7,
      cy: 0.4,
      r: 0.55,
      fx: 0.8,
      fy: 0.8,
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 1, color: "#1d7f68" }
      ]
    });

    const vertical = flipDocumentObjectsAroundPoint(painted, [objectId], center, "vertical");
    const verticalGraphic = graphicById(vertical, objectId);
    expect(verticalGraphic.style.fillPaint).toMatchObject({
      kind: "linear-gradient",
      x1: 0.15,
      y1: 0.8,
      x2: 0.85,
      y2: 0.3
    });
    expect(verticalGraphic.style.strokePaint).toMatchObject({
      kind: "radial-gradient",
      cx: 0.3,
      cy: 0.6,
      r: 0.55,
      fx: 0.2,
      fy: 0.2
    });
  });

  it("skips fill and corner-only style fields for open-stroke graphics", () => {
    const withLine = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Open Stroke Style"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = withLine.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line graphic to be selected.");
    }

    const fillAttempt = applyGraphicObjectColorToSelection(withLine, "fill", "#1d7f68");
    expect(graphicById(fillAttempt, objectId).style.fillColor).toBe("none");
    expect(graphicById(fillAttempt, objectId).style.fillPaint).toBeUndefined();

    const stroked = applyGraphicObjectColorToSelection(fillAttempt, "stroke", "#a94324");
    expect(graphicById(stroked, objectId).style).toMatchObject({
      strokeColor: "#a94324",
      strokePaint: { kind: "solid", color: "#a94324", opacity: 1 }
    });

    const fillOpacityAttempt = applyGraphicObjectOpacityToSelection(stroked, "fillOpacity", 0.25);
    expect(graphicById(fillOpacityAttempt, objectId).style.fillOpacity).toBeUndefined();

    const lineEnded = applyGraphicObjectStrokeStyleToSelection(fillOpacityAttempt, {
      strokeLineCap: "square"
    });
    expect(graphicById(lineEnded, objectId).style.strokeLineCap).toBe("square");

    const cornerAttempt = applyGraphicObjectStrokeStyleToSelection(lineEnded, {
      strokeLineJoin: "bevel",
      strokeMiterLimit: 6
    });
    expect(graphicById(cornerAttempt, objectId).style.strokeLineJoin).toBeUndefined();
    expect(graphicById(cornerAttempt, objectId).style.strokeMiterLimit).toBeUndefined();
  });

  it("uses distinct dashed and dotted stroke presets and round dots", () => {
    const withLine = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Dash Presets"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = withLine.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line graphic to be selected.");
    }

    const dashed = applyGraphicObjectStrokeStyleToSelection(withLine, {
      strokeDasharray: "8 6"
    });
    const dotted = applyGraphicObjectStrokeStyleToSelection(dashed, {
      strokeDasharray: "0 6",
      strokeLineCap: "round"
    });

    expect(graphicById(dashed, objectId).style.strokeDasharray).toBe("8 6");
    expect(graphicById(dotted, objectId).style.strokeDasharray).toBe("0 6");
    expect(graphicById(dotted, objectId).style.strokeDasharray).not.toBe(graphicById(dashed, objectId).style.strokeDasharray);
    expect(graphicById(dotted, objectId).style.strokeLineCap).toBe("round");
  });

  it("applies mixed graphic style commands only to supported objects", () => {
    const withLine = insertNativeArtGraphicObject(
      createPhase4Document("Mixed Graphic Styles"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const lineId = withLine.selection.objectIds[0];
    const withCircle = insertNativeArtGraphicObject(withLine, { x: 320, y: 180 }, "tool.art.circle");
    const circleId = withCircle.selection.objectIds[0];
    if (!lineId || !circleId) {
      throw new Error("Expected line and circle graphics.");
    }
    const selected = applyPatches(withCircle, [{
      op: "setSelection",
      pageId: withCircle.pages[0].id,
      objectIds: [lineId, circleId]
    }]);

    const filled = applyGraphicObjectColorToSelection(selected, "fill", "#1d7f68");
    expect(graphicById(filled, lineId).style.fillColor).toBe("none");
    expect(graphicById(filled, lineId).style.fillPaint).toBeUndefined();
    expect(graphicById(filled, circleId).style).toMatchObject({
      fillColor: "#1d7f68",
      fillPaint: { kind: "solid", color: "#1d7f68", opacity: 1 }
    });

    const stroked = applyGraphicObjectColorToSelection(filled, "stroke", "#b3261e");
    expect(graphicById(stroked, lineId).style.strokeColor).toBe("#b3261e");
    expect(graphicById(stroked, circleId).style.strokeColor).toBe("#b3261e");

    const lineEnded = applyGraphicObjectStrokeStyleToSelection(stroked, {
      strokeLineCap: "square"
    });
    expect(graphicById(lineEnded, lineId).style.strokeLineCap).toBe("square");
    expect(graphicById(lineEnded, circleId).style.strokeLineCap).toBeUndefined();

    const dotted = applyGraphicObjectStrokeStyleToSelection(lineEnded, {
      strokeDasharray: "0 6",
      strokeLineCap: "round"
    });
    expect(graphicById(dotted, lineId).style).toMatchObject({
      strokeDasharray: "0 6",
      strokeLineCap: "round"
    });
    expect(graphicById(dotted, circleId).style).toMatchObject({
      strokeDasharray: "0 6",
      strokeLineCap: "round"
    });
  });

  it("toggles object selection while preserving explicit order", () => {
    const withRect = insertNativeArtGraphicObject(
      createPhase4Document("Selection Toggle Order"),
      { x: 220, y: 180 },
      "tool.art.rectFilled"
    );
    const rectId = withRect.selection.objectIds[0];
    const withLine = insertNativeArtGraphicObject(withRect, { x: 320, y: 220 }, "tool.art.line");
    const lineId = withLine.selection.objectIds[0];
    if (!rectId || !lineId) {
      throw new Error("Expected a rectangle and line.");
    }
    const pageId = withLine.pages[0].id;
    const rectSelected = applyPatches(withLine, [{
      op: "setSelection",
      pageId,
      objectIds: [rectId]
    }]);

    const bothSelected = toggleDocumentObjectSelection(rectSelected, pageId, lineId);
    const lineOnly = toggleDocumentObjectSelection(bothSelected, pageId, rectId);

    expect(bothSelected.selection.objectIds).toEqual([rectId, lineId]);
    expect(lineOnly.selection.objectIds).toEqual([lineId]);
  });

  it("applies native art boolean union and exports the result as SVG", () => {
    const withFirst = insertNativeArtGraphicObject(
      createPhase4Document("Boolean Art Union"),
      { x: 220, y: 180 },
      "tool.art.rectFilled"
    );
    const firstId = withFirst.selection.objectIds[0];
    const withSecond = insertNativeArtGraphicObject(withFirst, { x: 260, y: 196 }, "tool.art.rectFilled");
    const secondId = withSecond.selection.objectIds[0];
    if (!firstId || !secondId) {
      throw new Error("Expected two art rectangles.");
    }
    const selected = applyPatches(withSecond, [{
      op: "setSelection",
      pageId: withSecond.pages[0].id,
      objectIds: [firstId, secondId]
    }]);

    expect(selectedArtBooleanEligibleObjectIds(selected)).toEqual([firstId, secondId]);
    const result = applyNativeArtBooleanOperationToSelection(selected, "union");
    const resultId = result.resultObjectIds[0];
    if (!resultId) {
      throw new Error("Expected boolean union result.");
    }
    const graphic = graphicById(result.document, resultId);
    const svg = exportPhase4Svg(result.document, { includeWarnings: true });
    const exportedTag = exportedObjectTag(svg.contents, resultId);
    const exportedPathD = exportedAttribute(exportedTag, "d");
    const exportedPoints = svgPathCoordinatePairs(exportedPathD);
    const exportedXs = exportedPoints.map((point) => point.x);
    const exportedYs = exportedPoints.map((point) => point.y);

    expect(result.changed).toBe(true);
    expect(result.status).toBe("Unioned 2 closed art shapes");
    expect(result.document.selection.objectIds).toEqual([resultId]);
    expect(result.document.pages[0].objects.some((object) => object.id === firstId || object.id === secondId)).toBe(false);
    expect(graphic).toMatchObject({
      type: "graphic",
      graphicKind: "path",
      style: {
        fillColor: "#111111",
        artToolCommandId: "art.boolean.union"
      },
      data: {
        artToolId: "boolean-union"
      }
    });
    expect(graphic.data.pathD).toMatch(/^M /);
    expect(svg.contents).toContain(`data-object-id="${resultId}"`);
    expect(exportedPathD).not.toBe(graphic.data.pathD);
    expect(Math.min(...exportedXs)).toBeCloseTo(graphic.x, 3);
    expect(Math.min(...exportedYs)).toBeCloseTo(graphic.y, 3);
    expect(svg.contents).toContain("<path");
    expect(svg.warnings).toEqual([]);

    const rotated = rotateDocumentObject(result.document, resultId, 12);
    const rotatedSvg = exportPhase4Svg(rotated, { includeWarnings: true });
    const rotatedTag = exportedObjectTag(rotatedSvg.contents, resultId);
    expect(exportedAttribute(rotatedTag, "transform")).toContain("rotate(12");
  });

  it("applies native art boolean subtract, intersect, split, and open-shape skips", () => {
    const withRect = insertNativeArtGraphicObject(
      createPhase4Document("Boolean Art Operations"),
      { x: 220, y: 180 },
      "tool.art.rectFilled"
    );
    const rectId = withRect.selection.objectIds[0];
    const withCircle = insertNativeArtGraphicObject(withRect, { x: 220, y: 180 }, "tool.art.circleFilled");
    const circleId = withCircle.selection.objectIds[0];
    if (!rectId || !circleId) {
      throw new Error("Expected a rectangle and circle.");
    }
    const selectedForSubtract = applyPatches(withCircle, [{
      op: "setSelection",
      pageId: withCircle.pages[0].id,
      objectIds: [rectId, circleId]
    }]);

    const subtracted = applyNativeArtBooleanOperationToSelection(selectedForSubtract, "subtract");
    const subtractGraphic = graphicById(subtracted.document, subtracted.resultObjectIds[0] ?? "");
    expect(subtracted.changed).toBe(true);
    expect(subtracted.status).toBe("Subtracted 1 closed art shape from first selected shape");
    expect((subtractGraphic.data.pathD?.match(/M /g) ?? [])).toHaveLength(2);
    expect(subtractGraphic.data.pathD).toContain("Z");

    const withFirstEllipse = insertNativeArtGraphicObject(
      createPhase4Document("Boolean Art Intersect Ellipses"),
      { x: 220, y: 180 },
      "tool.art.ellipseFilled"
    );
    const firstEllipseId = withFirstEllipse.selection.objectIds[0];
    const withSecondEllipse = insertNativeArtGraphicObject(withFirstEllipse, { x: 250, y: 180 }, "tool.art.ellipseFilled");
    const secondEllipseId = withSecondEllipse.selection.objectIds[0];
    if (!firstEllipseId || !secondEllipseId) {
      throw new Error("Expected intersect ellipses.");
    }
    const selectedForIntersect = applyPatches(withSecondEllipse, [{
      op: "setSelection",
      pageId: withSecondEllipse.pages[0].id,
      objectIds: [firstEllipseId, secondEllipseId]
    }]);
    const intersected = applyNativeArtBooleanOperationToSelection(selectedForIntersect, "intersect");
    const intersectGraphic = graphicById(intersected.document, intersected.resultObjectIds[0] ?? "");
    expect(intersected.changed).toBe(true);
    expect(intersectGraphic.width).toBeGreaterThan(0);
    expect(intersectGraphic.height).toBeGreaterThan(0);
    expect(intersectGraphic.data.pathD).toContain("Z");

    const withFirstSplitRect = insertNativeArtGraphicObject(
      createPhase4Document("Boolean Art Split"),
      { x: 220, y: 180 },
      "tool.art.rectFilled"
    );
    const firstSplitId = withFirstSplitRect.selection.objectIds[0];
    const withSecondSplitRect = insertNativeArtGraphicObject(withFirstSplitRect, { x: 252, y: 180 }, "tool.art.rectFilled");
    const secondSplitId = withSecondSplitRect.selection.objectIds[0];
    if (!firstSplitId || !secondSplitId) {
      throw new Error("Expected split rectangles.");
    }
    const selectedForSplit = applyPatches(withSecondSplitRect, [{
      op: "setSelection",
      pageId: withSecondSplitRect.pages[0].id,
      objectIds: [firstSplitId, secondSplitId]
    }]);
    const split = applyNativeArtBooleanOperationToSelection(selectedForSplit, "split");
    expect(split.changed).toBe(true);
    expect(split.resultObjectIds.length).toBeGreaterThanOrEqual(2);
    expect(split.document.selection.objectIds).toEqual(split.resultObjectIds);

    const withOpenLine = insertNativeArtGraphicObject(withRect, { x: 320, y: 220 }, "tool.art.line");
    const lineId = withOpenLine.selection.objectIds[0];
    if (!lineId) {
      throw new Error("Expected an open art line.");
    }
    const selectedWithLine = applyPatches(withOpenLine, [{
      op: "setSelection",
      pageId: withOpenLine.pages[0].id,
      objectIds: [rectId, lineId]
    }]);
    const skipped = applyNativeArtBooleanOperationToSelection(selectedWithLine, "union");
    expect(skipped.changed).toBe(false);
    expect(skipped.document).toBe(selectedWithLine);
    expect(skipped.skippedInputs).toEqual([{ objectId: lineId, reason: "open-shape" }]);
    expect(skipped.status).toBe("Boolean union needs at least two closed art shapes; skipped 1 open art object");
  });

  it("copies graphic fill, stroke, markers, and full appearance with the eyedropper helper", () => {
    const withTarget = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Eyedropper"),
      { x: 220, y: 180 },
      "tool.art.circle"
    );
    const targetId = withTarget.selection.objectIds[0];
    const withSource = insertNativeArtGraphicObject(withTarget, { x: 340, y: 180 }, "tool.art.rect");
    const sourceId = withSource.selection.objectIds[0];
    if (!targetId || !sourceId) {
      throw new Error("Expected eyedropper target and source graphics.");
    }
    const paintedSource = applyPatches(withSource, [
      {
        op: "updateObject",
        objectId: sourceId,
        changes: {
          style: {
            ...graphicById(withSource, sourceId).style,
            fillColor: "#1d7f68",
            fillOpacity: 0.42,
            fillMode: "solid",
            fillPaint: {
              kind: "linear-gradient",
              units: "object",
              x1: 0,
              y1: 0,
              x2: 1,
              y2: 1,
              stops: [
                { offset: 0, color: "#ffffff" },
                { offset: 1, color: "#1d7f68", opacity: 0.42 }
              ]
            },
            strokeColor: "#b3261e",
            strokeWidth: 5
          }
        }
      },
      { op: "setSelection", pageId: withSource.pages[0].id, objectIds: [targetId] }
    ]);

    const copiedFill = applyGraphicObjectEyedropperToSelection(paintedSource, sourceId, "fill");
    expect(graphicById(copiedFill, targetId).style).toMatchObject({
      fillColor: "#1d7f68",
      fillOpacity: 0.42,
      fillPaint: {
        kind: "linear-gradient",
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#1d7f68", opacity: 0.42 }
        ]
      }
    });
    expect(graphicById(copiedFill, targetId).style.strokeWidth).not.toBe(5);

    const withLineTarget = insertNativeArtGraphicObject(
      createPhase4Document("Graphic Eyedropper Stroke"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const lineTargetId = withLineTarget.selection.objectIds[0];
    const withArrowSource = insertNativeArtGraphicObject(withLineTarget, { x: 360, y: 180 }, "tool.art.arrow");
    const arrowSourceId = withArrowSource.selection.objectIds[0];
    if (!lineTargetId || !arrowSourceId) {
      throw new Error("Expected eyedropper line target and arrow source.");
    }
    const styledArrowSource = applyPatches(withArrowSource, [
      {
        op: "updateObject",
        objectId: arrowSourceId,
        changes: {
          style: {
            ...graphicById(withArrowSource, arrowSourceId).style,
            strokeColor: "#6046a8",
            strokeOpacity: 0.6,
            strokeWidth: 7,
            strokeDasharray: "8 6",
            strokeLineCap: "square"
          }
        }
      },
      { op: "setSelection", pageId: withArrowSource.pages[0].id, objectIds: [lineTargetId] }
    ]);
    const copiedStroke = applyGraphicObjectEyedropperToSelection(styledArrowSource, arrowSourceId, "stroke");
    expect(graphicById(copiedStroke, lineTargetId).style).toMatchObject({
      strokeColor: "#6046a8",
      strokeOpacity: 0.6,
      strokeWidth: 7,
      strokeDasharray: "8 6",
      strokeLineCap: "square"
    });
    expect(graphicById(copiedStroke, lineTargetId).data.markerEnd).toEqual({ kind: "filled-arrow", sizePx: 10 });
    expect(graphicById(copiedStroke, lineTargetId).style.fillColor).toBe("none");

    const fullAppearanceTarget = applyPatches(paintedSource, [
      {
        op: "updateObject",
        objectId: sourceId,
        changes: {
          style: {
            ...graphicById(paintedSource, sourceId).style,
            opacity: 0.7,
            effect: "shadow",
            effects: [{ kind: "sketch", seed: 3919 }],
            tiltXDegrees: 35
          }
        }
      },
      { op: "setSelection", pageId: paintedSource.pages[0].id, objectIds: [targetId] }
    ]);
    const copiedFull = applyGraphicObjectEyedropperToSelection(
      fullAppearanceTarget,
      sourceId,
      "fill",
      { fullAppearance: true }
    );
    expect(graphicById(copiedFull, targetId).style).toMatchObject({
      fillColor: "#1d7f68",
      strokeColor: "#b3261e",
      strokeWidth: 5,
      opacity: 0.7,
      effect: "shadow",
      effects: [
        { kind: "sketch", seed: 3919 }
      ]
    });
    expect(graphicById(copiedFull, targetId).style.tiltXDegrees).toBeUndefined();
  });

  it("applies and clears native art effect metadata through workflow helpers", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Art Effects"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted rectangle art object to be selected.");
    }

    const shadowed = applyGraphicObjectEffectToSelection(inserted, "shadow");
    expect(graphicById(shadowed, objectId).style.effects).toEqual([
      { kind: "shadow", color: "#52616b", opacity: 0.28, offsetX: 6, offsetY: 6, blurPx: 3 }
    ]);

    const sketched = applyGraphicObjectEffectToSelection(shadowed, "sketch");
    expect(graphicById(sketched, objectId).style.effects?.map((effect) => effect.kind)).toEqual(["shadow", "sketch"]);
    expect(graphicById(sketched, objectId).style.effects?.find((effect) => effect.kind === "sketch")).toMatchObject({
      seed: expect.any(Number),
      roughness: 1.25,
      bowing: 0.8,
      strokeWidth: 1.5
    });

    const recolored = applyGraphicObjectEffectColorToSelection(sketched, "shadow", "#123456");
    expect(graphicById(recolored, objectId).style.fillColor).toBe("none");
    expect(graphicById(recolored, objectId).style.strokeColor).toBe("#111111");
    expect(graphicById(recolored, objectId).style.effects?.find((effect) => effect.kind === "shadow")).toMatchObject({
      color: "#123456",
      opacity: 0.28,
      offsetX: 6,
      offsetY: 6,
      blurPx: 3
    });

    const resized = applyGraphicObjectEffectSizeToSelection(recolored, "glow", 0.5);
    expect(graphicById(resized, objectId).style.effects?.find((effect) => effect.kind === "glow")).toMatchObject({
      kind: "glow",
      color: "#fdd835",
      opacity: 0.42,
      blurPx: 9,
      spreadPx: 2
    });

    const faded = applyGraphicObjectEffectOpacityToSelection(resized, "glow", 0.72);
    expect(graphicById(faded, objectId).style.effects?.find((effect) => effect.kind === "glow")).toMatchObject({
      opacity: 0.72,
      blurPx: 9,
      spreadPx: 2
    });

    const disabledGlow = deactivateGraphicObjectEffectForSelection(faded, "glow");
    expect(graphicById(disabledGlow, objectId).style.effects?.map((effect) => effect.kind)).toEqual(["shadow", "sketch"]);
    expect(graphicById(disabledGlow, objectId).style.inactiveEffects).toEqual([
      { kind: "glow", color: "#fdd835", opacity: 0.72, blurPx: 9, spreadPx: 2 }
    ]);

    const restoredGlow = applyGraphicObjectEffectToSelection(disabledGlow, "glow");
    expect(graphicById(restoredGlow, objectId).style.effects?.find((effect) => effect.kind === "glow")).toMatchObject({
      color: "#fdd835",
      opacity: 0.72,
      blurPx: 9,
      spreadPx: 2
    });
    expect(graphicById(restoredGlow, objectId).style.inactiveEffects).toBeUndefined();

    const activeClickAgain = applyGraphicObjectEffectToSelection(restoredGlow, "glow");
    expect(graphicById(activeClickAgain, objectId).style.effects?.find((effect) => effect.kind === "glow")).toMatchObject({
      color: "#fdd835",
      opacity: 0.72,
      blurPx: 9,
      spreadPx: 2
    });

    const cleared = applyGraphicObjectEffectToSelection(activeClickAgain, "none");
    expect(graphicById(cleared, objectId).style.effect).toBeUndefined();
    expect(graphicById(cleared, objectId).style.effects).toBeUndefined();
    expect(graphicById(cleared, objectId).style.inactiveEffects?.map((effect) => effect.kind)).toEqual(["shadow", "sketch", "glow"]);

    const restoredAfterClear = applyGraphicObjectEffectToSelection(cleared, "shadow");
    expect(graphicById(restoredAfterClear, objectId).style.effects).toEqual([
      { kind: "shadow", color: "#123456", opacity: 0.28, offsetX: 6, offsetY: 6, blurPx: 3 }
    ]);
    expect(graphicById(restoredAfterClear, objectId).style.inactiveEffects?.map((effect) => effect.kind)).toEqual(["sketch", "glow"]);
  });

  it("applies shared visual effects to selected molecules without changing chemistry", () => {
    const inserted = insertNativeSingleBondMolecule(
      createPhase4Document("Native Molecule Visual Effects"),
      { x: 260, y: 220 }
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted native molecule to be selected.");
    }
    const originalMolecule = moleculeById(inserted, objectId);

    expect(selectedVisualEffectObjectIds(inserted)).toEqual([objectId]);

    const glowing = applyVisualEffectToSelection(inserted, "glow");
    expect(moleculeVisualEffects(glowing, objectId)).toEqual([
      { kind: "glow", color: "#fdd835", opacity: 0.42, blurPx: 7, spreadPx: 1.2 }
    ]);

    const recolored = applyVisualEffectColorToSelection(glowing, "glow", "#ffee66");
    const resized = applyVisualEffectSizeToSelection(recolored, "glow", 0.5);
    const faded = applyVisualEffectOpacityToSelection(resized, "glow", 0.7);
    expect(moleculeVisualEffects(faded, objectId)?.[0]).toMatchObject({
      kind: "glow",
      color: "#ffee66",
      opacity: 0.7,
      blurPx: 9,
      spreadPx: 2
    });

    const disabled = deactivateVisualEffectForSelection(faded, "glow");
    expect(moleculeVisualEffects(disabled, objectId)).toBeUndefined();
    expect(moleculeInactiveVisualEffects(disabled, objectId)).toEqual([
      { kind: "glow", color: "#ffee66", opacity: 0.7, blurPx: 9, spreadPx: 2 }
    ]);

    const restored = applyVisualEffectToSelection(disabled, "glow");
    expect(moleculeVisualEffects(restored, objectId)).toEqual([
      { kind: "glow", color: "#ffee66", opacity: 0.7, blurPx: 9, spreadPx: 2 }
    ]);
    const restoredMolecule = moleculeById(restored, objectId);
    expect(restoredMolecule.atoms).toEqual(originalMolecule.atoms);
    expect(restoredMolecule.bonds).toEqual(originalMolecule.bonds);
    expect(restoredMolecule.structure).toBe(originalMolecule.structure);
    expect(restoredMolecule.chemistry).toEqual(originalMolecule.chemistry);
  });

  it("does not apply visual effect metadata to selected text, plus signs, or charge symbols", () => {
    const withMolecule = insertNativeSingleBondMolecule(
      createPhase4Document("Visual Effects Ignore Symbols"),
      { x: 260, y: 220 }
    );
    const moleculeId = withMolecule.selection.objectIds[0];
    if (!moleculeId) {
      throw new Error("Expected inserted native molecule to be selected.");
    }

    const pageId = withMolecule.pages[0].id;
    const textObject: TextObject = {
      id: "text_visual_effect_guard",
      type: "text",
      x: 120,
      y: 140,
      width: 80,
      height: 28,
      rotation: 0,
      style: { color: "#111111" },
      text: "N",
      spans: []
    };
    const plusObject: PlusObject = {
      id: "plus_visual_effect_guard",
      type: "plus",
      x: 180,
      y: 140,
      width: 24,
      height: 24,
      rotation: 0,
      style: {}
    };
    const chargeObject: ElectronMarkObject = {
      id: "charge_visual_effect_guard",
      type: "electron-mark",
      x: 220,
      y: 140,
      width: 18,
      height: 18,
      rotation: 0,
      style: {},
      markKind: "charge",
      anchor: { kind: "point", point: { x: 229, y: 149 } },
      charge: 1
    };
    const mixedSelection = selectAllDocumentObjects(
      applyPatches(withMolecule, [
        { op: "addObject", pageId, object: textObject },
        { op: "addObject", pageId, object: plusObject },
        { op: "addObject", pageId, object: chargeObject }
      ]),
      pageId
    );

    expect(selectedVisualEffectObjectIds(mixedSelection)).toEqual([moleculeId]);

    const sketched = applyVisualEffectToSelection(mixedSelection, "sketch");
    expect(moleculeVisualEffects(sketched, moleculeId)?.map((effect) => effect.kind)).toEqual(["sketch"]);
    for (const objectId of [textObject.id, plusObject.id, chargeObject.id]) {
      expect(objectStyleById(sketched, objectId).visualEffects).toBeUndefined();
      expect(objectStyleById(sketched, objectId).effects).toBeUndefined();
    }
  });

  it("edits rectangle corner radius through native graphic workflow helpers", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Corner Radius Edit"),
      { x: 220, y: 180 },
      "tool.art.rect"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted rectangle art object to be selected.");
    }
    const rect = graphicById(inserted, objectId);

    expect(nativeGraphicCornerRadiusEditPoint(rect)).toEqual({ x: 0, y: 0 });

    const maxed = updateNativeGraphicCornerRadius(inserted, objectId, { x: 200, y: 0 });
    const maxedRect = graphicById(maxed, objectId);
    expect(maxedRect.data.cornerRadiusPx).toBeCloseTo(Math.min(rect.width, rect.height) / 2, 3);
    expect(maxedRect.graphicKind).toBe("rect");
    expect(maxedRect.x).toBe(rect.x);
    expect(maxedRect.y).toBe(rect.y);
    expect(maxedRect.width).toBe(rect.width);
    expect(maxedRect.height).toBe(rect.height);

    const reset = updateNativeGraphicCornerRadius(maxed, objectId, { x: -20, y: 0 });
    expect(graphicById(reset, objectId).data.cornerRadiusPx).toBe(0);

    const ellipseInserted = insertNativeArtGraphicObject(reset, { x: 320, y: 180 }, "tool.art.circle");
    const ellipseId = ellipseInserted.selection.objectIds[0];
    if (!ellipseId) {
      throw new Error("Expected inserted ellipse art object.");
    }
    expect(nativeGraphicCornerRadiusEditPoint(graphicById(ellipseInserted, ellipseId))).toBeUndefined();
    expect(updateNativeGraphicCornerRadius(ellipseInserted, ellipseId, { x: 12, y: 0 })).toBe(ellipseInserted);

    const radiusHistory = {
      past: [inserted],
      present: maxed,
      future: []
    };
    expect(graphicById(undo(radiusHistory).present, objectId).data.cornerRadiusPx).toBeUndefined();
    expect(graphicById(redo(undo(radiusHistory)).present, objectId).data.cornerRadiusPx).toBe(maxedRect.data.cornerRadiusPx);

    const reopened = openNativeDocument(createNativeSavePayload(maxed).contents);
    expect(graphicById(reopened.document ?? inserted, objectId).data.cornerRadiusPx).toBe(maxedRect.data.cornerRadiusPx);
  });

  it("edits native graphic path endpoints and bends straight lines into freeform curves", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Path Edit"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }

    const originalGraphic = graphicById(inserted, objectId);
    const originalPoints = nativeGraphicPathEditPoints(originalGraphic);
    if (!originalPoints) {
      throw new Error("Expected line art object to expose path edit points.");
    }

    const extendedEnd = {
      x: originalPoints.end.x + 64,
      y: originalPoints.end.y + 12
    };
    const endpointEdited = updateNativeGraphicPathHandle(inserted, objectId, "end", extendedEnd);
    const endpointGraphic = graphicById(endpointEdited, objectId);
    expect(endpointGraphic.data).toMatchObject({
      artPathKind: "line",
      lineStart: originalPoints.start,
      lineEnd: extendedEnd
    });
    expect(endpointGraphic.width).toBeGreaterThan(originalGraphic.width);
    expect(endpointGraphic.height).toBeGreaterThan(originalGraphic.height);
    expect(endpointEdited.selection.objectIds).toEqual([objectId]);

    const bentControl = {
      x: (originalPoints.start.x + extendedEnd.x) / 2,
      y: originalPoints.start.y - 48
    };
    const bent = updateNativeGraphicPathHandle(endpointEdited, objectId, "middle", bentControl);
    const bentGraphic = graphicById(bent, objectId);
    const bentPoints = nativeGraphicPathEditPoints(bentGraphic);
    expect(bentGraphic.data.artPathKind).toBe("quadratic");
    expect(bentGraphic.data.arcCenter).toBeUndefined();
    expect(bentGraphic.data.arcRadiusX).toBeUndefined();
    expect(bentGraphic.data.arcRadiusY).toBeUndefined();
    expect(bentGraphic.data.arcStartRadians).toBeUndefined();
    expect(bentGraphic.data.arcSweepRadians).toBeUndefined();
    expect(bentGraphic.data.lineStart).toEqual(originalPoints.start);
    expect(bentGraphic.data.lineEnd).toEqual(extendedEnd);
    expect(bentGraphic.data.pathControlPoint).toEqual(bentControl);
    expect(bentPoints?.middle.x).toBeCloseTo(bentControl.x, 3);
    expect(bentPoints?.middle.y).toBeCloseTo(bentControl.y, 3);
    expect(bentGraphic.y).toBeLessThan(endpointGraphic.y);

    const pathEditHistory = {
      past: [endpointEdited],
      present: bent,
      future: []
    };
    expect(graphicById(undo(pathEditHistory).present, objectId).data.artPathKind).toBe("line");
    expect(nativeGraphicPathEditPoints(graphicById(redo(undo(pathEditHistory)).present, objectId))?.middle.x).toBeCloseTo(bentControl.x, 3);
  });

  it("moves edited line graphic endpoints with the object", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Move Edited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const endpointEdited = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "end",
      { x: points.end.x + 42, y: points.end.y + 12 }
    );
    const editedGraphic = graphicById(endpointEdited, objectId);
    const dx = 36;
    const dy = 22;

    const moved = moveDocumentObject(endpointEdited, objectId, {
      x: editedGraphic.x + dx,
      y: editedGraphic.y + dy
    });
    const movedGraphic = graphicById(moved, objectId);

    expect(movedGraphic.x).toBeCloseTo(editedGraphic.x + dx, 6);
    expect(movedGraphic.y).toBeCloseTo(editedGraphic.y + dy, 6);
    expect(movedGraphic.data.lineStart).toEqual(translatedPoint(editedGraphic.data.lineStart!, dx, dy));
    expect(movedGraphic.data.lineEnd).toEqual(translatedPoint(editedGraphic.data.lineEnd!, dx, dy));
    expect(movedGraphic.data.pathControlPoint).toBeUndefined();
  });

  it("moves quadratic graphic explicit points with the object", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Move Quadratic Graphic"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 8, y: points.middle.y - 44 }
    );
    const bentGraphic = graphicById(bent, objectId);
    const beforePoints = nativeGraphicPathEditPoints(bentGraphic);
    const dx = 28;
    const dy = -18;

    const moved = moveDocumentObject(bent, objectId, {
      x: bentGraphic.x + dx,
      y: bentGraphic.y + dy
    });
    const movedGraphic = graphicById(moved, objectId);
    const movedPoints = nativeGraphicPathEditPoints(movedGraphic);

    expect(movedGraphic.data.artPathKind).toBe("quadratic");
    expect(movedGraphic.data.lineStart).toEqual(translatedPoint(bentGraphic.data.lineStart!, dx, dy));
    expect(movedGraphic.data.lineEnd).toEqual(translatedPoint(bentGraphic.data.lineEnd!, dx, dy));
    expect(movedGraphic.data.pathControlPoint).toEqual(translatedPoint(bentGraphic.data.pathControlPoint!, dx, dy));
    expect(movedPoints?.start).toEqual(translatedPoint(beforePoints!.start, dx, dy));
    expect(movedPoints?.middle).toEqual(translatedPoint(beforePoints!.middle, dx, dy));
    expect(movedPoints?.end).toEqual(translatedPoint(beforePoints!.end, dx, dy));
  });

  it("moves legacy quadratic arc explicit points with the object", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Move Legacy Quadratic Arc"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 10, y: points.middle.y - 36 }
    );
    const legacy = applyPatch(bent, {
      op: "updateObject",
      objectId,
      changes: {
        data: {
          ...graphicById(bent, objectId).data,
          artPathKind: "arc"
        }
      }
    });
    const legacyGraphic = graphicById(legacy, objectId);
    const dx = 18;
    const dy = 24;

    const moved = moveDocumentObject(legacy, objectId, {
      x: legacyGraphic.x + dx,
      y: legacyGraphic.y + dy
    });
    const movedGraphic = graphicById(moved, objectId);

    expect(movedGraphic.data.artPathKind).toBe("arc");
    expect(movedGraphic.data.lineStart).toEqual(translatedPoint(legacyGraphic.data.lineStart!, dx, dy));
    expect(movedGraphic.data.lineEnd).toEqual(translatedPoint(legacyGraphic.data.lineEnd!, dx, dy));
    expect(movedGraphic.data.pathControlPoint).toEqual(translatedPoint(legacyGraphic.data.pathControlPoint!, dx, dy));
  });

  it("moves semantic arc center with the object", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Move Semantic Arc"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arc art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected arc art object to expose path edit points.");
    }
    const edited = updateNativeGraphicPathHandle(inserted, objectId, "end", points.start);
    const editedGraphic = graphicById(edited, objectId);
    const dx = 31;
    const dy = 17;

    const moved = moveDocumentObject(edited, objectId, {
      x: editedGraphic.x + dx,
      y: editedGraphic.y + dy
    });
    const movedGraphic = graphicById(moved, objectId);

    expect(editedGraphic.data.arcCenter).toBeDefined();
    expect(movedGraphic.data.artPathKind).toBe("arc");
    expect(movedGraphic.data.arcCenter).toEqual(translatedPoint(editedGraphic.data.arcCenter!, dx, dy));
    expect(movedGraphic.data.pathControlPoint).toBeUndefined();
  });

  it("moves unedited line graphics through object bounds fallback", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Move Unedited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const graphic = graphicById(inserted, objectId);
    const beforePoints = nativeGraphicPathEditPoints(graphic);
    if (!beforePoints) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const dx = 40;
    const dy = -12;

    const moved = moveDocumentObject(inserted, objectId, {
      x: graphic.x + dx,
      y: graphic.y + dy
    });
    const movedGraphic = graphicById(moved, objectId);
    const movedPoints = nativeGraphicPathEditPoints(movedGraphic);

    expect(movedGraphic.data.lineStart).toBeUndefined();
    expect(movedGraphic.data.lineEnd).toBeUndefined();
    expect(movedGraphic.data.pathControlPoint).toBeUndefined();
    expect(movedPoints?.start).toEqual(translatedPoint(beforePoints.start, dx, dy));
    expect(movedPoints?.middle).toEqual(translatedPoint(beforePoints.middle, dx, dy));
    expect(movedPoints?.end).toEqual(translatedPoint(beforePoints.end, dx, dy));
  });

  it("scales edited line graphic endpoints with the frame", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Scale Edited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const endpointEdited = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "end",
      { x: points.end.x + 42, y: points.end.y + 12 }
    );
    const editedGraphic = graphicById(endpointEdited, objectId);
    const oldCenter = {
      x: editedGraphic.x + editedGraphic.width / 2,
      y: editedGraphic.y + editedGraphic.height / 2
    };
    const scaleX = 1.5;
    const scaleY = 0.5;

    const scaled = scaleDocumentObjectsAroundPoint(endpointEdited, [objectId], oldCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const newCenter = {
      x: scaledGraphic.x + scaledGraphic.width / 2,
      y: scaledGraphic.y + scaledGraphic.height / 2
    };

    expect(scaledGraphic.width).toBeCloseTo(editedGraphic.width * scaleX, 6);
    expect(scaledGraphic.height).toBeCloseTo(editedGraphic.height * scaleY, 6);
    expectPointToBeClose(scaledGraphic.data.lineStart, scaledPoint(editedGraphic.data.lineStart!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledGraphic.data.lineEnd, scaledPoint(editedGraphic.data.lineEnd!, oldCenter, newCenter, scaleX, scaleY));
    expect(scaledGraphic.data.pathControlPoint).toBeUndefined();
  });

  it("scales quadratic graphic explicit points with the frame", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Scale Quadratic Graphic"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 8, y: points.middle.y - 44 }
    );
    const bentGraphic = graphicById(bent, objectId);
    const beforePoints = nativeGraphicPathEditPoints(bentGraphic);
    const oldCenter = {
      x: bentGraphic.x + bentGraphic.width / 2,
      y: bentGraphic.y + bentGraphic.height / 2
    };
    const scaleX = 1.35;
    const scaleY = 0.6;

    const scaled = scaleDocumentObjectsAroundPoint(bent, [objectId], oldCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const scaledPoints = nativeGraphicPathEditPoints(scaledGraphic);
    const newCenter = {
      x: scaledGraphic.x + scaledGraphic.width / 2,
      y: scaledGraphic.y + scaledGraphic.height / 2
    };

    expect(scaledGraphic.data.artPathKind).toBe("quadratic");
    expectPointToBeClose(scaledGraphic.data.lineStart, scaledPoint(bentGraphic.data.lineStart!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledGraphic.data.lineEnd, scaledPoint(bentGraphic.data.lineEnd!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledGraphic.data.pathControlPoint, scaledPoint(bentGraphic.data.pathControlPoint!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledPoints?.start, scaledPoint(beforePoints!.start, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledPoints?.middle, scaledPoint(beforePoints!.middle, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledPoints?.end, scaledPoint(beforePoints!.end, oldCenter, newCenter, scaleX, scaleY));
  });

  it("scales legacy quadratic arc explicit points with the frame", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Scale Legacy Quadratic Arc"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 10, y: points.middle.y - 36 }
    );
    const legacy = applyPatch(bent, {
      op: "updateObject",
      objectId,
      changes: {
        data: {
          ...graphicById(bent, objectId).data,
          artPathKind: "arc"
        }
      }
    });
    const legacyGraphic = graphicById(legacy, objectId);
    const oldCenter = {
      x: legacyGraphic.x + legacyGraphic.width / 2,
      y: legacyGraphic.y + legacyGraphic.height / 2
    };
    const scaleX = 0.8;
    const scaleY = 1.4;

    const scaled = scaleDocumentObjectsAroundPoint(legacy, [objectId], oldCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const newCenter = {
      x: scaledGraphic.x + scaledGraphic.width / 2,
      y: scaledGraphic.y + scaledGraphic.height / 2
    };

    expect(scaledGraphic.data.artPathKind).toBe("arc");
    expectPointToBeClose(scaledGraphic.data.lineStart, scaledPoint(legacyGraphic.data.lineStart!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledGraphic.data.lineEnd, scaledPoint(legacyGraphic.data.lineEnd!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledGraphic.data.pathControlPoint, scaledPoint(legacyGraphic.data.pathControlPoint!, oldCenter, newCenter, scaleX, scaleY));
  });

  it("scales semantic arc center and radii with the frame", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Scale Semantic Arc"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arc art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected arc art object to expose path edit points.");
    }
    const edited = updateNativeGraphicPathHandle(inserted, objectId, "end", points.start);
    const editedGraphic = graphicById(edited, objectId);
    const oldCenter = {
      x: editedGraphic.x + editedGraphic.width / 2,
      y: editedGraphic.y + editedGraphic.height / 2
    };
    const scaleX = 1.25;
    const scaleY = 0.75;

    const scaled = scaleDocumentObjectsAroundPoint(edited, [objectId], oldCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const newCenter = {
      x: scaledGraphic.x + scaledGraphic.width / 2,
      y: scaledGraphic.y + scaledGraphic.height / 2
    };

    expect(editedGraphic.data.arcCenter).toBeDefined();
    expect(scaledGraphic.data.artPathKind).toBe("arc");
    expectPointToBeClose(scaledGraphic.data.arcCenter, scaledPoint(editedGraphic.data.arcCenter!, oldCenter, newCenter, scaleX, scaleY));
    expect(scaledGraphic.data.arcRadiusX).toBeCloseTo((editedGraphic.data.arcRadiusX ?? 0) * scaleX, 6);
    expect(scaledGraphic.data.arcRadiusY).toBeCloseTo((editedGraphic.data.arcRadiusY ?? 0) * scaleY, 6);
    expect(scaledGraphic.data.pathControlPoint).toBeUndefined();
  });

  it("scales unedited line graphics through object bounds fallback", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Scale Unedited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const graphic = graphicById(inserted, objectId);
    const beforePoints = nativeGraphicPathEditPoints(graphic);
    if (!beforePoints) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const oldCenter = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };
    const scaleX = 1.4;
    const scaleY = 0.7;

    const scaled = scaleDocumentObjectsAroundPoint(inserted, [objectId], oldCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const scaledPoints = nativeGraphicPathEditPoints(scaledGraphic);

    expect(scaledGraphic.data.lineStart).toBeUndefined();
    expect(scaledGraphic.data.lineEnd).toBeUndefined();
    expect(scaledGraphic.data.pathControlPoint).toBeUndefined();
    expect(scaledGraphic.width).toBeCloseTo(graphic.width * scaleX, 6);
    expect(scaledGraphic.height).toBeCloseTo(graphic.height * scaleY, 6);
    for (const point of [scaledPoints?.start, scaledPoints?.middle, scaledPoints?.end]) {
      expect(point?.x).toBeGreaterThanOrEqual(scaledGraphic.x);
      expect(point?.x).toBeLessThanOrEqual(scaledGraphic.x + scaledGraphic.width);
      expect(point?.y).toBeGreaterThanOrEqual(scaledGraphic.y);
      expect(point?.y).toBeLessThanOrEqual(scaledGraphic.y + scaledGraphic.height);
    }
    expect(pointDistance(scaledPoints!.start, beforePoints.start)).toBeGreaterThan(0.5);
    expect(pointDistance(scaledPoints!.end, beforePoints.end)).toBeGreaterThan(0.5);
  });

  it("scales native polyline path nodes with the frame", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Scale Native Polyline"),
      { x: 220, y: 180 },
      "tool.art.polyline"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted polyline art object to be selected.");
    }
    const graphic = graphicById(inserted, objectId);
    const beforeNodes = graphic.data.pathNodes;
    if (!beforeNodes) {
      throw new Error("Expected inserted polyline art object to store path nodes.");
    }
    const oldCenter = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };
    const scaleX = 1.5;
    const scaleY = 0.45;

    const scaled = scaleDocumentObjectsAroundPoint(inserted, [objectId], oldCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const afterNodes = scaledGraphic.data.pathNodes;
    const newCenter = {
      x: scaledGraphic.x + scaledGraphic.width / 2,
      y: scaledGraphic.y + scaledGraphic.height / 2
    };

    expect(scaledGraphic.data.artPathKind).toBe("polyline");
    expect(scaledGraphic.width).toBeCloseTo(graphic.width * scaleX, 6);
    expect(scaledGraphic.height).toBeCloseTo(graphic.height * scaleY, 6);
    expect(afterNodes).toHaveLength(beforeNodes.length);
    beforeNodes.forEach((node, index) => {
      expectPointToBeClose(afterNodes?.[index]?.point, scaledPoint(node.point, oldCenter, newCenter, scaleX, scaleY));
    });
  });

  it("does not rewrite local pathD data while scaling graphic frames", () => {
    const baseDocument = createPhase4Document("Scale Local Path D");
    const page = baseDocument.pages[0];
    if (!page) {
      throw new Error("Expected a page.");
    }
    const graphic: GraphicObject = {
      type: "graphic",
      id: "local_path_d",
      x: 180,
      y: 160,
      width: 96,
      height: 54,
      rotation: 0,
      graphicKind: "path",
      style: {
        strokeColor: "#111111",
        fillColor: "none",
        strokeWidth: 3
      },
      data: {
        pathD: "M 0 0 C 12 24 48 24 96 54"
      }
    };
    const document = applyPatches(baseDocument, [
      { op: "addObject", pageId: page.id, object: graphic },
      { op: "setSelection", pageId: page.id, objectIds: [graphic.id] }
    ]);
    const oldCenter = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };

    const scaled = scaleDocumentObjectsAroundPoint(document, [graphic.id], oldCenter, 1.5, 0.5);
    const scaledGraphic = graphicById(scaled, graphic.id);

    expect(scaledGraphic.width).toBeCloseTo(graphic.width * 1.5, 6);
    expect(scaledGraphic.height).toBeCloseTo(graphic.height * 0.5, 6);
    expect(scaledGraphic.data.pathD).toBe(graphic.data.pathD);
  });

  it("rotates a single edited graphic line around its object box center without rewriting explicit geometry", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Single Graphic Rotation Pivot"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 12, y: points.middle.y - 36 }
    );
    const bentGraphic = graphicById(bent, objectId);
    const oldCenter = {
      x: bentGraphic.x + bentGraphic.width / 2,
      y: bentGraphic.y + bentGraphic.height / 2
    };

    const rotated = rotateDocumentObject(bent, objectId, 47);
    const rotatedGraphic = graphicById(rotated, objectId);
    const newCenter = {
      x: rotatedGraphic.x + rotatedGraphic.width / 2,
      y: rotatedGraphic.y + rotatedGraphic.height / 2
    };

    expectPointToBeClose(newCenter, oldCenter);
    expect(rotatedGraphic.rotation).toBeCloseTo(47, 6);
    expect(rotatedGraphic.width).toBeCloseTo(bentGraphic.width, 6);
    expect(rotatedGraphic.height).toBeCloseTo(bentGraphic.height, 6);
    expectPointToBeClose(rotatedGraphic.data.lineStart, bentGraphic.data.lineStart!);
    expectPointToBeClose(rotatedGraphic.data.lineEnd, bentGraphic.data.lineEnd!);
    expectPointToBeClose(rotatedGraphic.data.pathControlPoint, bentGraphic.data.pathControlPoint!);
  });

  it("prepares a rotated straight graphic line for direct editing without moving visible endpoints", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Prepare Rotated Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const rotated = rotateDocumentObject(inserted, objectId, 42);
    const rotatedGraphic = graphicById(rotated, objectId);
    const rotatedPoints = nativeGraphicPathEditPoints(rotatedGraphic);
    if (!rotatedPoints) {
      throw new Error("Expected rotated line edit points.");
    }
    const projectedStart = projectGraphicVisualPoint(rotatedGraphic, rotatedPoints.start);
    const projectedEnd = projectGraphicVisualPoint(rotatedGraphic, rotatedPoints.end);

    const prepared = prepareGraphicPathForDirectEdit(rotated, objectId);
    const preparedGraphic = graphicById(prepared, objectId);
    const preparedPoints = nativeGraphicPathEditPoints(preparedGraphic);

    expect(preparedGraphic.rotation).toBe(0);
    expect(preparedGraphic.data.artPathKind).toBe("line");
    expectPointToBeClose(preparedGraphic.data.lineStart, projectedStart);
    expectPointToBeClose(preparedGraphic.data.lineEnd, projectedEnd);
    expect(preparedGraphic.data.pathControlPoint).toBeUndefined();
    expectPointToBeClose(preparedPoints?.start, projectedStart);
    expectPointToBeClose(preparedPoints?.end, projectedEnd);
  });

  it("prepares rotated quadratic and legacy quadratic graphics as unrotated explicit curves", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Prepare Rotated Quadratic"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 10, y: points.middle.y - 34 }
    );
    const legacy = applyPatch(bent, {
      op: "updateObject",
      objectId,
      changes: {
        rotation: 32,
        data: {
          ...graphicById(bent, objectId).data,
          artPathKind: "arc"
        }
      }
    });
    const rotatedGraphic = graphicById(legacy, objectId);
    const rotatedPoints = nativeGraphicPathEditPoints(rotatedGraphic);
    if (!rotatedPoints) {
      throw new Error("Expected rotated quadratic edit points.");
    }
    const projectedStart = projectGraphicVisualPoint(rotatedGraphic, rotatedPoints.start);
    const projectedMiddle = projectGraphicVisualPoint(rotatedGraphic, rotatedPoints.middle);
    const projectedEnd = projectGraphicVisualPoint(rotatedGraphic, rotatedPoints.end);

    const prepared = prepareGraphicPathForDirectEdit(legacy, objectId);
    const preparedGraphic = graphicById(prepared, objectId);
    const preparedPoints = nativeGraphicPathEditPoints(preparedGraphic);

    expect(preparedGraphic.rotation).toBe(0);
    expect(preparedGraphic.data.artPathKind).toBe("quadratic");
    expectPointToBeClose(preparedGraphic.data.lineStart, projectedStart);
    expectPointToBeClose(preparedGraphic.data.pathControlPoint, projectedMiddle);
    expectPointToBeClose(preparedGraphic.data.lineEnd, projectedEnd);
    expect(preparedGraphic.data.arcCenter).toBeUndefined();
    expectPointToBeClose(preparedPoints?.start, projectedStart);
    expectPointToBeClose(preparedPoints?.middle, projectedMiddle);
    expectPointToBeClose(preparedPoints?.end, projectedEnd);
  });

  it("edits circular art arcs by changing radian sweep around the same ellipse", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Circular Arc Edit"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arc art object to be selected.");
    }

    const originalGraphic = graphicById(inserted, objectId);
    const originalPoints = nativeGraphicPathEditPoints(originalGraphic);
    if (!originalPoints) {
      throw new Error("Expected arc art object to expose path edit points.");
    }

    const completed = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "end",
      originalPoints.start
    );
    const completedGraphic = graphicById(completed, objectId);
    const originalCenter = {
      x: originalGraphic.x + originalGraphic.width / 2,
      y: originalGraphic.y + originalGraphic.height / 2
    };

    expect(completedGraphic.data.artPathKind).toBe("arc");
    expect(completedGraphic.data.arcCenter).toEqual(originalCenter);
    expect(completedGraphic.data.arcRadiusX).toBeCloseTo(originalGraphic.width / 2 - 4, 6);
    expect(completedGraphic.data.arcRadiusY).toBeCloseTo(originalGraphic.height / 2 - 4, 6);
    expect(completedGraphic.data.arcStartRadians).toBeCloseTo(degToRad(-225), 6);
    expect(completedGraphic.data.arcSweepRadians).toBeGreaterThan(degToRad(358));
    expect(completedGraphic.data.lineStart).toBeUndefined();
    expect(completedGraphic.data.lineEnd).toBeUndefined();
    expect(completedGraphic.data.pathControlPoint).toBeUndefined();
    expect(completed.selection.objectIds).toEqual([objectId]);
  });

  it("rotates circular art arcs with the middle path handle instead of bending them", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Circular Arc Rotate"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arc art object to be selected.");
    }

    const originalGraphic = graphicById(inserted, objectId);
    const rotated = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      pointOnGraphicEllipse(originalGraphic, 0)
    );
    const rotatedGraphic = graphicById(rotated, objectId);
    const rotatedPoints = nativeGraphicPathEditPoints(rotatedGraphic);
    if (!rotatedPoints) {
      throw new Error("Expected rotated arc art object to expose path edit points.");
    }

    expect(rotatedGraphic.data.artPathKind).toBe("arc");
    expect(rotatedGraphic.data.arcStartRadians).toBeCloseTo(degToRad(-135), 6);
    expect(rotatedGraphic.data.arcSweepRadians).toBeCloseTo(degToRad(270), 6);
    expect(rotatedGraphic.data.pathControlPoint).toBeUndefined();
    expect(rotatedPoints.middle.x).toBeCloseTo(pointOnGraphicEllipse(originalGraphic, 0).x, 3);
    expect(rotatedPoints.middle.y).toBeCloseTo(pointOnGraphicEllipse(originalGraphic, 0).y, 3);
  });

  it("keeps a rectangular circular arc middle handle attached through document workflow edits", () => {
    const baseDocument = createPhase4Document("Native Rectangular Circular Arc Attachment");
    const page = baseDocument.pages[0];
    if (!page) {
      throw new Error("Expected a page.");
    }
    const arcSweepRadians = Math.PI * 1.36;
    const graphic: GraphicObject = {
      type: "graphic",
      id: "rectangular_arc",
      x: 180,
      y: 160,
      width: 96,
      height: 54,
      rotation: 0,
      graphicKind: "path",
      style: {
        strokeColor: "#111111",
        fillColor: "none",
        strokeWidth: 3
      },
      data: {
        artPathKind: "arc",
        arcStartRadians: Math.PI * 0.18,
        arcSweepRadians
      }
    };
    const document = applyPatches(baseDocument, [
      { op: "addObject", pageId: page.id, object: graphic },
      { op: "setSelection", pageId: page.id, objectIds: [graphic.id] }
    ]);
    const originalPoints = nativeGraphicPathEditPoints(graphic);
    if (!originalPoints) {
      throw new Error("Expected rectangular arc edit points.");
    }
    const target = {
      x: originalPoints.middle.x + 31,
      y: originalPoints.middle.y - 17
    };

    const edited = updateNativeGraphicPathHandle(document, graphic.id, "middle", target);
    const editedPoints = nativeGraphicPathEditPoints(graphicById(edited, graphic.id));

    expect(editedPoints?.middle.x).toBeCloseTo(target.x, 3);
    expect(editedPoints?.middle.y).toBeCloseTo(target.y, 3);
    expect(graphicById(edited, graphic.id).data.arcSweepRadians).toBeCloseTo(arcSweepRadians, 6);
  });

  it("expands circular art arc radius from the middle handle and preserves edits through history and reopen", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Native Circular Arc Radius"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arc art object to be selected.");
    }

    const originalGraphic = graphicById(inserted, objectId);
    const originalPoints = nativeGraphicPathEditPoints(originalGraphic);
    if (!originalPoints) {
      throw new Error("Expected arc art object to expose path edit points.");
    }
    const center = {
      x: originalGraphic.x + originalGraphic.width / 2,
      y: originalGraphic.y + originalGraphic.height / 2
    };
    const dx = originalPoints.middle.x - center.x;
    const dy = originalPoints.middle.y - center.y;
    const length = Math.max(Math.hypot(dx, dy), 1);
    const outwardMiddle = {
      x: center.x + dx / length * (length + 26),
      y: center.y + dy / length * (length + 26)
    };

    const expanded = updateNativeGraphicPathHandle(inserted, objectId, "middle", outwardMiddle);
    const expandedGraphic = graphicById(expanded, objectId);

    expect(expandedGraphic.width).toBeGreaterThan(originalGraphic.width);
    expect(expandedGraphic.height).toBeGreaterThan(originalGraphic.height);
    expect(expandedGraphic.data.arcCenter).toEqual(center);
    expect(expandedGraphic.data.arcRadiusX).toBeCloseTo(length + 26, 3);
    expect(expandedGraphic.data.arcRadiusY).toBeCloseTo(length + 26, 3);
    expect(expandedGraphic.data.arcSweepRadians).toBeCloseTo(degToRad(270), 6);
    expect(expandedGraphic.data.pathControlPoint).toBeUndefined();

    const radiusHistory = {
      past: [inserted],
      present: expanded,
      future: []
    };
    expect(graphicById(undo(radiusHistory).present, objectId).width).toBeCloseTo(originalGraphic.width, 3);
    expect(graphicById(redo(undo(radiusHistory)).present, objectId).width).toBeCloseTo(expandedGraphic.width, 3);

    const reopened = openNativeDocument(createNativeSavePayload(expanded).contents);
    expect(graphicById(reopened.document ?? inserted, objectId)).toEqual(expandedGraphic);

    const transformed = applyDocumentObjectProjectedPlaneTilt(
      rotateDocumentObject(expanded, objectId, 24),
      objectId,
      18,
      -12
    );
    const transformedGraphic = graphicById(transformed, objectId);
    const transformedPoints = nativeGraphicPathEditPoints(transformedGraphic);
    if (!transformedPoints) {
      throw new Error("Expected transformed arc art object to remain editable.");
    }
    const transformedCenter = transformedGraphic.data.arcCenter ?? {
      x: transformedGraphic.x + transformedGraphic.width / 2,
      y: transformedGraphic.y + transformedGraphic.height / 2
    };
    const transformedDx = transformedPoints.middle.x - transformedCenter.x;
    const transformedDy = transformedPoints.middle.y - transformedCenter.y;
    const transformedLength = Math.max(Math.hypot(transformedDx, transformedDy), 1);
    const transformedOutwardMiddle = {
      x: transformedCenter.x + transformedDx / transformedLength * (transformedLength + 16),
      y: transformedCenter.y + transformedDy / transformedLength * (transformedLength + 16)
    };
    const editedAfterTransform = updateNativeGraphicPathHandle(
      transformed,
      objectId,
      "middle",
      transformedOutwardMiddle
    );

    expect(graphicById(editedAfterTransform, objectId).width).toBeGreaterThan(transformedGraphic.width);
    expect(nativeGraphicPathEditPoints(graphicById(editedAfterTransform, objectId))).toBeDefined();
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

  it("serializes and pastes ChemDraft selections with fresh object and group ids", () => {
    const withMolecule = insertNativeSingleBondMolecule(
      createPhase4Document("ChemDraft Selection Clipboard"),
      { x: 240, y: 220 }
    );
    const molecule = selectedMolecule(withMolecule);
    const withGraphic = insertNativeArtGraphicObject(withMolecule, { x: 360, y: 240 }, "tool.art.rect");
    const graphicId = withGraphic.selection.objectIds[0];
    if (!graphicId) {
      throw new Error("Expected inserted art object to be selected.");
    }
    const selected = applyPatch(withGraphic, {
      op: "setSelection",
      pageId: withGraphic.pages[0].id,
      objectIds: [molecule.id, graphicId]
    });
    const grouped = groupSelectedDocumentObjects(selected);
    const group = grouped.pages[0].objects.find((object): object is GroupObject =>
      object.type === "group" && grouped.selection.objectIds.includes(object.id)
    );
    if (!group) {
      throw new Error("Expected copied selection to be grouped.");
    }

    const payload = createSelectionClipboardPayload(grouped);
    if (!payload) {
      throw new Error("Expected selection clipboard payload.");
    }
    const parsed = parseSelectionClipboardPayload(serializeSelectionClipboardPayload(payload));
    if (!parsed) {
      throw new Error("Expected serialized selection payload to parse.");
    }

    const pasted = pasteSelectionClipboardPayload(grouped, parsed, { x: 560, y: 520 });
    const pastedGroupId = pasted.selection.objectIds[0];
    const pastedGroup = pasted.pages[0].objects.find((object): object is GroupObject =>
      object.type === "group" && object.id === pastedGroupId
    );
    expect(pastedGroup).toBeDefined();
    expect(pastedGroup?.id).not.toBe(group.id);
    expect(pastedGroup?.childObjectIds).toHaveLength(2);
    expect(pastedGroup?.childObjectIds).not.toEqual(group.childObjectIds);
    expect(pasted.pages[0].objects.filter((object) => object.type === "molecule")).toHaveLength(2);
    expect(pasted.pages[0].objects.filter((object) => object.type === "graphic")).toHaveLength(2);
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

  it("deletes selected native molecule parts as one fragment", () => {
    const butane = growFromAtom(
      growFromAtom(
        insertNativeSingleBondMolecule(createPhase4Document("Delete Fragment"), { x: 220, y: 260 }),
        "atom_002",
        -60
      ),
      "atom_003",
      0
    );
    const molecule = selectedMolecule(butane);
    const deleted = applyNativeMoleculePartDeleteTarget(butane, {
      objectId: molecule.id,
      kind: "parts",
      atomIds: ["atom_003", "atom_004"],
      bondIds: ["bond_003"]
    });
    const nextMolecule = selectedMolecule(deleted);

    expect(nextMolecule.atoms.map((atom) => atom.id)).toEqual(["atom_001", "atom_002"]);
    expect(nextMolecule.bonds.map((bond) => bond.id)).toEqual(["bond_001"]);
    expect(nextMolecule.structure).toBe("CC");
    expect(nextMolecule.chemistry).toMatchObject({ formula: "C2H6", atomCount: 2, bondCount: 1 });
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

  it("deletes a lassoed fragment (atoms plus their incident bonds) and rebuilds the remaining graph", () => {
    const hexane = growHexaneChain(
      insertNativeSingleBondMolecule(createPhase4Document("Parts Delete Fragment"), { x: 240, y: 320 })
    );
    const trimmed = applyNativeMoleculePartsDelete(hexane, {
      objectId: selectedMolecule(hexane).id,
      atomIds: ["atom_004", "atom_005", "atom_006"],
      bondIds: []
    });
    const molecule = selectedMolecule(trimmed);

    expect(selectedMolecule(hexane).atoms).toHaveLength(6);
    expect(molecule.atoms.map((atom) => atom.id)).toEqual(["atom_001", "atom_002", "atom_003"]);
    expect(molecule.bonds).toHaveLength(2);
    expect(molecule.structure).toBe("CCC");
    expect(molecule.chemistry).toMatchObject({ atomCount: 3, bondCount: 2 });
  });

  it("removes the molecule object when a parts delete clears every atom", () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Parts Delete Empty"), { x: 220, y: 260 });
    const empty = applyNativeMoleculePartsDelete(ethane, {
      objectId: selectedMolecule(ethane).id,
      atomIds: ["atom_001", "atom_002"],
      bondIds: []
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

  it("fuses benzene onto an exposed terminal worm bond instead of closing inward as a no-op", () => {
    let document = insertNativeTemplateMolecule(createPhase4Document("Benzene Worm"), { x: 400, y: 360 }, "benzene");
    const first = selectedMolecule(document);
    document = applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(first, "bond_001"),
      moleculeBondMidpoint(first, "bond_001"),
      "benzene"
    );
    for (let index = 0; index < 3; index += 1) {
      const molecule = selectedMolecule(document);
      const bondId = rightmostSixMemberRingPerimeterBondId(molecule);
      document = applyNativeTemplateToolAtTarget(document, moleculeBondTarget(molecule, bondId), moleculeBondMidpoint(molecule, bondId), "benzene");
    }

    const molecule = selectedMolecule(document);
    const targetBondId = "bond_022";
    const targetBond = moleculeBond(molecule, targetBondId);
    expect(atomDegree(molecule, targetBond.fromAtomId)).toBe(3);
    expect(atomDegree(molecule, targetBond.toAtomId)).toBe(2);

    const plan = planNativeTemplatePlacement(
      document,
      { point: moleculeBondMidpoint(molecule, targetBondId), target: moleculeBondTarget(molecule, targetBondId) },
      "benzene"
    );
    expect(plan?.kind).toBe("fused-closure");
    expect(plan?.addedAtomIds).toHaveLength(3);
    expect(plan?.addedBondIds.length).toBeGreaterThan(0);
    expect(nativeMoleculeInvalidAtomStates(plan!.molecule)).toEqual([]);

    const extended = selectedMolecule(applyNativeTemplatePlacementPlan(document, plan!));
    expect(extended.atoms.length).toBe(molecule.atoms.length + 3);
    expect(extended.bonds.length).toBeGreaterThan(molecule.bonds.length);
    expectNoDuplicateAtomPositions(extended);
  });

  it("grows benzene from a legal bay bond even when the first side candidate is degenerate", () => {
    const bondLength = nativeBondLengthPx;
    const origin = { x: 360, y: 320 };
    const targetFrom = { id: "atom_001", element: "C", x: origin.x, y: origin.y, formalCharge: 0 };
    const targetTo = { id: "atom_002", element: "C", x: origin.x + bondLength, y: origin.y, formalCharge: 0 };
    const degenerateClosure = {
      id: "atom_003",
      element: "C",
      x: origin.x + bondLength * 1.5,
      y: origin.y - bondLength * Math.sqrt(3) / 2,
      formalCharge: 0
    };
    const crowdedScaffold = [
      { id: "atom_004", element: "C", x: origin.x + bondLength * 1.5, y: origin.y + bondLength * 4, formalCharge: 0 },
      { id: "atom_005", element: "C", x: origin.x + bondLength * 2.5, y: origin.y + bondLength * 4.25, formalCharge: 0 },
      { id: "atom_006", element: "C", x: origin.x + bondLength * 0.5, y: origin.y + bondLength * 4.5, formalCharge: 0 }
    ];
    const molecule = {
      id: "mol_bay",
      type: "molecule",
      x: origin.x,
      y: origin.y,
      width: bondLength * 3,
      height: bondLength * 5,
      rotation: 0,
      style: {},
      structureFormat: "smiles",
      structure: "C",
      atoms: [targetFrom, targetTo, degenerateClosure, ...crowdedScaffold],
      bonds: [
        { id: "bond_target", fromAtomId: targetFrom.id, toAtomId: targetTo.id, order: "single" },
        { id: "bond_scaffold_1", fromAtomId: degenerateClosure.id, toAtomId: "atom_004", order: "single" },
        { id: "bond_scaffold_2", fromAtomId: degenerateClosure.id, toAtomId: "atom_005", order: "single" },
        { id: "bond_scaffold_3", fromAtomId: degenerateClosure.id, toAtomId: "atom_006", order: "single" }
      ],
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const base = createPhase4Document("Bay Bond Benzene Growth");
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule },
      { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
    ]);

    const plan = planNativeTemplatePlacement(
      document,
      { point: moleculeBondMidpoint(molecule, "bond_target"), target: moleculeBondTarget(molecule, "bond_target") },
      "benzene"
    );

    expect(plan?.kind).toBe("fuse-bond");
    expect(plan?.addedAtomIds).toHaveLength(4);
    expect(plan?.addedBondIds.length).toBeGreaterThan(0);
    expect(nativeMoleculeInvalidAtomStates(plan!.molecule)).toEqual([]);
    const addedAtoms = plan!.molecule.atoms.filter((atom) => plan!.addedAtomIds.includes(atom.id));
    const addedCentroidY = addedAtoms.reduce((sum, atom) => sum + atom.y, 0) / addedAtoms.length;
    expect(addedCentroidY).toBeGreaterThan(origin.y);
  });

  it("plans a standalone ring (no target) and applies it identically to direct insertion", () => {
    const document = createPhase4Document("Plan Standalone");
    const point = { x: 260, y: 260 };
    const plan = planNativeTemplatePlacement(document, { point }, "benzene");

    expect(plan?.kind).toBe("standalone");
    expect(plan?.objectId).toBeUndefined();
    expect(plan?.addedAtomIds).toHaveLength(6);
    expect(plan?.addedBondIds).toHaveLength(6);
    // The plan's standalone apply must match the pre-refactor insertion path exactly.
    expect(applyNativeTemplatePlacementPlan(document, plan!)).toEqual(
      insertNativeTemplateMolecule(document, point, "benzene")
    );
  });

  it("plans a bond fusion and commits exactly the previewed graph (preview == commit)", () => {
    const document = insertNativeTemplateMolecule(createPhase4Document("Plan Fuse"), { x: 360, y: 320 }, "benzene");
    const benzene = selectedMolecule(document);
    const target = moleculeBondTarget(benzene, "bond_001");
    const point = moleculeBondMidpoint(benzene, "bond_001");
    const plan = planNativeTemplatePlacement(document, { point, target }, "benzene");

    expect(plan?.kind).toBe("fuse-bond");
    expect(plan?.objectId).toBe(benzene.id);
    expect(plan?.addedAtomIds).toHaveLength(4); // benzene -> naphthalene adds four atoms
    // The committed molecule must equal the plan's molecule — the preview/commit invariant.
    const committed = selectedMolecule(applyNativeTemplatePlacementPlan(document, plan!));
    expect(committed.atoms).toEqual(plan!.molecule.atoms);
    expect(committed.bonds).toEqual(plan!.molecule.bonds);
    // And the wrapper tool path is unchanged by the refactor.
    expect(applyNativeTemplateToolAtTarget(document, target, point, "benzene"))
      .toEqual(applyNativeTemplatePlacementPlan(document, plan!));
  });

  it("plans an atom attachment (spiro) for an atom target", () => {
    const document = insertNativeTemplateMolecule(createPhase4Document("Plan Attach"), { x: 360, y: 320 }, "cyclohexane");
    const ring = selectedMolecule(document);
    const target = moleculeAtomTarget(ring, "atom_001");
    const plan = planNativeTemplatePlacement(document, { point: moleculeAtom(ring, "atom_001"), target }, "cyclohexane");

    expect(plan?.kind).toBe("attach-atom");
    expect(plan?.objectId).toBe(ring.id);
    expect(plan?.addedAtomIds).toHaveLength(5); // cyclohexane spiro shares one atom, adds five
  });

  it("returns no plan when an empty-canvas standalone tool path produces nothing new", () => {
    // Sanity: the standalone path always yields a plan, and the wrapper matches it.
    const document = createPhase4Document("Plan Wrapper");
    const point = { x: 300, y: 300 };
    expect(applyNativeTemplateToolAtPoint(document, point, "cyclopentane")).toEqual(
      applyNativeTemplatePlacementPlan(
        document,
        planNativeTemplatePlacement(document, { point }, "cyclopentane")!
      )
    );
  });

  it("marks an aromatic spiro placement invalid but a saturated spiro valid (ghost warn rule)", () => {
    const benzeneDocument = insertNativeTemplateMolecule(createPhase4Document("Spiro Benzene"), { x: 360, y: 320 }, "benzene");
    const benzene = selectedMolecule(benzeneDocument);
    const benzeneSpiro = planNativeTemplatePlacement(
      benzeneDocument,
      { point: moleculeAtom(benzene, "atom_001"), target: moleculeAtomTarget(benzene, "atom_001") },
      "benzene"
    );
    expect(benzeneSpiro?.kind).toBe("attach-atom");
    // The shared carbon ends up in two aromatic rings — over-valent — so the ghost must warn.
    expect(nativeMoleculeInvalidAtomStates(benzeneSpiro!.molecule).length).toBeGreaterThan(0);

    const cyclohexaneDocument = insertNativeTemplateMolecule(createPhase4Document("Spiro Cyclohexane"), { x: 360, y: 320 }, "cyclohexane");
    const cyclohexane = selectedMolecule(cyclohexaneDocument);
    const cyclohexaneSpiro = planNativeTemplatePlacement(
      cyclohexaneDocument,
      { point: moleculeAtom(cyclohexane, "atom_001"), target: moleculeAtomTarget(cyclohexane, "atom_001") },
      "cyclohexane"
    );
    expect(cyclohexaneSpiro?.kind).toBe("attach-atom");
    // A degree-4 sp3 spiro carbon is perfectly valid — the ghost must stay neutral.
    expect(nativeMoleculeInvalidAtomStates(cyclohexaneSpiro!.molecule)).toEqual([]);
  });

  it("fuses a ring outward even when the click lands inside the existing ring", () => {
    // Regression: clicking a hair inside the ring used to let the small click-side term flip
    // the new ring onto the SAME side as the existing one, dropping a second benzene on top
    // of the first (coincident atoms). Crowding must win so the fusion always goes outward.
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Inside-Click Fusion"),
      { x: 360, y: 320 },
      "benzene"
    );
    const benzene = selectedMolecule(document);
    const centroid = {
      x: benzene.atoms.reduce((sum, atom) => sum + atom.x, 0) / benzene.atoms.length,
      y: benzene.atoms.reduce((sum, atom) => sum + atom.y, 0) / benzene.atoms.length
    };
    const midpoint = moleculeBondMidpoint(benzene, "bond_001");
    // A click pushed from the shared bond toward the ring centre — i.e. "inside" the ring.
    const insideClick = {
      x: midpoint.x + (centroid.x - midpoint.x) * 0.4,
      y: midpoint.y + (centroid.y - midpoint.y) * 0.4
    };

    const naphthalene = selectedMolecule(applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(benzene, "bond_001"),
      insideClick,
      "benzene"
    ));

    expect(naphthalene.atoms).toHaveLength(10);
    expect(naphthalene.bonds).toHaveLength(11);
    expect(naphthalene.chemistry).toMatchObject({ formula: "C10H8", atomCount: 10, bondCount: 11 });
    // The decisive assertion: no new atom landed on top of an existing one (no overlap).
    expectNoDuplicateAtomPositions(naphthalene);
    // And the new ring sits on the far side of the shared bond from the original centre.
    const newRingAtoms = naphthalene.atoms.filter((atom) =>
      !benzene.atoms.some((original) => original.id === atom.id)
    );
    const newCentroidY = newRingAtoms.reduce((sum, atom) => sum + atom.y, 0) / newRingAtoms.length;
    expect(Math.sign(newCentroidY - midpoint.y)).toBe(Math.sign(midpoint.y - centroid.y));
  });

  it("fuses to the clicked side of an isolated bond, where crowding can't break the tie", () => {
    // A lone bond has no other atoms, so the crowding signal is 0 and the click side is the ONLY
    // thing nativeTemplateSideForBond can use — its fallback branch. Each perpendicular click must
    // drop the new ring on its own side (the branch the outward-fusion test never reaches).
    const document = insertNativeSingleBondMolecule(createPhase4Document("Lone Bond Side"), { x: 220, y: 240 });
    const molecule = selectedMolecule(document);
    const bond = molecule.bonds[0];
    const from = moleculeAtom(molecule, bond.fromAtomId);
    const to = moleculeAtom(molecule, bond.toAtomId);
    const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };

    // Signed distance of the new ring's centroid along the click normal, for a click `sign` * 8px
    // off the midpoint on that normal.
    const newRingOffsetForClick = (sign: 1 | -1): number => {
      const click = { x: midpoint.x + normal.x * 8 * sign, y: midpoint.y + normal.y * 8 * sign };
      const fused = selectedMolecule(
        applyNativeTemplateToolAtTarget(document, moleculeBondTarget(molecule, bond.id), click, "benzene")
      );
      const newAtoms = fused.atoms.filter((atom) => !molecule.atoms.some((original) => original.id === atom.id));
      const centroid = {
        x: newAtoms.reduce((sum, atom) => sum + atom.x, 0) / newAtoms.length,
        y: newAtoms.reduce((sum, atom) => sum + atom.y, 0) / newAtoms.length
      };
      return (centroid.x - midpoint.x) * normal.x + (centroid.y - midpoint.y) * normal.y;
    };

    expect(Math.sign(newRingOffsetForClick(1))).toBe(1);
    expect(Math.sign(newRingOffsetForClick(-1))).toBe(-1);
  });

  it("closes a fused ring onto an existing rim atom instead of duplicating it", () => {
    let document = insertNativeTemplateMolecule(createPhase4Document("Closure Snap"), { x: 400, y: 360 }, "benzene");
    const central = selectedMolecule(document);

    // First outer ring on a central bond — open space, so nothing snaps (plain naphthalene).
    document = applyNativeTemplateToolAtTarget(
      document,
      moleculeBondTarget(central, "bond_001"),
      moleculeBondMidpoint(central, "bond_001"),
      "benzene"
    );
    const afterFirst = selectedMolecule(document);
    expect(afterFirst.atoms).toHaveLength(10);

    // Second outer ring on the ADJACENT central bond. One of its proposed vertices lands on the
    // first outer ring's rim atom, so closure must reuse it: 6 + 4 + 3 = 13 atoms, not 14.
    const plan = planNativeTemplatePlacement(
      document,
      { point: moleculeBondMidpoint(afterFirst, "bond_002"), target: moleculeBondTarget(afterFirst, "bond_002") },
      "benzene"
    );
    expect(plan?.kind).toBe("fused-closure");
    expect(plan?.addedAtomIds).toHaveLength(3);

    const closed = selectedMolecule(applyNativeTemplatePlacementPlan(document, plan!));
    expect(closed.atoms).toHaveLength(13);
    expectNoDuplicateAtomPositions(closed);
    // The reused rim atom now belongs to both outer rings (degree 3), never duplicated.
    closed.atoms.forEach((atom) => expect(atomDegree(closed, atom.id)).toBeLessThanOrEqual(3));
  });

  it("builds coronene by fusing six benzene rings around a central ring", () => {
    let document = insertNativeTemplateMolecule(createPhase4Document("Coronene"), { x: 400, y: 360 }, "benzene");

    for (let bondIndex = 1; bondIndex <= 6; bondIndex += 1) {
      const central = selectedMolecule(document);
      const bondId = `bond_00${bondIndex}`;
      document = applyNativeTemplateToolAtTarget(
        document,
        moleculeBondTarget(central, bondId),
        moleculeBondMidpoint(central, bondId),
        "benzene"
      );
    }

    const coronene = selectedMolecule(document);
    expect(document.pages[0].objects.filter((object) => object.type === "molecule")).toHaveLength(1);
    // Naive (non-merging) fusion would leave 6 + 6*4 = 30 atoms with six duplicated rim pairs;
    // closure reuses the rim atoms to give coronene's 24 carbons.
    expect(coronene.atoms).toHaveLength(24);
    expectNoDuplicateAtomPositions(coronene);
    coronene.atoms.forEach((atom) => expect(atomDegree(coronene, atom.id)).toBeLessThanOrEqual(3));

    // Every carbon must carry exactly one double bond — a valid Kekulé structure / full
    // aromaticity. The inner six carbons used to be left with none (they read as sp3) because
    // their bonds are all ring-shared; closure must still hand the inner ring its double bonds.
    const doubleBondCountByAtom = new Map<string, number>();
    coronene.bonds
      .filter((bond) => bond.order === "double")
      .forEach((bond) => {
        doubleBondCountByAtom.set(bond.fromAtomId, (doubleBondCountByAtom.get(bond.fromAtomId) ?? 0) + 1);
        doubleBondCountByAtom.set(bond.toAtomId, (doubleBondCountByAtom.get(bond.toAtomId) ?? 0) + 1);
      });
    coronene.atoms.forEach((atom) => {
      expect(doubleBondCountByAtom.get(atom.id) ?? 0, `atom ${atom.id} double-bond count`).toBe(1);
    });
    // Coronene's Kekulé needs exactly 12 double bonds across 24 carbons.
    expect(coronene.bonds.filter((bond) => bond.order === "double")).toHaveLength(12);
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
        const beforeCleanup = molecule;
        document = cleanUpSelectedNativeMolecule2d(document);
        molecule = selectedMolecule(document);
        // Every stress case fuses at least one extra ring, so these are all multi-ring systems —
        // the 2D pass deliberately preserves them as drawn (its polygon+tree layout would shear
        // them; the old length-relaxer did exactly that). Geometry must carry through unchanged;
        // the engine-backed 3D Cleanup is the full re-layout for these shapes.
        molecule.bonds.forEach((bond) => {
          expect(moleculeBondLength(molecule, bond.id), `stress case ${index + 1} bond ${bond.id}`).toBeCloseTo(
            moleculeBondLength(beforeCleanup, bond.id),
            2
          );
        });
      }

      expectUsableNativeMoleculeGraph(molecule, `stress case ${index + 1}`, {
        minimumAtomDistancePx: 0.5
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

  it("exports the Phase 4 subset as a CDXML compatibility text result", () => {
    const document = insertAdapterFallbackMolecule(createPhase4Document("CDXML Fixture"));
    const result = exportPhase4Cdxml(document);

    expect(result.format).toBe("cdxml");
    expect(result.kind).toBe("text");
    expect(result.extension).toBe("cdxml");
    expect(result.mimeType).toBe("chemical/x-cdxml");
    expect(result.contents).toContain("<CDXML");
    expect(result.contents).toContain('CreationProgram="ChemDraft"');
    expect(result.contents).toContain('Name="org.chemdraft/native-document"');
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
    expect(result.contents.match(/data-bond-id="/g)?.length).toBe(2);
    expect(result.contents.match(/stroke="#ffffff"/g)?.length ?? 0).toBe(0);
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

describe("group transforms (multi-object selection)", () => {
  const moleculeAtomTotal = (document: ChemDraftDocument) =>
    document.pages[0].objects.reduce(
      (total, object) => total + (object.type === "molecule" ? object.atoms.length : 0),
      0
    );

  const twoMolecules = () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Group"), { x: 200, y: 200 });
    const document = insertNativeSingleBondMolecule(first, { x: 360, y: 320 });
    const [m1, m2] = document.pages[0].objects;
    return { document, ids: [m1.id, m2.id], m1, m2 };
  };

  it("computes the union bounding box and center of the selection", () => {
    const { document, ids, m1, m2 } = twoMolecules();
    const bounds = selectionBounds(document.pages[0].objects, ids);
    expect(bounds).toBeDefined();
    expect(bounds!.x).toBeCloseTo(Math.min(m1.x, m2.x));
    expect(bounds!.y).toBeCloseTo(Math.min(m1.y, m2.y));
    expect(bounds!.x + bounds!.width).toBeCloseTo(Math.max(m1.x + m1.width, m2.x + m2.width));
    expect(bounds!.centerX).toBeCloseTo(bounds!.x + bounds!.width / 2);
    expect(bounds!.centerY).toBeCloseTo(bounds!.y + bounds!.height / 2);
  });

  it("moves the whole selection by one delta, preserving relative offsets and identity", () => {
    const { document, ids, m1, m2 } = twoMolecules();
    const atomsBefore = moleculeAtomTotal(document);
    const moved = moveDocumentObjects(document, ids, 40, -25);
    const n1 = moved.pages[0].objects.find((object) => object.id === m1.id)!;
    const n2 = moved.pages[0].objects.find((object) => object.id === m2.id)!;
    expect(n1.x - m1.x).toBeCloseTo(40);
    expect(n1.y - m1.y).toBeCloseTo(-25);
    expect(n2.x - m2.x).toBeCloseTo(40);
    expect(n2.y - m2.y).toBeCloseTo(-25);
    expect(n2.x - n1.x).toBeCloseTo(m2.x - m1.x); // relative layout unchanged
    expect(moleculeAtomTotal(moved)).toBe(atomsBefore);
  });

  it("creates invisible group metadata and resolves it to child objects", () => {
    const { document, ids } = twoMolecules();
    const selected = applyPatches(document, [
      { op: "setSelection", pageId: document.pages[0].id, objectIds: ids }
    ]);
    const beforeBounds = selectionBounds(selected.pages[0].objects, ids);
    if (!beforeBounds) {
      throw new Error("Expected selected group bounds.");
    }

    const grouped = groupSelectedDocumentObjects(selected);
    const group = grouped.pages[0].objects.find((object): object is GroupObject => object.type === "group");

    expect(group).toBeDefined();
    expect(group?.childObjectIds).toEqual(ids);
    expect(grouped.selection.objectIds).toEqual([group?.id]);
    expect(selectedGroupObjectIds(grouped)).toEqual([group?.id]);
    expect(resolveGroupedDocumentObjectIds(grouped.pages[0].objects, grouped.selection.objectIds)).toEqual(ids);
    expect(selectionBounds(grouped.pages[0].objects, grouped.selection.objectIds)).toEqual(beforeBounds);
  });

  it("promotes grouped child selection gestures back to the group id", () => {
    const { document, ids } = twoMolecules();
    const pageId = document.pages[0].id;
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [
      { op: "setSelection", pageId, objectIds: ids }
    ]));
    const groupId = selectedGroupObjectIds(grouped)[0];
    if (!groupId) {
      throw new Error("Expected selected group.");
    }

    expect(selectDocumentObject(grouped, ids[0]).selection.objectIds).toEqual([groupId]);
    expect(selectDocumentObjects(grouped, pageId, ids).selection.objectIds).toEqual([groupId]);

    const emptySelection = selectDocumentObjects(grouped, pageId, []);
    expect(toggleDocumentObjectSelection(emptySelection, pageId, ids[0]).selection.objectIds).toEqual([groupId]);
    expect(toggleDocumentObjectSelection(grouped, pageId, ids[0]).selection.objectIds).toEqual([]);

    const directChildSelection = selectDocumentObjectWithinGroup(grouped, ids[0]);
    expect(directChildSelection.selection.objectIds).toEqual([ids[0]]);

    const movedChild = moveDocumentObjects(directChildSelection, directChildSelection.selection.objectIds, 30, 0);
    const movedFirst = movedChild.pages[0].objects.find((object) => object.id === ids[0]);
    const movedSecond = movedChild.pages[0].objects.find((object) => object.id === ids[1]);
    const originalFirst = grouped.pages[0].objects.find((object) => object.id === ids[0]);
    const originalSecond = grouped.pages[0].objects.find((object) => object.id === ids[1]);
    if (!movedFirst || !movedSecond || !originalFirst || !originalSecond) {
      throw new Error("Expected grouped child fixtures.");
    }
    expect(movedFirst.x - originalFirst.x).toBeCloseTo(30);
    expect(movedSecond.x).toBeCloseTo(originalSecond.x);
    expect(selectedGroupObjectIds(movedChild)).toEqual([]);
    expect(movedChild.pages[0].objects.find((object) => object.id === groupId)).toBeDefined();

    const cleared = selectDocumentObjects(movedChild, pageId, []);
    expect(selectDocumentObject(cleared, ids[0]).selection.objectIds).toEqual([groupId]);
  });

  it("moves and rotates selected group children through the group id", () => {
    const { document, ids, m1, m2 } = twoMolecules();
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [
      { op: "setSelection", pageId: document.pages[0].id, objectIds: ids }
    ]));
    const groupId = selectedGroupObjectIds(grouped)[0];
    if (!groupId) {
      throw new Error("Expected selected group.");
    }

    const moved = moveDocumentObjects(grouped, grouped.selection.objectIds, 40, -25);
    const movedFirst = moved.pages[0].objects.find((object) => object.id === m1.id)!;
    const movedSecond = moved.pages[0].objects.find((object) => object.id === m2.id)!;
    expect(moved.selection.objectIds).toEqual([groupId]);
    expect(movedFirst.x - m1.x).toBeCloseTo(40);
    expect(movedSecond.y - m2.y).toBeCloseTo(-25);

    const beforeRotateBounds = selectionBounds(grouped.pages[0].objects, grouped.selection.objectIds);
    if (!beforeRotateBounds) {
      throw new Error("Expected grouped selection bounds.");
    }
    const expectedRotated = rotateDocumentObjectsAroundPoint(
      grouped,
      ids,
      { x: beforeRotateBounds.centerX, y: beforeRotateBounds.centerY },
      90
    );
    const rotated = rotateSelectedDocumentObjects90(grouped);
    const expectedFirst = expectedRotated.pages[0].objects.find((object) => object.id === m1.id)!;
    const expectedSecond = expectedRotated.pages[0].objects.find((object) => object.id === m2.id)!;
    const rotatedFirst = rotated.pages[0].objects.find((object) => object.id === m1.id)!;
    const rotatedSecond = rotated.pages[0].objects.find((object) => object.id === m2.id)!;
    expect(rotated.selection.objectIds).toEqual([groupId]);
    expect(rotatedFirst).toEqual(expectedFirst);
    expect(rotatedSecond).toEqual(expectedSecond);
  });

  it("ungroups selected group metadata back to its children", () => {
    const { document, ids } = twoMolecules();
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [
      { op: "setSelection", pageId: document.pages[0].id, objectIds: ids }
    ]));
    const groupId = selectedGroupObjectIds(grouped)[0];
    if (!groupId) {
      throw new Error("Expected selected group.");
    }

    const ungrouped = ungroupSelectedDocumentObjects(grouped);

    expect(ungrouped.pages[0].objects.some((object) => object.id === groupId)).toBe(false);
    expect(ungrouped.selection.objectIds).toEqual(ids);
  });

  it("duplicates a selected group as a new grouped copy", () => {
    const { document, ids } = twoMolecules();
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [
      { op: "setSelection", pageId: document.pages[0].id, objectIds: ids }
    ]));

    const duplicated = duplicateSelectedDocumentObjects(grouped);
    const duplicateGroupId = selectedGroupObjectIds(duplicated)[0];
    const duplicateChildIds = resolveGroupedDocumentObjectIds(duplicated.pages[0].objects, duplicated.selection.objectIds);

    expect(duplicateGroupId).toBeDefined();
    expect(duplicated.selection.objectIds).toEqual([duplicateGroupId]);
    expect(duplicateChildIds).toHaveLength(ids.length);
    expect(duplicateChildIds.some((objectId) => ids.includes(objectId))).toBe(false);
  });

  it("moves selected group children through layer order as a visible block", () => {
    const document = createPhase4Document("Group Layer Order");
    const pageId = document.pages[0].id;
    const text = (id: string, x: number): TextObject => ({
      id,
      type: "text",
      x,
      y: 180,
      width: 60,
      height: 30,
      rotation: 0,
      style: {},
      text: id,
      spans: []
    });
    const objects = [
      text("behind", 100),
      text("child_a", 180),
      text("child_b", 260),
      text("blocker", 340)
    ];
    const selected = applyPatches(document, [
      ...objects.map((object) => ({ op: "addObject" as const, pageId, object })),
      { op: "setSelection" as const, pageId, objectIds: ["child_a", "child_b"] }
    ]);
    const grouped = groupSelectedDocumentObjects(selected);
    const groupId = selectedGroupObjectIds(grouped)[0];
    if (!groupId) {
      throw new Error("Expected selected group.");
    }

    expect(selectedLayerObjectIds(grouped)).toEqual(["child_a", "child_b", groupId]);

    const forward = reorderSelectedDocumentObject(grouped, "forward");
    expect(forward.pages[0].objects.map((object) => object.id)).toEqual([
      "behind",
      "blocker",
      "child_a",
      "child_b",
      groupId
    ]);
    expect(forward.selection.objectIds).toEqual([groupId]);

    const back = reorderSelectedDocumentObject(forward, "back");
    expect(back.pages[0].objects.map((object) => object.id)).toEqual([
      "child_a",
      "child_b",
      groupId,
      "behind",
      "blocker"
    ]);
    expect(back.selection.objectIds).toEqual([groupId]);
  });

  it("moves multi-selected objects through layer order together while preserving their order", () => {
    const document = createPhase4Document("Multi Layer Order");
    const pageId = document.pages[0].id;
    const objects: TextObject[] = ["back", "left", "right", "front"].map((id, index) => ({
      id,
      type: "text",
      x: 120 + index * 72,
      y: 220,
      width: 48,
      height: 24,
      rotation: 0,
      style: {},
      text: id,
      spans: []
    }));
    const selected = applyPatches(document, [
      ...objects.map((object) => ({ op: "addObject" as const, pageId, object })),
      { op: "setSelection" as const, pageId, objectIds: ["left", "right"] }
    ]);

    const forward = reorderSelectedDocumentObject(selected, "forward");
    expect(forward.pages[0].objects.map((object) => object.id)).toEqual([
      "back",
      "front",
      "left",
      "right"
    ]);
    expect(forward.selection.objectIds).toEqual(["left", "right"]);

    const toBack = reorderSelectedDocumentObject(forward, "back");
    expect(toBack.pages[0].objects.map((object) => object.id)).toEqual([
      "left",
      "right",
      "back",
      "front"
    ]);
    expect(toBack.selection.objectIds).toEqual(["left", "right"]);
  });

  it("deletes a selected group and its child objects", () => {
    const { document, ids } = twoMolecules();
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [
      { op: "setSelection", pageId: document.pages[0].id, objectIds: ids }
    ]));

    const deleted = deleteSelectedDocumentObjects(grouped);

    expect(deleted.pages[0].objects.filter((object) => ids.includes(object.id))).toHaveLength(0);
    expect(selectedGroupObjectIds(deleted)).toEqual([]);
  });

  it("aligns mixed selected objects to the shared selection bounds", () => {
    const withMolecule = insertNativeSingleBondMolecule(
      createPhase4Document("Align Selection"),
      { x: 220, y: 180 }
    );
    const molecule = selectedMolecule(withMolecule);
    const withLine = insertNativeArtGraphicObject(withMolecule, { x: 420, y: 260 }, "tool.art.line");
    const lineId = withLine.selection.objectIds[0];
    if (!lineId) {
      throw new Error("Expected inserted line object to be selected.");
    }
    const withText = insertNativeTextObject(withLine, { x: 560, y: 340 }, "Align");
    const textId = withText.selection.objectIds[0];
    if (!textId) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const ids = [molecule.id, lineId, textId];
    const selected = applyPatches(withText, [
      { op: "setSelection", pageId: withText.pages[0].id, objectIds: ids }
    ]);
    const bounds = selectionBounds(selected.pages[0].objects, ids);
    if (!bounds) {
      throw new Error("Expected selected object bounds.");
    }
    const selectedObjectsIn = (document: ChemDraftDocument) =>
      ids.map((id) => {
        const object = document.pages[0].objects.find((candidate) => candidate.id === id);
        if (!object) {
          throw new Error(`Expected selected object ${id}.`);
        }
        return object;
      });

    const leftAligned = alignSelectedDocumentObjects(selected, "left");
    selectedObjectsIn(leftAligned).forEach((object) => {
      expect(object.x).toBeCloseTo(bounds.x, 6);
    });

    const centerAligned = alignSelectedDocumentObjects(selected, "center");
    selectedObjectsIn(centerAligned).forEach((object) => {
      expect(object.x + object.width / 2).toBeCloseTo(bounds.centerX, 6);
    });

    const bottomAligned = alignSelectedDocumentObjects(selected, "bottom");
    selectedObjectsIn(bottomAligned).forEach((object) => {
      expect(object.y + object.height).toBeCloseTo(bounds.y + bounds.height, 6);
    });
  });

  it("distributes selected objects by centers or equal gaps while preserving the outer anchors", () => {
    const document = createPhase4Document("Distribute Selection");
    const pageId = document.pages[0].id;
    const objects: TextObject[] = [
      { id: "text_left", type: "text", x: 100, y: 180, width: 40, height: 24, rotation: 0, style: {}, text: "A", spans: [] },
      { id: "text_middle", type: "text", x: 260, y: 500, width: 20, height: 24, rotation: 0, style: {}, text: "B", spans: [] },
      { id: "text_right", type: "text", x: 520, y: 260, width: 60, height: 24, rotation: 0, style: {}, text: "C", spans: [] }
    ];
    const ids = objects.map((object) => object.id);
    const selected = applyPatches(document, [
      ...objects.map((object) => ({ op: "addObject" as const, pageId, object })),
      { op: "setSelection" as const, pageId, objectIds: ids }
    ]);
    const objectById = (current: ChemDraftDocument, id: string): TextObject => {
      const object = current.pages[0].objects.find((candidate): candidate is TextObject =>
        candidate.id === id && candidate.type === "text"
      );
      if (!object) {
        throw new Error(`Expected text object ${id}.`);
      }
      return object;
    };
    const centerX = (current: ChemDraftDocument, id: string) => {
      const object = objectById(current, id);
      return object.x + object.width / 2;
    };
    const centerY = (current: ChemDraftDocument, id: string) => {
      const object = objectById(current, id);
      return object.y + object.height / 2;
    };
    const rightEdge = (current: ChemDraftDocument, id: string) => {
      const object = objectById(current, id);
      return object.x + object.width;
    };
    const bottomEdge = (current: ChemDraftDocument, id: string) => {
      const object = objectById(current, id);
      return object.y + object.height;
    };

    const horizontal = distributeSelectedDocumentObjects(selected, "horizontal");
    expect(centerX(horizontal, "text_left")).toBeCloseTo(centerX(selected, "text_left"), 6);
    expect(centerX(horizontal, "text_right")).toBeCloseTo(centerX(selected, "text_right"), 6);
    expect(centerX(horizontal, "text_middle")).toBeCloseTo(
      (centerX(selected, "text_left") + centerX(selected, "text_right")) / 2,
      6
    );

    const vertical = distributeSelectedDocumentObjects(selected, "vertical");
    expect(centerY(vertical, "text_left")).toBeCloseTo(centerY(selected, "text_left"), 6);
    expect(centerY(vertical, "text_middle")).toBeCloseTo(centerY(selected, "text_middle"), 6);
    expect(centerY(vertical, "text_right")).toBeCloseTo(
      (centerY(selected, "text_left") + centerY(selected, "text_middle")) / 2,
      6
    );

    const horizontalGaps = distributeSelectedDocumentObjects(selected, "horizontal", "spacing");
    expect(objectById(horizontalGaps, "text_left").x).toBeCloseTo(objectById(selected, "text_left").x, 6);
    expect(rightEdge(horizontalGaps, "text_right")).toBeCloseTo(rightEdge(selected, "text_right"), 6);
    const leftToMiddleGap = objectById(horizontalGaps, "text_middle").x - rightEdge(horizontalGaps, "text_left");
    const middleToRightGap = objectById(horizontalGaps, "text_right").x - rightEdge(horizontalGaps, "text_middle");
    expect(leftToMiddleGap).toBeCloseTo(middleToRightGap, 6);

    const verticalGaps = distributeSelectedDocumentObjects(selected, "vertical", "spacing");
    expect(objectById(verticalGaps, "text_left").y).toBeCloseTo(objectById(selected, "text_left").y, 6);
    expect(bottomEdge(verticalGaps, "text_middle")).toBeCloseTo(bottomEdge(selected, "text_middle"), 6);
    const topToMiddleGap = objectById(verticalGaps, "text_right").y - bottomEdge(verticalGaps, "text_left");
    const middleToBottomGap = objectById(verticalGaps, "text_middle").y - bottomEdge(verticalGaps, "text_right");
    expect(topToMiddleGap).toBeCloseTo(middleToBottomGap, 6);
  });

  it("distributes rotated art by visible bounds instead of hidden object boxes", () => {
    const document = createPhase4Document("Visual Bounds Distribute");
    const pageId = document.pages[0].id;
    const objects: GraphicObject[] = [
      {
        id: "visual_top",
        type: "graphic",
        graphicKind: "rect",
        x: 180,
        y: 100,
        width: 76,
        height: 185,
        rotation: -6,
        style: { strokeColor: "#111111", strokeWidth: 2, fillPaint: { kind: "none" } },
        data: {}
      },
      {
        id: "visual_middle",
        type: "graphic",
        graphicKind: "ellipse",
        x: 190,
        y: 360,
        width: 72,
        height: 72,
        rotation: 0,
        style: { strokeColor: "#111111", strokeWidth: 2, fillPaint: { kind: "none" } },
        data: {}
      },
      {
        id: "visual_bottom",
        type: "graphic",
        graphicKind: "rect",
        x: 170,
        y: 650,
        width: 108,
        height: 88,
        rotation: 0,
        style: { strokeColor: "#111111", strokeWidth: 2, fillPaint: { kind: "none" } },
        data: {}
      }
    ];
    const selected = applyPatches(document, [
      ...objects.map((object) => ({ op: "addObject" as const, pageId, object })),
      { op: "setSelection" as const, pageId, objectIds: objects.map((object) => object.id) }
    ]);
    const objectById = (current: ChemDraftDocument, id: string): GraphicObject => {
      const object = current.pages[0].objects.find((candidate): candidate is GraphicObject =>
        candidate.id === id && candidate.type === "graphic"
      );
      if (!object) {
        throw new Error(`Expected graphic object ${id}.`);
      }
      return object;
    };
    const visualCenterY = (current: ChemDraftDocument, id: string) => {
      const bounds = documentObjectVisualBounds(objectById(current, id));
      return bounds.y + bounds.height / 2;
    };
    const visualGap = (current: ChemDraftDocument, upperId: string, lowerId: string) => {
      const upper = documentObjectVisualBounds(objectById(current, upperId));
      const lower = documentObjectVisualBounds(objectById(current, lowerId));
      return lower.y - (upper.y + upper.height);
    };

    const centers = distributeSelectedDocumentObjects(selected, "vertical", "centers");
    const equalGaps = distributeSelectedDocumentObjects(selected, "vertical", "spacing");

    expect(objectById(centers, "visual_middle").y).not.toBeCloseTo(objectById(equalGaps, "visual_middle").y, 3);
    expect(visualCenterY(centers, "visual_middle")).toBeCloseTo(
      (visualCenterY(selected, "visual_top") + visualCenterY(selected, "visual_bottom")) / 2,
      3
    );
    expect(visualGap(equalGaps, "visual_top", "visual_middle")).toBeCloseTo(
      visualGap(equalGaps, "visual_middle", "visual_bottom"),
      3
    );
  });

  it("duplicates selected objects as offset copies and selects the duplicates", () => {
    const withMolecule = insertNativeSingleBondMolecule(
      createPhase4Document("Duplicate Selection"),
      { x: 220, y: 180 }
    );
    const molecule = selectedMolecule(withMolecule);
    const withLine = insertNativeArtGraphicObject(withMolecule, { x: 420, y: 260 }, "tool.art.line");
    const lineId = withLine.selection.objectIds[0];
    if (!lineId) {
      throw new Error("Expected inserted line object to be selected.");
    }
    const linePoints = nativeGraphicPathEditPoints(graphicById(withLine, lineId));
    if (!linePoints) {
      throw new Error("Expected line object to expose edit points.");
    }
    const editedLine = updateNativeGraphicPathHandle(
      withLine,
      lineId,
      "end",
      { x: linePoints.end.x + 18, y: linePoints.end.y + 12 }
    );
    const selected = applyPatches(editedLine, [
      { op: "setSelection", pageId: editedLine.pages[0].id, objectIds: [molecule.id, lineId] }
    ]);
    const beforeLine = graphicById(selected, lineId);
    const beforeBounds = selectionBounds(selected.pages[0].objects, selected.selection.objectIds);
    if (!beforeBounds) {
      throw new Error("Expected selected object bounds.");
    }

    const duplicated = duplicateSelectedDocumentObjects(selected);
    const duplicateIds = duplicated.selection.objectIds;
    const duplicateObjects = duplicated.pages[0].objects.filter((object) => duplicateIds.includes(object.id));
    const duplicateMolecule = duplicateObjects.find((object): object is MoleculeObject => object.type === "molecule");
    const duplicateLine = duplicateObjects.find((object): object is GraphicObject => object.type === "graphic");
    const duplicateBounds = selectionBounds(duplicated.pages[0].objects, duplicateIds);

    expect(duplicated.pages[0].objects).toHaveLength(selected.pages[0].objects.length + 2);
    expect(duplicateIds).toHaveLength(2);
    expect(duplicateIds).not.toContain(molecule.id);
    expect(duplicateIds).not.toContain(lineId);
    expect(duplicateMolecule).toBeDefined();
    expect(duplicateLine).toBeDefined();
    expect(duplicateBounds?.centerX).toBeCloseTo(beforeBounds.centerX + 24, 6);
    expect(duplicateBounds?.centerY).toBeCloseTo(beforeBounds.centerY + 24, 6);
    expect(duplicateMolecule?.atoms[0]?.x).toBeCloseTo(molecule.atoms[0].x + 24, 6);
    expect(duplicateMolecule?.atoms[0]?.y).toBeCloseTo(molecule.atoms[0].y + 24, 6);
    expectPointToBeClose(duplicateLine?.data.lineStart, translatedPoint(beforeLine.data.lineStart!, 24, 24));
    expectPointToBeClose(duplicateLine?.data.lineEnd, translatedPoint(beforeLine.data.lineEnd!, 24, 24));
  });

  it("rotates the selected objects 90 degrees around the shared selection center", () => {
    const withLine = insertNativeArtGraphicObject(
      createPhase4Document("Rotate 90 Selection"),
      { x: 260, y: 190 },
      "tool.art.line"
    );
    const lineId = withLine.selection.objectIds[0];
    if (!lineId) {
      throw new Error("Expected inserted line object to be selected.");
    }
    const withText = insertNativeTextObject(withLine, { x: 480, y: 280 }, "90");
    const textId = withText.selection.objectIds[0];
    if (!textId) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const selected = applyPatches(withText, [
      { op: "setSelection", pageId: withText.pages[0].id, objectIds: [lineId, textId] }
    ]);
    const beforeLine = graphicById(selected, lineId);
    const beforeText = selected.pages[0].objects.find((object): object is TextObject => object.id === textId && object.type === "text");
    const bounds = selectionBounds(selected.pages[0].objects, selected.selection.objectIds);
    if (!beforeText || !bounds) {
      throw new Error("Expected text object and selection bounds.");
    }
    const groupCenter = { x: bounds.centerX, y: bounds.centerY };
    const beforeLineCenter = { x: beforeLine.x + beforeLine.width / 2, y: beforeLine.y + beforeLine.height / 2 };
    const beforeTextCenter = { x: beforeText.x + beforeText.width / 2, y: beforeText.y + beforeText.height / 2 };

    const rotated = rotateSelectedDocumentObjects90(selected);
    const rotatedLine = graphicById(rotated, lineId);
    const rotatedText = rotated.pages[0].objects.find((object): object is TextObject => object.id === textId && object.type === "text");

    expect(rotated.selection.objectIds).toEqual([lineId, textId]);
    expect(rotatedLine.rotation).toBeCloseTo(90, 6);
    expect(rotatedText?.rotation).toBeCloseTo(90, 6);
    expectPointToBeClose(
      { x: rotatedLine.x + rotatedLine.width / 2, y: rotatedLine.y + rotatedLine.height / 2 },
      rotatedPointAround(beforeLineCenter, groupCenter, 90)
    );
    expectPointToBeClose(
      rotatedText ? { x: rotatedText.x + rotatedText.width / 2, y: rotatedText.y + rotatedText.height / 2 } : undefined,
      rotatedPointAround(beforeTextCenter, groupCenter, 90)
    );
  });

  it("group-moves edited line graphic path geometry with the object", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Group Move Edited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const edited = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "end",
      { x: points.end.x + 44, y: points.end.y + 18 }
    );
    const withText = insertNativeTextObject(edited, { x: 420, y: 260 }, "Group");
    const textId = withText.selection.objectIds[0];
    if (!textId) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const editedGraphic = graphicById(withText, objectId);
    const text = withText.pages[0].objects.find((object) => object.id === textId);
    if (!text) {
      throw new Error("Expected text object.");
    }
    const dx = 34;
    const dy = -21;

    const moved = moveDocumentObjects(withText, [objectId, textId], dx, dy);
    const movedGraphic = graphicById(moved, objectId);
    const movedText = moved.pages[0].objects.find((object) => object.id === textId);

    expect(movedGraphic.x).toBeCloseTo(editedGraphic.x + dx, 6);
    expect(movedGraphic.y).toBeCloseTo(editedGraphic.y + dy, 6);
    expect(movedGraphic.data.lineStart).toEqual(translatedPoint(editedGraphic.data.lineStart!, dx, dy));
    expect(movedGraphic.data.lineEnd).toEqual(translatedPoint(editedGraphic.data.lineEnd!, dx, dy));
    expect(movedText?.x).toBeCloseTo(text.x + dx, 6);
    expect(movedText?.y).toBeCloseTo(text.y + dy, 6);
  });

  it("group-moves semantic arc center with the object", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Group Move Semantic Arc"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arc art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected arc art object to expose path edit points.");
    }
    const edited = updateNativeGraphicPathHandle(inserted, objectId, "end", points.start);
    const withText = insertNativeTextObject(edited, { x: 420, y: 260 }, "Arc group");
    const textId = withText.selection.objectIds[0];
    if (!textId) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const editedGraphic = graphicById(withText, objectId);
    const dx = -26;
    const dy = 33;

    const moved = moveDocumentObjects(withText, [objectId, textId], dx, dy);
    const movedGraphic = graphicById(moved, objectId);

    expect(editedGraphic.data.arcCenter).toBeDefined();
    expect(movedGraphic.data.arcCenter).toEqual(translatedPoint(editedGraphic.data.arcCenter!, dx, dy));
    expect(movedGraphic.data.pathControlPoint).toBeUndefined();
  });

  it("group-resizes edited graphic path geometry with the selection frame", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Group Resize Edited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 8, y: points.middle.y - 38 }
    );
    const withText = insertNativeTextObject(bent, { x: 420, y: 260 }, "Group");
    const textId = withText.selection.objectIds[0];
    if (!textId) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const bentGraphic = graphicById(withText, objectId);
    const beforePoints = nativeGraphicPathEditPoints(bentGraphic);
    const bounds = selectionBounds(withText.pages[0].objects, [objectId, textId]);
    if (!bounds || !beforePoints) {
      throw new Error("Expected group bounds and quadratic edit points.");
    }
    const scaleX = 1.3;
    const scaleY = 0.65;
    const groupCenter = { x: bounds.centerX, y: bounds.centerY };
    const oldCenter = {
      x: bentGraphic.x + bentGraphic.width / 2,
      y: bentGraphic.y + bentGraphic.height / 2
    };

    const scaled = scaleDocumentObjectsAroundPoint(withText, [objectId, textId], groupCenter, scaleX, scaleY);
    const scaledGraphic = graphicById(scaled, objectId);
    const scaledPoints = nativeGraphicPathEditPoints(scaledGraphic);
    const newCenter = {
      x: scaledGraphic.x + scaledGraphic.width / 2,
      y: scaledGraphic.y + scaledGraphic.height / 2
    };

    expect(scaledGraphic.width).toBeCloseTo(bentGraphic.width * scaleX, 6);
    expect(scaledGraphic.height).toBeCloseTo(bentGraphic.height * scaleY, 6);
    expectPointToBeClose(scaledGraphic.data.lineStart, scaledPoint(bentGraphic.data.lineStart!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledGraphic.data.lineEnd, scaledPoint(bentGraphic.data.lineEnd!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledGraphic.data.pathControlPoint, scaledPoint(bentGraphic.data.pathControlPoint!, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledPoints?.start, scaledPoint(beforePoints.start, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledPoints?.middle, scaledPoint(beforePoints.middle, oldCenter, newCenter, scaleX, scaleY));
    expectPointToBeClose(scaledPoints?.end, scaledPoint(beforePoints.end, oldCenter, newCenter, scaleX, scaleY));
  });

  it("group-flips edited graphic path geometry with positive frame dimensions", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Group Flip Edited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 8, y: points.middle.y - 38 }
    );
    const withText = insertNativeTextObject(bent, { x: 420, y: 260 }, "Group");
    const textId = withText.selection.objectIds[0];
    if (!textId) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const bentGraphic = graphicById(withText, objectId);
    const beforePoints = nativeGraphicPathEditPoints(bentGraphic);
    const bounds = selectionBounds(withText.pages[0].objects, [objectId, textId]);
    if (!bounds || !beforePoints) {
      throw new Error("Expected group bounds and quadratic edit points.");
    }
    const groupCenter = { x: bounds.centerX, y: bounds.centerY };
    const oldCenter = {
      x: bentGraphic.x + bentGraphic.width / 2,
      y: bentGraphic.y + bentGraphic.height / 2
    };

    const flipped = flipDocumentObjectsAroundPoint(withText, [objectId, textId], groupCenter, "horizontal");
    const flippedGraphic = graphicById(flipped, objectId);
    const flippedPoints = nativeGraphicPathEditPoints(flippedGraphic);
    const newCenter = {
      x: flippedGraphic.x + flippedGraphic.width / 2,
      y: flippedGraphic.y + flippedGraphic.height / 2
    };

    expectPointToBeClose(newCenter, { x: groupCenter.x - (oldCenter.x - groupCenter.x), y: oldCenter.y });
    expect(flippedGraphic.width).toBeCloseTo(bentGraphic.width, 6);
    expect(flippedGraphic.height).toBeCloseTo(bentGraphic.height, 6);
    expect(flippedGraphic.rotation).toBeCloseTo(bentGraphic.rotation, 6);
    expectPointToBeClose(flippedGraphic.data.lineStart, scaledPoint(bentGraphic.data.lineStart!, oldCenter, newCenter, -1, 1));
    expectPointToBeClose(flippedGraphic.data.lineEnd, scaledPoint(bentGraphic.data.lineEnd!, oldCenter, newCenter, -1, 1));
    expectPointToBeClose(flippedGraphic.data.pathControlPoint, scaledPoint(bentGraphic.data.pathControlPoint!, oldCenter, newCenter, -1, 1));
    expectPointToBeClose(flippedPoints?.start, scaledPoint(beforePoints.start, oldCenter, newCenter, -1, 1));
    expectPointToBeClose(flippedPoints?.middle, scaledPoint(beforePoints.middle, oldCenter, newCenter, -1, 1));
    expectPointToBeClose(flippedPoints?.end, scaledPoint(beforePoints.end, oldCenter, newCenter, -1, 1));
  });

  it("flips semantic arc radii without negative values", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Flip Semantic Arc"),
      { x: 220, y: 180 },
      "tool.art.arc270"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted arc art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected arc art object to expose path edit points.");
    }
    const edited = updateNativeGraphicPathHandle(inserted, objectId, "end", points.start);
    const editedGraphic = graphicById(edited, objectId);
    const oldCenter = {
      x: editedGraphic.x + editedGraphic.width / 2,
      y: editedGraphic.y + editedGraphic.height / 2
    };

    const flipped = flipDocumentObjectsAroundPoint(edited, [objectId], oldCenter, "horizontal");
    const flippedGraphic = graphicById(flipped, objectId);
    const newCenter = {
      x: flippedGraphic.x + flippedGraphic.width / 2,
      y: flippedGraphic.y + flippedGraphic.height / 2
    };

    expect(editedGraphic.data.arcCenter).toBeDefined();
    expect(flippedGraphic.data.artPathKind).toBe("arc");
    expect(flippedGraphic.data.arcRadiusX).toBeCloseTo(editedGraphic.data.arcRadiusX ?? 0, 6);
    expect(flippedGraphic.data.arcRadiusY).toBeCloseTo(editedGraphic.data.arcRadiusY ?? 0, 6);
    expect(flippedGraphic.data.arcRadiusX).toBeGreaterThan(0);
    expect(flippedGraphic.data.arcRadiusY).toBeGreaterThan(0);
    expectPointToBeClose(flippedGraphic.data.arcCenter, scaledPoint(editedGraphic.data.arcCenter!, oldCenter, newCenter, -1, 1));
  });

  it("group-rotates edited graphic path geometry by moving explicit data with the object center only", () => {
    const inserted = insertNativeArtGraphicObject(
      createPhase4Document("Group Rotate Edited Line"),
      { x: 220, y: 180 },
      "tool.art.line"
    );
    const objectId = inserted.selection.objectIds[0];
    if (!objectId) {
      throw new Error("Expected inserted line art object to be selected.");
    }
    const points = nativeGraphicPathEditPoints(graphicById(inserted, objectId));
    if (!points) {
      throw new Error("Expected line art object to expose path edit points.");
    }
    const bent = updateNativeGraphicPathHandle(
      inserted,
      objectId,
      "middle",
      { x: points.middle.x + 12, y: points.middle.y - 36 }
    );
    const withText = insertNativeTextObject(bent, { x: 420, y: 260 }, "Group");
    const textId = withText.selection.objectIds[0];
    if (!textId) {
      throw new Error("Expected inserted text object to be selected.");
    }
    const bentGraphic = graphicById(withText, objectId);
    const beforePoints = nativeGraphicPathEditPoints(bentGraphic);
    const bounds = selectionBounds(withText.pages[0].objects, [objectId, textId]);
    if (!bounds || !beforePoints) {
      throw new Error("Expected group bounds and quadratic edit points.");
    }
    const groupCenter = { x: bounds.centerX, y: bounds.centerY };
    const oldCenter = {
      x: bentGraphic.x + bentGraphic.width / 2,
      y: bentGraphic.y + bentGraphic.height / 2
    };
    const oldStartVector = {
      x: bentGraphic.data.lineStart!.x - oldCenter.x,
      y: bentGraphic.data.lineStart!.y - oldCenter.y
    };
    const oldControlVector = {
      x: bentGraphic.data.pathControlPoint!.x - oldCenter.x,
      y: bentGraphic.data.pathControlPoint!.y - oldCenter.y
    };

    const rotated = rotateDocumentObjectsAroundPoint(withText, [objectId, textId], groupCenter, 90);
    const rotatedGraphic = graphicById(rotated, objectId);
    const rotatedPoints = nativeGraphicPathEditPoints(rotatedGraphic);
    const newCenter = {
      x: rotatedGraphic.x + rotatedGraphic.width / 2,
      y: rotatedGraphic.y + rotatedGraphic.height / 2
    };
    const expectedCenter = rotatedPointAround(oldCenter, groupCenter, 90);
    const expectedStart = translatedPoint(bentGraphic.data.lineStart!, newCenter.x - oldCenter.x, newCenter.y - oldCenter.y);
    const expectedEnd = translatedPoint(bentGraphic.data.lineEnd!, newCenter.x - oldCenter.x, newCenter.y - oldCenter.y);
    const expectedControl = translatedPoint(
      bentGraphic.data.pathControlPoint!,
      newCenter.x - oldCenter.x,
      newCenter.y - oldCenter.y
    );

    expectPointToBeClose(newCenter, expectedCenter);
    expect(rotatedGraphic.rotation).toBeCloseTo(90, 6);
    expect(rotatedGraphic.width).toBeCloseTo(bentGraphic.width, 6);
    expect(rotatedGraphic.height).toBeCloseTo(bentGraphic.height, 6);
    expectPointToBeClose(rotatedGraphic.data.lineStart, expectedStart);
    expectPointToBeClose(rotatedGraphic.data.lineEnd, expectedEnd);
    expectPointToBeClose(rotatedGraphic.data.pathControlPoint, expectedControl);
    expectPointToBeClose(rotatedPoints?.start, expectedStart);
    expectPointToBeClose(rotatedPoints?.middle, expectedControl);
    expectPointToBeClose(rotatedPoints?.end, expectedEnd);
    expect((rotatedGraphic.data.lineStart?.x ?? 0) - newCenter.x).toBeCloseTo(oldStartVector.x, 6);
    expect((rotatedGraphic.data.lineStart?.y ?? 0) - newCenter.y).toBeCloseTo(oldStartVector.y, 6);
    expect((rotatedGraphic.data.pathControlPoint?.x ?? 0) - newCenter.x).toBeCloseTo(oldControlVector.x, 6);
    expect((rotatedGraphic.data.pathControlPoint?.y ?? 0) - newCenter.y).toBeCloseTo(oldControlVector.y, 6);
  });

  it("rotates the selection 180° about the group center: members reverse and move, identity preserved", () => {
    const { document, ids, m1 } = twoMolecules();
    const mol1 = m1 as MoleculeObject;
    const [a0, a1] = mol1.atoms;
    const beforeVector = { x: a1.x - a0.x, y: a1.y - a0.y };
    const beforeObjCenter = { x: m1.x + m1.width / 2, y: m1.y + m1.height / 2 };
    const bounds = selectionBounds(document.pages[0].objects, ids)!;
    const atomsBefore = moleculeAtomTotal(document);

    const rotated = rotateDocumentObjectsAroundPoint(document, ids, { x: bounds.centerX, y: bounds.centerY }, 180);
    const obj1 = rotated.pages[0].objects.find((object) => object.id === m1.id) as MoleculeObject;
    const r0 = obj1.atoms.find((atom) => atom.id === a0.id)!;
    const r1 = obj1.atoms.find((atom) => atom.id === a1.id)!;

    // 180° rigid rotation reverses every internal vector (frame-independent).
    expect(r1.x - r0.x).toBeCloseTo(-beforeVector.x, 1);
    expect(r1.y - r0.y).toBeCloseTo(-beforeVector.y, 1);
    // Rotating about the GROUP center (not each molecule's own) moves the member.
    const afterObjCenter = { x: obj1.x + obj1.width / 2, y: obj1.y + obj1.height / 2 };
    expect(Math.hypot(afterObjCenter.x - beforeObjCenter.x, afterObjCenter.y - beforeObjCenter.y)).toBeGreaterThan(20);
    expect(moleculeAtomTotal(rotated)).toBe(atomsBefore);
  });

  it("keeps group molecule rotation separate from later single-molecule rotation", () => {
    const { document, ids, m1 } = twoMolecules();
    const molecule = m1 as MoleculeObject;
    const groupBounds = selectionBounds(document.pages[0].objects, ids)!;
    const groupRotated = rotateDocumentObjectsAroundPoint(
      document,
      ids,
      { x: groupBounds.centerX, y: groupBounds.centerY },
      90
    );
    const groupRotatedMolecule = moleculeById(groupRotated, molecule.id);
    const singleCenterBefore = nativeMoleculeCenter(groupRotatedMolecule);

    expect(nativeMoleculeTransformState(groupRotatedMolecule).rotationDegrees).toBe(0);

    const singleRotated = rotateDocumentObject(groupRotated, molecule.id, 45);
    const singleRotatedMolecule = moleculeById(singleRotated, molecule.id);
    const singleCenterAfter = nativeMoleculeCenter(singleRotatedMolecule);

    expect(nativeMoleculeTransformState(singleRotatedMolecule).rotationDegrees).toBe(45);
    expect(singleCenterAfter.x).toBeCloseTo(singleCenterBefore.x, 3);
    expect(singleCenterAfter.y).toBeCloseTo(singleCenterBefore.y, 3);
    expect(moleculeAtomTotal(singleRotated)).toBe(moleculeAtomTotal(document));
  });

  it("scales the selection about the group center: internal vectors double, union grows, identity preserved", () => {
    const { document, ids, m1 } = twoMolecules();
    const mol1 = m1 as MoleculeObject;
    const [a0, a1] = mol1.atoms;
    const beforeVector = { x: a1.x - a0.x, y: a1.y - a0.y };
    const before = selectionBounds(document.pages[0].objects, ids)!;
    const atomsBefore = moleculeAtomTotal(document);

    const scaled = scaleDocumentObjectsAroundPoint(document, ids, { x: before.centerX, y: before.centerY }, 2, 2);
    const obj1 = scaled.pages[0].objects.find((object) => object.id === m1.id) as MoleculeObject;
    const s0 = obj1.atoms.find((atom) => atom.id === a0.id)!;
    const s1 = obj1.atoms.find((atom) => atom.id === a1.id)!;

    // Scale by 2 doubles every internal vector (frame-independent).
    expect(s1.x - s0.x).toBeCloseTo(2 * beforeVector.x, 1);
    expect(s1.y - s0.y).toBeCloseTo(2 * beforeVector.y, 1);
    const after = selectionBounds(scaled.pages[0].objects, ids)!;
    expect(after.width).toBeGreaterThan(before.width * 1.5);
    expect(after.height).toBeGreaterThan(before.height * 1.5);
    expect(moleculeAtomTotal(scaled)).toBe(atomsBefore);
  });

  it("flips selected molecules about the group center while preserving identity", () => {
    const { document, ids, m1 } = twoMolecules();
    const mol1 = m1 as MoleculeObject;
    const [a0, a1] = mol1.atoms;
    const beforeVector = { x: a1.x - a0.x, y: a1.y - a0.y };
    const bounds = selectionBounds(document.pages[0].objects, ids)!;
    const atomsBefore = moleculeAtomTotal(document);

    const flipped = flipDocumentObjectsAroundPoint(document, ids, { x: bounds.centerX, y: bounds.centerY }, "horizontal");
    const obj1 = flipped.pages[0].objects.find((object) => object.id === m1.id) as MoleculeObject;
    const f0 = obj1.atoms.find((atom) => atom.id === a0.id)!;
    const f1 = obj1.atoms.find((atom) => atom.id === a1.id)!;

    expectPointToBeClose(f0, { x: bounds.centerX - (a0.x - bounds.centerX), y: a0.y }, 1);
    expectPointToBeClose(f1, { x: bounds.centerX - (a1.x - bounds.centerX), y: a1.y }, 1);
    expect(f1.x - f0.x).toBeCloseTo(-beforeVector.x, 1);
    expect(f1.y - f0.y).toBeCloseTo(beforeVector.y, 1);
    expect(moleculeAtomTotal(flipped)).toBe(atomsBefore);
  });
});

describe("PR #7 review regression fixes", () => {
  it("rejects a clipboard selection payload whose object is missing type-specific fields (#4)", () => {
    const malformed = JSON.stringify({
      kind: "chemdraft-selection",
      version: 1,
      // base fields present, but a reaction-arrow without the required start/end anchors
      objects: [{ id: "arrow_bad", type: "reaction-arrow", x: 10, y: 10, width: 40, height: 10, rotation: 0, style: {} }],
      selectionIds: ["arrow_bad"],
      bounds: { x: 10, y: 10, width: 40, height: 10, centerX: 30, centerY: 15 }
    });
    expect(parseSelectionClipboardPayload(malformed)).toBeUndefined();
  });

  it("offsets reaction-arrow point anchors when pasting so the arrow keeps its shape (#5)", () => {
    const base = createPhase4Document("Arrow Paste");
    const pageId = base.pages[0].id;
    const arrow = {
      id: "arrow_1",
      type: "reaction-arrow" as const,
      arrowKind: "forward" as const,
      x: 100,
      y: 100,
      width: 80,
      height: 20,
      rotation: 0,
      style: {},
      start: { kind: "point" as const, point: { x: 100, y: 110 } },
      end: { kind: "point" as const, point: { x: 180, y: 110 } },
      labels: []
    };
    const withArrow = applyPatches(base, [
      { op: "addObject", pageId, object: arrow },
      { op: "setSelection", pageId, objectIds: ["arrow_1"] }
    ]);
    const payload = createSelectionClipboardPayload(withArrow);
    if (!payload) {
      throw new Error("Expected arrow clipboard payload.");
    }

    const pasted = pasteSelectionClipboardPayload(withArrow, payload, {
      x: payload.bounds.centerX + 100,
      y: payload.bounds.centerY + 100
    });
    const pastedArrow = pasted.pages[0].objects.find(
      (object): object is Extract<DocumentObject, { type: "reaction-arrow" }> =>
        object.type === "reaction-arrow" && object.id !== "arrow_1"
    );
    if (!pastedArrow) {
      throw new Error("Expected a pasted reaction arrow.");
    }
    // The frame and both point anchors shift by the same delta, so each anchor keeps its original
    // offset from the frame (the renderer positions anchors relative to x/y).
    expect(pastedArrow.start.point?.x).toBeCloseTo(arrow.start.point.x + (pastedArrow.x - arrow.x), 6);
    expect(pastedArrow.start.point?.y).toBeCloseTo(arrow.start.point.y + (pastedArrow.y - arrow.y), 6);
    expect((pastedArrow.start.point?.x ?? 0) - pastedArrow.x).toBeCloseTo(arrow.start.point.x - arrow.x, 6);
    expect((pastedArrow.end.point?.x ?? 0) - pastedArrow.x).toBeCloseTo(arrow.end.point.x - arrow.x, 6);
  });

  it("deletes selected objects that live on a later page (#7)", () => {
    const base = createPhase4Document("Multi Page Delete");
    const firstPage = base.pages[0];
    const graphic = {
      id: "rect_p2",
      type: "graphic" as const,
      graphicKind: "rect" as const,
      x: 50,
      y: 50,
      width: 40,
      height: 30,
      rotation: 0,
      style: {},
      data: {}
    };
    const twoPage = {
      ...base,
      pages: [firstPage, { ...firstPage, id: "page_002", objects: [graphic] }],
      selection: { ...base.selection, pageId: "page_002", objectIds: ["rect_p2"] }
    };

    const deleted = deleteSelectedDocumentObjects(twoPage);
    expect(deleted.pages[1].objects.find((object) => object.id === "rect_p2")).toBeUndefined();
  });

  it("aligns a selected group as one unit, preserving its internal layout (#15)", () => {
    let document = insertNativeArtGraphicObject(createPhase4Document("Group Align"), { x: 120, y: 120 }, "tool.art.rect");
    document = insertNativeArtGraphicObject(document, { x: 180, y: 160 }, "tool.art.circle");
    const pageId = document.pages[0].id;
    const artIds = document.pages[0].objects.filter((object) => object.type === "graphic").map((object) => object.id);
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [{ op: "setSelection", pageId, objectIds: artIds }]));
    const groupId = grouped.selection.objectIds[0];
    const childXById = (current: ChemDraftDocument) =>
      new Map(artIds.map((id) => [id, current.pages[0].objects.find((object) => object.id === id)?.x ?? 0]));
    const relativeBefore = (() => {
      const positions = childXById(grouped);
      return (positions.get(artIds[1]) ?? 0) - (positions.get(artIds[0]) ?? 0);
    })();

    const withFar = insertNativeArtGraphicObject(grouped, { x: 520, y: 320 }, "tool.art.line");
    const farId = withFar.selection.objectIds[0];
    const selected = applyPatches(withFar, [{ op: "setSelection", pageId, objectIds: [groupId, farId] }]);

    const aligned = alignSelectedDocumentObjects(selected, "left");
    const positionsAfter = childXById(aligned);
    const relativeAfter = (positionsAfter.get(artIds[1]) ?? 0) - (positionsAfter.get(artIds[0]) ?? 0);
    // The group moved as a whole: its children kept their relative spacing instead of collapsing to
    // a single x (which is what aligning the expanded children individually would do).
    expect(relativeAfter).toBeCloseTo(relativeBefore, 6);
  });

  it("applies toolbar color to a group's children, not the invisible group wrapper (#16)", () => {
    let document = insertNativeArtGraphicObject(createPhase4Document("Group Color"), { x: 120, y: 120 }, "tool.art.rect");
    document = insertNativeArtGraphicObject(document, { x: 200, y: 120 }, "tool.art.circle");
    const pageId = document.pages[0].id;
    const artIds = document.pages[0].objects.filter((object) => object.type === "graphic").map((object) => object.id);
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [{ op: "setSelection", pageId, objectIds: artIds }]));
    const groupId = grouped.selection.objectIds[0];

    const result = applyToolbarColorToSelection(grouped, "#1f5fbf", { objectIds: [groupId] });

    expect(result.changed).toBe(true);
    const children = result.document.pages[0].objects.filter(
      (object): object is GraphicObject => object.type === "graphic"
    );
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.style.strokeColor?.toLowerCase()).toBe("#1f5fbf");
    }
    const group = result.document.pages[0].objects.find((object) => object.id === groupId);
    expect((group?.style as Record<string, unknown> | undefined)?.strokeColor).toBeUndefined();
  });

  it("styles native molecule rings without mutating chemical identity", () => {
    const base = createPhase4Document("Ring Style");
    const molecule = benzeneRingMolecule();
    const ringKey = "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006";
    const target = { objectId: molecule.id, kind: "ring" as const, ringKey };
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule },
      { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
    ]);

    const colored = applyMoleculeRingFillColor(document, target, "#d02626");
    const translucent = applyMoleculeRingFillOpacity(colored, target, 0.42);
    const effected = applyMoleculeRingEffect(translucent, target, "glow");
    const next = moleculeById(effected, molecule.id);
    const ringStyle = (next.style.ringStyles as Record<string, Record<string, unknown>>)[ringKey];

    expect(next.atoms).toEqual(molecule.atoms);
    expect(next.bonds).toEqual(molecule.bonds);
    expect(next.structure).toBe(molecule.structure);
    expect(ringStyle.fillColor).toBe("#d02626");
    expect(ringStyle.fillOpacity).toBe(0.42);
    expect((ringStyle.visualEffects as VisualEffect[])[0]).toMatchObject({ kind: "glow" });
    expect(applyMoleculeRingFillColor(document, { ...target, ringKey: "missing" }, "#111111")).toBe(document);
  });

  it("applies molecule base style patches without disturbing sparse part overrides", () => {
    const base = createPhase4Document("Molecule Base Style Patch");
    const molecule = benzeneRingMolecule({
      style: {
        fillColor: "none",
        bondColors: { bond_001: "#b3261e" },
        atomLabelColors: { atom_001: "#1f5fbf" }
      }
    });
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule }
    ]);

    const patched = applyMoleculeBaseStylePatch(document, [molecule.id], {
      chainAngleDegrees: 109.5,
      bondColor: "#263238",
      bondBoldWidthPx: 5.2,
      bondSpacingMode: "percent",
      bondSpacingPercent: 18,
      bondHashSpacingPx: 2.5,
      atomIndicatorShowAtomNumbers: true,
      bondIndicatorShowReaction: false,
      atomLabelColor: "#263238"
    });
    const next = moleculeById(patched, molecule.id);

    expect(next.style).toMatchObject({
      chainAngleDegrees: 109.5,
      bondColor: "#263238",
      bondBoldWidthPx: 5.2,
      bondSpacingMode: "percent",
      bondSpacingPercent: 18,
      bondHashSpacingPx: 2.5,
      atomIndicatorShowAtomNumbers: true,
      bondIndicatorShowReaction: false,
      atomLabelColor: "#263238",
      bondColors: { bond_001: "#b3261e" },
      atomLabelColors: { atom_001: "#1f5fbf" }
    });
    expect(applyMoleculeBaseStylePatch(patched, [molecule.id], {
      bondColor: "#263238",
      atomLabelColor: "#263238"
    })).toBe(patched);
  });

  it("applies atom label style patches only to targeted atoms", () => {
    const base = createPhase4Document("Atom Label Style Patch");
    const molecule = benzeneRingMolecule({
      atoms: [
        { id: "atom_oh", element: "O", x: 120, y: 160, formalCharge: 0 },
        { id: "atom_nh", element: "N", x: 180, y: 160, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_001", fromAtomId: "atom_oh", toAtomId: "atom_nh", order: "single" }
      ],
      style: {
        atomLabelFontSizePx: 12,
        atomLabelColor: "#111111",
        atomLabelColors: { atom_nh: "#b3261e" }
      }
    });
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule }
    ]);

    const patched = applyMoleculeAtomLabelStylePatch(
      document,
      [{ objectId: molecule.id, atomId: "atom_oh" }],
      {
        atomLabelFontSizePx: 18,
        atomLabelColor: "#1f5fbf",
        atomLabelPlacement: "above",
        atomLabelHideImplicitHydrogens: true
      }
    );
    const next = moleculeById(patched, molecule.id);

    expect(next.style.atomLabelFontSizePx).toBe(12);
    expect(next.style.atomLabelColor).toBe("#111111");
    expect(next.style.atomLabelFontSizes).toEqual({ atom_oh: 18 });
    expect(next.style.atomLabelColors).toEqual({ atom_nh: "#b3261e", atom_oh: "#1f5fbf" });
    expect(next.style.atomLabelPlacements).toEqual({ atom_oh: "above" });
    expect(next.style.atomLabelHideImplicitHydrogensByAtomId).toEqual({ atom_oh: true });
    expect(applyMoleculeAtomLabelStylePatch(patched, [{ objectId: molecule.id, atomId: "atom_oh" }], {
      atomLabelFontSizePx: 18,
      atomLabelColor: "#1f5fbf"
    })).toBe(patched);
  });

  it("applies bond style patches only to targeted bonds", () => {
    const base = createPhase4Document("Bond Style Patch");
    const molecule = benzeneRingMolecule({
      style: {
        bondColor: "#111111",
        bondStrokeWidthPx: 2,
        bondColors: { bond_002: "#b3261e" }
      }
    });
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule }
    ]);

    const patched = applyMoleculeBondStylePatch(
      document,
      [{ objectId: molecule.id, bondId: "bond_001" }],
      {
        bondColor: "#1f5fbf",
        bondStrokeWidthPx: 7,
        bondLineCap: "round",
        multipleBondGapPx: 6.5,
        bondIndicatorShowStereochemistry: true
      }
    );
    const next = moleculeById(patched, molecule.id);

    expect(next.style.bondColor).toBe("#111111");
    expect(next.style.bondStrokeWidthPx).toBe(2);
    expect(next.style.bondColors).toEqual({ bond_002: "#b3261e", bond_001: "#1f5fbf" });
    expect(next.style.bondStrokeWidths).toEqual({ bond_001: 7 });
    expect(next.style.bondLineCaps).toEqual({ bond_001: "round" });
    expect(next.style.bondMultipleBondGaps).toEqual({ bond_001: 6.5 });
    expect(next.style.bondIndicatorShowStereochemistryByBondId).toEqual({ bond_001: true });
    expect(applyMoleculeBondStylePatch(patched, [{ objectId: molecule.id, bondId: "bond_001" }], {
      bondColor: "#1f5fbf",
      bondStrokeWidthPx: 7
    })).toBe(patched);
  });

  it("applies atom indicator patches only to targeted atoms", () => {
    const base = createPhase4Document("Atom Indicator Style Patch");
    const molecule = benzeneRingMolecule({
      style: {
        atomIndicatorShowAtomNumbers: false
      }
    });
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule }
    ]);

    const patched = applyMoleculeAtomIndicatorStylePatch(
      document,
      [{ objectId: molecule.id, atomId: "atom_001" }],
      {
        atomIndicatorShowAtomNumbers: true,
        atomIndicatorShowQuery: false
      }
    );
    const next = moleculeById(patched, molecule.id);

    expect(next.style.atomIndicatorShowAtomNumbers).toBe(false);
    expect(next.style.atomIndicatorShowAtomNumbersByAtomId).toEqual({ atom_001: true });
    expect(next.style.atomIndicatorShowQueryByAtomId).toEqual({ atom_001: false });
    expect(applyMoleculeAtomIndicatorStylePatch(patched, [{ objectId: molecule.id, atomId: "atom_001" }], {
      atomIndicatorShowAtomNumbers: true
    })).toBe(patched);
  });

  it("scales selected molecules to a target bond length around each molecule center", () => {
    const base = createPhase4Document("Target Bond Length");
    const first = benzeneRingMolecule();
    const second = benzeneRingMolecule({
      id: "mol_ring_shifted",
      x: 430,
      atoms: benzeneRingMolecule().atoms.map((atom) => ({
        ...atom,
        id: `${atom.id}_b`,
        x: atom.x + 280,
        y: atom.y + 30,
        labelOffset: atom.id === "atom_001" ? { x: 8, y: -4 } : atom.labelOffset
      })),
      bonds: benzeneRingMolecule().bonds.map((bond) => ({
        ...bond,
        id: `${bond.id}_b`,
        fromAtomId: `${bond.fromAtomId}_b`,
        toAtomId: `${bond.toAtomId}_b`
      })),
      style: {
        fillColor: "none",
        ringStyles: {
          "bond_001_b|bond_002_b|bond_003_b|bond_004_b|bond_005_b|bond_006_b": {
            fillColor: "#d02626"
          }
        }
      }
    });
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: first },
      { op: "addObject", pageId: base.pages[0].id, object: second }
    ]);
    const firstBeforeLength = bondLength(first, "bond_001");
    const secondBeforeLength = bondLength(second, "bond_001_b");
    const firstCenter = moleculeAtomCenter(first);
    const secondCenter = moleculeAtomCenter(second);

    const scaled = applyMoleculeTargetBondLength(document, [first.id, second.id], 96);
    const scaledFirst = moleculeById(scaled, first.id);
    const scaledSecond = moleculeById(scaled, second.id);

    expect(bondLength(scaledFirst, "bond_001")).toBeCloseTo(96, 6);
    expect(bondLength(scaledSecond, "bond_001_b")).toBeCloseTo(96, 6);
    expect(moleculeAtomCenter(scaledFirst)).toEqual(firstCenter);
    expect(moleculeAtomCenter(scaledSecond)).toEqual(secondCenter);
    expect(scaledFirst.style.bondLengthPx).toBe(96);
    expect(scaledSecond.style.bondLengthPx).toBe(96);
    expect(scaledFirst.atoms[0]?.id).toBe(first.atoms[0]?.id);
    expect(scaledSecond.bonds[0]?.id).toBe(second.bonds[0]?.id);
    expect(scaledSecond.atoms[0]?.labelOffset).toEqual({ x: 8 * (96 / secondBeforeLength), y: -4 * (96 / secondBeforeLength) });
    expect(scaledFirst.atoms[0]?.x).toBeCloseTo(
      firstCenter.x + (first.atoms[0]!.x - firstCenter.x) * (96 / firstBeforeLength),
      6
    );
    expect(scaledSecond.style.ringStyles).toEqual(second.style.ringStyles);
  });

  it("scales selected bonds to a target length without scaling the whole molecule", () => {
    const base = createPhase4Document("Selected Bond Target Length");
    const molecule = benzeneRingMolecule();
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule }
    ]);
    const untouchedBefore = bondLength(molecule, "bond_003");

    const scaled = applyMoleculeTargetBondLengthToBonds(
      document,
      [{ objectId: molecule.id, bondId: "bond_001" }],
      96
    );
    const next = moleculeById(scaled, molecule.id);

    expect(bondLength(next, "bond_001")).toBeCloseTo(96, 6);
    expect(bondLength(next, "bond_003")).toBeCloseTo(untouchedBefore, 6);
    expect(next.style.bondLengthPx).toBeUndefined();
    expect(next.style.bondLengths).toEqual({ bond_001: 96 });
    expect(next.bonds.map((bond) => bond.id)).toEqual(molecule.bonds.map((bond) => bond.id));
  });

  it("reaches the target length on both selected bonds that share an atom", () => {
    const base = createPhase4Document("Adjacent Selected Bond Target Length");
    const molecule = benzeneRingMolecule();
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule }
    ]);

    // bond_001 (atom_001-atom_002) and bond_002 (atom_002-atom_003) share atom_002.
    const scaled = applyMoleculeTargetBondLengthToBonds(
      document,
      [
        { objectId: molecule.id, bondId: "bond_001" },
        { objectId: molecule.id, bondId: "bond_002" }
      ],
      96
    );
    const next = moleculeById(scaled, molecule.id);

    // Both bonds end at the requested length; the shared atom is not clobbered by the
    // second bond overwriting the first.
    expect(bondLength(next, "bond_001")).toBeCloseTo(96, 6);
    expect(bondLength(next, "bond_002")).toBeCloseTo(96, 6);
    expect(next.style.bondLengths).toEqual({ bond_001: 96, bond_002: 96 });
  });

  it("clears molecule ring styles without changing base molecule style or chemistry", () => {
    const base = createPhase4Document("Ring Style Clear");
    const molecule = benzeneRingMolecule();
    const ringKey = "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006";
    const target = { objectId: molecule.id, kind: "ring" as const, ringKey };
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule },
      { op: "setSelection", pageId: base.pages[0].id, objectIds: [molecule.id] }
    ]);
    const styled = applyMoleculeRingFillOpacity(
      applyMoleculeRingFillColor(document, target, "#d02626"),
      target,
      0.42
    );

    const cleared = clearMoleculeRingStyles(styled, [molecule.id]);
    const next = moleculeById(cleared, molecule.id);

    expect(next.style.ringStyles).toBeUndefined();
    expect(next.atoms).toEqual(molecule.atoms);
    expect(next.bonds).toEqual(molecule.bonds);
    expect(next.structure).toBe(molecule.structure);
    expect(clearMoleculeRingStyles(cleared, [molecule.id])).toBe(cleared);
  });

  it("prunes ring styles when a topology edit removes that ring", () => {
    const base = createPhase4Document("Ring Prune");
    const molecule = benzeneRingMolecule();
    const ringKey = "bond_001|bond_002|bond_003|bond_004|bond_005|bond_006";
    const target = { objectId: molecule.id, kind: "ring" as const, ringKey };
    const document = applyPatches(base, [
      { op: "addObject", pageId: base.pages[0].id, object: molecule }
    ]);
    const styled = applyMoleculeRingFillColor(document, target, "#2c7a3f");

    const broken = applyNativeMoleculeDeleteTarget(styled, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    });

    expect(moleculeById(broken, molecule.id).style.ringStyles).toBeUndefined();
  });
});

describe("nativeSingleBondGraphSmiles general graph writer", () => {
  // Fused bicyclic (naphthalene/decalin) skeleton: two six-membered rings sharing the a05-a10
  // edge, 10 carbons and 11 bonds. Only the bond orders vary between the aromatic and the
  // saturated forms, so callers pass the set of edges that should be double bonds.
  const fusedBicyclicSkeleton = (
    doubleBondPairs: ReadonlyArray<readonly [string, string]>
  ): { atoms: MoleculeAtom[]; bonds: MoleculeBond[] } => {
    const atomIds = ["a01", "a02", "a03", "a04", "a05", "a06", "a07", "a08", "a09", "a10"];
    const atoms: MoleculeAtom[] = atomIds.map((id, index) => ({
      id,
      element: "C",
      x: index * 10,
      y: 0,
      formalCharge: 0
    }));
    const edges: ReadonlyArray<readonly [string, string]> = [
      ["a01", "a02"], ["a02", "a03"], ["a03", "a04"], ["a04", "a05"],
      ["a05", "a10"], ["a05", "a06"], ["a06", "a07"], ["a07", "a08"],
      ["a08", "a09"], ["a09", "a10"], ["a10", "a01"]
    ];
    const pairKey = (from: string, to: string): string => [from, to].sort().join("::");
    const doubleBonds = new Set(doubleBondPairs.map(([from, to]) => pairKey(from, to)));
    const bonds: MoleculeBond[] = edges.map(([from, to], index) => ({
      id: `bond_${String(index + 1).padStart(3, "0")}`,
      fromAtomId: from,
      toAtomId: to,
      order: doubleBonds.has(pairKey(from, to)) ? "double" : "single"
    }));
    return { atoms, bonds };
  };

  const reparse = (smiles: string): { formula: string; ringCount: number } => {
    const molecule = OCL.Molecule.fromSmiles(smiles);
    molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
    return {
      formula: molecule.getMolecularFormula().formula,
      ringCount: molecule.getRingSet().getSize()
    };
  };

  it("linearizes fused naphthalene into a two-ring SMILES that OpenChemLib reparses to C10H8", () => {
    const { atoms, bonds } = fusedBicyclicSkeleton([
      ["a01", "a02"], ["a03", "a04"], ["a05", "a10"], ["a06", "a07"], ["a08", "a09"]
    ]);

    const smiles = nativeSingleBondGraphSmiles(atoms, bonds);

    // The old fallback concatenated bare atom symbols, collapsing naphthalene to the decane
    // chain "CCCCCCCCCC" — no ring closures, no bonds preserved.
    expect(smiles).not.toBe("CCCCCCCCCC");
    expect(smiles).toMatch(/\d/);
    expect(reparse(smiles)).toEqual({ formula: "C10H8", ringCount: 2 });
  });

  it("linearizes saturated decalin into a two-ring SMILES that OpenChemLib reparses to C10H18", () => {
    const { atoms, bonds } = fusedBicyclicSkeleton([]);

    const smiles = nativeSingleBondGraphSmiles(atoms, bonds);

    expect(smiles).not.toContain("=");
    expect(smiles).toMatch(/\d/);
    expect(reparse(smiles)).toEqual({ formula: "C10H18", ringCount: 2 });
  });

  it("joins a ringed component and a chain component with a dot instead of fusing them", () => {
    const { atoms: ringAtoms, bonds: ringBonds } = fusedBicyclicSkeleton([]);
    const chainAtoms: MoleculeAtom[] = [
      { id: "z1", element: "C", x: 0, y: 100, formalCharge: 0 },
      { id: "z2", element: "C", x: 10, y: 100, formalCharge: 0 }
    ];
    const chainBonds: MoleculeBond[] = [
      { id: "chain_bond", fromAtomId: "z1", toAtomId: "z2", order: "single" }
    ];

    const smiles = nativeSingleBondGraphSmiles([...ringAtoms, ...chainAtoms], [...ringBonds, ...chainBonds]);

    expect(smiles.split(".")).toHaveLength(2);
    expect(reparse(smiles)).toEqual({ formula: "C12H24", ringCount: 2 });
  });
});
