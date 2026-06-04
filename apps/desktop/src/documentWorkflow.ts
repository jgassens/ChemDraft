import {
  applyPatch,
  applyPatches,
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  createPageLayout,
  deserializeDocument,
  pageMarginFromLayout,
  serializeDocument,
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
  mimeType: "application/vnd.chemdraft+json";
  contents: string;
}

export interface ClipboardPasteResult {
  document: ChemDraftDocument;
  status: string;
  kind: ClipboardDetectedPayload["kind"];
  selectedObjectId?: string;
  editTextObjectId?: string;
  warnings: ClipboardTransferWarning[];
}

export type PagePoint = LayoutPoint;

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

export interface NativeFreeformBondGrowthOptions {
  forceCustomLength?: boolean;
}

export type NativeMoleculeDeleteHit =
  | {
      kind: "atom";
      atomId: string;
      distanceToPointer: number;
    }
  | {
      kind: "bond";
      bondId: string;
      fromAtomId: string;
      toAtomId: string;
      terminalAtomId?: string;
      distanceToPointer: number;
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

const defaultNativeMoleculeTransform: MoleculeTransformState = {
  scaleX: 1,
  scaleY: 1,
  rotationDegrees: 0
};

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
        spans: [{ text, script: "normal", style: {} }]
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

export function updateSelectedNativeTextObjectStyle(
  document: ChemDraftDocument,
  style: Partial<NativeTextStyle>
): ChemDraftDocument {
  const selected = getSelectedTextObject(document);
  return selected ? updateNativeTextObjectStyle(document, selected.id, style) : document;
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
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  const selected = getSelectedMolecule(document);
  const extended = selected ? extendNativeCarbonChain(selected, point, page.width, page.height) : undefined;

  if (!selected) {
    return insertNativeSingleBondMolecule(document, point);
  }

  if (!extended) {
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

export function findNativeMoleculeDeleteHit(
  molecule: MoleculeObject,
  point: PagePoint
): NativeMoleculeDeleteHit | undefined {
  if (!isEditableNativeMoleculeGraph(molecule)) {
    return undefined;
  }

  const atomHit = findNearestAtomAtPoint({
    atoms: molecule.atoms,
    point,
    hitRadius: atomHitRadius
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
    hitRadius: bondHitRadius
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

export function getSelectedMolecule(document: ChemDraftDocument): MoleculeObject | undefined {
  const object = getSelectedObject(document);
  return object?.type === "molecule" ? object : undefined;
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
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === target.objectId));
  const molecule = page?.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || molecule.bonds.length < 2) {
    return document;
  }

  const targetBondIds = nativeMoleculePartBondIds(molecule, target);
  if (targetBondIds.size === 0 || targetBondIds.size === molecule.bonds.length) {
    return document;
  }

  const reorderedBonds = reorderMoleculeBonds(molecule.bonds, targetBondIds, placement);
  if (reorderedBonds.every((bond, index) => bond.id === molecule.bonds[index]?.id)) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: molecule.id,
      changes: { bonds: reorderedBonds }
    },
    { now: phase4Timestamp }
  );
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
          }))
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

export function nativeMoleculeTransformState(molecule: MoleculeObject): MoleculeTransformState {
  return {
    scaleX: normalizeNativeMoleculeScale(molecule.transform?.scaleX ?? defaultNativeMoleculeTransform.scaleX),
    scaleY: normalizeNativeMoleculeScale(molecule.transform?.scaleY ?? defaultNativeMoleculeTransform.scaleY),
    rotationDegrees: normalizeDegrees(molecule.transform?.rotationDegrees ?? defaultNativeMoleculeTransform.rotationDegrees)
  };
}

function withNativeMoleculeTransform(
  molecule: MoleculeObject,
  transform: MoleculeTransformState
): MoleculeObject {
  return {
    ...molecule,
    transform: {
      scaleX: normalizeNativeMoleculeScale(transform.scaleX),
      scaleY: normalizeNativeMoleculeScale(transform.scaleY),
      rotationDegrees: normalizeDegrees(transform.rotationDegrees)
    }
  };
}

function normalizeNativeMoleculeScale(scale: number): number {
  return Number((Number.isFinite(scale) && scale > 0 ? scale : 1).toFixed(4));
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

function findTextObject(document: ChemDraftDocument, objectId: string): TextObject | undefined {
  return findTextObjectLocation(document, objectId)?.object;
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
  pageHeight: number
): MoleculeObject | undefined {
  const preview = previewNativeMoleculeBondGrowth(molecule, point, pageWidth, pageHeight);
  if (!preview) {
    return undefined;
  }

  return preview.targetAtomId
    ? connectNativeCarbonAtoms(molecule, preview.atomId, preview.targetAtomId)
    : extendNativeCarbonGraph(molecule, preview.atomId, preview.newAtomPoint);
}

function extendNativeCarbonGraph(
  molecule: MoleculeObject,
  sourceAtomId: string,
  newAtomPoint: PagePoint
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
      order: "single" as const
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
  targetAtomId: string
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
      order: "single" as const
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
  if (order === "double") {
    return {
      ...bond,
      order,
      display: {
        ...(bond.display ?? {}),
        doubleBondSide: bond.display?.doubleBondSide ?? defaultDoubleBondSide(molecule, bond)
      }
    };
  }

  const { display: _display, ...bondWithoutDisplay } = bond;
  return {
    ...bondWithoutDisplay,
    order
  };
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
