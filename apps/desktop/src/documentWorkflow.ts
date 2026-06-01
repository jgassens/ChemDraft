import {
  applyPatch,
  applyPatches,
  createEmptyDocument,
  createPageLayout,
  deserializeDocument,
  pageMarginFromLayout,
  serializeDocument,
  type ChemDraftDocument,
  type ChemicalMetadata,
  type CompatibilityWarning,
  type DocumentObject,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  type PageOrientation,
  type PageSizePresetId
} from "@chemdraft/chem-core";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import type { EditorSaveResult } from "@chemdraft/editor-adapter";
import { exportDocumentToSvg, type SvgExportResult } from "@chemdraft/export-engine";

export const phase4Timestamp = "2026-05-29T00:00:00.000Z";

export interface NativeSavePayload {
  filename: string;
  mimeType: "application/vnd.chemdraft+json";
  contents: string;
}

export interface PagePoint {
  x: number;
  y: number;
}

export const nativeSingleBondDimensions = {
  width: 96,
  height: 32
} as const;

const nativeBondLength = 80;
const nativeMoleculePadding = 8;
const extensionHitRadius = 104;

export function createPhase4Document(title = "Untitled.chemdraft"): ChemDraftDocument {
  return createEmptyDocument({
    title,
    now: phase4Timestamp
  });
}

export function createAdapterFallbackMolecule(
  document: ChemDraftDocument,
  analysis?: StructureAnalysisResult
): MoleculeObject {
  const id = nextObjectId(document, "mol_adapter");

  return {
    id,
    type: "molecule",
    x: 180,
    y: 220,
    width: 190,
    height: 96,
    rotation: 0,
    style: {
      source: "editor-adapter-fallback"
    },
    compatibility: {
      sourceFormat: "editor-adapter-fallback",
      warnings: [
        {
          code: "editor.adapter_fallback",
          message: "Inserted through the Phase 4 adapter-backed fallback because no drawing engine is connected."
        }
      ],
      unknown: {}
    },
    structureFormat: "smiles",
    structure: analysis?.input.value ?? "CCO",
    chemistry: analysis ? chemistryMetadataFromAnalysis(analysis) : undefined,
    atoms: [],
    bonds: [],
    superatoms: [],
    rGroups: []
  };
}

export function insertAdapterFallbackMolecule(
  document: ChemDraftDocument,
  analysis?: StructureAnalysisResult
): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) {
    throw new Error("Cannot insert adapter fallback molecule: document has no pages.");
  }

  const object = createAdapterFallbackMolecule(document, analysis);
  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function createNativeSingleBondMolecule(
  document: ChemDraftDocument,
  point: PagePoint = { x: 228, y: 236 }
): MoleculeObject {
  const page = firstPage(document);
  const center = {
    x: clamp(point.x, nativeBondLength / 2, page.width - nativeBondLength / 2),
    y: clamp(point.y, 0, page.height)
  };
  const leftAtom = {
    id: "atom_001",
    element: "C",
    x: center.x - nativeBondLength / 2,
    y: center.y,
    formalCharge: 0
  } satisfies MoleculeAtom;
  const rightAtom = {
    id: "atom_002",
    element: "C",
    x: center.x + nativeBondLength / 2,
    y: center.y,
    formalCharge: 0
  } satisfies MoleculeAtom;
  const atoms = [leftAtom, rightAtom];
  const bonds = [{
    id: "bond_001",
    fromAtomId: leftAtom.id,
    toAtomId: rightAtom.id,
    order: "single"
  }] satisfies MoleculeBond[];
  const geometry = moleculeGeometryFromAtoms(atoms);

  return normalizeNativeMoleculeGeometry({
    id: nextObjectId(document, "mol_bond"),
    type: "molecule",
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    rotation: 0,
    style: {
      source: "chemdraft-native-drawing",
      drawingPrimitive: "single-bond"
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    structureFormat: "smiles",
    structure: carbonChainSmiles(atoms.length),
    chemistry: alkaneMetadata(atoms.length),
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  });
}

export function insertNativeSingleBondMolecule(
  document: ChemDraftDocument,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeSingleBondMolecule(document, point);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function applySingleBondToolAtPoint(
  document: ChemDraftDocument,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  const selected = getSelectedMolecule(document);
  const extended = selected ? extendNativeCarbonChain(selected, point, page.width, page.height) : undefined;

  if (!selected || !extended) {
    return insertNativeSingleBondMolecule(document, point);
  }

  return applyPatches(
    document,
    [
      { op: "updateObject", objectId: selected.id, changes: extended },
      { op: "setSelection", pageId: page.id, objectIds: [selected.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function getSelectedObject(document: ChemDraftDocument): DocumentObject | undefined {
  const selectedObjectId = document.selection.objectIds[0];
  if (!selectedObjectId) {
    return undefined;
  }

  for (const page of document.pages) {
    const object = page.objects.find((candidate) => candidate.id === selectedObjectId);
    if (object) {
      return object;
    }
  }

  return undefined;
}

export function getSelectedMolecule(document: ChemDraftDocument): MoleculeObject | undefined {
  const object = getSelectedObject(document);
  return object?.type === "molecule" ? object : undefined;
}

export function applyAnalysisToSelectedMolecule(
  document: ChemDraftDocument,
  analysis: StructureAnalysisResult
): ChemDraftDocument {
  const selectedMolecule = getSelectedMolecule(document);
  if (!selectedMolecule) {
    throw new Error("Cannot apply chemistry analysis: no molecule is selected.");
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: selectedMolecule.id,
      changes: {
        chemistry: chemistryMetadataFromAnalysis(analysis)
      }
    },
    { now: phase4Timestamp }
  );
}

export function applyEditorSaveResultToSelectedObject(
  document: ChemDraftDocument,
  result: EditorSaveResult
): ChemDraftDocument {
  const selectedObject = getSelectedObject(document);
  if (!selectedObject) {
    throw new Error("Cannot apply editor save result: no document object is selected.");
  }
  if (selectedObject.id !== result.object.id) {
    throw new Error(
      `Cannot apply editor save result: selected object "${selectedObject.id}" does not match saved object "${result.object.id}".`
    );
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: result.object.id,
      changes: result.object
    },
    { now: phase4Timestamp }
  );
}

export function createNativeSavePayload(document: ChemDraftDocument): NativeSavePayload {
  return {
    filename: `${sanitizeFilename(document.title.replace(/\.chemdraft$/i, ""))}.chemdraft`,
    mimeType: "application/vnd.chemdraft+json",
    contents: serializeDocument(document)
  };
}

export function openNativeDocument(contents: string): ChemDraftDocument {
  return deserializeDocument(contents);
}

export function setDocumentPageSize(document: ChemDraftDocument, presetId: PageSizePresetId): ChemDraftDocument {
  const page = firstPage(document);
  const layout = createPageLayout(presetId, page.layout.orientation, pageMarginFromLayout(page.layout));

  return applyPatch(
    document,
    {
      op: "updatePageLayout",
      pageId: page.id,
      layout
    },
    { now: phase4Timestamp }
  );
}

export function setDocumentPageOrientation(
  document: ChemDraftDocument,
  orientation: PageOrientation
): ChemDraftDocument {
  const page = firstPage(document);
  const layout = createPageLayout(page.layout.presetId, orientation, pageMarginFromLayout(page.layout));

  return applyPatch(
    document,
    {
      op: "updatePageLayout",
      pageId: page.id,
      layout
    },
    { now: phase4Timestamp }
  );
}

export function exportPhase4Svg(document: ChemDraftDocument): SvgExportResult {
  return exportDocumentToSvg(document, { includeWarnings: true });
}

export function chemistryMetadataFromAnalysis(result: StructureAnalysisResult): ChemicalMetadata {
  return {
    formula: result.properties.formula,
    averageMass: result.properties.averageMass,
    exactMass: result.properties.exactMass,
    atomCount: result.properties.atomCount,
    bondCount: result.properties.bondCount,
    totalCharge: result.properties.totalCharge,
    radicalCount: 0,
    isotopeLabels: [],
    stereochemistry: result.properties.stereochemistry,
    warnings: chemistryWarningsToCompatibilityWarnings(result.warnings)
  };
}

function chemistryWarningsToCompatibilityWarnings(warnings: StructureAnalysisResult["warnings"]): CompatibilityWarning[] {
  return warnings.map((warning) => ({
    code: warning.code,
    message: warning.message
  }));
}

function nextObjectId(document: ChemDraftDocument, prefix: string): string {
  const existingIds = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  let index = existingIds.size + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;

  while (existingIds.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }

  return id;
}

function firstPage(document: ChemDraftDocument): ChemDraftDocument["pages"][number] {
  const page = document.pages[0];
  if (!page) {
    throw new Error("Cannot update page layout: document has no pages.");
  }

  return page;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return sanitized || "Untitled";
}

function extendNativeCarbonChain(
  molecule: MoleculeObject,
  point: PagePoint,
  pageWidth: number,
  pageHeight: number
): MoleculeObject | undefined {
  if (!isEditableNativeCarbonChain(molecule)) {
    return undefined;
  }

  const terminal = nearestTerminalAtom(molecule, point);
  if (!terminal) {
    return undefined;
  }
  if (!isPointNearObject(point, molecule) && terminal.distance > extensionHitRadius) {
    return undefined;
  }

  const direction = extensionDirection(molecule, terminal.atom, point);
  const newAtom: MoleculeAtom = {
    id: nextIndexedId("atom", molecule.atoms.map((atom) => atom.id)),
    element: "C",
    x: clamp(terminal.atom.x + direction.x * nativeBondLength, 0, pageWidth),
    y: clamp(terminal.atom.y + direction.y * nativeBondLength, 0, pageHeight),
    formalCharge: 0
  };
  const atoms = [...molecule.atoms, newAtom];
  const bonds = [
    ...molecule.bonds,
    {
      id: nextIndexedId("bond", molecule.bonds.map((bond) => bond.id)),
      fromAtomId: terminal.atom.id,
      toAtomId: newAtom.id,
      order: "single" as const
    }
  ];

  return normalizeNativeMoleculeGeometry({
    ...molecule,
    structure: carbonChainSmiles(atoms.length),
    chemistry: alkaneMetadata(atoms.length),
    atoms,
    bonds
  });
}

function isEditableNativeCarbonChain(molecule: MoleculeObject): boolean {
  return (
    molecule.style.source === "chemdraft-native-drawing" &&
    molecule.atoms.length >= 2 &&
    molecule.bonds.length >= 1 &&
    molecule.atoms.every((atom) => atom.element === "C" && atom.formalCharge === 0) &&
    molecule.bonds.every((bond) => bond.order === "single")
  );
}

function nearestTerminalAtom(
  molecule: MoleculeObject,
  point: PagePoint
): { atom: MoleculeAtom; distance: number } | undefined {
  const degrees = atomDegrees(molecule);
  const terminals = molecule.atoms.filter((atom) => (degrees.get(atom.id) ?? 0) <= 1);
  const nearest = terminals
    .map((atom) => ({ atom, distance: distance(atom, point) }))
    .sort((left, right) => left.distance - right.distance)[0];

  return nearest;
}

function extensionDirection(
  molecule: MoleculeObject,
  terminalAtom: MoleculeAtom,
  point: PagePoint
): PagePoint {
  const neighbor = bondedNeighbor(molecule, terminalAtom.id);
  const outward = neighbor ? normalize({
    x: terminalAtom.x - neighbor.x,
    y: terminalAtom.y - neighbor.y
  }) : { x: 1, y: 0 };
  const towardClick = normalize({
    x: point.x - terminalAtom.x,
    y: point.y - terminalAtom.y
  });
  const rawDirection = dot(towardClick, outward) >= 0.25 ? towardClick : outward;

  return snapDirectionToThirtyDegrees(rawDirection);
}

function normalizeNativeMoleculeGeometry(molecule: MoleculeObject): MoleculeObject {
  const geometry = moleculeGeometryFromAtoms(molecule.atoms);
  return {
    ...molecule,
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height
  };
}

function moleculeGeometryFromAtoms(atoms: readonly MoleculeAtom[]): Pick<MoleculeObject, "x" | "y" | "width" | "height"> {
  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const x = minX - nativeMoleculePadding;
  const y = minY - nativeSingleBondDimensions.height / 2;

  return {
    x,
    y,
    width: Math.max(nativeSingleBondDimensions.width, maxX - minX + nativeMoleculePadding * 2),
    height: Math.max(nativeSingleBondDimensions.height, maxY - minY + nativeSingleBondDimensions.height)
  };
}

function alkaneMetadata(atomCount: number): ChemicalMetadata {
  const hydrogenCount = atomCount * 2 + 2;
  return {
    formula: `C${atomCount}H${hydrogenCount}`,
    averageMass: Number((atomCount * 12.011 + hydrogenCount * 1.008).toFixed(3)),
    exactMass: Number((atomCount * 12 + hydrogenCount * 1.00782503223).toFixed(5)),
    atomCount,
    bondCount: Math.max(0, atomCount - 1),
    totalCharge: 0,
    radicalCount: 0,
    isotopeLabels: [],
    stereochemistry: [],
    warnings: []
  };
}

function carbonChainSmiles(atomCount: number): string {
  return "C".repeat(Math.max(1, atomCount));
}

function atomDegrees(molecule: MoleculeObject): Map<string, number> {
  const degrees = new Map(molecule.atoms.map((atom) => [atom.id, 0]));
  molecule.bonds.forEach((bond) => {
    degrees.set(bond.fromAtomId, (degrees.get(bond.fromAtomId) ?? 0) + 1);
    degrees.set(bond.toAtomId, (degrees.get(bond.toAtomId) ?? 0) + 1);
  });
  return degrees;
}

function bondedNeighbor(molecule: MoleculeObject, atomId: string): MoleculeAtom | undefined {
  const bond = molecule.bonds.find((candidate) => candidate.fromAtomId === atomId || candidate.toAtomId === atomId);
  const neighborId = bond?.fromAtomId === atomId ? bond.toAtomId : bond?.fromAtomId;
  return molecule.atoms.find((atom) => atom.id === neighborId);
}

function isPointNearObject(point: PagePoint, object: MoleculeObject): boolean {
  return (
    point.x >= object.x - extensionHitRadius &&
    point.x <= object.x + object.width + extensionHitRadius &&
    point.y >= object.y - extensionHitRadius &&
    point.y <= object.y + object.height + extensionHitRadius
  );
}

function nextIndexedId(prefix: string, ids: readonly string[]): string {
  const existing = new Set(ids);
  let index = ids.length + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;
  while (existing.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }
  return id;
}

function distance(left: PagePoint, right: PagePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function normalize(vector: PagePoint): PagePoint {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.0001) {
    return { x: 1, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function dot(left: PagePoint, right: PagePoint): number {
  return left.x * right.x + left.y * right.y;
}

function snapDirectionToThirtyDegrees(direction: PagePoint): PagePoint {
  const angle = Math.atan2(direction.y, direction.x);
  const snapped = Math.round(angle / (Math.PI / 6)) * (Math.PI / 6);
  return {
    x: Math.cos(snapped),
    y: Math.sin(snapped)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
