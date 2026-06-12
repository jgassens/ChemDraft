import {
  applyPatch,
  applyPatches,
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  createPageLayout,
  pageMarginFromLayout,
  nativeTextStyleFromObjectStyle,
  stylePresetToObjectStyle,
  textStyleToObjectStyle,
  type ChemDraftDocument,
  type ChemicalMetadata,
  type CompatibilityWarning,
  type DocumentObject,
  type ElectronMarkObject,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  type MoleculeTransformState,
  type NativeTextStyle,
  type ObjectReorderPlacement,
  type PageOrientation,
  type PageSizePresetId,
  type TextSpan,
  type TextObject
} from "@chemdraft/chem-core";
import {
  exportDocumentToCdxml,
  openChemDraftPayload,
  sha256Utf8Hex,
  type ChemDraftOpenResult,
  type CompatibilityConversionWarning
} from "@chemdraft/cdx-compat";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import type { EditorSaveResult } from "@chemdraft/editor-adapter";
import { exportDocumentToSvg, type SvgExportResult } from "@chemdraft/export-engine";
import {
  findNearestAtomAtPoint,
  findNearestBondHit,
  planBondExtension,
  planFreeformBondExtension,
  type LayoutPoint
} from "@chemdraft/layout-engine";
import {
  extractRxnMolfileBlocks,
  parseMolfileGraph,
  type ClipboardDetectedPayload,
  type ClipboardMolfileFormat,
  type ClipboardTransferWarning,
  type ParsedMolfileGraph
} from "@chemdraft/clipboard-adapter";

export const phase4Timestamp = "2026-05-29T00:00:00.000Z";

export interface NativeSavePayload {
  filename: string;
  mimeType: "chemical/x-cdxml";
  contents: string;
  warnings: CompatibilityConversionWarning[];
  payloadHash: string;
}

export interface ClipboardPasteResult {
  document: ChemDraftDocument;
  status: string;
  kind: ClipboardDetectedPayload["kind"];
  selectedObjectId?: string;
  editTextObjectId?: string;
  warnings: ClipboardTransferWarning[];
}

export interface NativeTextSelectionRange {
  start: number;
  end: number;
}

export type NativeMoleculeColorTarget =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "parts"; atomIds: readonly string[]; bondIds: readonly string[] };

export interface ToolbarColorSelection {
  objectIds: readonly string[];
  moleculePart?: NativeMoleculeColorTarget;
  textRange?: { objectId: string; range: NativeTextSelectionRange };
}

export interface ToolbarColorApplyResult {
  document: ChemDraftDocument;
  changed: boolean;
  targetedSelection: boolean;
}

export type PagePoint = LayoutPoint;
export type PageRect = PagePoint & {
  width: number;
  height: number;
};

export interface NativeBondGrowthPreview {
  atomId: string;
  targetAtomId?: string;
  direction: PagePoint;
  candidateDirections: PagePoint[];
  newAtomPoint: PagePoint;
  distanceToPointer: number;
  availableBonds: number;
}

export interface NativeFreeformBondGrowthPreview extends NativeBondGrowthPreview {
  targetAtomId?: string;
  customLength: boolean;
  length: number;
  lengthAngstrom: number;
}

export type NativeBondDisplayStyle = NonNullable<NonNullable<MoleculeBond["display"]>["bondStyle"]>;
export type NativeBondToolStyle = "solid" | NativeBondDisplayStyle;
export type NativeMoleculeTemplateId =
  | "cyclopentane"
  | "cyclohexane"
  | "benzene"
  | "chairCyclohexaneA"
  | "chairCyclohexaneB";

export interface NativeBondToolOptions {
  bondStyle?: NativeBondDisplayStyle;
}

export interface NativeFreeformBondGrowthOptions extends NativeBondToolOptions {
  forceCustomLength?: boolean;
}

/**
 * Where a resolved pointer hit came from. `model` = pure geometric hit (the source of
 * truth); `atom-dom-tiebreak` = an atom adopted from the DOM element under the pointer to
 * rescue a near-miss. Bonds are ALWAYS `model` (invariant: the DOM never assigns bond
 * identity). Absent on non-pointer hits (keyboard/programmatic), which don't track it.
 */
export type NativeHitProvenance = "model" | "atom-dom-tiebreak";

export type NativeMoleculeDeleteHit =
  | {
      kind: "atom";
      atomId: string;
      distanceToPointer: number;
      source?: NativeHitProvenance;
    }
  | {
      kind: "bond";
      bondId: string;
      fromAtomId: string;
      toAtomId: string;
      terminalAtomId?: string;
      distanceToPointer: number;
      source?: NativeHitProvenance;
    };

export type NativeMoleculeDeleteTarget = NativeMoleculeDeleteHit & { objectId: string };
export type NativeBondOrderTarget = Extract<NativeMoleculeDeleteHit, { kind: "bond" }> & { objectId: string };
export type NativeBondOrderValue = Extract<MoleculeBond["order"], "single" | "double" | "triple">;
export type NativeMoleculePartReorderTarget =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "parts"; atomIds: readonly string[]; bondIds: readonly string[] };
export type NativeMoleculePartMoveTarget = NativeMoleculePartReorderTarget;
export type NativeDoubleBondSide = NonNullable<MoleculeBond["display"]>["doubleBondSide"];
export type NativeChargeValue = -1 | 1;

export interface ProjectedPlaneTiltPoint {
  x: number;
  y: number;
}

export interface ProjectedPlaneTiltResult extends ProjectedPlaneTiltPoint {
  z: number;
}

export interface ProjectedPlaneTiltClamp {
  tiltRad: number;
  clamped: boolean;
}

interface ProjectedPlaneTiltVectorClamp {
  tiltXRad: number;
  tiltYRad: number;
  clamped: boolean;
}

export interface ProjectedPlaneTiltOptions {
  mutateWhenClamped?: boolean;
  fromTiltRad?: number;
  fromTiltYRad?: number;
  tiltYRad?: number;
  fromRotationDegrees?: number;
  rotationDegrees?: number;
  persistTransform?: boolean;
}

export interface ProjectedPlaneTiltDocumentResult {
  document: ChemDraftDocument;
  tiltRad: number;
  tiltXRad: number;
  tiltYRad: number;
  rotationDegrees: number;
  clamped: boolean;
  changed: boolean;
}

const defaultNativeMoleculeTransform: MoleculeTransformState = {
  scaleX: 1,
  scaleY: 1,
  rotationDegrees: 0
};

const projectedPlaneTiltMaxDegrees = 360;

export const projectedPlaneTiltMaxRadians = projectedPlaneTiltMaxDegrees * Math.PI / 180;

export const nativeSingleBondDimensions = {
  width: 48,
  height: 32
} as const;
export const nativeTextObjectDimensions = {
  width: 240,
  height: 56
} as const;
export const nativeTextObjectMinimumDimensions = {
  width: 36,
  height: 24
} as const;

export const nativeBondLengthPx = ChemDraftSyntheticStylePreset.drawing.bondLengthPx;
export const nativeAtomHitRadiusPx = 8;
export const nativeChargeMarkSizePx = 18;
export const nativeChargeAssociationRadiusPx = nativeBondLengthPx * 1.15;

const nativeBondLength = nativeBondLengthPx;
const nativeCarbonSingleBondLengthAngstrom = 1.56;
const nativeMoleculePadding = 8;
const atomHitRadius = nativeAtomHitRadiusPx;
const bondHitRadius = 4;
const nativeAtomInvalidGrowthLimit = 8;
const freeformMinimumBondLength = 4.5;
const freeformCustomLengthBreakawayDistance = nativeBondLength * 1.4;
const nativeTextBoxHorizontalPadding = 6;
const nativeTextBoxVerticalPadding = 4;

export const nativeElementSymbols = [
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
  "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
  "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
  "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
  "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
  "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
  "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
  "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
  "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
  "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
  "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds",
  "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og"
] as const;
export type NativeElementSymbol = typeof nativeElementSymbols[number];
export const nativeSingleLetterElements = ["H", "B", "C", "N", "O", "F", "P", "S", "I"] as const;
export type NativeSingleLetterElement = typeof nativeSingleLetterElements[number];

export interface NativeAtomValidationState {
  atomId: string;
  element: string;
  valenceUsed: number;
  formalCharge: number;
  expectedFormalCharge?: number;
  valid: boolean;
  invalidReason?: string;
}

export interface NativeChargeAssociation {
  chargeObjectId: string;
  atomId: string;
  moleculeId: string;
  charge: NativeChargeValue;
  distance: number;
}

const nativeElementSymbolSet = new Set<string>(nativeElementSymbols);
const nativeSingleLetterElementSet = new Set<string>(nativeSingleLetterElements);
const nativeAtomValence: Partial<Record<NativeElementSymbol, number>> = {
  H: 1,
  B: 3,
  C: 4,
  N: 3,
  O: 2,
  F: 1,
  Si: 4,
  P: 3,
  S: 2,
  Cl: 1,
  Br: 1,
  I: 1
};
const nativeAtomMaxValence: Partial<Record<NativeElementSymbol, number>> = {
  H: 1,
  B: 4,
  C: 4,
  N: 4,
  O: 3,
  F: 1,
  Si: 4,
  P: 5,
  S: 6,
  Cl: 1,
  Br: 1,
  I: 1
};
const nativeAtomMass: Partial<Record<NativeElementSymbol, { average: number; exact: number }>> = {
  H: { average: 1.008, exact: 1.00782503223 },
  B: { average: 10.81, exact: 11.00930536 },
  C: { average: 12.011, exact: 12 },
  N: { average: 14.007, exact: 14.00307400443 },
  O: { average: 15.999, exact: 15.99491461957 },
  F: { average: 18.998, exact: 18.99840316273 },
  Si: { average: 28.085, exact: 27.97692653465 },
  P: { average: 30.974, exact: 30.97376199842 },
  S: { average: 32.06, exact: 31.9720711744 },
  Cl: { average: 35.45, exact: 34.968852682 },
  Br: { average: 79.904, exact: 78.9183376 },
  I: { average: 126.904, exact: 126.9044719 }
};
const nativeBondOrderValue: Record<MoleculeBond["order"], number> = {
  single: 1,
  double: 2,
  triple: 3,
  aromatic: 1,
  unknown: 1
};

export function nativeElementFromKeyboardKey(key: string): NativeSingleLetterElement | undefined {
  const normalized = key.trim().toUpperCase();
  return nativeSingleLetterElementSet.has(normalized)
    ? normalized as NativeSingleLetterElement
    : undefined;
}

export function normalizeNativeAtomElementLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const elementCandidate = `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1).toLowerCase()}`;
  return nativeElementSymbolSet.has(elementCandidate) ? elementCandidate : trimmed;
}

export function nativeElementFromAtomLabel(value: string): NativeElementSymbol | undefined {
  const normalized = normalizeNativeAtomElementLabel(value);
  return nativeElementSymbolSet.has(normalized) ? normalized as NativeElementSymbol : undefined;
}

export function nativeAtomDisplayLabel(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[]
): string | undefined {
  const element = nativeElementFromAtomLabel(atom.element);
  if (!element) {
    const symbol = atom.element.trim() || "C";
    return `${symbol}${atomChargeLabelSuffix(atom.formalCharge)}`;
  }
  const valenceUsed = nativeAtomBondOrderUsage(atom.id, bonds);
  const implicitHydrogenCount = nativeImplicitHydrogenCount(element, valenceUsed);
  const formalCharge = atom.formalCharge;

  if (element === "C" && valenceUsed > 0 && formalCharge === 0 && atom.labelVisible !== true) {
    return undefined;
  }

  return `${element}${implicitHydrogenLabelSuffix(implicitHydrogenCount)}${atomChargeLabelSuffix(formalCharge)}`;
}

export function nativeAtomValidationState(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[],
  effectiveFormalCharge = atom.formalCharge
): NativeAtomValidationState {
  const element = nativeElementFromAtomLabel(atom.element);
  const valenceUsed = nativeAtomBondOrderUsage(atom.id, bonds);

  if (!element) {
    const symbol = atom.element.trim() || "(blank)";
    return {
      atomId: atom.id,
      element: symbol,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: true
    };
  }

  if (nativeAtomValence[element] === undefined || nativeAtomMaxValence[element] === undefined) {
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: true
    };
  }

  const expectedFormalCharge = nativeAtomFormalChargeForValence(element, valenceUsed);

  if (expectedFormalCharge === undefined) {
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: false,
      invalidReason: `${element} atom ${atom.id} has unsupported valence ${valenceUsed}.`
    };
  }

  if (effectiveFormalCharge !== expectedFormalCharge) {
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      expectedFormalCharge,
      valid: false,
      invalidReason: `${element} atom ${atom.id} has charge ${effectiveFormalCharge}, expected ${expectedFormalCharge} for valence ${valenceUsed}.`
    };
  }

  return {
    atomId: atom.id,
    element,
    valenceUsed,
    formalCharge: effectiveFormalCharge,
    expectedFormalCharge,
    valid: true
  };
}

export function nativeMoleculeInvalidAtomStates(
  molecule: MoleculeObject,
  chargeByAtomId: ReadonlyMap<string, number> = new Map()
): NativeAtomValidationState[] {
  return molecule.atoms
    .map((atom) => nativeAtomValidationState(atom, molecule.bonds, atom.formalCharge + (chargeByAtomId.get(atom.id) ?? 0)))
    .filter((state) => !state.valid);
}

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
    transform: defaultNativeMoleculeTransform,
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
  point: PagePoint = { x: 228, y: 236 },
  options: NativeBondToolOptions = {}
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
    order: "single",
    ...nativeBondDisplayObject(options.bondStyle)
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
    transform: defaultNativeMoleculeTransform,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      source: "chemdraft-native-drawing",
      drawingPrimitive: "single-bond"
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, bonds),
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  });
}

export function insertNativeSingleBondMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  options: NativeBondToolOptions = {}
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeSingleBondMolecule(document, point, options);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function nativeBondStyleForToolCommand(commandId: string): NativeBondToolStyle | undefined {
  switch (commandId) {
    case "tool.bond":
      return "solid";
    case "tool.wedgeBond":
      return "wedge";
    case "tool.hashedBond":
      return "hashed";
    case "tool.dashedBond":
      return "dashed";
    case "tool.boldBond":
      return "bold";
    default:
      return undefined;
  }
}

export function nativeTemplateForToolCommand(commandId: string): NativeMoleculeTemplateId | undefined {
  switch (commandId) {
    case "tool.cyclopentane":
      return "cyclopentane";
    case "tool.cyclohexane":
      return "cyclohexane";
    case "tool.benzene":
      return "benzene";
    case "tool.chairCyclohexaneA":
      return "chairCyclohexaneA";
    case "tool.chairCyclohexaneB":
      return "chairCyclohexaneB";
    default:
      return undefined;
  }
}

export function createNativeTemplateMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  templateId: NativeMoleculeTemplateId
): MoleculeObject {
  const page = firstPage(document);
  const center = {
    x: clamp(point.x, nativeBondLength, page.width - nativeBondLength),
    y: clamp(point.y, nativeBondLength, page.height - nativeBondLength)
  };
  const geometry = nativeTemplateGeometry(center, templateId);
  const atoms = geometry.atoms;
  const bonds = geometry.bonds;
  const moleculeGeometry = moleculeGeometryFromAtoms(atoms);

  return normalizeNativeMoleculeGeometry({
    id: nextObjectId(document, "mol_template"),
    type: "molecule",
    x: moleculeGeometry.x,
    y: moleculeGeometry.y,
    width: moleculeGeometry.width,
    height: moleculeGeometry.height,
    rotation: 0,
    transform: defaultNativeMoleculeTransform,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      source: "chemdraft-native-drawing",
      drawingPrimitive: templateId
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    structureFormat: "smiles",
    structure: nativeSingleBondGraphSmiles(atoms, bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, bonds),
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  });
}

export function insertNativeTemplateMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  templateId: NativeMoleculeTemplateId
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeTemplateMolecule(document, point, templateId);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

/**
 * A resolved, ready-to-commit template placement. Computing it is pure (no document mutation),
 * so the SAME plan can be rendered as a ghost preview and then applied — preview and commit can
 * never diverge. `molecule` is the post-placement graph (a brand-new ring for "standalone", the
 * edited graph otherwise); `addedAtomIds`/`addedBondIds` are the parts new to this placement
 * (for preview/selection). `fused-closure` is produced once closure-merge lands (Stage D); for
 * now bond fusion always reports "fuse-bond".
 */
export type NativeTemplatePlacementPlan = {
  kind: "standalone" | "fuse-bond" | "attach-atom" | "fused-closure";
  templateId: NativeMoleculeTemplateId;
  molecule: MoleculeObject;
  objectId?: string;
  addedAtomIds: readonly string[];
  addedBondIds: readonly string[];
};

/** Compute the placement a template click would make, without mutating the document. */
export function planNativeTemplatePlacement(
  document: ChemDraftDocument,
  placement: { point: PagePoint; target?: NativeMoleculeDeleteTarget },
  templateId: NativeMoleculeTemplateId
): NativeTemplatePlacementPlan | undefined {
  const { point, target } = placement;
  if (target) {
    const molecule = firstPage(document).objects.find((object): object is MoleculeObject =>
      object.id === target.objectId && object.type === "molecule"
    );
    if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
      return undefined;
    }

    const nextMolecule = target.kind === "bond"
      ? fuseNativeTemplateRingToBond(molecule, target.bondId, point, templateId)
      : attachNativeTemplateRingToAtom(molecule, target.atomId, point, templateId);
    if (!nextMolecule) {
      return undefined;
    }

    const existingAtomIds = new Set(molecule.atoms.map((atom) => atom.id));
    const existingBondIds = new Set(molecule.bonds.map((bond) => bond.id));
    const addedAtomIds = nextMolecule.atoms.filter((atom) => !existingAtomIds.has(atom.id)).map((atom) => atom.id);
    const addedBondIds = nextMolecule.bonds.filter((bond) => !existingBondIds.has(bond.id)).map((bond) => bond.id);
    // A bond fusion that added fewer atoms than the ring contributes in open space reused at
    // least one existing atom — i.e. it closed onto a neighbouring ring (Stage D). Atom targets
    // are always spiro attachment.
    const fusedNewAtoms = nativeTemplateRingSize(templateId) - 2;
    const kind = target.kind === "atom"
      ? "attach-atom"
      : addedAtomIds.length < fusedNewAtoms ? "fused-closure" : "fuse-bond";
    return {
      kind,
      templateId,
      molecule: nextMolecule,
      objectId: molecule.id,
      addedAtomIds,
      addedBondIds
    };
  }

  const molecule = createNativeTemplateMolecule(document, point, templateId);
  return {
    kind: "standalone",
    templateId,
    molecule,
    addedAtomIds: molecule.atoms.map((atom) => atom.id),
    addedBondIds: molecule.bonds.map((bond) => bond.id)
  };
}

/** Commit a plan produced by {@link planNativeTemplatePlacement}. */
export function applyNativeTemplatePlacementPlan(
  document: ChemDraftDocument,
  plan: NativeTemplatePlacementPlan
): ChemDraftDocument {
  const page = firstPage(document);
  if (plan.kind === "standalone") {
    return applyPatches(
      document,
      [
        { op: "addObject", pageId: page.id, object: plan.molecule },
        { op: "setSelection", pageId: page.id, objectIds: [plan.molecule.id] }
      ],
      { now: phase4Timestamp }
    );
  }

  if (!plan.objectId) {
    return document;
  }
  return applyPatches(
    document,
    [
      { op: "updateObject", objectId: plan.objectId, changes: plan.molecule },
      { op: "setSelection", pageId: page.id, objectIds: [plan.objectId] }
    ],
    { now: phase4Timestamp }
  );
}

export function applyNativeTemplateToolAtPoint(
  document: ChemDraftDocument,
  point: PagePoint,
  templateId: NativeMoleculeTemplateId
): ChemDraftDocument {
  const plan = planNativeTemplatePlacement(document, { point }, templateId);
  return plan ? applyNativeTemplatePlacementPlan(document, plan) : document;
}

export function applyNativeTemplateToolAtTarget(
  document: ChemDraftDocument,
  target: NativeMoleculeDeleteTarget,
  point: PagePoint,
  templateId: NativeMoleculeTemplateId
): ChemDraftDocument {
  const plan = planNativeTemplatePlacement(document, { point, target }, templateId);
  return plan ? applyNativeTemplatePlacementPlan(document, plan) : document;
}

function nativeTemplateGeometry(
  center: PagePoint,
  templateId: NativeMoleculeTemplateId
): { atoms: MoleculeAtom[]; bonds: MoleculeBond[] } {
  if (templateId === "cyclopentane") {
    const atoms = regularNativeRingAtoms(center, 5, -Math.PI / 2);
    return { atoms, bonds: nativeRingBonds(atoms, () => ({ order: "single" })) };
  }

  if (templateId === "cyclohexane") {
    const atoms = regularNativeRingAtoms(center, 6, 0);
    return { atoms, bonds: nativeRingBonds(atoms, () => ({ order: "single" })) };
  }

  if (templateId === "benzene") {
    const atoms = regularNativeRingAtoms(center, 6, 0);
    return {
      atoms,
      bonds: nativeRingBonds(atoms, (index, fromAtom, toAtom) => {
        if (index % 2 !== 0) {
          return { order: "single" };
        }

        return {
          order: "double",
          display: { doubleBondSide: doubleBondSideTowardPoint(fromAtom, toAtom, center) }
        };
      })
    };
  }

  return nativeChairCyclohexaneGeometry(center, templateId === "chairCyclohexaneB");
}

function regularNativeRingAtoms(center: PagePoint, size: number, rotation: number): MoleculeAtom[] {
  const radius = nativeBondLength / (2 * Math.sin(Math.PI / size));
  return Array.from({ length: size }, (_, index) => {
    const angle = rotation + index * Math.PI * 2 / size;
    return {
      id: `atom_${String(index + 1).padStart(3, "0")}`,
      element: "C",
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      formalCharge: 0
    };
  });
}

function nativeChairCyclohexaneGeometry(
  center: PagePoint,
  reflected: boolean
): { atoms: MoleculeAtom[]; bonds: MoleculeBond[] } {
  const atoms = nativeChairCyclohexaneBasePoints(reflected).map((point, index) => ({
    id: `atom_${String(index + 1).padStart(3, "0")}`,
    element: "C",
    ...offsetPoint(center, point),
    formalCharge: 0
  }));

  return { atoms, bonds: nativeRingBonds(atoms, () => ({ order: "single" })) };
}

function nativeChairCyclohexaneBasePoints(reflected: boolean): PagePoint[] {
  const points: PagePoint[] = [{ x: 0, y: 0 }];

  nativeChairCyclohexaneDirections(reflected).slice(0, -1).forEach((degrees) => {
    const previous = points[points.length - 1] ?? { x: 0, y: 0 };
    const radians = degrees * Math.PI / 180;
    points.push({
      x: previous.x + Math.cos(radians) * nativeBondLength,
      y: previous.y + Math.sin(radians) * nativeBondLength
    });
  });

  const center = centroidOfPoints(points);
  return points.map((point) => ({
    x: roundGeometryCoordinate(point.x - center.x),
    y: roundGeometryCoordinate(point.y - center.y)
  }));
}

function nativeChairCyclohexaneDirections(reflected: boolean): readonly number[] {
  return reflected
    ? [120, -15, 15, -60, 165, -165]
    : [60, -15, 15, -120, 165, -165];
}

function rotateVector(point: PagePoint, angleRadians: number): PagePoint {
  return {
    x: point.x * Math.cos(angleRadians) - point.y * Math.sin(angleRadians),
    y: point.x * Math.sin(angleRadians) + point.y * Math.cos(angleRadians)
  };
}

function offsetPoint(origin: PagePoint, offset: PagePoint): PagePoint {
  return {
    x: origin.x + offset.x,
    y: origin.y + offset.y
  };
}

function nativeRingBonds(
  atoms: readonly MoleculeAtom[],
  bondForIndex: (
    index: number,
    fromAtom: MoleculeAtom,
    toAtom: MoleculeAtom
  ) => Pick<MoleculeBond, "order" | "display">
): MoleculeBond[] {
  return atoms.map((fromAtom, index) => {
    const toAtom = atoms[(index + 1) % atoms.length] ?? fromAtom;
    const display = bondForIndex(index, fromAtom, toAtom);
    return {
      id: `bond_${String(index + 1).padStart(3, "0")}`,
      fromAtomId: fromAtom.id,
      toAtomId: toAtom.id,
      ...display
    };
  });
}

function doubleBondSideTowardPoint(fromAtom: MoleculeAtom, toAtom: MoleculeAtom, point: PagePoint): NativeDoubleBondSide {
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

function fuseNativeTemplateRingToBond(
  molecule: MoleculeObject,
  bondId: string,
  point: PagePoint,
  templateId: NativeMoleculeTemplateId
): MoleculeObject | undefined {
  const size = nativeTemplateRingSize(templateId);
  const targetBond = molecule.bonds.find((bond) => bond.id === bondId);
  const fromAtom = targetBond
    ? molecule.atoms.find((atom) => atom.id === targetBond.fromAtomId)
    : undefined;
  const toAtom = targetBond
    ? molecule.atoms.find((atom) => atom.id === targetBond.toAtomId)
    : undefined;
  if (!targetBond || !fromAtom || !toAtom || size < 3) {
    return undefined;
  }

  if (isNativeChairTemplate(templateId)) {
    return fuseNativeChairTemplateToBond(
      molecule,
      targetBond,
      fromAtom,
      toAtom,
      point,
      templateId === "chairCyclohexaneB"
    );
  }

  const vertices = nativeRingVerticesForSharedBond(molecule, fromAtom, toAtom, point, size);
  if (!vertices) {
    return undefined;
  }

  // Closure-aware vertex resolution: a proposed ring vertex that lands on an existing atom
  // (a neighbouring ring's rim atom, when closing a fused polycycle like coronene) is REUSED
  // instead of duplicated. The snap radius is below the test floor for distinct atoms
  // (0.25*bondLength), so a plain fusion — whose new vertices sit in open space — never snaps
  // and is byte-identical to before. Only genuine closures take the merge/guard path.
  const sharedAtomIds = new Set([fromAtom.id, toAtom.id]);
  const resolvedSlots: Array<{ id: string } | { vertex: PagePoint }> = [];
  const reusedAtomIds = new Set<string>();
  let closedOntoExisting = false;
  for (const vertex of vertices.slice(2)) {
    const snapped = nearestExistingAtomWithin(molecule, vertex, nativeTemplateClosureSnapPx);
    if (snapped) {
      // A vertex snapping onto a shared atom, or onto an atom already used by this ring, is a
      // degenerate placement (it would collapse the ring) — reject rather than corrupt the graph.
      if (sharedAtomIds.has(snapped.id) || reusedAtomIds.has(snapped.id)) {
        return undefined;
      }
      reusedAtomIds.add(snapped.id);
      resolvedSlots.push({ id: snapped.id });
      closedOntoExisting = true;
    } else {
      resolvedSlots.push({ vertex });
    }
  }

  const newVertexCount = resolvedSlots.filter((slot): slot is { vertex: PagePoint } => "vertex" in slot).length;
  const newAtomIds = nextIndexedIds("atom", molecule.atoms.map((atom) => atom.id), newVertexCount);
  const newAtoms: MoleculeAtom[] = [];
  const ringAtomIds: string[] = [fromAtom.id, toAtom.id];
  for (const slot of resolvedSlots) {
    if ("id" in slot) {
      ringAtomIds.push(slot.id);
      continue;
    }
    const id = newAtomIds[newAtoms.length] ?? nextIndexedId("atom", [...molecule.atoms.map((atom) => atom.id), ...newAtoms.map((atom) => atom.id)]);
    newAtoms.push({ id, element: "C", x: slot.vertex.x, y: slot.vertex.y, formalCharge: 0 } satisfies MoleculeAtom);
    ringAtomIds.push(id);
  }

  const atomById = new Map<string, MoleculeAtom>(molecule.atoms.map((atom) => [atom.id, atom]));
  newAtoms.forEach((atom) => atomById.set(atom.id, atom));
  const ringAtoms = ringAtomIds.map((id) => atomById.get(id) ?? fromAtom);
  const ringCenter = centroidOfPoints(vertices);
  const sharedBondContributesPi = templateId === "benzene"
    ? sharedBondContributesAromaticPi(molecule, targetBond)
    : undefined;

  // Build the ring's edges (skipping the shared edge 0, which is the target bond). An edge that
  // already exists between two atoms — the shared edge, or a rim bond contributed by an adjacent
  // ring during closure — is reused, never duplicated. Only the missing edges get new bonds, and
  // the ring-bond index is preserved so aromatic double-bond placement is unchanged for a plain
  // fusion.
  const newBonds: MoleculeBond[] = [];
  for (let ringBondIndex = 1; ringBondIndex < size; ringBondIndex += 1) {
    const fromAtomId = ringAtomIds[ringBondIndex];
    const toAtomId = ringAtomIds[(ringBondIndex + 1) % size] ?? ringAtomIds[0];
    if (fromAtomId === toAtomId || nativeBondExistsBetween(molecule, fromAtomId, toAtomId)) {
      continue;
    }
    newBonds.push({
      id: "",
      fromAtomId,
      toAtomId,
      ...nativeTemplateRingBondDisplay(
        templateId,
        ringBondIndex,
        size,
        ringAtoms[ringBondIndex] ?? ringAtoms[0] ?? fromAtom,
        ringAtoms[(ringBondIndex + 1) % size] ?? ringAtoms[0] ?? toAtom,
        ringCenter,
        sharedBondContributesPi
      )
    } satisfies MoleculeBond);
  }
  const newBondIds = nextIndexedIds("bond", molecule.bonds.map((bond) => bond.id), newBonds.length);
  newBonds.forEach((bond, index) => {
    // newBondIds is sized to newBonds.length, so the index is always present and the fallback is
    // effectively dead — but mirror the atom path and draw from the already-assigned new bonds too,
    // so it can never mint a colliding id even if it somehow fired.
    bond.id = newBondIds[index]
      ?? nextIndexedId("bond", [...molecule.bonds, ...newBonds.slice(0, index)].map((candidate) => candidate.id));
  });

  // Guard the closure (only when a vertex actually snapped, so plain fusion is untouched): on the
  // single-bond skeleton — BEFORE aromatic normalization, which can otherwise make a fused
  // junction look invalid — no existing carbon may exceed degree 3 for a ring-template closure.
  if (closedOntoExisting && nativeClosureExceedsDegreeCap(molecule, newBonds)) {
    return undefined;
  }

  const fused = refreshNativeSingleBondGraph(
    molecule,
    [...molecule.atoms, ...newAtoms],
    [...molecule.bonds, ...newBonds]
  );
  return templateId === "benzene" ? normalizeNativeAromaticTemplateBonds(fused) : fused;
}

// Closure snap radius. Kept below the minimum distance between two distinct atoms the suite
// guarantees (0.25*bondLength), so a plain fusion (vertices in open space) never snaps and only
// a true closure — whose proposed vertices land essentially on an existing atom — merges.
// NB: this assumes template-spaced geometry. An imported or heavily distorted molecule with atoms
// closer than this radius could let a plain fusion vertex merge onto an unrelated atom;
// nativeClosureExceedsDegreeCap rejects the over-connecting cases, but deriving the radius from the
// actual nearest-neighbour spacing would be more robust if that ever bites.
const nativeTemplateClosureSnapPx = nativeBondLength * 0.2;

function nearestExistingAtomWithin(
  molecule: MoleculeObject,
  point: PagePoint,
  tolerance: number
): MoleculeAtom | undefined {
  let best: MoleculeAtom | undefined;
  let bestDistance = tolerance;
  for (const atom of molecule.atoms) {
    const candidateDistance = Math.hypot(atom.x - point.x, atom.y - point.y);
    if (candidateDistance <= bestDistance) {
      best = atom;
      bestDistance = candidateDistance;
    }
  }
  return best;
}

function nativeBondExistsBetween(molecule: MoleculeObject, fromAtomId: string, toAtomId: string): boolean {
  return molecule.bonds.some((bond) =>
    (bond.fromAtomId === fromAtomId && bond.toAtomId === toAtomId)
    || (bond.fromAtomId === toAtomId && bond.toAtomId === fromAtomId)
  );
}

// True when adding `newBonds` would push any pre-existing carbon past degree 3 on the single-bond
// skeleton — the signature of a bad closure merge (e.g. snapping that folds the ring onto itself).
function nativeClosureExceedsDegreeCap(molecule: MoleculeObject, newBonds: readonly MoleculeBond[]): boolean {
  const degree = new Map<string, number>();
  const bump = (atomId: string) => degree.set(atomId, (degree.get(atomId) ?? 0) + 1);
  molecule.bonds.forEach((bond) => {
    bump(bond.fromAtomId);
    bump(bond.toAtomId);
  });
  newBonds.forEach((bond) => {
    bump(bond.fromAtomId);
    bump(bond.toAtomId);
  });
  return molecule.atoms.some((atom) => (degree.get(atom.id) ?? 0) > 3);
}

function attachNativeTemplateRingToAtom(
  molecule: MoleculeObject,
  atomId: string,
  point: PagePoint,
  templateId: NativeMoleculeTemplateId
): MoleculeObject | undefined {
  const size = nativeTemplateRingSize(templateId);
  const sharedAtom = molecule.atoms.find((atom) => atom.id === atomId);
  if (!sharedAtom || size < 3) {
    return undefined;
  }

  if (isNativeChairTemplate(templateId)) {
    return attachNativeChairTemplateToAtom(
      molecule,
      sharedAtom,
      point,
      templateId === "chairCyclohexaneB"
    );
  }

  const vertices = nativeRingVerticesForSharedAtom(molecule, sharedAtom, point, size);
  if (!vertices) {
    return undefined;
  }

  const nextAtomIds = nextIndexedIds("atom", molecule.atoms.map((atom) => atom.id), size - 1);
  const newAtoms = vertices.slice(1).map((vertex, index) => ({
    id: nextAtomIds[index] ?? nextIndexedId("atom", molecule.atoms.map((atom) => atom.id)),
    element: "C",
    x: vertex.x,
    y: vertex.y,
    formalCharge: 0
  } satisfies MoleculeAtom));
  const ringAtoms = [sharedAtom, ...newAtoms];
  const ringAtomIds = [sharedAtom.id, ...newAtoms.map((atom) => atom.id)];
  const ringCenter = centroidOfPoints(vertices);
  const newBondIds = nextIndexedIds("bond", molecule.bonds.map((bond) => bond.id), size);
  const newBonds = ringAtomIds.map((fromAtomId, index) => {
    const toAtomId = ringAtomIds[(index + 1) % ringAtomIds.length] ?? sharedAtom.id;
    const sourceAtom = ringAtoms[index] ?? sharedAtom;
    const destinationAtom = ringAtoms[(index + 1) % ringAtoms.length] ?? sharedAtom;
    return {
      id: newBondIds[index] ?? nextIndexedId("bond", molecule.bonds.map((bond) => bond.id)),
      fromAtomId,
      toAtomId,
      ...nativeTemplateRingBondDisplay(
        templateId,
        index,
        ringAtomIds.length,
        sourceAtom,
        destinationAtom,
        ringCenter
      )
    } satisfies MoleculeBond;
  });

  const attached = refreshNativeSingleBondGraph(
    molecule,
    [...molecule.atoms, ...newAtoms],
    [...molecule.bonds, ...newBonds]
  );
  return templateId === "benzene" ? normalizeNativeAromaticTemplateBonds(attached) : attached;
}

function isNativeChairTemplate(templateId: NativeMoleculeTemplateId): boolean {
  return templateId === "chairCyclohexaneA" || templateId === "chairCyclohexaneB";
}

function fuseNativeChairTemplateToBond(
  molecule: MoleculeObject,
  targetBond: MoleculeBond,
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  point: PagePoint,
  reflected: boolean
): MoleculeObject | undefined {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const basePoints = nativeChairCyclohexaneBasePoints(reflected);
  const normal = { x: -dy / length, y: dx / length };
  const midpoint = { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };
  const desiredSide = nativeTemplateSideForBond(molecule, fromAtom, toAtom, point, normal);
  const candidates: Array<{
    points: PagePoint[];
    sharedFromIndex: number;
    sharedToIndex: number;
    score: number;
  }> = [];

  basePoints.forEach((sourcePoint, edgeIndex) => {
    const nextIndex = (edgeIndex + 1) % basePoints.length;
    const nextPoint = basePoints[nextIndex] ?? sourcePoint;

    [false, true].forEach((reverse) => {
      const sourceFrom = reverse ? nextPoint : sourcePoint;
      const sourceTo = reverse ? sourcePoint : nextPoint;
      const points = transformNativeTemplatePointsForAnchoredSegment(
        basePoints,
        sourceFrom,
        sourceTo,
        fromAtom,
        toAtom
      );
      if (!points) {
        return;
      }

      const sharedFromIndex = reverse ? nextIndex : edgeIndex;
      const sharedToIndex = reverse ? edgeIndex : nextIndex;
      const newPoints = points.filter((_, index) => index !== sharedFromIndex && index !== sharedToIndex);
      const chairCenter = centroidOfPoints(points);
      const sideScore = (chairCenter.x - midpoint.x) * normal.x + (chairCenter.y - midpoint.y) * normal.y;
      const sidePenalty = sideScore * desiredSide >= 0 ? 0 : 1000;
      const crowding = nativeChairTemplateCrowding(molecule, newPoints, new Set([fromAtom.id, toAtom.id]));

      candidates.push({
        points,
        sharedFromIndex,
        sharedToIndex,
        score: sidePenalty + crowding
      });
    });
  });

  const candidate = candidates.sort((left, right) => left.score - right.score)[0];
  if (!candidate) {
    return undefined;
  }

  const newBaseIndices = candidate.points
    .map((_, index) => index)
    .filter((index) => index !== candidate.sharedFromIndex && index !== candidate.sharedToIndex);
  const nextAtomIds = nextIndexedIds("atom", molecule.atoms.map((atom) => atom.id), newBaseIndices.length);
  const atomIdByBaseIndex = new Map<number, string>([
    [candidate.sharedFromIndex, fromAtom.id],
    [candidate.sharedToIndex, toAtom.id]
  ]);
  const newAtoms = newBaseIndices.map((baseIndex, index) => {
    const pointForAtom = candidate.points[baseIndex] ?? fromAtom;
    const id = nextAtomIds[index] ?? nextIndexedId("atom", molecule.atoms.map((atom) => atom.id));
    atomIdByBaseIndex.set(baseIndex, id);
    return {
      id,
      element: "C",
      x: pointForAtom.x,
      y: pointForAtom.y,
      formalCharge: 0
    } satisfies MoleculeAtom;
  });
  const newBondEdges = candidate.points
    .map((_, index) => [index, (index + 1) % candidate.points.length] as const)
    .filter(([fromIndex, toIndex]) => (
      !nativeChairTemplateEdgeIsShared(fromIndex, toIndex, candidate.sharedFromIndex, candidate.sharedToIndex)
    ));
  const newBondIds = nextIndexedIds("bond", molecule.bonds.map((bond) => bond.id), newBondEdges.length);
  const newBonds = newBondEdges.map(([fromIndex, toIndex], index) => ({
    id: newBondIds[index] ?? nextIndexedId("bond", molecule.bonds.map((bond) => bond.id)),
    fromAtomId: atomIdByBaseIndex.get(fromIndex) ?? fromAtom.id,
    toAtomId: atomIdByBaseIndex.get(toIndex) ?? toAtom.id,
    order: "single"
  } satisfies MoleculeBond));

  return refreshNativeSingleBondGraph(
    molecule,
    [...molecule.atoms, ...newAtoms],
    [...molecule.bonds, ...newBonds]
  );
}

function attachNativeChairTemplateToAtom(
  molecule: MoleculeObject,
  sharedAtom: MoleculeAtom,
  point: PagePoint,
  reflected: boolean
): MoleculeObject | undefined {
  const basePoints = nativeChairCyclohexaneBasePoints(reflected);
  const desiredDirection = nativeTemplateDirectionForAtom(molecule, sharedAtom, point);
  const candidates = basePoints.map((basePoint, sharedIndex) => {
    const centerVector = { x: -basePoint.x, y: -basePoint.y };
    const sourceDirection = Math.atan2(centerVector.y, centerVector.x);
    const rotation = desiredDirection - sourceDirection;
    const points = basePoints.map((pointForAtom) => {
      const relativePoint = {
        x: pointForAtom.x - basePoint.x,
        y: pointForAtom.y - basePoint.y
      };
      const rotatedPoint = rotateVector(relativePoint, rotation);
      return {
        x: roundGeometryCoordinate(sharedAtom.x + rotatedPoint.x),
        y: roundGeometryCoordinate(sharedAtom.y + rotatedPoint.y)
      };
    });
    const newPoints = points.filter((_, index) => index !== sharedIndex);

    return {
      points,
      sharedIndex,
      score: nativeChairTemplateCrowding(molecule, newPoints, new Set([sharedAtom.id]))
    };
  });
  const candidate = candidates.sort((left, right) => left.score - right.score)[0];
  if (!candidate) {
    return undefined;
  }

  const newBaseIndices = candidate.points.map((_, index) => index).filter((index) => index !== candidate.sharedIndex);
  const nextAtomIds = nextIndexedIds("atom", molecule.atoms.map((atom) => atom.id), newBaseIndices.length);
  const atomIdByBaseIndex = new Map<number, string>([[candidate.sharedIndex, sharedAtom.id]]);
  const newAtoms = newBaseIndices.map((baseIndex, index) => {
    const pointForAtom = candidate.points[baseIndex] ?? sharedAtom;
    const id = nextAtomIds[index] ?? nextIndexedId("atom", molecule.atoms.map((atom) => atom.id));
    atomIdByBaseIndex.set(baseIndex, id);
    return {
      id,
      element: "C",
      x: pointForAtom.x,
      y: pointForAtom.y,
      formalCharge: 0
    } satisfies MoleculeAtom;
  });
  const newBondIds = nextIndexedIds("bond", molecule.bonds.map((bond) => bond.id), candidate.points.length);
  const newBonds = candidate.points.map((_, index) => ({
    id: newBondIds[index] ?? nextIndexedId("bond", molecule.bonds.map((bond) => bond.id)),
    fromAtomId: atomIdByBaseIndex.get(index) ?? sharedAtom.id,
    toAtomId: atomIdByBaseIndex.get((index + 1) % candidate.points.length) ?? sharedAtom.id,
    order: "single"
  } satisfies MoleculeBond));

  return refreshNativeSingleBondGraph(
    molecule,
    [...molecule.atoms, ...newAtoms],
    [...molecule.bonds, ...newBonds]
  );
}

function transformNativeTemplatePointsForAnchoredSegment(
  points: readonly PagePoint[],
  sourceFrom: PagePoint,
  sourceTo: PagePoint,
  destinationFrom: PagePoint,
  destinationTo: PagePoint
): PagePoint[] | undefined {
  const sourceVector = { x: sourceTo.x - sourceFrom.x, y: sourceTo.y - sourceFrom.y };
  const destinationVector = {
    x: destinationTo.x - destinationFrom.x,
    y: destinationTo.y - destinationFrom.y
  };
  const sourceLength = Math.hypot(sourceVector.x, sourceVector.y);
  const destinationLength = Math.hypot(destinationVector.x, destinationVector.y);
  if (sourceLength === 0 || destinationLength === 0) {
    return undefined;
  }

  const scale = destinationLength / sourceLength;
  const rotation = Math.atan2(destinationVector.y, destinationVector.x) -
    Math.atan2(sourceVector.y, sourceVector.x);

  return points.map((point) => {
    const scaledPoint = {
      x: (point.x - sourceFrom.x) * scale,
      y: (point.y - sourceFrom.y) * scale
    };
    const rotatedPoint = rotateVector(scaledPoint, rotation);
    return {
      x: roundGeometryCoordinate(destinationFrom.x + rotatedPoint.x),
      y: roundGeometryCoordinate(destinationFrom.y + rotatedPoint.y)
    };
  });
}

function nativeChairTemplateEdgeIsShared(
  fromIndex: number,
  toIndex: number,
  sharedFromIndex: number,
  sharedToIndex: number
): boolean {
  return (fromIndex === sharedFromIndex && toIndex === sharedToIndex) ||
    (fromIndex === sharedToIndex && toIndex === sharedFromIndex);
}

function nativeChairTemplateCrowding(
  molecule: MoleculeObject,
  points: readonly PagePoint[],
  excludedAtomIds: ReadonlySet<string>
): number {
  return molecule.atoms
    .filter((atom) => !excludedAtomIds.has(atom.id))
    .reduce((score, atom) => (
      score + points.reduce((sum, point) => (
        sum + 1 / Math.max(nativeBondLength * 0.25, distance(atom, point))
      ), 0)
    ), 0);
}

function nativeTemplateRingSize(templateId: NativeMoleculeTemplateId): number {
  return templateId === "cyclopentane" ? 5 : 6;
}

function nativeTemplateRingBondDisplay(
  templateId: NativeMoleculeTemplateId,
  ringBondIndex: number,
  ringSize: number,
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  ringCenter: PagePoint,
  sharedBondContributesPi?: boolean
): Pick<MoleculeBond, "order" | "display"> {
  if (templateId !== "benzene") {
    return { order: "single" };
  }

  if (!nativeBenzeneRingBondIsDouble(ringBondIndex, ringSize, sharedBondContributesPi)) {
    return { order: "single" };
  }

  return {
    order: "double",
    display: { doubleBondSide: doubleBondSideTowardPoint(fromAtom, toAtom, ringCenter) }
  };
}

function nativeBenzeneRingBondIsDouble(
  ringBondIndex: number,
  ringSize: number,
  sharedBondContributesPi?: boolean
): boolean {
  if (ringSize !== 6) {
    return false;
  }

  if (sharedBondContributesPi === true) {
    return ringBondIndex === 2 || ringBondIndex === 4;
  }

  if (sharedBondContributesPi === false) {
    return ringBondIndex === 1 || ringBondIndex === 3 || ringBondIndex === 5;
  }

  return ringBondIndex % 2 === 0;
}

function sharedBondContributesAromaticPi(molecule: MoleculeObject, targetBond: MoleculeBond): boolean {
  if (targetBond.order === "double") {
    return true;
  }

  return [targetBond.fromAtomId, targetBond.toAtomId].every((atomId) =>
    molecule.bonds.some((bond) =>
      bond.id !== targetBond.id &&
      bond.order === "double" &&
      (bond.fromAtomId === atomId || bond.toAtomId === atomId)
    )
  );
}

interface NativeAromaticRingCycle {
  atomIds: string[];
  bondIds: string[];
  center: PagePoint;
}

interface NativeAromaticMatching {
  bondIds: string[];
  matchedAtoms: number;
  existingDoubleBonds: number;
  sharedDoubleBonds: number;
}

function normalizeNativeAromaticTemplateBonds(molecule: MoleculeObject): MoleculeObject {
  const allCycles = findNativeSixMemberCarbonRingCycles(molecule);
  const aromaticCycles = allCycles.filter((cycle) =>
    cycle.bondIds.filter((bondId) =>
      molecule.bonds.some((bond) => bond.id === bondId && bond.order === "double")
    ).length >= 2
  );

  if (aromaticCycles.length === 0) {
    return molecule;
  }

  const allCycleMembership = bondCycleMembership(allCycles);
  const aromaticCycleMembership = bondCycleMembership(aromaticCycles);
  const aromaticAtomIds = new Set(aromaticCycles.flatMap((cycle) => cycle.atomIds));
  const aromaticBondIds = new Set(aromaticCycles.flatMap((cycle) => cycle.bondIds));
  const candidateBondIds = [...aromaticBondIds].filter((bondId) => {
    const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
    if (!bond || !aromaticAtomIds.has(bond.fromAtomId) || !aromaticAtomIds.has(bond.toAtomId)) {
      return false;
    }

    // The bond must lie ENTIRELY within aromatic rings, so a benzene/cyclohexane fusion bond —
    // which also belongs to the saturated ring — stays single. But a bond shared between two
    // AROMATIC rings (every inner-ring bond of a peri-fused system like coronene) is eligible;
    // forbidding it left the inner carbons with no double bond at all, reading as sp3.
    const aromaticMembership = aromaticCycleMembership.get(bondId) ?? 0;
    const totalMembership = allCycleMembership.get(bondId) ?? 0;
    return aromaticMembership >= 1 && totalMembership === aromaticMembership;
  });
  // Bonds shared by more than one aromatic ring. We still PREFER double bonds on unshared
  // (perimeter) bonds, so cata-condensed systems (naphthalene, acenes) keep their conventional
  // Kekulé with single fusion bonds, while peri-fused systems use the fewest shared double bonds
  // needed to give every carbon a double bond (coronene's inner ring gets three, not six spokes).
  const sharedAromaticBondIds = new Set(
    candidateBondIds.filter((bondId) => (aromaticCycleMembership.get(bondId) ?? 0) > 1)
  );
  const doubleBondIds = new Set(
    chooseNativeAromaticDoubleBondIds(molecule, aromaticAtomIds, candidateBondIds, sharedAromaticBondIds)
  );
  if (doubleBondIds.size === 0) {
    return molecule;
  }

  const nextBonds = molecule.bonds.map((bond) => {
    if (!aromaticBondIds.has(bond.id)) {
      return bond;
    }

    if (!doubleBondIds.has(bond.id)) {
      return nativeBondWithOrderAndDoubleSide(bond, "single");
    }

    const ring = aromaticCycles.find((cycle) => cycle.bondIds.includes(bond.id));
    const fromAtom = molecule.atoms.find((atom) => atom.id === bond.fromAtomId);
    const toAtom = molecule.atoms.find((atom) => atom.id === bond.toAtomId);
    const side = ring && fromAtom && toAtom
      ? doubleBondSideTowardPoint(fromAtom, toAtom, ring.center)
      : bond.display?.doubleBondSide;
    return nativeBondWithOrderAndDoubleSide(bond, "double", side);
  });

  if (nextBonds.every((bond, index) => bond === molecule.bonds[index])) {
    return molecule;
  }

  return refreshNativeSingleBondGraph(molecule, molecule.atoms, nextBonds);
}

function findNativeSixMemberCarbonRingCycles(molecule: MoleculeObject): NativeAromaticRingCycle[] {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
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

  const cycles = new Map<string, NativeAromaticRingCycle>();
  const visit = (startAtomId: string, atomId: string, atomIds: string[], bondIds: string[]) => {
    if (atomIds.length === 6) {
      const closingBond = (adjacency.get(atomId) ?? []).find((edge) => edge.atomId === startAtomId);
      if (!closingBond) {
        return;
      }

      const cycleBondIds = [...bondIds, closingBond.bondId];
      const key = canonicalNativeRingCycleKey(cycleBondIds);
      if (!cycles.has(key)) {
        const cycleAtomIds = [...atomIds];
        cycles.set(key, {
          atomIds: cycleAtomIds,
          bondIds: cycleBondIds,
          center: centroidOfPoints(cycleAtomIds.map((id) => atomById.get(id)).filter((atom): atom is MoleculeAtom => Boolean(atom)))
        });
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

  return [...cycles.values()];
}

function canonicalNativeRingCycleKey(bondIds: readonly string[]): string {
  return [...bondIds].sort().join("|");
}

function bondCycleMembership(cycles: readonly NativeAromaticRingCycle[]): Map<string, number> {
  return cycles.reduce((membership, cycle) => {
    cycle.bondIds.forEach((bondId) => {
      membership.set(bondId, (membership.get(bondId) ?? 0) + 1);
    });
    return membership;
  }, new Map<string, number>());
}

function chooseNativeAromaticDoubleBondIds(
  molecule: MoleculeObject,
  aromaticAtomIds: ReadonlySet<string>,
  candidateBondIds: readonly string[],
  sharedBondIds: ReadonlySet<string> = new Set()
): string[] {
  const candidateBonds = candidateBondIds
    .map((bondId) => molecule.bonds.find((bond) => bond.id === bondId))
    .filter((bond): bond is MoleculeBond => Boolean(bond))
    .sort((a, b) => a.id.localeCompare(b.id));
  const candidateByAtom = new Map<string, MoleculeBond[]>();
  candidateBonds.forEach((bond) => {
    candidateByAtom.set(bond.fromAtomId, [...(candidateByAtom.get(bond.fromAtomId) ?? []), bond]);
    candidateByAtom.set(bond.toAtomId, [...(candidateByAtom.get(bond.toAtomId) ?? []), bond]);
  });

  const memo = new Map<string, NativeAromaticMatching>();
  const bestForAtoms = (unmatchedAtomIds: readonly string[]): NativeAromaticMatching => {
    const key = [...unmatchedAtomIds].sort().join("|");
    const cached = memo.get(key);
    if (cached) {
      return cached;
    }

    if (unmatchedAtomIds.length === 0) {
      return { bondIds: [], matchedAtoms: 0, existingDoubleBonds: 0, sharedDoubleBonds: 0 };
    }

    const unmatched = new Set(unmatchedAtomIds);
    const atomId = [...unmatched].sort()[0] ?? unmatchedAtomIds[0];
    let best: NativeAromaticMatching = bestForAtoms(unmatchedAtomIds.filter((id) => id !== atomId));
    const incidentBonds = (candidateByAtom.get(atomId) ?? []).filter((bond) => {
      const otherAtomId = bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId;
      return aromaticAtomIds.has(otherAtomId) && unmatched.has(otherAtomId);
    });

    incidentBonds.forEach((bond) => {
      const otherAtomId = bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId;
      const next = bestForAtoms(unmatchedAtomIds.filter((id) => id !== atomId && id !== otherAtomId));
      const candidate: NativeAromaticMatching = {
        bondIds: [bond.id, ...next.bondIds],
        matchedAtoms: next.matchedAtoms + 2,
        existingDoubleBonds: next.existingDoubleBonds + (bond.order === "double" ? 1 : 0),
        sharedDoubleBonds: next.sharedDoubleBonds + (sharedBondIds.has(bond.id) ? 1 : 0)
      };
      if (nativeAromaticMatchingIsBetter(candidate, best)) {
        best = candidate;
      }
    });

    memo.set(key, best);
    return best;
  };

  return bestForAtoms([...aromaticAtomIds]).bondIds;
}

function nativeAromaticMatchingIsBetter(candidate: NativeAromaticMatching, current: NativeAromaticMatching): boolean {
  // Cover the most carbons first (a perfect matching = every carbon gets one double bond), then
  // use the FEWEST shared/fusion double bonds (so cata-condensed systems keep single fusion
  // bonds and peri-fused systems use only the shared doubles they truly need), then prefer
  // keeping existing double bonds for stability across incremental fusions, then a stable order.
  if (candidate.matchedAtoms !== current.matchedAtoms) {
    return candidate.matchedAtoms > current.matchedAtoms;
  }
  if (candidate.sharedDoubleBonds !== current.sharedDoubleBonds) {
    return candidate.sharedDoubleBonds < current.sharedDoubleBonds;
  }
  if (candidate.bondIds.length !== current.bondIds.length) {
    return candidate.bondIds.length > current.bondIds.length;
  }
  if (candidate.existingDoubleBonds !== current.existingDoubleBonds) {
    return candidate.existingDoubleBonds > current.existingDoubleBonds;
  }
  return candidate.bondIds.join("|") < current.bondIds.join("|");
}

function nativeBondWithOrderAndDoubleSide(
  bond: MoleculeBond,
  order: MoleculeBond["order"],
  doubleBondSide?: NativeDoubleBondSide
): MoleculeBond {
  const display = { ...(bond.display ?? {}) };
  if (doubleBondSide) {
    display.doubleBondSide = doubleBondSide;
  } else {
    delete display.doubleBondSide;
  }

  return {
    ...bond,
    order,
    display: Object.keys(display).length > 0 ? display : undefined
  };
}

function centroidOfPoints(points: readonly PagePoint[]): PagePoint {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }

  return points.reduce<PagePoint>(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 }
  );
}

function nativeRingVerticesForSharedBond(
  molecule: MoleculeObject,
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  point: PagePoint,
  size: number
): PagePoint[] | undefined {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const unit = { x: dx / length, y: dy / length };
  const normal = { x: -unit.y, y: unit.x };
  const midpoint = { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };
  const side = nativeTemplateSideForBond(molecule, fromAtom, toAtom, point, normal);
  const apothem = length / (2 * Math.tan(Math.PI / size));
  const center = {
    x: midpoint.x + normal.x * side * apothem,
    y: midpoint.y + normal.y * side * apothem
  };
  const radius = length / (2 * Math.sin(Math.PI / size));
  const angleFrom = Math.atan2(fromAtom.y - center.y, fromAtom.x - center.x);
  const angleTo = Math.atan2(toAtom.y - center.y, toAtom.x - center.x);
  const step = Math.PI * 2 / size;
  const signedDelta = normalizeSignedAngle(angleTo - angleFrom);
  const direction = signedDelta >= 0 ? 1 : -1;

  return [
    { x: fromAtom.x, y: fromAtom.y },
    { x: toAtom.x, y: toAtom.y },
    ...Array.from({ length: size - 2 }, (_, index) => {
      const angle = angleTo + direction * step * (index + 1);
      return {
        x: roundGeometryCoordinate(center.x + Math.cos(angle) * radius),
        y: roundGeometryCoordinate(center.y + Math.sin(angle) * radius)
      };
    })
  ];
}

function nativeRingVerticesForSharedAtom(
  molecule: MoleculeObject,
  sharedAtom: MoleculeAtom,
  point: PagePoint,
  size: number
): PagePoint[] | undefined {
  const radius = nativeBondLength / (2 * Math.sin(Math.PI / size));
  const centerDirection = nativeTemplateDirectionForAtom(molecule, sharedAtom, point);
  const center = {
    x: sharedAtom.x + Math.cos(centerDirection) * radius,
    y: sharedAtom.y + Math.sin(centerDirection) * radius
  };
  const sharedAngle = Math.atan2(sharedAtom.y - center.y, sharedAtom.x - center.x);
  const step = Math.PI * 2 / size;
  const clockwiseCrowding = nativeTemplateSpiroCrowding(molecule, sharedAtom, center, sharedAngle, size, 1);
  const counterClockwiseCrowding = nativeTemplateSpiroCrowding(molecule, sharedAtom, center, sharedAngle, size, -1);
  const direction = clockwiseCrowding <= counterClockwiseCrowding ? 1 : -1;

  return [
    { x: sharedAtom.x, y: sharedAtom.y },
    ...Array.from({ length: size - 1 }, (_, index) => {
      const angle = sharedAngle + direction * step * (index + 1);
      return {
        x: roundGeometryCoordinate(center.x + Math.cos(angle) * radius),
        y: roundGeometryCoordinate(center.y + Math.sin(angle) * radius)
      };
    })
  ];
}

function nativeTemplateSideForBond(
  molecule: MoleculeObject,
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  point: PagePoint,
  normal: PagePoint
): 1 | -1 {
  const midpoint = { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };

  // Crowding is the PRIMARY signal: a bond that belongs to an existing ring has its other
  // ring atoms on one side, and fusing into them would drop the new ring on top of the old
  // one (coincident atoms — the "second benzene placed on top of the first" bug). So we
  // fuse to the side AWAY from the existing structure whenever there clearly is one. The
  // click position only decides when the two sides are balanced (an isolated/symmetric bond
  // with nothing to collide with). Every existing fuse test clicks the exact midpoint
  // (clickScore == 0), so it already lands here — this only changes off-centre clicks.
  const crowdScore = molecule.atoms
    .filter((atom) => atom.id !== fromAtom.id && atom.id !== toAtom.id)
    .reduce((score, atom) => {
      const side = (atom.x - midpoint.x) * normal.x + (atom.y - midpoint.y) * normal.y;
      return score + Math.sign(side);
    }, 0);
  if (crowdScore !== 0) {
    return crowdScore > 0 ? -1 : 1;
  }

  const clickScore = (point.x - midpoint.x) * normal.x + (point.y - midpoint.y) * normal.y;
  return clickScore >= 0 ? 1 : -1;
}

function nativeTemplateDirectionForAtom(
  molecule: MoleculeObject,
  atom: MoleculeAtom,
  point: PagePoint
): number {
  const pointDistance = distance(atom, point);
  if (pointDistance > nativeBondLength * 0.35) {
    return Math.atan2(point.y - atom.y, point.x - atom.x);
  }

  const neighborAngles = neighborAnglesForAtom(molecule, atom.id);
  return largestOpenAngle(neighborAngles) ?? -Math.PI / 2;
}

function nativeTemplateSpiroCrowding(
  molecule: MoleculeObject,
  sharedAtom: MoleculeAtom,
  center: PagePoint,
  sharedAngle: number,
  size: number,
  direction: 1 | -1
): number {
  const radius = nativeBondLength / (2 * Math.sin(Math.PI / size));
  const step = Math.PI * 2 / size;
  const candidatePoints = Array.from({ length: size - 1 }, (_, index) => ({
    x: center.x + Math.cos(sharedAngle + direction * step * (index + 1)) * radius,
    y: center.y + Math.sin(sharedAngle + direction * step * (index + 1)) * radius
  }));
  return molecule.atoms
    .filter((atom) => atom.id !== sharedAtom.id)
    .reduce((score, atom) => (
      score + candidatePoints.reduce((sum, point) => sum + 1 / Math.max(nativeBondLength * 0.25, distance(atom, point)), 0)
    ), 0);
}

export function nativeTextObjectSizeForText(
  text: string,
  style: Record<string, unknown> | Partial<NativeTextStyle> = {},
  options: { width?: number; height?: number; maxWidth?: number; maxHeight?: number } = {}
): { width: number; height: number } {
  const textStyle = nativeTextStyleFromObjectStyle(style);
  const paragraphs = normalizeTextLines(text);
  const lineHeightPx = textStyle.fontSizePx * textStyle.lineHeight;
  const naturalContentWidth = Math.max(
    ...paragraphs.map((line) => estimateNativeTextLineWidth(line, textStyle)),
    nativeTextObjectMinimumDimensions.width - nativeTextBoxHorizontalPadding
  );
  const maxWidth = options.maxWidth ?? nativeTextObjectDimensions.width;
  const width = clamp(
    options.width ?? naturalContentWidth + nativeTextBoxHorizontalPadding,
    nativeTextObjectMinimumDimensions.width,
    Math.max(nativeTextObjectMinimumDimensions.width, maxWidth)
  );
  const wrappedLineCount = paragraphs.reduce((count, line) => (
    count + wrappedNativeTextLineCount(line, textStyle, width - nativeTextBoxHorizontalPadding)
  ), 0);
  const paragraphSpacing = Math.max(0, paragraphs.length - 1) * textStyle.paragraphSpacingPx;
  const naturalHeight = clamp(
    wrappedLineCount * lineHeightPx + paragraphSpacing + nativeTextBoxVerticalPadding,
    nativeTextObjectMinimumDimensions.height,
    Number.MAX_SAFE_INTEGER
  );
  const height = clamp(
    options.height ?? naturalHeight,
    nativeTextObjectMinimumDimensions.height,
    Math.max(nativeTextObjectMinimumDimensions.height, options.maxHeight ?? Number.MAX_SAFE_INTEGER)
  );

  return {
    width: roundToTextBoxPixel(width),
    height: roundToTextBoxPixel(height)
  };
}

export function createNativeTextObject(
  document: ChemDraftDocument,
  point: PagePoint,
  text = "Text",
  style: Partial<NativeTextStyle> = {}
): TextObject {
  const page = firstPage(document);
  const resolvedText = text.length > 0 ? text : "Text";
  const objectStyle = textStyleToObjectStyle(style);
  const size = nativeTextObjectSizeForText(resolvedText, objectStyle, {
    maxWidth: Math.max(nativeTextObjectMinimumDimensions.width, page.width - point.x)
  });
  const width = size.width;
  const height = size.height;

  return {
    id: nextObjectId(document, "text"),
    type: "text",
    x: clamp(point.x, 0, Math.max(0, page.width - width)),
    y: clamp(point.y, 0, Math.max(0, page.height - height)),
    width,
    height,
    rotation: 0,
    style: {
      ...objectStyle,
      textBoxSizingMode: "auto"
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    text: resolvedText,
    spans: [{ text: resolvedText, script: "normal", style: {} }]
  };
}

export function insertNativeTextObject(
  document: ChemDraftDocument,
  point: PagePoint,
  text = "Text",
  style: Partial<NativeTextStyle> = {}
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeTextObject(document, point, text, style);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function createNativeMolfileMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  molfile: string,
  format: ClipboardMolfileFormat,
  graph: ParsedMolfileGraph = parseMolfileGraph(molfile)
): MoleculeObject {
  if (graph.atoms.length === 0) {
    throw new Error("Cannot paste MOL payload: no atoms were found.");
  }

  const page = firstPage(document);
  const atoms = scaleParsedMolfileAtoms(graph, point, page).map((atom) => ({
    id: atom.id,
    element: atom.element,
    x: atom.x,
    y: atom.y,
    formalCharge: atom.formalCharge
  })) satisfies MoleculeAtom[];
  const atomIds = new Set(atoms.map((atom) => atom.id));
  const bonds = graph.bonds
    .filter((bond) => atomIds.has(bond.fromAtomId) && atomIds.has(bond.toAtomId))
    .map((bond) => ({
      id: bond.id,
      fromAtomId: bond.fromAtomId,
      toAtomId: bond.toAtomId,
      order: bond.order
    })) satisfies MoleculeBond[];
  const warnings = [
    ...clipboardWarningsToCompatibilityWarnings(graph.warnings),
    {
      code: "clipboard.molfile_imported",
      message: "Pasted from MOL clipboard text; unsupported MOL fields were not imported into native geometry."
    }
  ];

  return normalizeNativeMoleculeGeometry({
    id: nextObjectId(document, "mol_clipboard"),
    type: "molecule",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    transform: defaultNativeMoleculeTransform,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      source: "clipboard-molfile"
    },
    compatibility: {
      sourceFormat: format,
      warnings,
      unknown: {}
    },
    structureFormat: format,
    structure: molfile,
    chemistry: nativeSingleBondGraphMetadata(atoms, bonds),
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  });
}

export function insertNativeMolfileMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  molfile: string,
  format: ClipboardMolfileFormat
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeMolfileMolecule(document, point, molfile, format);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function applyClipboardPastePayload(
  document: ChemDraftDocument,
  payload: ClipboardDetectedPayload,
  point: PagePoint,
  textStyle: Partial<NativeTextStyle> = {}
): ClipboardPasteResult {
  if (payload.kind === "plain-text") {
    const nextDocument = insertNativeTextObject(document, point, payload.text, textStyle);
    const selected = getSelectedTextObject(nextDocument);
    return {
      document: nextDocument,
      status: "Pasted editable text",
      kind: payload.kind,
      selectedObjectId: selected?.id,
      editTextObjectId: selected?.id,
      warnings: payload.warnings
    };
  }

  if (payload.kind === "molfile") {
    const nextDocument = insertNativeMolfileMolecule(document, point, payload.text, payload.format);
    const selected = getSelectedMolecule(nextDocument);
    const parsedWarnings = selected?.compatibility?.warnings
      .filter((warning) => warning.code.startsWith("clipboard."))
      .map((warning) => ({ code: warning.code, message: warning.message })) ?? [];
    return {
      document: nextDocument,
      status: `Pasted editable ${payload.format === "molfile-v3000" ? "MOL V3000" : "MOL V2000"} structure`,
      kind: payload.kind,
      selectedObjectId: selected?.id,
      warnings: [...payload.warnings, ...parsedWarnings]
    };
  }

  if (payload.kind === "rxnfile") {
    const molfileBlocks = extractRxnMolfileBlocks(payload.text);
    if (molfileBlocks.length === 0) {
      return {
        document,
        status: payload.warnings[0]?.message ?? "RXN paste is not implemented yet.",
        kind: payload.kind,
        warnings: payload.warnings
      };
    }

    try {
      const nextDocument = molfileBlocks.reduce((currentDocument, block, index) => {
        const offsetPoint = {
          x: point.x + index * 180,
          y: point.y
        };
        return insertNativeMolfileMolecule(currentDocument, offsetPoint, block.text, block.format);
      }, document);
      const selected = getSelectedMolecule(nextDocument);
      const rxnWarnings = [
        ...payload.warnings,
        {
          code: "clipboard.rxn_mol_blocks_imported",
          message: "ChemDraft extracted editable MOL blocks from the RXN clipboard payload; reaction arrows, roles, and layout are not imported yet."
        }
      ];
      return {
        document: nextDocument,
        status: `Pasted ${molfileBlocks.length} editable RXN molecule block${molfileBlocks.length === 1 ? "" : "s"}`,
        kind: payload.kind,
        selectedObjectId: selected?.id,
        warnings: rxnWarnings
      };
    } catch (error) {
      const warning = {
        code: "clipboard.rxn_parse_failed",
        message: error instanceof Error
          ? `ChemDraft detected RXN molecule blocks, but could not parse them: ${error.message}`
          : "ChemDraft detected RXN molecule blocks, but could not parse them."
      };
      return {
        document,
        status: warning.message,
        kind: payload.kind,
        warnings: [...payload.warnings, warning]
      };
    }
  }

  if (payload.kind === "smiles") {
    const page = firstPage(document);
    const object = createClipboardTextStructureMolecule(document, point, "smiles", payload.text, payload.warnings);
    const nextDocument = applyPatches(
      document,
      [
        { op: "addObject", pageId: page.id, object },
        { op: "setSelection", pageId: page.id, objectIds: [object.id] }
      ],
      { now: phase4Timestamp }
    );

    return {
      document: nextDocument,
      status: "Pasted SMILES payload; native 2D layout generation is not implemented yet",
      kind: payload.kind,
      selectedObjectId: object.id,
      warnings: payload.warnings
    };
  }

  return {
    document,
    status: statusForUnsupportedClipboardPayload(payload),
    kind: payload.kind,
    warnings: payload.warnings
  };
}

export function getSelectedTextObject(document: ChemDraftDocument): TextObject | undefined {
  const object = getSelectedObject(document);
  return object?.type === "text" ? object : undefined;
}

export function updateNativeTextObjectText(
  document: ChemDraftDocument,
  objectId: string,
  text: string
): ChemDraftDocument {
  const location = findTextObjectLocation(document, objectId);
  if (!location) {
    return document;
  }
  const { object, page } = location;
  const fixedWidth = object.style.textBoxSizingMode === "fixed-width" || object.style.textBoxSizingMode === "fixed-size";
  const fixedSize = object.style.textBoxSizingMode === "fixed-size";
  const size = nativeTextObjectSizeForText(text, object.style, {
    width: fixedWidth ? object.width : undefined,
    height: fixedSize ? object.height : undefined,
    maxWidth: Math.max(nativeTextObjectMinimumDimensions.width, page.width - object.x),
    maxHeight: Math.max(nativeTextObjectMinimumDimensions.height, page.height - object.y)
  });

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        text,
        width: size.width,
        height: size.height,
        spans: textObjectSpansForTextChange(object, text)
      }
    },
    { now: phase4Timestamp }
  );
}

export function resizeNativeTextObjectBox(
  document: ChemDraftDocument,
  objectId: string,
  frame: { x?: number; y?: number; width?: number; height?: number }
): ChemDraftDocument {
  const location = findTextObjectLocation(document, objectId);
  if (!location) {
    return document;
  }
  const { object, page } = location;
  const nextX = clamp(frame.x ?? object.x, 0, page.width - nativeTextObjectMinimumDimensions.width);
  const nextY = clamp(frame.y ?? object.y, 0, page.height - nativeTextObjectMinimumDimensions.height);
  const nextWidth = clamp(
    frame.width ?? object.width,
    nativeTextObjectMinimumDimensions.width,
    Math.max(nativeTextObjectMinimumDimensions.width, page.width - nextX)
  );
  const fixedHeight = frame.height !== undefined;
  const size = nativeTextObjectSizeForText(object.text, object.style, {
    width: nextWidth,
    height: fixedHeight ? frame.height : undefined,
    maxWidth: Math.max(nativeTextObjectMinimumDimensions.width, page.width - nextX),
    maxHeight: Math.max(nativeTextObjectMinimumDimensions.height, page.height - nextY)
  });

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        x: nextX,
        y: nextY,
        width: size.width,
        height: size.height,
        style: {
          ...object.style,
          textBoxSizingMode: fixedHeight ? "fixed-size" : "fixed-width"
        }
      }
    },
    { now: phase4Timestamp }
  );
}

export function updateNativeTextObjectStyle(
  document: ChemDraftDocument,
  objectId: string,
  style: Partial<NativeTextStyle>
): ChemDraftDocument {
  const location = findTextObjectLocation(document, objectId);
  if (!location) {
    return document;
  }
  const { object, page } = location;
  const nextStyle = nativeTextStyleFromObjectStyle({
    ...nativeTextStyleFromObjectStyle(object.style),
    ...style
  });
  const fixedWidth = object.style.textBoxSizingMode === "fixed-width" || object.style.textBoxSizingMode === "fixed-size";
  const fixedSize = object.style.textBoxSizingMode === "fixed-size";
  const size = nativeTextObjectSizeForText(object.text, nextStyle, {
    width: fixedWidth ? object.width : undefined,
    height: fixedSize ? object.height : undefined,
    maxWidth: Math.max(nativeTextObjectMinimumDimensions.width, page.width - object.x),
    maxHeight: Math.max(nativeTextObjectMinimumDimensions.height, page.height - object.y)
  });

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        width: size.width,
        height: size.height,
        style: {
          ...object.style,
          ...textStyleToObjectStyle(nextStyle)
        }
      }
    },
    { now: phase4Timestamp }
  );
}

export function updateNativeTextObjectScript(
  document: ChemDraftDocument,
  objectId: string,
  script: TextSpan["script"]
): ChemDraftDocument {
  const location = findTextObjectLocation(document, objectId);
  if (!location) {
    return document;
  }
  const { object } = location;

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        spans: [{ text: object.text, script, style: {} }]
      }
    },
    { now: phase4Timestamp }
  );
}

export function updateNativeTextObjectScriptRange(
  document: ChemDraftDocument,
  objectId: string,
  range: NativeTextSelectionRange,
  script: TextSpan["script"]
): ChemDraftDocument {
  const location = findTextObjectLocation(document, objectId);
  if (!location) {
    return document;
  }

  const spans = updateTextObjectSpansInRange(location.object, range, (span) => ({
    ...span,
    script
  }));

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: { spans }
    },
    { now: phase4Timestamp }
  );
}

export function updateNativeTextObjectStyleRange(
  document: ChemDraftDocument,
  objectId: string,
  range: NativeTextSelectionRange,
  style: Record<string, unknown>
): ChemDraftDocument {
  const location = findTextObjectLocation(document, objectId);
  if (!location) {
    return document;
  }

  const spans = updateTextObjectSpansInRange(location.object, range, (span) => ({
    ...span,
    style: {
      ...span.style,
      ...style
    }
  }));

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: { spans }
    },
    { now: phase4Timestamp }
  );
}

export function updateSelectedNativeTextObjectStyle(
  document: ChemDraftDocument,
  style: Partial<NativeTextStyle>
): ChemDraftDocument {
  const selected = getSelectedTextObject(document);
  return selected ? updateNativeTextObjectStyle(document, selected.id, style) : document;
}

export function applyColorToDocumentObjects(
  document: ChemDraftDocument,
  color: string,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const selectedIds = new Set(objectIds);
  if (selectedIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (!selectedIds.has(object.id)) {
        return [];
      }

      const changes = documentObjectColorChanges(object, color);
      return changes ? [{ op: "updateObject" as const, objectId: object.id, changes }] : [];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

export function applyColorToNativeMoleculePart(
  document: ChemDraftDocument,
  target: NativeMoleculeColorTarget,
  color: string
): ChemDraftDocument {
  const object = findMoleculeObject(document, target.objectId);
  if (object?.type !== "molecule") {
    return document;
  }

  const atomLabelColors = styleColorMap(object.style.atomLabelColors);
  const bondColors = styleColorMap(object.style.bondColors);

  if (target.kind === "atom") {
    atomLabelColors[target.atomId] = color;
  } else if (target.kind === "bond") {
    bondColors[target.bondId] = color;
  } else {
    target.atomIds.forEach((atomId) => {
      atomLabelColors[atomId] = color;
    });
    target.bondIds.forEach((bondId) => {
      bondColors[bondId] = color;
    });
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: target.objectId,
      changes: {
        style: {
          ...object.style,
          atomLabelColors,
          bondColors
        }
      }
    },
    { now: phase4Timestamp }
  );
}

export function resolveToolbarColorSelection(
  document: ChemDraftDocument,
  live: ToolbarColorSelection,
  fallback?: ToolbarColorSelection
): ToolbarColorSelection {
  const resolvedLive = validateToolbarColorSelection(document, live);
  if (toolbarColorSelectionHasTargets(resolvedLive)) {
    return resolvedLive;
  }

  return validateToolbarColorSelection(document, fallback ?? { objectIds: [] });
}

export function applyToolbarColorToSelection(
  document: ChemDraftDocument,
  color: string,
  selection: ToolbarColorSelection
): ToolbarColorApplyResult {
  const validatedSelection = validateToolbarColorSelection(document, selection);
  const colorMoleculePart = validatedSelection.moleculePart;
  const colorTextRange = validatedSelection.textRange;
  const targetObjectIds = [
    ...new Set([
      ...validatedSelection.objectIds,
      ...(colorMoleculePart ? [colorMoleculePart.objectId] : [])
    ])
  ].filter((objectId) =>
    !(colorMoleculePart && objectId === colorMoleculePart.objectId) &&
    !(colorTextRange && objectId === colorTextRange.objectId)
  );
  const targetedSelection = targetObjectIds.length > 0 || Boolean(colorMoleculePart) || Boolean(colorTextRange);
  if (!targetedSelection) {
    return { document, changed: false, targetedSelection: false };
  }

  let nextDocument = document;
  if (targetObjectIds.length > 0) {
    nextDocument = applyColorToDocumentObjects(nextDocument, color, targetObjectIds);
  }
  if (colorMoleculePart) {
    nextDocument = applyColorToNativeMoleculePart(nextDocument, colorMoleculePart, color);
  }
  if (colorTextRange) {
    nextDocument = updateNativeTextObjectStyleRange(nextDocument, colorTextRange.objectId, colorTextRange.range, { color });
  }

  return {
    document: nextDocument,
    changed: nextDocument !== document,
    targetedSelection
  };
}

function validateToolbarColorSelection(
  document: ChemDraftDocument,
  selection: ToolbarColorSelection
): ToolbarColorSelection {
  const objectIds = [...new Set(selection.objectIds)]
    .filter((objectId) => documentObjectExists(document, objectId));
  const moleculePart = selection.moleculePart
    ? validateNativeMoleculeColorTarget(document, selection.moleculePart)
    : undefined;
  const textRange = selection.textRange && selection.textRange.range.start !== selection.textRange.range.end
    ? findTextObject(document, selection.textRange.objectId)
      ? selection.textRange
      : undefined
    : undefined;

  return { objectIds, moleculePart, textRange };
}

function toolbarColorSelectionHasTargets(selection: ToolbarColorSelection): boolean {
  return selection.objectIds.length > 0 || Boolean(selection.moleculePart) || Boolean(selection.textRange);
}

function validateNativeMoleculeColorTarget(
  document: ChemDraftDocument,
  target: NativeMoleculeColorTarget
): NativeMoleculeColorTarget | undefined {
  const molecule = findMoleculeObject(document, target.objectId);
  if (!molecule) {
    return undefined;
  }

  if (target.kind === "atom") {
    return molecule.atoms.some((atom) => atom.id === target.atomId) ? target : undefined;
  }

  if (target.kind === "bond") {
    return molecule.bonds.some((bond) => bond.id === target.bondId) ? target : undefined;
  }

  const atomIds = target.atomIds.filter((atomId) => molecule.atoms.some((atom) => atom.id === atomId));
  const bondIds = target.bondIds.filter((bondId) => molecule.bonds.some((bond) => bond.id === bondId));
  return atomIds.length > 0 || bondIds.length > 0
    ? { objectId: target.objectId, kind: "parts", atomIds, bondIds }
    : undefined;
}

export function deleteSelectedDocumentObjects(document: ChemDraftDocument): ChemDraftDocument {
  const selectedIds = document.selection.objectIds.filter((objectId) =>
    document.pages.some((page) => page.objects.some((object) => object.id === objectId))
  );
  if (selectedIds.length === 0) {
    return document;
  }

  return applyPatches(
    document,
    selectedIds.map((objectId) => ({ op: "removeObject", objectId })),
    { now: phase4Timestamp }
  );
}

export function applySingleBondToolAtPoint(
  document: ChemDraftDocument,
  point: PagePoint,
  options: NativeBondToolOptions = {}
): ChemDraftDocument {
  const page = firstPage(document);
  const selected = getSelectedMolecule(document);
  const extended = selected ? extendNativeCarbonChain(selected, point, page.width, page.height, options) : undefined;

  if (!selected) {
    return insertNativeSingleBondMolecule(document, point, options);
  }

  if (!extended) {
    return insertNativeSingleBondMolecule(document, point, options);
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

export function applyFreeformSingleBondToolAtPoint(
  document: ChemDraftDocument,
  objectId: string,
  sourceAtomId: string,
  point: PagePoint,
  options: NativeFreeformBondGrowthOptions = {}
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === objectId && object.type === "molecule"
  );
  if (!molecule) {
    return document;
  }

  const preview = previewNativeMoleculeFreeformBondGrowth(
    molecule,
    sourceAtomId,
    point,
    page.width,
    page.height,
    options
  );
  if (!preview) {
    return document;
  }

  const extended = preview.targetAtomId
    ? connectNativeCarbonAtoms(molecule, preview.atomId, preview.targetAtomId, options)
    : extendNativeCarbonGraph(molecule, preview.atomId, preview.newAtomPoint, options);
  if (!extended) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "updateObject", objectId: molecule.id, changes: extended },
      { op: "setSelection", pageId: page.id, objectIds: [molecule.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function applyNativeBondDisplayStyleTarget(
  document: ChemDraftDocument,
  target: NativeBondOrderTarget,
  bondStyle: NativeBondDisplayStyle
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const bond = molecule.bonds.find((candidate) => candidate.id === target.bondId);
  if (!bond || bond.display?.bondStyle === bondStyle) {
    return document;
  }

  const bonds = molecule.bonds.map((candidate) =>
    candidate.id === bond.id ? nativeBondWithDisplayStyle(candidate, bondStyle) : candidate
  );
  const nextMolecule = refreshNativeSingleBondGraph(molecule, molecule.atoms, bonds);

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

export function applyChargeToolAtPoint(
  document: ChemDraftDocument,
  charge: NativeChargeValue,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  return addChargeMarkAtPoint(document, page.id, charge, point);
}

export function applyChargeToolAtNativeAtom(
  document: ChemDraftDocument,
  charge: NativeChargeValue,
  target: NativeMoleculeDeleteTarget
): ChemDraftDocument {
  if (target.kind !== "atom") {
    return document;
  }

  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule" && isEditableNativeMoleculeGraph(object)
  );
  if (!molecule) {
    return document;
  }

  const point = nativeChargePlacementPointForAtom(molecule, target.atomId, page.objects, page.width, page.height);
  return point ? addChargeMarkAtPoint(document, page.id, charge, point) : document;
}

export function applySingleBondToolAtNativeAtom(
  document: ChemDraftDocument,
  target: NativeMoleculeDeleteTarget,
  steeringPoint?: PagePoint
): ChemDraftDocument {
  if (target.kind !== "atom") {
    return document;
  }

  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const atom = molecule.atoms.find((candidate) => candidate.id === target.atomId);
  if (!atom) {
    return document;
  }

  const preview = previewNativeMoleculeBondGrowth(molecule, steeringPoint ?? atom, page.width, page.height);
  if (!preview) {
    return document;
  }

  const extended = preview.targetAtomId
    ? connectNativeCarbonAtoms(molecule, preview.atomId, preview.targetAtomId)
    : extendNativeCarbonGraph(molecule, preview.atomId, preview.newAtomPoint);
  if (!extended) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "updateObject", objectId: molecule.id, changes: extended },
      { op: "setSelection", pageId: page.id, objectIds: [molecule.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function applyNativeCarbonylAtAtomTarget(
  document: ChemDraftDocument,
  target: NativeMoleculeDeleteTarget,
  steeringPoint?: PagePoint
): ChemDraftDocument {
  if (target.kind !== "atom") {
    return document;
  }

  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const nextMolecule = addNativeCarbonylToAtom(molecule, target.atomId, page.width, page.height, steeringPoint);
  if (!nextMolecule) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "updateObject", objectId: molecule.id, changes: nextMolecule },
      { op: "setSelection", pageId: page.id, objectIds: [molecule.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function nativeChargePlacementPointForAtom(
  molecule: MoleculeObject,
  atomId: string,
  objects: readonly DocumentObject[],
  pageWidth: number,
  pageHeight: number
): PagePoint | undefined {
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  if (!atom) {
    return undefined;
  }

  const placementRadius = Math.max(nativeChargeMarkSizePx * 1.35, nativeBondLength * 0.55);
  const neighborAngles = molecule.bonds
    .filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId)
    .map((bond) => molecule.atoms.find((candidate) =>
      candidate.id === (bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId)
    ))
    .filter((candidate): candidate is MoleculeAtom => candidate !== undefined)
    .map((neighbor) => Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x));
  const preferredOpenAngle = largestOpenAngle(neighborAngles) ?? -Math.PI / 4;
  const otherAtoms = molecule.atoms.filter((candidate) => candidate.id !== atomId);
  const chargeCenters = objects
    .filter((object): object is ElectronMarkObject => object.type === "electron-mark" && object.markKind === "charge")
    .map(nativeChargeMarkCenter);
  const halfSize = nativeChargeMarkSizePx / 2;
  const candidates = Array.from({ length: 16 }, (_, index) => {
    const angle = -Math.PI + index * Math.PI / 8;
    const point = {
      x: atom.x + Math.cos(angle) * placementRadius,
      y: atom.y + Math.sin(angle) * placementRadius
    };
    const clampedPoint = {
      x: clamp(point.x, halfSize, Math.max(halfSize, pageWidth - halfSize)),
      y: clamp(point.y, halfSize, Math.max(halfSize, pageHeight - halfSize))
    };
    const boundaryPenalty = distance(point, clampedPoint);
    const bondSeparation = neighborAngles.length === 0
      ? Math.PI
      : Math.min(...neighborAngles.map((neighborAngle) => angularDistance(angle, neighborAngle)));
    const atomDistanceScore = otherAtoms.reduce((sum, otherAtom) =>
      sum + Math.min(1, distance(clampedPoint, otherAtom) / (nativeBondLength * 1.5)), 0
    );
    const chargeDistanceScore = chargeCenters.reduce((sum, center) =>
      sum + Math.min(1, distance(clampedPoint, center) / (nativeBondLength * 1.5)), 0
    );
    const preferredScore = 1 - angularDistance(angle, preferredOpenAngle) / Math.PI;

    return {
      point: clampedPoint,
      score: bondSeparation * 1000 + atomDistanceScore * 20 + chargeDistanceScore * 10 + preferredScore - boundaryPenalty * 10
    };
  });

  return candidates
    .sort((left, right) => right.score - left.score || left.point.y - right.point.y || left.point.x - right.point.x)[0]
    ?.point;
}

function addChargeMarkAtPoint(
  document: ChemDraftDocument,
  pageId: string,
  charge: NativeChargeValue,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  const halfSize = nativeChargeMarkSizePx / 2;
  const x = clamp(point.x - halfSize, 0, Math.max(0, page.width - nativeChargeMarkSizePx));
  const y = clamp(point.y - halfSize, 0, Math.max(0, page.height - nativeChargeMarkSizePx));
  const center = {
    x: x + halfSize,
    y: y + halfSize
  };
  const chargeMark = {
    id: nextObjectId(document, "charge"),
    type: "electron-mark",
    x,
    y,
    width: nativeChargeMarkSizePx,
    height: nativeChargeMarkSizePx,
    rotation: 0,
    style: {
      source: "chemdraft-native-charge"
    },
    markKind: "charge",
    anchor: {
      kind: "point",
      point: center
    },
    charge
  } satisfies ElectronMarkObject;

  return applyPatches(
    document,
    [
      { op: "addObject", pageId, object: chargeMark },
      { op: "setSelection", pageId, objectIds: [chargeMark.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function nativeChargeAssociationsForMolecule(
  molecule: MoleculeObject,
  objects: readonly DocumentObject[]
): NativeChargeAssociation[] {
  const candidateStates = molecule.atoms
    .map((atom) => ({ atom, state: nativeAtomValidationState(atom, molecule.bonds) }))
    .filter(({ state }) =>
      state.expectedFormalCharge !== undefined && state.expectedFormalCharge !== state.formalCharge
    );
  if (candidateStates.length === 0) {
    return [];
  }

  return objects
    .filter((object): object is ElectronMarkObject =>
      object.type === "electron-mark" && object.markKind === "charge" && nativeChargeValue(object.charge) !== undefined
    )
    .flatMap((chargeMark) => {
      const charge = nativeChargeValue(chargeMark.charge);
      if (charge === undefined) {
        return [];
      }

      const center = nativeChargeMarkCenter(chargeMark);
      const nearest = candidateStates
        .map(({ atom, state }) => ({
          atom,
          state,
          neededCharge: (state.expectedFormalCharge ?? state.formalCharge) - state.formalCharge,
          distance: distance(center, atom)
        }))
        .filter(({ neededCharge, distance }) =>
          Math.sign(neededCharge) === charge && distance <= nativeChargeAssociationRadiusPx
        )
        .sort((left, right) => left.distance - right.distance)[0];
      if (!nearest) {
        return [];
      }

      return [{
        chargeObjectId: chargeMark.id,
        atomId: nearest.atom.id,
        moleculeId: molecule.id,
        charge,
        distance: nearest.distance
      }];
    });
}

export function nativeChargeByAtomIdFromAssociations(
  associations: readonly NativeChargeAssociation[]
): ReadonlyMap<string, number> {
  const chargeByAtomId = new Map<string, number>();
  associations.forEach((association) => {
    chargeByAtomId.set(association.atomId, (chargeByAtomId.get(association.atomId) ?? 0) + association.charge);
  });
  return chargeByAtomId;
}

export function nativeChargeMarkCenter(mark: ElectronMarkObject): PagePoint {
  return {
    x: mark.x + mark.width / 2,
    y: mark.y + mark.height / 2
  };
}

export function findNativeMoleculeAtomHit(
  molecule: MoleculeObject,
  point: PagePoint
): { atomId: string; degree: number; availableBonds: number; distance: number } | undefined {
  if (!isEditableNativeMoleculeGraph(molecule)) {
    return undefined;
  }

  const hit = findNearestAtomAtPoint({
    atoms: molecule.atoms,
    point,
    hitRadius: atomHitRadius
  });
  if (!hit) {
    return undefined;
  }

  const atom = molecule.atoms.find((candidate) => candidate.id === hit.atomId);
  if (!atom) {
    return undefined;
  }

  const valenceUsed = atomBondOrderUsageMap(molecule.atoms, molecule.bonds).get(hit.atomId) ?? 0;
  const availableBonds = nativeAtomAvailableBondCount(atom, valenceUsed);
  if (availableBonds <= 0) {
    return undefined;
  }

  return {
    atomId: hit.atomId,
    degree: atomDegreeMap(molecule.atoms, molecule.bonds).get(hit.atomId) ?? 0,
    availableBonds,
    distance: hit.distance
  };
}

/**
 * Tolerances (page-space px) for a single hit-test. Both default to the legacy fixed
 * radii, so non-pointer callers (keyboard commands, programmatic hits, tests) are
 * unaffected. The pointer path supplies a scale-derived `bondHitRadius` so the on-screen
 * bond target stays a constant size at any zoom — see hitTest.ts `bondHitRadiusForScale`.
 */
export interface NativeMoleculeHitTolerance {
  atomHitRadius?: number;
  bondHitRadius?: number;
}

export function findNativeMoleculeDeleteHit(
  molecule: MoleculeObject,
  point: PagePoint,
  tolerance?: NativeMoleculeHitTolerance
): NativeMoleculeDeleteHit | undefined {
  if (!isEditableNativeMoleculeGraph(molecule)) {
    return undefined;
  }

  const atomHit = findNearestAtomAtPoint({
    atoms: molecule.atoms,
    point,
    hitRadius: tolerance?.atomHitRadius ?? atomHitRadius
  });
  if (atomHit) {
    return {
      kind: "atom",
      atomId: atomHit.atomId,
      distanceToPointer: atomHit.distance
    };
  }

  const bondHit = findNearestBondHit({
    atoms: molecule.atoms,
    bonds: molecule.bonds,
    point,
    hitRadius: tolerance?.bondHitRadius ?? bondHitRadius
  });
  if (!bondHit?.bondId) {
    return undefined;
  }

  return {
    kind: "bond",
    bondId: bondHit.bondId,
    fromAtomId: bondHit.fromAtomId,
    toAtomId: bondHit.toAtomId,
    terminalAtomId: bondHit.nearestTerminalAtomId,
    distanceToPointer: bondHit.distance
  };
}

// Within this along-bond distance of an endpoint the ATOM wins (spiro); beyond it the BOND
// wins (fusion). This carves a small spiro target out of each vertex while letting the fuse
// band cover the rest of every edge, so a ring tool no longer needs a pixel-perfect mid-bond
// click — yet hovering the vertex glyph (or just off it) still resolves to the atom.
const nativeTemplateVertexCapPx = nativeBondLength * 0.3;

// True when the pointer projects onto the interior span of the bond (past the vertex cap at
// either end), i.e. the pointer is genuinely "on the edge" rather than "on the vertex".
function nativeTemplatePointIsOnBondSpan(
  molecule: MoleculeObject,
  bondHit: { fromAtomId: string; toAtomId: string },
  point: PagePoint
): boolean {
  const from = molecule.atoms.find((atom) => atom.id === bondHit.fromAtomId);
  const to = molecule.atoms.find((atom) => atom.id === bondHit.toAtomId);
  if (!from || !to) {
    return false;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return false;
  }
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  const alongFromNearerEndpoint = Math.min(t, 1 - t) * Math.sqrt(lengthSquared);
  return alongFromNearerEndpoint >= nativeTemplateVertexCapPx;
}

/**
 * Template-tool variant of {@link findNativeMoleculeDeleteHit}. Unlike the atom-first delete
 * hit, this is BOND-preferring along edges: when the pointer sits over a bond's interior span
 * it returns that bond (fusion) even if a vertex is also within the atom radius — fixing the
 * "magical spot" where a near-vertex hover spiro'd instead of fusing. The vertex cap keeps a
 * small atom (spiro) target at each vertex. Purely geometric (no DOM hint), so the highlight
 * this paints and the click that commits it can never disagree. Delete/eraser is untouched.
 */
export function findNativeMoleculeTemplateHit(
  molecule: MoleculeObject,
  point: PagePoint,
  tolerance?: NativeMoleculeHitTolerance
): NativeMoleculeDeleteHit | undefined {
  if (!isEditableNativeMoleculeGraph(molecule)) {
    return undefined;
  }

  const atomHit = findNearestAtomAtPoint({
    atoms: molecule.atoms,
    point,
    hitRadius: tolerance?.atomHitRadius ?? atomHitRadius
  });
  const bondHit = findNearestBondHit({
    atoms: molecule.atoms,
    bonds: molecule.bonds,
    point,
    hitRadius: tolerance?.bondHitRadius ?? bondHitRadius
  });

  const bondCandidate = bondHit?.bondId !== undefined ? bondHit : undefined;
  const preferBond = bondCandidate !== undefined
    && (!atomHit || nativeTemplatePointIsOnBondSpan(molecule, bondCandidate, point));
  if (preferBond && bondCandidate?.bondId) {
    return {
      kind: "bond",
      bondId: bondCandidate.bondId,
      fromAtomId: bondCandidate.fromAtomId,
      toAtomId: bondCandidate.toAtomId,
      terminalAtomId: bondCandidate.nearestTerminalAtomId,
      distanceToPointer: bondCandidate.distance
    };
  }

  if (atomHit) {
    return { kind: "atom", atomId: atomHit.atomId, distanceToPointer: atomHit.distance };
  }

  if (bondCandidate?.bondId) {
    return {
      kind: "bond",
      bondId: bondCandidate.bondId,
      fromAtomId: bondCandidate.fromAtomId,
      toAtomId: bondCandidate.toAtomId,
      terminalAtomId: bondCandidate.nearestTerminalAtomId,
      distanceToPointer: bondCandidate.distance
    };
  }

  return undefined;
}

export function applyNativeMoleculeDeleteTarget(
  document: ChemDraftDocument,
  target: NativeMoleculeDeleteTarget
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const nextMolecule = target.kind === "atom"
    ? deleteNativeCarbonAtom(molecule, target.atomId)
    : deleteNativeCarbonBond(molecule, target.bondId, target.terminalAtomId);
  if (!nextMolecule) {
    return document;
  }

  if (nextMolecule.atoms.length === 0) {
    return applyPatch(
      document,
      { op: "removeObject", objectId: molecule.id },
      { now: phase4Timestamp }
    );
  }

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

export function applyNativeMoleculeBondOrderTarget(
  document: ChemDraftDocument,
  target: NativeBondOrderTarget
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const bond = molecule.bonds.find((candidate) => candidate.id === target.bondId);
  if (!bond) {
    return document;
  }

  const nextOrder = nextNativeBondOrder(molecule, bond);
  return isNativeBondOrderValue(nextOrder)
    ? applyNativeMoleculeBondOrderValueTarget(document, target, nextOrder)
    : document;
}

export function applyNativeMoleculeBondOrderValueTarget(
  document: ChemDraftDocument,
  target: NativeBondOrderTarget,
  order: NativeBondOrderValue
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const bond = molecule.bonds.find((candidate) => candidate.id === target.bondId);
  if (!bond) {
    return document;
  }

  if (order === bond.order || !canSetNativeBondOrder(molecule, bond, order)) {
    return document;
  }

  const bonds = molecule.bonds.map((candidate) =>
    candidate.id === bond.id ? nativeBondWithOrderAndDisplay(molecule, candidate, order) : candidate
  );
  const nextMolecule = refreshNativeSingleBondGraph(molecule, molecule.atoms, bonds);

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

export function applyNativeDoubleBondSideTarget(
  document: ChemDraftDocument,
  target: NativeBondOrderTarget,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const bond = molecule.bonds.find((candidate) => candidate.id === target.bondId);
  if (!bond || bond.order !== "double") {
    return document;
  }

  const doubleBondSide = doubleBondSideForPoint(molecule, bond, point);
  if (!doubleBondSide || bond.display?.doubleBondSide === doubleBondSide) {
    return document;
  }

  const bonds = molecule.bonds.map((candidate) =>
    candidate.id === bond.id
      ? { ...candidate, display: { ...(candidate.display ?? {}), doubleBondSide } }
      : candidate
  );
  const nextMolecule = refreshNativeSingleBondGraph(molecule, molecule.atoms, bonds);

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

export function applyNativeAtomElementTarget(
  document: ChemDraftDocument,
  target: NativeMoleculeDeleteTarget,
  element: string
): ChemDraftDocument {
  if (target.kind !== "atom") {
    return document;
  }

  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const atom = molecule.atoms.find((candidate) => candidate.id === target.atomId);
  const normalizedElement = normalizeNativeAtomElementLabel(element);
  const labelVisible = normalizedElement === "C";
  if (!atom || normalizedElement.length === 0) {
    return document;
  }

  if (atom.element === normalizedElement && (atom.labelVisible === true) === labelVisible) {
    return document;
  }

  const atoms = molecule.atoms.map((candidate) =>
    candidate.id === target.atomId ? nativeAtomWithElement(candidate, normalizedElement, labelVisible) : candidate
  );
  const nextMolecule = refreshNativeSingleBondGraph(molecule, atoms, molecule.bonds);

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

export function previewNativeMoleculeBondGrowth(
  molecule: MoleculeObject,
  point: PagePoint,
  pageWidth: number,
  pageHeight: number
): NativeBondGrowthPreview | undefined {
  if (!isEditableNativeMoleculeGraph(molecule)) {
    return undefined;
  }

  const atomHit = findNativeMoleculeAtomHit(molecule, point);
  if (!atomHit) {
    return undefined;
  }

  const extension = planBondExtension({
    atoms: molecule.atoms,
    bonds: molecule.bonds,
    clickPoint: point,
    bondLength: nativeBondLength,
    hitRadius: atomHitRadius,
    maxBondsPerAtom: nativeAtomInvalidGrowthLimit,
    preferredAtomId: atomHit.atomId,
    pageBounds: { x: 0, y: 0, width: pageWidth, height: pageHeight },
    objectBounds: {
      x: molecule.x,
      y: molecule.y,
      width: molecule.width,
      height: molecule.height
    }
  });

  if (!extension) {
    return undefined;
  }
  if (extension.targetAtomId && !canConnectNativeAtoms(molecule, extension.sourceAtomId, extension.targetAtomId)) {
    return undefined;
  }

  return {
    atomId: extension.sourceAtomId,
    targetAtomId: extension.targetAtomId,
    direction: extension.direction,
    candidateDirections: nativeBondGrowthCandidateDirections(molecule, extension.sourceAtomId, extension.direction),
    newAtomPoint: extension.newAtomPoint,
    distanceToPointer: extension.distanceToClick,
    availableBonds: atomHit.availableBonds
  };
}

function nativeBondGrowthCandidateDirections(
  molecule: MoleculeObject,
  atomId: string,
  selectedDirection: PagePoint
): PagePoint[] {
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  if (!atom) {
    return [selectedDirection];
  }

  const neighborAtoms = molecule.bonds
    .filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId)
    .map((bond) => molecule.atoms.find((candidate) =>
      candidate.id === (bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId)
    ))
    .filter((candidate): candidate is MoleculeAtom => candidate !== undefined);
  if (neighborAtoms.length !== 1) {
    return [selectedDirection];
  }

  const neighbor = neighborAtoms[0];
  const neighborAngle = Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x);
  const targetAngle = 120 * Math.PI / 180;
  const directions = [
    selectedDirection,
    directionFromAngle(neighborAngle + targetAngle),
    directionFromAngle(neighborAngle - targetAngle)
  ];

  return directions.reduce<PagePoint[]>((unique, direction) => {
    if (!unique.some((existing) => Math.hypot(existing.x - direction.x, existing.y - direction.y) < 0.01)) {
      unique.push(direction);
    }
    return unique;
  }, []);
}

function directionFromAngle(angle: number): PagePoint {
  return {
    x: Math.cos(angle),
    y: Math.sin(angle)
  };
}

function largestOpenAngle(angles: readonly number[]): number | undefined {
  if (angles.length === 0) {
    return undefined;
  }

  const normalizedAngles = angles.map(normalizeAngle).sort((left, right) => left - right);
  const gaps = normalizedAngles.map((angle, index) => {
    const nextAngle = normalizedAngles[(index + 1) % normalizedAngles.length] ?? angle;
    const wrappedNext = index === normalizedAngles.length - 1 ? nextAngle + Math.PI * 2 : nextAngle;
    const gap = wrappedNext - angle;
    return {
      gap,
      midpoint: normalizeAngle(angle + gap / 2)
    };
  });

  return gaps.sort((left, right) => right.gap - left.gap || left.midpoint - right.midpoint)[0]?.midpoint;
}

export function previewNativeMoleculeFreeformBondGrowth(
  molecule: MoleculeObject,
  sourceAtomId: string,
  point: PagePoint,
  pageWidth: number,
  pageHeight: number,
  options: NativeFreeformBondGrowthOptions = {}
): NativeFreeformBondGrowthPreview | undefined {
  if (!isEditableNativeMoleculeGraph(molecule)) {
    return undefined;
  }

  const sourceAtom = molecule.atoms.find((atom) => atom.id === sourceAtomId);
  if (!sourceAtom) {
    return undefined;
  }

  const atomHit = findNativeMoleculeAtomHit(molecule, sourceAtom);
  if (!atomHit || atomHit.atomId !== sourceAtomId) {
    return undefined;
  }

  const extension = planFreeformBondExtension({
    atoms: molecule.atoms,
    bonds: molecule.bonds,
    sourceAtomId,
    endPoint: point,
    bondLength: nativeBondLength,
    pageBounds: { x: 0, y: 0, width: pageWidth, height: pageHeight },
    maxBondsPerAtom: nativeAtomInvalidGrowthLimit,
    minimumBondLength: freeformMinimumBondLength,
    customLengthBreakawayDistance: freeformCustomLengthBreakawayDistance,
    forceCustomLength: options.forceCustomLength,
    snapHitRadius: atomHitRadius
  });
  if (!extension) {
    return undefined;
  }
  if (extension.targetAtomId && !canConnectNativeAtoms(molecule, extension.sourceAtomId, extension.targetAtomId)) {
    return undefined;
  }
  const length = distance(sourceAtom, extension.newAtomPoint);

  return {
    atomId: extension.sourceAtomId,
    targetAtomId: extension.targetAtomId,
    direction: extension.direction,
    candidateDirections: nativeBondGrowthCandidateDirections(molecule, extension.sourceAtomId, extension.direction),
    newAtomPoint: extension.newAtomPoint,
    distanceToPointer: extension.distanceToClick,
    availableBonds: atomHit.availableBonds,
    customLength: extension.lengthMode === "custom",
    length,
    lengthAngstrom: Number((length / nativeBondLength * nativeCarbonSingleBondLengthAngstrom).toFixed(3))
  };
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

function textObjectSpansForTextChange(object: TextObject, nextText: string): TextSpan[] {
  if (object.text === nextText) {
    return textObjectSpansForWorkflow(object);
  }

  const currentSpans = textObjectSpansForWorkflow(object);
  let prefixLength = 0;
  while (
    prefixLength < object.text.length &&
    prefixLength < nextText.length &&
    object.text[prefixLength] === nextText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < object.text.length - prefixLength &&
    suffixLength < nextText.length - prefixLength &&
    object.text[object.text.length - 1 - suffixLength] === nextText[nextText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const insertedText = nextText.slice(prefixLength, nextText.length - suffixLength);
  const insertionSpan = textSpanAtOffset(currentSpans, prefixLength)
    ?? textSpanAtOffset(currentSpans, Math.max(0, prefixLength - 1))
    ?? { text: "", script: textObjectUniformScript(object), style: {} };

  return normalizeTextSpans([
    ...textSpansForRange(currentSpans, 0, prefixLength),
    ...(insertedText.length > 0
      ? [{ text: insertedText, script: insertionSpan.script, style: { ...insertionSpan.style } }]
      : []),
    ...textSpansForRange(currentSpans, object.text.length - suffixLength, object.text.length)
  ]);
}

function updateTextObjectSpansInRange(
  object: TextObject,
  range: NativeTextSelectionRange,
  updateSpan: (span: TextSpan) => TextSpan
): TextSpan[] {
  const normalizedRange = normalizeTextSelectionRange(range, object.text.length);
  if (normalizedRange.start === normalizedRange.end) {
    return textObjectSpansForWorkflow(object);
  }

  const spans = textObjectSpansForWorkflow(object);
  let offset = 0;
  const nextSpans = spans.flatMap((span) => {
    const start = offset;
    const end = offset + span.text.length;
    offset = end;

    if (end <= normalizedRange.start || start >= normalizedRange.end) {
      return [span];
    }

    const pieces: TextSpan[] = [];
    const beforeLength = Math.max(0, normalizedRange.start - start);
    const afterStart = Math.min(span.text.length, normalizedRange.end - start);

    if (beforeLength > 0) {
      pieces.push({ ...span, text: span.text.slice(0, beforeLength), style: { ...span.style } });
    }

    const selectedText = span.text.slice(beforeLength, afterStart);
    if (selectedText.length > 0) {
      pieces.push(updateSpan({ ...span, text: selectedText, style: { ...span.style } }));
    }

    if (afterStart < span.text.length) {
      pieces.push({ ...span, text: span.text.slice(afterStart), style: { ...span.style } });
    }

    return pieces;
  });

  return normalizeTextSpans(nextSpans);
}

function textObjectSpansForWorkflow(object: TextObject): TextSpan[] {
  const spans = normalizeTextSpans(object.spans);
  if (spans.length > 0 && spans.map((span) => span.text).join("") === object.text) {
    return spans;
  }

  return object.text.length > 0
    ? [{ text: object.text, script: "normal", style: {} }]
    : [];
}

function textSpansForRange(spans: readonly TextSpan[], start: number, end: number): TextSpan[] {
  if (start >= end) {
    return [];
  }

  let offset = 0;
  return spans.flatMap((span) => {
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    offset = spanEnd;

    const sliceStart = Math.max(start, spanStart);
    const sliceEnd = Math.min(end, spanEnd);
    if (sliceStart >= sliceEnd) {
      return [];
    }

    return [{
      text: span.text.slice(sliceStart - spanStart, sliceEnd - spanStart),
      script: span.script,
      style: { ...span.style }
    }];
  });
}

function textSpanAtOffset(spans: readonly TextSpan[], offset: number): TextSpan | undefined {
  let cursor = 0;
  return spans.find((span) => {
    const start = cursor;
    cursor += span.text.length;
    return offset >= start && offset < cursor;
  });
}

function normalizeTextSelectionRange(range: NativeTextSelectionRange, textLength: number): NativeTextSelectionRange {
  const start = Math.round(clamp(Math.min(range.start, range.end), 0, textLength));
  const end = Math.round(clamp(Math.max(range.start, range.end), 0, textLength));
  return { start, end };
}

function normalizeTextSpans(spans: readonly TextSpan[]): TextSpan[] {
  return spans
    .filter((span) => span.text.length > 0)
    .reduce<TextSpan[]>((normalized, span) => {
      const next = {
        text: span.text,
        script: span.script ?? "normal",
        style: { ...span.style }
      };
      const previous = normalized[normalized.length - 1];
      if (previous && previous.script === next.script && textSpanStylesEqual(previous.style, next.style)) {
        previous.text += next.text;
        return normalized;
      }

      normalized.push(next);
      return normalized;
    }, []);
}

function textSpanStylesEqual(first: TextSpan["style"], second: TextSpan["style"]): boolean {
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  return firstKeys.length === secondKeys.length && firstKeys.every((key) => first[key] === second[key]);
}

function textObjectUniformScript(object: TextObject): TextSpan["script"] {
  const spans = textObjectSpansForWorkflow(object);
  if (spans.length === 0) {
    return "normal";
  }

  const scripts = new Set(spans.map((span) => span.script));
  return scripts.size === 1 ? [...scripts][0] ?? "normal" : "normal";
}

function documentObjectColorChanges(object: DocumentObject, color: string): Partial<DocumentObject> | undefined {
  if (object.type === "molecule") {
    return styleColorChanges(object, {
      bondColor: color,
      atomLabelColor: color
    });
  }

  if (object.type === "text") {
    return styleColorChanges(object, { color });
  }

  return styleColorChanges(object, {
    color,
    strokeColor: color,
    fillColor: color
  });
}

function styleColorChanges(
  object: DocumentObject,
  styleChanges: Record<string, string>
): Partial<DocumentObject> | undefined {
  if (Object.entries(styleChanges).every(([key, value]) => object.style[key] === value)) {
    return undefined;
  }

  return {
    style: {
      ...object.style,
      ...styleChanges
    }
  };
}

function styleColorMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function getSelectedMolecule(document: ChemDraftDocument): MoleculeObject | undefined {
  const object = getSelectedObject(document);
  return object?.type === "molecule" ? object : undefined;
}

export function getSelectedMolecules(document: ChemDraftDocument): MoleculeObject[] {
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0) {
    return [];
  }

  const moleculeById = new Map<string, MoleculeObject>();
  document.pages.forEach((page) => {
    page.objects.forEach((object) => {
      if (object.type === "molecule" && selectedIds.has(object.id)) {
        moleculeById.set(object.id, object);
      }
    });
  });

  return document.selection.objectIds
    .map((objectId) => moleculeById.get(objectId))
    .filter((molecule): molecule is MoleculeObject => molecule !== undefined);
}

export function selectDocumentObject(document: ChemDraftDocument, objectId: string): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  if (!page) {
    throw new Error(`Cannot select document object: object "${objectId}" does not exist.`);
  }

  return applyPatch(
    document,
    {
      op: "setSelection",
      pageId: page.id,
      objectIds: [objectId]
    },
    { now: phase4Timestamp }
  );
}

export function selectDocumentObjects(
  document: ChemDraftDocument,
  pageId: string,
  objectIds: readonly string[]
): ChemDraftDocument {
  return applyPatch(
    document,
    {
      op: "setSelection",
      pageId,
      objectIds: [...objectIds]
    },
    { now: phase4Timestamp }
  );
}

export function selectAllDocumentObjects(document: ChemDraftDocument, pageId: string): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page || page.objects.length === 0) {
    return document;
  }

  const objectIds = page.objects.map((object) => object.id);
  if (
    document.selection.pageId === page.id &&
    document.selection.objectIds.length === objectIds.length &&
    document.selection.objectIds.every((objectId, index) => objectId === objectIds[index])
  ) {
    return document;
  }

  return selectDocumentObjects(document, page.id, objectIds);
}

export function reorderSelectedDocumentObject(
  document: ChemDraftDocument,
  placement: ObjectReorderPlacement
): ChemDraftDocument {
  const objectId = document.selection.objectIds[0];
  if (!objectId) {
    return document;
  }

  return applyPatch(
    document,
    { op: "reorderObject", objectId, placement },
    { now: phase4Timestamp }
  );
}

export function reorderNativeMoleculeParts(
  document: ChemDraftDocument,
  target: NativeMoleculePartReorderTarget,
  placement: ObjectReorderPlacement
): ChemDraftDocument {
  void target;
  void placement;
  return document;
}

export function moveNativeMoleculeParts(
  document: ChemDraftDocument,
  target: NativeMoleculePartMoveTarget,
  delta: PagePoint
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === target.objectId));
  const molecule = page?.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!page || !molecule) {
    return document;
  }

  const targetAtomIds = nativeMoleculePartAtomIds(molecule, target);
  if (targetAtomIds.size === 0) {
    return document;
  }

  const targetAtoms = molecule.atoms.filter((atom) => targetAtomIds.has(atom.id));
  const minX = Math.min(...targetAtoms.map((atom) => atom.x));
  const maxX = Math.max(...targetAtoms.map((atom) => atom.x));
  const minY = Math.min(...targetAtoms.map((atom) => atom.y));
  const maxY = Math.max(...targetAtoms.map((atom) => atom.y));
  const dx = clamp(delta.x, -minX, page.width - maxX);
  const dy = clamp(delta.y, -minY, page.height - maxY);
  if (dx === 0 && dy === 0) {
    return document;
  }

  const moved = normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => targetAtomIds.has(atom.id)
      ? { ...atom, x: atom.x + dx, y: atom.y + dy }
      : atom)
  });

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: molecule.id,
      changes: {
        x: moved.x,
        y: moved.y,
        width: moved.width,
        height: moved.height,
        atoms: moved.atoms
      }
    },
    { now: phase4Timestamp }
  );
}

export function nativeMoleculePartBounds(
  molecule: MoleculeObject,
  target: NativeMoleculePartMoveTarget
): PageRect | undefined {
  const targetAtomIds = nativeMoleculePartAtomIds(molecule, target);
  if (targetAtomIds.size === 0) {
    return undefined;
  }

  const targetAtoms = molecule.atoms.filter((atom) => targetAtomIds.has(atom.id));
  if (targetAtoms.length === 0) {
    return undefined;
  }

  const minX = Math.min(...targetAtoms.map((atom) => atom.x));
  const maxX = Math.max(...targetAtoms.map((atom) => atom.x));
  const minY = Math.min(...targetAtoms.map((atom) => atom.y));
  const maxY = Math.max(...targetAtoms.map((atom) => atom.y));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

export function moveDocumentObject(
  document: ChemDraftDocument,
  objectId: string,
  position: PagePoint
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const object = page?.objects.find((candidate) => candidate.id === objectId);
  if (!page || !object) {
    return document;
  }

  const nextX = clamp(position.x, 0, Math.max(0, page.width - object.width));
  const nextY = clamp(position.y, 0, Math.max(0, page.height - object.height));
  const dx = nextX - object.x;
  const dy = nextY - object.y;
  if (dx === 0 && dy === 0) {
    return document;
  }

  if (object.type === "molecule") {
    const translatedTransform = translateNativeMoleculeTransformCenter(object, dx, dy);
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          atoms: object.atoms.map((atom) => ({
            ...atom,
            x: atom.x + dx,
            y: atom.y + dy
          })),
          ...(translatedTransform ? { transform: translatedTransform } : {})
        }
      },
      { now: phase4Timestamp }
    );
  }

  if (object.type === "electron-mark" && object.markKind === "charge") {
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          anchor: {
            ...object.anchor,
            kind: "point",
            point: {
              x: nextX + object.width / 2,
              y: nextY + object.height / 2
            }
          }
        }
      },
      { now: phase4Timestamp }
    );
  }

  return applyPatch(
    document,
    {
      op: "moveObject",
      objectId,
      x: nextX,
      y: nextY
    },
    { now: phase4Timestamp }
  );
}

export function rotateNativeMoleculeParts(
  document: ChemDraftDocument,
  target: NativeMoleculePartMoveTarget,
  angleDegrees: number
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === target.objectId));
  const molecule = page?.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!page || !molecule || Math.abs(angleDegrees) < 0.05) {
    return document;
  }

  const targetAtomIds = nativeMoleculePartAtomIds(molecule, target);
  const bounds = nativeMoleculePartBounds(molecule, target);
  if (targetAtomIds.size === 0 || !bounds) {
    return document;
  }

  const center = objectCenter(bounds);
  const angleRadians = angleDegrees * Math.PI / 180;
  const rotated = normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => targetAtomIds.has(atom.id)
      ? { ...atom, ...rotatePointAround(atom, center, angleRadians) }
      : atom)
  });

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: rotated },
    { now: phase4Timestamp }
  );
}

export function rotateDocumentObject(
  document: ChemDraftDocument,
  objectId: string,
  angleDegrees: number
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const object = page?.objects.find((candidate) => candidate.id === objectId);
  if (!page || !object || Math.abs(angleDegrees) < 0.05) {
    return document;
  }

  if (object.type === "molecule" && object.atoms.length > 0) {
    const center = objectCenter(object);
    const angleRadians = (object.rotation + angleDegrees) * Math.PI / 180;
    const atoms = object.atoms.map((atom) => ({
      ...atom,
      ...rotatePointAround(atom, center, angleRadians)
    }));
    const transform = nativeMoleculeTransformState(object);
    const nextMolecule = withNativeMoleculeTransform(normalizeNativeMoleculeGeometry({
      ...object,
      rotation: 0,
      atoms
    }), {
      ...transform,
      rotationDegrees: transform.rotationDegrees + angleDegrees
    });

    return applyPatch(
      document,
      { op: "updateObject", objectId, changes: nextMolecule },
      { now: phase4Timestamp }
    );
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        rotation: normalizeDegrees(object.rotation + angleDegrees)
      }
    },
    { now: phase4Timestamp }
  );
}

export function rotateNativeMoleculeObjectAroundPoint(
  document: ChemDraftDocument,
  objectId: string,
  center: PagePoint,
  angleDegrees: number
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const molecule = page?.objects.find((candidate): candidate is MoleculeObject =>
    candidate.id === objectId && candidate.type === "molecule"
  );
  if (!page || !molecule || molecule.atoms.length === 0 || Math.abs(angleDegrees) < 0.05) {
    return document;
  }

  const angleRadians = (molecule.rotation + angleDegrees) * Math.PI / 180;
  const atoms = molecule.atoms.map((atom) => ({
    ...atom,
    ...rotatePointAround(atom, center, angleRadians)
  }));
  const transform = nativeMoleculeTransformState(molecule);
  const nextMolecule = withNativeMoleculeTransform(normalizeNativeMoleculeGeometry({
    ...molecule,
    rotation: 0,
    atoms
  }), {
    ...transform,
    rotationDegrees: transform.rotationDegrees + angleDegrees
  });

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

export function clampProjectedPlaneTiltRadians(tiltRad: number): ProjectedPlaneTiltClamp {
  const finiteTilt = Number.isFinite(tiltRad) ? tiltRad : 0;
  const clampedTilt = clamp(finiteTilt, -projectedPlaneTiltMaxRadians, projectedPlaneTiltMaxRadians);
  return {
    tiltRad: clampedTilt,
    clamped: Math.abs(clampedTilt - finiteTilt) > 1e-9
  };
}

export function clampProjectedPlaneTiltVectorRadians(tiltXRad: number, tiltYRad: number): ProjectedPlaneTiltVectorClamp {
  const finiteTiltX = Number.isFinite(tiltXRad) ? tiltXRad : 0;
  const finiteTiltY = Number.isFinite(tiltYRad) ? tiltYRad : 0;
  const magnitude = Math.hypot(finiteTiltX, finiteTiltY);
  if (magnitude <= projectedPlaneTiltMaxRadians || magnitude <= 1e-9) {
    return {
      tiltXRad: finiteTiltX,
      tiltYRad: finiteTiltY,
      clamped: !Number.isFinite(tiltXRad) || !Number.isFinite(tiltYRad)
    };
  }

  const scale = projectedPlaneTiltMaxRadians / magnitude;
  return {
    tiltXRad: finiteTiltX * scale,
    tiltYRad: finiteTiltY * scale,
    clamped: true
  };
}

export function tiltPointAroundPageAxis(
  point: ProjectedPlaneTiltPoint,
  center: ProjectedPlaneTiltPoint,
  axisAngleRad: number,
  tiltRad: number
): ProjectedPlaneTiltResult {
  const ux = Math.cos(axisAngleRad);
  const uy = Math.sin(axisAngleRad);
  const vx = -uy;
  const vy = ux;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const alongAxis = dx * ux + dy * uy;
  const acrossAxis = dx * vx + dy * vy;
  const s = Math.sin(tiltRad);
  const tiltedAlongAxis = alongAxis + acrossAxis * s;

  return {
    x: center.x + tiltedAlongAxis * ux + acrossAxis * vx,
    y: center.y + tiltedAlongAxis * uy + acrossAxis * vy,
    z: acrossAxis * s
  };
}

function retargetProjectedPlaneTiltPointAroundPageAxis(
  point: ProjectedPlaneTiltPoint,
  center: ProjectedPlaneTiltPoint,
  axisAngleRad: number,
  fromTiltRad: number,
  toTiltRad: number
): ProjectedPlaneTiltResult {
  const ux = Math.cos(axisAngleRad);
  const uy = Math.sin(axisAngleRad);
  const vx = -uy;
  const vy = ux;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const alongAxis = dx * ux + dy * uy;
  const acrossAxis = dx * vx + dy * vy;
  const fromSin = Math.sin(fromTiltRad);
  const toSin = Math.sin(toTiltRad);
  const baseAlongAxis = alongAxis - acrossAxis * fromSin;
  const tiltedAlongAxis = baseAlongAxis + acrossAxis * toSin;

  return {
    x: center.x + tiltedAlongAxis * ux + acrossAxis * vx,
    y: center.y + tiltedAlongAxis * uy + acrossAxis * vy,
    z: acrossAxis * toSin
  };
}

function retargetProjectedPlaneTiltPoint(
  point: ProjectedPlaneTiltPoint,
  center: ProjectedPlaneTiltPoint,
  fromTiltXRad: number,
  fromTiltYRad: number,
  toTiltXRad: number,
  toTiltYRad: number,
  fromRotationDegrees = 0,
  toRotationDegrees = fromRotationDegrees
): ProjectedPlaneTiltResult {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const fromRotationRad = -fromRotationDegrees * Math.PI / 180;
  const fromRotationCos = Math.cos(fromRotationRad);
  const fromRotationSin = Math.sin(fromRotationRad);
  const localX = dx * fromRotationCos - dy * fromRotationSin;
  const localY = dx * fromRotationSin + dy * fromRotationCos;
  const fromXShear = Math.sin(fromTiltXRad);
  const fromYShear = Math.sin(fromTiltYRad);
  const baseY = localY - fromYShear * localX;
  const baseX = localX - fromXShear * baseY;
  const toXShear = Math.sin(toTiltXRad);
  const toYShear = Math.sin(toTiltYRad);
  const projectedX = baseX + baseY * toXShear;
  const projectedY = baseY + projectedX * toYShear;
  const toRotationRad = toRotationDegrees * Math.PI / 180;
  const toRotationCos = Math.cos(toRotationRad);
  const toRotationSin = Math.sin(toRotationRad);

  return {
    x: center.x + projectedX * toRotationCos - projectedY * toRotationSin,
    y: center.y + projectedX * toRotationSin + projectedY * toRotationCos,
    z: baseY * toXShear - baseX * toYShear
  };
}

function normalizedDegreeDelta(left: number, right: number): number {
  let delta = normalizeDegrees(left) - normalizeDegrees(right);
  if (delta > 180) {
    delta -= 360;
  }
  if (delta < -180) {
    delta += 360;
  }
  return delta;
}

export function tiltNativeMoleculeProjectedPlane(
  document: ChemDraftDocument,
  objectId: string,
  center: PagePoint,
  axisAngleRad: number,
  tiltRad: number,
  options: ProjectedPlaneTiltOptions = {}
): ProjectedPlaneTiltDocumentResult {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const molecule = page?.objects.find((candidate): candidate is MoleculeObject =>
    candidate.id === objectId && candidate.type === "molecule"
  );
  const resolvedTiltVector = clampProjectedPlaneTiltVectorRadians(tiltRad, options.tiltYRad ?? 0);
  const fromTiltX = clampProjectedPlaneTiltRadians(options.fromTiltRad ?? 0);
  const fromTiltY = clampProjectedPlaneTiltRadians(options.fromTiltYRad ?? 0);
  const fromTiltVector = {
    tiltXRad: fromTiltX.tiltRad,
    tiltYRad: fromTiltY.tiltRad,
    clamped: fromTiltX.clamped || fromTiltY.clamped
  };
  const transform = molecule ? nativeMoleculeTransformState(molecule) : defaultNativeMoleculeTransform;
  const fromRotationDegrees = normalizeDegrees(options.fromRotationDegrees ?? transform.rotationDegrees);
  const resolvedRotationDegrees = normalizeDegrees(options.rotationDegrees ?? fromRotationDegrees);
  const rotationChanged = Math.abs(normalizedDegreeDelta(resolvedRotationDegrees, fromRotationDegrees)) >= 0.001;
  const useTiltVector =
    options.tiltYRad !== undefined ||
    options.fromTiltYRad !== undefined ||
    options.rotationDegrees !== undefined ||
    options.fromRotationDegrees !== undefined ||
    options.persistTransform === true;
  const mutateWhenClamped = options.mutateWhenClamped ?? true;
  if (
    !page ||
    !molecule ||
    molecule.atoms.length === 0 ||
    (
      Math.abs(resolvedTiltVector.tiltXRad - fromTiltVector.tiltXRad) < 0.001 &&
      (!useTiltVector || (
        Math.abs(resolvedTiltVector.tiltYRad - fromTiltVector.tiltYRad) < 0.001 &&
        !rotationChanged
      ))
    )
  ) {
    return {
      document,
      tiltRad: resolvedTiltVector.tiltXRad,
      tiltXRad: resolvedTiltVector.tiltXRad,
      tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
      rotationDegrees: resolvedRotationDegrees,
      clamped: resolvedTiltVector.clamped || fromTiltVector.clamped,
      changed: false
    };
  }
  if ((resolvedTiltVector.clamped || fromTiltVector.clamped) && !mutateWhenClamped) {
    return {
      document,
      tiltRad: resolvedTiltVector.tiltXRad,
      tiltXRad: resolvedTiltVector.tiltXRad,
      tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
      rotationDegrees: resolvedRotationDegrees,
      clamped: true,
      changed: false
    };
  }

  const projectedPlaneCenter = useTiltVector && transform.tiltCenterX !== undefined && transform.tiltCenterY !== undefined
    ? { x: transform.tiltCenterX, y: transform.tiltCenterY }
    : center;
  const tiltedGeometry = normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => {
      const point = useTiltVector
        ? retargetProjectedPlaneTiltPoint(
            atom,
            projectedPlaneCenter,
            fromTiltVector.tiltXRad,
            fromTiltVector.tiltYRad,
            resolvedTiltVector.tiltXRad,
            resolvedTiltVector.tiltYRad,
            fromRotationDegrees,
            resolvedRotationDegrees
          )
        : retargetProjectedPlaneTiltPointAroundPageAxis(
            atom,
            projectedPlaneCenter,
            axisAngleRad,
            fromTiltVector.tiltXRad,
            resolvedTiltVector.tiltXRad
          );
      return {
        ...atom,
        x: roundGeometryCoordinate(point.x),
        y: roundGeometryCoordinate(point.y)
      };
    })
  });
  const tilted = options.persistTransform
    ? withNativeMoleculeTransform(tiltedGeometry, {
        ...transform,
        rotationDegrees: resolvedRotationDegrees,
        tiltXDegrees: radiansToDegrees(resolvedTiltVector.tiltXRad),
        tiltYDegrees: radiansToDegrees(resolvedTiltVector.tiltYRad),
        tiltCenterX: projectedPlaneCenter.x,
        tiltCenterY: projectedPlaneCenter.y
      })
    : tiltedGeometry;
  const changed = nativeMoleculeGeometryOrTransformChanged(molecule, tilted);
  if (!changed) {
    return {
      document,
      tiltRad: resolvedTiltVector.tiltXRad,
      tiltXRad: resolvedTiltVector.tiltXRad,
      tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
      rotationDegrees: resolvedRotationDegrees,
      clamped: resolvedTiltVector.clamped || fromTiltVector.clamped,
      changed: false
    };
  }

  return {
    document: applyPatch(
      document,
      { op: "updateObject", objectId, changes: tilted },
      { now: phase4Timestamp }
    ),
    tiltRad: resolvedTiltVector.tiltXRad,
    tiltXRad: resolvedTiltVector.tiltXRad,
    tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
    rotationDegrees: resolvedRotationDegrees,
    clamped: resolvedTiltVector.clamped || fromTiltVector.clamped,
    changed: true
  };
}

export function tiltNativeMoleculePartsProjectedPlane(
  document: ChemDraftDocument,
  target: NativeMoleculePartMoveTarget,
  center: PagePoint,
  axisAngleRad: number,
  tiltRad: number,
  options: ProjectedPlaneTiltOptions = {}
): ProjectedPlaneTiltDocumentResult {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === target.objectId));
  const molecule = page?.objects.find((candidate): candidate is MoleculeObject =>
    candidate.id === target.objectId && candidate.type === "molecule"
  );
  const resolvedTiltVector = clampProjectedPlaneTiltVectorRadians(tiltRad, options.tiltYRad ?? 0);
  const fromTiltX = clampProjectedPlaneTiltRadians(options.fromTiltRad ?? 0);
  const fromTiltY = clampProjectedPlaneTiltRadians(options.fromTiltYRad ?? 0);
  const fromTiltVector = {
    tiltXRad: fromTiltX.tiltRad,
    tiltYRad: fromTiltY.tiltRad,
    clamped: fromTiltX.clamped || fromTiltY.clamped
  };
  const fromRotationDegrees = normalizeDegrees(options.fromRotationDegrees ?? 0);
  const resolvedRotationDegrees = normalizeDegrees(options.rotationDegrees ?? fromRotationDegrees);
  const rotationChanged = Math.abs(normalizedDegreeDelta(resolvedRotationDegrees, fromRotationDegrees)) >= 0.001;
  const useTiltVector =
    options.tiltYRad !== undefined ||
    options.fromTiltYRad !== undefined ||
    options.rotationDegrees !== undefined ||
    options.fromRotationDegrees !== undefined;
  const mutateWhenClamped = options.mutateWhenClamped ?? true;
  if (
    !page ||
    !molecule ||
    molecule.atoms.length === 0 ||
    (
      Math.abs(resolvedTiltVector.tiltXRad - fromTiltVector.tiltXRad) < 0.001 &&
      (!useTiltVector || (
        Math.abs(resolvedTiltVector.tiltYRad - fromTiltVector.tiltYRad) < 0.001 &&
        !rotationChanged
      ))
    )
  ) {
    return {
      document,
      tiltRad: resolvedTiltVector.tiltXRad,
      tiltXRad: resolvedTiltVector.tiltXRad,
      tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
      rotationDegrees: resolvedRotationDegrees,
      clamped: resolvedTiltVector.clamped || fromTiltVector.clamped,
      changed: false
    };
  }
  if ((resolvedTiltVector.clamped || fromTiltVector.clamped) && !mutateWhenClamped) {
    return {
      document,
      tiltRad: resolvedTiltVector.tiltXRad,
      tiltXRad: resolvedTiltVector.tiltXRad,
      tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
      rotationDegrees: resolvedRotationDegrees,
      clamped: true,
      changed: false
    };
  }

  const targetAtomIds = nativeMoleculePartAtomIds(molecule, target);
  if (targetAtomIds.size === 0) {
      return {
        document,
        tiltRad: resolvedTiltVector.tiltXRad,
        tiltXRad: resolvedTiltVector.tiltXRad,
        tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
        rotationDegrees: resolvedRotationDegrees,
        clamped: resolvedTiltVector.clamped || fromTiltVector.clamped,
        changed: false
      };
  }

  const tilted = normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => {
      if (!targetAtomIds.has(atom.id)) {
        return atom;
      }

      const point = useTiltVector
        ? retargetProjectedPlaneTiltPoint(
            atom,
            center,
            fromTiltVector.tiltXRad,
            fromTiltVector.tiltYRad,
            resolvedTiltVector.tiltXRad,
            resolvedTiltVector.tiltYRad,
            fromRotationDegrees,
            resolvedRotationDegrees
          )
        : retargetProjectedPlaneTiltPointAroundPageAxis(
            atom,
            center,
            axisAngleRad,
            fromTiltVector.tiltXRad,
            resolvedTiltVector.tiltXRad
          );
      return {
        ...atom,
        x: roundGeometryCoordinate(point.x),
        y: roundGeometryCoordinate(point.y)
      };
    })
  });
  const changed = nativeMoleculeGeometryOrTransformChanged(molecule, tilted);
  if (!changed) {
    return {
      document,
      tiltRad: resolvedTiltVector.tiltXRad,
      tiltXRad: resolvedTiltVector.tiltXRad,
      tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
      rotationDegrees: resolvedRotationDegrees,
      clamped: resolvedTiltVector.clamped || fromTiltVector.clamped,
      changed: false
    };
  }

  return {
    document: applyPatch(
      document,
      { op: "updateObject", objectId: molecule.id, changes: tilted },
      { now: phase4Timestamp }
    ),
    tiltRad: resolvedTiltVector.tiltXRad,
    tiltXRad: resolvedTiltVector.tiltXRad,
    tiltYRad: useTiltVector ? resolvedTiltVector.tiltYRad : 0,
    rotationDegrees: resolvedRotationDegrees,
    clamped: resolvedTiltVector.clamped || fromTiltVector.clamped,
    changed: true
  };
}

export function resizeNativeMoleculeParts(
  document: ChemDraftDocument,
  target: NativeMoleculePartMoveTarget,
  scale: { x: number; y: number }
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === target.objectId));
  const molecule = page?.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!page || !molecule || molecule.atoms.length === 0) {
    return document;
  }

  const scaleX = Number.isFinite(scale.x) ? scale.x : 1;
  const scaleY = Number.isFinite(scale.y) ? scale.y : 1;
  if (scaleX <= 0 || scaleY <= 0 || (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001)) {
    return document;
  }

  const targetAtomIds = nativeMoleculePartAtomIds(molecule, target);
  const bounds = nativeMoleculePartBounds(molecule, target);
  if (targetAtomIds.size === 0 || !bounds) {
    return document;
  }

  const center = objectCenter(bounds);
  const resized = normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => targetAtomIds.has(atom.id)
      ? {
          ...atom,
          x: center.x + (atom.x - center.x) * scaleX,
          y: center.y + (atom.y - center.y) * scaleY
        }
      : atom)
  });

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: resized },
    { now: phase4Timestamp }
  );
}

export function resizeNativeMoleculeObject(
  document: ChemDraftDocument,
  objectId: string,
  scale: { x: number; y: number }
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const molecule = page?.objects.find((object): object is MoleculeObject =>
    object.id === objectId && object.type === "molecule"
  );
  if (!page || !molecule || molecule.atoms.length === 0) {
    return document;
  }

  const scaleX = Number.isFinite(scale.x) ? scale.x : 1;
  const scaleY = Number.isFinite(scale.y) ? scale.y : 1;
  if (scaleX <= 0 || scaleY <= 0 || (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001)) {
    return document;
  }

  const center = objectCenter(molecule);
  const transform = nativeMoleculeTransformState(molecule);
  const resized = withNativeMoleculeTransform(normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => ({
      ...atom,
      x: center.x + (atom.x - center.x) * scaleX,
      y: center.y + (atom.y - center.y) * scaleY
    }))
  }), {
    ...transform,
    scaleX: transform.scaleX * scaleX,
    scaleY: transform.scaleY * scaleY
  });

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: resized },
    { now: phase4Timestamp }
  );
}

// ---------------------------------------------------------------------------
// Group transforms — move/rotate/scale a *set* of selected objects as one rigid
// group about a common center. Coordinates (and, for scale, sizes) change only;
// connectivity, bond order, charge, and stereo are preserved. Each helper fans
// out to per-object transforms about the shared center, reusing the single-object
// molecule transforms. (AGENTS.md §6.8 names layout-engine as the long-term home;
// kept here beside the single-object versions for now.)
// ---------------------------------------------------------------------------

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/** Union axis-aligned bounding box (and center) of the selected objects, in page coords. */
export function selectionBounds(
  objects: readonly DocumentObject[],
  ids: readonly string[]
): SelectionBounds | undefined {
  const set = new Set(ids);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const object of objects) {
    if (!set.has(object.id)) {
      continue;
    }
    minX = Math.min(minX, object.x);
    minY = Math.min(minY, object.y);
    maxX = Math.max(maxX, object.x + object.width);
    maxY = Math.max(maxY, object.y + object.height);
    count += 1;
  }
  if (count === 0) {
    return undefined;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

/** Translate one object by a delta (no per-object clamping — the group clamps as a whole). */
function translateDocumentObjectBy(
  document: ChemDraftDocument,
  objectId: string,
  dx: number,
  dy: number
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const object = page?.objects.find((candidate) => candidate.id === objectId);
  if (!page || !object || (dx === 0 && dy === 0)) {
    return document;
  }

  const nextX = object.x + dx;
  const nextY = object.y + dy;

  if (object.type === "molecule") {
    const translatedTransform = translateNativeMoleculeTransformCenter(object, dx, dy);
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          atoms: object.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy })),
          ...(translatedTransform ? { transform: translatedTransform } : {})
        }
      },
      { now: phase4Timestamp }
    );
  }

  if (object.type === "electron-mark" && object.markKind === "charge") {
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          anchor: {
            ...object.anchor,
            kind: "point",
            point: { x: nextX + object.width / 2, y: nextY + object.height / 2 }
          }
        }
      },
      { now: phase4Timestamp }
    );
  }

  return applyPatch(
    document,
    { op: "moveObject", objectId, x: nextX, y: nextY },
    { now: phase4Timestamp }
  );
}

/** Move every object in `ids` by the same delta, clamped so the group bbox stays on the page. */
export function moveDocumentObjects(
  document: ChemDraftDocument,
  ids: readonly string[],
  dx: number,
  dy: number
): ChemDraftDocument {
  const page = firstPage(document);
  const bounds = selectionBounds(page.objects, ids);
  if (!bounds) {
    return document;
  }

  const cdx = clamp(dx, -bounds.x, Math.max(-bounds.x, page.width - (bounds.x + bounds.width)));
  const cdy = clamp(dy, -bounds.y, Math.max(-bounds.y, page.height - (bounds.y + bounds.height)));
  if (Math.abs(cdx) < 1e-6 && Math.abs(cdy) < 1e-6) {
    return document;
  }

  const set = new Set(ids);
  let next = document;
  for (const object of page.objects) {
    if (set.has(object.id)) {
      next = translateDocumentObjectBy(next, object.id, cdx, cdy);
    }
  }
  return next;
}

/** Scale a molecule's atoms about an arbitrary external `center` (group-scale building block). */
function scaleNativeMoleculeObjectAroundPoint(
  document: ChemDraftDocument,
  objectId: string,
  center: PagePoint,
  scaleX: number,
  scaleY: number
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const molecule = page?.objects.find((candidate): candidate is MoleculeObject =>
    candidate.id === objectId && candidate.type === "molecule"
  );
  if (!page || !molecule || molecule.atoms.length === 0) {
    return document;
  }

  const transform = nativeMoleculeTransformState(molecule);
  const resized = withNativeMoleculeTransform(normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => ({
      ...atom,
      x: center.x + (atom.x - center.x) * scaleX,
      y: center.y + (atom.y - center.y) * scaleY
    }))
  }), {
    ...transform,
    scaleX: transform.scaleX * scaleX,
    scaleY: transform.scaleY * scaleY
  });

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: resized },
    { now: phase4Timestamp }
  );
}

/** Reposition a non-molecule object's center about `center`, applying rotation/scale to its own box. */
function transformOtherObjectAroundPoint(
  document: ChemDraftDocument,
  objectId: string,
  center: PagePoint,
  options: { degrees?: number; scaleX?: number; scaleY?: number }
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const object = page?.objects.find((candidate) => candidate.id === objectId);
  if (!page || !object) {
    return document;
  }

  const degrees = options.degrees ?? 0;
  const scaleX = options.scaleX ?? 1;
  const scaleY = options.scaleY ?? 1;
  const oldCenter = objectCenter(object);
  const scaledCenter = {
    x: center.x + (oldCenter.x - center.x) * scaleX,
    y: center.y + (oldCenter.y - center.y) * scaleY
  };
  const newCenter = Math.abs(degrees) >= 0.05
    ? rotatePointAround(scaledCenter, center, degrees * Math.PI / 180)
    : scaledCenter;
  const nextWidth = object.width * scaleX;
  const nextHeight = object.height * scaleY;
  const nextX = newCenter.x - nextWidth / 2;
  const nextY = newCenter.y - nextHeight / 2;

  const changes: Record<string, unknown> = {
    x: nextX,
    y: nextY,
    width: nextWidth,
    height: nextHeight,
    rotation: normalizeDegrees(object.rotation + degrees)
  };
  if (object.type === "electron-mark" && object.markKind === "charge") {
    changes.anchor = { ...object.anchor, kind: "point", point: { x: newCenter.x, y: newCenter.y } };
  }

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: changes as Partial<DocumentObject> },
    { now: phase4Timestamp }
  );
}

/** Rotate every object in `ids` about the shared `center` by `degrees`. */
export function rotateDocumentObjectsAroundPoint(
  document: ChemDraftDocument,
  ids: readonly string[],
  center: PagePoint,
  degrees: number
): ChemDraftDocument {
  if (Math.abs(degrees) < 0.05) {
    return document;
  }
  const page = firstPage(document);
  const set = new Set(ids);
  let next = document;
  for (const object of page.objects) {
    if (!set.has(object.id)) {
      continue;
    }
    next = object.type === "molecule"
      ? rotateNativeMoleculeObjectAroundPoint(next, object.id, center, degrees)
      : transformOtherObjectAroundPoint(next, object.id, center, { degrees });
  }
  return next;
}

/** Scale every object in `ids` about the shared `center` by `scaleX`/`scaleY`. */
export function scaleDocumentObjectsAroundPoint(
  document: ChemDraftDocument,
  ids: readonly string[],
  center: PagePoint,
  scaleX: number,
  scaleY: number
): ChemDraftDocument {
  const sx = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
  const sy = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1;
  if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) {
    return document;
  }
  const page = firstPage(document);
  const set = new Set(ids);
  let next = document;
  for (const object of page.objects) {
    if (!set.has(object.id)) {
      continue;
    }
    next = object.type === "molecule"
      ? scaleNativeMoleculeObjectAroundPoint(next, object.id, center, sx, sy)
      : transformOtherObjectAroundPoint(next, object.id, center, { scaleX: sx, scaleY: sy });
  }
  return next;
}

export function cleanUpSelectedNativeMolecule2d(document: ChemDraftDocument): ChemDraftDocument {
  return cleanUpNativeMolecules2d(document, document.selection.objectIds);
}

export function cleanUpNativeMolecules2d(
  document: ChemDraftDocument,
  objectIds: readonly string[]
): ChemDraftDocument {
  const targetIds = [...new Set(objectIds)];
  if (targetIds.length === 0) {
    return document;
  }

  const moleculeById = new Map<string, MoleculeObject>();
  document.pages.forEach((page) => {
    page.objects.forEach((object) => {
      if (object.type === "molecule" && isEditableNativeMoleculeGraph(object)) {
        moleculeById.set(object.id, object);
      }
    });
  });

  const patches = targetIds.flatMap((objectId) => {
    const molecule = moleculeById.get(objectId);
    if (!molecule) {
      return [];
    }

    const cleaned = cleanUpNativeMoleculeGeometry2d(molecule);
    return nativeMoleculeGeometryOrTransformChanged(molecule, cleaned)
      ? [{ op: "updateObject" as const, objectId: molecule.id, changes: cleaned }]
      : [];
  });

  if (patches.length === 0) {
    return document;
  }

  return applyPatches(document, patches, { now: phase4Timestamp });
}

export function nativeMoleculeTransformState(molecule: MoleculeObject): MoleculeTransformState {
  const tiltXDegrees = normalizeProjectedPlaneTiltDegrees(molecule.transform?.tiltXDegrees);
  const tiltYDegrees = normalizeProjectedPlaneTiltDegrees(molecule.transform?.tiltYDegrees);
  const hasProjectedPlaneTilt = tiltXDegrees !== undefined || tiltYDegrees !== undefined;
  const tiltCenterX = hasProjectedPlaneTilt
    ? normalizeProjectedPlaneTiltCenterCoordinate(molecule.transform?.tiltCenterX)
    : undefined;
  const tiltCenterY = hasProjectedPlaneTilt
    ? normalizeProjectedPlaneTiltCenterCoordinate(molecule.transform?.tiltCenterY)
    : undefined;
  return {
    scaleX: normalizeNativeMoleculeScale(molecule.transform?.scaleX ?? defaultNativeMoleculeTransform.scaleX),
    scaleY: normalizeNativeMoleculeScale(molecule.transform?.scaleY ?? defaultNativeMoleculeTransform.scaleY),
    rotationDegrees: normalizeDegrees(molecule.transform?.rotationDegrees ?? defaultNativeMoleculeTransform.rotationDegrees),
    ...(tiltXDegrees === undefined ? {} : { tiltXDegrees }),
    ...(tiltYDegrees === undefined ? {} : { tiltYDegrees }),
    ...(tiltCenterX === undefined || tiltCenterY === undefined ? {} : { tiltCenterX, tiltCenterY })
  };
}

function withNativeMoleculeTransform(
  molecule: MoleculeObject,
  transform: MoleculeTransformState
): MoleculeObject {
  const tiltXDegrees = normalizeProjectedPlaneTiltDegrees(transform.tiltXDegrees);
  const tiltYDegrees = normalizeProjectedPlaneTiltDegrees(transform.tiltYDegrees);
  const hasProjectedPlaneTilt = tiltXDegrees !== undefined || tiltYDegrees !== undefined;
  const tiltCenterX = hasProjectedPlaneTilt
    ? normalizeProjectedPlaneTiltCenterCoordinate(transform.tiltCenterX)
    : undefined;
  const tiltCenterY = hasProjectedPlaneTilt
    ? normalizeProjectedPlaneTiltCenterCoordinate(transform.tiltCenterY)
    : undefined;
  return {
    ...molecule,
    transform: {
      scaleX: normalizeNativeMoleculeScale(transform.scaleX),
      scaleY: normalizeNativeMoleculeScale(transform.scaleY),
      rotationDegrees: normalizeDegrees(transform.rotationDegrees),
      ...(tiltXDegrees === undefined ? {} : { tiltXDegrees }),
      ...(tiltYDegrees === undefined ? {} : { tiltYDegrees }),
      ...(tiltCenterX === undefined || tiltCenterY === undefined ? {} : { tiltCenterX, tiltCenterY })
    }
  };
}

function translateNativeMoleculeTransformCenter(
  molecule: MoleculeObject,
  dx: number,
  dy: number
): MoleculeTransformState | undefined {
  const transform = nativeMoleculeTransformState(molecule);
  if (transform.tiltCenterX === undefined || transform.tiltCenterY === undefined) {
    return undefined;
  }

  return {
    ...transform,
    tiltCenterX: roundGeometryCoordinate(transform.tiltCenterX + dx),
    tiltCenterY: roundGeometryCoordinate(transform.tiltCenterY + dy)
  };
}

function cleanUpNativeMoleculeGeometry2d(molecule: MoleculeObject): MoleculeObject {
  if (molecule.atoms.length <= 1 || molecule.bonds.length === 0) {
    return withNativeMoleculeTransform(normalizeNativeMoleculeGeometry(molecule), defaultNativeMoleculeTransform);
  }

  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const adjacency = nativeAdjacency(molecule.atoms, molecule.bonds);
  const bondByAtomPair = nativeBondByAtomPair(molecule.bonds);
  const nextAtomPoints = new Map<string, PagePoint>();

  nativeComponents(molecule.atoms, adjacency).forEach((componentIds) => {
    const componentAtomSet = new Set(componentIds);
    const componentAtoms = componentIds
      .map((atomId) => atomById.get(atomId))
      .filter((atom): atom is MoleculeAtom => atom !== undefined);
    const componentCenter = averagePagePoint(componentAtoms);
    const layout = cleanUpNativeMoleculeComponent2d({
      componentAtoms,
      componentAtomSet,
      atomById,
      adjacency,
      bondByAtomPair
    });
    const componentBonds = molecule.bonds.filter((bond) => componentAtomSet.has(bond.fromAtomId) && componentAtomSet.has(bond.toAtomId));
    const adjustedLayout = componentBonds.length > componentAtoms.length
      ? relaxNativeCleanupBondLengths(layout, componentBonds)
      : layout;
    const layoutCenter = averagePagePoint([...adjustedLayout.values()]);

    adjustedLayout.forEach((point, atomId) => {
      nextAtomPoints.set(atomId, {
        x: roundGeometryCoordinate(componentCenter.x + point.x - layoutCenter.x),
        y: roundGeometryCoordinate(componentCenter.y + point.y - layoutCenter.y)
      });
    });
  });

  const atoms = molecule.atoms.map((atom) => {
    const point = nextAtomPoints.get(atom.id);
    return point ? { ...atom, ...point } : atom;
  });

  return withNativeMoleculeTransform(
    normalizeNativeMoleculeGeometry({
      ...molecule,
      atoms
    }),
    defaultNativeMoleculeTransform
  );
}

function cleanUpNativeMoleculeComponent2d(input: {
  componentAtoms: readonly MoleculeAtom[];
  componentAtomSet: ReadonlySet<string>;
  atomById: ReadonlyMap<string, MoleculeAtom>;
  adjacency: ReadonlyMap<string, readonly string[]>;
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>;
}): ReadonlyMap<string, PagePoint> {
  const placed = new Map<string, PagePoint>();
  const cyclePath = cleanUpSimpleCyclePath(input.componentAtoms, input.adjacency);

  if (cyclePath) {
    placeRegularCycle(cyclePath, input.atomById, placed);
    const cycleAtomSet = new Set(cyclePath);
    cyclePath.forEach((atomId) => {
      const atomPoint = placed.get(atomId);
      if (!atomPoint) {
        return;
      }

      const branchIds = (input.adjacency.get(atomId) ?? [])
        .filter((neighborId) => input.componentAtomSet.has(neighborId) && !cycleAtomSet.has(neighborId));
      const branchAngles = assignAnglesToNeighbors({
        atomId,
        neighborIds: branchIds,
        candidateAngles: branchAnglesAroundPreferred(Math.atan2(atomPoint.y, atomPoint.x), branchIds.length),
        atomById: input.atomById
      });

      branchIds.forEach((branchId, index) => {
        layoutNativeCleanupSubtree({
          atomId: branchId,
          parentAtomId: atomId,
          directionAngle: branchAngles[index] ?? Math.atan2(atomPoint.y, atomPoint.x),
          componentAtomSet: input.componentAtomSet,
          atomById: input.atomById,
          adjacency: input.adjacency,
          bondByAtomPair: input.bondByAtomPair,
          placed
        });
      });
    });

    return placed;
  }

  const rootPath = longestNativePath(input.componentAtoms, input.adjacency);
  const rootAtomId = rootPath[0] ?? input.componentAtoms[0]?.id;
  if (!rootAtomId) {
    return placed;
  }

  placed.set(rootAtomId, { x: 0, y: 0 });
  const rootNeighborIds = orderedCleanupNeighbors({
    atomId: rootAtomId,
    parentAtomId: undefined,
    preferredFirstNeighborId: rootPath[1],
    componentAtomSet: input.componentAtomSet,
    adjacency: input.adjacency
  });
  const rootAngles = cleanupRootNeighborAngles(rootAtomId, rootNeighborIds, input.atomById, input.bondByAtomPair);

  rootNeighborIds.forEach((neighborId, index) => {
    layoutNativeCleanupSubtree({
      atomId: neighborId,
      parentAtomId: rootAtomId,
      directionAngle: rootAngles[index] ?? 0,
      componentAtomSet: input.componentAtomSet,
      atomById: input.atomById,
      adjacency: input.adjacency,
      bondByAtomPair: input.bondByAtomPair,
      placed
    });
  });

  return placed;
}

function layoutNativeCleanupSubtree(input: {
  atomId: string;
  parentAtomId: string;
  directionAngle: number;
  componentAtomSet: ReadonlySet<string>;
  atomById: ReadonlyMap<string, MoleculeAtom>;
  adjacency: ReadonlyMap<string, readonly string[]>;
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>;
  placed: Map<string, PagePoint>;
}): void {
  if (input.placed.has(input.atomId)) {
    return;
  }

  const parentPoint = input.placed.get(input.parentAtomId);
  if (!parentPoint) {
    return;
  }

  input.placed.set(input.atomId, {
    x: parentPoint.x + Math.cos(input.directionAngle) * nativeBondLength,
    y: parentPoint.y + Math.sin(input.directionAngle) * nativeBondLength
  });

  const childIds = orderedCleanupNeighbors({
    atomId: input.atomId,
    parentAtomId: input.parentAtomId,
    componentAtomSet: input.componentAtomSet,
    adjacency: input.adjacency
  }).filter((neighborId) => !input.placed.has(neighborId));
  const childAngles = cleanupChildAngles(
    input.atomId,
    input.parentAtomId,
    childIds,
    input.atomById,
    input.bondByAtomPair
  );

  childIds.forEach((childId, index) => {
    layoutNativeCleanupSubtree({
      ...input,
      atomId: childId,
      parentAtomId: input.atomId,
      directionAngle: childAngles[index] ?? input.directionAngle
    });
  });
}

function relaxNativeCleanupBondLengths(
  layout: ReadonlyMap<string, PagePoint>,
  bonds: readonly MoleculeBond[]
): ReadonlyMap<string, PagePoint> {
  const points = new Map([...layout.entries()].map(([atomId, point]) => [atomId, { ...point }]));
  const bondedAtomPairs = new Set(bonds.map((bond) => atomPairKey(bond.fromAtomId, bond.toAtomId)));
  const relaxation = 0.45;
  const separationRelaxation = 0.36;
  const minimumNonBondedDistance = nativeBondLength * 0.31;

  for (let iteration = 0; iteration < 180; iteration += 1) {
    let maxError = 0;

    bonds.forEach((bond) => {
      const from = points.get(bond.fromAtomId);
      const to = points.get(bond.toAtomId);
      if (!from || !to) {
        return;
      }

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length <= 0.001) {
        return;
      }

      const error = length - nativeBondLength;
      maxError = Math.max(maxError, Math.abs(error));
      const adjustment = error * relaxation / 2;
      const ux = dx / length;
      const uy = dy / length;

      from.x += ux * adjustment;
      from.y += uy * adjustment;
      to.x -= ux * adjustment;
      to.y -= uy * adjustment;
    });

    const atomPoints = [...points.entries()].sort(([leftAtomId], [rightAtomId]) => leftAtomId.localeCompare(rightAtomId));
    for (let leftIndex = 0; leftIndex < atomPoints.length; leftIndex += 1) {
      const [leftAtomId, left] = atomPoints[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < atomPoints.length; rightIndex += 1) {
        const [rightAtomId, right] = atomPoints[rightIndex];
        if (bondedAtomPairs.has(atomPairKey(leftAtomId, rightAtomId))) {
          continue;
        }

        let dx = right.x - left.x;
        let dy = right.y - left.y;
        let length = Math.hypot(dx, dy);
        if (length >= minimumNonBondedDistance) {
          continue;
        }

        if (length <= 0.001) {
          const deterministicAngle = (leftIndex * 31 + rightIndex * 17) * Math.PI / 180;
          dx = Math.cos(deterministicAngle);
          dy = Math.sin(deterministicAngle);
          length = 1;
        }

        const error = minimumNonBondedDistance - length;
        maxError = Math.max(maxError, error);
        const adjustment = error * separationRelaxation / 2;
        const ux = dx / length;
        const uy = dy / length;

        left.x -= ux * adjustment;
        left.y -= uy * adjustment;
        right.x += ux * adjustment;
        right.y += uy * adjustment;
      }
    }

    if (maxError < 0.002) {
      break;
    }
  }

  return new Map([...points.entries()].map(([atomId, point]) => [atomId, {
    x: roundGeometryCoordinate(point.x),
    y: roundGeometryCoordinate(point.y)
  }]));
}

function cleanUpSimpleCyclePath(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined {
  const cycleAtomIds = findSingleCycleAtomIds(atoms, adjacency);
  if (!cycleAtomIds || cycleAtomIds.length < 3) {
    return undefined;
  }

  const cycleAtomSet = new Set(cycleAtomIds);
  const cycleAdjacency = new Map(cycleAtomIds.map((atomId) => [
    atomId,
    (adjacency.get(atomId) ?? []).filter((neighborId) => cycleAtomSet.has(neighborId)).sort()
  ]));
  if ([...cycleAdjacency.values()].some((neighbors) => neighbors.length !== 2)) {
    return undefined;
  }

  const startAtomId = [...cycleAtomIds].sort()[0];
  const firstNeighborId = cycleAdjacency.get(startAtomId)?.[0];
  if (!firstNeighborId) {
    return undefined;
  }

  const cyclePath = [startAtomId];
  let previousAtomId = startAtomId;
  let currentAtomId = firstNeighborId;
  while (currentAtomId !== startAtomId) {
    cyclePath.push(currentAtomId);
    const nextAtomId = (cycleAdjacency.get(currentAtomId) ?? []).find((neighborId) => neighborId !== previousAtomId);
    if (!nextAtomId || cyclePath.length > cycleAtomIds.length) {
      return undefined;
    }

    previousAtomId = currentAtomId;
    currentAtomId = nextAtomId;
  }

  return cyclePath.length === cycleAtomIds.length ? cyclePath : undefined;
}

function placeRegularCycle(
  cyclePath: readonly string[],
  atomById: ReadonlyMap<string, MoleculeAtom>,
  placed: Map<string, PagePoint>
): void {
  const size = cyclePath.length;
  const firstAtom = atomById.get(cyclePath[0]);
  const secondAtom = atomById.get(cyclePath[1]);
  const existingFirstBondAngle = firstAtom && secondAtom
    ? Math.atan2(secondAtom.y - firstAtom.y, secondAtom.x - firstAtom.x)
    : 0;
  const step = Math.PI * 2 / size;
  const radius = nativeBondLength / (2 * Math.sin(Math.PI / size));
  const theta0 = existingFirstBondAngle - step / 2 - Math.PI / 2;

  cyclePath.forEach((atomId, index) => {
    const theta = theta0 + index * step;
    placed.set(atomId, {
      x: Math.cos(theta) * radius,
      y: Math.sin(theta) * radius
    });
  });
}

function cleanupRootNeighborAngles(
  atomId: string,
  neighborIds: readonly string[],
  atomById: ReadonlyMap<string, MoleculeAtom>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): readonly number[] {
  const atom = atomById.get(atomId);
  if (!atom || neighborIds.length === 0) {
    return [];
  }

  const firstNeighbor = atomById.get(neighborIds[0]);
  const anchorAngle = firstNeighbor ? Math.atan2(firstNeighbor.y - atom.y, firstNeighbor.x - atom.x) : 0;
  const idealAngle = idealNativeCleanupAngleRadians(atomId, bondByAtomPair);

  if (neighborIds.length === 1) {
    return [anchorAngle];
  }

  if (neighborIds.length === 2) {
    const secondAngle = chooseCandidateAngle(
      existingNeighborAngle(atomId, neighborIds[1], atomById),
      idealAngle === Math.PI
        ? [anchorAngle + Math.PI]
        : [anchorAngle + idealAngle, anchorAngle - idealAngle]
    );
    return [anchorAngle, secondAngle];
  }

  const candidates = Array.from({ length: neighborIds.length }, (_, index) =>
    anchorAngle + index * Math.PI * 2 / neighborIds.length
  );
  return assignAnglesToNeighbors({ atomId, neighborIds, candidateAngles: candidates, atomById });
}

function cleanupChildAngles(
  atomId: string,
  parentAtomId: string,
  childIds: readonly string[],
  atomById: ReadonlyMap<string, MoleculeAtom>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): readonly number[] {
  if (childIds.length === 0) {
    return [];
  }

  const atomPoint = atomById.get(atomId);
  const parentPoint = atomById.get(parentAtomId);
  if (!atomPoint || !parentPoint) {
    return childIds.map(() => 0);
  }

  const incomingAngle = Math.atan2(parentPoint.y - atomPoint.y, parentPoint.x - atomPoint.x);
  const idealAngle = idealNativeCleanupAngleRadians(atomId, bondByAtomPair);
  if (childIds.length === 1) {
    const candidates = idealAngle === Math.PI
      ? [incomingAngle + Math.PI]
      : [incomingAngle + idealAngle, incomingAngle - idealAngle];
    return [chooseCandidateAngle(existingNeighborAngle(atomId, childIds[0], atomById), candidates)];
  }

  if (childIds.length === 2 && idealAngle !== Math.PI) {
    const candidates = [incomingAngle + idealAngle, incomingAngle - idealAngle];
    return assignAnglesToNeighbors({ atomId, neighborIds: childIds, candidateAngles: candidates, atomById });
  }

  const forwardAngle = incomingAngle + Math.PI;
  const candidates = branchAnglesAroundPreferred(forwardAngle, childIds.length);
  return assignAnglesToNeighbors({ atomId, neighborIds: childIds, candidateAngles: candidates, atomById });
}

function orderedCleanupNeighbors(input: {
  atomId: string;
  parentAtomId?: string;
  preferredFirstNeighborId?: string;
  componentAtomSet: ReadonlySet<string>;
  adjacency: ReadonlyMap<string, readonly string[]>;
}): readonly string[] {
  const neighbors = (input.adjacency.get(input.atomId) ?? [])
    .filter((neighborId) => neighborId !== input.parentAtomId && input.componentAtomSet.has(neighborId))
    .sort();

  if (!input.preferredFirstNeighborId || !neighbors.includes(input.preferredFirstNeighborId)) {
    return neighbors;
  }

  return [
    input.preferredFirstNeighborId,
    ...neighbors.filter((neighborId) => neighborId !== input.preferredFirstNeighborId)
  ];
}

function idealNativeCleanupAngleRadians(
  atomId: string,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): number {
  const connectedBonds = [...bondByAtomPair.values()].filter((bond) =>
    bond.fromAtomId === atomId || bond.toAtomId === atomId
  );
  const connectedDoubleBondCount = connectedBonds.filter((bond) => bond.order === "double").length;

  return connectedBonds.some((bond) => bond.order === "triple") || connectedDoubleBondCount >= 2
    ? Math.PI
    : 2 * Math.PI / 3;
}

function branchAnglesAroundPreferred(preferredAngle: number, count: number): readonly number[] {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [preferredAngle];
  }
  if (count === 2) {
    return [preferredAngle - Math.PI / 3, preferredAngle + Math.PI / 3];
  }

  return Array.from({ length: count }, (_, index) =>
    preferredAngle + (index - (count - 1) / 2) * Math.PI * 2 / count
  );
}

function assignAnglesToNeighbors(input: {
  atomId: string;
  neighborIds: readonly string[];
  candidateAngles: readonly number[];
  atomById: ReadonlyMap<string, MoleculeAtom>;
}): readonly number[] {
  const remainingCandidates = [...input.candidateAngles];
  return input.neighborIds.map((neighborId) => {
    const existingAngle = existingNeighborAngle(input.atomId, neighborId, input.atomById);
    if (remainingCandidates.length === 0) {
      return existingAngle ?? 0;
    }

    const bestIndex = remainingCandidates.reduce((best, candidate, index) => {
      if (existingAngle === undefined) {
        return best;
      }
      return angularDistance(candidate, existingAngle) < angularDistance(remainingCandidates[best] ?? candidate, existingAngle)
        ? index
        : best;
    }, 0);
    const [angle] = remainingCandidates.splice(bestIndex, 1);
    return angle ?? existingAngle ?? 0;
  });
}

function chooseCandidateAngle(existingAngle: number | undefined, candidateAngles: readonly number[]): number {
  if (candidateAngles.length === 0) {
    return existingAngle ?? 0;
  }
  if (existingAngle === undefined) {
    return candidateAngles[0] ?? 0;
  }

  return candidateAngles.reduce((best, candidate) =>
    angularDistance(candidate, existingAngle) < angularDistance(best, existingAngle) ? candidate : best,
    candidateAngles[0] ?? 0
  );
}

function existingNeighborAngle(
  atomId: string,
  neighborId: string,
  atomById: ReadonlyMap<string, MoleculeAtom>
): number | undefined {
  const atom = atomById.get(atomId);
  const neighbor = atomById.get(neighborId);
  return atom && neighbor ? Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x) : undefined;
}

function averagePagePoint(points: readonly PagePoint[]): PagePoint {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }

  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function nativeMoleculeGeometryOrTransformChanged(before: MoleculeObject, after: MoleculeObject): boolean {
  const beforeTransform = nativeMoleculeTransformState(before);
  const afterTransform = nativeMoleculeTransformState(after);
  if (
    Math.abs(beforeTransform.scaleX - afterTransform.scaleX) > 0.001 ||
    Math.abs(beforeTransform.scaleY - afterTransform.scaleY) > 0.001 ||
    Math.abs(beforeTransform.rotationDegrees - afterTransform.rotationDegrees) > 0.001 ||
    Math.abs((beforeTransform.tiltXDegrees ?? 0) - (afterTransform.tiltXDegrees ?? 0)) > 0.001 ||
    Math.abs((beforeTransform.tiltYDegrees ?? 0) - (afterTransform.tiltYDegrees ?? 0)) > 0.001 ||
    Math.abs((beforeTransform.tiltCenterX ?? 0) - (afterTransform.tiltCenterX ?? 0)) > 0.001 ||
    Math.abs((beforeTransform.tiltCenterY ?? 0) - (afterTransform.tiltCenterY ?? 0)) > 0.001
  ) {
    return true;
  }

  return before.atoms.some((atom, index) => {
    const nextAtom = after.atoms[index];
    return !nextAtom || Math.abs(atom.x - nextAtom.x) > 0.001 || Math.abs(atom.y - nextAtom.y) > 0.001;
  });
}

function roundGeometryCoordinate(value: number): number {
  return Number(value.toFixed(3));
}

function normalizeNativeMoleculeScale(scale: number): number {
  return Number((Number.isFinite(scale) && scale > 0 ? scale : 1).toFixed(4));
}

function normalizeProjectedPlaneTiltDegrees(degrees: number | undefined): number | undefined {
  const finiteDegrees = Number.isFinite(degrees) ? degrees ?? 0 : 0;
  const normalized = Number(clamp(
    finiteDegrees,
    -projectedPlaneTiltMaxDegrees,
    projectedPlaneTiltMaxDegrees
  ).toFixed(3));
  return Math.abs(normalized) < 0.001 ? undefined : normalized;
}

function normalizeProjectedPlaneTiltCenterCoordinate(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? roundGeometryCoordinate(value ?? 0) : undefined;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function objectCenter(object: Pick<DocumentObject, "x" | "y" | "width" | "height">): PagePoint {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function rotatePointAround(point: PagePoint, center: PagePoint, angleRadians: number): PagePoint {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

function normalizeDegrees(angleDegrees: number): number {
  let normalized = angleDegrees % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return Number(normalized.toFixed(3));
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

export function applyEditorSaveResultToSelectedMolecule(
  document: ChemDraftDocument,
  result: EditorSaveResult
): ChemDraftDocument {
  const selectedMolecule = getSelectedMolecule(document);
  if (!selectedMolecule) {
    throw new Error("Cannot apply editor save result: no molecule is selected.");
  }
  if (result.object.type !== "molecule") {
    throw new Error(`Cannot apply editor save result: saved object is "${result.object.type}", not a molecule.`);
  }

  return applyEditorSaveResultToSelectedObject(document, {
    ...result,
    object: syncMoleculePreviewFromEditorSave(selectedMolecule, result.object)
  });
}

export function createNativeSavePayload(document: ChemDraftDocument): NativeSavePayload {
  const result = exportDocumentToCdxml(document);
  return {
    filename: `${sanitizeFilename(document.title.replace(/\.chemdraft$/i, ""))}.chemdraft`,
    mimeType: "chemical/x-cdxml",
    contents: result.contents,
    warnings: result.warnings,
    payloadHash: sha256Utf8Hex(result.contents)
  };
}

export function openNativeDocument(contents: string): ChemDraftOpenResult {
  return openChemDraftPayload(contents);
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

function findTextObject(document: ChemDraftDocument, objectId: string): TextObject | undefined {
  return findTextObjectLocation(document, objectId)?.object;
}

function documentObjectExists(document: ChemDraftDocument, objectId: string): boolean {
  return document.pages.some((page) => page.objects.some((object) => object.id === objectId));
}

function findMoleculeObject(document: ChemDraftDocument, objectId: string): MoleculeObject | undefined {
  for (const page of document.pages) {
    const object = page.objects.find((candidate) => candidate.id === objectId);
    if (object?.type === "molecule") {
      return object;
    }
  }

  return undefined;
}

function findTextObjectLocation(
  document: ChemDraftDocument,
  objectId: string
): { page: ChemDraftDocument["pages"][number]; object: TextObject } | undefined {
  for (const page of document.pages) {
    const object = page.objects.find((candidate) => candidate.id === objectId);
    if (object?.type === "text") {
      return { page, object };
    }
  }

  return undefined;
}

function normalizeTextLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 0 ? lines : [""];
}

function estimateNativeTextLineWidth(line: string, style: NativeTextStyle): number {
  if (line.length === 0) {
    return style.fontSizePx * 0.5;
  }

  return [...line].reduce((width, character, index) => (
    width + style.fontSizePx * nativeTextCharacterWidthFactor(character)
      + (index > 0 ? style.letterSpacingPx : 0)
  ), 0);
}

function wrappedNativeTextLineCount(line: string, style: NativeTextStyle, contentWidth: number): number {
  const safeContentWidth = Math.max(1, contentWidth);
  return Math.max(1, Math.ceil(estimateNativeTextLineWidth(line, style) / safeContentWidth));
}

function nativeTextCharacterWidthFactor(character: string): number {
  if (character === "\t") {
    return 1.6;
  }

  if (character.trim().length === 0) {
    return 0.34;
  }

  if ("ilI.,:;!|".includes(character)) {
    return 0.28;
  }

  if ("mwMW@#%&".includes(character)) {
    return 0.82;
  }

  if (/[A-Z0-9]/.test(character)) {
    return 0.62;
  }

  return 0.54;
}

function roundToTextBoxPixel(value: number): number {
  return Math.round(value * 100) / 100;
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

function createClipboardTextStructureMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  format: "smiles",
  structure: string,
  warnings: readonly ClipboardTransferWarning[]
): MoleculeObject {
  const page = firstPage(document);
  const width = 190;
  const height = 96;

  return {
    id: nextObjectId(document, "mol_clipboard"),
    type: "molecule",
    x: clamp(point.x, 0, Math.max(0, page.width - width)),
    y: clamp(point.y, 0, Math.max(0, page.height - height)),
    width,
    height,
    rotation: 0,
    transform: defaultNativeMoleculeTransform,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      source: "clipboard-chemical-text"
    },
    compatibility: {
      sourceFormat: format,
      warnings: clipboardWarningsToCompatibilityWarnings(warnings),
      unknown: {}
    },
    structureFormat: format,
    structure,
    chemistry: {
      warnings: clipboardWarningsToCompatibilityWarnings(warnings),
      isotopeLabels: [],
      stereochemistry: []
    },
    atoms: [],
    bonds: [],
    superatoms: [],
    rGroups: []
  };
}

function scaleParsedMolfileAtoms(
  graph: ParsedMolfileGraph,
  point: PagePoint,
  page: ChemDraftDocument["pages"][number]
): ParsedMolfileGraph["atoms"] {
  const averageBondLength = averageParsedMolfileBondLength(graph);
  const scale = averageBondLength > 0 ? nativeBondLengthPx / averageBondLength : nativeBondLengthPx / 1.5;
  const scaledAtoms = graph.atoms.map((atom) => ({
    ...atom,
    x: atom.x * scale,
    y: -atom.y * scale
  }));
  const xs = scaledAtoms.map((atom) => atom.x);
  const ys = scaledAtoms.map((atom) => atom.y);
  const center = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2
  };
  let atoms = scaledAtoms.map((atom) => ({
    ...atom,
    x: atom.x + point.x - center.x,
    y: atom.y + point.y - center.y
  }));
  const geometry = moleculeGeometryFromAtoms(atoms);
  const boundedX = clamp(geometry.x, 0, Math.max(0, page.width - geometry.width));
  const boundedY = clamp(geometry.y, 0, Math.max(0, page.height - geometry.height));
  const shiftX = boundedX - geometry.x;
  const shiftY = boundedY - geometry.y;

  if (Math.abs(shiftX) > 0.001 || Math.abs(shiftY) > 0.001) {
    atoms = atoms.map((atom) => ({
      ...atom,
      x: atom.x + shiftX,
      y: atom.y + shiftY
    }));
  }

  return atoms;
}

function averageParsedMolfileBondLength(graph: ParsedMolfileGraph): number {
  const atomById = new Map(graph.atoms.map((atom) => [atom.id, atom]));
  const lengths = graph.bonds
    .map((bond) => {
      const fromAtom = atomById.get(bond.fromAtomId);
      const toAtom = atomById.get(bond.toAtomId);
      return fromAtom && toAtom ? Math.hypot(fromAtom.x - toAtom.x, fromAtom.y - toAtom.y) : 0;
    })
    .filter((length) => length > 0.0001);

  if (lengths.length === 0) {
    return 0;
  }

  return lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
}

function clipboardWarningsToCompatibilityWarnings(
  warnings: readonly ClipboardTransferWarning[]
): CompatibilityWarning[] {
  return warnings.map((warning) => ({
    code: warning.code,
    message: warning.message
  }));
}

function statusForUnsupportedClipboardPayload(payload: ClipboardDetectedPayload): string {
  const firstWarning = payload.warnings[0]?.message;
  if (firstWarning) {
    return firstWarning;
  }

  if (payload.kind === "cdxml") {
    return "Clipboard contains CDXML, but CDXML paste parsing is not implemented yet";
  }
  if (payload.kind === "cdx") {
    return "Clipboard contains CDX, but best-effort CDX paste parsing is not implemented yet";
  }
  if (payload.kind === "rxnfile") {
    return "Clipboard contains RXN text, but RXN paste is not implemented yet";
  }
  if (payload.kind === "vector-only") {
    return "Clipboard contains vector artwork only; no editable chemistry payload was found";
  }

  return "Clipboard does not contain a supported ChemDraft paste payload";
}

function sanitizeFilename(value: string): string {
  const sanitized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return sanitized || "Untitled";
}

function extendNativeCarbonChain(
  molecule: MoleculeObject,
  point: PagePoint,
  pageWidth: number,
  pageHeight: number,
  options: NativeBondToolOptions = {}
): MoleculeObject | undefined {
  const preview = previewNativeMoleculeBondGrowth(molecule, point, pageWidth, pageHeight);
  if (!preview) {
    return undefined;
  }

  return preview.targetAtomId
    ? connectNativeCarbonAtoms(molecule, preview.atomId, preview.targetAtomId, options)
    : extendNativeCarbonGraph(molecule, preview.atomId, preview.newAtomPoint, options);
}

function extendNativeCarbonGraph(
  molecule: MoleculeObject,
  sourceAtomId: string,
  newAtomPoint: PagePoint,
  options: NativeBondToolOptions = {}
): MoleculeObject | undefined {
  if (!canGrowNativeAtom(molecule, sourceAtomId)) {
    return undefined;
  }

  const newAtom: MoleculeAtom = {
    id: nextIndexedId("atom", molecule.atoms.map((atom) => atom.id)),
    element: "C",
    x: newAtomPoint.x,
    y: newAtomPoint.y,
    formalCharge: 0
  };
  const atoms = [...molecule.atoms, newAtom];
  const bonds = [
    ...molecule.bonds,
    {
      id: nextIndexedId("bond", molecule.bonds.map((bond) => bond.id)),
      fromAtomId: sourceAtomId,
      toAtomId: newAtom.id,
      order: "single" as const,
      ...nativeBondDisplayObject(options.bondStyle)
    }
  ];

  return refreshNativeSingleBondGraph(molecule, atoms, bonds);
}

function addNativeCarbonylToAtom(
  molecule: MoleculeObject,
  sourceAtomId: string,
  pageWidth: number,
  pageHeight: number,
  steeringPoint?: PagePoint
): MoleculeObject | undefined {
  const sourceAtom = molecule.atoms.find((atom) => atom.id === sourceAtomId);
  if (!sourceAtom || nativeElementFromAtomLabel(sourceAtom.element) !== "C") {
    return undefined;
  }

  const valenceUsage = atomBondOrderUsageMap(molecule.atoms, molecule.bonds);
  const nextCarbonValence = (valenceUsage.get(sourceAtomId) ?? 0) + nativeBondOrderValue.double;
  if (sourceAtom.formalCharge !== 0 || nativeAtomFormalChargeForValence("C", nextCarbonValence) !== 0) {
    return undefined;
  }

  const oxygenAtom: MoleculeAtom = {
    id: nextIndexedId("atom", molecule.atoms.map((atom) => atom.id)),
    element: "O",
    x: 0,
    y: 0,
    formalCharge: 0
  };
  const oxygenPoint = carbonylOxygenPointForAtom(molecule, sourceAtomId, pageWidth, pageHeight, steeringPoint);
  const newAtom = {
    ...oxygenAtom,
    x: oxygenPoint.x,
    y: oxygenPoint.y
  };
  const newBond: MoleculeBond = {
    id: nextIndexedId("bond", molecule.bonds.map((bond) => bond.id)),
    fromAtomId: sourceAtomId,
    toAtomId: newAtom.id,
    order: "double"
  };
  const bonds = [
    ...molecule.bonds,
    nativeBondWithOrderAndDisplay(molecule, newBond, "double")
  ];

  return refreshNativeSingleBondGraph(molecule, [...molecule.atoms, newAtom], bonds);
}

function carbonylOxygenPointForAtom(
  molecule: MoleculeObject,
  atomId: string,
  pageWidth: number,
  pageHeight: number,
  steeringPoint?: PagePoint
): PagePoint {
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  if (!atom) {
    return { x: nativeBondLength, y: 0 };
  }

  const steeredDistance = steeringPoint ? distance(atom, steeringPoint) : 0;
  const angle = steeredDistance > 0.01
    ? Math.atan2((steeringPoint?.y ?? atom.y) - atom.y, (steeringPoint?.x ?? atom.x) - atom.x)
    : largestOpenAngle(neighborAnglesForAtom(molecule, atomId)) ?? -Math.PI / 2;
  const point = {
    x: atom.x + Math.cos(angle) * nativeBondLength,
    y: atom.y + Math.sin(angle) * nativeBondLength
  };

  return {
    x: clamp(point.x, 0, pageWidth),
    y: clamp(point.y, 0, pageHeight)
  };
}

function neighborAnglesForAtom(molecule: MoleculeObject, atomId: string): number[] {
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  if (!atom) {
    return [];
  }

  return molecule.bonds
    .filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId)
    .map((bond) => molecule.atoms.find((candidate) =>
      candidate.id === (bond.fromAtomId === atomId ? bond.toAtomId : bond.fromAtomId)
    ))
    .filter((candidate): candidate is MoleculeAtom => candidate !== undefined)
    .map((neighbor) => Math.atan2(neighbor.y - atom.y, neighbor.x - atom.x));
}

function connectNativeCarbonAtoms(
  molecule: MoleculeObject,
  sourceAtomId: string,
  targetAtomId: string,
  options: NativeBondToolOptions = {}
): MoleculeObject | undefined {
  if (!canConnectNativeAtoms(molecule, sourceAtomId, targetAtomId)) {
    return undefined;
  }

  const bonds = [
    ...molecule.bonds,
    {
      id: nextIndexedId("bond", molecule.bonds.map((bond) => bond.id)),
      fromAtomId: sourceAtomId,
      toAtomId: targetAtomId,
      order: "single" as const,
      ...nativeBondDisplayObject(options.bondStyle)
    }
  ];

  return refreshNativeSingleBondGraph(molecule, molecule.atoms, bonds);
}

function nativeAtomWithElement(
  atom: MoleculeAtom,
  element: string,
  labelVisible: boolean
): MoleculeAtom {
  const { labelVisible: _labelVisible, ...baseAtom } = atom;
  return labelVisible
    ? { ...baseAtom, element, labelVisible: true }
    : { ...baseAtom, element };
}

function isNativeBondOrderValue(order: MoleculeBond["order"]): order is NativeBondOrderValue {
  return order === "single" || order === "double" || order === "triple";
}

function nextNativeBondOrder(molecule: MoleculeObject, bond: MoleculeBond): MoleculeBond["order"] {
  const nextOrder = bond.order === "single"
    ? "double"
    : bond.order === "double" ? "triple" : "single";
  if (!canSetNativeBondOrder(molecule, bond, nextOrder)) {
    return bond.order;
  }

  return nextOrder;
}

function nativeBondWithOrderAndDisplay(
  molecule: MoleculeObject,
  bond: MoleculeBond,
  order: MoleculeBond["order"]
): MoleculeBond {
  const bondStyle = bond.display?.bondStyle;
  if (order === "double") {
    return {
      ...bond,
      order,
      display: {
        ...(bond.display ?? {}),
        ...(bondStyle ? { bondStyle } : {}),
        doubleBondSide: bond.display?.doubleBondSide ?? defaultDoubleBondSide(molecule, bond)
      }
    };
  }

  const { display: _display, ...bondWithoutDisplay } = bond;
  return {
    ...bondWithoutDisplay,
    order,
    ...nativeBondDisplayObject(bondStyle)
  };
}

function nativeBondWithDisplayStyle(
  bond: MoleculeBond,
  bondStyle: NativeBondDisplayStyle
): MoleculeBond {
  return {
    ...bond,
    display: {
      ...(bond.display ?? {}),
      bondStyle
    }
  };
}

function nativeBondDisplayObject(
  bondStyle: NativeBondDisplayStyle | undefined
): Pick<MoleculeBond, "display"> | Record<string, never> {
  return bondStyle ? { display: { bondStyle } } : {};
}

function defaultDoubleBondSide(molecule: MoleculeObject, bond: MoleculeBond): NativeDoubleBondSide {
  const geometry = bondGeometry(molecule, bond);
  if (!geometry) {
    return "left";
  }

  const { fromAtom, toAtom, normal } = geometry;
  const score = molecule.bonds.reduce((sum, candidate) => {
    const neighborId =
      candidate.id === bond.id
        ? undefined
        : candidate.fromAtomId === fromAtom.id
          ? candidate.toAtomId
          : candidate.toAtomId === fromAtom.id
            ? candidate.fromAtomId
            : candidate.fromAtomId === toAtom.id
              ? candidate.toAtomId
              : candidate.toAtomId === toAtom.id
                ? candidate.fromAtomId
                : undefined;
    const sourceAtom =
      candidate.fromAtomId === fromAtom.id || candidate.toAtomId === fromAtom.id
        ? fromAtom
        : candidate.fromAtomId === toAtom.id || candidate.toAtomId === toAtom.id
          ? toAtom
          : undefined;
    const neighborAtom = neighborId
      ? molecule.atoms.find((atom) => atom.id === neighborId)
      : undefined;
    if (!sourceAtom || !neighborAtom) {
      return sum;
    }

    return sum + (neighborAtom.x - sourceAtom.x) * normal.x + (neighborAtom.y - sourceAtom.y) * normal.y;
  }, 0);

  return score >= 0 ? "left" : "right";
}

function doubleBondSideForPoint(
  molecule: MoleculeObject,
  bond: MoleculeBond,
  point: PagePoint
): NativeDoubleBondSide | undefined {
  const geometry = bondGeometry(molecule, bond);
  if (!geometry) {
    return undefined;
  }

  const midpoint = {
    x: (geometry.fromAtom.x + geometry.toAtom.x) / 2,
    y: (geometry.fromAtom.y + geometry.toAtom.y) / 2
  };
  const score = (point.x - midpoint.x) * geometry.normal.x + (point.y - midpoint.y) * geometry.normal.y;
  return score >= 0 ? "left" : "right";
}

function bondGeometry(
  molecule: MoleculeObject,
  bond: MoleculeBond
): {
  fromAtom: MoleculeAtom;
  toAtom: MoleculeAtom;
  normal: PagePoint;
} | undefined {
  const fromAtom = molecule.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = molecule.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return undefined;
  }

  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  return {
    fromAtom,
    toAtom,
    normal: {
      x: -dy / length,
      y: dx / length
    }
  };
}

function canSetNativeBondOrder(
  molecule: MoleculeObject,
  bond: MoleculeBond,
  order: MoleculeBond["order"]
): boolean {
  if (order !== "single" && order !== "double" && order !== "triple") {
    return false;
  }

  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const fromAtom = atomById.get(bond.fromAtomId);
  const toAtom = atomById.get(bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return false;
  }

  const valenceUsage = atomBondOrderUsageMap(molecule.atoms, molecule.bonds);
  const currentOrderValue = nativeBondOrderValue[bond.order] ?? 1;
  const nextOrderValue = nativeBondOrderValue[order] ?? 1;
  const fromElement = nativeElementFromAtomLabel(fromAtom.element);
  const toElement = nativeElementFromAtomLabel(toAtom.element);
  if (!fromElement || !toElement) {
    return false;
  }
  const fromUsage = (valenceUsage.get(fromAtom.id) ?? 0) - currentOrderValue + nextOrderValue;
  const toUsage = (valenceUsage.get(toAtom.id) ?? 0) - currentOrderValue + nextOrderValue;
  const fromCharge = nativeAtomFormalChargeForValence(fromElement, fromUsage);
  const toCharge = nativeAtomFormalChargeForValence(toElement, toUsage);

  return fromCharge === 0 && toCharge === 0;
}

function canGrowNativeAtom(molecule: MoleculeObject, atomId: string): boolean {
  const valenceUsage = atomBondOrderUsageMap(molecule.atoms, molecule.bonds);
  const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
  return atom !== undefined && nativeAtomAvailableBondCount(atom, valenceUsage.get(atomId) ?? 0) > 0;
}

function canConnectNativeAtoms(
  molecule: MoleculeObject,
  sourceAtomId: string,
  targetAtomId: string
): boolean {
  if (sourceAtomId === targetAtomId) {
    return false;
  }

  const atomIds = new Set(molecule.atoms.map((atom) => atom.id));
  if (!atomIds.has(sourceAtomId) || !atomIds.has(targetAtomId)) {
    return false;
  }

  if (molecule.bonds.some((bond) =>
    (bond.fromAtomId === sourceAtomId && bond.toAtomId === targetAtomId) ||
    (bond.fromAtomId === targetAtomId && bond.toAtomId === sourceAtomId)
  )) {
    return false;
  }

  const valenceUsage = atomBondOrderUsageMap(molecule.atoms, molecule.bonds);
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const sourceAtom = atomById.get(sourceAtomId);
  const targetAtom = atomById.get(targetAtomId);
  return (
    sourceAtom !== undefined &&
    targetAtom !== undefined &&
    nativeAtomAvailableBondCount(sourceAtom, valenceUsage.get(sourceAtomId) ?? 0) > 0 &&
    nativeAtomAvailableBondCount(targetAtom, valenceUsage.get(targetAtomId) ?? 0) > 0
  );
}

function deleteNativeCarbonAtom(
  molecule: MoleculeObject,
  atomId: string
): MoleculeObject | undefined {
  if (!molecule.atoms.some((atom) => atom.id === atomId)) {
    return undefined;
  }

  const atoms = molecule.atoms.filter((atom) => atom.id !== atomId);
  const bonds = molecule.bonds.filter((bond) => bond.fromAtomId !== atomId && bond.toAtomId !== atomId);
  return refreshNativeSingleBondGraph(molecule, atoms, bonds);
}

function deleteNativeCarbonBond(
  molecule: MoleculeObject,
  bondId: string,
  terminalAtomId: string | undefined
): MoleculeObject | undefined {
  const targetBond = molecule.bonds.find((bond) => bond.id === bondId);
  if (!targetBond) {
    return undefined;
  }

  const degrees = atomDegreeMap(molecule.atoms, molecule.bonds);
  const terminalCandidates = [targetBond.fromAtomId, targetBond.toAtomId]
    .filter((atomId) => (degrees.get(atomId) ?? 0) <= 1);
  const atomIdToRemove = terminalAtomId && terminalCandidates.includes(terminalAtomId)
    ? terminalAtomId
    : terminalCandidates[0];

  if (atomIdToRemove) {
    const atoms = molecule.atoms.filter((atom) => atom.id !== atomIdToRemove);
    const bonds = molecule.bonds.filter((bond) =>
      bond.id !== bondId && bond.fromAtomId !== atomIdToRemove && bond.toAtomId !== atomIdToRemove
    );
    return refreshNativeSingleBondGraph(molecule, atoms, bonds);
  }

  return refreshNativeSingleBondGraph(
    molecule,
    molecule.atoms,
    molecule.bonds.filter((bond) => bond.id !== bondId)
  );
}

function refreshNativeSingleBondGraph(
  molecule: MoleculeObject,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeObject {
  return normalizeNativeMoleculeGeometry({
    ...molecule,
    structure: nativeSingleBondGraphSmiles(atoms, bonds),
    chemistry: nativeSingleBondGraphMetadata(atoms, bonds),
    atoms: [...atoms],
    bonds: [...bonds]
  });
}

function syncMoleculePreviewFromEditorSave(
  previous: MoleculeObject,
  saved: MoleculeObject
): MoleculeObject {
  if (saved.structureFormat !== "molfile-v3000") {
    return saved;
  }

  const graph = parseV3000MoleculeGraph(saved.structure, previous);
  if (!graph) {
    return saved;
  }

  const styleWithoutPrimitive = { ...saved.style };
  delete styleWithoutPrimitive.drawingPrimitive;

  return normalizeNativeMoleculeGeometry({
    ...saved,
    style: {
      ...styleWithoutPrimitive,
      source: "ketcher-adapter"
    },
    chemistry: undefined,
    atoms: graph.atoms,
    bonds: graph.bonds
  });
}

function parseV3000MoleculeGraph(
  molfile: string,
  previous: MoleculeObject
): Pick<MoleculeObject, "atoms" | "bonds"> | undefined {
  const rawAtoms: Array<{ sourceId: string; element: string; x: number; y: number; formalCharge: number }> = [];
  const rawBonds: Array<{ sourceId: string; fromSourceId: string; toSourceId: string; order: MoleculeBond["order"] }> = [];
  let section: "atom" | "bond" | undefined;

  for (const rawLine of molfile.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^M\s+V30\b/, "M V30");
    if (line === "M V30 BEGIN ATOM") {
      section = "atom";
      continue;
    }
    if (line === "M V30 BEGIN BOND") {
      section = "bond";
      continue;
    }
    if (line === "M V30 END ATOM" || line === "M V30 END BOND") {
      section = undefined;
      continue;
    }
    if (!section || !line.startsWith("M V30 ")) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (section === "atom") {
      const [, , sourceId, element, rawX, rawY] = parts;
      const x = Number(rawX);
      const y = Number(rawY);
      if (!sourceId || !element || !Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }

      rawAtoms.push({
        sourceId,
        element,
        x,
        y,
        formalCharge: formalChargeFromV3000AtomLine(line)
      });
      continue;
    }

    const [, , sourceId, rawOrder, fromSourceId, toSourceId] = parts;
    if (!sourceId || !rawOrder || !fromSourceId || !toSourceId) {
      continue;
    }

    rawBonds.push({
      sourceId,
      fromSourceId,
      toSourceId,
      order: bondOrderFromV3000(rawOrder)
    });
  }

  if (rawAtoms.length === 0) {
    return undefined;
  }

  const sourceCenter = rawCoordinateCenter(rawAtoms);
  const targetCenter = {
    x: previous.x + previous.width / 2,
    y: previous.y + previous.height / 2
  };
  const scale = previewScaleFromV3000Graph(rawAtoms, rawBonds, previous);
  const atomIdBySourceId = new Map<string, string>();
  const atoms = rawAtoms.map((atom, index) => {
    const id = previous.atoms[index]?.id ?? nextOrdinalId("atom", index);
    atomIdBySourceId.set(atom.sourceId, id);

    return {
      id,
      element: atom.element,
      x: targetCenter.x + (atom.x - sourceCenter.x) * scale,
      y: targetCenter.y - (atom.y - sourceCenter.y) * scale,
      formalCharge: atom.formalCharge
    } satisfies MoleculeAtom;
  });
  const bonds = rawBonds.flatMap((bond, index) => {
    const fromAtomId = atomIdBySourceId.get(bond.fromSourceId);
    const toAtomId = atomIdBySourceId.get(bond.toSourceId);
    if (!fromAtomId || !toAtomId) {
      return [];
    }

    return [{
      id: previous.bonds[index]?.id ?? nextOrdinalId("bond", index),
      fromAtomId,
      toAtomId,
      order: bond.order
    } satisfies MoleculeBond];
  });

  return { atoms, bonds };
}

function rawCoordinateCenter(atoms: readonly { x: number; y: number }[]): PagePoint {
  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);

  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2
  };
}

function previewScaleFromV3000Graph(
  atoms: readonly { sourceId: string; x: number; y: number }[],
  bonds: readonly { fromSourceId: string; toSourceId: string }[],
  previous: MoleculeObject
): number {
  const rawAtomById = new Map(atoms.map((atom) => [atom.sourceId, atom]));
  const rawBondLengths = bonds
    .map((bond) => {
      const fromAtom = rawAtomById.get(bond.fromSourceId);
      const toAtom = rawAtomById.get(bond.toSourceId);
      return fromAtom && toAtom ? distance(fromAtom, toAtom) : undefined;
    })
    .filter((value): value is number => value !== undefined && value > 0);
  const rawAverage = average(rawBondLengths);

  if (!rawAverage) {
    return averageNativeBondLength(previous) ?? nativeBondLength;
  }

  return (averageNativeBondLength(previous) ?? nativeBondLength) / rawAverage;
}

function averageNativeBondLength(molecule: MoleculeObject): number | undefined {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const lengths = molecule.bonds
    .map((bond) => {
      const fromAtom = atomById.get(bond.fromAtomId);
      const toAtom = atomById.get(bond.toAtomId);
      return fromAtom && toAtom ? distance(fromAtom, toAtom) : undefined;
    })
    .filter((value): value is number => value !== undefined && value > 0);

  return average(lengths);
}

function average(values: readonly number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function formalChargeFromV3000AtomLine(line: string): number {
  const match = /\bCHG=(-?\d+)\b/.exec(line);
  return match ? Number(match[1]) : 0;
}

function bondOrderFromV3000(value: string): MoleculeBond["order"] {
  if (value === "1") {
    return "single";
  }
  if (value === "2") {
    return "double";
  }
  if (value === "3") {
    return "triple";
  }
  if (value === "4") {
    return "aromatic";
  }

  return "unknown";
}

function nextOrdinalId(prefix: string, index: number): string {
  return `${prefix}_${String(index + 1).padStart(3, "0")}`;
}

function isEditableNativeMoleculeGraph(molecule: MoleculeObject): boolean {
  const atomIds = new Set(molecule.atoms.map((atom) => atom.id));
  const supportedBondOrders = new Set<MoleculeBond["order"]>(["single", "double", "triple", "aromatic", "unknown"]);

  return (
    molecule.atoms.length >= 1 &&
    molecule.atoms.every((atom) =>
      atom.id.trim().length > 0 &&
      atom.element.trim().length > 0 &&
      Number.isFinite(atom.x) &&
      Number.isFinite(atom.y)
    ) &&
    molecule.bonds.every((bond) =>
      bond.id.trim().length > 0 &&
      bond.fromAtomId !== bond.toAtomId &&
      atomIds.has(bond.fromAtomId) &&
      atomIds.has(bond.toAtomId) &&
      supportedBondOrders.has(bond.order)
    )
  );
}

function normalizeNativeMoleculeGeometry(molecule: MoleculeObject): MoleculeObject {
  if (molecule.atoms.length === 0) {
    return {
      ...molecule,
      width: 0,
      height: 0
    };
  }

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

function nativeSingleBondGraphMetadata(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ChemicalMetadata {
  const elementCounts = new Map<string, number>();
  const valenceUsage = atomBondOrderUsageMap(atoms, bonds);
  const totalCharge = atoms.reduce((sum, atom) => sum + atom.formalCharge, 0);
  const warnings = nativeInvalidAtomWarnings(atoms, bonds);

  atoms.forEach((atom) => {
    const element = nativeElementFromAtomLabel(atom.element);
    if (!element) {
      return;
    }
    elementCounts.set(element, (elementCounts.get(element) ?? 0) + 1);

    if (element !== "H") {
      const implicitHydrogens = nativeImplicitHydrogenCount(element, valenceUsage.get(atom.id) ?? 0);
      elementCounts.set("H", (elementCounts.get("H") ?? 0) + implicitHydrogens);
    }
  });

  const averageMass = [...elementCounts.entries()].reduce(
    (sum, [element, count]) => sum + (nativeAtomMass[element as NativeElementSymbol]?.average ?? 0) * count,
    0
  );
  const exactMass = [...elementCounts.entries()].reduce(
    (sum, [element, count]) => sum + (nativeAtomMass[element as NativeElementSymbol]?.exact ?? 0) * count,
    0
  );

  return {
    formula: formulaFromElementCounts(elementCounts),
    averageMass: Number(averageMass.toFixed(3)),
    exactMass: Number(exactMass.toFixed(5)),
    atomCount: atoms.length,
    bondCount: bonds.length,
    totalCharge,
    radicalCount: 0,
    isotopeLabels: [],
    stereochemistry: [],
    warnings
  };
}

function formulaFromElementCounts(counts: ReadonlyMap<string, number>): string {
  const carbonCount = counts.get("C") ?? 0;
  const remainingElements = [...counts.keys()]
    .filter((element) => element !== "C" && element !== "H")
    .sort();
  const orderedElements = carbonCount > 0
    ? ["C", "H", ...remainingElements]
    : [...counts.keys()].sort();

  return orderedElements
    .map((element) => ({ element, count: counts.get(element) ?? 0 }))
    .filter(({ count }) => count > 0)
    .map(({ element, count }) => `${element}${count === 1 ? "" : count}`)
    .join("") || "C0H0";
}

function nativeSingleBondGraphSmiles(atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]): string {
  if (atoms.length === 0) {
    return "";
  }
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const adjacency = nativeAdjacency(atoms, bonds);
  const bondByAtomPair = nativeBondByAtomPair(bonds);
  const components = nativeComponents(atoms, adjacency);
  const singleCycleSmiles = renderSingleCycleWithBranchesSmiles(atoms, bonds, components, adjacency, atomById, bondByAtomPair);
  if (singleCycleSmiles) {
    return singleCycleSmiles;
  }
  if (!isForestGraph(atoms, bonds, components)) {
    return atoms.map((atom) => nativeAtomSmiles(atom)).join("");
  }

  return components.map((componentIds) => {
    if (componentIds.length === 1) {
      return nativeAtomSmiles(atomById.get(componentIds[0]));
    }

    const componentAtoms = atoms.filter((atom) => componentIds.includes(atom.id));
    const mainPath = longestNativePath(componentAtoms, adjacency);
    return renderNativePath(mainPath, adjacency, atomById, bondByAtomPair);
  }).join(".");
}

function renderSingleCycleWithBranchesSmiles(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  components: readonly (readonly string[])[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  atomById: ReadonlyMap<string, MoleculeAtom>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string | undefined {
  if (components.length !== 1 || atoms.length < 3 || bonds.length !== atoms.length) {
    return undefined;
  }

  const cycleAtomIds = findSingleCycleAtomIds(atoms, adjacency);
  if (!cycleAtomIds || cycleAtomIds.length < 3) {
    return undefined;
  }

  const cycleAtomIdSet = new Set(cycleAtomIds);
  const cycleAdjacency = new Map(cycleAtomIds.map((atomId) => [
    atomId,
    (adjacency.get(atomId) ?? []).filter((neighborId) => cycleAtomIdSet.has(neighborId)).sort()
  ]));
  if ([...cycleAdjacency.values()].some((neighbors) => neighbors.length !== 2)) {
    return undefined;
  }

  const startAtomId = [...cycleAtomIds].sort()[0];
  const firstNeighborId = cycleAdjacency.get(startAtomId)?.[0];
  if (!firstNeighborId) {
    return undefined;
  }

  const cyclePath = [startAtomId];
  let previousAtomId = startAtomId;
  let currentAtomId = firstNeighborId;
  while (currentAtomId !== startAtomId) {
    cyclePath.push(currentAtomId);
    const nextAtomId = (cycleAdjacency.get(currentAtomId) ?? []).find((neighborId) => neighborId !== previousAtomId);
    if (!nextAtomId || cyclePath.length > cycleAtomIds.length) {
      return undefined;
    }

    previousAtomId = currentAtomId;
    currentAtomId = nextAtomId;
  }

  if (cyclePath.length !== cycleAtomIds.length) {
    return undefined;
  }

  return cyclePath.map((atomId, index) => {
    const symbol = nativeAtomSmiles(atomById.get(atomId));
    const previousAtomId = cyclePath[index - 1];
    const bondPrefix = previousAtomId ? bondOrderSymbol(bondByAtomPair.get(atomPairKey(previousAtomId, atomId))?.order) : "";
    const ringClosure = index === 0 || index === cyclePath.length - 1 ? "1" : "";
    const cycleNeighbors = new Set(cycleAdjacency.get(atomId) ?? []);
    const branches = (adjacency.get(atomId) ?? [])
      .filter((neighborId) => !cycleNeighbors.has(neighborId))
      .sort((left, right) =>
        subtreeSize(right, atomId, adjacency) - subtreeSize(left, atomId, adjacency) || left.localeCompare(right)
      )
      .map((branchId) => `(${renderNativeBranch(branchId, atomId, adjacency, atomById, bondByAtomPair)})`)
      .join("");
    return `${bondPrefix}${symbol}${ringClosure}${branches}`;
  }).join("");
}

function findSingleCycleAtomIds(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined {
  const remaining = new Set(atoms.map((atom) => atom.id));
  const degrees = new Map(atoms.map((atom) => [atom.id, adjacency.get(atom.id)?.length ?? 0]));
  const pending = [...degrees.entries()]
    .filter(([, degree]) => degree <= 1)
    .map(([atomId]) => atomId);

  while (pending.length > 0) {
    const atomId = pending.pop();
    if (!atomId || !remaining.has(atomId)) {
      continue;
    }

    remaining.delete(atomId);
    (adjacency.get(atomId) ?? []).forEach((neighborId) => {
      if (!remaining.has(neighborId)) {
        return;
      }

      const nextDegree = (degrees.get(neighborId) ?? 0) - 1;
      degrees.set(neighborId, nextDegree);
      if (nextDegree <= 1) {
        pending.push(neighborId);
      }
    });
  }

  const cycleAtomIds = [...remaining].sort();
  if (cycleAtomIds.length < 3) {
    return undefined;
  }

  return cycleAtomIds;
}

function isForestGraph(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  components: readonly (readonly string[])[]
): boolean {
  const atomIds = new Set(atoms.map((atom) => atom.id));
  if (bonds.some((bond) => !atomIds.has(bond.fromAtomId) || !atomIds.has(bond.toAtomId))) {
    return false;
  }

  return bonds.length === atoms.length - components.length;
}

function nativeComponents(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly (readonly string[])[] {
  const visited = new Set<string>();
  const components: string[][] = [];

  atoms.map((atom) => atom.id).sort().forEach((startAtomId) => {
    if (visited.has(startAtomId)) {
      return;
    }

    const component: string[] = [];
    const pending = [startAtomId];
    while (pending.length > 0) {
      const atomId = pending.pop();
      if (!atomId || visited.has(atomId)) {
        continue;
      }

      visited.add(atomId);
      component.push(atomId);
      pending.push(...(adjacency.get(atomId) ?? []).filter((neighborId) => !visited.has(neighborId)));
    }

    components.push(component.sort());
  });

  return components;
}

function nativeAdjacency(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ReadonlyMap<string, readonly string[]> {
  const atomIds = new Set(atoms.map((atom) => atom.id));
  const adjacency = new Map(atoms.map((atom) => [atom.id, [] as string[]]));

  bonds.forEach((bond) => {
    if (!atomIds.has(bond.fromAtomId) || !atomIds.has(bond.toAtomId)) {
      return;
    }
    adjacency.get(bond.fromAtomId)?.push(bond.toAtomId);
    adjacency.get(bond.toAtomId)?.push(bond.fromAtomId);
  });

  adjacency.forEach((neighbors) => {
    neighbors.sort();
  });

  return adjacency;
}

function nativeBondByAtomPair(bonds: readonly MoleculeBond[]): ReadonlyMap<string, MoleculeBond> {
  return new Map(bonds.map((bond) => [atomPairKey(bond.fromAtomId, bond.toAtomId), bond]));
}

function nativeMoleculePartBondIds(
  molecule: MoleculeObject,
  target: NativeMoleculePartReorderTarget
): Set<string> {
  const atomIds = new Set<string>();
  const bondIds = new Set<string>();

  if (target.kind === "atom") {
    atomIds.add(target.atomId);
  } else if (target.kind === "bond") {
    bondIds.add(target.bondId);
  } else {
    target.atomIds.forEach((atomId) => atomIds.add(atomId));
    target.bondIds.forEach((bondId) => bondIds.add(bondId));
  }

  molecule.bonds.forEach((bond) => {
    if (atomIds.has(bond.fromAtomId) || atomIds.has(bond.toAtomId)) {
      bondIds.add(bond.id);
    }
  });

  return new Set(molecule.bonds
    .filter((bond) => bondIds.has(bond.id))
    .map((bond) => bond.id));
}

function nativeMoleculePartAtomIds(
  molecule: MoleculeObject,
  target: NativeMoleculePartMoveTarget
): Set<string> {
  const atomIds = new Set<string>();
  const bondIds = new Set<string>();

  if (target.kind === "atom") {
    atomIds.add(target.atomId);
  } else if (target.kind === "bond") {
    bondIds.add(target.bondId);
  } else {
    target.atomIds.forEach((atomId) => atomIds.add(atomId));
    target.bondIds.forEach((bondId) => bondIds.add(bondId));
  }

  molecule.bonds.forEach((bond) => {
    if (bondIds.has(bond.id)) {
      atomIds.add(bond.fromAtomId);
      atomIds.add(bond.toAtomId);
    }
  });

  return new Set(molecule.atoms
    .filter((atom) => atomIds.has(atom.id))
    .map((atom) => atom.id));
}

function reorderMoleculeBonds(
  bonds: readonly MoleculeBond[],
  targetBondIds: ReadonlySet<string>,
  placement: ObjectReorderPlacement
): MoleculeBond[] {
  if (placement === "front") {
    return [
      ...bonds.filter((bond) => !targetBondIds.has(bond.id)),
      ...bonds.filter((bond) => targetBondIds.has(bond.id))
    ];
  }

  if (placement === "back") {
    return [
      ...bonds.filter((bond) => targetBondIds.has(bond.id)),
      ...bonds.filter((bond) => !targetBondIds.has(bond.id))
    ];
  }

  const reordered = [...bonds];
  if (placement === "forward") {
    for (let index = reordered.length - 2; index >= 0; index -= 1) {
      if (targetBondIds.has(reordered[index].id) && !targetBondIds.has(reordered[index + 1].id)) {
        [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
      }
    }
    return reordered;
  }

  for (let index = 1; index < reordered.length; index += 1) {
    if (targetBondIds.has(reordered[index].id) && !targetBondIds.has(reordered[index - 1].id)) {
      [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
    }
  }
  return reordered;
}

function atomPairKey(leftAtomId: string, rightAtomId: string): string {
  return [leftAtomId, rightAtomId].sort().join("::");
}

function longestNativePath(
  atoms: readonly MoleculeAtom[],
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] {
  const atomIds = atoms.map((atom) => atom.id).sort();
  return atomIds
    .flatMap((fromAtomId) => atomIds.map((toAtomId) => pathBetweenAtoms(fromAtomId, toAtomId, adjacency)))
    .filter((path): path is readonly string[] => path !== undefined)
    .sort((left, right) => right.length - left.length || left.join(".").localeCompare(right.join(".")))[0] ?? [atomIds[0] ?? "C"];
}

function pathBetweenAtoms(
  fromAtomId: string,
  toAtomId: string,
  adjacency: ReadonlyMap<string, readonly string[]>
): readonly string[] | undefined {
  const pending: Array<readonly string[]> = [[fromAtomId]];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const path = pending.shift();
    const atomId = path?.[path.length - 1];
    if (!path || !atomId || visited.has(atomId)) {
      continue;
    }
    if (atomId === toAtomId) {
      return path;
    }

    visited.add(atomId);
    for (const neighborId of adjacency.get(atomId) ?? []) {
      if (!visited.has(neighborId)) {
        pending.push([...path, neighborId]);
      }
    }
  }

  return undefined;
}

function renderNativePath(
  path: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  atomById: ReadonlyMap<string, MoleculeAtom>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  return path.map((atomId, index) => {
    const previousAtomId = path[index - 1];
    const nextAtomId = path[index + 1];
    const bondPrefix = previousAtomId ? bondOrderSymbol(bondByAtomPair.get(atomPairKey(previousAtomId, atomId))?.order) : "";
    const branches = (adjacency.get(atomId) ?? [])
      .filter((neighborId) => neighborId !== previousAtomId && neighborId !== nextAtomId)
      .sort((left, right) =>
        subtreeSize(right, atomId, adjacency) - subtreeSize(left, atomId, adjacency) || left.localeCompare(right)
      );
    return `${bondPrefix}${nativeAtomSmiles(atomById.get(atomId))}${branches.map((branchId) =>
      `(${renderNativeBranch(branchId, atomId, adjacency, atomById, bondByAtomPair)})`
    ).join("")}`;
  }).join("");
}

function renderNativeBranch(
  atomId: string,
  parentAtomId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  atomById: ReadonlyMap<string, MoleculeAtom>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  const bondPrefix = bondOrderSymbol(bondByAtomPair.get(atomPairKey(parentAtomId, atomId))?.order);
  const branches = (adjacency.get(atomId) ?? [])
    .filter((neighborId) => neighborId !== parentAtomId)
    .sort((left, right) =>
      subtreeSize(right, atomId, adjacency) - subtreeSize(left, atomId, adjacency) || left.localeCompare(right)
    );
  return `${bondPrefix}${nativeAtomSmiles(atomById.get(atomId))}${branches.map((branchId) =>
    `(${renderNativeBranch(branchId, atomId, adjacency, atomById, bondByAtomPair)})`
  ).join("")}`;
}

function bondOrderSymbol(order: MoleculeBond["order"] | undefined): string {
  if (order === "double") {
    return "=";
  }
  if (order === "triple") {
    return "#";
  }

  return "";
}

function nativeAtomSmiles(atom: MoleculeAtom | undefined): string {
  if (!atom) {
    return "C";
  }

  if (atom.formalCharge !== 0) {
    return `[${atom.element}${atomChargeLabelSuffix(atom.formalCharge)}]`;
  }

  return atom.element === "H" ? "[H]" : atom.element;
}

function nativeAtomAvailableBondCount(atom: MoleculeAtom, valenceUsed: number): number {
  return nativeElementFromAtomLabel(atom.element) === undefined
    ? 0
    : Math.max(0, nativeAtomInvalidGrowthLimit - valenceUsed);
}

function implicitHydrogenLabelSuffix(count: number): string {
  if (count <= 0) {
    return "";
  }

  return count === 1 ? "H" : `H${count}`;
}

function atomChargeLabelSuffix(charge: number): string {
  if (charge === 0) {
    return "";
  }

  const magnitude = Math.abs(charge);
  const sign = charge > 0 ? "+" : "-";
  return magnitude === 1 ? sign : `${magnitude}${sign}`;
}

function nativeChargeValue(charge: number | undefined): NativeChargeValue | undefined {
  if (charge === 1 || charge === -1) {
    return charge;
  }

  return undefined;
}

function nativeImplicitHydrogenCount(element: NativeElementSymbol, valenceUsed: number): number {
  const neutralValence = nativeAtomValence[element];
  return neutralValence === undefined ? 0 : Math.max(0, neutralValence - valenceUsed);
}

function nativeAtomFormalChargeForValence(
  element: NativeElementSymbol,
  valenceUsed: number
): number | undefined {
  const neutralValence = nativeAtomValence[element];
  const maxValence = nativeAtomMaxValence[element];
  if (neutralValence === undefined || maxValence === undefined) {
    return undefined;
  }

  if (valenceUsed < 0 || valenceUsed > maxValence) {
    return undefined;
  }

  if (valenceUsed <= neutralValence) {
    return 0;
  }

  if (element === "B" && valenceUsed === 4) {
    return -1;
  }

  if ((element === "N" || element === "O") && valenceUsed === neutralValence + 1) {
    return 1;
  }

  if (element === "P" && valenceUsed === 4) {
    return 1;
  }

  if (element === "P" && valenceUsed === 5) {
    return 0;
  }

  if (element === "S" && (valenceUsed === 4 || valenceUsed === 6)) {
    return 0;
  }

  return undefined;
}

function nativeInvalidAtomWarnings(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): CompatibilityWarning[] {
  return atoms
    .map((atom) => nativeAtomValidationState(atom, bonds))
    .filter((state) => !state.valid)
    .map((state) => ({
      code: "chemistry.invalid_valence",
      message: state.invalidReason ?? `${state.element} atom ${state.atomId} has invalid valence.`,
      objectId: state.atomId
    }));
}

function subtreeSize(
  atomId: string,
  parentAtomId: string,
  adjacency: ReadonlyMap<string, readonly string[]>
): number {
  return 1 + (adjacency.get(atomId) ?? [])
    .filter((neighborId) => neighborId !== parentAtomId)
    .reduce((sum, neighborId) => sum + subtreeSize(neighborId, atomId, adjacency), 0);
}

function atomDegreeMap(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ReadonlyMap<string, number> {
  const degrees = new Map(atoms.map((atom) => [atom.id, 0]));
  bonds.forEach((bond) => {
    degrees.set(bond.fromAtomId, (degrees.get(bond.fromAtomId) ?? 0) + 1);
    degrees.set(bond.toAtomId, (degrees.get(bond.toAtomId) ?? 0) + 1);
  });

  return degrees;
}

function atomBondOrderUsageMap(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): ReadonlyMap<string, number> {
  const usage = new Map(atoms.map((atom) => [atom.id, 0]));
  bonds.forEach((bond) => {
    const value = nativeBondOrderValue[bond.order] ?? 1;
    usage.set(bond.fromAtomId, (usage.get(bond.fromAtomId) ?? 0) + value);
    usage.set(bond.toAtomId, (usage.get(bond.toAtomId) ?? 0) + value);
  });

  return usage;
}

function nativeAtomBondOrderUsage(atomId: string, bonds: readonly MoleculeBond[]): number {
  return bonds.reduce((sum, bond) => (
    bond.fromAtomId === atomId || bond.toAtomId === atomId
      ? sum + (nativeBondOrderValue[bond.order] ?? 1)
      : sum
  ), 0);
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

function nextIndexedIds(prefix: string, ids: readonly string[], count: number): string[] {
  const existing = new Set(ids);
  const nextIds: string[] = [];
  let index = ids.length + 1;

  while (nextIds.length < count) {
    const id = `${prefix}_${String(index).padStart(3, "0")}`;
    index += 1;
    if (!existing.has(id)) {
      existing.add(id);
      nextIds.push(id);
    }
  }

  return nextIds;
}

function distance(left: PagePoint, right: PagePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function angularDistance(left: number, right: number): number {
  const delta = Math.abs(normalizeAngle(left) - normalizeAngle(right));
  return Math.min(delta, Math.PI * 2 - delta);
}

function normalizeAngle(angle: number): number {
  let normalized = angle % (Math.PI * 2);
  if (normalized < 0) {
    normalized += Math.PI * 2;
  }
  return normalized;
}

function normalizeSignedAngle(angle: number): number {
  const normalized = normalizeAngle(angle);
  return normalized > Math.PI ? normalized - Math.PI * 2 : normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
