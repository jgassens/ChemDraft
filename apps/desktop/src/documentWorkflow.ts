import {
  editGraphicMarkerSize,
  snapGraphicMarkerSizePx,
  clampGraphicShaftMarkSizePx,
  editGraphicCornerRadius,
  editGraphicPathGeometry,
  deleteGraphicPathNode,
  deleteGraphicPathSegment,
  splitGraphicPathSegmentAtPoint,
  createGraphicFreehandPathCache,
  defaultVisualEffectForKind,
  graphicCornerRadiusEditPoint,
  graphicObjectSupportsBooleanOperation,
  graphicPathEditPoints,
  graphicPathNodeEditPoints,
  inactiveVisualEffectsForStyle,
  mergeVisualEffectsByKind,
  planNativeArtVisual,
  planNativeArtBooleanOperation,
  prepareGraphicPathForDirectEdit as prepareGraphicPathObjectForDirectEdit,
  visualEffectsForStyle,
  visualStyleWithEffects,
  type NativeArtPoint,
  type NativeArtBooleanOperation,
  type NativeArtBooleanSkippedInput,
  type NativeArtBooleanResultPath,
  type NativeArtMarkerHandleId,
  type NativeArtVisualPlan,
  type GraphicPathEditHandle,
  type GraphicPathEditPoints,
  type GraphicPathNodeEditPoints,
  type VisualEffectKind
} from "@chemdraft/art-engine";
import {
  applyPatch,
  applyPatches,
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  DocumentObjectSchema,
  createPageLayout,
  createCustomPageLayout,
  cssPxToPageSize,
  DEFAULT_MIN_PROJECTED_BOND_LENGTH_FRACTION,
  pageLayoutSourceUnit,
  flattenPerspectiveFrom3D,
  moleculeToMolfileV2000,
  moleculeToMolfileV3000,
  PageSizePresets,
  pageMarginFromLayout,
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  stylePresetToObjectStyle,
  textStyleToObjectStyle,
  type Anchor,
  type ArrowObject,
  type BracketObject,
  type ChemDraftDocument,
  type ChemicalMetadata,
  type CompatibilityWarning,
  type DocumentPatch,
  type DocumentObject,
  type DocumentPage,
  type ElectronMarkObject,
  type MechanismArrowObject,
  type FlattenWarning,
  type GraphicFreehandOptions,
  type GraphicFreehandPoint,
  type GraphicMarker,
  type GraphicObjectData,
  type GraphicObject,
  type GroupObject,
  type GraphicPaint,
  type GraphicObjectStyle,
  type PageLayout,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  type MoleculeTransformState,
  type NativeDrawingStyle,
  type NativeTextStyle,
  type ObjectReorderPlacement,
  type PageOrientation,
  type PageSizePresetId,
  type PageSizeUnit,
  type StereoCenterReport,
  type TextSpan,
  type TextObject,
  type VisualEffect,
  type ViewMatrix
} from "@chemdraft/chem-core";
import {
  exportDocumentToCdxml as exportDocumentToCdxmlEnvelope,
  openChemDraftPayload,
  sha256Utf8Hex,
  type ChemDraftOpenResult,
  type CompatibilityConversionWarning
} from "@chemdraft/cdx-compat";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import type { EditorSaveResult } from "@chemdraft/editor-adapter";
import type { ScreenPlacement } from "./interaction/spinOverlay";
import {
  exportDocumentToCdxml as exportDocumentToCdxmlText,
  exportDocumentToSvg,
  type BinaryExportResult,
  type CdxmlTextExportOptions,
  type PdfExportOptions,
  type SvgExportOptions,
  type SvgExportResult,
  type TextExportResult
} from "@chemdraft/export-engine";
import {
  findNearestAtomAtPoint,
  findNearestBondHit,
  nativeMoleculeRings,
  planBondExtension,
  planFreeformBondExtension,
  doubleBondRendersSymmetric,
  nativeAtomValenceForCharge,
  defaultMechanismArrowControls,
  mechanismArrowGeometry,
  resolvePageAnchorPoint,
  ringInteriorDoubleBondSides,
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

export interface PageObjectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImportedPageFitRecommendation {
  pageId: string;
  pageIndex: number;
  currentPresetId: PageSizePresetId;
  currentOrientation: PageOrientation;
  currentPageTitle: string;
  recommendedPresetId: PageSizePresetId;
  recommendedOrientation: PageOrientation;
  recommendedPageTitle: string;
  recommendedLayout: PageLayout;
  contentBounds: PageObjectBounds;
  requiredWidthPx: number;
  requiredHeightPx: number;
  translateX: number;
  translateY: number;
  overflowLeftPx: number;
  overflowTopPx: number;
  overflowRightPx: number;
  overflowBottomPx: number;
}

export interface ClipboardPasteResult {
  document: ChemDraftDocument;
  status: string;
  kind: ClipboardDetectedPayload["kind"];
  selectedObjectId?: string;
  editTextObjectId?: string;
  warnings: ClipboardTransferWarning[];
}

export const CHEMDRAFT_SELECTION_CLIPBOARD_TYPE = "application/x-chemdraft-selection+json";

export interface ChemDraftSelectionClipboardPayload {
  kind: "chemdraft-selection";
  version: 1;
  objects: DocumentObject[];
  selectionIds: string[];
  bounds: SelectionBounds;
}

export interface NativeTextSelectionRange {
  start: number;
  end: number;
}

export type NativeMoleculeColorTarget =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "parts"; atomIds: readonly string[]; bondIds: readonly string[] };
export type NativeMoleculeRingTarget = { objectId: string; kind: "ring"; ringKey: string };

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

export type NativeArtToolId =
  | "circle"
  | "circleDashed"
  | "circleGloss"
  | "circleFilled"
  | "circleShadow"
  | "ellipse"
  | "ellipseDashed"
  | "ellipseGloss"
  | "ellipseFilled"
  | "ellipseShadow"
  | "roundedRect"
  | "roundedRectDashed"
  | "roundedRectGloss"
  | "roundedRectFilled"
  | "roundedRectShadow"
  | "rect"
  | "rectDashed"
  | "rectGloss"
  | "rectFilled"
  | "rectShadow"
  | "line"
  | "lineDashed"
  | "lineWavy"
  | "lineBold"
  | "pen"
  | "polyline"
  | "pencil"
  | "brush"
  | "arrow"
  | "reactionArrow"
  | "reactionArrowBold"
  | "reactionArrowDashed"
  | "resonanceArrow"
  | "equilibriumArrow"
  | "retroArrow"
  | "curvedArrow90"
  | "curvedArrow180"
  | "fishhookArrow"
  | "fishhookCurved"
  | "noReactionArrow"
  | "arc270"
  | "arc270Dashed"
  | "arc180"
  | "arc180Dashed"
  | "arc120"
  | "arc120Dashed"
  | "arc90"
  | "arc90Dashed"
  | "lobe"
  | "shadedLobe"
  | "pOrbital"
  | "sOrbital";

export interface NativeArtToolDefinition {
  id: NativeArtToolId;
  commandId: string;
  title: string;
  graphicKind: GraphicObject["graphicKind"];
  width: number;
  height: number;
  data: GraphicObjectData;
  style: GraphicObjectStyle;
}

export type NativeGraphicPathEditHandle = GraphicPathEditHandle;
export type NativeGraphicPathEditPoints = GraphicPathEditPoints;
export type NativeGraphicPathNodeEditPoints = GraphicPathNodeEditPoints;

export interface NativeGraphicPathSegmentSplit {
  document: ChemDraftDocument;
  segmentIndex: number;
  point: PagePoint;
  distance: number;
}
export type NativeGraphicMarkerHandleId = NativeArtMarkerHandleId;
export type NativeGraphicCornerRadiusEditPoint = NativeArtPoint;
export type GraphicStyleEffectKind = VisualEffectKind | "none";
export type GraphicStyleAdjustableEffectKind = Exclude<GraphicStyleEffectKind, "none">;

const artOutlineStyle = {
  strokeColor: "#111111",
  fillColor: "none",
  strokeWidth: 2
} satisfies GraphicObjectStyle;

const artFilledStyle = {
  strokeColor: "#111111",
  fillColor: "#111111",
  strokeWidth: 1.5,
  fillMode: "solid"
} satisfies GraphicObjectStyle;

const artGlossStyle = {
  strokeColor: "#111111",
  fillColor: "#111111",
  strokeWidth: 1.5,
  fillMode: "gloss"
} satisfies GraphicObjectStyle;

const artShadowStyle = {
  strokeColor: "#111111",
  fillColor: "#f8faf9",
  strokeWidth: 2,
  effect: "shadow"
} satisfies GraphicObjectStyle;

export const nativeArtToolDefinitions: readonly NativeArtToolDefinition[] = [
  artShapeTool("circle", "Circle", "ellipse", 48, 48, {}, artOutlineStyle),
  artShapeTool("circleDashed", "Dashed Circle", "ellipse", 48, 48, {}, { ...artOutlineStyle, strokeDasharray: "3 4" }),
  artShapeTool("circleGloss", "Gloss Circle", "ellipse", 48, 48, {}, artGlossStyle),
  artShapeTool("circleFilled", "Filled Circle", "ellipse", 48, 48, {}, artFilledStyle),
  artShapeTool("circleShadow", "Shadow Circle", "ellipse", 48, 48, {}, artShadowStyle),
  artShapeTool("ellipse", "Ellipse", "ellipse", 72, 34, {}, artOutlineStyle),
  artShapeTool("ellipseDashed", "Dashed Ellipse", "ellipse", 72, 34, {}, { ...artOutlineStyle, strokeDasharray: "3 4" }),
  artShapeTool("ellipseGloss", "Gloss Ellipse", "ellipse", 72, 34, {}, artGlossStyle),
  artShapeTool("ellipseFilled", "Filled Ellipse", "ellipse", 72, 34, {}, artFilledStyle),
  artShapeTool("ellipseShadow", "Shadow Ellipse", "ellipse", 72, 34, {}, artShadowStyle),
  artShapeTool("roundedRect", "Rounded Rectangle", "rect", 72, 40, { cornerRadiusPx: 7 }, artOutlineStyle),
  artShapeTool("roundedRectDashed", "Dashed Rounded Rectangle", "rect", 72, 40, { cornerRadiusPx: 7 }, { ...artOutlineStyle, strokeDasharray: "3 4" }),
  artShapeTool("roundedRectGloss", "Gloss Rounded Rectangle", "rect", 72, 40, { cornerRadiusPx: 7 }, artGlossStyle),
  artShapeTool("roundedRectFilled", "Filled Rounded Rectangle", "rect", 72, 40, { cornerRadiusPx: 7 }, artFilledStyle),
  artShapeTool("roundedRectShadow", "Shadow Rounded Rectangle", "rect", 72, 40, { cornerRadiusPx: 7 }, artShadowStyle),
  artShapeTool("rect", "Rectangle", "rect", 72, 40, {}, artOutlineStyle),
  artShapeTool("rectDashed", "Dashed Rectangle", "rect", 72, 40, {}, { ...artOutlineStyle, strokeDasharray: "3 4" }),
  artShapeTool("rectGloss", "Gloss Rectangle", "rect", 72, 40, {}, artGlossStyle),
  artShapeTool("rectFilled", "Filled Rectangle", "rect", 72, 40, {}, artFilledStyle),
  artShapeTool("rectShadow", "Shadow Rectangle", "rect", 72, 40, {}, artShadowStyle),
  artShapeTool("line", "Line", "path", 82, 46, { artPathKind: "line" }, artOutlineStyle),
  artShapeTool("lineDashed", "Dashed Line", "path", 82, 46, { artPathKind: "line" }, { ...artOutlineStyle, strokeDasharray: "6 6" }),
  artShapeTool("lineWavy", "Wavy Line", "path", 82, 46, { artPathKind: "wavy" }, artOutlineStyle),
  artShapeTool("lineBold", "Bold Line", "path", 82, 46, { artPathKind: "line" }, { ...artOutlineStyle, strokeWidth: 6 }),
  artShapeTool("pen", "Pen", "path", 1, 1, { artPathKind: "bezier" }, artOutlineStyle),
  artShapeTool("polyline", "Polyline", "path", 96, 72, {
    artPathKind: "polyline",
    pathNodes: [
      { point: { x: 8, y: 58 } },
      { point: { x: 44, y: 14 } },
      { point: { x: 88, y: 46 } }
    ]
  }, artOutlineStyle),
  artShapeTool("pencil", "Pencil", "path", 1, 1, {
    artPathKind: "freehand",
    freehandOptions: {
      size: 5,
      thinning: 0.25,
      smoothing: 0.35,
      streamline: 0.25,
      simulatePressure: false
    }
  }, { strokeColor: "#111111", fillColor: "none" }),
  artShapeTool("brush", "Brush", "path", 1, 1, {
    artPathKind: "freehand",
    freehandOptions: {
      size: 16,
      thinning: 0.65,
      smoothing: 0.58,
      streamline: 0.42,
      simulatePressure: false
    }
  }, { strokeColor: "#111111", fillColor: "none" }),
  artShapeTool("arrow", "Arrow", "path", 82, 46, {
    artPathKind: "line",
    markerEnd: { kind: "filled-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  // Reaction/resonance arrows are drawn with the full art-arrow mechanics (draggable ends, arc,
  // arrowhead size) but carry their chemical identity in `artToolId`, which the CDXML layer reads to
  // emit/parse them as reaction arrows (single-headed reaction = forward; double-headed resonance).
  artShapeTool("reactionArrow", "Reaction Arrow", "path", 82, 46, {
    artPathKind: "line",
    markerEnd: { kind: "filled-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  artShapeTool("reactionArrowBold", "Reaction Arrow (Large Head)", "path", 82, 46, {
    artPathKind: "line",
    markerEnd: { kind: "filled-arrow", sizePx: 24 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  artShapeTool("reactionArrowDashed", "Dashed Reaction Arrow", "path", 82, 46, {
    artPathKind: "line",
    markerEnd: { kind: "filled-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt", strokeDasharray: "6 6" }),
  artShapeTool("resonanceArrow", "Resonance Arrow", "path", 82, 46, {
    artPathKind: "line",
    markerStart: { kind: "filled-arrow", sizePx: 16 },
    markerEnd: { kind: "filled-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  // Equilibrium: two parallel half-shafts pointing opposite ways. `markerEnd` heads the forward shaft
  // and `markerStart` the reverse one, so head sizing reuses the ordinary marker handles; each shaft's
  // length is an independent fraction of the axis (an equilibrium's two sides are rarely equal).
  artShapeTool("equilibriumArrow", "Equilibrium Arrow", "path", 82, 46, {
    artPathKind: "line",
    dualShaft: true,
    dualShaftGapPx: 7,
    markerStart: { kind: "half-arrow", sizePx: 14 },
    markerEnd: { kind: "half-arrow", sizePx: 14 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  // Retrosynthetic: the same two-shaft geometry, but both shafts run the same way with a single open
  // head spanning them ("=>"). Being an art arrow is what gives it the hover dots, drag-to-move and
  // hover-delete the other arrows have; `artToolId` still exports it as ArrowType="RetroSynthetic".
  // No marker: the "=>" head is part of the arrow's own path geometry (see graphicEquilibriumPathD) —
  // an axis-centred arrowhead marker can never span the two shafts.
  artShapeTool("retroArrow", "Retrosynthesis Arrow", "path", 82, 46, {
    artPathKind: "line",
    dualShaft: true,
    dualShaftParallel: true,
    dualShaftGapPx: 5
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  // Electron/arrow-pushing curves: the existing arc geometry with a reaction arrowhead. Dragging an
  // endpoint flips the sweep, so clockwise presets cover both directions.
  artShapeTool("curvedArrow90", "Curved Arrow (Gentle)", "path", 58, 58, {
    artPathKind: "arc",
    arcSweepRadians: degreesToRadians(90),
    markerEnd: { kind: "filled-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  artShapeTool("curvedArrow180", "Curved Arrow (Pronounced)", "path", 58, 58, {
    artPathKind: "arc",
    arcSweepRadians: degreesToRadians(180),
    markerEnd: { kind: "filled-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  // Fishhook (single-barb) arrows for radical / single-electron pushing.
  artShapeTool("fishhookArrow", "Fishhook Arrow", "path", 82, 46, {
    artPathKind: "line",
    markerEnd: { kind: "half-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  artShapeTool("fishhookCurved", "Curved Fishhook Arrow", "path", 58, 58, {
    artPathKind: "arc",
    arcSweepRadians: degreesToRadians(180),
    markerEnd: { kind: "half-arrow", sizePx: 16 }
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  // "Reaction didn't work": a reaction arrow crossed with an X at the shaft midpoint.
  artShapeTool("noReactionArrow", "No-Reaction Arrow", "path", 82, 46, {
    artPathKind: "line",
    markerEnd: { kind: "filled-arrow", sizePx: 16 },
    shaftMark: "cross"
  }, { ...artOutlineStyle, strokeLineCap: "butt" }),
  artArcTool("arc270", "Three-quarter Arc", 270, false),
  artArcTool("arc270Dashed", "Dashed Three-quarter Arc", 270, true),
  artArcTool("arc180", "Half Arc", 180, false),
  artArcTool("arc180Dashed", "Dashed Half Arc", 180, true),
  artArcTool("arc120", "One-third Arc", 120, false),
  artArcTool("arc120Dashed", "Dashed One-third Arc", 120, true),
  artArcTool("arc90", "Quarter Arc", 90, false),
  artArcTool("arc90Dashed", "Dashed Quarter Arc", 90, true),
  // Orbital tools keep their chemistry command ids (tool.lobe, …) but ride the art pipeline:
  // parametric closed paths get pointer placement, transform chrome, and SVG export for free.
  artShapeTool("lobe", "Orbital Lobe", "path", 40, 60, {
    artPathKind: "bezier",
    pathClosed: true,
    // Closed bezier fills need >= 3 nodes (art-engine pathKindSupportsClosedFill): tip plus two
    // upper bulb nodes.
    pathNodes: [
      { point: { x: 20, y: 56 }, inControl: { x: 30, y: 46 }, outControl: { x: 10, y: 46 } },
      { point: { x: 6, y: 16 }, inControl: { x: 2, y: 30 }, outControl: { x: 10, y: 4 } },
      { point: { x: 34, y: 16 }, inControl: { x: 30, y: 4 }, outControl: { x: 38, y: 30 } }
    ]
  }, artOutlineStyle, "tool.lobe"),
  artShapeTool("shadedLobe", "Shaded Orbital Lobe", "path", 40, 60, {
    artPathKind: "bezier",
    pathClosed: true,
    pathNodes: [
      { point: { x: 20, y: 56 }, inControl: { x: 30, y: 46 }, outControl: { x: 10, y: 46 } },
      { point: { x: 6, y: 16 }, inControl: { x: 2, y: 30 }, outControl: { x: 10, y: 4 } },
      { point: { x: 34, y: 16 }, inControl: { x: 30, y: 4 }, outControl: { x: 38, y: 30 } }
    ]
  }, artGlossStyle, "tool.shadedLobe"),
  artShapeTool("pOrbital", "p Orbital", "path", 40, 88, {
    artPathKind: "bezier",
    pathClosed: true,
    pathNodes: [
      { point: { x: 20, y: 44 }, inControl: { x: 6, y: 54 }, outControl: { x: 6, y: 34 } },
      { point: { x: 20, y: 4 }, inControl: { x: 2, y: 16 }, outControl: { x: 38, y: 16 } },
      { point: { x: 20, y: 44 }, inControl: { x: 34, y: 34 }, outControl: { x: 34, y: 54 } },
      { point: { x: 20, y: 84 }, inControl: { x: 38, y: 72 }, outControl: { x: 2, y: 72 } }
    ]
  }, artOutlineStyle, "tool.pOrbital"),
  artShapeTool("sOrbital", "s Orbital", "ellipse", 48, 48, {}, artGlossStyle, "tool.sOrbital")
];

const nativeArtToolByCommandId = new Map(nativeArtToolDefinitions.map((tool) => [tool.commandId, tool]));

function artShapeTool(
  id: NativeArtToolId,
  title: string,
  graphicKind: GraphicObject["graphicKind"],
  width: number,
  height: number,
  data: GraphicObjectData,
  style: GraphicObjectStyle,
  commandId: string = `tool.art.${id}`
): NativeArtToolDefinition {
  return {
    id,
    commandId,
    title,
    graphicKind,
    width,
    height,
    data,
    style
  };
}

function artArcTool(
  id: NativeArtToolId,
  title: string,
  arcSweepDegrees: number,
  dashed: boolean
): NativeArtToolDefinition {
  return artShapeTool(
    id,
    title,
    "path",
    58,
    58,
    {
      artPathKind: "arc",
      arcSweepRadians: degreesToRadians(arcSweepDegrees)
    },
    dashed ? { ...artOutlineStyle, strokeDasharray: "3 4" } : artOutlineStyle
  );
}

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

type Matrix3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number]
];

type ProjectedPlanePoint3d = ProjectedPlaneTiltPoint & { z?: number };
type ProjectedPlaneCenter3d = ProjectedPlaneTiltPoint & { z: number };

export interface ProjectedPlaneTiltWrap {
  tiltRad: number;
  clamped: boolean;
}

interface ProjectedPlaneTiltVectorWrap {
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
export const documentObjectProjectedPlaneTiltMaxDegrees = projectedPlaneTiltMaxDegrees;

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
// Coordinate-free SMILES need a little more room than hand-drawn/native structures. At the
// 22 px drawing default, a 15 px heteroatom label and a stereobond consume most of a fused-ring
// bond. A 28 px target keeps the normal line/font weights while giving generated polycycles the
// same open proportions users expect from a chemical depiction engine.
export const smilesPasteBondLengthPx = 28;
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

export function nativeAtomValidationState(
  atom: MoleculeAtom,
  bonds: readonly MoleculeBond[],
  effectiveFormalCharge = atom.formalCharge
): NativeAtomValidationState {
  const element = nativeElementFromAtomLabel(atom.element);
  // Unpaired electrons from associated radical marks occupy bonding slots like bonds do.
  const valenceUsed = nativeAtomBondOrderUsage(atom.id, bonds) + (atom.markRadicals ?? 0);

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

  if (nativeAtomFormalChargeForValence(element, valenceUsed) === undefined && !nativeAtomChargeSupportsValence(element, valenceUsed, effectiveFormalCharge)) {
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      valid: false,
      invalidReason: `${element} atom ${atom.id} has unsupported valence ${valenceUsed}.`
    };
  }

  if (!nativeAtomChargeSupportsValence(element, valenceUsed, effectiveFormalCharge)) {
    const expectedFormalCharge = nativeAtomSuggestedChargeForValence(element, valenceUsed);
    return {
      atomId: atom.id,
      element,
      valenceUsed,
      formalCharge: effectiveFormalCharge,
      ...(expectedFormalCharge === undefined ? {} : { expectedFormalCharge }),
      valid: false,
      invalidReason: expectedFormalCharge === undefined
        ? `${element} atom ${atom.id} has charge ${effectiveFormalCharge}, unsupported for valence ${valenceUsed}.`
        : `${element} atom ${atom.id} has charge ${effectiveFormalCharge}, expected ${expectedFormalCharge} for valence ${valenceUsed}.`
    };
  }

  return {
    atomId: atom.id,
    element,
    valenceUsed,
    formalCharge: effectiveFormalCharge,
    expectedFormalCharge: effectiveFormalCharge,
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

export interface NativeChainAnchor {
  objectId: string;
  atomId: string;
}

export interface NativeChainToolOptions {
  /**
   * Skip the chemistry derivation for a frame the user is still dragging.
   *
   * SMILES and the chemistry metadata are derived from the *whole* molecule, so re-deriving them on
   * every pointermove makes a drag quadratic in the size of the molecule being extended — a chain
   * pulled off a 300-atom structure re-walks all 300 atoms per frame. Nothing on screen reads those
   * fields; the renderer draws atoms and bonds. The commit at the end of the gesture runs without
   * this flag and derives once, so what lands in the document is always fully derived.
   */
  preview?: boolean;
}

/** Backstop for a drag with no page bounds; a full-page chain is far shorter than this. */
const maxNativeChainSegments = 200;

/** Zig-zag chain vertex plan. The press point is the first vertex; the drag vector sets the chain
 *  axis, and segment count comes from the drag length divided by the per-segment reach
 *  (bondLength × cos of the half zig-zag angle). No drag (or a sub-threshold drag) yields one
 *  segment. Segment directions alternate ±(180 − chainAngleDegrees)/2 about the axis so consecutive
 *  bonds meet at the style's chain angle. */
export function planNativeChainVertices(input: {
  start: PagePoint;
  dragPoint?: PagePoint;
  bondLengthPx: number;
  chainAngleDegrees: number;
  /** When given, the walk stops rather than stepping off the page. */
  pageBounds?: { width: number; height: number };
}): PagePoint[] {
  const segmentLength = Math.max(8, input.bondLengthPx);
  const halfRadians = degreesToRadians((180 - clamp(input.chainAngleDegrees, 1, 179)) / 2);
  const reachPerSegment = segmentLength * Math.cos(halfRadians);
  const dx = (input.dragPoint?.x ?? input.start.x + reachPerSegment) - input.start.x;
  const dy = (input.dragPoint?.y ?? input.start.y) - input.start.y;
  const dragLength = Math.hypot(dx, dy);
  const axisAngle = dragLength < 1e-6 ? 0 : Math.atan2(dy, dx);
  const segmentCount = !input.dragPoint || dragLength < reachPerSegment * 0.75
    ? 1
    : Math.min(maxNativeChainSegments, Math.max(1, Math.round(dragLength / reachPerSegment)));

  const bounds = input.pageBounds;
  const inBounds = (point: PagePoint): boolean =>
    !bounds || (point.x >= 0 && point.y >= 0 && point.x <= bounds.width && point.y <= bounds.height);
  const step = (from: PagePoint, angle: number): PagePoint => ({
    x: from.x + Math.cos(angle) * segmentLength,
    y: from.y + Math.sin(angle) * segmentLength
  });

  // The zig-zag's first step is conventionally the "up" one. Near a page edge that single choice can
  // be the only thing out of bounds — a chain started just below the top margin would stop dead at
  // one vertex, which is a lone bond-less carbon rather than a chain. Start on whichever side fits.
  let phase = -1;
  if (!inBounds(step(input.start, axisAngle - halfRadians)) && inBounds(step(input.start, axisAngle + halfRadians))) {
    phase = 1;
  }

  const vertices: PagePoint[] = [{ x: input.start.x, y: input.start.y }];
  for (let index = 1; index <= segmentCount; index += 1) {
    const previous = vertices[index - 1];
    const next = step(previous, axisAngle + (index % 2 === 1 ? phase : -phase) * halfRadians);
    // Pointer capture keeps delivering moves well past the page edge; atoms placed out there are
    // unreachable and unprintable, so the chain simply stops at the boundary.
    if (!inBounds(next)) {
      break;
    }
    vertices.push(next);
  }
  return vertices;
}

/** Chain tool: press-drag draws an alkane zig-zag in one gesture. Anchored on an existing atom it
 *  appends carbons to that molecule using the molecule's own bond length and chain angle;
 *  otherwise it seeds a new native molecule from the synthetic preset. Pure — the caller previews
 *  with replacePresentDocument and commits once. */
export function applyNativeChainTool(
  document: ChemDraftDocument,
  startPoint: PagePoint,
  dragPoint?: PagePoint,
  anchor?: NativeChainAnchor,
  options: NativeChainToolOptions = {}
): ChemDraftDocument {
  const page = firstPage(document);

  if (anchor) {
    const molecule = page.objects.find((object): object is MoleculeObject =>
      object.id === anchor.objectId && object.type === "molecule" && isEditableNativeMoleculeGraph(object)
    );
    const sourceAtom = molecule?.atoms.find((atom) => atom.id === anchor.atomId);
    if (!molecule || !sourceAtom) {
      return document;
    }

    const style = nativeDrawingStyleFromObjectStyle(molecule.style);
    const vertices = planNativeChainVertices({
      start: { x: sourceAtom.x, y: sourceAtom.y },
      dragPoint,
      bondLengthPx: style.bondLengthPx,
      chainAngleDegrees: style.chainAngleDegrees,
      pageBounds: { width: page.width, height: page.height }
    });

    const current = appendNativeCarbonVertices(molecule, sourceAtom.id, vertices.slice(1), options.preview);
    if (!current) {
      return document;
    }

    return applyPatches(
      document,
      [
        { op: "updateObject", objectId: molecule.id, changes: current },
        { op: "setSelection", pageId: page.id, objectIds: [molecule.id] }
      ],
      { now: phase4Timestamp }
    );
  }

  const presetStyle = nativeDrawingStyleFromObjectStyle(stylePresetToObjectStyle(ChemDraftSyntheticStylePreset));
  const start = {
    x: clamp(startPoint.x, 0, page.width),
    y: clamp(startPoint.y, 0, page.height)
  };
  const vertices = planNativeChainVertices({
    start,
    dragPoint,
    bondLengthPx: presetStyle.bondLengthPx,
    chainAngleDegrees: presetStyle.chainAngleDegrees,
    pageBounds: { width: page.width, height: page.height }
  });
  if (vertices.length < 2) {
    // Every direction out of the press point left the page. A single vertex is not a chain — it is a
    // bond-less carbon the user never asked for, and one they would have to hunt down to delete.
    return document;
  }
  const atoms = vertices.map((vertex, index) => ({
    id: `atom_${String(index + 1).padStart(3, "0")}`,
    element: "C",
    x: vertex.x,
    y: vertex.y,
    formalCharge: 0
  } satisfies MoleculeAtom));
  const bonds = atoms.slice(1).map((atom, index) => ({
    id: `bond_${String(index + 1).padStart(3, "0")}`,
    fromAtomId: atoms[index].id,
    toAtomId: atom.id,
    order: "single" as const
  } satisfies MoleculeBond));
  const geometry = moleculeGeometryFromAtoms(atoms);
  const object = normalizeNativeMoleculeGeometry({
    id: nextObjectId(document, "mol_chain"),
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
      drawingPrimitive: "chain"
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

export function nativeArtToolForCommand(commandId: string): NativeArtToolDefinition | undefined {
  return nativeArtToolByCommandId.get(commandId);
}

export function nativeArtToolIsFreehand(commandId: string): boolean {
  return nativeArtToolForCommand(commandId)?.data.artPathKind === "freehand";
}

export function createNativeArtGraphicObject(
  document: ChemDraftDocument,
  point: PagePoint,
  commandId: string
): GraphicObject | undefined {
  const tool = nativeArtToolForCommand(commandId);
  if (!tool) {
    return undefined;
  }

  const page = firstPage(document);
  const x = clamp(point.x - tool.width / 2, 0, Math.max(0, page.width - tool.width));
  const y = clamp(point.y - tool.height / 2, 0, Math.max(0, page.height - tool.height));
  const { data: toolData, style: toolStyle } = nativeArrowStyleDefaultOverlay(tool, tool.data, tool.style);
  const data = nativeArtToolDataForPlacement(toolData, x, y);
  return {
    id: nextObjectId(document, `art_${tool.id}`),
    type: "graphic",
    x,
    y,
    width: tool.width,
    height: tool.height,
    rotation: 0,
    style: {
      ...toolStyle,
      source: "chemdraft-native-art",
      artToolCommandId: tool.commandId
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    graphicKind: tool.graphicKind,
    data: {
      ...data,
      artToolId: tool.id
    }
  };
}

export function createNativeFreehandGraphicObject(
  document: ChemDraftDocument,
  points: readonly GraphicFreehandPoint[],
  commandId: string
): GraphicObject | undefined {
  const tool = nativeArtToolForCommand(commandId);
  if (!tool || tool.data.artPathKind !== "freehand") {
    return undefined;
  }

  const cleanPoints = normalizeFreehandPoints(points);
  if (cleanPoints.length < 2) {
    return undefined;
  }

  const page = firstPage(document);
  const options = tool.data.freehandOptions ?? {};
  const bounds = nativeFreehandBounds(cleanPoints, options, page.width, page.height);
  const object = {
    id: nextObjectId(document, `art_${tool.id}`),
    type: "graphic",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    rotation: 0,
    style: {
      ...tool.style,
      source: "chemdraft-native-art",
      artToolCommandId: tool.commandId
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    graphicKind: tool.graphicKind,
    data: {
      ...tool.data,
      freehandPoints: cleanPoints,
      artToolId: tool.id
    }
  } satisfies GraphicObject;
  return {
    ...object,
    data: {
      ...object.data,
      ...createGraphicFreehandPathCache(object)
    }
  };
}

export function nativeFreehandStrokeDocument(
  document: ChemDraftDocument,
  points: readonly GraphicFreehandPoint[],
  commandId: string
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeFreehandGraphicObject(document, points, commandId);
  if (!object) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function createNativePolylineGraphicObject(
  document: ChemDraftDocument,
  points: readonly PagePoint[],
  commandId: string = "tool.art.polyline",
  options: { closed?: boolean } = {}
): GraphicObject | undefined {
  const tool = nativeArtToolForCommand(commandId);
  if (!tool || tool.data.artPathKind !== "polyline") {
    return undefined;
  }

  const cleanPoints = normalizePolylinePoints(points);
  if (cleanPoints.length < 2) {
    return undefined;
  }

  const page = firstPage(document);
  const bounds = nativePolylineBounds(cleanPoints, page.width, page.height, tool.style.strokeWidth);
  return {
    id: nextObjectId(document, `art_${tool.id}`),
    type: "graphic",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    rotation: 0,
    style: {
      ...tool.style,
      source: "chemdraft-native-art",
      artToolCommandId: tool.commandId
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    graphicKind: tool.graphicKind,
    data: {
      ...tool.data,
      artPathKind: "polyline",
      pathNodes: cleanPoints.map((point) => ({ point })),
      pathClosed: options.closed === true,
      artToolId: tool.id
    }
  };
}

export function nativePolylinePathDocument(
  document: ChemDraftDocument,
  points: readonly PagePoint[],
  commandId: string = "tool.art.polyline",
  options: { closed?: boolean } = {}
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativePolylineGraphicObject(document, points, commandId, options);
  if (!object) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function createNativeBezierGraphicObject(
  document: ChemDraftDocument,
  nodes: ReadonlyArray<NonNullable<GraphicObjectData["pathNodes"]>[number]>,
  commandId: string = "tool.art.pen",
  options: { closed?: boolean } = {}
): GraphicObject | undefined {
  const tool = nativeArtToolForCommand(commandId);
  if (!tool || tool.data.artPathKind !== "bezier") {
    return undefined;
  }

  const cleanNodes = normalizePathNodes(nodes);
  if (cleanNodes.length < 2) {
    return undefined;
  }

  const page = firstPage(document);
  const bounds = nativePathNodeBounds(cleanNodes, page.width, page.height, tool.style.strokeWidth);
  return {
    id: nextObjectId(document, `art_${tool.id}`),
    type: "graphic",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    rotation: 0,
    style: {
      ...tool.style,
      source: "chemdraft-native-art",
      artToolCommandId: tool.commandId
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    graphicKind: tool.graphicKind,
    data: {
      ...tool.data,
      artPathKind: "bezier",
      pathNodes: cleanNodes,
      pathClosed: options.closed === true,
      artToolId: tool.id
    }
  };
}

export function nativeBezierPathDocument(
  document: ChemDraftDocument,
  nodes: ReadonlyArray<NonNullable<GraphicObjectData["pathNodes"]>[number]>,
  commandId: string = "tool.art.pen",
  options: { closed?: boolean } = {}
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeBezierGraphicObject(document, nodes, commandId, options);
  if (!object) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

function nativeArtToolDataForPlacement(
  data: GraphicObjectData,
  x: number,
  y: number
): GraphicObjectData {
  if (!data.pathNodes) {
    return { ...data };
  }

  return {
    ...data,
    pathNodes: data.pathNodes.map((node) => ({
      point: offsetPagePoint(node.point, x, y),
      ...(node.inControl ? { inControl: offsetPagePoint(node.inControl, x, y) } : {}),
      ...(node.outControl ? { outControl: offsetPagePoint(node.outControl, x, y) } : {})
    }))
  };
}

function offsetPagePoint(point: PagePoint, x: number, y: number): PagePoint {
  return {
    x: point.x + x,
    y: point.y + y
  };
}

function normalizeFreehandPoints(points: readonly GraphicFreehandPoint[]): GraphicFreehandPoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: roundFreehandNumber(point.x),
      y: roundFreehandNumber(point.y),
      ...(typeof point.pressure === "number" && Number.isFinite(point.pressure)
        ? { pressure: roundFreehandNumber(clamp(point.pressure, 0, 1)) }
        : {})
    }));
}

function normalizePolylinePoints(points: readonly PagePoint[]): PagePoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .reduce<PagePoint[]>((normalized, point) => {
      const next = {
        x: roundFreehandNumber(point.x),
        y: roundFreehandNumber(point.y)
      };
      const previous = normalized[normalized.length - 1];
      if (!previous || Math.hypot(previous.x - next.x, previous.y - next.y) >= 0.75) {
        normalized.push(next);
      }
      return normalized;
    }, []);
}

function normalizePathNodes(
  nodes: ReadonlyArray<NonNullable<GraphicObjectData["pathNodes"]>[number]>
): NonNullable<GraphicObjectData["pathNodes"]> {
  return nodes
    .filter((node) => Number.isFinite(node.point.x) && Number.isFinite(node.point.y))
    .reduce<NonNullable<GraphicObjectData["pathNodes"]>>((normalized, node) => {
      const point = roundPagePoint(node.point);
      const previous = normalized[normalized.length - 1];
      if (previous && Math.hypot(previous.point.x - point.x, previous.point.y - point.y) < 0.75) {
        return normalized;
      }

      normalized.push({
        point,
        ...(finitePoint(node.inControl) ? { inControl: roundPagePoint(node.inControl) } : {}),
        ...(finitePoint(node.outControl) ? { outControl: roundPagePoint(node.outControl) } : {})
      });
      return normalized;
    }, []);
}

function finitePoint(point: PagePoint | undefined): point is PagePoint {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function roundPagePoint(point: PagePoint): PagePoint {
  return {
    x: roundFreehandNumber(point.x),
    y: roundFreehandNumber(point.y)
  };
}

function nativePathNodeBounds(
  nodes: ReadonlyArray<NonNullable<GraphicObjectData["pathNodes"]>[number]>,
  pageWidth: number,
  pageHeight: number,
  strokeWidth: GraphicObjectStyle["strokeWidth"]
): PageRect {
  return nativeBoundsForPagePoints(
    nodes.flatMap((node) => [node.point, node.inControl, node.outControl]).filter((point): point is PagePoint => point !== undefined),
    pageWidth,
    pageHeight,
    strokeWidth
  );
}

function nativePolylineBounds(
  points: readonly PagePoint[],
  pageWidth: number,
  pageHeight: number,
  strokeWidth: GraphicObjectStyle["strokeWidth"]
): PageRect {
  return nativeBoundsForPagePoints(points, pageWidth, pageHeight, strokeWidth);
}

function nativeBoundsForPagePoints(
  points: readonly PagePoint[],
  pageWidth: number,
  pageHeight: number,
  strokeWidth: GraphicObjectStyle["strokeWidth"]
): PageRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const numericStrokeWidth = typeof strokeWidth === "number" && Number.isFinite(strokeWidth) ? strokeWidth : 2;
  const padding = Math.max(6, numericStrokeWidth * 2);
  const x = clamp(minX - padding, 0, Math.max(0, pageWidth - 1));
  const y = clamp(minY - padding, 0, Math.max(0, pageHeight - 1));
  const right = clamp(maxX + padding, x + 1, pageWidth);
  const bottom = clamp(maxY + padding, y + 1, pageHeight);
  return {
    x: roundFreehandNumber(x),
    y: roundFreehandNumber(y),
    width: roundFreehandNumber(right - x),
    height: roundFreehandNumber(bottom - y)
  };
}

function nativeFreehandBounds(
  points: readonly GraphicFreehandPoint[],
  options: GraphicFreehandOptions,
  pageWidth: number,
  pageHeight: number
): { x: number; y: number; width: number; height: number } {
  const size = typeof options.size === "number" && Number.isFinite(options.size) ? options.size : 8;
  const thinning = typeof options.thinning === "number" && Number.isFinite(options.thinning) ? Math.abs(options.thinning) : 0.5;
  const padding = Math.max(8, size * (1 + thinning) * 0.75);
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const x = clamp(minX - padding, 0, Math.max(0, pageWidth - 1));
  const y = clamp(minY - padding, 0, Math.max(0, pageHeight - 1));
  const right = clamp(maxX + padding, x + 1, pageWidth);
  const bottom = clamp(maxY + padding, y + 1, pageHeight);
  return {
    x: roundFreehandNumber(x),
    y: roundFreehandNumber(y),
    width: roundFreehandNumber(right - x),
    height: roundFreehandNumber(bottom - y)
  };
}

function roundFreehandNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function insertNativeArtGraphicObject(
  document: ChemDraftDocument,
  point: PagePoint,
  commandId: string
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeArtGraphicObject(document, point, commandId);
  if (!object) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

/** Default length of a click-placed (undragged) art line/arrow, in page units. Matches the reaction
 *  arrow default so a plain click drops a sensible horizontal arrow rather than a zero-length dot. */
export const nativeArtLineDefaultLengthPx = 120;

/** The arrow-family art tools — the ones "Set as Default Arrow Style" applies to. */
const nativeArrowStyleToolIds = new Set<NativeArtToolId>([
  "arrow",
  "reactionArrow",
  "reactionArrowBold",
  "reactionArrowDashed",
  "resonanceArrow",
  "equilibriumArrow",
  "retroArrow",
  "curvedArrow90",
  "curvedArrow180",
  "fishhookArrow",
  "fishhookCurved",
  "noReactionArrow"
]);

/**
 * The reusable parts of an arrow's look — everything "Set as Default Arrow Style" carries from a
 * right-clicked arrow onto every subsequent one drawn with the same tool. Geometry that the draw
 * gesture itself decides (endpoints, length, angle) is deliberately absent; the bow is stored as a
 * signed fraction of the length so a curved default bends new arrows proportionally at any size.
 */
export interface NativeArrowStyleDefault {
  markerStartSizePx?: number;
  markerEndSizePx?: number;
  dualShaftScale?: number;
  dualShaftForwardFrac?: number;
  dualShaftReverseFrac?: number;
  arcSweepRadians?: number;
  bowFrac?: number;
  strokeColor?: string;
  strokeWidth?: number;
  /** Three states, because a tool can ship a dashed base style: absent = "not captured, keep the
   *  tool's own dash", a string = that dash, and `null` = explicitly solid, which must CLEAR the
   *  tool's base dash. Without the null case, making a dashed arrow solid and saving it as the
   *  default was unrepresentable and the next arrow came back dashed. */
  strokeDasharray?: string | null;
}

/** Per-tool "draw new arrows like this" defaults. Session state seeded from persistence by the main
 *  window; consulted by the art-object constructors so every creation path picks them up. */
const nativeArrowStyleDefaults = new Map<NativeArtToolId, NativeArrowStyleDefault>();

export function setNativeArrowStyleDefault(toolId: NativeArtToolId, style: NativeArrowStyleDefault): void {
  nativeArrowStyleDefaults.set(toolId, style);
}

export function loadNativeArrowStyleDefaults(record: Readonly<Record<string, NativeArrowStyleDefault>>): void {
  for (const [toolId, style] of Object.entries(record)) {
    if (nativeArrowStyleToolIds.has(toolId as NativeArtToolId) && style && typeof style === "object") {
      nativeArrowStyleDefaults.set(toolId as NativeArtToolId, style);
    }
  }
}

export function nativeArrowStyleDefaultsSnapshot(): Record<string, NativeArrowStyleDefault> {
  return Object.fromEntries(nativeArrowStyleDefaults);
}

export function clearNativeArrowStyleDefaults(): void {
  nativeArrowStyleDefaults.clear();
}

/** The arrow-family tool ids as a stable list, for exhaustive tests and UI enumerations. */
export const nativeArrowStyleToolIdList: readonly NativeArtToolId[] = [...nativeArrowStyleToolIds];

/** The arrow-family tool id a graphic was drawn with, or undefined for non-arrow graphics. The one
 *  membership check for "is this an arrow" — the style-default capture and the selection classifier
 *  both key off it. */
export function nativeArrowToolIdForGraphic(object: DocumentObject): NativeArtToolId | undefined {
  if (object.type !== "graphic") {
    return undefined;
  }
  const toolId = object.data.artToolId as NativeArtToolId | undefined;
  return toolId && nativeArrowStyleToolIds.has(toolId) ? toolId : undefined;
}

/** True when the graphic was drawn with one of the twelve arrow tools. */
export function isNativeArrowGraphic(object: DocumentObject): boolean {
  return nativeArrowToolIdForGraphic(object) !== undefined;
}

/** Object types present in the current selection, for routing a command (or a selection-aware
 *  widget) to a surface that can edit them. */
export function selectedDocumentObjectTypes(document: ChemDraftDocument): ReadonlySet<DocumentObject["type"]> {
  const selectedIds = new Set(document.selection.objectIds);
  const types = new Set<DocumentObject["type"]>();
  if (selectedIds.size === 0) {
    return types;
  }
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (selectedIds.has(object.id)) {
        types.add(object.type);
      }
    }
  }
  return types;
}

/**
 * Read a right-clicked arrow's reusable style, or undefined when the object isn't an arrow. Captures
 * only what the object actually expresses: marker sizes it has, dual-shaft heft and half-lengths, an
 * arc's sweep, a bent line's bow, and explicit stroke styling.
 */
export function nativeArrowStyleDefaultFromGraphic(
  object: DocumentObject
): { toolId: NativeArtToolId; title: string; style: NativeArrowStyleDefault } | undefined {
  if (object.type !== "graphic") {
    return undefined;
  }
  const toolId = nativeArrowToolIdForGraphic(object);
  if (!toolId) {
    return undefined;
  }
  const tool = nativeArtToolDefinitions.find((definition) => definition.id === toolId);
  if (!tool) {
    return undefined;
  }

  const style: NativeArrowStyleDefault = {};
  const markerStartSize = object.data.markerStart?.sizePx;
  const markerEndSize = object.data.markerEnd?.sizePx;
  if (typeof markerStartSize === "number") {
    style.markerStartSizePx = markerStartSize;
  }
  if (typeof markerEndSize === "number") {
    style.markerEndSizePx = markerEndSize;
  }
  if (object.data.dualShaft === true) {
    if (typeof object.data.dualShaftScale === "number") {
      style.dualShaftScale = object.data.dualShaftScale;
    }
    if (object.data.dualShaftParallel !== true) {
      if (typeof object.data.dualShaftForwardFrac === "number") {
        style.dualShaftForwardFrac = object.data.dualShaftForwardFrac;
      }
      if (typeof object.data.dualShaftReverseFrac === "number") {
        style.dualShaftReverseFrac = object.data.dualShaftReverseFrac;
      }
    }
  }
  if (object.data.artPathKind === "arc" && typeof object.data.arcSweepRadians === "number") {
    style.arcSweepRadians = object.data.arcSweepRadians;
  }
  const bow = nativeArrowBowFraction(object);
  if (bow !== undefined) {
    style.bowFrac = bow;
  }
  if (typeof object.style.strokeColor === "string") {
    style.strokeColor = object.style.strokeColor;
  }
  if (typeof object.style.strokeWidth === "number") {
    style.strokeWidth = object.style.strokeWidth;
  }
  // Capture solid explicitly (null) rather than omitting it, so "make this dashed tool draw solid
  // arrows from now on" is expressible; omission still means "keep whatever the tool draws".
  style.strokeDasharray = typeof object.style.strokeDasharray === "string"
    ? object.style.strokeDasharray
    : null;

  return { toolId, title: tool.title, style };
}

/** A bent line's bow: the control point's signed perpendicular offset at the midpoint, as a fraction
 *  of the length — transplantable onto a new arrow of any length or angle. */
function nativeArrowBowFraction(object: GraphicObject): number | undefined {
  if (object.data.artPathKind !== "quadratic") {
    return undefined;
  }
  const start = object.data.lineStart;
  const end = object.data.lineEnd;
  const control = object.data.pathControlPoint;
  if (!start || !end || !control) {
    return undefined;
  }
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 1) {
    return undefined;
  }
  const axis = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const normal = { x: axis.y, y: -axis.x };
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return ((control.x - mid.x) * normal.x + (control.y - mid.y) * normal.y) / length;
}

/** Overlay a tool's stored default style onto freshly built creation data + style. */
function nativeArrowStyleDefaultOverlay(
  tool: NativeArtToolDefinition,
  data: GraphicObjectData,
  style: GraphicObjectStyle
): { data: GraphicObjectData; style: GraphicObjectStyle } {
  const stored = nativeArrowStyleDefaults.get(tool.id);
  if (!stored) {
    return { data, style };
  }

  const nextData: GraphicObjectData = { ...data };
  // Marker sizes only resize heads the tool already draws — a default never adds or removes one.
  if (typeof stored.markerStartSizePx === "number" && nextData.markerStart) {
    nextData.markerStart = { ...nextData.markerStart, sizePx: stored.markerStartSizePx };
  }
  if (typeof stored.markerEndSizePx === "number" && nextData.markerEnd) {
    nextData.markerEnd = { ...nextData.markerEnd, sizePx: stored.markerEndSizePx };
  }
  if (nextData.dualShaft === true) {
    if (typeof stored.dualShaftScale === "number") {
      nextData.dualShaftScale = stored.dualShaftScale;
    }
    if (nextData.dualShaftParallel !== true) {
      if (typeof stored.dualShaftForwardFrac === "number") {
        nextData.dualShaftForwardFrac = stored.dualShaftForwardFrac;
      }
      if (typeof stored.dualShaftReverseFrac === "number") {
        nextData.dualShaftReverseFrac = stored.dualShaftReverseFrac;
      }
    }
  }
  if (nextData.artPathKind === "arc" && typeof stored.arcSweepRadians === "number") {
    nextData.arcSweepRadians = stored.arcSweepRadians;
  }

  const nextStyle: GraphicObjectStyle = { ...style };
  if (typeof stored.strokeColor === "string") {
    nextStyle.strokeColor = stored.strokeColor;
  }
  if (typeof stored.strokeWidth === "number") {
    nextStyle.strokeWidth = stored.strokeWidth;
  }
  if (typeof stored.strokeDasharray === "string") {
    nextStyle.strokeDasharray = stored.strokeDasharray;
  } else if (stored.strokeDasharray === null) {
    // Explicitly solid: clear the tool's base dash instead of leaving it in place.
    delete nextStyle.strokeDasharray;
  }

  return { data: nextData, style: nextStyle };
}

/** Line-family art tools (straight and wavy lines, plain/reaction/resonance arrows) draw between two
 *  endpoints, so — like bonds and reaction arrows — they support press-drag-release placement rather
 *  than plopping a fixed box. Arc/quadratic/bezier/polyline/freehand tools are excluded. */
export function nativeArtToolIsLineDraw(commandId: string): boolean {
  const kind = nativeArtToolForCommand(commandId)?.data.artPathKind;
  return kind === "line" || kind === "wavy";
}

/** Arrow-mode in-place editing applies to line-draw tools and to arrow-family arcs (curved pushing /
 *  fishhook arrows — arcs that carry an arrowhead marker). Plain arcs and shapes are excluded. */
export function nativeArtToolSupportsArrowHoverEdit(commandId: string): boolean {
  if (nativeArtToolIsLineDraw(commandId)) {
    return true;
  }
  const tool = nativeArtToolForCommand(commandId);
  return tool?.data.artPathKind === "arc" &&
    (tool.data.markerStart !== undefined || tool.data.markerEnd !== undefined);
}

/** Build a line-family art graphic with explicit endpoints. The bounding box encloses both ends plus
 *  padding for stroke + arrowhead so selection/hit-testing stay honest; `lineStart`/`lineEnd` make the
 *  arrow immediately editable (drag ends, curve the middle) and let the CDXML layer read its geometry. */
export function createNativeArtLineGraphicObject(
  document: ChemDraftDocument,
  start: PagePoint,
  end: PagePoint,
  commandId: string
): GraphicObject | undefined {
  const tool = nativeArtToolForCommand(commandId);
  if (!tool || !nativeArtToolIsLineDraw(commandId)) {
    return undefined;
  }

  const page = firstPage(document);
  const clampedStart = {
    x: clamp(start.x, 0, page.width),
    y: clamp(start.y, 0, page.height)
  };
  const clampedEnd = {
    x: clamp(end.x, 0, page.width),
    y: clamp(end.y, 0, page.height)
  };
  const { data: toolData, style: toolStyle } = nativeArrowStyleDefaultOverlay(tool, tool.data, tool.style);

  // A stored bow default bends the new arrow proportionally: same signed fraction of its length.
  const bowFrac = nativeArrowStyleDefaults.get(tool.id)?.bowFrac;
  const bowData: GraphicObjectData = {};
  if (typeof bowFrac === "number" && toolData.artPathKind === "line" && toolData.dualShaft !== true) {
    const length = Math.hypot(clampedEnd.x - clampedStart.x, clampedEnd.y - clampedStart.y);
    if (length >= 1 && Math.abs(bowFrac) > 0.001) {
      const axis = { x: (clampedEnd.x - clampedStart.x) / length, y: (clampedEnd.y - clampedStart.y) / length };
      const normal = { x: axis.y, y: -axis.x };
      bowData.artPathKind = "quadratic";
      bowData.pathControlPoint = {
        x: (clampedStart.x + clampedEnd.x) / 2 + normal.x * bowFrac * length,
        y: (clampedStart.y + clampedEnd.y) / 2 + normal.y * bowFrac * length
      };
    }
  }

  const strokeWidth = typeof toolStyle.strokeWidth === "number" ? toolStyle.strokeWidth : 2;
  const markerSize = Math.max(toolData.markerStart?.sizePx ?? 0, toolData.markerEnd?.sizePx ?? 0);
  const padding = Math.max(8, strokeWidth * 2 + markerSize);
  const boxPoints = [clampedStart, clampedEnd, ...(bowData.pathControlPoint ? [bowData.pathControlPoint] : [])];
  const minX = Math.min(...boxPoints.map((point) => point.x)) - padding;
  const minY = Math.min(...boxPoints.map((point) => point.y)) - padding;
  const maxX = Math.max(...boxPoints.map((point) => point.x)) + padding;
  const maxY = Math.max(...boxPoints.map((point) => point.y)) + padding;

  return {
    id: nextObjectId(document, `art_${tool.id}`),
    type: "graphic",
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    rotation: 0,
    style: {
      ...toolStyle,
      source: "chemdraft-native-art",
      artToolCommandId: tool.commandId
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    graphicKind: tool.graphicKind,
    data: {
      ...toolData,
      lineStart: { x: clampedStart.x, y: clampedStart.y },
      lineEnd: { x: clampedEnd.x, y: clampedEnd.y },
      ...bowData,
      artToolId: tool.id
    }
  };
}

/** Insert a line-family art graphic spanning `start`→`end` and select it. */
export function applyNativeArtLineToolAtPoint(
  document: ChemDraftDocument,
  start: PagePoint,
  end: PagePoint,
  commandId: string
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeArtLineGraphicObject(document, start, end, commandId);
  if (!object) {
    return document;
  }

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

/** Click (no drag) placement: drop a default-length horizontal arrow with the press point as the tail. */
export function applyNativeArtLineToolDefaultAtPoint(
  document: ChemDraftDocument,
  point: PagePoint,
  commandId: string
): ChemDraftDocument {
  const page = firstPage(document);
  const startX = clamp(point.x, 0, Math.max(0, page.width - nativeArtLineDefaultLengthPx));
  const y = clamp(point.y, 0, page.height);
  return applyNativeArtLineToolAtPoint(
    document,
    { x: startX, y },
    { x: startX + nativeArtLineDefaultLengthPx, y },
    commandId
  );
}

export function nativeGraphicPathEditPoints(object: GraphicObject): NativeGraphicPathEditPoints | undefined {
  return graphicPathEditPoints(object);
}

export function nativeGraphicPathNodeEditPoints(object: GraphicObject): NativeGraphicPathNodeEditPoints | undefined {
  return graphicPathNodeEditPoints(object);
}

export function nativeGraphicCornerRadiusEditPoint(
  object: GraphicObject
): NativeGraphicCornerRadiusEditPoint | undefined {
  return graphicCornerRadiusEditPoint(object);
}

export type NativeGraphicLinearGradientHandleId = "start" | "end";
export type NativeGraphicRadialGradientHandleId = "center" | "radius" | "focus";
export type NativeGraphicGradientHandleId = NativeGraphicLinearGradientHandleId | NativeGraphicRadialGradientHandleId;

export interface NativeGraphicLinearGradientHandlePoints {
  start: NativeArtPoint;
  end: NativeArtPoint;
}

export interface NativeGraphicRadialGradientHandlePoints {
  center: NativeArtPoint;
  radius: NativeArtPoint;
  focus?: NativeArtPoint;
  radiusPx: number;
}

export function nativeGraphicLinearGradientHandlePoints(
  object: NativePaintObject,
  target: GraphicStylePaintTarget
): NativeGraphicLinearGradientHandlePoints | undefined {
  if (!nativePaintObjectSupportsTarget(object, target)) {
    return undefined;
  }

  const paint = nativePaintForObject(object, target);
  if (paint.kind !== "linear-gradient") {
    return undefined;
  }

  return {
    start: {
      x: clampWorkflowUnit(paint.x1) * object.width,
      y: clampWorkflowUnit(paint.y1) * object.height
    },
    end: {
      x: clampWorkflowUnit(paint.x2) * object.width,
      y: clampWorkflowUnit(paint.y2) * object.height
    }
  };
}

export function nativeGraphicRadialGradientHandlePoints(
  object: NativePaintObject,
  target: GraphicStylePaintTarget
): NativeGraphicRadialGradientHandlePoints | undefined {
  if (!nativePaintObjectSupportsTarget(object, target)) {
    return undefined;
  }

  const paint = nativePaintForObject(object, target);
  if (paint.kind !== "radial-gradient") {
    return undefined;
  }

  const center = {
    x: clampWorkflowUnit(paint.cx) * object.width,
    y: clampWorkflowUnit(paint.cy) * object.height
  };
  const radiusPx = Math.max(0, Number.isFinite(paint.r) ? paint.r : 0) * Math.max(object.width, object.height, 1);
  return {
    center,
    radius: {
      x: center.x + radiusPx,
      y: center.y
    },
    focus: typeof paint.fx === "number" && typeof paint.fy === "number"
      ? {
          x: clampWorkflowUnit(paint.fx) * object.width,
          y: clampWorkflowUnit(paint.fy) * object.height
        }
      : undefined,
    radiusPx
  };
}

export function updateNativeGraphicPathHandle(
  document: ChemDraftDocument,
  objectId: string,
  handle: NativeGraphicPathEditHandle,
  point: PagePoint
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (!object || object.type !== "graphic") {
    return document;
  }

  const edited = editGraphicPathGeometry(object, handle, point);
  if (!edited || edited === object) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: edited
    },
    { now: phase4Timestamp }
  );
}

export function deleteNativeGraphicPathNode(
  document: ChemDraftDocument,
  objectId: string,
  nodeIndex: number
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  const nodes = object?.type === "graphic" ? object.data.pathNodes : undefined;
  if (
    object?.type !== "graphic" ||
    !Array.isArray(nodes) ||
    !Number.isInteger(nodeIndex) ||
    nodeIndex < 0 ||
    nodeIndex >= nodes.length
  ) {
    return document;
  }

  if (nodes.length <= 2) {
    return applyPatch(
      document,
      { op: "removeObject", objectId },
      { now: phase4Timestamp }
    );
  }

  const edited = deleteGraphicPathNode(object, nodeIndex);
  if (!edited || edited === object) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: edited
    },
    { now: phase4Timestamp }
  );
}

export function deleteNativeGraphicPathSegment(
  document: ChemDraftDocument,
  objectId: string,
  segmentIndex: number
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  const nodes = object?.type === "graphic" ? object.data.pathNodes : undefined;
  const pathClosed = object?.type === "graphic" && object.data.pathClosed === true;
  const segmentCount = Array.isArray(nodes)
    ? pathClosed ? nodes.length : nodes.length - 1
    : 0;
  if (
    object?.type !== "graphic" ||
    !Array.isArray(nodes) ||
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 ||
    segmentIndex >= segmentCount
  ) {
    return document;
  }

  if (nodes.length <= 2) {
    return applyPatch(
      document,
      { op: "removeObject", objectId },
      { now: phase4Timestamp }
    );
  }

  const edited = deleteGraphicPathSegment(object, segmentIndex);
  if (!edited || edited === object) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: edited
    },
    { now: phase4Timestamp }
  );
}

export function splitNativeGraphicPathSegmentAtPoint(
  document: ChemDraftDocument,
  objectId: string,
  point: PagePoint,
  options: { maxDistancePx?: number } = {}
): NativeGraphicPathSegmentSplit | undefined {
  const page = firstPage(document);
  const object = findDocumentObject(document, objectId);
  if (object?.type !== "graphic") {
    return undefined;
  }

  const split = splitGraphicPathSegmentAtPoint(object, point, options);
  if (!split) {
    return undefined;
  }

  return {
    document: applyPatches(
      document,
      [
        { op: "updateObject", objectId, changes: split.object },
        { op: "setSelection", pageId: page.id, objectIds: [objectId] }
      ],
      { now: phase4Timestamp }
    ),
    segmentIndex: split.segmentIndex,
    point: split.point,
    distance: split.distance
  };
}

export function updateNativeGraphicMarkerHandle(
  document: ChemDraftDocument,
  objectId: string,
  markerId: NativeGraphicMarkerHandleId,
  point: PagePoint,
  options: { symmetric?: boolean } = {}
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (!object || object.type !== "graphic") {
    return document;
  }

  const edited = editGraphicMarkerSize(object, markerId, point, options);
  if (!edited || edited === object) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: edited
    },
    { now: phase4Timestamp }
  );
}

export function prepareGraphicPathForDirectEdit(
  document: ChemDraftDocument,
  objectId: string
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (!object || object.type !== "graphic") {
    return document;
  }

  const prepared = prepareGraphicPathObjectForDirectEdit(object);
  if (prepared === object) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: prepared
    },
    { now: phase4Timestamp }
  );
}

export function updateNativeGraphicCornerRadius(
  document: ChemDraftDocument,
  objectId: string,
  point: PagePoint
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (!object || object.type !== "graphic") {
    return document;
  }

  const edited = editGraphicCornerRadius(object, point);
  if (!edited || edited === object) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: edited
    },
    { now: phase4Timestamp }
  );
}

export function updateNativeGraphicLinearGradientHandle(
  document: ChemDraftDocument,
  objectId: string,
  target: GraphicStylePaintTarget,
  handle: NativeGraphicLinearGradientHandleId,
  point: PagePoint
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (
    !object ||
    (object.type !== "graphic" && object.type !== "molecule") ||
    !nativePaintObjectSupportsTarget(object, target)
  ) {
    return document;
  }

  const paint = nativePaintForObject(object, target);
  if (paint.kind !== "linear-gradient") {
    return document;
  }

  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const nextX = clampWorkflowUnit(point.x / width);
  const nextY = clampWorkflowUnit(point.y / height);
  const nextPaint = handle === "start"
    ? { ...paint, x1: nextX, y1: nextY }
    : { ...paint, x2: nextX, y2: nextY };
  if (
    nextPaint.x1 === paint.x1 &&
    nextPaint.y1 === paint.y1 &&
    nextPaint.x2 === paint.x2 &&
    nextPaint.y2 === paint.y2
  ) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        style: nativePaintStyleForObject(object, target, nextPaint)
      }
    },
    { now: phase4Timestamp }
  );
}

export function updateNativeGraphicRadialGradientHandle(
  document: ChemDraftDocument,
  objectId: string,
  target: GraphicStylePaintTarget,
  handle: NativeGraphicRadialGradientHandleId,
  point: PagePoint
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (
    !object ||
    (object.type !== "graphic" && object.type !== "molecule") ||
    !nativePaintObjectSupportsTarget(object, target)
  ) {
    return document;
  }

  const paint = nativePaintForObject(object, target);
  if (paint.kind !== "radial-gradient") {
    return document;
  }

  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const maxDimension = Math.max(width, height, 1);
  const nextX = clampWorkflowUnit(point.x / width);
  const nextY = clampWorkflowUnit(point.y / height);
  const center = {
    x: paint.cx * width,
    y: paint.cy * height
  };
  const nextPaint = handle === "center"
    ? { ...paint, cx: nextX, cy: nextY }
    : handle === "focus"
      ? { ...paint, fx: nextX, fy: nextY }
      : {
          ...paint,
          r: Math.max(0, Math.hypot(point.x - center.x, point.y - center.y) / maxDimension)
        };
  if (
    nextPaint.cx === paint.cx &&
    nextPaint.cy === paint.cy &&
    nextPaint.r === paint.r &&
    nextPaint.fx === paint.fx &&
    nextPaint.fy === paint.fy
  ) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        style: nativePaintStyleForObject(object, target, nextPaint)
      }
    },
    { now: phase4Timestamp }
  );
}

export function applyDocumentObjectProjectedPlaneTilt(
  document: ChemDraftDocument,
  objectId: string,
  tiltXDegrees: number,
  tiltYDegrees: number
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (!object || object.type === "molecule") {
    return document;
  }

  const nextTiltX = normalizeDocumentObjectProjectedPlaneTiltDegrees(tiltXDegrees) ?? 0;
  const nextTiltY = normalizeDocumentObjectProjectedPlaneTiltDegrees(tiltYDegrees) ?? 0;
  if (
    object.style.tiltXDegrees === nextTiltX &&
    object.style.tiltYDegrees === nextTiltY
  ) {
    return document;
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        style: {
          ...object.style,
          tiltXDegrees: nextTiltX,
          tiltYDegrees: nextTiltY
        }
      }
    },
    { now: phase4Timestamp }
  );
}

export function documentObjectProjectedPlaneTilt(object: DocumentObject): { tiltXDegrees: number; tiltYDegrees: number } {
  return {
    tiltXDegrees: typeof object.style.tiltXDegrees === "number" && Number.isFinite(object.style.tiltXDegrees)
      ? object.style.tiltXDegrees
      : 0,
    tiltYDegrees: typeof object.style.tiltYDegrees === "number" && Number.isFinite(object.style.tiltYDegrees)
      ? object.style.tiltYDegrees
      : 0
  };
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

  const vertexCandidates = nativeRingVertexCandidatesForSharedBond(molecule, fromAtom, toAtom, point, size);
  if (vertexCandidates.length === 0) {
    return undefined;
  }

  for (const vertices of vertexCandidates) {
    const fused = fuseNativeTemplateRingVerticesToBond(molecule, targetBond, fromAtom, toAtom, vertices, templateId);
    if (fused) {
      return fused;
    }
  }

  return undefined;
}

function fuseNativeTemplateRingVerticesToBond(
  molecule: MoleculeObject,
  targetBond: MoleculeBond,
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  vertices: readonly PagePoint[],
  templateId: NativeMoleculeTemplateId
): MoleculeObject | undefined {
  const size = nativeTemplateRingSize(templateId);

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

  if (newAtoms.length === 0 && newBonds.length === 0) {
    return undefined;
  }

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

function refreshNativeCyclicDoubleBondSides(molecule: MoleculeObject): MoleculeObject {
  const cycles = findNativeCarbonRingCycles(molecule, new Set([5, 6]));
  if (cycles.length === 0) {
    return molecule;
  }

  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const cyclesByBondId = new Map<string, NativeAromaticRingCycle[]>();
  cycles.forEach((cycle) => {
    cycle.bondIds.forEach((bondId) => {
      cyclesByBondId.set(bondId, [...(cyclesByBondId.get(bondId) ?? []), cycle]);
    });
  });

  let changed = false;
  const bonds = molecule.bonds.map((bond) => {
    if (bond.order !== "double") {
      return bond;
    }

    const owningCycles = cyclesByBondId.get(bond.id) ?? [];
    const fromAtom = atomById.get(bond.fromAtomId);
    const toAtom = atomById.get(bond.toAtomId);
    if (owningCycles.length === 0 || !fromAtom || !toAtom) {
      return bond;
    }

    const currentSide = bond.display?.doubleBondSide;
    const cycle =
      owningCycles.find((candidate) => doubleBondSideTowardPoint(fromAtom, toAtom, candidate.center) === currentSide)
      ?? owningCycles[0];
    if (!cycle) {
      return bond;
    }

    const side = doubleBondSideTowardPoint(fromAtom, toAtom, cycle.center);
    if (currentSide === side) {
      return bond;
    }

    changed = true;
    return nativeBondWithOrderAndDoubleSide(bond, "double", side);
  });

  return changed ? { ...molecule, bonds } : molecule;
}

function findNativeSixMemberCarbonRingCycles(molecule: MoleculeObject): NativeAromaticRingCycle[] {
  return findNativeCarbonRingCycles(molecule, new Set([6]));
}

function findNativeCarbonRingCycles(
  molecule: MoleculeObject,
  ringSizes: ReadonlySet<number>
): NativeAromaticRingCycle[] {
  const targetSizes = [...ringSizes].filter((size) => Number.isInteger(size) && size >= 3).sort((a, b) => a - b);
  const maxRingSize = targetSizes[targetSizes.length - 1];
  if (maxRingSize === undefined) {
    return [];
  }

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
    if (ringSizes.has(atomIds.length)) {
      const closingBond = (adjacency.get(atomId) ?? []).find((edge) => edge.atomId === startAtomId);
      if (closingBond) {
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
      }
    }

    if (atomIds.length >= maxRingSize) {
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

function nativeRingVertexCandidatesForSharedBond(
  molecule: MoleculeObject,
  fromAtom: MoleculeAtom,
  toAtom: MoleculeAtom,
  point: PagePoint,
  size: number
): PagePoint[][] {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [];
  }

  const unit = { x: dx / length, y: dy / length };
  const normal = { x: -unit.y, y: unit.x };
  const midpoint = { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };
  const apothem = length / (2 * Math.tan(Math.PI / size));
  const radius = length / (2 * Math.sin(Math.PI / size));
  const step = Math.PI * 2 / size;
  const clickScore = (point.x - midpoint.x) * normal.x + (point.y - midpoint.y) * normal.y;
  const clickSide: 1 | -1 = clickScore >= 0 ? 1 : -1;
  const excludedAtomIds = new Set([fromAtom.id, toAtom.id]);
  const candidates = ([1, -1] as const).map((side) => {
    const center = {
      x: midpoint.x + normal.x * side * apothem,
      y: midpoint.y + normal.y * side * apothem
    };
    const angleFrom = Math.atan2(fromAtom.y - center.y, fromAtom.x - center.x);
    const angleTo = Math.atan2(toAtom.y - center.y, toAtom.x - center.x);
    const signedDelta = normalizeSignedAngle(angleTo - angleFrom);
    const direction = signedDelta >= 0 ? 1 : -1;
    const vertices = [
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
    return {
      side,
      vertices,
      crowding: nativeTemplateRingCrowding(molecule, vertices.slice(2), excludedAtomIds)
    };
  }).sort((left, right) => left.crowding - right.crowding);
  const best = candidates[0];
  const alternate = candidates[1];
  if (!best) {
    return [];
  }
  if (alternate && Math.abs(best.crowding - alternate.crowding) <= nativeTemplateRingCrowdingTieEpsilon) {
    const clicked = candidates.find((candidate) => candidate.side === clickSide);
    const other = candidates.find((candidate) => candidate.side !== clickSide);
    return [clicked?.vertices, other?.vertices].filter((vertices): vertices is PagePoint[] => vertices !== undefined);
  }
  return candidates.map((candidate) => candidate.vertices);
}

const nativeTemplateRingCrowdingTieEpsilon = 0.000001;

function nativeTemplateRingCrowding(
  molecule: MoleculeObject,
  points: readonly PagePoint[],
  excludedAtomIds: ReadonlySet<string>
): number {
  return molecule.atoms
    .filter((atom) => !excludedAtomIds.has(atom.id))
    .reduce((score, atom) => score + points.reduce((sum, point) => {
      const normalizedDistance = distance(atom, point) / nativeBondLength;
      return sum + 1 / Math.max(0.05, normalizedDistance) ** 2;
    }, 0), 0);
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

const bracketKindByToolCommandId: ReadonlyMap<string, BracketObject["bracketKind"]> = new Map([
  ["tool.bracket", "curly"],
  ["tool.squareBracket", "square"]
]);

export function bracketKindForToolCommand(commandId: string): BracketObject["bracketKind"] | undefined {
  return bracketKindByToolCommandId.get(commandId);
}

export const nativeBracketDefaultSize = { width: 16, height: 64 } as const;

/** Click placement: a default-size bracket centered on the click point, clamped to the page. */
export function insertNativeBracket(
  document: ChemDraftDocument,
  point: PagePoint,
  bracketKind: BracketObject["bracketKind"]
): ChemDraftDocument {
  const page = firstPage(document);
  const { width, height } = nativeBracketDefaultSize;
  const object: BracketObject = {
    id: nextObjectId(document, "bracket"),
    type: "bracket",
    x: clamp(point.x - width / 2, 0, Math.max(0, page.width - width)),
    y: clamp(point.y - height / 2, 0, Math.max(0, page.height - height)),
    width,
    height,
    rotation: 0,
    style: {},
    bracketKind,
    containedObjectIds: [],
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    }
  };

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

const reactionArrowKindByToolCommandId: ReadonlyMap<string, ArrowObject["arrowKind"]> = new Map([
  ["tool.reactionArrow", "forward"],
  ["tool.resonanceArrow", "resonance"],
  ["tool.equilibriumArrow", "equilibrium"],
  ["tool.retroArrow", "retrosynthesis"]
]);

export function reactionArrowKindForToolCommand(commandId: string): ArrowObject["arrowKind"] | undefined {
  return reactionArrowKindByToolCommandId.get(commandId);
}

export const nativeReactionArrowDefaultLengthPx = 120;
/** Cross-axis minimum for an arrow's frame. The widest glyph (equilibrium) reaches 7.5 px either
 *  side of the shaft, so a 24 px box keeps heads, transform handles, and align/marquee bounds
 *  around the drawing even when the arrow is axis-aligned. */
const nativeReactionArrowMinExtentPx = 24;
const nativeReactionArrowMinLengthPx = 8;

export function createNativeReactionArrow(
  document: ChemDraftDocument,
  startPoint: PagePoint,
  endPoint: PagePoint,
  arrowKind: ArrowObject["arrowKind"]
): ArrowObject {
  const minX = Math.min(startPoint.x, endPoint.x);
  const maxX = Math.max(startPoint.x, endPoint.x);
  const minY = Math.min(startPoint.y, endPoint.y);
  const maxY = Math.max(startPoint.y, endPoint.y);
  const width = Math.max(maxX - minX, nativeReactionArrowMinExtentPx);
  const height = Math.max(maxY - minY, nativeReactionArrowMinExtentPx);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  return {
    id: nextObjectId(document, "arrow"),
    type: "reaction-arrow",
    x: midX - width / 2,
    y: midY - height / 2,
    width,
    height,
    rotation: 0,
    style: {},
    arrowKind,
    start: { kind: "point", point: { x: startPoint.x, y: startPoint.y } },
    end: { kind: "point", point: { x: endPoint.x, y: endPoint.y } },
    labels: [],
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    }
  };
}

export function insertNativeReactionArrow(
  document: ChemDraftDocument,
  startPoint: PagePoint,
  endPoint: PagePoint,
  arrowKind: ArrowObject["arrowKind"]
): ChemDraftDocument {
  const page = firstPage(document);
  const object = createNativeReactionArrow(document, startPoint, endPoint, arrowKind);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

/** Click placement: a default-length horizontal arrow starting at the click point, clamped to the
 *  page so the whole arrow stays visible. */
export function applyReactionArrowToolAtPoint(
  document: ChemDraftDocument,
  point: PagePoint,
  arrowKind: ArrowObject["arrowKind"]
): ChemDraftDocument {
  const page = firstPage(document);
  const startX = clamp(point.x, 0, Math.max(0, page.width - nativeReactionArrowDefaultLengthPx));
  const y = clamp(point.y, nativeReactionArrowMinExtentPx / 2, Math.max(nativeReactionArrowMinExtentPx / 2, page.height - nativeReactionArrowMinExtentPx / 2));

  return insertNativeReactionArrow(
    document,
    { x: startX, y },
    { x: startX + nativeReactionArrowDefaultLengthPx, y },
    arrowKind
  );
}

/** Drag placement: keep the press point as the tail and stretch the head to the pointer. Below the
 *  minimum drag length the default click arrow is kept unchanged. */
export function stretchNativeReactionArrowTo(
  document: ChemDraftDocument,
  objectId: string,
  startPoint: PagePoint,
  endPoint: PagePoint
): ChemDraftDocument {
  const object = findDocumentObject(document, objectId);
  if (object?.type !== "reaction-arrow") {
    return document;
  }
  if (Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) < nativeReactionArrowMinLengthPx) {
    return document;
  }

  const replacement = createNativeReactionArrow(document, startPoint, endPoint, object.arrowKind);
  return applyPatches(
    document,
    [{
      op: "updateObject",
      objectId,
      changes: {
        x: replacement.x,
        y: replacement.y,
        width: replacement.width,
        height: replacement.height,
        start: replacement.start,
        end: replacement.end
      }
    }],
    { now: phase4Timestamp }
  );
}

/** Chemical-formula span formatting: digit runs that follow an element letter or closing
 *  parenthesis become subscripts, and a trailing charge (optional digits plus +, -, or −) becomes a
 *  superscript. Everything else stays a normal span. */
/**
 * A run of element symbols, groupings, and counts — what a trailing sign must follow to be a charge
 * at all. "trans-", "Boc-", and "tert-" fail this and keep their hyphen.
 *
 * Written so that at most one alternative can match at any position: a digit is consumed only by a
 * `\d*` suffix, never by an alternative of its own. The earlier spelling offered both
 * `[A-Z][a-z]?\d*` and a standalone `\d+`, so a long digit run had 2^(n-1) parses and a
 * non-matching tail sent the engine through all of them — a pasted label of ~30 digits froze the
 * app. Same language, linear time.
 */
const formulaBodyPattern = /^\d*(?:(?:[A-Z][a-z]?|[()[\]·])\d*)*$/;
const singleElementPattern = /^[A-Z][a-z]?$/;

/**
 * Index where a trailing charge begins, or `text.length` when there is none.
 *
 * The hard case is that a digit before the sign can be either a charge magnitude or an atom count,
 * and the two are spelled identically: in "Ca2+" the 2 is the charge, in "NH4+" the 4 is a count.
 * Two or more digits always split (the last is the magnitude, as in "SO42-"); a single digit is
 * read as the magnitude only when the body is one element symbol, which is what separates the
 * metal cations from the polyatomic ions.
 */
function formulaChargeStart(text: string): number {
  const match = /(\d*)([+\-±−])$/.exec(text);
  if (!match) {
    return text.length;
  }

  const signIndex = text.length - 1;
  const digits = match[1];
  const body = text.slice(0, text.length - match[0].length);
  // The pattern below accepts the empty string; a bare sign is not a charged formula.
  if (body.length === 0 || !formulaBodyPattern.test(body)) {
    return text.length;
  }
  if (digits.length === 0) {
    return signIndex;
  }
  if (digits.length >= 2) {
    return signIndex - 1;
  }
  return singleElementPattern.test(body) ? signIndex - 1 : signIndex;
}

/** Per-character source styles, so reformatting keeps colour, font, and weight. */
function formulaCharacterStyles(
  text: string,
  sourceSpans: readonly TextSpan[]
): Array<TextSpan["style"] | undefined> {
  const styles: Array<TextSpan["style"] | undefined> = [];
  for (const span of sourceSpans) {
    for (let index = 0; index < span.text.length; index += 1) {
      styles.push(span.style);
    }
  }
  while (styles.length < text.length) {
    styles.push(styles[styles.length - 1]);
  }
  return styles;
}

export function formulaSpansFromText(text: string, sourceSpans: readonly TextSpan[] = []): TextSpan[] {
  if (text.length === 0) {
    return [{ text: "", script: "normal", style: {} }];
  }

  const styles = formulaCharacterStyles(text, sourceSpans);
  const runs: Array<{ text: string; script: TextSpan["script"]; style: TextSpan["style"] | undefined }> = [];
  const pushRun = (runText: string, script: TextSpan["script"], at: number) => {
    if (runText.length === 0) {
      return;
    }
    const style = styles[at];
    const previous = runs[runs.length - 1];
    // Styles come from the source spans, so identical styling is the same object reference.
    if (previous && previous.script === script && previous.style === style) {
      previous.text += runText;
      return;
    }
    runs.push({ text: runText, script, style });
  };

  const chargeStart = formulaChargeStart(text);
  let index = 0;
  while (index < chargeStart) {
    const character = text[index];
    if (/\d/.test(character) && index > 0 && /[A-Za-z)\]]/.test(text[index - 1])) {
      let end = index;
      while (end < chargeStart && /\d/.test(text[end])) {
        end += 1;
      }
      pushRun(text.slice(index, end), "subscript", index);
      index = end;
      continue;
    }
    pushRun(character, "normal", index);
    index += 1;
  }
  if (chargeStart < text.length) {
    pushRun(text.slice(chargeStart), "superscript", chargeStart);
  }

  return runs.map((run) => ({ text: run.text, script: run.script, style: { ...(run.style ?? {}) } }));
}

/** One-shot formula formatting over the selected text objects; returns the same document when the
 *  selection holds no text objects or nothing would change. */
export function applyFormulaTextFormatting(document: ChemDraftDocument): ChemDraftDocument {
  const page = firstPage(document);
  const selectedIds = new Set(document.selection.objectIds);
  const patches: DocumentPatch[] = [];
  for (const object of page.objects) {
    if (object.type !== "text" || !selectedIds.has(object.id)) {
      continue;
    }
    const spans = formulaSpansFromText(object.text, object.spans);
    if (JSON.stringify(spans) === JSON.stringify(object.spans)) {
      continue;
    }
    patches.push({ op: "updateObject", objectId: object.id, changes: { spans } });
  }
  if (patches.length === 0) {
    return document;
  }
  return applyPatches(document, patches, { now: phase4Timestamp });
}

const symbolGlyphByToolCommandId: ReadonlyMap<string, string> = new Map([
  ["tool.dagger", "‡"],
  ["tool.symbol", "°"],
  ["tool.symbol.degree", "°"],
  ["tool.symbol.plusMinus", "±"],
  ["tool.symbol.angstrom", "Å"],
  ["tool.symbol.delta", "Δ"],
  ["tool.symbol.centerDot", "·"],
  ["tool.symbol.prime", "′"]
]);

export function symbolGlyphForToolCommand(commandId: string): string | undefined {
  return symbolGlyphByToolCommandId.get(commandId);
}

/** Stamp a single symbol glyph as a normal text object. One call per click, one history entry. */
export function insertNativeSymbolGlyph(
  document: ChemDraftDocument,
  point: PagePoint,
  glyph: string,
  style: Partial<NativeTextStyle> = {}
): ChemDraftDocument {
  // A stamp lands centred on the click, the way brackets and art shapes do. Plain text keeps the
  // click as its top-left instead, because that is where its caret starts.
  const size = nativeTextObjectSizeForText(glyph, textStyleToObjectStyle(style));
  return insertNativeTextObject(
    document,
    { x: point.x - size.width / 2, y: point.y - size.height / 2 },
    glyph,
    style
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
      order: bond.order,
      // Preserve wedge/hash stereo markers from the pasted molfile (V2000 bond stereo /
      // V3000 CFG) instead of silently dropping them (AGENTS.md §5.7).
      ...(bond.bondStyle ? { display: { bondStyle: bond.bondStyle } } : {})
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

/** A 2D depiction (atoms + wedge-aware bonds) produced from a SMILES by the OCL
 *  adapter's `depictSmiles2D`. Kept structural so this module never imports the
 *  engine (which stays behind a dynamic import to keep it out of the static graph). */
export interface PastedStructureDepiction {
  atoms: ReadonlyArray<{ element: string; x: number; y: number; charge: number }>;
  bonds: ReadonlyArray<{ from: number; to: number; order: MoleculeBond["order"]; wedge: "wedge" | "hashed" | null }>;
}

/**
 * Read a generated 2D molfile into the structural depiction consumed by SMILES paste. Keeping
 * this conversion beside `insertSmilesMolecule` means RDKit and the OpenChemLib fallback share
 * the app's existing molfile parser, including its fixed-column and wedge-direction handling.
 */
export function pastedStructureDepictionFromMolfile(molfile: string): PastedStructureDepiction {
  const graph = parseMolfileGraph(molfile);
  const atomIndexById = new Map(graph.atoms.map((atom, index) => [atom.id, index]));
  return {
    atoms: graph.atoms.map((atom) => ({
      element: atom.element,
      x: atom.x,
      y: atom.y,
      charge: atom.formalCharge
    })),
    bonds: graph.bonds.flatMap((bond) => {
      const from = atomIndexById.get(bond.fromAtomId);
      const to = atomIndexById.get(bond.toAtomId);
      if (from === undefined || to === undefined) return [];
      return [{
        from,
        to,
        // Carried through, not collapsed. `MoleculeBond["order"]` — which this interface already
        // declares — accepts both, the insert path stores whatever arrives, and the OCL adapter
        // explicitly refuses this same collapse citing AGENTS.md section 5.7. Flattening an
        // un-kekulized aromatic ring to all-single bonds is a silent chemistry change.
        order: bond.order,
        wedge: bond.bondStyle ?? null
      }];
    })
  };
}

/**
 * Place a SMILES-derived 2D depiction as an editable native molecule, preserving
 * stereochemistry. The depiction is engine-frame y-UP with wedge/hash bonds; the
 * molfile scaler negates y (→ document y-down) and KEEPS the wedges unchanged —
 * which preserves chirality per the coordinate-frame contract (negate y, never swap
 * wedges; proven by the Phase 6 oracle round-trip). Double-bond sides are recomputed
 * from the placed geometry so ring double bonds draw toward the ring interior.
 */
/** Where a SMILES-derived molecule came from, so the object records it honestly. */
export interface SmilesMoleculeSource {
  objectIdPrefix: string;
  styleSource: string;
  warningCode: string;
  warningMessage: string;
  /**
   * Ids already handed out but not yet in the document, so the next one skips them.
   *
   * Paste does not need this: it inserts immediately, so the document always reflects every id
   * already issued. A plugin's structure does — it is BUILT and then waits in the review queue, so
   * two structures built before either is accepted both saw an unchanged document and both minted
   * `mol_plugin_001`. Accepting the second threw `object "mol_plugin_001" already exists`.
   *
   * The caller owns the set and adds to it, because only the caller knows when an id has been issued.
   */
  reservedObjectIds?: Set<string>;
}

export const SMILES_PASTE_SOURCE: SmilesMoleculeSource = {
  objectIdPrefix: "mol_clipboard",
  styleSource: "clipboard-smiles",
  warningCode: "clipboard.smiles_imported",
  warningMessage: "Generated an editable 2D structure from pasted SMILES."
};

/**
 * Build the molecule object a SMILES depiction becomes, without touching the document.
 *
 * Split out of {@link insertSmilesMolecule} so the plugin boundary can reach it: a plugin proposes a
 * patch carrying an object, and has no business applying one. Both callers therefore produce the same
 * object — same scaling, same double-bond side recomputation, same compatibility record — which is
 * what stops "insert from name" and "paste a SMILES" drifting into two different structures for the
 * same input.
 *
 * `source` distinguishes them where it matters: the style and the compatibility warning record where
 * the structure came from, and "pasted" would be a false provenance claim for a converted name.
 */
export function createSmilesMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  depiction: PastedStructureDepiction,
  smilesText: string,
  source: SmilesMoleculeSource = SMILES_PASTE_SOURCE
): DocumentObject {
  if (depiction.atoms.length === 0) {
    throw new Error("Cannot build a molecule: no atoms were generated.");
  }
  const page = firstPage(document);

  const pseudoGraph: ParsedMolfileGraph = {
    format: "molfile-v2000",
    atoms: depiction.atoms.map((atom, index) => ({
      id: `a${index}`,
      element: atom.element,
      x: atom.x,
      y: atom.y,
      formalCharge: atom.charge
    })),
    bonds: depiction.bonds.map((bond, index) => ({
      id: `b${index}`,
      fromAtomId: `a${bond.from}`,
      toAtomId: `a${bond.to}`,
      order: bond.order
    })),
    warnings: []
  };

  const atoms: MoleculeAtom[] = scaleParsedMolfileAtoms(
    pseudoGraph,
    point,
    page,
    smilesPasteBondLengthPx
  ).map((atom) => ({
    id: atom.id,
    element: atom.element,
    x: atom.x,
    y: atom.y,
    formalCharge: atom.formalCharge
  }));
  const atomIds = new Set(atoms.map((atom) => atom.id));
  const baseBonds: MoleculeBond[] = depiction.bonds
    .map((bond, index): MoleculeBond => {
      const base: MoleculeBond = {
        id: `b${index}`,
        fromAtomId: `a${bond.from}`,
        toAtomId: `a${bond.to}`,
        order: bond.order
      };
      return bond.wedge ? { ...base, display: { bondStyle: bond.wedge } } : base;
    })
    .filter((bond) => atomIds.has(bond.fromAtomId) && atomIds.has(bond.toAtomId));

  // Recompute each double bond's drawn side from the placed 2D geometry.
  const geometry = moleculeGeometryFromAtoms(atoms);
  const sideMolecule: MoleculeObject = {
    id: "smiles-side",
    type: "molecule",
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms,
    bonds: baseBonds,
    superatoms: [],
    rGroups: [],
    ...geometry
  };
  const bonds: MoleculeBond[] = baseBonds.map((bond) =>
    bond.order === "double"
      ? { ...bond, display: { ...(bond.display ?? {}), doubleBondSide: defaultDoubleBondSide(sideMolecule, bond) } }
      : bond
  );

  const structure = moleculeToMolfileV2000({ ...sideMolecule, bonds }, { fromDocFrame: true });

  return normalizeNativeMoleculeGeometry({
    id: nextObjectId(document, source.objectIdPrefix, source.reservedObjectIds),
    type: "molecule",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    transform: defaultNativeMoleculeTransform,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      bondLengthPx: smilesPasteBondLengthPx,
      source: source.styleSource
    },
    compatibility: {
      sourceFormat: "smiles",
      warnings: [{ code: source.warningCode, message: source.warningMessage }],
      unknown: { smiles: smilesText }
    },
    structureFormat: "molfile-v2000",
    structure,
    chemistry: nativeSingleBondGraphMetadata(atoms, bonds),
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  });
}

export function insertSmilesMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  depiction: PastedStructureDepiction,
  smilesText: string
): ChemDraftDocument {
  const object = createSmilesMolecule(document, point, depiction, smilesText);
  const page = firstPage(document);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
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
    // Detection is a heuristic over clipboard text, so it can hand this branch something that is
    // not a molfile at all. `parseMolfileGraph` throws on malformed input, and an exception here
    // escapes the whole paste handler — paste then does nothing at all, with no message. Fail the
    // same way the RXN branch below does: keep the document, report why (§16).
    try {
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
    } catch (error) {
      const warning = {
        code: "clipboard.molfile_parse_failed",
        message: error instanceof Error
          ? `ChemDraft detected a MOL structure on the clipboard, but could not parse it: ${error.message}`
          : "ChemDraft detected a MOL structure on the clipboard, but could not parse it."
      };
      return {
        document,
        status: warning.message,
        kind: payload.kind,
        warnings: [...payload.warnings, warning]
      };
    }
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

export function applyObjectColorToDocumentObjects(
  document: ChemDraftDocument,
  color: string,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  // Expand groups to their renderable children: a GroupObject is skipped by render/export, so
  // writing color to the group wrapper changes nothing visible while reporting success.
  const allObjects = document.pages.flatMap((page) => page.objects);
  const selectedIds = new Set(resolveGroupedDocumentObjectIds(allObjects, objectIds));
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

export type GraphicStylePaintTarget = "fill" | "stroke";
export type GraphicStylePaintType = GraphicPaint["kind"] | "gloss";
const MAX_GRAPHIC_GRADIENT_STOPS = 8;
const GRAPHIC_GRADIENT_ENDPOINT_STOP_GAP = 0.01;
type GradientGraphicPaint = Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }>;
type NativePaintObject = GraphicObject | MoleculeObject;

export function selectedGraphicObjectIds(document: ChemDraftDocument): string[] {
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0) {
    return [];
  }

  return document.pages.flatMap((page) =>
    page.objects
      .filter((object): object is GraphicObject => object.type === "graphic" && selectedIds.has(object.id))
      .map((object) => object.id)
  );
}

export function selectedMoleculeObjectIds(document: ChemDraftDocument): string[] {
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0) {
    return [];
  }

  return document.pages.flatMap((page) =>
    page.objects
      .filter((object): object is MoleculeObject => object.type === "molecule" && selectedIds.has(object.id))
      .map((object) => object.id)
  );
}

export type MoleculeBaseStylePatch = Partial<
  Pick<
    NativeDrawingStyle,
    | "chainAngleDegrees"
    | "bondStrokeWidthPx"
    | "bondBoldWidthPx"
    | "bondColor"
    | "bondLineCap"
    | "bondSpacingMode"
    | "bondSpacingPercent"
    | "multipleBondGapPx"
    | "doubleBondInsetPx"
    | "bondMarginWidthPx"
    | "bondHashSpacingPx"
    | "bondOverlapClearancePx"
    | "atomIndicatorShowQuery"
    | "atomIndicatorShowStereochemistry"
    | "atomIndicatorShowEnhancedStereochemistry"
    | "atomIndicatorShowAtomNumbers"
    | "bondIndicatorShowQuery"
    | "bondIndicatorShowStereochemistry"
    | "bondIndicatorShowReaction"
    | "atomLabelFontFamily"
    | "atomLabelFontSizePx"
    | "atomLabelFontWeight"
    | "atomLabelFontStyle"
    | "atomLabelColor"
    | "atomLabelBackgroundColor"
    | "atomLabelPaddingPx"
    | "atomLabelBondClearancePx"
    | "atomLabelAlignment"
    | "atomLabelPlacement"
    | "atomLabelShowTerminalCarbons"
    | "atomLabelHideImplicitHydrogens"
  >
>;

export function applyMoleculeBaseStylePatch(
  document: ChemDraftDocument,
  moleculeObjectIds: readonly string[],
  patch: MoleculeBaseStylePatch
): ChemDraftDocument {
  const targetIds = new Set(moleculeObjectIds);
  const patchEntries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (targetIds.size === 0 || patchEntries.length === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule" || !targetIds.has(object.id)) {
        return [];
      }
      // Patch values are top-level primitives, so a shallow compare against the
      // current values is equivalent to the old whole-style JSON.stringify diff and
      // skips building nextStyle (and serializing twice) on a no-op.
      const changed = patchEntries.some(
        ([key, value]) => (object.style as Record<string, unknown>)[key] !== value
      );
      return changed
        ? [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: { style: { ...object.style, ...Object.fromEntries(patchEntries) } }
          }]
        : [];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

export interface MoleculeAtomLabelStyleTarget {
  objectId: string;
  atomId: string;
}

export type MoleculeAtomLabelStylePatch = Partial<
  Pick<
    NativeDrawingStyle,
    | "atomLabelFontFamily"
    | "atomLabelFontSizePx"
    | "atomLabelFontWeight"
    | "atomLabelFontStyle"
    | "atomLabelColor"
    | "atomLabelBackgroundColor"
    | "atomLabelPaddingPx"
    | "atomLabelBondClearancePx"
    | "atomLabelAlignment"
    | "atomLabelPlacement"
    | "atomLabelShowTerminalCarbons"
    | "atomLabelHideImplicitHydrogens"
  >
>;

export function applyMoleculeAtomLabelStylePatch(
  document: ChemDraftDocument,
  targets: readonly MoleculeAtomLabelStyleTarget[],
  patch: MoleculeAtomLabelStylePatch
): ChemDraftDocument {
  const patchEntries = Object.entries(patch).filter((entry): entry is [keyof MoleculeAtomLabelStylePatch, NonNullable<MoleculeAtomLabelStylePatch[keyof MoleculeAtomLabelStylePatch]>] =>
    entry[1] !== undefined
  );
  if (targets.length === 0 || patchEntries.length === 0) {
    return document;
  }

  const targetAtomIdsByObject = new Map<string, Set<string>>();
  targets.forEach((target) => {
    const atomIds = targetAtomIdsByObject.get(target.objectId) ?? new Set<string>();
    atomIds.add(target.atomId);
    targetAtomIdsByObject.set(target.objectId, atomIds);
  });

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule") {
        return [];
      }
      const requestedAtomIds = targetAtomIdsByObject.get(object.id);
      if (!requestedAtomIds) {
        return [];
      }
      const atomIds = object.atoms.map((atom) => atom.id).filter((atomId) => requestedAtomIds.has(atomId));
      if (atomIds.length === 0) {
        return [];
      }

      let nextStyle = object.style;
      const touchedKeys = new Set<string>();
      for (const [field, value] of patchEntries) {
        const mapKey = atomLabelStyleMapKey(field);
        if (!mapKey) {
          continue;
        }
        const nextMap = stylePrimitiveMap(nextStyle[mapKey], atomLabelStyleMapValueIsValid(field));
        atomIds.forEach((atomId) => {
          nextMap[atomId] = value;
        });
        nextStyle = {
          ...nextStyle,
          [mapKey]: nextMap
        };
        touchedKeys.add(mapKey);
      }

      return moleculeStyleChangedAtKeys(object.style, nextStyle, touchedKeys)
        ? [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: { style: nextStyle }
          }]
        : [];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

export interface MoleculeBondStyleTarget {
  objectId: string;
  bondId: string;
}

export type MoleculeBondStylePatch = Partial<
  Pick<
    NativeDrawingStyle,
    | "bondLengthPx"
    | "bondStrokeWidthPx"
    | "bondBoldWidthPx"
    | "bondColor"
    | "bondLineCap"
    | "bondSpacingMode"
    | "bondSpacingPercent"
    | "multipleBondGapPx"
    | "doubleBondInsetPx"
    | "bondMarginWidthPx"
    | "bondHashSpacingPx"
    | "bondOverlapClearancePx"
    | "bondIndicatorShowQuery"
    | "bondIndicatorShowStereochemistry"
    | "bondIndicatorShowReaction"
  >
>;

export function applyMoleculeBondStylePatch(
  document: ChemDraftDocument,
  targets: readonly MoleculeBondStyleTarget[],
  patch: MoleculeBondStylePatch
): ChemDraftDocument {
  const patchEntries = Object.entries(patch).filter((entry): entry is [keyof MoleculeBondStylePatch, NonNullable<MoleculeBondStylePatch[keyof MoleculeBondStylePatch]>] =>
    entry[1] !== undefined
  );
  if (targets.length === 0 || patchEntries.length === 0) {
    return document;
  }

  const targetBondIdsByObject = new Map<string, Set<string>>();
  targets.forEach((target) => {
    const bondIds = targetBondIdsByObject.get(target.objectId) ?? new Set<string>();
    bondIds.add(target.bondId);
    targetBondIdsByObject.set(target.objectId, bondIds);
  });

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule") {
        return [];
      }
      const requestedBondIds = targetBondIdsByObject.get(object.id);
      if (!requestedBondIds) {
        return [];
      }
      const bondIds = object.bonds.map((bond) => bond.id).filter((bondId) => requestedBondIds.has(bondId));
      if (bondIds.length === 0) {
        return [];
      }

      let nextStyle = object.style;
      const touchedKeys = new Set<string>();
      for (const [field, value] of patchEntries) {
        const mapKey = bondStyleMapKey(field);
        if (!mapKey) {
          continue;
        }
        const nextMap = stylePrimitiveMap(nextStyle[mapKey], bondStyleMapValueIsValid(field));
        bondIds.forEach((bondId) => {
          nextMap[bondId] = value;
        });
        nextStyle = {
          ...nextStyle,
          [mapKey]: nextMap
        };
        touchedKeys.add(mapKey);
      }

      return moleculeStyleChangedAtKeys(object.style, nextStyle, touchedKeys)
        ? [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: { style: nextStyle }
          }]
        : [];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

export interface MoleculeAtomIndicatorStyleTarget {
  objectId: string;
  atomId: string;
}

export type MoleculeAtomIndicatorStylePatch = Partial<
  Pick<
    NativeDrawingStyle,
    | "atomIndicatorShowQuery"
    | "atomIndicatorShowStereochemistry"
    | "atomIndicatorShowEnhancedStereochemistry"
    | "atomIndicatorShowAtomNumbers"
  >
>;

export function applyMoleculeAtomIndicatorStylePatch(
  document: ChemDraftDocument,
  targets: readonly MoleculeAtomIndicatorStyleTarget[],
  patch: MoleculeAtomIndicatorStylePatch
): ChemDraftDocument {
  const patchEntries = Object.entries(patch).filter((entry): entry is [keyof MoleculeAtomIndicatorStylePatch, NonNullable<MoleculeAtomIndicatorStylePatch[keyof MoleculeAtomIndicatorStylePatch]>] =>
    entry[1] !== undefined
  );
  if (targets.length === 0 || patchEntries.length === 0) {
    return document;
  }

  const targetAtomIdsByObject = new Map<string, Set<string>>();
  targets.forEach((target) => {
    const atomIds = targetAtomIdsByObject.get(target.objectId) ?? new Set<string>();
    atomIds.add(target.atomId);
    targetAtomIdsByObject.set(target.objectId, atomIds);
  });

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule") {
        return [];
      }
      const requestedAtomIds = targetAtomIdsByObject.get(object.id);
      if (!requestedAtomIds) {
        return [];
      }
      const atomIds = object.atoms.map((atom) => atom.id).filter((atomId) => requestedAtomIds.has(atomId));
      if (atomIds.length === 0) {
        return [];
      }

      let nextStyle = object.style;
      const touchedKeys = new Set<string>();
      for (const [field, value] of patchEntries) {
        const mapKey = atomIndicatorStyleMapKey(field);
        const nextMap = stylePrimitiveMap(nextStyle[mapKey], atomIndicatorStyleMapValueIsValid(field));
        atomIds.forEach((atomId) => {
          nextMap[atomId] = value;
        });
        nextStyle = {
          ...nextStyle,
          [mapKey]: nextMap
        };
        touchedKeys.add(mapKey);
      }

      return moleculeStyleChangedAtKeys(object.style, nextStyle, touchedKeys)
        ? [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: { style: nextStyle }
          }]
        : [];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

export function applyMoleculeTargetBondLength(
  document: ChemDraftDocument,
  moleculeObjectIds: readonly string[],
  targetBondLengthPx: number
): ChemDraftDocument {
  if (!Number.isFinite(targetBondLengthPx) || targetBondLengthPx <= 0) {
    return document;
  }

  const targetIds = new Set(moleculeObjectIds);
  if (targetIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule" || !targetIds.has(object.id)) {
        return [];
      }

      const representative = representativeNativeMoleculeBondLength(object);
      const nextStyle = {
        ...object.style,
        bondLengthPx: targetBondLengthPx
      };
      const scaled = representative
        ? scaledMoleculeToTargetBondLength(object, targetBondLengthPx, representative, nextStyle)
        : normalizeNativeMoleculeGeometry({ ...object, style: nextStyle });
      const changes = moleculeObjectChanges(object, scaled);
      return Object.keys(changes).length === 0
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

export function applyMoleculeTargetBondLengthToBonds(
  document: ChemDraftDocument,
  targets: readonly MoleculeBondStyleTarget[],
  targetBondLengthPx: number
): ChemDraftDocument {
  if (!Number.isFinite(targetBondLengthPx) || targetBondLengthPx <= 0 || targets.length === 0) {
    return document;
  }

  const targetBondIdsByObject = new Map<string, Set<string>>();
  targets.forEach((target) => {
    const bondIds = targetBondIdsByObject.get(target.objectId) ?? new Set<string>();
    bondIds.add(target.bondId);
    targetBondIdsByObject.set(target.objectId, bondIds);
  });

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule") {
        return [];
      }
      const requestedBondIds = targetBondIdsByObject.get(object.id);
      if (!requestedBondIds) {
        return [];
      }
      const selectedBonds = object.bonds.filter((bond) => requestedBondIds.has(bond.id));
      if (selectedBonds.length === 0) {
        return [];
      }

      const nextBondLengths = stylePrimitiveMap(object.style.bondLengths, (candidate): candidate is number =>
        typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      );
      selectedBonds.forEach((bond) => {
        nextBondLengths[bond.id] = targetBondLengthPx;
      });

      const atomById = new Map(object.atoms.map((atom) => [atom.id, { ...atom }]));
      // Atoms already repositioned by an earlier selected bond are anchored so a later
      // selected bond that shares one can't drag it back off-target. The first bond to touch
      // a pair recenters it around its midpoint; a bond that shares an already-placed atom
      // pivots around it, moving only its free endpoint. Without this, two selected bonds
      // sharing an atom clobber each other and neither ends at the requested length.
      const anchoredAtomIds = new Set<string>();
      selectedBonds.forEach((bond) => {
        const from = atomById.get(bond.fromAtomId);
        const to = atomById.get(bond.toAtomId);
        if (!from || !to) {
          return;
        }
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        if (!Number.isFinite(length) || length <= 0) {
          return;
        }
        const unit = { x: dx / length, y: dy / length };
        const fromAnchored = anchoredAtomIds.has(from.id);
        const toAnchored = anchoredAtomIds.has(to.id);
        if (fromAnchored && toAnchored) {
          // Both endpoints are already pinned by earlier selected bonds; moving either would
          // break those. Leave the geometry as-is (the target is still recorded in style).
          return;
        }
        if (fromAnchored) {
          atomById.set(to.id, {
            ...to,
            x: from.x + unit.x * targetBondLengthPx,
            y: from.y + unit.y * targetBondLengthPx
          });
        } else if (toAnchored) {
          atomById.set(from.id, {
            ...from,
            x: to.x - unit.x * targetBondLengthPx,
            y: to.y - unit.y * targetBondLengthPx
          });
        } else {
          const center = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
          const half = targetBondLengthPx / 2;
          atomById.set(from.id, {
            ...from,
            x: center.x - unit.x * half,
            y: center.y - unit.y * half
          });
          atomById.set(to.id, {
            ...to,
            x: center.x + unit.x * half,
            y: center.y + unit.y * half
          });
        }
        anchoredAtomIds.add(from.id);
        anchoredAtomIds.add(to.id);
      });

      const nextObject = normalizeNativeMoleculeGeometry({
        ...object,
        atoms: object.atoms.map((atom) => atomById.get(atom.id) ?? atom),
        style: {
          ...object.style,
          bondLengths: nextBondLengths
        }
      });
      const changes = moleculeObjectChanges(object, nextObject);
      return Object.keys(changes).length === 0
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

export function selectedVisualEffectObjectIds(
  document: ChemDraftDocument,
  options: { excludeMoleculeObjectIds?: ReadonlySet<string> } = {}
): string[] {
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0) {
    return [];
  }

  return document.pages.flatMap((page) =>
    page.objects
      .filter((object): object is GraphicObject | MoleculeObject =>
        (object.type === "graphic" || object.type === "molecule") &&
        selectedIds.has(object.id) &&
        !options.excludeMoleculeObjectIds?.has(object.id)
      )
      .map((object) => object.id)
  );
}

export interface NativeArtBooleanDocumentResult {
  document: ChemDraftDocument;
  changed: boolean;
  status: string;
  resultObjectIds: string[];
  skippedInputs: NativeArtBooleanSkippedInput[];
}

export function selectedArtBooleanEligibleObjectIds(document: ChemDraftDocument): string[] {
  return selectedGraphicObjectsInSelectionOrder(document)
    .filter(graphicObjectSupportsBooleanOperation)
    .map((object) => object.id);
}

export function applyNativeArtBooleanOperationToSelection(
  document: ChemDraftDocument,
  operation: NativeArtBooleanOperation
): NativeArtBooleanDocumentResult {
  const page = document.pages.find((candidate) => candidate.id === document.selection.pageId) ?? firstPage(document);
  const selectedGraphics = selectedGraphicObjectsInSelectionOrder(document);
  const plan = planNativeArtBooleanOperation(selectedGraphics, operation);
  if (plan.eligibleInputIds.length < 2) {
    return {
      document,
      changed: false,
      status: nativeArtBooleanNeedsSelectionStatus(operation, plan.skippedInputs),
      resultObjectIds: [],
      skippedInputs: plan.skippedInputs
    };
  }

  if (plan.resultPaths.length === 0) {
    return {
      document,
      changed: false,
      status: `${nativeArtBooleanCommandTitle(operation)} produced no closed art shape`,
      resultObjectIds: [],
      skippedInputs: plan.skippedInputs
    };
  }

  const sourceObject = selectedGraphics.find((object) => object.id === plan.eligibleInputIds[0]);
  if (!sourceObject) {
    return {
      document,
      changed: false,
      status: "Boolean art operation could not find a source shape",
      resultObjectIds: [],
      skippedInputs: plan.skippedInputs
    };
  }

  const reservedObjectIds = new Set(document.pages.flatMap((candidate) => candidate.objects.map((object) => object.id)));
  const resultObjects = plan.resultPaths.map((resultPath) =>
    createNativeArtBooleanResultObject(document, sourceObject, operation, resultPath, reservedObjectIds)
  );
  const resultObjectIds = resultObjects.map((object) => object.id);
  const patches: DocumentPatch[] = [
    ...plan.eligibleInputIds.map((objectId) => ({ op: "removeObject" as const, objectId })),
    ...resultObjects.map((object) => ({ op: "addObject" as const, pageId: page.id, object })),
    { op: "setSelection", pageId: page.id, objectIds: resultObjectIds }
  ];

  return {
    document: applyPatches(document, patches, { now: phase4Timestamp }),
    changed: true,
    status: nativeArtBooleanSuccessStatus(operation, plan.eligibleInputIds.length, resultObjects.length, plan.skippedInputs),
    resultObjectIds,
    skippedInputs: plan.skippedInputs
  };
}

function selectedGraphicObjectsInSelectionOrder(document: ChemDraftDocument): GraphicObject[] {
  if (document.selection.objectIds.length === 0) {
    return [];
  }

  const page = document.pages.find((candidate) => candidate.id === document.selection.pageId) ?? firstPage(document);
  const graphicsById = new Map(page.objects
    .filter((object): object is GraphicObject => object.type === "graphic")
    .map((object) => [object.id, object]));
  return document.selection.objectIds.flatMap((objectId) => {
    const object = graphicsById.get(objectId);
    return object ? [object] : [];
  });
}

function createNativeArtBooleanResultObject(
  document: ChemDraftDocument,
  sourceObject: GraphicObject,
  operation: NativeArtBooleanOperation,
  resultPath: NativeArtBooleanResultPath,
  reservedObjectIds: Set<string>
): GraphicObject {
  return {
    id: nextReservedObjectId(reservedObjectIds, `art_boolean_${operation}`, document),
    type: "graphic",
    graphicKind: "path",
    x: resultPath.bounds.x,
    y: resultPath.bounds.y,
    width: resultPath.bounds.width,
    height: resultPath.bounds.height,
    rotation: 0,
    style: {
      ...sourceObject.style,
      source: "chemdraft-native-art",
      artToolId: `boolean-${operation}`,
      artToolCommandId: `art.boolean.${operation}`
    },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    },
    data: {
      pathD: resultPath.pathD,
      artToolId: `boolean-${operation}`
    }
  };
}

function nextReservedObjectId(
  reservedObjectIds: Set<string>,
  prefix: string,
  document: ChemDraftDocument
): string {
  let index = document.pages.flatMap((page) => page.objects).length + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;
  while (reservedObjectIds.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }
  reservedObjectIds.add(id);
  return id;
}

function nativeArtBooleanNeedsSelectionStatus(
  operation: NativeArtBooleanOperation,
  skippedInputs: readonly NativeArtBooleanSkippedInput[]
): string {
  const skipped = nativeArtBooleanSkippedStatus(skippedInputs);
  return `${nativeArtBooleanCommandTitle(operation)} needs at least two closed art shapes${skipped}`;
}

function nativeArtBooleanSuccessStatus(
  operation: NativeArtBooleanOperation,
  eligibleCount: number,
  resultCount: number,
  skippedInputs: readonly NativeArtBooleanSkippedInput[]
): string {
  if (operation === "subtract") {
    const subtractCount = Math.max(0, eligibleCount - 1);
    return `Subtracted ${subtractCount} closed art ${subtractCount === 1 ? "shape" : "shapes"} from first selected shape${nativeArtBooleanSkippedStatus(skippedInputs)}`;
  }

  const sourceText = `${eligibleCount} closed art ${eligibleCount === 1 ? "shape" : "shapes"}`;
  const resultText = operation === "split"
    ? ` into ${resultCount} ${resultCount === 1 ? "piece" : "pieces"}`
    : "";
  return `${nativeArtBooleanPastTense(operation)} ${sourceText}${resultText}${nativeArtBooleanSkippedStatus(skippedInputs)}`;
}

function nativeArtBooleanCommandTitle(operation: NativeArtBooleanOperation): string {
  if (operation === "subtract") {
    return "Boolean subtract";
  }
  if (operation === "intersect") {
    return "Boolean intersect";
  }
  if (operation === "split") {
    return "Boolean split";
  }
  return "Boolean union";
}

function nativeArtBooleanPastTense(operation: NativeArtBooleanOperation): string {
  if (operation === "subtract") {
    return "Subtracted";
  }
  if (operation === "intersect") {
    return "Intersected";
  }
  if (operation === "split") {
    return "Split";
  }
  return "Unioned";
}

function nativeArtBooleanSkippedStatus(skippedInputs: readonly NativeArtBooleanSkippedInput[]): string {
  if (skippedInputs.length === 0) {
    return "";
  }

  const openCount = skippedInputs.filter((input) => input.reason === "open-shape").length;
  const unsupportedCount = skippedInputs.filter((input) => input.reason === "unsupported-shape").length;
  const invalidCount = skippedInputs.filter((input) => input.reason === "invalid-geometry").length;
  const parts = [
    openCount > 0 ? `${openCount} open` : "",
    unsupportedCount > 0 ? `${unsupportedCount} unsupported` : "",
    invalidCount > 0 ? `${invalidCount} invalid` : ""
  ].filter(Boolean);
  return `; skipped ${parts.length > 0 ? parts.join(", ") : skippedInputs.length} art ${skippedInputs.length === 1 ? "object" : "objects"}`;
}

export function applyGraphicObjectColorToSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  color: string,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const normalized = normalizeWorkflowHexColor(color);
  if (!normalized) {
    return document;
  }

  return updateGraphicObjects(document, objectIds, (object) => {
    const opacity = target === "fill" ? graphicFillPaintOpacity(object) : graphicStrokePaintOpacity(object);
    const currentPaint = target === "fill" ? graphicFillPaintForObject(object) : graphicStrokePaintForObject(object);
    const paint = graphicPaintWithPrimaryColor(currentPaint, normalized, opacity);
    return target === "fill"
      ? {
          ...object.style,
          fillColor: normalized,
          fillMode: object.style.fillMode === "gloss"
            ? "gloss"
            : paint.kind === "none" ? undefined : "solid",
          fillPaint: paint
        }
      : {
          ...object.style,
          strokeColor: normalized,
          strokePaint: paint
        };
  }, (object) => graphicObjectSupportsStyleCapability(object, target));
}

export function applyGraphicObjectNoneToSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjects(document, objectIds, (object) => target === "fill"
    ? {
        ...object.style,
        fillColor: "none",
        fillMode: undefined,
        fillPaint: { kind: "none" }
      }
    : {
        ...object.style,
        strokeColor: "none",
        strokePaint: { kind: "none" }
      }, (object) => graphicObjectSupportsStyleCapability(object, target));
}

export function applyGraphicObjectPaintTypeToSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  paintType: GraphicStylePaintType,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjects(document, objectIds, (object) => {
    if (paintType === "gloss") {
      const color = graphicPaintBaseColor(object, "fill");
      const opacity = graphicFillPaintOpacity(object);
      return {
        ...object.style,
        fillColor: color,
        fillMode: "gloss",
        fillPaint: { kind: "solid", color, opacity }
      };
    }

    const paint = graphicPaintForType(object, target, paintType);
    return target === "fill"
      ? {
          ...object.style,
          fillColor: legacyColorForGraphicPaint(paint, "none"),
          fillMode: paint.kind === "none" ? undefined : "solid",
          fillPaint: paint
        }
      : {
          ...object.style,
          strokeColor: legacyColorForGraphicPaint(paint, "#111111"),
          strokePaint: paint
        };
  }, (object) =>
    graphicObjectSupportsStyleCapability(object, target) &&
    (paintType !== "gloss" || target === "fill")
  );
}

export function swapGraphicObjectFillAndStroke(
  document: ChemDraftDocument,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjects(document, objectIds, (object) => {
    const fillPaint = graphicFillPaintForObject(object);
    const strokePaint = graphicStrokePaintForObject(object);
    return {
      ...object.style,
      fillPaint: strokePaint,
      strokePaint: fillPaint,
      fillColor: legacyColorForGraphicPaint(strokePaint, "none"),
      strokeColor: legacyColorForGraphicPaint(fillPaint, "#111111"),
      fillMode: strokePaint.kind === "none" ? undefined : "solid",
      fillOpacity: object.style.strokeOpacity,
      strokeOpacity: object.style.fillOpacity
    };
  }, (object) =>
    graphicObjectSupportsStyleCapability(object, "fill") &&
    graphicObjectSupportsStyleCapability(object, "stroke")
  );
}

export function applyGraphicObjectEyedropperToSelection(
  document: ChemDraftDocument,
  sourceObjectId: string,
  target: GraphicStylePaintTarget,
  options: { fullAppearance?: boolean } = {},
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const source = findDocumentObject(document, sourceObjectId);
  if (source?.type !== "graphic") {
    return document;
  }

  const targetIds = objectIds.filter((objectId) => objectId !== sourceObjectId);
  if (targetIds.length === 0) {
    return document;
  }

  const targetIdSet = new Set(targetIds);
  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "graphic" || !targetIdSet.has(object.id)) {
        return [];
      }
      if (
        options.fullAppearance
          ? !graphicObjectSupportsStyleCapability(object, "fill") && !graphicObjectSupportsStyleCapability(object, "stroke")
          : !graphicObjectSupportsStyleCapability(object, target)
      ) {
        return [];
      }

      const nextStyle = { ...object.style };
      if (options.fullAppearance) {
        copyGraphicAppearanceStyle(nextStyle, source.style);
      } else if (target === "fill") {
        copyGraphicFillStyle(nextStyle, source.style);
      } else {
        copyGraphicStrokeStyle(nextStyle, source.style);
      }

      let nextData = object.data;
      if (
        (options.fullAppearance || target === "stroke") &&
        graphicObjectSupportsStyleCapability(object, "lineEnds")
      ) {
        nextData = { ...object.data };
        copyOptionalGraphicDataKey(nextData, source.data, "markerStart");
        copyOptionalGraphicDataKey(nextData, source.data, "markerEnd");
      }

      return graphicStylesEqual(object.style, nextStyle) && graphicDataMarkerStateEqual(object.data, nextData)
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: {
              style: nextStyle,
              data: nextData
            }
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

function copyOptionalGraphicDataKey<K extends keyof GraphicObjectData>(
  target: GraphicObjectData,
  source: GraphicObjectData,
  key: K
): void {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = source[key];
  } else {
    delete target[key];
  }
}

function graphicDataMarkerStateEqual(first: GraphicObjectData, second: GraphicObjectData): boolean {
  return JSON.stringify({
    markerStart: first.markerStart,
    markerEnd: first.markerEnd
  }) === JSON.stringify({
    markerStart: second.markerStart,
    markerEnd: second.markerEnd
  });
}

export function reverseGraphicObjectGradientStopsForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjectGradientStopsForSelection(document, target, objectIds, reverseGradientStops);
}

export function rotateGraphicObjectGradientStopsForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjectGradientStopsForSelection(document, target, objectIds, rotateGradientStops);
}

export function addGraphicObjectGradientStopForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjectGradientStopsForSelection(document, target, objectIds, addGradientStop);
}

export function deleteGraphicObjectGradientStopForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjectGradientStopsForSelection(document, target, objectIds, deleteMiddleGradientStop);
}

export function deleteGraphicObjectGradientStopAtIndexForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  stopIndex: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjectGradientStopsForSelection(document, target, objectIds, (stops) =>
    deleteGradientStopAtIndex(stops, stopIndex)
  );
}

export function applyGraphicObjectGradientStopColorForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  stopIndex: number,
  color: string,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const normalized = normalizeWorkflowHexColor(color);
  if (!normalized) {
    return document;
  }

  return updateGraphicObjectGradientStopsForSelection(document, target, objectIds, (stops) =>
    updateGradientStopAtIndex(stops, stopIndex, (stop) => ({ ...stop, color: normalized }))
  );
}

export function applyGraphicObjectGradientStopOpacityForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  stopIndex: number,
  opacity: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const value = clampWorkflowUnit(opacity);
  return updateGraphicObjectGradientStopsForSelection(document, target, objectIds, (stops) =>
    updateGradientStopAtIndex(stops, stopIndex, (stop) => ({ ...stop, opacity: value }))
  );
}

export function applyGraphicObjectGradientStopOffsetForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  stopIndex: number,
  offset: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const value = clampWorkflowUnit(offset);
  return updateGradientPaintObjectsForSelection(document, target, objectIds, (paint) =>
    moveGraphicGradientStopOffset(paint, stopIndex, value)
  );
}

export function applyGraphicObjectOpacityToSelection(
  document: ChemDraftDocument,
  key: "opacity" | "fillOpacity" | "strokeOpacity",
  opacity: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const value = clampWorkflowUnit(opacity);
  return updateGraphicObjects(document, objectIds, (object) => ({
    ...object.style,
    [key]: value
  }), (object) => key === "opacity" || graphicObjectSupportsStyleCapability(
    object,
    key === "fillOpacity" ? "fill" : "stroke"
  ));
}

export function applyMoleculeObjectColorToSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  color: string,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const normalized = normalizeWorkflowHexColor(color);
  if (!normalized) {
    return document;
  }

  return updateMoleculeObjects(document, objectIds, (object) => {
    if (target === "fill") {
      const nextPaint = moleculePaintWithPrimaryColor(
        moleculeFillPaintForObject(object),
        normalized,
        moleculeFillPaintOpacity(object)
      );
      return {
        ...object.style,
        fillColor: legacyColorForGraphicPaint(nextPaint, "none"),
        fillMode: nextPaint.kind === "none" ? undefined : "solid",
        fillPaint: nextPaint
      };
    }

    return {
      ...object.style,
      bondColor: normalized,
      atomLabelColor: normalized,
      color: normalized,
      strokeColor: normalized,
      strokePaint: { kind: "solid", color: normalized, opacity: moleculeStrokePaintOpacity(object) }
    };
  });
}

export function applyMoleculeObjectNoneToSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  if (target !== "fill") {
    return document;
  }

  return updateMoleculeObjects(document, objectIds, (object) => ({
    ...object.style,
    fillColor: "none",
    fillMode: undefined,
    fillPaint: { kind: "none" }
  }));
}

export function applyMoleculeObjectPaintTypeToSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  paintType: GraphicStylePaintType,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  if (target !== "fill") {
    return document;
  }

  return updateMoleculeObjects(document, objectIds, (object) => {
    const paint = moleculePaintForType(object, paintType);
    return {
      ...object.style,
      fillColor: legacyColorForGraphicPaint(paint, "none"),
      fillMode: paint.kind === "none" ? undefined : "solid",
      fillPaint: paint
    };
  });
}

export function applyMoleculeObjectOpacityToSelection(
  document: ChemDraftDocument,
  key: "opacity" | "fillOpacity" | "strokeOpacity",
  opacity: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const value = clampWorkflowUnit(opacity);
  return updateMoleculeObjects(document, objectIds, (object) => ({
    ...object.style,
    [key]: value
  }));
}

export function clearMoleculeRingStyles(
  document: ChemDraftDocument,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateMoleculeObjects(document, objectIds, (object) => moleculeStyleWithRingStyles(object.style, {}));
}

export function applyMoleculeRingFillColor(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  color: string
): ChemDraftDocument {
  const normalized = normalizeWorkflowHexColor(color);
  if (!normalized) {
    return document;
  }

  return updateMoleculeRingStyle(document, target, (style) => ({
    ...style,
    fillColor: normalized,
    fillPaint: { kind: "solid", color: normalized }
  }));
}

export function applyMoleculeRingFillNone(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget
): ChemDraftDocument {
  return updateMoleculeRingStyle(document, target, (style) => ({
    ...style,
    fillColor: "none",
    fillPaint: { kind: "none" }
  }));
}

export function applyMoleculeRingFillOpacity(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  opacity: number
): ChemDraftDocument {
  return updateMoleculeRingStyle(document, target, (style) => ({
    ...style,
    fillOpacity: clampWorkflowUnit(opacity)
  }));
}

export function applyMoleculeRingEffect(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  effectKind: GraphicStyleEffectKind
): ChemDraftDocument {
  return updateMoleculeRingStyle(document, target, (style, object) => {
    const baseStyle = visualEffectBaseStyle(style);
    const existingEffects = visualEffectsForStyle(style);
    const inactiveEffects = inactiveVisualEffectsForStyle(style);
    if (effectKind === "none") {
      return visualStyleWithEffects(baseStyle, [], mergeVisualEffectsByKind(inactiveEffects, existingEffects));
    }

    if (existingEffects.some((effect) => effect.kind === effectKind)) {
      return visualStyleWithEffects(baseStyle, existingEffects, inactiveEffects);
    }

    const restoredEffect = inactiveEffects.find((effect) => effect.kind === effectKind) ??
      defaultVisualEffectForKind(`${object.id}-${target.ringKey}`, effectKind);
    return visualStyleWithEffects(
      baseStyle,
      [...existingEffects, restoredEffect],
      inactiveEffects.filter((effect) => effect.kind !== effectKind)
    );
  });
}

export function deactivateMoleculeRingEffect(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  effectKind: GraphicStyleAdjustableEffectKind
): ChemDraftDocument {
  return updateMoleculeRingStyle(document, target, (style) => {
    const existingEffects = visualEffectsForStyle(style);
    const removedEffect = existingEffects.find((effect) => effect.kind === effectKind);
    if (!removedEffect) {
      return style;
    }

    const baseStyle = visualEffectBaseStyle(style);
    return visualStyleWithEffects(
      baseStyle,
      existingEffects.filter((effect) => effect.kind !== effectKind),
      mergeVisualEffectsByKind(inactiveVisualEffectsForStyle(style), [removedEffect])
    );
  });
}

export function applyMoleculeRingEffectColor(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  effectKind: GraphicStyleAdjustableEffectKind,
  color: string
): ChemDraftDocument {
  const normalized = normalizeWorkflowHexColor(color);
  if (!normalized) {
    return document;
  }

  return updateMoleculeRingEffect(document, target, effectKind, (effect) => ({
    ...effect,
    color: normalized
  }));
}

export function applyMoleculeRingEffectOpacity(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  effectKind: GraphicStyleAdjustableEffectKind,
  opacity: number
): ChemDraftDocument {
  return updateMoleculeRingEffect(document, target, effectKind, (effect) => ({
    ...effect,
    opacity: clampWorkflowUnit(opacity)
  }));
}

export function applyMoleculeRingEffectSize(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  effectKind: GraphicStyleAdjustableEffectKind,
  size: number
): ChemDraftDocument {
  const value = clampWorkflowUnit(size);
  return updateMoleculeRingEffect(document, target, effectKind, (effect) => {
    if (effectKind === "shadow") {
      const sizePx = value * 24;
      return {
        ...effect,
        offsetX: sizePx,
        offsetY: sizePx,
        blurPx: sizePx * 0.5
      };
    }

    if (effectKind === "glow") {
      return {
        ...effect,
        blurPx: value * 18,
        spreadPx: value * 4
      };
    }

    return {
      ...effect,
      roughness: value * 3,
      bowing: value * 2,
      strokeWidth: Math.max(0.5, value * 4)
    };
  });
}

export function applyGraphicObjectEffectToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleEffectKind,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return applyVisualEffectToSelection(document, effectKind, objectIds);
}

export function applyVisualEffectToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleEffectKind,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateVisualEffectObjects(document, objectIds, (object) => {
    const baseStyle = visualEffectBaseStyle(object.style);
    const existingEffects = visualEffectsForStyle(object.style);
    const inactiveEffects = inactiveVisualEffectsForStyle(object.style);
    if (effectKind === "none") {
      return visualStyleForObject(object, baseStyle, [], mergeVisualEffectsByKind(inactiveEffects, existingEffects));
    }

    if (existingEffects.some((effect) => effect.kind === effectKind)) {
      return visualStyleForObject(object, baseStyle, existingEffects, inactiveEffects);
    }

    const restoredEffect = inactiveEffects.find((effect) => effect.kind === effectKind) ??
      defaultVisualEffectForKind(object.id, effectKind);
    return visualStyleForObject(
      object,
      baseStyle,
      [...existingEffects, restoredEffect],
      inactiveEffects.filter((effect) => effect.kind !== effectKind)
    );
  });
}

export function deactivateGraphicObjectEffectForSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return deactivateVisualEffectForSelection(document, effectKind, objectIds);
}

export function deactivateVisualEffectForSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateVisualEffectObjects(document, objectIds, (object) => {
    const existingEffects = visualEffectsForStyle(object.style);
    const removedEffect = existingEffects.find((effect) => effect.kind === effectKind);
    if (!removedEffect) {
      return object.style;
    }

    const baseStyle = visualEffectBaseStyle(object.style);
    return visualStyleForObject(
      object,
      baseStyle,
      existingEffects.filter((effect) => effect.kind !== effectKind),
      mergeVisualEffectsByKind(inactiveVisualEffectsForStyle(object.style), [removedEffect])
    );
  });
}

export function applyGraphicObjectEffectColorToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  color: string,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return applyVisualEffectColorToSelection(document, effectKind, color, objectIds);
}

export function applyVisualEffectColorToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  color: string,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateVisualEffectForSelection(document, effectKind, objectIds, (effect) => ({
    ...effect,
    color
  }));
}

export function applyGraphicObjectEffectOpacityToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  opacity: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return applyVisualEffectOpacityToSelection(document, effectKind, opacity, objectIds);
}

export function applyVisualEffectOpacityToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  opacity: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateVisualEffectForSelection(document, effectKind, objectIds, (effect) => ({
    ...effect,
    opacity: clampWorkflowUnit(opacity)
  }));
}

export function applyGraphicObjectEffectSizeToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  size: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return applyVisualEffectSizeToSelection(document, effectKind, size, objectIds);
}

export function applyVisualEffectSizeToSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  size: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const value = clampWorkflowUnit(size);
  return updateVisualEffectForSelection(document, effectKind, objectIds, (effect) => {
    if (effectKind === "shadow") {
      const sizePx = value * 24;
      return {
        ...effect,
        offsetX: sizePx,
        offsetY: sizePx,
        blurPx: sizePx * 0.5
      };
    }

    if (effectKind === "glow") {
      return {
        ...effect,
        blurPx: value * 18,
        spreadPx: value * 4
      };
    }

    return {
      ...effect,
      roughness: value * 3,
      bowing: value * 2,
      strokeWidth: Math.max(0.5, value * 4)
    };
  });
}

export function applyGraphicObjectStrokeStyleToSelection(
  document: ChemDraftDocument,
  style: Pick<GraphicObjectStyle, "strokeWidth" | "strokeDasharray" | "strokeLineCap" | "strokeLineJoin" | "strokeMiterLimit">,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjects(document, objectIds, (object) => ({
    ...object.style,
    ...graphicObjectSupportedStrokeStyle(object, style)
  }), (object) => Object.keys(graphicObjectSupportedStrokeStyle(object, style)).length > 0);
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
    nextDocument = applyObjectColorToDocumentObjects(nextDocument, color, targetObjectIds);
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
  const page = selectionPage(document);
  const selectedIds = new Set(document.selection.objectIds);
  const selectedChildIds = new Set(resolveGroupedDocumentObjectIds(page.objects, document.selection.objectIds));
  const affectedGroupIds = page.objects
    .filter((object): object is GroupObject =>
      object.type === "group" &&
      (selectedIds.has(object.id) || object.childObjectIds.some((childId) => selectedChildIds.has(childId)))
    )
    .map((object) => object.id);
  const objectIds = [...new Set([...selectedChildIds, ...affectedGroupIds])];
  if (objectIds.length === 0) {
    return document;
  }

  return applyPatches(
    document,
    objectIds.map((objectId) => ({ op: "removeObject", objectId })),
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

/**
 * What an electron-symbol tool places: a charge (circled by default, optionally plain or with a
 * radical dot — •+/•−), a bare unpaired electron, or a lone pair.
 */
export type NativeElectronMarkSpec =
  | { kind: "charge"; charge: NativeChargeValue; chargeStyle?: "circled" | "plain"; radical?: boolean }
  | { kind: "radical-dot" }
  | { kind: "lone-pair" };

export function nativeElectronMarkSpecFromCharge(charge: NativeChargeValue): NativeElectronMarkSpec {
  return { kind: "charge", charge };
}

export function applyChargeToolAtPoint(
  document: ChemDraftDocument,
  spec: NativeElectronMarkSpec | NativeChargeValue,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  return addChargeMarkAtPoint(document, page.id, normalizeElectronMarkSpec(spec), point);
}

function normalizeElectronMarkSpec(spec: NativeElectronMarkSpec | NativeChargeValue): NativeElectronMarkSpec {
  return typeof spec === "number" ? nativeElectronMarkSpecFromCharge(spec) : spec;
}

/**
 * The charge tool places a SELECTABLE, MOVABLE charge-mark object beside the atom — the mark is
 * the user's handle on the charge. Its chemical effect (deprotonation, formula, validity) is
 * applied by `reconcileNativeChargeMarks`, which every document commit runs: while the mark sits
 * within the association radius the atom carries its charge, and dragging the mark away hands
 * the proton back.
 */
export function applyChargeToolAtNativeAtom(
  document: ChemDraftDocument,
  spec: NativeElectronMarkSpec | NativeChargeValue,
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
  return point
    ? addChargeMarkAtPoint(document, page.id, normalizeElectronMarkSpec(spec), point, {
        objectId: molecule.id,
        atomId: target.atomId
      })
    : document;
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

  // The natural home for a charge is where the next atom would land if the chain kept growing
  // from here — the same slot the bond tool would use. Only a saturated atom (no growth slot)
  // falls back to the open-angle scoring below.
  const growth = previewNativeMoleculeBondGrowth(molecule, atom, pageWidth, pageHeight);
  if (growth && growth.atomId === atomId && !growth.targetAtomId) {
    return growth.newAtomPoint;
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

function addChargeMarkAtPoint(
  document: ChemDraftDocument,
  pageId: string,
  spec: NativeElectronMarkSpec,
  point: PagePoint,
  anchorAtom?: { objectId: string; atomId: string }
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
    markKind: spec.kind === "charge" ? "charge" as const : spec.kind,
    // An atom anchor makes the reconciliation sticky to the intended atom even when a crowded
    // placement lands the mark marginally closer to a neighbor.
    anchor: anchorAtom
      ? { kind: "atom" as const, objectId: anchorAtom.objectId, atomId: anchorAtom.atomId }
      : { kind: "point" as const, point: center },
    ...(spec.kind === "charge"
      ? {
          charge: spec.charge,
          ...(spec.chargeStyle ? { chargeStyle: spec.chargeStyle } : {}),
          ...(spec.radical ? { radical: true } : {})
        }
      : {})
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

/**
 * Applies the chemistry of the floating charge marks. A charge mark is a selectable, movable
 * object: while it sits within `nativeChargeAssociationRadiusPx` of an atom that can legally
 * carry its charge, that atom carries the charge (a minus beside a drawn OH removes the proton);
 * drag the mark away and the atom gets its proton back — no error badge, because the atom is
 * simply neutral again.
 *
 * Runs on every document commit, so it must be a cheap, IDEMPOTENT normalization. The invariant
 * that makes it self-contained: `atom.markCharge` records exactly the portion of
 * `atom.formalCharge` the marks contributed. Each pass strips that portion back out (recovering
 * the atom's intrinsic, drawn/imported charge), re-assigns every mark to its nearest supportable
 * atom, and writes both fields fresh — so deleted marks, moved molecules, edited elements, and
 * copies pasted without their mark all settle correctly with no history diffing.
 */
export function reconcileNativeChargeMarks(document: ChemDraftDocument): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) {
    return document;
  }

  const electronMarks = page.objects.filter((object): object is ElectronMarkObject =>
    object.type === "electron-mark" &&
    (object.markKind === "lone-pair" ||
      object.markKind === "radical-dot" ||
      (object.markKind === "charge" && nativeChargeValue(object.charge) !== undefined))
  );
  const molecules = page.objects.filter((object): object is MoleculeObject =>
    object.type === "molecule" && isEditableNativeMoleculeGraph(object)
  );
  const hasMarkContributions = molecules.some((molecule) =>
    molecule.atoms.some((atom) => (atom.markCharge ?? 0) !== 0 || (atom.markRadicals ?? 0) !== 0)
  );
  if (electronMarks.length === 0 && !hasMarkContributions) {
    return document;
  }

  // What a mark contributes to its atom. Lone pairs contribute nothing — they anchor for
  // positioning only, since implied lone pairs are already part of the octet arithmetic.
  const markContribution = (mark: ElectronMarkObject): { charge: number; radicals: number } => {
    if (mark.markKind === "charge") {
      return { charge: nativeChargeValue(mark.charge) ?? 0, radicals: mark.radical === true ? 1 : 0 };
    }
    return { charge: 0, radicals: mark.markKind === "radical-dot" ? 1 : 0 };
  };

  const atomKey = (moleculeId: string, atomId: string) => `${moleculeId}\n${atomId}`;
  const moleculeById = new Map(molecules.map((molecule) => [molecule.id, molecule] as const));
  const usageByMoleculeId = new Map(molecules.map((molecule) =>
    [molecule.id, atomBondOrderUsageMap(molecule.atoms, molecule.bonds)] as const
  ));
  // The atom-targeted tool drops the mark one bond length out (the chain-growth slot), so a
  // molecule drawn or pasted with longer bonds needs its radius to scale with its own bonds.
  const associationRadiusByMoleculeId = new Map(molecules.map((molecule) => [
    molecule.id,
    Math.max(nativeChargeAssociationRadiusPx, nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx * 1.15)
  ] as const));
  const assignedChargeByAtomKey = new Map<string, number>();
  const assignedRadicalsByAtomKey = new Map<string, number>();
  const anchorByMarkId = new Map<string, { objectId: string; atomId: string } | undefined>();

  const markCanAssociate = (
    moleculeId: string,
    atomId: string,
    center: PagePoint,
    contribution: { charge: number; radicals: number }
  ): boolean => {
    const molecule = moleculeById.get(moleculeId);
    const atom = molecule?.atoms.find((candidate) => candidate.id === atomId);
    if (!molecule || !atom ||
      distance(center, atom) > (associationRadiusByMoleculeId.get(moleculeId) ?? nativeChargeAssociationRadiusPx)) {
      return false;
    }

    const element = nativeElementFromAtomLabel(atom.element);
    if (!element) {
      return false;
    }

    if (contribution.charge === 0 && contribution.radicals === 0) {
      return true;
    }

    const key = atomKey(moleculeId, atomId);
    const intrinsicCharge = atom.formalCharge - (atom.markCharge ?? 0);
    const candidateCharge = intrinsicCharge + (assignedChargeByAtomKey.get(key) ?? 0) + contribution.charge;
    // Each unpaired electron occupies a bonding slot, so it counts as used valence.
    const candidateUsage = (usageByMoleculeId.get(moleculeId)?.get(atomId) ?? 0) +
      (assignedRadicalsByAtomKey.get(key) ?? 0) + contribution.radicals;
    return nativeAtomChargeSupportsValence(element, candidateUsage, candidateCharge);
  };

  const assign = (moleculeId: string, atomId: string, contribution: { charge: number; radicals: number }) => {
    const key = atomKey(moleculeId, atomId);
    assignedChargeByAtomKey.set(key, (assignedChargeByAtomKey.get(key) ?? 0) + contribution.charge);
    assignedRadicalsByAtomKey.set(key, (assignedRadicalsByAtomKey.get(key) ?? 0) + contribution.radicals);
  };

  // Pass 1 — sticky anchors. A mark that is already bound to an atom (by the charge tool or an
  // earlier pass) keeps that atom while it stays in radius and the chemistry stays legal, so
  // dragging a mark between two nearby atoms doesn't flicker and a crowded placement can't be
  // stolen by whichever neighbor happens to sit marginally closer.
  electronMarks.forEach((mark) => {
    if (mark.anchor.kind !== "atom" || !mark.anchor.objectId || !mark.anchor.atomId) {
      return;
    }

    const contribution = markContribution(mark);
    const center = nativeChargeMarkCenter(mark);
    if (markCanAssociate(mark.anchor.objectId, mark.anchor.atomId, center, contribution)) {
      assign(mark.anchor.objectId, mark.anchor.atomId, contribution);
      anchorByMarkId.set(mark.id, { objectId: mark.anchor.objectId, atomId: mark.anchor.atomId });
    }
  });

  // Pass 2 — everything else associates with its nearest supportable atom in radius, or floats.
  electronMarks.forEach((mark) => {
    if (anchorByMarkId.has(mark.id)) {
      return;
    }

    const contribution = markContribution(mark);
    const center = nativeChargeMarkCenter(mark);
    let nearest: { objectId: string; atomId: string; distance: number } | undefined;
    molecules.forEach((molecule) => {
      const associationRadius = associationRadiusByMoleculeId.get(molecule.id) ?? nativeChargeAssociationRadiusPx;
      molecule.atoms.forEach((atom) => {
        const separation = distance(center, atom);
        if (
          separation <= associationRadius &&
          (!nearest || separation < nearest.distance) &&
          markCanAssociate(molecule.id, atom.id, center, contribution)
        ) {
          nearest = { objectId: molecule.id, atomId: atom.id, distance: separation };
        }
      });
    });

    if (nearest) {
      assign(nearest.objectId, nearest.atomId, contribution);
      anchorByMarkId.set(mark.id, { objectId: nearest.objectId, atomId: nearest.atomId });
    } else {
      anchorByMarkId.set(mark.id, undefined);
    }
  });

  const nextObjectById = new Map<string, DocumentObject>();

  molecules.forEach((molecule) => {
    let atomsChanged = false;
    const atoms = molecule.atoms.map((atom) => {
      const key = atomKey(molecule.id, atom.id);
      const chargeContribution = assignedChargeByAtomKey.get(key) ?? 0;
      const radicalContribution = assignedRadicalsByAtomKey.get(key) ?? 0;
      const formalCharge = atom.formalCharge - (atom.markCharge ?? 0) + chargeContribution;
      if (
        formalCharge === atom.formalCharge &&
        (atom.markCharge ?? 0) === chargeContribution &&
        (atom.markRadicals ?? 0) === radicalContribution
      ) {
        return atom;
      }

      atomsChanged = true;
      const { markCharge: _previousMarkCharge, markRadicals: _previousMarkRadicals, ...baseAtom } = atom;
      return {
        ...baseAtom,
        formalCharge,
        ...(chargeContribution === 0 ? {} : { markCharge: chargeContribution }),
        ...(radicalContribution === 0 ? {} : { markRadicals: radicalContribution })
      };
    });
    if (atomsChanged) {
      nextObjectById.set(molecule.id, refreshNativeSingleBondGraph(molecule, atoms, molecule.bonds));
    }
  });

  electronMarks.forEach((mark) => {
    const anchor = anchorByMarkId.get(mark.id);
    const currentAnchor = mark.anchor.kind === "atom"
      ? { objectId: mark.anchor.objectId, atomId: mark.anchor.atomId }
      : undefined;
    if (anchor && (currentAnchor?.objectId !== anchor.objectId || currentAnchor?.atomId !== anchor.atomId)) {
      nextObjectById.set(mark.id, {
        ...mark,
        anchor: { kind: "atom", objectId: anchor.objectId, atomId: anchor.atomId }
      });
    } else if (!anchor && mark.anchor.kind === "atom") {
      nextObjectById.set(mark.id, {
        ...mark,
        anchor: { kind: "point", point: nativeChargeMarkCenter(mark) }
      });
    }
  });

  if (nextObjectById.size === 0) {
    return document;
  }

  const objects = page.objects.map((object) => nextObjectById.get(object.id) ?? object);
  return {
    ...document,
    pages: document.pages.map((candidate, index) => (index === 0 ? { ...candidate, objects } : candidate))
  };
}

/** Where an electron-pushing arrow may start or end: an atom, or a charge/electron mark. */
export type MechanismArrowEndpoint =
  | { kind: "atom"; objectId: string; atomId: string }
  | { kind: "object"; objectId: string };

function mechanismEndpointAnchor(endpoint: MechanismArrowEndpoint): MechanismArrowObject["source"] {
  return endpoint.kind === "atom"
    ? { kind: "atom", objectId: endpoint.objectId, atomId: endpoint.atomId }
    : { kind: "object", objectId: endpoint.objectId };
}

function mechanismArrowBounds(
  points: readonly PagePoint[]
): { x: number; y: number; width: number; height: number } {
  const paddingPx = 12;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - paddingPx;
  const minY = Math.min(...ys) - paddingPx;
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) + paddingPx - minX,
    height: Math.max(...ys) + paddingPx - minY
  };
}

/**
 * The electron-pushing tool commits here on release: an arrow anchored to chemistry at both ends.
 * The default Bezier controls are materialized immediately (one for a short hop, two for a long
 * reach) so the selection handles have concrete points for the user to drag.
 */
export function createMechanismArrowBetween(
  document: ChemDraftDocument,
  arrowKind: "full-headed" | "half-headed",
  source: MechanismArrowEndpoint,
  target: MechanismArrowEndpoint
): ChemDraftDocument {
  if (source.kind === target.kind &&
    source.objectId === target.objectId &&
    (source.kind !== "atom" || target.kind !== "atom" || source.atomId === target.atomId)) {
    return document;
  }

  const page = firstPage(document);
  const sourceAnchor = mechanismEndpointAnchor(source);
  const targetAnchor = mechanismEndpointAnchor(target);
  const sourcePoint = resolvePageAnchorPoint(page, sourceAnchor);
  const targetPoint = resolvePageAnchorPoint(page, targetAnchor);
  if (!sourcePoint || !targetPoint) {
    return document;
  }

  const controlPoints = defaultMechanismArrowControls(sourcePoint, targetPoint);
  const arrow = {
    id: nextObjectId(document, "mech"),
    type: "mechanism-arrow",
    ...mechanismArrowBounds([sourcePoint, targetPoint, ...controlPoints]),
    rotation: 0,
    style: {
      source: "chemdraft-native-mechanism"
    },
    arrowKind,
    source: sourceAnchor,
    target: targetAnchor,
    controlPoints,
    warnings: []
  } satisfies MechanismArrowObject;

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object: arrow },
      { op: "setSelection", pageId: page.id, objectIds: [arrow.id] }
    ],
    { now: phase4Timestamp }
  );
}

/** The draggable Bezier handle positions for a selected mechanism arrow. */
export function mechanismArrowHandlePoints(
  page: DocumentPage,
  object: MechanismArrowObject
): PagePoint[] {
  return mechanismArrowGeometry(page, object)?.controls ?? [];
}

/** Drags one Bezier handle: the user snakes the arrow around whatever is in the way. */
export function applyMechanismArrowControlPoint(
  document: ChemDraftDocument,
  objectId: string,
  controlIndex: number,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  const object = page.objects.find((candidate): candidate is MechanismArrowObject =>
    candidate.id === objectId && candidate.type === "mechanism-arrow"
  );
  if (!object) {
    return document;
  }

  const geometry = mechanismArrowGeometry(page, object);
  if (!geometry || controlIndex < 0 || controlIndex >= geometry.controls.length) {
    return document;
  }

  const controlPoints = geometry.controls.map((control, index) =>
    index === controlIndex ? { x: point.x, y: point.y } : control
  );

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId,
      changes: {
        controlPoints,
        ...mechanismArrowBounds([geometry.source, geometry.target, ...controlPoints])
      }
    },
    { now: phase4Timestamp }
  );
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
  const prunedNextMolecule = moleculeWithPrunedRingStyles(nextMolecule);

  if (prunedNextMolecule.atoms.length === 0) {
    return applyPatch(
      document,
      { op: "removeObject", objectId: molecule.id },
      { now: phase4Timestamp }
    );
  }

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: prunedNextMolecule },
    { now: phase4Timestamp }
  );
}

/**
 * Delete a multi-part ("parts") selection — every selected atom (with its incident
 * bonds) plus every explicitly selected bond — in one step, rebuilding the graph the
 * same way single-atom/bond deletion does. Removes the whole object if nothing remains.
 * This is the deletion path for lasso fragment selections (`kind: "parts"`), which the
 * single-target `applyNativeMoleculeDeleteTarget` cannot express.
 */
export function applyNativeMoleculePartsDelete(
  document: ChemDraftDocument,
  selection: { objectId: string; atomIds: readonly string[]; bondIds: readonly string[] }
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === selection.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const removeAtomIds = new Set(selection.atomIds);
  const removeBondIds = new Set(selection.bondIds);
  if (removeAtomIds.size === 0 && removeBondIds.size === 0) {
    return document;
  }

  const atoms = molecule.atoms.filter((atom) => !removeAtomIds.has(atom.id));
  const bonds = molecule.bonds.filter((bond) =>
    !removeBondIds.has(bond.id) &&
    !removeAtomIds.has(bond.fromAtomId) &&
    !removeAtomIds.has(bond.toAtomId)
  );
  if (atoms.length === molecule.atoms.length && bonds.length === molecule.bonds.length) {
    return document; // selection referenced nothing that still exists
  }

  if (atoms.length === 0) {
    return applyPatch(
      document,
      { op: "removeObject", objectId: molecule.id },
      { now: phase4Timestamp }
    );
  }

  return applyPatch(
    document,
    {
      op: "updateObject",
      objectId: molecule.id,
      changes: moleculeWithPrunedRingStyles(refreshNativeSingleBondGraph(molecule, atoms, bonds))
    },
    { now: phase4Timestamp }
  );
}

export function applyNativeMoleculePartDeleteTarget(
  document: ChemDraftDocument,
  target: NativeMoleculePartReorderTarget
): ChemDraftDocument {
  const page = firstPage(document);
  const molecule = page.objects.find((object): object is MoleculeObject =>
    object.id === target.objectId && object.type === "molecule"
  );
  if (!molecule || !isEditableNativeMoleculeGraph(molecule)) {
    return document;
  }

  const nextMolecule = nativeMoleculeAfterPartDelete(molecule, target);
  if (!nextMolecule) {
    return document;
  }
  const prunedNextMolecule = moleculeWithPrunedRingStyles(nextMolecule);

  if (prunedNextMolecule.atoms.length === 0) {
    return applyPatch(
      document,
      { op: "removeObject", objectId: molecule.id },
      { now: phase4Timestamp }
    );
  }

  return applyPatch(
    document,
    { op: "updateObject", objectId: molecule.id, changes: prunedNextMolecule },
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

  const drawingStyle = nativeDrawingStyleFromObjectStyle(molecule.style);
  const extension = planBondExtension({
    atoms: molecule.atoms,
    bonds: molecule.bonds,
    clickPoint: point,
    bondLength: drawingStyle.bondLengthPx,
    hitRadius: atomHitRadius,
    maxBondsPerAtom: nativeAtomInvalidGrowthLimit,
    targetBondAngleDegrees: drawingStyle.chainAngleDegrees,
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
    candidateDirections: nativeBondGrowthCandidateDirections(
      molecule,
      extension.sourceAtomId,
      extension.direction,
      drawingStyle.chainAngleDegrees
    ),
    newAtomPoint: extension.newAtomPoint,
    distanceToPointer: extension.distanceToClick,
    availableBonds: atomHit.availableBonds
  };
}

function nativeBondGrowthCandidateDirections(
  molecule: MoleculeObject,
  atomId: string,
  selectedDirection: PagePoint,
  targetBondAngleDegrees: number = ChemDraftSyntheticStylePreset.drawing.chainAngleDegrees
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
  const targetAngle = targetBondAngleDegrees * Math.PI / 180;
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

  const drawingStyle = nativeDrawingStyleFromObjectStyle(molecule.style);
  const extension = planFreeformBondExtension({
    atoms: molecule.atoms,
    bonds: molecule.bonds,
    sourceAtomId,
    endPoint: point,
    bondLength: drawingStyle.bondLengthPx,
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
    candidateDirections: nativeBondGrowthCandidateDirections(
      molecule,
      extension.sourceAtomId,
      extension.direction,
      drawingStyle.chainAngleDegrees
    ),
    newAtomPoint: extension.newAtomPoint,
    distanceToPointer: extension.distanceToClick,
    availableBonds: atomHit.availableBonds,
    customLength: extension.lengthMode === "custom",
    length,
    lengthAngstrom: Number((length / drawingStyle.bondLengthPx * nativeCarbonSingleBondLengthAngstrom).toFixed(3))
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

  if (object.type === "graphic") {
    const fillsVisible = graphicObjectHasVisibleFill(object);
    return styleColorChanges(object, {
      color,
      strokeColor: color,
      ...(fillsVisible ? { fillColor: color } : {})
    });
  }

  return styleColorChanges(object, {
    color,
    strokeColor: color,
    fillColor: color
  });
}

function graphicObjectHasVisibleFill(object: GraphicObject): boolean {
  if (!graphicObjectSupportsStyleCapability(object, "fill")) {
    return false;
  }

  const fillColor = object.style.fillColor;
  if (typeof fillColor === "string" && fillColor.toLowerCase() === "none") {
    return false;
  }

  return typeof fillColor === "string" ||
    object.style.fillMode === "solid" ||
    object.style.fillMode === "gloss" ||
    object.style.effect === "shadow" ||
    object.style.effects?.some((effect) => effect.kind === "shadow") === true;
}

function copyGraphicAppearanceStyle(target: GraphicObjectStyle, source: GraphicObjectStyle): void {
  copyGraphicFillStyle(target, source);
  copyGraphicStrokeStyle(target, source);
  copyOptionalGraphicStyleKey(target, source, "opacity");
  copyOptionalGraphicStyleKey(target, source, "effect");
  copyOptionalGraphicStyleKey(target, source, "effects");
  copyOptionalGraphicStyleKey(target, source, "inactiveEffects");
}

function copyGraphicFillStyle(target: GraphicObjectStyle, source: GraphicObjectStyle): void {
  copyOptionalGraphicStyleKey(target, source, "fillColor");
  copyOptionalGraphicStyleKey(target, source, "fillPaint");
  copyOptionalGraphicStyleKey(target, source, "fillOpacity");
  copyOptionalGraphicStyleKey(target, source, "fillMode");
}

function copyGraphicStrokeStyle(target: GraphicObjectStyle, source: GraphicObjectStyle): void {
  copyOptionalGraphicStyleKey(target, source, "color");
  copyOptionalGraphicStyleKey(target, source, "strokeColor");
  copyOptionalGraphicStyleKey(target, source, "strokePaint");
  copyOptionalGraphicStyleKey(target, source, "strokeOpacity");
  copyOptionalGraphicStyleKey(target, source, "strokeWidth");
  copyOptionalGraphicStyleKey(target, source, "strokeDasharray");
  copyOptionalGraphicStyleKey(target, source, "strokeLineCap");
  copyOptionalGraphicStyleKey(target, source, "strokeLineJoin");
  copyOptionalGraphicStyleKey(target, source, "strokeMiterLimit");
}

function copyOptionalGraphicStyleKey<K extends keyof GraphicObjectStyle>(
  target: GraphicObjectStyle,
  source: GraphicObjectStyle,
  key: K
): void {
  if (hasGraphicStyleKey(source, key)) {
    target[key] = source[key];
  } else {
    delete target[key];
  }
}

type GraphicStyleCapability = "fill" | "stroke" | "dash" | "lineCap" | "lineJoin" | "lineEnds";

function graphicObjectSupportsStyleCapability(object: GraphicObject, capability: GraphicStyleCapability): boolean {
  const capabilities = planNativeArtVisual(object, { coordinateSpace: "local" }).capabilities;
  if (capability === "fill") {
    return capabilities.supportsFill;
  }
  if (capability === "stroke") {
    return capabilities.supportsStroke;
  }
  if (capability === "dash") {
    return capabilities.supportsDash;
  }
  if (capability === "lineCap") {
    return capabilities.supportsLineCap;
  }
  if (capability === "lineEnds") {
    return capabilities.supportsLineCap;
  }
  return capabilities.supportsLineJoin;
}

function nativePaintObjectSupportsTarget(object: NativePaintObject, target: GraphicStylePaintTarget): boolean {
  return object.type === "graphic"
    ? graphicObjectSupportsStyleCapability(object, target)
    : target === "fill" || target === "stroke";
}

function nativePaintForObject(object: NativePaintObject, target: GraphicStylePaintTarget): GraphicPaint {
  if (object.type === "graphic") {
    return target === "fill" ? graphicFillPaintForObject(object) : graphicStrokePaintForObject(object);
  }

  return target === "fill" ? moleculeFillPaintForObject(object) : moleculeStrokePaintForObject(object);
}

function nativePaintStyleForObject(
  object: NativePaintObject,
  target: GraphicStylePaintTarget,
  paint: GraphicPaint
): Record<string, unknown> {
  if (object.type === "graphic") {
    return target === "fill"
      ? {
          ...object.style,
          fillColor: legacyColorForGraphicPaint(paint, "none"),
          fillMode: paint.kind === "none" ? undefined : "solid",
          fillPaint: paint
        }
      : {
          ...object.style,
          strokeColor: legacyColorForGraphicPaint(paint, "#111111"),
          strokePaint: paint
        };
  }

  if (target === "fill") {
    return {
      ...object.style,
      fillColor: legacyColorForGraphicPaint(paint, "none"),
      fillMode: paint.kind === "none" ? undefined : "solid",
      fillPaint: paint
    };
  }

  const strokeColor = legacyColorForGraphicPaint(paint, "#111111");
  return {
    ...object.style,
    bondColor: strokeColor,
    atomLabelColor: strokeColor,
    color: strokeColor,
    strokeColor,
    strokePaint: paint
  };
}

function graphicObjectSupportedStrokeStyle(
  object: GraphicObject,
  style: Pick<GraphicObjectStyle, "strokeWidth" | "strokeDasharray" | "strokeLineCap" | "strokeLineJoin" | "strokeMiterLimit">
): Partial<GraphicObjectStyle> {
  const changesDash = hasGraphicStyleKey(style, "strokeDasharray");
  const next: Partial<GraphicObjectStyle> = {};
  if (hasGraphicStyleKey(style, "strokeWidth") && graphicObjectSupportsStyleCapability(object, "dash")) {
    next.strokeWidth = style.strokeWidth;
  }
  if (changesDash && graphicObjectSupportsStyleCapability(object, "dash")) {
    next.strokeDasharray = style.strokeDasharray;
  }
  if (
    hasGraphicStyleKey(style, "strokeLineCap") &&
    (changesDash
      ? graphicObjectSupportsStyleCapability(object, "dash")
      : graphicObjectSupportsStyleCapability(object, "lineCap"))
  ) {
    next.strokeLineCap = style.strokeLineCap;
  }
  if (hasGraphicStyleKey(style, "strokeLineJoin") && graphicObjectSupportsStyleCapability(object, "lineJoin")) {
    next.strokeLineJoin = style.strokeLineJoin;
  }
  if (hasGraphicStyleKey(style, "strokeMiterLimit") && graphicObjectSupportsStyleCapability(object, "lineJoin")) {
    next.strokeMiterLimit = style.strokeMiterLimit;
  }
  return next;
}

function hasGraphicStyleKey(style: Partial<GraphicObjectStyle>, key: keyof GraphicObjectStyle): boolean {
  return Object.prototype.hasOwnProperty.call(style, key);
}

function visualEffectBaseStyle(style: Record<string, unknown>): Record<string, unknown> {
  const {
    effect: _legacyEffect,
    visualEffects: _visualEffects,
    inactiveVisualEffects: _inactiveVisualEffects,
    effects: _effects,
    inactiveEffects: _inactiveEffects,
    ...baseStyle
  } = style;
  return baseStyle;
}

function visualStyleForObject(
  object: GraphicObject | MoleculeObject,
  baseStyle: Record<string, unknown>,
  effects: readonly VisualEffect[],
  inactiveEffects: readonly VisualEffect[]
): Record<string, unknown> {
  return visualStyleWithEffects(baseStyle, effects, inactiveEffects, {
    includeGraphicAliases: object.type === "graphic"
  });
}

function updateVisualEffectForSelection(
  document: ChemDraftDocument,
  effectKind: GraphicStyleAdjustableEffectKind,
  objectIds: readonly string[],
  updateEffect: (effect: VisualEffect, object: GraphicObject | MoleculeObject) => VisualEffect
): ChemDraftDocument {
  return updateVisualEffectObjects(document, objectIds, (object) => {
    const baseStyle = visualEffectBaseStyle(object.style);
    const existingEffects = visualEffectsForStyle(object.style);
    const inactiveEffects = inactiveVisualEffectsForStyle(object.style);
    const nextEffects = existingEffects.some((effect) => effect.kind === effectKind)
      ? existingEffects.map((effect) => effect.kind === effectKind ? updateEffect(effect, object) : effect)
      : [...existingEffects, updateEffect(defaultVisualEffectForKind(object.id, effectKind), object)];
    return visualStyleForObject(
      object,
      baseStyle,
      nextEffects,
      inactiveEffects.filter((effect) => effect.kind !== effectKind)
    );
  });
}

function updateGraphicObjects(
  document: ChemDraftDocument,
  objectIds: readonly string[],
  updateStyle: (object: GraphicObject) => GraphicObjectStyle,
  supportsUpdate: (object: GraphicObject) => boolean = () => true
): ChemDraftDocument {
  const targetIds = new Set(objectIds);
  if (targetIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "graphic" || !targetIds.has(object.id) || !supportsUpdate(object)) {
        return [];
      }

      const nextStyle = updateStyle(object);
      return graphicStylesEqual(object.style, nextStyle)
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: {
              style: nextStyle
            }
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

/** Sibling of {@link updateGraphicObjects} for `data` patches (markers live in data, not style).
 *  The updater returns the ORIGINAL `object.data` reference to signal "no change" — reference
 *  equality is the bail, so no-op invokes never create patches (or undo entries). */
function updateGraphicObjectData(
  document: ChemDraftDocument,
  objectIds: readonly string[],
  updateData: (object: GraphicObject) => GraphicObjectData,
  supportsUpdate: (object: GraphicObject) => boolean = () => true
): ChemDraftDocument {
  const targetIds = new Set(objectIds);
  if (targetIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "graphic" || !targetIds.has(object.id) || !supportsUpdate(object)) {
        return [];
      }

      const nextData = updateData(object);
      return nextData === object.data
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: {
              data: nextData
            }
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

/**
 * Ends that can carry an arrowhead marker: open-stroke paths whose terminals the marker machinery
 * plans. Keyed off `isOpenStroke` (not "has a handle today") so an arrow with a bare tail still
 * counts — growing a tail head is the point. Retrosynthetic arrows are excluded: their "⇒" head is
 * path geometry, not a marker, so a marker command would draw a second head.
 */
export function graphicObjectSupportsMarkers(object: DocumentObject | undefined): boolean {
  if (!object || object.type !== "graphic" || !graphicShapeCanCarryMarkers(object)) {
    return false;
  }
  return graphicObjectSupportsMarkersWithPlan(object, planNativeArtVisual(object, { coordinateSpace: "local" }));
}

/** The half of the test that needs no plan, so the plan is only built when it can still change the
 *  answer. */
function graphicShapeCanCarryMarkers(object: GraphicObject): boolean {
  return object.graphicKind === "path" && object.data.dualShaftParallel !== true;
}

/**
 * {@link graphicObjectSupportsMarkers} for a caller that already holds the object's render plan.
 *
 * Planning is not cheap — it samples path geometry — and `createArtInspectorModel` is keyed on
 * `document`, which is replaced on every pointermove frame. It planned each selected graphic once
 * up front and then called the planless helper twice more (the `supportsMarkers` map and
 * `skippedForControl`), so a selected path was planned two to three times per frame with the answer
 * already in hand.
 */
export function graphicObjectSupportsMarkersWithPlan(
  object: GraphicObject,
  plan: NativeArtVisualPlan
): boolean {
  return graphicShapeCanCarryMarkers(object) && plan.capabilities.isOpenStroke === true;
}

/**
 * Set one end's arrowhead kind on every marker-capable graphic in the selection. `kind: "none"`
 * deletes the marker key rather than storing `{kind: "none"}` — the render plan treats both as
 * absent, and a deleted key keeps "Set as Default Arrow Style"'s never-adds-or-removes-heads
 * contract honest. Adding a head to a bare end seeds its size from the opposite head (falling back
 * to the 16px tool default) so the pair matches.
 */
export function applyGraphicObjectMarkerKindToSelection(
  document: ChemDraftDocument,
  markerId: NativeArtMarkerHandleId,
  kind: GraphicMarker["kind"],
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  return updateGraphicObjectData(document, objectIds, (object) => {
    const current = object.data[markerId];
    if (kind === "none") {
      if (!current) {
        return object.data;
      }
      const nextData = { ...object.data };
      delete nextData[markerId];
      return nextData;
    }
    if (current?.kind === kind) {
      return object.data;
    }
    const otherId: NativeArtMarkerHandleId = markerId === "markerStart" ? "markerEnd" : "markerStart";
    const seedSizePx = current?.sizePx ?? object.data[otherId]?.sizePx ?? 16;
    return {
      ...object.data,
      [markerId]: {
        kind,
        sizePx: seedSizePx,
        ...(current?.angleDegrees !== undefined ? { angleDegrees: current.angleDegrees } : {})
      }
    };
  }, graphicObjectSupportsMarkers);
}

/** Set every non-none head's size on the selection's marker-capable graphics, snapped to the same
 *  4px steps the canvas handle drags between (both ends together, matching the handle's symmetric
 *  default — asymmetric sizing stays a canvas Shift-drag capability). */
export function applyGraphicObjectMarkerSizeToSelection(
  document: ChemDraftDocument,
  sizePx: number,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const snapped = snapGraphicMarkerSizePx(sizePx);
  return updateGraphicObjectData(document, objectIds, (object) => {
    let nextData = object.data;
    for (const markerId of ["markerStart", "markerEnd"] as const) {
      const marker = nextData[markerId];
      if (marker && marker.kind !== "none" && marker.sizePx !== snapped) {
        nextData = { ...nextData, [markerId]: { ...marker, sizePx: snapped } };
      }
    }
    return nextData;
  }, graphicObjectSupportsMarkers);
}

/** Graphics that draw a shaft mark (the no-reaction ✗). */
export function graphicObjectHasShaftMark(object: DocumentObject | undefined): boolean {
  return object?.type === "graphic" && object.data.shaftMark === "cross";
}

/** Set (or, with undefined, return to stroke-derived "auto") the no-reaction cross size on
 *  every shaft-marked graphic in the selection. Explicit sizes clamp to the engine's bounds. */
export function applyGraphicShaftMarkSizeToSelection(
  document: ChemDraftDocument,
  sizePx: number | undefined,
  objectIds: readonly string[] = document.selection.objectIds
): ChemDraftDocument {
  const clamped = sizePx === undefined ? undefined : clampGraphicShaftMarkSizePx(sizePx);
  return updateGraphicObjectData(document, objectIds, (object) => {
    if (clamped === undefined) {
      if (object.data.shaftMarkSizePx === undefined) {
        return object.data;
      }
      const nextData = { ...object.data };
      delete nextData.shaftMarkSizePx;
      return nextData;
    }
    if (object.data.shaftMarkSizePx === clamped) {
      return object.data;
    }
    return { ...object.data, shaftMarkSizePx: clamped };
  }, graphicObjectHasShaftMark);
}

function updateVisualEffectObjects(
  document: ChemDraftDocument,
  objectIds: readonly string[],
  updateStyle: (object: GraphicObject | MoleculeObject) => Record<string, unknown>
): ChemDraftDocument {
  const targetIds = new Set(objectIds);
  if (targetIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if ((object.type !== "graphic" && object.type !== "molecule") || !targetIds.has(object.id)) {
        return [];
      }

      const nextStyle = updateStyle(object);
      return JSON.stringify(object.style) === JSON.stringify(nextStyle)
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: {
              style: nextStyle
            }
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

function updateMoleculeObjects(
  document: ChemDraftDocument,
  objectIds: readonly string[],
  updateStyle: (object: MoleculeObject) => Record<string, unknown>
): ChemDraftDocument {
  const targetIds = new Set(objectIds);
  if (targetIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule" || !targetIds.has(object.id)) {
        return [];
      }

      const nextStyle = updateStyle(object);
      return JSON.stringify(object.style) === JSON.stringify(nextStyle)
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: {
              style: nextStyle
            }
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

function representativeNativeMoleculeBondLength(molecule: MoleculeObject): number | undefined {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const heavyDistances: number[] = [];
  const allDistances: number[] = [];
  for (const bond of molecule.bonds) {
    const from = atomById.get(bond.fromAtomId);
    const to = atomById.get(bond.toAtomId);
    if (!from || !to) {
      continue;
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (!Number.isFinite(distance) || distance <= 0) {
      continue;
    }
    allDistances.push(distance);
    if (nativeElementFromAtomLabel(from.element) !== "H" && nativeElementFromAtomLabel(to.element) !== "H") {
      heavyDistances.push(distance);
    }
  }
  return medianNumber(heavyDistances.length > 0 ? heavyDistances : allDistances);
}

function scaledMoleculeToTargetBondLength(
  molecule: MoleculeObject,
  targetBondLengthPx: number,
  representativeBondLengthPx: number,
  nextStyle: Record<string, unknown>
): MoleculeObject {
  const scale = targetBondLengthPx / representativeBondLengthPx;
  if (!Number.isFinite(scale) || scale <= 0) {
    return normalizeNativeMoleculeGeometry({ ...molecule, style: nextStyle });
  }

  const center = moleculeAtomBoundsCenter(molecule.atoms);
  if (!center) {
    return normalizeNativeMoleculeGeometry({ ...molecule, style: nextStyle });
  }

  const atoms = molecule.atoms.map((atom) => ({
    ...atom,
    x: center.x + (atom.x - center.x) * scale,
    y: center.y + (atom.y - center.y) * scale,
    ...(atom.labelOffset ? {
      labelOffset: {
        x: atom.labelOffset.x * scale,
        y: atom.labelOffset.y * scale
      }
    } : {})
  }));

  return normalizeNativeMoleculeGeometry({
    ...molecule,
    style: nextStyle,
    atoms
  });
}

function moleculeAtomBoundsCenter(atoms: readonly MoleculeAtom[]): PagePoint | undefined {
  if (atoms.length === 0) {
    return undefined;
  }
  const minX = Math.min(...atoms.map((atom) => atom.x));
  const maxX = Math.max(...atoms.map((atom) => atom.x));
  const minY = Math.min(...atoms.map((atom) => atom.y));
  const maxY = Math.max(...atoms.map((atom) => atom.y));
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2
  };
}

function moleculeObjectChanges(previous: MoleculeObject, next: MoleculeObject): Partial<MoleculeObject> {
  const changes: Partial<MoleculeObject> = {};
  if (JSON.stringify(previous.style) !== JSON.stringify(next.style)) {
    changes.style = next.style;
  }
  if (JSON.stringify(previous.atoms) !== JSON.stringify(next.atoms)) {
    changes.atoms = next.atoms;
  }
  if (previous.x !== next.x) {
    changes.x = next.x;
  }
  if (previous.y !== next.y) {
    changes.y = next.y;
  }
  if (previous.width !== next.width) {
    changes.width = next.width;
  }
  if (previous.height !== next.height) {
    changes.height = next.height;
  }
  return changes;
}

function medianNumber(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}

type MoleculeRingStyleRecord = Record<string, unknown>;

function updateMoleculeRingStyle(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  updateStyle: (style: MoleculeRingStyleRecord, object: MoleculeObject) => MoleculeRingStyleRecord
): ChemDraftDocument {
  return updateMoleculeObjects(document, [target.objectId], (object) => {
    if (!nativeMoleculeRings(object).some((ring) => ring.ringKey === target.ringKey)) {
      return object.style;
    }

    const ringStyles = moleculeRingStyleMap(object.style.ringStyles);
    const currentStyle = ringStyles[target.ringKey] ?? {};
    const nextStyle = compactMoleculeRingStyle(updateStyle(currentStyle, object));
    const nextRingStyles = { ...ringStyles };
    if (Object.keys(nextStyle).length > 0) {
      nextRingStyles[target.ringKey] = nextStyle;
    } else {
      delete nextRingStyles[target.ringKey];
    }
    return moleculeStyleWithRingStyles(object.style, nextRingStyles);
  });
}

function updateMoleculeRingEffect(
  document: ChemDraftDocument,
  target: NativeMoleculeRingTarget,
  effectKind: GraphicStyleAdjustableEffectKind,
  updateEffect: (effect: VisualEffect, object: MoleculeObject) => VisualEffect
): ChemDraftDocument {
  return updateMoleculeRingStyle(document, target, (style, object) => {
    const baseStyle = visualEffectBaseStyle(style);
    const existingEffects = visualEffectsForStyle(style);
    const inactiveEffects = inactiveVisualEffectsForStyle(style);
    const nextEffects = existingEffects.some((effect) => effect.kind === effectKind)
      ? existingEffects.map((effect) => effect.kind === effectKind ? updateEffect(effect, object) : effect)
      : [...existingEffects, updateEffect(defaultVisualEffectForKind(`${object.id}-${target.ringKey}`, effectKind), object)];
    return visualStyleWithEffects(
      baseStyle,
      nextEffects,
      inactiveEffects.filter((effect) => effect.kind !== effectKind)
    );
  });
}

export function pruneMoleculeRingStyles(
  document: ChemDraftDocument,
  objectId: string
): ChemDraftDocument {
  return updateMoleculeObjects(document, [objectId], (object) => moleculeWithPrunedRingStyles(object).style);
}

function moleculeWithPrunedRingStyles(molecule: MoleculeObject): MoleculeObject {
  const ringStyles = moleculeRingStyleMap(molecule.style.ringStyles);
  if (Object.keys(ringStyles).length === 0) {
    return molecule;
  }

  const validRingKeys = new Set(nativeMoleculeRings(molecule).map((ring) => ring.ringKey));
  const nextRingStyles = Object.fromEntries(
    Object.entries(ringStyles).filter(([ringKey]) => validRingKeys.has(ringKey))
  );
  const nextStyle = moleculeStyleWithRingStyles(molecule.style, nextRingStyles);
  return JSON.stringify(molecule.style) === JSON.stringify(nextStyle)
    ? molecule
    : { ...molecule, style: nextStyle };
}

function moleculeStyleWithRingStyles(
  style: Record<string, unknown>,
  ringStyles: Record<string, MoleculeRingStyleRecord>
): Record<string, unknown> {
  const { ringStyles: _ringStyles, ...baseStyle } = style;
  return Object.keys(ringStyles).length > 0
    ? { ...baseStyle, ringStyles }
    : baseStyle;
}

function moleculeRingStyleMap(value: unknown): Record<string, MoleculeRingStyleRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, style]) => style && typeof style === "object" && !Array.isArray(style))
      .map(([ringKey, style]) => [ringKey, { ...(style as MoleculeRingStyleRecord) }])
  );
}

function compactMoleculeRingStyle(style: MoleculeRingStyleRecord): MoleculeRingStyleRecord {
  return Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined)
  );
}

function graphicFillPaintForObject(object: GraphicObject): GraphicPaint {
  if (object.style.fillPaint) {
    return object.style.fillPaint;
  }

  const fillColor = typeof object.style.fillColor === "string" ? object.style.fillColor : "none";
  const color = normalizeWorkflowHexColor(fillColor);
  return color
    ? { kind: "solid", color, opacity: graphicFillPaintOpacity(object) }
    : { kind: "none" };
}

function graphicStrokePaintForObject(object: GraphicObject): GraphicPaint {
  if (object.style.strokePaint) {
    return object.style.strokePaint;
  }

  const color = normalizeWorkflowHexColor(
    typeof object.style.strokeColor === "string" ? object.style.strokeColor : undefined
  ) ?? "#111111";
  return { kind: "solid", color, opacity: graphicStrokePaintOpacity(object) };
}

function moleculeFillPaintForObject(object: MoleculeObject): GraphicPaint {
  const paint = graphicPaintFromUnknown(object.style.fillPaint);
  if (paint) {
    return paint;
  }

  const fillColor = typeof object.style.fillColor === "string" ? object.style.fillColor : "none";
  const color = normalizeWorkflowHexColor(fillColor);
  return color
    ? { kind: "solid", color, opacity: moleculeFillPaintOpacity(object) }
    : { kind: "none" };
}

function moleculeStrokePaintForObject(object: MoleculeObject): GraphicPaint {
  const paint = graphicPaintFromUnknown(object.style.strokePaint);
  if (paint) {
    return paint;
  }

  const color = normalizeWorkflowHexColor(
    typeof object.style.bondColor === "string" ? object.style.bondColor :
      typeof object.style.strokeColor === "string" ? object.style.strokeColor :
        typeof object.style.color === "string" ? object.style.color : undefined
  ) ?? "#111111";
  return { kind: "solid", color, opacity: moleculeStrokePaintOpacity(object) };
}

function graphicPaintForType(
  object: GraphicObject,
  target: GraphicStylePaintTarget,
  paintType: GraphicPaint["kind"]
): GraphicPaint {
  if (paintType === "none") {
    return { kind: "none" };
  }

  const color = graphicPaintBaseColor(object, target);
  const opacity = target === "fill" ? graphicFillPaintOpacity(object) : graphicStrokePaintOpacity(object);
  if (paintType === "solid") {
    return { kind: "solid", color, opacity };
  }

  const companionColor = gradientCompanionColor(color);
  if (paintType === "linear-gradient") {
    return {
      kind: "linear-gradient",
      units: "object",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stops: [
        { offset: 0, color },
        { offset: 1, color: companionColor }
      ]
    };
  }

  return {
    kind: "radial-gradient",
    units: "object",
    cx: 0.5,
    cy: 0.5,
    r: 0.72,
    fx: 0.32,
    fy: 0.28,
    stops: [
      { offset: 0, color: companionColor },
      { offset: 1, color }
    ]
  };
}

function moleculePaintForType(
  object: MoleculeObject,
  paintType: GraphicStylePaintType
): GraphicPaint {
  if (paintType === "none") {
    return { kind: "none" };
  }

  const color = moleculePaintBaseColor(object, "fill");
  const opacity = moleculeFillPaintOpacity(object);
  if (paintType === "solid") {
    return { kind: "solid", color, opacity };
  }

  const companionColor = gradientCompanionColor(color);
  if (paintType === "linear-gradient") {
    return {
      kind: "linear-gradient",
      units: "object",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stops: [
        { offset: 0, color },
        { offset: 1, color: companionColor }
      ]
    };
  }

  return {
    kind: "radial-gradient",
    units: "object",
    cx: 0.38,
    cy: 0.32,
    r: 0.78,
    fx: 0.28,
    fy: 0.22,
    stops: [
      { offset: 0, color: companionColor },
      { offset: 1, color }
    ]
  };
}

function graphicPaintBaseColor(object: GraphicObject, target: GraphicStylePaintTarget): string {
  const paint = target === "fill" ? graphicFillPaintForObject(object) : graphicStrokePaintForObject(object);
  const fallback = target === "fill"
    ? normalizeWorkflowHexColor(typeof object.style.fillColor === "string" ? object.style.fillColor : undefined) ?? "#111111"
    : normalizeWorkflowHexColor(
      typeof object.style.strokeColor === "string" ? object.style.strokeColor : undefined
    ) ?? "#111111";
  return legacyColorForGraphicPaint(paint, fallback);
}

function moleculePaintBaseColor(object: MoleculeObject, target: GraphicStylePaintTarget): string {
  const paint = target === "fill" ? moleculeFillPaintForObject(object) : moleculeStrokePaintForObject(object);
  const fallback = target === "fill"
    ? normalizeWorkflowHexColor(typeof object.style.fillColor === "string" ? object.style.fillColor : undefined) ?? "#1d7f68"
    : normalizeWorkflowHexColor(
      typeof object.style.bondColor === "string" ? object.style.bondColor :
        typeof object.style.strokeColor === "string" ? object.style.strokeColor : undefined
    ) ?? "#111111";
  return legacyColorForGraphicPaint(paint, fallback);
}

function gradientCompanionColor(color: string): string {
  return color.toLowerCase() === "#ffffff" ? "#1d7f68" : "#ffffff";
}

function graphicPaintWithPrimaryColor(paint: GraphicPaint, color: string, opacity: number): GraphicPaint {
  if (paint.kind === "linear-gradient" || paint.kind === "radial-gradient") {
    return {
      ...paint,
      stops: gradientStopsWithPrimaryColor(paint.stops, color)
    };
  }

  return { kind: "solid", color, opacity };
}

function moleculePaintWithPrimaryColor(paint: GraphicPaint, color: string, opacity: number): GraphicPaint {
  if (paint.kind === "linear-gradient" || paint.kind === "radial-gradient") {
    return {
      ...paint,
      stops: gradientStopsWithPrimaryColor(paint.stops, color)
    };
  }

  return { kind: "solid", color, opacity };
}

function gradientStopsWithPrimaryColor(
  stops: Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }>["stops"],
  color: string
): Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }>["stops"] {
  const normalizedStopColors = stops.map((stop) => normalizeWorkflowHexColor(stop.color));
  const hasBaseStop = normalizedStopColors.some((stopColor) => stopColor !== undefined && stopColor !== "#ffffff");
  return stops.map((stop, index) => {
    const normalizedStopColor = normalizedStopColors[index];
    const shouldUpdate = hasBaseStop
      ? normalizedStopColor !== "#ffffff"
      : index === stops.length - 1;
    return shouldUpdate ? { ...stop, color } : stop;
  });
}

function updateGraphicObjectGradientStopsForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[],
  updateStops: (
    stops: GradientGraphicPaint["stops"]
  ) => GradientGraphicPaint["stops"]
): ChemDraftDocument {
  return updateGradientPaintObjectsForSelection(document, target, objectIds, (paint) => ({
    ...paint,
    stops: updateStops(paint.stops)
  }));
}

function updateGradientPaintObjectsForSelection(
  document: ChemDraftDocument,
  target: GraphicStylePaintTarget,
  objectIds: readonly string[],
  updatePaint: (paint: GradientGraphicPaint, object: NativePaintObject) => GradientGraphicPaint
): ChemDraftDocument {
  const targetIds = new Set(objectIds);
  if (targetIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (
        (object.type !== "graphic" && object.type !== "molecule") ||
        !targetIds.has(object.id) ||
        !nativePaintObjectSupportsTarget(object, target)
      ) {
        return [];
      }

      const paint = nativePaintForObject(object, target);
      if (paint.kind !== "linear-gradient" && paint.kind !== "radial-gradient") {
        return [];
      }

      const nextPaint = updatePaint(paint, object);
      const nextStyle = nativePaintStyleForObject(object, target, nextPaint);
      return JSON.stringify(object.style) === JSON.stringify(nextStyle)
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes: {
              style: nextStyle
            }
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

function reverseGradientStops(
  stops: GradientGraphicPaint["stops"]
): GradientGraphicPaint["stops"] {
  return stops
    .map((stop) => ({
      ...stop,
      offset: clampWorkflowUnit(1 - stop.offset)
    }))
    .sort((left, right) => left.offset - right.offset);
}

function rotateGradientStops(
  stops: GradientGraphicPaint["stops"]
): GradientGraphicPaint["stops"] {
  const sorted = sortedGradientStops(stops);
  if (sorted.length <= 1) {
    return sorted;
  }

  const rotatedPayloads = [
    sorted[sorted.length - 1]!,
    ...sorted.slice(0, -1)
  ];
  return sortedGradientStops(sorted.map((stop, index) => {
    const payload = rotatedPayloads[index]!;
    const opacity = gradientStopOpacity(payload);
    return {
      offset: stop.offset,
      color: gradientStopColor(payload),
      ...(opacity < 1 ? { opacity } : {})
    };
  }));
}

function addGradientStop(
  stops: GradientGraphicPaint["stops"]
): GradientGraphicPaint["stops"] {
  const sorted = sortedGradientStops(stops);
  if (sorted.length >= MAX_GRAPHIC_GRADIENT_STOPS) {
    return sorted;
  }
  if (sorted.length === 0) {
    return [
      { offset: 0, color: "#111111" },
      { offset: 1, color: "#ffffff" }
    ];
  }
  if (sorted.length === 1) {
    const only = sorted[0]!;
    return sortedGradientStops([
      only,
      { ...only, offset: only.offset <= 0.5 ? 1 : 0 }
    ]);
  }

  let leftIndex = 0;
  let widestGap = -1;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const gap = sorted[index + 1]!.offset - sorted[index]!.offset;
    if (gap > widestGap) {
      widestGap = gap;
      leftIndex = index;
    }
  }

  const left = sorted[leftIndex]!;
  const right = sorted[leftIndex + 1]!;
  const offset = clampWorkflowUnit((left.offset + right.offset) / 2);
  const color = mixWorkflowHexColors(gradientStopColor(left), gradientStopColor(right), 0.5);
  const opacity = (gradientStopOpacity(left) + gradientStopOpacity(right)) / 2;
  const stop = {
    offset,
    color,
    ...(opacity < 1 ? { opacity: clampWorkflowUnit(opacity) } : {})
  };

  return sortedGradientStops([
    ...sorted.slice(0, leftIndex + 1),
    stop,
    ...sorted.slice(leftIndex + 1)
  ]);
}

function deleteMiddleGradientStop(
  stops: GradientGraphicPaint["stops"]
): GradientGraphicPaint["stops"] {
  const sorted = sortedGradientStops(stops);
  if (sorted.length <= 2) {
    return sorted;
  }

  let deleteIndex = 1;
  let closestToMiddle = Number.POSITIVE_INFINITY;
  for (let index = 1; index < sorted.length - 1; index += 1) {
    const distance = Math.abs(sorted[index]!.offset - 0.5);
    if (distance < closestToMiddle) {
      closestToMiddle = distance;
      deleteIndex = index;
    }
  }

  return sorted.filter((_, index) => index !== deleteIndex);
}

function deleteGradientStopAtIndex(
  stops: GradientGraphicPaint["stops"],
  stopIndex: number
): GradientGraphicPaint["stops"] {
  const sorted = sortedGradientStops(stops);
  if (sorted.length <= 2) {
    return sorted;
  }

  const deleteIndex = Math.max(0, Math.min(sorted.length - 1, Math.round(stopIndex)));
  return sorted.filter((_, index) => index !== deleteIndex);
}

function moveGraphicGradientStopOffset(
  paint: GradientGraphicPaint,
  stopIndex: number,
  offset: number
): GradientGraphicPaint {
  const sorted = sortedGradientStops(paint.stops);
  const editIndex = Math.round(stopIndex);
  if (editIndex < 0 || editIndex >= sorted.length) {
    return { ...paint, stops: sorted };
  }

  if (paint.kind === "linear-gradient" && sorted.length >= 2) {
    if (editIndex === 0) {
      return moveLinearGradientStartStop(paint, sorted, offset);
    }
    if (editIndex === sorted.length - 1) {
      return moveLinearGradientEndStop(paint, sorted, offset);
    }
  }

  return {
    ...paint,
    stops: updateGradientStopAtIndex(sorted, editIndex, (stop) => ({ ...stop, offset }))
  };
}

function moveLinearGradientStartStop(
  paint: Extract<GraphicPaint, { kind: "linear-gradient" }>,
  sortedStops: GradientGraphicPaint["stops"],
  offset: number
): Extract<GraphicPaint, { kind: "linear-gradient" }> {
  const nextStop = sortedStops[1];
  const maximumOffset = nextStop
    ? Math.max(0, nextStop.offset - GRAPHIC_GRADIENT_ENDPOINT_STOP_GAP)
    : 1;
  const endpointOffset = Math.max(0, Math.min(maximumOffset, offset));
  const span = 1 - endpointOffset;
  if (span <= 0) {
    return { ...paint, stops: sortedStops };
  }

  const x1 = clampWorkflowUnit(paint.x1);
  const y1 = clampWorkflowUnit(paint.y1);
  const x2 = clampWorkflowUnit(paint.x2);
  const y2 = clampWorkflowUnit(paint.y2);
  return {
    ...paint,
    x1: clampWorkflowUnit(x1 + (x2 - x1) * endpointOffset),
    y1: clampWorkflowUnit(y1 + (y2 - y1) * endpointOffset),
    stops: sortedGradientStops(sortedStops.map((stop) => ({
      ...stop,
      offset: clampWorkflowUnit((stop.offset - endpointOffset) / span)
    })))
  };
}

function moveLinearGradientEndStop(
  paint: Extract<GraphicPaint, { kind: "linear-gradient" }>,
  sortedStops: GradientGraphicPaint["stops"],
  offset: number
): Extract<GraphicPaint, { kind: "linear-gradient" }> {
  const previousStop = sortedStops[sortedStops.length - 2];
  const minimumOffset = previousStop
    ? Math.min(1, previousStop.offset + GRAPHIC_GRADIENT_ENDPOINT_STOP_GAP)
    : 0;
  const endpointOffset = Math.max(minimumOffset, Math.min(1, offset));
  if (endpointOffset <= 0) {
    return { ...paint, stops: sortedStops };
  }

  const x1 = clampWorkflowUnit(paint.x1);
  const y1 = clampWorkflowUnit(paint.y1);
  const x2 = clampWorkflowUnit(paint.x2);
  const y2 = clampWorkflowUnit(paint.y2);
  return {
    ...paint,
    x2: clampWorkflowUnit(x1 + (x2 - x1) * endpointOffset),
    y2: clampWorkflowUnit(y1 + (y2 - y1) * endpointOffset),
    stops: sortedGradientStops(sortedStops.map((stop) => ({
      ...stop,
      offset: clampWorkflowUnit(stop.offset / endpointOffset)
    })))
  };
}

function updateGradientStopAtIndex(
  stops: GradientGraphicPaint["stops"],
  stopIndex: number,
  updateStop: (
    stop: GradientGraphicPaint["stops"][number]
  ) => GradientGraphicPaint["stops"][number]
): GradientGraphicPaint["stops"] {
  const sorted = sortedGradientStops(stops);
  const editIndex = Math.round(stopIndex);
  if (editIndex < 0 || editIndex >= sorted.length) {
    return sorted;
  }

  return sortedGradientStops(sorted.map((stop, index) => index === editIndex ? updateStop(stop) : stop));
}

function sortedGradientStops(
  stops: GradientGraphicPaint["stops"]
): GradientGraphicPaint["stops"] {
  return stops
    .map((stop) => ({
      ...stop,
      offset: clampWorkflowUnit(stop.offset),
      color: gradientStopColor(stop),
      ...(gradientStopOpacity(stop) < 1 ? { opacity: gradientStopOpacity(stop) } : {})
    }))
    .sort((left, right) => left.offset - right.offset);
}

function gradientStopColor(
  stop: GradientGraphicPaint["stops"][number]
): string {
  return normalizeWorkflowHexColor(stop.color) ?? "#111111";
}

function gradientStopOpacity(
  stop: GradientGraphicPaint["stops"][number]
): number {
  return clampWorkflowUnit(stop.opacity ?? 1);
}

function mixWorkflowHexColors(from: string, to: string, amount: number): string {
  const start = rgbFromWorkflowHexColor(from);
  const end = rgbFromWorkflowHexColor(to);
  const t = clampWorkflowUnit(amount);
  return `#${[0, 1, 2].map((index) =>
    Math.round(start[index]! + (end[index]! - start[index]!) * t).toString(16).padStart(2, "0")
  ).join("")}`;
}

function rgbFromWorkflowHexColor(color: string): [number, number, number] {
  const normalized = normalizeWorkflowHexColor(color) ?? "#111111";
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16)
  ];
}

function graphicFillPaintOpacity(object: GraphicObject): number {
  return object.style.fillPaint?.kind === "solid"
    ? clampWorkflowUnit(object.style.fillPaint.opacity ?? 1)
    : clampWorkflowUnit(object.style.fillOpacity ?? 1);
}

function graphicStrokePaintOpacity(object: GraphicObject): number {
  return object.style.strokePaint?.kind === "solid"
    ? clampWorkflowUnit(object.style.strokePaint.opacity ?? 1)
    : clampWorkflowUnit(object.style.strokeOpacity ?? 1);
}

function moleculeFillPaintOpacity(object: MoleculeObject): number {
  if (typeof object.style.fillOpacity === "number") {
    return clampWorkflowUnit(object.style.fillOpacity);
  }
  const paint = graphicPaintFromUnknown(object.style.fillPaint);
  return paint?.kind === "solid"
    ? clampWorkflowUnit(paint.opacity ?? 1)
    : 1;
}

function moleculeStrokePaintOpacity(object: MoleculeObject): number {
  if (typeof object.style.strokeOpacity === "number") {
    return clampWorkflowUnit(object.style.strokeOpacity);
  }
  const paint = graphicPaintFromUnknown(object.style.strokePaint);
  return paint?.kind === "solid"
    ? clampWorkflowUnit(paint.opacity ?? 1)
    : 1;
}

function graphicPaintFromUnknown(value: unknown): GraphicPaint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const paint = value as Partial<GraphicPaint> & Record<string, unknown>;
  if (paint.kind === "none") {
    return { kind: "none" };
  }

  if (paint.kind === "solid" && typeof paint.color === "string") {
    return {
      kind: "solid",
      color: paint.color,
      ...(typeof paint.opacity === "number" ? { opacity: clampWorkflowUnit(paint.opacity) } : {})
    };
  }

  if (
    paint.kind === "linear-gradient" &&
    typeof paint.x1 === "number" &&
    typeof paint.y1 === "number" &&
    typeof paint.x2 === "number" &&
    typeof paint.y2 === "number" &&
    paint.units === "object" &&
    Array.isArray(paint.stops)
  ) {
    return {
      kind: "linear-gradient",
      units: "object",
      x1: clampWorkflowUnit(paint.x1),
      y1: clampWorkflowUnit(paint.y1),
      x2: clampWorkflowUnit(paint.x2),
      y2: clampWorkflowUnit(paint.y2),
      stops: sortedGradientStops(paint.stops as Extract<GraphicPaint, { kind: "linear-gradient" }>["stops"])
    };
  }

  if (
    paint.kind === "radial-gradient" &&
    typeof paint.cx === "number" &&
    typeof paint.cy === "number" &&
    typeof paint.r === "number" &&
    paint.units === "object" &&
    Array.isArray(paint.stops)
  ) {
    return {
      kind: "radial-gradient",
      units: "object",
      cx: clampWorkflowUnit(paint.cx),
      cy: clampWorkflowUnit(paint.cy),
      r: Math.max(0, paint.r),
      ...(typeof paint.fx === "number" ? { fx: clampWorkflowUnit(paint.fx) } : {}),
      ...(typeof paint.fy === "number" ? { fy: clampWorkflowUnit(paint.fy) } : {}),
      stops: sortedGradientStops(paint.stops as Extract<GraphicPaint, { kind: "radial-gradient" }>["stops"])
    };
  }

  return undefined;
}

function legacyColorForGraphicPaint(paint: GraphicPaint, fallback: string): string {
  if (paint.kind === "solid") {
    return paint.color;
  }
  if (paint.kind === "linear-gradient" || paint.kind === "radial-gradient") {
    return [...paint.stops]
      .reverse()
      .map((stop) => normalizeWorkflowHexColor(stop.color))
      .find((color) => color !== undefined && color !== "#ffffff") ??
      normalizeWorkflowHexColor(paint.stops[0]?.color) ??
      fallback;
  }
  return fallback;
}

function graphicStylesEqual(first: GraphicObjectStyle, second: GraphicObjectStyle): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function normalizeWorkflowHexColor(color: string | undefined): string | undefined {
  const normalized = color?.trim().replace(/^#/, "").toLowerCase();
  if (!normalized || normalized === "none") {
    return undefined;
  }
  if (/^[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.split("").map((character) => `${character}${character}`).join("")}`;
  }
  return /^[0-9a-f]{6}$/.test(normalized) ? `#${normalized}` : undefined;
}

function clampWorkflowUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function styleColorChanges(
  object: DocumentObject,
  styleChanges: Record<string, string>
): Partial<DocumentObject> | undefined {
  const currentStyle = object.style as Record<string, unknown>;
  if (Object.entries(styleChanges).every(([key, value]) => currentStyle[key] === value)) {
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

function stylePrimitiveMap<T extends string | number | boolean>(
  value: unknown,
  isValid: (candidate: unknown) => candidate is T
): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, T] => isValid(entry[1]))
  );
}

// nextStyle is built by spreading object.style and reassigning only the touched
// sparse-map keys, so every other key is reference-identical. Comparing just the
// touched keys reproduces the old whole-style JSON.stringify diff while skipping
// serialization of the many untouched per-atom/per-bond override maps.
function moleculeStyleChangedAtKeys(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  keys: ReadonlySet<string>
): boolean {
  for (const key of keys) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      return true;
    }
  }
  return false;
}

function atomLabelStyleMapKey(field: keyof MoleculeAtomLabelStylePatch): string | undefined {
  switch (field) {
    case "atomLabelFontFamily":
      return "atomLabelFontFamilies";
    case "atomLabelFontSizePx":
      return "atomLabelFontSizes";
    case "atomLabelFontWeight":
      return "atomLabelFontWeights";
    case "atomLabelFontStyle":
      return "atomLabelFontStyles";
    case "atomLabelColor":
      return "atomLabelColors";
    case "atomLabelBackgroundColor":
      return "atomLabelBackgroundColors";
    case "atomLabelPaddingPx":
      return "atomLabelPaddings";
    case "atomLabelBondClearancePx":
      return "atomLabelBondClearances";
    case "atomLabelAlignment":
      return "atomLabelAlignments";
    case "atomLabelPlacement":
      return "atomLabelPlacements";
    case "atomLabelShowTerminalCarbons":
      return "atomLabelShowTerminalCarbonsByAtomId";
    case "atomLabelHideImplicitHydrogens":
      return "atomLabelHideImplicitHydrogensByAtomId";
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function atomLabelStyleMapValueIsValid(
  field: keyof MoleculeAtomLabelStylePatch
): (candidate: unknown) => candidate is string | number | boolean {
  switch (field) {
    case "atomLabelFontFamily":
    case "atomLabelColor":
    case "atomLabelBackgroundColor":
      return (candidate): candidate is string => typeof candidate === "string";
    case "atomLabelFontSizePx":
    case "atomLabelFontWeight":
    case "atomLabelPaddingPx":
    case "atomLabelBondClearancePx":
      return (candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate);
    case "atomLabelFontStyle":
      return (candidate): candidate is string => candidate === "normal" || candidate === "italic";
    case "atomLabelAlignment":
      return (candidate): candidate is string =>
        candidate === "automatic" || candidate === "left" || candidate === "center" || candidate === "right";
    case "atomLabelPlacement":
      return (candidate): candidate is string => candidate === "automatic" || candidate === "above" || candidate === "below";
    case "atomLabelShowTerminalCarbons":
    case "atomLabelHideImplicitHydrogens":
      return (candidate): candidate is boolean => typeof candidate === "boolean";
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function bondStyleMapKey(field: keyof MoleculeBondStylePatch): string | undefined {
  switch (field) {
    case "bondLengthPx":
      return "bondLengths";
    case "bondStrokeWidthPx":
      return "bondStrokeWidths";
    case "bondBoldWidthPx":
      return "bondBoldWidths";
    case "bondColor":
      return "bondColors";
    case "bondLineCap":
      return "bondLineCaps";
    case "bondSpacingMode":
      return "bondSpacingModes";
    case "bondSpacingPercent":
      return "bondSpacingPercents";
    case "multipleBondGapPx":
      return "bondMultipleBondGaps";
    case "doubleBondInsetPx":
      return "bondDoubleBondInsets";
    case "bondMarginWidthPx":
      return "bondMarginWidths";
    case "bondHashSpacingPx":
      return "bondHashSpacings";
    case "bondOverlapClearancePx":
      return "bondOverlapClearances";
    case "bondIndicatorShowQuery":
      return "bondIndicatorShowQueryByBondId";
    case "bondIndicatorShowStereochemistry":
      return "bondIndicatorShowStereochemistryByBondId";
    case "bondIndicatorShowReaction":
      return "bondIndicatorShowReactionByBondId";
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function bondStyleMapValueIsValid(
  field: keyof MoleculeBondStylePatch
): (candidate: unknown) => candidate is string | number | boolean {
  switch (field) {
    case "bondColor":
      return (candidate): candidate is string => typeof candidate === "string";
    case "bondLineCap":
      return (candidate): candidate is string => candidate === "butt" || candidate === "round" || candidate === "square";
    case "bondSpacingMode":
      return (candidate): candidate is string => candidate === "absolute" || candidate === "percent";
    case "bondLengthPx":
    case "bondStrokeWidthPx":
    case "bondBoldWidthPx":
    case "bondSpacingPercent":
    case "multipleBondGapPx":
    case "doubleBondInsetPx":
    case "bondMarginWidthPx":
    case "bondHashSpacingPx":
    case "bondOverlapClearancePx":
      return (candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate);
    case "bondIndicatorShowQuery":
    case "bondIndicatorShowStereochemistry":
    case "bondIndicatorShowReaction":
      return (candidate): candidate is boolean => typeof candidate === "boolean";
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function atomIndicatorStyleMapKey(field: keyof MoleculeAtomIndicatorStylePatch): string {
  switch (field) {
    case "atomIndicatorShowQuery":
      return "atomIndicatorShowQueryByAtomId";
    case "atomIndicatorShowStereochemistry":
      return "atomIndicatorShowStereochemistryByAtomId";
    case "atomIndicatorShowEnhancedStereochemistry":
      return "atomIndicatorShowEnhancedStereochemistryByAtomId";
    case "atomIndicatorShowAtomNumbers":
      return "atomIndicatorShowAtomNumbersByAtomId";
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function atomIndicatorStyleMapValueIsValid(
  _field: keyof MoleculeAtomIndicatorStylePatch
): (candidate: unknown) => candidate is boolean {
  return (candidate): candidate is boolean => typeof candidate === "boolean";
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
  const selectableObjectId = selectableDocumentObjectIdForSelection(page.objects, objectId);

  return applyPatch(
    document,
    {
      op: "setSelection",
      pageId: page.id,
      objectIds: [selectableObjectId]
    },
    { now: phase4Timestamp }
  );
}

export function selectDocumentObjectWithinGroup(document: ChemDraftDocument, objectId: string): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  if (!page) {
    throw new Error(`Cannot select document object within group: object "${objectId}" does not exist.`);
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
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const selectableObjectIds = page
    ? promoteDocumentObjectIdsToSelectableGroups(page.objects, objectIds)
    : [...objectIds];
  return applyPatch(
    document,
    {
      op: "setSelection",
      pageId,
      objectIds: selectableObjectIds
    },
    { now: phase4Timestamp }
  );
}

export function toggleDocumentObjectSelection(
  document: ChemDraftDocument,
  pageId: string,
  objectId: string
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const currentIds = page
    ? promoteDocumentObjectIdsToSelectableGroups(page.objects, document.selection.objectIds)
    : document.selection.objectIds;
  const selectableObjectId = page ? selectableDocumentObjectIdForSelection(page.objects, objectId) : objectId;
  const objectIds = currentIds.includes(selectableObjectId)
    ? currentIds.filter((candidate) => candidate !== selectableObjectId)
    : [...currentIds, selectableObjectId];
  return selectDocumentObjects(document, pageId, objectIds);
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
  const page = firstPage(document);
  const objectIds = selectedLayerObjectIds(document);
  if (objectIds.length === 0) {
    return document;
  }

  return reorderPageObjects(document, page.id, objectIds, placement);
}

function reorderPageObjects(
  document: ChemDraftDocument,
  pageId: string,
  objectIds: readonly string[],
  placement: ObjectReorderPlacement
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    return document;
  }

  const currentOrder = page.objects.map((object) => object.id);
  const nextOrder = reorderedLayerObjectIds(currentOrder, objectIds, placement);
  if (nextOrder.every((objectId, index) => objectId === currentOrder[index])) {
    return document;
  }

  let next = document;
  for (const objectId of [...nextOrder].reverse()) {
    next = applyPatch(
      next,
      { op: "reorderObject", objectId, placement: "back" },
      { now: phase4Timestamp }
    );
  }
  return next;
}

export function reorderedLayerObjectIds(
  currentOrder: readonly string[],
  objectIds: readonly string[],
  placement: ObjectReorderPlacement
): string[] {
  const selected = new Set(objectIds.filter((objectId) => currentOrder.includes(objectId)));
  if (selected.size === 0) {
    return [...currentOrder];
  }

  if (placement === "front") {
    return [
      ...currentOrder.filter((objectId) => !selected.has(objectId)),
      ...currentOrder.filter((objectId) => selected.has(objectId))
    ];
  }

  if (placement === "back") {
    return [
      ...currentOrder.filter((objectId) => selected.has(objectId)),
      ...currentOrder.filter((objectId) => !selected.has(objectId))
    ];
  }

  const nextOrder = [...currentOrder];
  if (placement === "forward") {
    for (let index = nextOrder.length - 2; index >= 0; index -= 1) {
      if (selected.has(nextOrder[index]) && !selected.has(nextOrder[index + 1])) {
        [nextOrder[index], nextOrder[index + 1]] = [nextOrder[index + 1], nextOrder[index]];
      }
    }
    return nextOrder;
  }

  for (let index = 1; index < nextOrder.length; index += 1) {
    if (selected.has(nextOrder[index]) && !selected.has(nextOrder[index - 1])) {
      [nextOrder[index - 1], nextOrder[index]] = [nextOrder[index], nextOrder[index - 1]];
    }
  }
  return nextOrder;
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
  position: PagePoint,
  options: {
    /**
     * Interactive moves keep objects on the page; exact translations (the Copy As scoped
     * document) must NOT clamp — a mechanism arrow whose bounds exceed the fitted page would
     * otherwise translate by the wrong delta, leaving its Bezier controls at stale coordinates.
     */
    clampToPage?: boolean;
  } = {}
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const object = page?.objects.find((candidate) => candidate.id === objectId);
  if (!page || !object) {
    return document;
  }

  const clampToPage = options.clampToPage ?? true;
  const nextX = clampToPage ? clamp(position.x, 0, Math.max(0, page.width - object.width)) : position.x;
  const nextY = clampToPage ? clamp(position.y, 0, Math.max(0, page.height - object.height)) : position.y;
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

  if (object.type === "mechanism-arrow") {
    // The Bezier controls and any point-anchored ends live in page coordinates, so they ride
    // along; atom/object anchors stay put and re-resolve wherever their targets are.
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          source: offsetAnchorPoint(object.source, dx, dy),
          target: offsetAnchorPoint(object.target, dx, dy),
          controlPoints: object.controlPoints.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }))
        }
      },
      { now: phase4Timestamp }
    );
  }

  if (object.type === "graphic") {
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          data: translateGraphicObjectData(object.data, dx, dy)
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

function translateGraphicObjectData(
  data: GraphicObjectData,
  dx: number,
  dy: number
): GraphicObjectData {
  const translatePoint = (point: PagePoint | undefined): PagePoint | undefined =>
    point ? { x: point.x + dx, y: point.y + dy } : undefined;
  const nextData: GraphicObjectData = {
    ...data,
    lineStart: translatePoint(data.lineStart),
    lineEnd: translatePoint(data.lineEnd),
    pathControlPoint: translatePoint(data.pathControlPoint),
    arcCenter: translatePoint(data.arcCenter),
    pathNodes: transformGraphicPathNodes(data.pathNodes, translatePoint),
    freehandPoints: transformGraphicFreehandPoints(data.freehandPoints, translatePoint)
  };
  delete nextData.cachedFreehandPathD;
  delete nextData.cachedFreehandPathRevision;
  return nextData;
}

function resizeGraphicObjectDataForFrame(
  data: GraphicObjectData,
  oldCenter: PagePoint,
  newCenter: PagePoint,
  scaleX: number,
  scaleY: number
): GraphicObjectData {
  const resizePoint = (point: PagePoint | undefined): PagePoint | undefined =>
    point
      ? {
          x: newCenter.x + (point.x - oldCenter.x) * scaleX,
          y: newCenter.y + (point.y - oldCenter.y) * scaleY
        }
      : undefined;

  const nextData: GraphicObjectData = {
    ...data,
    lineStart: resizePoint(data.lineStart),
    lineEnd: resizePoint(data.lineEnd),
    pathControlPoint: resizePoint(data.pathControlPoint),
    arcCenter: resizePoint(data.arcCenter),
    pathNodes: transformGraphicPathNodes(data.pathNodes, resizePoint),
    freehandPoints: transformGraphicFreehandPoints(data.freehandPoints, resizePoint)
  };
  delete nextData.cachedFreehandPathD;
  delete nextData.cachedFreehandPathRevision;

  if (typeof data.arcRadiusX === "number" && Number.isFinite(data.arcRadiusX)) {
    nextData.arcRadiusX = Math.max(1, data.arcRadiusX * Math.abs(scaleX));
  }

  if (typeof data.arcRadiusY === "number" && Number.isFinite(data.arcRadiusY)) {
    nextData.arcRadiusY = Math.max(1, data.arcRadiusY * Math.abs(scaleY));
  }

  // A parametric arc traces (cx + rx*cos t, cy + ry*sin t). Mirroring the centre and radii alone
  // left t untouched, so a flipped curved arrow kept its original sweep direction — and for the
  // curved pushing arrows that direction IS the chemistry. Under a mirror cos t and/or sin t change
  // sign, which is exactly atan2 of the signed components; the sweep reverses only when a single
  // axis flipped (a negative determinant). Mapping the START angle rather than the end keeps
  // markerStart/markerEnd on the ends they were already attached to.
  const signX = scaleX < 0 ? -1 : 1;
  const signY = scaleY < 0 ? -1 : 1;
  if (signX < 0 || signY < 0) {
    if (typeof data.arcStartRadians === "number" && Number.isFinite(data.arcStartRadians)) {
      nextData.arcStartRadians = Math.atan2(
        signY * Math.sin(data.arcStartRadians),
        signX * Math.cos(data.arcStartRadians)
      );
    }
    if (signX * signY < 0 && typeof data.arcSweepRadians === "number" && Number.isFinite(data.arcSweepRadians)) {
      nextData.arcSweepRadians = -data.arcSweepRadians;
    }
  }

  // Arrowheads are a size in px, not a pair of endpoints, so scaling the geometry alone would drag a
  // fixed-size head along a longer shaft — the arrow would look progressively wrong as it grew.
  // Scale by the OVERALL size change (see proportionalGraphicScale), not by one axis, so stretching
  // an arrow mostly-horizontally still enlarges its head somewhat rather than not at all.
  const headScale = proportionalGraphicScale(scaleX, scaleY);
  if (Math.abs(headScale - 1) > 0.0001) {
    nextData.markerStart = scaleGraphicMarker(data.markerStart, headScale);
    nextData.markerEnd = scaleGraphicMarker(data.markerEnd, headScale);
    if (typeof data.dualShaftGapPx === "number" && Number.isFinite(data.dualShaftGapPx)) {
      nextData.dualShaftGapPx = roundFreehandNumber(Math.max(0.5, data.dualShaftGapPx * headScale));
    }
    // An explicit no-reaction cross size scales with the arrow like the heads do; the derived
    // "auto" size follows stroke width, which the same resize already scales.
    if (typeof data.shaftMarkSizePx === "number" && Number.isFinite(data.shaftMarkSizePx)) {
      nextData.shaftMarkSizePx = clampGraphicShaftMarkSizePx(data.shaftMarkSizePx * headScale);
    }
  }

  return nextData;
}

/**
 * One scale factor for the parts of a graphic that have a thickness rather than a pair of endpoints
 * — arrowhead size, stroke width, shaft gap.
 *
 * The geometric mean of the two axes: it is the factor that changes area by the same amount the
 * resize did, so a uniform drag scales these exactly with the shape, and a one-axis stretch grows
 * them by the square root rather than either ignoring the stretch or doubling it.
 */
export function proportionalGraphicScale(scaleX: number, scaleY: number): number {
  const sx = Number.isFinite(scaleX) ? Math.abs(scaleX) : 1;
  const sy = Number.isFinite(scaleY) ? Math.abs(scaleY) : 1;
  if (sx <= 0 || sy <= 0) {
    return 1;
  }
  return Math.sqrt(sx * sy);
}

function scaleGraphicMarker(
  marker: GraphicObjectData["markerEnd"],
  scale: number
): GraphicObjectData["markerEnd"] {
  if (!marker || typeof marker.sizePx !== "number" || !Number.isFinite(marker.sizePx)) {
    return marker;
  }
  return { ...marker, sizePx: roundFreehandNumber(Math.max(2, marker.sizePx * scale)) };
}

function transformGraphicPathNodes(
  nodes: GraphicObjectData["pathNodes"],
  transformPoint: (point: PagePoint | undefined) => PagePoint | undefined
): GraphicObjectData["pathNodes"] {
  return nodes?.map((node) => ({
    point: transformPoint(node.point) ?? node.point,
    ...(node.inControl ? { inControl: transformPoint(node.inControl) ?? node.inControl } : {}),
    ...(node.outControl ? { outControl: transformPoint(node.outControl) ?? node.outControl } : {})
  }));
}

function transformGraphicFreehandPoints(
  points: GraphicObjectData["freehandPoints"],
  transformPoint: (point: PagePoint | undefined) => PagePoint | undefined
): GraphicObjectData["freehandPoints"] {
  return points?.map((point) => {
    const transformed = transformPoint(point);
    return {
      x: transformed?.x ?? point.x,
      y: transformed?.y ?? point.y,
      ...(typeof point.pressure === "number" ? { pressure: point.pressure } : {})
    };
  });
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
  const rotated = refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => targetAtomIds.has(atom.id)
      ? { ...atom, ...rotatePointAround(atom, center, angleRadians) }
      : atom)
  }));

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
    const center = nativeMoleculeCenter(object);
    const angleRadians = (object.rotation + angleDegrees) * Math.PI / 180;
    const atoms = object.atoms.map((atom) => ({
      ...atom,
      ...rotatePointAround(atom, center, angleRadians)
    }));
    const transform = nativeMoleculeTransformState(object);
    const nextMolecule = withNativeMoleculeTransform(refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
      ...object,
      rotation: 0,
      atoms
    })), {
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
  const nextMolecule = withNativeMoleculeTransform(refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
    ...molecule,
    rotation: 0,
    atoms
  })), {
    ...transform,
    rotationDegrees: transform.rotationDegrees + angleDegrees
  });

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

function rotateNativeMoleculeGeometryAroundPoint(
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
  const nextMolecule = refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
    ...molecule,
    rotation: 0,
    atoms: molecule.atoms.map((atom) => ({
      ...atom,
      ...rotatePointAround(atom, center, angleRadians)
    }))
  }));

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: nextMolecule },
    { now: phase4Timestamp }
  );
}

function wrapProjectedPlaneTiltValue(value: number, period: number): number {
  const wrapped = value % period;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function wrapProjectedPlaneTiltRadians(tiltRad: number): ProjectedPlaneTiltWrap {
  const finiteTilt = Number.isFinite(tiltRad) ? tiltRad : 0;
  const wrappedTilt = wrapProjectedPlaneTiltValue(finiteTilt, projectedPlaneTiltMaxRadians);
  return {
    tiltRad: wrappedTilt,
    clamped: !Number.isFinite(tiltRad)
  };
}

export function wrapProjectedPlaneTiltVectorRadians(tiltXRad: number, tiltYRad: number): ProjectedPlaneTiltVectorWrap {
  const wrappedX = wrapProjectedPlaneTiltRadians(tiltXRad);
  const wrappedY = wrapProjectedPlaneTiltRadians(tiltYRad);
  return {
    tiltXRad: wrappedX.tiltRad,
    tiltYRad: wrappedY.tiltRad,
    clamped: wrappedX.clamped || wrappedY.clamped
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
  const c = Math.cos(tiltRad);
  const s = Math.sin(tiltRad);
  const tiltedAcrossAxis = acrossAxis * c;

  return {
    x: center.x + alongAxis * ux + tiltedAcrossAxis * vx,
    y: center.y + alongAxis * uy + tiltedAcrossAxis * vy,
    z: acrossAxis * s
  };
}

function pointZ(point: ProjectedPlanePoint3d): number {
  const z = point.z ?? 0;
  return Number.isFinite(z) ? z : 0;
}

function projectedPlaneRotationMatrix(
  tiltXRad: number,
  tiltYRad: number,
  rotationDegrees = 0
): Matrix3 {
  const cx = Math.cos(tiltXRad);
  const sx = Math.sin(tiltXRad);
  const cy = Math.cos(tiltYRad);
  const sy = Math.sin(tiltYRad);
  const zRad = rotationDegrees * Math.PI / 180;
  const cz = Math.cos(zRad);
  const sz = Math.sin(zRad);

  // R_x · R_y · R_z: the in-plane Z rotation is applied first, then the Y and X tilts.
  // Applying Z first means tiltX/tiltY are interpreted in screen space rather than in
  // the molecule's already-Z-rotated local frame, so a vertical drag always tilts about
  // the screen's horizontal axis regardless of how the molecule was rotated in-plane.
  return [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy]
  ];
}

function transposeMatrix3(matrix: Matrix3): Matrix3 {
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]]
  ];
}

function multiplyMatrix3(left: Matrix3, right: Matrix3): Matrix3 {
  return [
    [
      left[0][0] * right[0][0] + left[0][1] * right[1][0] + left[0][2] * right[2][0],
      left[0][0] * right[0][1] + left[0][1] * right[1][1] + left[0][2] * right[2][1],
      left[0][0] * right[0][2] + left[0][1] * right[1][2] + left[0][2] * right[2][2]
    ],
    [
      left[1][0] * right[0][0] + left[1][1] * right[1][0] + left[1][2] * right[2][0],
      left[1][0] * right[0][1] + left[1][1] * right[1][1] + left[1][2] * right[2][1],
      left[1][0] * right[0][2] + left[1][1] * right[1][2] + left[1][2] * right[2][2]
    ],
    [
      left[2][0] * right[0][0] + left[2][1] * right[1][0] + left[2][2] * right[2][0],
      left[2][0] * right[0][1] + left[2][1] * right[1][1] + left[2][2] * right[2][1],
      left[2][0] * right[0][2] + left[2][1] * right[1][2] + left[2][2] * right[2][2]
    ]
  ];
}

function applyMatrix3(matrix: Matrix3, vector: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]
  ];
}

function projectedPlaneCenterWithDepth(center: ProjectedPlaneTiltPoint, depth = 0): ProjectedPlaneCenter3d {
  return {
    x: center.x,
    y: center.y,
    z: Number.isFinite(depth) ? depth : 0
  };
}

// Mean projected-plane depth of the given atoms, used as the tilt pivot's z so a molecule is
// tilted about its own depth plane rather than the z=0 screen plane. This is what keeps a
// single-object tilt centered on the molecule after a GROUP tilt: a group tilt rotates every
// member about the shared group center, giving each molecule a large uniform depth offset
// proportional to its distance from that center. Pivoting a later single tilt at z=0 would
// rotate that whole offset and swing the molecule about the stale group center; pivoting at
// the molecule's own mean depth cancels the offset so it tilts in place about its own center.
function meanAtomDepth(atoms: readonly MoleculeAtom[]): number {
  if (atoms.length === 0) {
    return 0;
  }
  return atoms.reduce((sum, atom) => sum + pointZ(atom), 0) / atoms.length;
}

function retargetProjectedPlaneTiltPoint(
  point: ProjectedPlanePoint3d,
  center: ProjectedPlaneCenter3d,
  fromTiltXRad: number,
  fromTiltYRad: number,
  toTiltXRad: number,
  toTiltYRad: number,
  fromRotationDegrees = 0,
  toRotationDegrees = fromRotationDegrees
): ProjectedPlaneTiltResult {
  const fromMatrix = projectedPlaneRotationMatrix(fromTiltXRad, fromTiltYRad, fromRotationDegrees);
  const toMatrix = projectedPlaneRotationMatrix(toTiltXRad, toTiltYRad, toRotationDegrees);
  const deltaMatrix = multiplyMatrix3(toMatrix, transposeMatrix3(fromMatrix));
  const [x, y, z] = applyMatrix3(deltaMatrix, [
    point.x - center.x,
    point.y - center.y,
    pointZ(point) - center.z
  ]);

  return {
    x: center.x + x,
    y: center.y + y,
    z: center.z + z
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

interface ProjectedPlaneTiltVector {
  tiltXRad: number;
  tiltYRad: number;
  clamped: boolean;
}

interface ResolvedProjectedPlaneTilt {
  resolvedTiltVector: ProjectedPlaneTiltVector;
  fromTiltVector: ProjectedPlaneTiltVector;
  fromRotationDegrees: number;
  resolvedRotationDegrees: number;
  /** True when the target orientation matches the source orientation within tolerance. */
  unchanged: boolean;
  /** True when clamping engaged and the caller asked not to mutate clamped tilts. */
  blockedByClamp: boolean;
  /** Maps a single point from the source orientation to the target orientation. */
  retargetAtom(point: ProjectedPlanePoint3d, center: ProjectedPlaneCenter3d): ProjectedPlaneTiltResult;
  /** Builds the no-op-friendly document result with the resolved tilt/rotation metadata. */
  result(document: ChemDraftDocument, changed: boolean): ProjectedPlaneTiltDocumentResult;
}

// Shared preamble for the three projected-plane tilt entry points. Resolving the tilt
// vector, clamp state, rotation frame, and retarget closure in one place keeps the single,
// part, and group paths on the same screen-space frame of reference (always the Euler
// vector path) so `tiltYRad: 0` behaves identically to omitting it.
function resolveProjectedPlaneTiltParameters(
  tiltRad: number,
  options: ProjectedPlaneTiltOptions,
  defaultFromRotationDegrees: number
): ResolvedProjectedPlaneTilt {
  const resolvedTiltVector = wrapProjectedPlaneTiltVectorRadians(tiltRad, options.tiltYRad ?? 0);
  const fromTiltX = wrapProjectedPlaneTiltRadians(options.fromTiltRad ?? 0);
  const fromTiltY = wrapProjectedPlaneTiltRadians(options.fromTiltYRad ?? 0);
  const fromTiltVector: ProjectedPlaneTiltVector = {
    tiltXRad: fromTiltX.tiltRad,
    tiltYRad: fromTiltY.tiltRad,
    clamped: fromTiltX.clamped || fromTiltY.clamped
  };
  const fromRotationDegrees = normalizeDegrees(options.fromRotationDegrees ?? defaultFromRotationDegrees);
  const resolvedRotationDegrees = normalizeDegrees(options.rotationDegrees ?? fromRotationDegrees);
  const rotationChanged = Math.abs(normalizedDegreeDelta(resolvedRotationDegrees, fromRotationDegrees)) >= 0.001;
  const clamped = resolvedTiltVector.clamped || fromTiltVector.clamped;
  const mutateWhenClamped = options.mutateWhenClamped ?? true;
  const unchanged =
    Math.abs(resolvedTiltVector.tiltXRad - fromTiltVector.tiltXRad) < 0.001 &&
    Math.abs(resolvedTiltVector.tiltYRad - fromTiltVector.tiltYRad) < 0.001 &&
    !rotationChanged;

  return {
    resolvedTiltVector,
    fromTiltVector,
    fromRotationDegrees,
    resolvedRotationDegrees,
    unchanged,
    blockedByClamp: clamped && !mutateWhenClamped,
    retargetAtom: (point, center) =>
      retargetProjectedPlaneTiltPoint(
        point,
        center,
        fromTiltVector.tiltXRad,
        fromTiltVector.tiltYRad,
        resolvedTiltVector.tiltXRad,
        resolvedTiltVector.tiltYRad,
        fromRotationDegrees,
        resolvedRotationDegrees
      ),
    result: (document, changed) => ({
      document,
      tiltRad: resolvedTiltVector.tiltXRad,
      tiltXRad: resolvedTiltVector.tiltXRad,
      tiltYRad: resolvedTiltVector.tiltYRad,
      rotationDegrees: resolvedRotationDegrees,
      clamped,
      changed
    })
  };
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
  const transform = molecule ? nativeMoleculeTransformState(molecule) : defaultNativeMoleculeTransform;
  const params = resolveProjectedPlaneTiltParameters(tiltRad, options, transform.rotationDegrees);
  if (!page || !molecule || molecule.atoms.length === 0 || params.unchanged || params.blockedByClamp) {
    return params.result(document, false);
  }

  const projectedPlaneCenter = projectedPlaneCenterWithDepth(center, meanAtomDepth(molecule.atoms));
  const tiltedGeometry = refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => {
      const point = params.retargetAtom(atom, projectedPlaneCenter);
      return {
        ...atom,
        x: roundGeometryCoordinate(point.x),
        y: roundGeometryCoordinate(point.y),
        z: roundGeometryCoordinate(point.z)
      };
    })
  }));
  const tilted = options.persistTransform
    ? withNativeMoleculeTransform(tiltedGeometry, {
        scaleX: transform.scaleX,
        scaleY: transform.scaleY,
        rotationDegrees: params.resolvedRotationDegrees,
        tiltXDegrees: radiansToDegrees(params.resolvedTiltVector.tiltXRad),
        tiltYDegrees: radiansToDegrees(params.resolvedTiltVector.tiltYRad)
      })
    : tiltedGeometry;
  if (!nativeMoleculeGeometryOrTransformChanged(molecule, tilted)) {
    return params.result(document, false);
  }

  return params.result(
    applyPatch(document, { op: "updateObject", objectId, changes: tilted }, { now: phase4Timestamp }),
    true
  );
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
  const params = resolveProjectedPlaneTiltParameters(tiltRad, options, 0);
  if (!page || !molecule || molecule.atoms.length === 0 || params.unchanged || params.blockedByClamp) {
    return params.result(document, false);
  }

  const targetAtomIds = nativeMoleculePartAtomIds(molecule, target);
  if (targetAtomIds.size === 0) {
    return params.result(document, false);
  }

  const targetAtoms = molecule.atoms.filter((atom) => targetAtomIds.has(atom.id));
  const projectedPlaneCenter = projectedPlaneCenterWithDepth(center, meanAtomDepth(targetAtoms));
  const tilted = refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => {
      if (!targetAtomIds.has(atom.id)) {
        return atom;
      }

      const point = params.retargetAtom(atom, projectedPlaneCenter);
      return {
        ...atom,
        x: roundGeometryCoordinate(point.x),
        y: roundGeometryCoordinate(point.y),
        z: roundGeometryCoordinate(point.z)
      };
    })
  }));
  if (!nativeMoleculeGeometryOrTransformChanged(molecule, tilted)) {
    return params.result(document, false);
  }

  return params.result(
    applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: tilted }, { now: phase4Timestamp }),
    true
  );
}

export function tiltNativeMoleculeObjectsProjectedPlane(
  document: ChemDraftDocument,
  objectIds: readonly string[],
  center: PagePoint,
  axisAngleRad: number,
  tiltRad: number,
  options: ProjectedPlaneTiltOptions = {}
): ProjectedPlaneTiltDocumentResult {
  const objectIdSet = new Set(objectIds);
  const params = resolveProjectedPlaneTiltParameters(tiltRad, options, 0);
  if (objectIdSet.size === 0 || params.unchanged || params.blockedByClamp) {
    return params.result(document, false);
  }

  const projectedPlaneCenter = projectedPlaneCenterWithDepth(center);
  const patches: DocumentPatch[] = [];
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (
        !objectIdSet.has(object.id) ||
        object.type !== "molecule" ||
        object.atoms.length === 0
      ) {
        continue;
      }

      // Group tilt bakes the shared screen-space rotation into each molecule's geometry but
      // deliberately does NOT persist per-object tilt metadata. The rotation pivots about the
      // *group* selection center, not each molecule's own center, so persisting an absolute
      // tilt would seed a later single-object re-tilt with a baseline that swings the molecule
      // about the stale group pivot (the molecule appears to "remember" the group center).
      // Leaving tilt unpersisted lets a reselected member tilt cleanly about its own center.
      const tilted = refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
        ...object,
        atoms: object.atoms.map((atom) => {
          const point = params.retargetAtom(atom, projectedPlaneCenter);
          return {
            ...atom,
            x: roundGeometryCoordinate(point.x),
            y: roundGeometryCoordinate(point.y),
            z: roundGeometryCoordinate(point.z)
          };
        })
      }));
      if (nativeMoleculeGeometryOrTransformChanged(object, tilted)) {
        patches.push({ op: "updateObject", objectId: object.id, changes: tilted });
      }
    }
  }

  if (patches.length === 0) {
    return params.result(document, false);
  }

  return params.result(applyPatches(document, patches, { now: phase4Timestamp }), true);
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

interface ObjectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Union axis-aligned bounding box (and center) of the selected objects, in page coords. */
export function selectionBounds(
  objects: readonly DocumentObject[],
  ids: readonly string[]
): SelectionBounds | undefined {
  const set = new Set(resolveGroupedDocumentObjectIds(objects, ids));
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

export function resolveGroupedDocumentObjectIds(
  objects: readonly DocumentObject[],
  ids: readonly string[]
): string[] {
  const objectById = new Map(objects.map((object) => [object.id, object] as const));
  const resolved: string[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string) => {
    if (seen.has(id) || visiting.has(id)) {
      return;
    }

    const object = objectById.get(id);
    if (!object) {
      return;
    }

    if (object.type !== "group") {
      seen.add(id);
      resolved.push(id);
      return;
    }

    visiting.add(id);
    object.childObjectIds.forEach(visit);
    visiting.delete(id);
  };

  ids.forEach(visit);
  return resolved;
}

export function selectableDocumentObjectIdForSelection(
  objects: readonly DocumentObject[],
  objectId: string
): string {
  const objectById = new Map(objects.map((object) => [object.id, object] as const));
  const outerGroupIdsByChildId = new Map<string, string>();
  const visiting = new Set<string>();

  const visitGroup = (group: GroupObject, parentGroupId: string) => {
    if (visiting.has(group.id)) {
      return;
    }

    visiting.add(group.id);
    for (const childId of group.childObjectIds) {
      outerGroupIdsByChildId.set(childId, parentGroupId);
      const child = objectById.get(childId);
      if (child?.type === "group") {
        visitGroup(child, parentGroupId);
      }
    }
    visiting.delete(group.id);
  };

  for (const object of objects) {
    if (object.type === "group" && !outerGroupIdsByChildId.has(object.id)) {
      visitGroup(object, object.id);
    }
  }

  return outerGroupIdsByChildId.get(objectId) ?? objectId;
}

export function promoteDocumentObjectIdsToSelectableGroups(
  objects: readonly DocumentObject[],
  objectIds: readonly string[]
): string[] {
  const selectableObjectIds: string[] = [];

  for (const objectId of objectIds) {
    const selectableObjectId = selectableDocumentObjectIdForSelection(objects, objectId);
    if (!selectableObjectIds.includes(selectableObjectId)) {
      selectableObjectIds.push(selectableObjectId);
    }
  }

  return selectableObjectIds;
}

export function selectedGroupObjectIds(document: ChemDraftDocument): string[] {
  const page = firstPage(document);
  const selectedIds = new Set(document.selection.objectIds);
  return page.objects
    .filter((object): object is GroupObject => object.type === "group" && selectedIds.has(object.id))
    .map((object) => object.id);
}

function selectedTransformObjectIds(document: ChemDraftDocument): string[] {
  const page = firstPage(document);
  return resolveGroupedDocumentObjectIds(page.objects, document.selection.objectIds);
}

export function selectedLayerObjectIds(document: ChemDraftDocument): string[] {
  const page = firstPage(document);
  const selectedIds = new Set(document.selection.objectIds);
  const selectedVisibleIds = new Set(resolveGroupedDocumentObjectIds(page.objects, document.selection.objectIds));
  return page.objects
    .filter((object) => selectedVisibleIds.has(object.id) || (object.type === "group" && selectedIds.has(object.id)))
    .map((object) => object.id);
}

export function groupSelectedDocumentObjects(document: ChemDraftDocument): ChemDraftDocument {
  const page = firstPage(document);
  const objectIds = selectedTransformObjectIds(document);
  if (objectIds.length < 2) {
    return document;
  }

  const bounds = selectionBounds(page.objects, objectIds);
  if (!bounds) {
    return document;
  }

  const group: GroupObject = {
    id: nextObjectId(document, "group"),
    type: "group",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    rotation: 0,
    style: {},
    childObjectIds: objectIds
  };

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object: group },
      { op: "setSelection", pageId: page.id, objectIds: [group.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function ungroupSelectedDocumentObjects(document: ChemDraftDocument): ChemDraftDocument {
  const page = firstPage(document);
  const selectedIds = new Set(document.selection.objectIds);
  const groups = page.objects.filter((object): object is GroupObject =>
    object.type === "group" && selectedIds.has(object.id)
  );
  if (groups.length === 0) {
    return document;
  }

  const childIds = resolveGroupedDocumentObjectIds(page.objects, groups.map((group) => group.id));
  return applyPatches(
    document,
    [
      ...groups.map((group) => ({ op: "removeObject" as const, objectId: group.id })),
      { op: "setSelection" as const, pageId: page.id, objectIds: childIds }
    ],
    { now: phase4Timestamp }
  );
}

export function documentObjectVisualBounds(object: DocumentObject): ObjectBounds {
  if (object.type !== "graphic") {
    return {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height
    };
  }

  const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
  const localBounds = rotatedGraphicLocalBounds(object, plan.frameBounds, object.rotation);
  return {
    x: object.x + localBounds.x,
    y: object.y + localBounds.y,
    width: localBounds.width,
    height: localBounds.height
  };
}

function rotatedGraphicLocalBounds(
  object: GraphicObject,
  bounds: ObjectBounds,
  rotationDegrees: number
): ObjectBounds {
  if (Math.abs(rotationDegrees) < 0.001) {
    return bounds;
  }
  if (
    object.graphicKind === "ellipse" &&
    Math.abs(Math.max(object.width, 1) - Math.max(object.height, 1)) < 0.001
  ) {
    return bounds;
  }

  const center = {
    x: Math.max(object.width, 1) / 2,
    y: Math.max(object.height, 1) / 2
  };
  const rotationRadians = degreesToRadians(rotationDegrees);
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height }
  ].map((point) => rotatePointAround(point, center, rotationRadians));
  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y));

  return {
    x: roundLayoutCoordinate(minX),
    y: roundLayoutCoordinate(minY),
    width: roundLayoutCoordinate(maxX - minX),
    height: roundLayoutCoordinate(maxY - minY)
  };
}

function roundLayoutCoordinate(value: number): number {
  return Number(value.toFixed(3));
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
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          atoms: object.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
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

  if (object.type === "graphic") {
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          data: translateGraphicObjectData(object.data, dx, dy)
        }
      },
      { now: phase4Timestamp }
    );
  }

  if (object.type === "reaction-arrow") {
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          start: offsetAnchorPoint(object.start, dx, dy),
          end: offsetAnchorPoint(object.end, dx, dy)
        }
      },
      { now: phase4Timestamp }
    );
  }

  if (object.type === "mechanism-arrow") {
    return applyPatch(
      document,
      {
        op: "updateObject",
        objectId,
        changes: {
          x: nextX,
          y: nextY,
          source: offsetAnchorPoint(object.source, dx, dy),
          target: offsetAnchorPoint(object.target, dx, dy),
          controlPoints: object.controlPoints.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }))
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
  const objectIds = resolveGroupedDocumentObjectIds(page.objects, ids);
  const bounds = selectionBounds(page.objects, objectIds);
  if (!bounds) {
    return document;
  }

  const cdx = clamp(dx, -bounds.x, Math.max(-bounds.x, page.width - (bounds.x + bounds.width)));
  const cdy = clamp(dy, -bounds.y, Math.max(-bounds.y, page.height - (bounds.y + bounds.height)));
  if (Math.abs(cdx) < 1e-6 && Math.abs(cdy) < 1e-6) {
    return document;
  }

  const set = new Set(objectIds);
  let next = document;
  for (const object of page.objects) {
    if (set.has(object.id)) {
      next = translateDocumentObjectBy(next, object.id, cdx, cdy);
    }
  }
  return next;
}

export type DocumentAlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DocumentDistributeAxis = "horizontal" | "vertical";
export type DocumentDistributeMode = "centers" | "spacing";

// The top-level objects participating in the current selection — a selected group appears once as
// its group object, not as its expanded children, so layout operations treat it as a single item.
function selectionLayoutObjects(document: ChemDraftDocument): DocumentObject[] {
  const page = selectionPage(document);
  const selectedIds = new Set(document.selection.objectIds);
  return page.objects.filter((object) => selectedIds.has(object.id));
}

// Move a top-level layout item by a delta. For a group this moves every descendant together (the
// same primitive group dragging uses), so the group keeps its internal arrangement. Unlike
// moveDocumentObjects it neither clamps to the page nor assumes the first page.
function translateSelectionLayoutItemBy(
  document: ChemDraftDocument,
  pageObjects: readonly DocumentObject[],
  itemId: string,
  dx: number,
  dy: number
): ChemDraftDocument {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return document;
  }
  let next = document;
  for (const memberId of resolveGroupedDocumentObjectIds(pageObjects, [itemId])) {
    next = translateDocumentObjectBy(next, memberId, dx, dy);
  }
  return next;
}

export function alignSelectedDocumentObjects(
  document: ChemDraftDocument,
  mode: DocumentAlignMode
): ChemDraftDocument {
  const page = selectionPage(document);
  const layoutItems = selectionLayoutObjects(document)
    .map((object) => ({ id: object.id, bounds: selectionBounds(page.objects, [object.id]) }))
    .filter((item): item is { id: string; bounds: SelectionBounds } => item.bounds !== undefined);
  if (layoutItems.length < 2) {
    return document;
  }
  const bounds = selectionBounds(page.objects, layoutItems.map((item) => item.id));
  if (!bounds) {
    return document;
  }

  let next = document;
  for (const { id, bounds: itemBounds } of layoutItems) {
    const dx = mode === "left"
      ? bounds.x - itemBounds.x
      : mode === "center"
        ? bounds.centerX - itemBounds.centerX
        : mode === "right"
          ? bounds.x + bounds.width - (itemBounds.x + itemBounds.width)
          : 0;
    const dy = mode === "top"
      ? bounds.y - itemBounds.y
      : mode === "middle"
        ? bounds.centerY - itemBounds.centerY
        : mode === "bottom"
          ? bounds.y + bounds.height - (itemBounds.y + itemBounds.height)
          : 0;
    next = translateSelectionLayoutItemBy(next, page.objects, id, dx, dy);
  }
  return next;
}

// Visual bounds of a top-level layout item, treating a group as a single box (the union of its
// descendants) rather than its stale wrapper geometry.
function layoutItemVisualBounds(
  pageObjects: readonly DocumentObject[],
  object: DocumentObject
): ObjectBounds {
  if (object.type === "group") {
    const bounds = selectionBounds(pageObjects, [object.id]);
    if (bounds) {
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
  }
  return documentObjectVisualBounds(object);
}

export function distributeSelectedDocumentObjects(
  document: ChemDraftDocument,
  axis: DocumentDistributeAxis,
  mode: DocumentDistributeMode = "centers"
): ChemDraftDocument {
  const page = selectionPage(document);
  const selectedObjects = selectionLayoutObjects(document);
  if (selectedObjects.length < 3) {
    return document;
  }

  if (mode === "spacing") {
    return distributeSelectedDocumentObjectsBySpacing(document, page.objects, selectedObjects, axis);
  }

  const centerForAxis = (object: DocumentObject) => {
    const bounds = layoutItemVisualBounds(page.objects, object);
    return axis === "horizontal"
      ? bounds.x + bounds.width / 2
      : bounds.y + bounds.height / 2;
  };
  const sortedObjects = [...selectedObjects].sort((a, b) => centerForAxis(a) - centerForAxis(b));
  const firstCenter = centerForAxis(sortedObjects[0]);
  const lastCenter = centerForAxis(sortedObjects[sortedObjects.length - 1]);
  const spacing = (lastCenter - firstCenter) / (sortedObjects.length - 1);
  if (Math.abs(spacing) < 1e-6) {
    return document;
  }

  let next = document;
  sortedObjects.forEach((object, index) => {
    const targetCenter = firstCenter + spacing * index;
    const delta = targetCenter - centerForAxis(object);
    next = axis === "horizontal"
      ? translateSelectionLayoutItemBy(next, page.objects, object.id, delta, 0)
      : translateSelectionLayoutItemBy(next, page.objects, object.id, 0, delta);
  });
  return next;
}

function distributeSelectedDocumentObjectsBySpacing(
  document: ChemDraftDocument,
  pageObjects: readonly DocumentObject[],
  selectedObjects: readonly DocumentObject[],
  axis: DocumentDistributeAxis
): ChemDraftDocument {
  const visualBoundsById = new Map(selectedObjects.map((object) => [object.id, layoutItemVisualBounds(pageObjects, object)] as const));
  const visualBoundsForObject = (object: DocumentObject): ObjectBounds => {
    const bounds = visualBoundsById.get(object.id);
    if (!bounds) {
      throw new Error(`Expected visual bounds for selected object ${object.id}.`);
    }
    return bounds;
  };
  const startForAxis = (object: DocumentObject) => {
    const bounds = visualBoundsForObject(object);
    return axis === "horizontal" ? bounds.x : bounds.y;
  };
  const sizeForAxis = (object: DocumentObject) => {
    const bounds = visualBoundsForObject(object);
    return axis === "horizontal" ? bounds.width : bounds.height;
  };
  const sortedObjects = [...selectedObjects].sort((a, b) => startForAxis(a) - startForAxis(b));
  const firstStart = startForAxis(sortedObjects[0]);
  const lastObject = sortedObjects[sortedObjects.length - 1];
  const lastEnd = startForAxis(lastObject) + sizeForAxis(lastObject);
  const totalSize = sortedObjects.reduce((sum, object) => sum + sizeForAxis(object), 0);
  const gap = (lastEnd - firstStart - totalSize) / (sortedObjects.length - 1);

  let next = document;
  let targetStart = firstStart;
  sortedObjects.forEach((object, index) => {
    if (index === 0 || index === sortedObjects.length - 1) {
      targetStart += sizeForAxis(object) + gap;
      return;
    }
    const delta = targetStart - startForAxis(object);
    next = axis === "horizontal"
      ? translateSelectionLayoutItemBy(next, pageObjects, object.id, delta, 0)
      : translateSelectionLayoutItemBy(next, pageObjects, object.id, 0, delta);
    targetStart += sizeForAxis(object) + gap;
  });
  return next;
}

export function duplicateSelectedDocumentObjects(
  document: ChemDraftDocument,
  offset: PagePoint = { x: 24, y: 24 }
): ChemDraftDocument {
  const page = firstPage(document);
  const selectedGroups = page.objects.filter((object): object is GroupObject =>
    object.type === "group" && document.selection.objectIds.includes(object.id)
  );
  const selectedIds = new Set(selectedTransformObjectIds(document));
  const selectedObjects = page.objects.filter((object) => selectedIds.has(object.id));
  if (selectedObjects.length === 0) {
    return document;
  }

  let next = document;
  const duplicateIds: string[] = [];
  const duplicateIdByOriginalId = new Map<string, string>();
  for (const object of selectedObjects) {
    const duplicate = cloneDocumentObjectForDuplicate(next, object);
    duplicateIds.push(duplicate.id);
    duplicateIdByOriginalId.set(object.id, duplicate.id);
    next = applyPatch(
      next,
      { op: "addObject", pageId: page.id, object: duplicate },
      { now: phase4Timestamp }
    );
  }

  const duplicateGroupIds: string[] = [];
  const groupedDuplicateChildIds = new Set<string>();
  for (const group of selectedGroups) {
    const childObjectIds = group.childObjectIds
      .map((childId) => duplicateIdByOriginalId.get(childId))
      .filter((childId): childId is string => childId !== undefined);
    if (childObjectIds.length < 2) {
      continue;
    }
    childObjectIds.forEach((childId) => groupedDuplicateChildIds.add(childId));
    const bounds = selectionBounds(next.pages[0].objects, childObjectIds);
    if (!bounds) {
      continue;
    }
    const duplicateGroup: GroupObject = {
      id: nextObjectId(next, "group"),
      type: "group",
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      rotation: 0,
      style: {},
      childObjectIds
    };
    duplicateGroupIds.push(duplicateGroup.id);
    next = applyPatch(
      next,
      { op: "addObject", pageId: page.id, object: duplicateGroup },
      { now: phase4Timestamp }
    );
  }

  const selectionIds = [
    ...duplicateGroupIds,
    ...duplicateIds.filter((duplicateId) => !groupedDuplicateChildIds.has(duplicateId))
  ];

  next = applyPatch(
    next,
    { op: "setSelection", pageId: page.id, objectIds: selectionIds },
    { now: phase4Timestamp }
  );

  return moveDocumentObjects(next, selectionIds, offset.x, offset.y);
}

export function createSelectionClipboardPayload(
  document: ChemDraftDocument
): ChemDraftSelectionClipboardPayload | undefined {
  const page = firstPage(document);
  const selectedObjectIds = selectedTransformObjectIds(document);
  const selectedIdSet = new Set(selectedObjectIds);
  const objects = page.objects.filter((object) => selectedIdSet.has(object.id));
  const selectedGroups = page.objects.filter((object): object is GroupObject =>
    object.type === "group" && document.selection.objectIds.includes(object.id)
  );
  const bounds = selectionBounds(page.objects, selectedObjectIds);
  if (objects.length === 0 || !bounds) {
    return undefined;
  }

  return {
    kind: "chemdraft-selection",
    version: 1,
    objects: structuredClone([
      ...objects,
      ...selectedGroups.filter((group) =>
        group.childObjectIds.some((childId) => selectedIdSet.has(childId))
      )
    ]) as DocumentObject[],
    selectionIds: document.selection.objectIds.filter((objectId) =>
      selectedIdSet.has(objectId) || selectedGroups.some((group) => group.id === objectId)
    ),
    bounds
  };
}

export function serializeSelectionClipboardPayload(
  payload: ChemDraftSelectionClipboardPayload
): string {
  return JSON.stringify(payload);
}

// Human-readable representation for the public `text/plain` clipboard flavor. External apps (Word,
// Mail, etc.) receive this, so it must never be the raw selection JSON — that lives only in the
// private CHEMDRAFT_SELECTION_CLIPBOARD_TYPE flavor. Returns "" when the selection has no readable
// text, in which case no public text flavor is published.
export function selectionClipboardPlainText(
  payload: ChemDraftSelectionClipboardPayload
): string {
  const lines: string[] = [];
  for (const object of payload.objects) {
    if (object.type === "text" && object.text.trim().length > 0) {
      lines.push(object.text);
    } else if (object.type === "annotation" && object.message.trim().length > 0) {
      lines.push(object.message);
    }
  }
  return lines.join("\n");
}

export function parseSelectionClipboardPayload(
  text: string
): ChemDraftSelectionClipboardPayload | undefined {
  try {
    const payload = JSON.parse(text) as Partial<ChemDraftSelectionClipboardPayload>;
    if (
      payload.kind !== "chemdraft-selection" ||
      payload.version !== 1 ||
      !Array.isArray(payload.objects) ||
      !Array.isArray(payload.selectionIds) ||
      !payload.bounds ||
      typeof payload.bounds.x !== "number" ||
      typeof payload.bounds.y !== "number" ||
      typeof payload.bounds.width !== "number" ||
      typeof payload.bounds.height !== "number"
    ) {
      return undefined;
    }

    const objects = payload.objects
      .map(parseClipboardDocumentObject)
      .filter((object): object is DocumentObject => object !== undefined);
    if (objects.length === 0 || objects.length !== payload.objects.length) {
      return undefined;
    }

    return {
      kind: "chemdraft-selection",
      version: 1,
      objects,
      selectionIds: payload.selectionIds.filter((id): id is string => typeof id === "string"),
      bounds: {
        x: payload.bounds.x,
        y: payload.bounds.y,
        width: payload.bounds.width,
        height: payload.bounds.height,
        centerX: typeof payload.bounds.centerX === "number"
          ? payload.bounds.centerX
          : payload.bounds.x + payload.bounds.width / 2,
        centerY: typeof payload.bounds.centerY === "number"
          ? payload.bounds.centerY
          : payload.bounds.y + payload.bounds.height / 2
      }
    };
  } catch {
    return undefined;
  }
}

export function pasteSelectionClipboardPayload(
  document: ChemDraftDocument,
  payload: ChemDraftSelectionClipboardPayload,
  point: PagePoint
): ChemDraftDocument {
  const page = firstPage(document);
  const dx = point.x - payload.bounds.centerX;
  const dy = point.y - payload.bounds.centerY;
  const sourceGroups = payload.objects.filter((object): object is GroupObject => object.type === "group");
  const sourceChildren = payload.objects.filter((object) => object.type !== "group");
  const sourceChildIds = new Set(sourceChildren.map((object) => object.id));
  let next = document;
  const idBySourceId = new Map<string, string>();

  for (const object of sourceChildren) {
    const pasted = translatedClipboardObject(
      cloneDocumentObjectForClipboardPaste(next, object),
      dx,
      dy
    );
    idBySourceId.set(object.id, pasted.id);
    next = applyPatch(
      next,
      { op: "addObject", pageId: page.id, object: pasted },
      { now: phase4Timestamp }
    );
  }

  for (const group of sourceGroups) {
    const childObjectIds = group.childObjectIds
      .filter((childId) => sourceChildIds.has(childId))
      .map((childId) => idBySourceId.get(childId))
      .filter((childId): childId is string => childId !== undefined);
    if (childObjectIds.length < 2) {
      continue;
    }

    const pastedGroup: GroupObject = {
      ...group,
      id: nextObjectId(next, "group"),
      x: group.x + dx,
      y: group.y + dy,
      childObjectIds
    };
    idBySourceId.set(group.id, pastedGroup.id);
    next = applyPatch(
      next,
      { op: "addObject", pageId: page.id, object: pastedGroup },
      { now: phase4Timestamp }
    );
  }

  const selectedIds = payload.selectionIds
    .map((sourceId) => idBySourceId.get(sourceId))
    .filter((objectId): objectId is string => objectId !== undefined);
  const fallbackSelectionIds = selectedIds.length > 0
    ? selectedIds
    : [...idBySourceId.values()];

  return applyPatch(
    next,
    { op: "setSelection", pageId: page.id, objectIds: fallbackSelectionIds },
    { now: phase4Timestamp }
  );
}

export function rotateSelectedDocumentObjects90(document: ChemDraftDocument): ChemDraftDocument {
  const page = firstPage(document);
  const objectIds = selectedTransformObjectIds(document);
  const bounds = selectionBounds(page.objects, objectIds);
  if (!bounds) {
    return document;
  }

  return rotateDocumentObjectsAroundPoint(
    document,
    objectIds,
    { x: bounds.centerX, y: bounds.centerY },
    90
  );
}

function cloneDocumentObjectForDuplicate(
  document: ChemDraftDocument,
  object: DocumentObject
): DocumentObject {
  const duplicate = structuredClone(object) as DocumentObject;
  duplicate.id = nextObjectId(document, duplicateObjectIdPrefix(object));
  return duplicate;
}

function cloneDocumentObjectForClipboardPaste(
  document: ChemDraftDocument,
  object: DocumentObject
): DocumentObject {
  return cloneDocumentObjectForDuplicate(document, object);
}

function translatedClipboardObject(
  object: DocumentObject,
  dx: number,
  dy: number
): DocumentObject {
  const nextX = object.x + dx;
  const nextY = object.y + dy;
  if (object.type === "molecule") {
    return {
      ...object,
      x: nextX,
      y: nextY,
      atoms: object.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
    };
  }

  if (object.type === "electron-mark" && object.markKind === "charge") {
    return {
      ...object,
      x: nextX,
      y: nextY,
      anchor: {
        ...object.anchor,
        kind: "point",
        point: { x: nextX + object.width / 2, y: nextY + object.height / 2 }
      }
    };
  }

  if (object.type === "graphic") {
    return {
      ...object,
      x: nextX,
      y: nextY,
      data: translateGraphicObjectData(object.data, dx, dy)
    };
  }

  if (object.type === "reaction-arrow") {
    return {
      ...object,
      x: nextX,
      y: nextY,
      start: offsetAnchorPoint(object.start, dx, dy),
      end: offsetAnchorPoint(object.end, dx, dy)
    };
  }

  if (object.type === "mechanism-arrow") {
    return {
      ...object,
      x: nextX,
      y: nextY,
      source: offsetAnchorPoint(object.source, dx, dy),
      target: offsetAnchorPoint(object.target, dx, dy),
      controlPoints: object.controlPoints.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }))
    };
  }

  return {
    ...object,
    x: nextX,
    y: nextY
  };
}

// Absolute point anchors must shift with the object frame; the renderer positions arrows by
// subtracting the object x/y from each anchor, so moving only x/y would warp the arrow. Object/atom
// anchors reference other ids and are left untouched.
function offsetAnchorPoint(anchor: Anchor, dx: number, dy: number): Anchor {
  return anchor.kind === "point" && anchor.point
    ? { ...anchor, point: { x: anchor.point.x + dx, y: anchor.point.y + dy } }
    : anchor;
}

function mapAnchorPoint(anchor: Anchor, map: (point: PagePoint) => PagePoint): Anchor {
  return anchor.kind === "point" && anchor.point
    ? { ...anchor, point: map(anchor.point) }
    : anchor;
}

// Fully validate (and normalize) a clipboard object against the document schema. Shallow base-field
// checks let objects with missing type-specific fields through, which then throw later at applyPatch
// instead of being rejected so paste can fall back safely.
function parseClipboardDocumentObject(value: unknown): DocumentObject | undefined {
  const result = DocumentObjectSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function duplicateObjectIdPrefix(object: DocumentObject): string {
  switch (object.type) {
    case "molecule":
      return "mol_copy";
    case "graphic":
      return "art_copy";
    case "text":
      return "text_copy";
    case "electron-mark":
      return object.markKind === "charge" ? "charge_copy" : "electron_copy";
    case "plus":
      return "plus_copy";
    default:
      return `${object.type.replace(/[^a-z0-9]+/gi, "_")}_copy`;
  }
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
  if (object.type === "graphic") {
    changes.data = resizeGraphicObjectDataForFrame(object.data, oldCenter, newCenter, scaleX, scaleY);
    // Stroke width scales with the arrow too, so a resized arrow keeps its proportions instead of
    // turning spindly as it grows. Arrow-family only: other art keeps its existing behaviour, where
    // a resized rectangle deliberately holds its stroke weight.
    const strokeScale = proportionalGraphicScale(scaleX, scaleY);
    if (isNativeArrowGraphic(object) && Math.abs(strokeScale - 1) > 0.0001) {
      const strokeWidth = object.style.strokeWidth;
      if (typeof strokeWidth === "number" && Number.isFinite(strokeWidth) && strokeWidth > 0) {
        changes.style = {
          ...object.style,
          strokeWidth: roundFreehandNumber(Math.max(0.1, strokeWidth * strokeScale))
        };
      }
    }
  }
  // Arrow endpoints are absolute page points, so scaling only the frame would leave the drawn arrow
  // at its original size inside a resized box.
  //
  // Rotation is deliberately *not* baked into these points. Both renderers draw the arrow at its
  // absolute anchors inside a group carrying `rotationTransform(object)`, so `changes.rotation`
  // below already turns it; rotating the anchors too would apply the angle twice and swing the arrow
  // off its frame. Scaling from the old centre and re-attaching at the new one is exactly what
  // `resizeGraphicObjectDataForFrame` does for graphics, and composes to the same result the caller
  // asked for: rotating the frame about `center` carries the offsets along with it.
  if (object.type === "reaction-arrow" || object.type === "mechanism-arrow") {
    const mapPoint = (point: PagePoint): PagePoint => ({
      x: newCenter.x + (point.x - oldCenter.x) * scaleX,
      y: newCenter.y + (point.y - oldCenter.y) * scaleY
    });
    if (object.type === "reaction-arrow") {
      changes.start = mapAnchorPoint(object.start, mapPoint);
      changes.end = mapAnchorPoint(object.end, mapPoint);
    } else {
      changes.source = mapAnchorPoint(object.source, mapPoint);
      changes.target = mapAnchorPoint(object.target, mapPoint);
      changes.controlPoints = object.controlPoints.map(mapPoint);
    }
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
  const set = new Set(resolveGroupedDocumentObjectIds(page.objects, ids));
  let next = document;
  for (const object of page.objects) {
    if (!set.has(object.id)) {
      continue;
    }
    next = object.type === "molecule"
      ? rotateNativeMoleculeGeometryAroundPoint(next, object.id, center, degrees)
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
  const set = new Set(resolveGroupedDocumentObjectIds(page.objects, ids));
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

export type DocumentFlipAxis = "horizontal" | "vertical";

export function flipSelectedDocumentObjects(
  document: ChemDraftDocument,
  axis: DocumentFlipAxis
): ChemDraftDocument {
  const page = firstPage(document);
  const objectIds = selectedTransformObjectIds(document);
  const bounds = selectionBounds(page.objects, objectIds);
  if (!bounds) {
    return document;
  }

  return flipDocumentObjectsAroundPoint(
    document,
    objectIds,
    { x: bounds.centerX, y: bounds.centerY },
    axis
  );
}

export function flipDocumentObjectsAroundPoint(
  document: ChemDraftDocument,
  ids: readonly string[],
  center: PagePoint,
  axis: DocumentFlipAxis
): ChemDraftDocument {
  if (ids.length === 0) {
    return document;
  }

  const page = firstPage(document);
  const set = new Set(resolveGroupedDocumentObjectIds(page.objects, ids));
  let next = document;
  for (const object of page.objects) {
    if (!set.has(object.id)) {
      continue;
    }
    next = object.type === "molecule"
      ? flipNativeMoleculeObjectAroundPoint(next, object.id, center, axis)
      : flipOtherObjectAroundPoint(next, object.id, center, axis);
  }
  return next;
}

function flipNativeMoleculeObjectAroundPoint(
  document: ChemDraftDocument,
  objectId: string,
  center: PagePoint,
  axis: DocumentFlipAxis
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const molecule = page?.objects.find((candidate): candidate is MoleculeObject =>
    candidate.id === objectId && candidate.type === "molecule"
  );
  if (!page || !molecule || molecule.atoms.length === 0) {
    return document;
  }

  const flipped = refreshNativeCyclicDoubleBondSides(normalizeNativeMoleculeGeometry({
    ...molecule,
    atoms: molecule.atoms.map((atom) => ({
      ...atom,
      ...flipPointAroundAxis(atom, center, axis)
    }))
  }));

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: flipped },
    { now: phase4Timestamp }
  );
}

function flipOtherObjectAroundPoint(
  document: ChemDraftDocument,
  objectId: string,
  center: PagePoint,
  axis: DocumentFlipAxis
): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  const object = page?.objects.find((candidate) => candidate.id === objectId);
  if (!page || !object) {
    return document;
  }

  const oldCenter = objectCenter(object);
  const newCenter = flipPointAroundAxis(oldCenter, center, axis);
  const scaleX = axis === "horizontal" ? -1 : 1;
  const scaleY = axis === "vertical" ? -1 : 1;
  const mirrorsOwnGeometry =
    object.type === "graphic" || object.type === "reaction-arrow" || object.type === "mechanism-arrow";
  const changes: Record<string, unknown> = {
    x: newCenter.x - object.width / 2,
    y: newCenter.y - object.height / 2,
    width: object.width,
    height: object.height,
    // An object with no mirrorable interior can only fake a horizontal flip as "rotate 180 after a
    // vertical one". Objects that mirror their own geometry below need no such trick: negating the
    // angle is the exact rotation of the mirrored shape, for either axis. Graphics used to be
    // carved out of that rule and kept their angle, so a rotated one flipped to 2*theta off the
    // mirror — and this branch made every arrow a graphic, putting the two arrow kinds at odds.
    rotation: mirrorsOwnGeometry
      ? normalizeDegrees(-object.rotation)
      : normalizeDegrees(axis === "horizontal" ? 180 - object.rotation : -object.rotation)
  };

  if (object.type === "electron-mark" && object.markKind === "charge") {
    changes.anchor = { ...object.anchor, kind: "point", point: newCenter };
  }
  if (object.type === "graphic") {
    changes.data = resizeGraphicObjectDataForFrame(object.data, oldCenter, newCenter, scaleX, scaleY);
    changes.style = flipGraphicObjectGradientStyle(object.style, axis);
  }
  // Arrow endpoints are absolute page points. Moving only the frame mirrors the box and leaves the
  // arrow inside it pointing the way it always did — so a flipped reaction scheme kept its original
  // direction. Mirror the anchors about the object's own centre and re-attach them at the new one;
  // the renderer's rotation transform (negated above) carries the rest.
  if (object.type === "reaction-arrow" || object.type === "mechanism-arrow") {
    const mapPoint = (point: PagePoint): PagePoint => ({
      x: newCenter.x + (point.x - oldCenter.x) * scaleX,
      y: newCenter.y + (point.y - oldCenter.y) * scaleY
    });
    if (object.type === "reaction-arrow") {
      changes.start = mapAnchorPoint(object.start, mapPoint);
      changes.end = mapAnchorPoint(object.end, mapPoint);
    } else {
      changes.source = mapAnchorPoint(object.source, mapPoint);
      changes.target = mapAnchorPoint(object.target, mapPoint);
      changes.controlPoints = object.controlPoints.map(mapPoint);
    }
  }

  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: changes as Partial<DocumentObject> },
    { now: phase4Timestamp }
  );
}

function flipGraphicObjectGradientStyle(
  style: GraphicObjectStyle,
  axis: DocumentFlipAxis
): GraphicObjectStyle {
  const fillPaint = flipGraphicPaintForAxis(style.fillPaint, axis);
  const strokePaint = flipGraphicPaintForAxis(style.strokePaint, axis);
  if (fillPaint === style.fillPaint && strokePaint === style.strokePaint) {
    return style;
  }

  return {
    ...style,
    ...(fillPaint === style.fillPaint ? {} : { fillPaint }),
    ...(strokePaint === style.strokePaint ? {} : { strokePaint })
  };
}

function flipGraphicPaintForAxis(
  paint: GraphicPaint | undefined,
  axis: DocumentFlipAxis
): GraphicPaint | undefined {
  if (paint?.kind === "linear-gradient") {
    return axis === "horizontal"
      ? {
          ...paint,
          x1: flipGradientUnitCoordinate(paint.x1),
          x2: flipGradientUnitCoordinate(paint.x2)
        }
      : {
          ...paint,
          y1: flipGradientUnitCoordinate(paint.y1),
          y2: flipGradientUnitCoordinate(paint.y2)
        };
  }

  if (paint?.kind === "radial-gradient") {
    return axis === "horizontal"
      ? {
          ...paint,
          cx: flipGradientUnitCoordinate(paint.cx),
          fx: typeof paint.fx === "number" ? flipGradientUnitCoordinate(paint.fx) : paint.fx
        }
      : {
          ...paint,
          cy: flipGradientUnitCoordinate(paint.cy),
          fy: typeof paint.fy === "number" ? flipGradientUnitCoordinate(paint.fy) : paint.fy
        };
  }

  return paint;
}

function flipGradientUnitCoordinate(value: number): number {
  return Number(clampWorkflowUnit(1 - value).toFixed(6));
}

function flipPointAroundAxis(
  point: PagePoint,
  center: PagePoint,
  axis: DocumentFlipAxis
): PagePoint {
  return axis === "horizontal"
    ? { x: center.x - (point.x - center.x), y: point.y }
    : { x: point.x, y: center.y - (point.y - center.y) };
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
    // Stripped perspective depth weights are a real change even when the geometry
    // was already ideal (the changed-check below only compares atoms/transform).
    const strippedDepthWeights = molecule.bonds.some((bond) => bond.display?.depthWeight !== undefined);
    return nativeMoleculeGeometryOrTransformChanged(molecule, cleaned) || strippedDepthWeights
      ? [{ op: "updateObject" as const, objectId: molecule.id, changes: cleaned }]
      : [];
  });

  if (patches.length === 0) {
    return document;
  }

  return applyPatches(document, patches, { now: phase4Timestamp });
}

/** True when any connected component of the molecule carries MORE than one ring (fused, bridged,
 *  spiro, or multiple rings joined by a chain) — the shapes the polygon+tree 2D cleanup cannot lay
 *  out and therefore leaves as drawn. MainWindow uses this to point the user at 3D Cleanup. */
export function moleculeHasFusedRingSystem(molecule: MoleculeObject): boolean {
  const adjacency = nativeAdjacency(molecule.atoms, molecule.bonds);
  return nativeComponents(molecule.atoms, adjacency).some((componentIds) => {
    const componentAtomSet = new Set(componentIds);
    const componentBondCount = molecule.bonds.filter(
      (bond) => componentAtomSet.has(bond.fromAtomId) && componentAtomSet.has(bond.toAtomId)
    ).length;
    return componentBondCount - componentIds.length + 1 >= 2;
  });
}

/**
 * Rebuild a native molecule's 2D geometry from an engine re-layout (the "3D Cleanup" command).
 * `relayout` receives the molecule as a V2000 molfile (atoms/bonds in model order) and returns a
 * depiction whose indices align 1:1 with that order — the OCL adapter's `relayoutMolfile2D`.
 * The fresh engine-frame coordinates (y-UP) map back into the document frame by negating y,
 * scaling so the mean bond length matches the drawing's current mean (clamped to the minimum
 * drawable length when collapsed), and recentring on the molecule's current centroid. Wedge/hash bonds
 * are REPLACED by the engine's parity-derived assignment (correct for the new geometry); other
 * bond decorations (dashed, bold) are preserved; double-bond sides and perspective depth weights
 * are recomputed/cleared for the new layout. Throws when the depiction cannot be trusted to map
 * back (atom count/element mismatch) — the caller surfaces that as a status, nothing commits.
 */
export function applyNativeMoleculeEngineRelayout(
  document: ChemDraftDocument,
  objectId: string,
  relayout: (molfile: string) => PastedStructureDepiction
): ChemDraftDocument {
  const molecule = findMoleculeObject(document, objectId);
  if (!molecule || !isEditableNativeMoleculeGraph(molecule) || molecule.atoms.length === 0) {
    return document;
  }

  const depiction = relayout(moleculeToMolfileV2000(molecule, { fromDocFrame: true }));
  if (depiction.atoms.length !== molecule.atoms.length) {
    throw new Error(
      `Engine re-layout returned ${depiction.atoms.length} atoms for a ${molecule.atoms.length}-atom structure.`
    );
  }
  depiction.atoms.forEach((atom, index) => {
    const expected = molecule.atoms[index].element;
    if (atom.element.toUpperCase() !== expected.toUpperCase()) {
      throw new Error(`Engine re-layout atom ${index + 1} is ${atom.element}, expected ${expected}.`);
    }
  });

  // Engine frame is y-UP; the document draws y-DOWN (the coordinate-frame contract: negate y, never
  // swap wedges).
  const enginePoints = depiction.atoms.map((atom) => ({ x: atom.x, y: -atom.y }));
  const engineBondLengths = depiction.bonds
    .map((bond) => {
      const from = enginePoints[bond.from];
      const to = enginePoints[bond.to];
      return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
    })
    .filter((length) => length > 0.001);
  const currentBondLengths = molecule.bonds
    .map((bond) => {
      const from = molecule.atoms.find((atom) => atom.id === bond.fromAtomId);
      const to = molecule.atoms.find((atom) => atom.id === bond.toAtomId);
      return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
    })
    .filter((length) => length > 0.001);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const currentBondLength = mean(currentBondLengths);
  // Repeated resize operations and malformed imports can leave a graph with nonzero but sub-pixel
  // bonds. Preserving that "scale" makes the clean depiction effectively disappear after rounding.
  // Clamp only collapsed drawings to the same conservative minimum accepted by freeform drawing;
  // normal small/large user scales remain unchanged.
  const targetBondLength = Math.max(currentBondLength, freeformMinimumBondLength);
  const engineBondLength = mean(engineBondLengths);
  const scale = engineBondLength > 0.001 ? targetBondLength / engineBondLength : 1;

  const engineCenter = averagePagePoint(enginePoints);
  const currentCenter = averagePagePoint(molecule.atoms);

  const atoms: MoleculeAtom[] = molecule.atoms.map((atom, index) => {
    const { z: _z, ...flatAtom } = atom;
    return {
      ...flatAtom,
      x: roundGeometryCoordinate(currentCenter.x + (enginePoints[index].x - engineCenter.x) * scale),
      y: roundGeometryCoordinate(currentCenter.y + (enginePoints[index].y - engineCenter.y) * scale)
    };
  });

  // Wedge/hash assignments follow the parities on the NEW geometry; index bonds by their endpoint
  // atom indices (bond order in the emitted molfile matches molecule.bonds minus dangling entries,
  // so pair keys are the robust join).
  const atomIndexById = new Map(molecule.atoms.map((atom, index) => [atom.id, index]));
  const engineBondByPair = new Map(
    depiction.bonds.map((bond) => [atomPairKey(`${Math.min(bond.from, bond.to)}`, `${Math.max(bond.from, bond.to)}`), bond])
  );
  const baseBonds: MoleculeBond[] = molecule.bonds.map((bond) => {
    const fromIndex = atomIndexById.get(bond.fromAtomId);
    const toIndex = atomIndexById.get(bond.toAtomId);
    const pairKey =
      fromIndex !== undefined && toIndex !== undefined
        ? atomPairKey(`${Math.min(fromIndex, toIndex)}`, `${Math.max(fromIndex, toIndex)}`)
        : undefined;
    const engineBond = pairKey !== undefined ? engineBondByPair.get(pairKey) : undefined;
    const wedge = engineBond?.wedge ?? null;
    const {
      bondStyle: previousStyle,
      depthWeight: _depthWeight,
      doubleBondSide: _side,
      ...restDisplay
    } = bond.display ?? {};
    const keptStyle = previousStyle === "wedge" || previousStyle === "hashed" ? undefined : previousStyle;
    const display = {
      ...restDisplay,
      ...(wedge ? { bondStyle: wedge } : keptStyle ? { bondStyle: keptStyle } : {})
    };
    // A wedge/hash is narrow at `from`. OCL may move the stereo marker to a different adjacent bond
    // and may orient that bond opposite to ChemDraft's pre-existing endpoint order. Preserve the
    // engine's directed narrow end; an unordered-pair-only transfer can turn R/S into unspecified.
    const engineFromAtomId = wedge && engineBond ? molecule.atoms[engineBond.from]?.id : undefined;
    const engineToAtomId = wedge && engineBond ? molecule.atoms[engineBond.to]?.id : undefined;
    const directedBond = engineFromAtomId && engineToAtomId
      ? { ...bond, fromAtomId: engineFromAtomId, toAtomId: engineToAtomId }
      : bond;
    return Object.keys(display).length > 0
      ? { ...directedBond, display }
      : { ...directedBond, display: undefined };
  });

  // Recompute each double bond's drawn side from the new geometry (ring doubles draw inward).
  const geometry = moleculeGeometryFromAtoms(atoms);
  const sideMolecule: MoleculeObject = { ...molecule, atoms, bonds: baseBonds, ...geometry };
  const bonds: MoleculeBond[] = baseBonds.map((bond) =>
    bond.order === "double"
      ? { ...bond, display: { ...(bond.display ?? {}), doubleBondSide: defaultDoubleBondSide(sideMolecule, bond) } }
      : bond
  );

  const cleaned = withNativeMoleculeTransform(
    normalizeNativeMoleculeGeometry({ ...molecule, atoms, bonds }),
    defaultNativeMoleculeTransform
  );
  const atomMetadataChanged = JSON.stringify(molecule.atoms) !== JSON.stringify(cleaned.atoms);
  const bondDisplayOrDirectionChanged = JSON.stringify(molecule.bonds) !== JSON.stringify(cleaned.bonds);
  const normalizedBoundsChanged =
    molecule.x !== cleaned.x ||
    molecule.y !== cleaned.y ||
    molecule.width !== cleaned.width ||
    molecule.height !== cleaned.height;
  if (
    !nativeMoleculeGeometryOrTransformChanged(molecule, cleaned) &&
    !atomMetadataChanged &&
    !bondDisplayOrDirectionChanged &&
    !normalizedBoundsChanged
  ) {
    return document;
  }

  return applyPatches(document, [{ op: "updateObject" as const, objectId: molecule.id, changes: cleaned }], {
    now: phase4Timestamp
  });
}

// ── 3D spin → flatten commit (Phase 5) ──────────────────────────────────────

export interface FlattenSpunOutcome {
  document: ChemDraftDocument;
  status: "committed" | "refused";
  warnings: FlattenWarning[];
  refusalReasons: string[];
  stereoCenters: StereoCenterReport[];
}

// ---------------------------------------------------------------------------
// Persisted Spin 3D model (the "3D source of truth" for 3D-backed rotation).
//
// After Spin 3D flattens a molecule we keep its conformer + committed view
// orientation so the ordinary X/Y/Z rotate handles can re-project the real 3D
// model instead of shearing the flattened 2D drawing. It lives under the
// permissive `compatibility.unknown` record (NOT a strict schema field) using a
// versioned, namespaced key — so it survives save/reload while older builds can
// still open new files (the key is simply ignored there). Validated on read; a
// stale model (graph edited since it was written) is ignored via the
// graph-signature gate, so we never have to proactively clear it.
// ---------------------------------------------------------------------------
export const SPIN3D_MODEL_KEY = "chemdraft.spin3d.model.v1";

type Spin3dOrientation = { x: number; y: number; z: number; w: number };

export interface Spin3dEngineProvenance {
  name: string;
  version?: string;
  forceField?: string;
}

export interface Spin3dDocumentModelV1 {
  kind: typeof SPIN3D_MODEL_KEY;
  /** conformerGraphSignature(molecule) at write time — the validity gate. */
  graphSignature: string;
  /** Defines coords3d order; robust to positional reordering of atoms. */
  atomIds: string[];
  /** Flat [x,y,z,...] in the MATH frame (y-up), in atomIds order. */
  coords3d: number[];
  /** The committed view orientation; the conformer is re-projected through this. */
  orientation: Spin3dOrientation;
  engine?: Spin3dEngineProvenance;
  updatedAt: string;
}

// Deliberately position-independent: dragging or flattening a molecule (which only
// moves its 2D x/y) keeps the signature stable, so a stored spin model survives those.
// Editing the graph (add/remove atom, change element/charge/bond order) changes it,
// invalidating a stale model.
export function conformerGraphSignature(molecule: MoleculeObject): string {
  const atoms = molecule.atoms.map((atom) => `${atom.id}:${atom.element}:${atom.formalCharge}`).join(",");
  const bonds = molecule.bonds.map((bond) => `${bond.fromAtomId}>${bond.toAtomId}:${bond.order}`).join(",");
  return `${atoms}|${bonds}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Reads + structurally validates the persisted Spin 3D model (no graph-match check). */
export function readSpin3dModel(molecule: MoleculeObject): Spin3dDocumentModelV1 | undefined {
  const raw = molecule.compatibility?.unknown?.[SPIN3D_MODEL_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const model = raw as Partial<Spin3dDocumentModelV1>;
  if (model.kind !== SPIN3D_MODEL_KEY) return undefined;
  if (typeof model.graphSignature !== "string") return undefined;
  if (!Array.isArray(model.atomIds) || !model.atomIds.every((id) => typeof id === "string")) return undefined;
  if (!Array.isArray(model.coords3d) || !model.coords3d.every(isFiniteNumber)) return undefined;
  if (model.coords3d.length !== model.atomIds.length * 3) return undefined;
  const orientation = model.orientation;
  if (
    !orientation ||
    !isFiniteNumber(orientation.x) ||
    !isFiniteNumber(orientation.y) ||
    !isFiniteNumber(orientation.z) ||
    !isFiniteNumber(orientation.w)
  ) {
    return undefined;
  }
  if (typeof model.updatedAt !== "string") return undefined;
  return model as Spin3dDocumentModelV1;
}

/** The persisted model only if it still matches the molecule's current graph. */
export function validSpin3dModelFor(molecule: MoleculeObject): Spin3dDocumentModelV1 | undefined {
  const model = readSpin3dModel(molecule);
  return model && model.graphSignature === conformerGraphSignature(molecule) ? model : undefined;
}

/** coords3d reordered from the model's atomIds order into the molecule's current atom order. */
export function spin3dModelCoordsForMolecule(
  model: Spin3dDocumentModelV1,
  molecule: MoleculeObject
): Float64Array | undefined {
  const indexById = new Map(model.atomIds.map((id, index) => [id, index]));
  const out = new Float64Array(molecule.atoms.length * 3);
  for (let i = 0; i < molecule.atoms.length; i += 1) {
    const src = indexById.get(molecule.atoms[i].id);
    if (src === undefined) return undefined;
    out[i * 3] = model.coords3d[src * 3];
    out[i * 3 + 1] = model.coords3d[src * 3 + 1];
    out[i * 3 + 2] = model.coords3d[src * 3 + 2];
  }
  return out;
}

/** Build a v1 model for `molecule` (coords3d must already be in molecule.atoms order). */
export function buildSpin3dModel(args: {
  molecule: MoleculeObject;
  coords3d: ArrayLike<number>;
  orientation: Spin3dOrientation;
  engine?: Spin3dEngineProvenance;
}): Spin3dDocumentModelV1 {
  return {
    kind: SPIN3D_MODEL_KEY,
    graphSignature: conformerGraphSignature(args.molecule),
    atomIds: args.molecule.atoms.map((atom) => atom.id),
    coords3d: Array.from(args.coords3d),
    orientation: {
      x: args.orientation.x,
      y: args.orientation.y,
      z: args.orientation.z,
      w: args.orientation.w
    },
    engine: args.engine,
    updatedAt: new Date().toISOString()
  };
}

function findMoleculeObjectById(document: ChemDraftDocument, objectId: string): MoleculeObject | undefined {
  return document.pages
    .flatMap((page) => page.objects)
    .find((object): object is MoleculeObject => object.id === objectId && object.type === "molecule");
}

function persistSpin3dModel(
  document: ChemDraftDocument,
  objectId: string,
  molecule: MoleculeObject,
  model: Spin3dDocumentModelV1
): ChemDraftDocument {
  const existing = molecule.compatibility;
  const compatibility = {
    ...(existing ?? {}),
    warnings: existing?.warnings ?? [],
    unknown: { ...(existing?.unknown ?? {}), [SPIN3D_MODEL_KEY]: model }
  };
  return applyPatch(
    document,
    { op: "updateObject", objectId, changes: { compatibility } },
    { now: phase4Timestamp }
  );
}

/**
 * Persist `model` under the molecule's `compatibility.unknown`, merging (never
 * clobbering) any existing compatibility data. Returns the document unchanged if the
 * object is missing. Goes through `applyPatch`, so the result is schema-validated.
 */
export function attachSpin3dModel(
  document: ChemDraftDocument,
  objectId: string,
  model: Spin3dDocumentModelV1
): ChemDraftDocument {
  const molecule = findMoleculeObjectById(document, objectId);
  if (!molecule) return document;
  return persistSpin3dModel(document, objectId, molecule, model);
}

/**
 * Build a v1 model from a conformer + committed orientation and persist it in one pass:
 * finds the molecule ONCE, signs its current graph, and attaches. Returns the document
 * unchanged if the object is missing. Use this from the rotate/flatten commit paths so the
 * find → buildSpin3dModel → attach sequence lives in a single place.
 */
export function attachSpin3dModelFromConformer(
  document: ChemDraftDocument,
  objectId: string,
  conformer: { coords3d: ArrayLike<number>; orientation: Spin3dOrientation; engine?: Spin3dEngineProvenance }
): ChemDraftDocument {
  const molecule = findMoleculeObjectById(document, objectId);
  if (!molecule) return document;
  const model = buildSpin3dModel({ molecule, ...conformer });
  return persistSpin3dModel(document, objectId, molecule, model);
}

function pointBondLengths(
  atoms: readonly { x: number; y: number }[],
  bondPairs: readonly (readonly [number, number])[]
): number[] {
  return bondPairs
    .map(([from, to]) => Math.hypot(atoms[from].x - atoms[to].x, atoms[from].y - atoms[to].y))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
}

function medianOf(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function atomsCentroid(atoms: readonly { x: number; y: number }[]): { x: number; y: number } {
  if (atoms.length === 0) return { x: 0, y: 0 };
  const sum = atoms.reduce((acc, a) => ({ x: acc.x + a.x, y: acc.y + a.y }), { x: 0, y: 0 });
  return { x: sum.x / atoms.length, y: sum.y / atoms.length };
}

/**
 * Reads a 2D depiction's molfile and reports, per atom (index-aligned), whether it is a true
 * stereocenter and its CIP descriptor. Injected (not imported) so this module stays independent of
 * the chemistry engine and the reconcile logic is unit-testable with a fake reader.
 */
export type StereoPerceiver = (
  molfile: string
) => ReadonlyArray<{ isStereoCenter: boolean; descriptor: "R" | "S" | "unspecified" }>;

/**
 * Make a freshly flattened depiction READ BACK as the same stereochemistry it started with.
 *
 * The perspective encoder proves each wedge sound against its OWN geometric model, but that model
 * can disagree with how a real CIP perceiver reads the squished 2D drawing of a dense fused cage
 * (see the strychnine/fenchol class of failures). Here we ask the actual perceiver (injected) what
 * the drawing says; wherever a center that was specified BEFORE the flatten now reads the wrong
 * hand, we flip that center's own wedge↔hash — which inverts only that center's reading — and
 * re-check. `ok:false` means no consistent set of flips reproduces every specified center (a
 * genuinely un-encodable view); the caller then refuses, leaving the document untouched.
 *
 * `ok:true` is returned ONLY straight after a perception that confirmed every specified center, so
 * the returned bonds are always validated-correct, never a hopeful guess.
 */
export function reconcileFlattenedStereo(
  templateMolecule: MoleculeObject,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  reference: ReadonlyMap<number, "R" | "S">,
  perceive: StereoPerceiver,
  options: {
    /** Rotated conformer depth by atom id; larger values are nearer the viewer. */
    depthByAtomId?: ReadonlyMap<string, number>;
  } = {}
): {
  ok: boolean;
  bonds: MoleculeBond[];
  unresolved: number[];
  /**
   * Why `ok` is false: "stereochemistry" means the drawing reads back wrong CIP descriptors at
   * `unresolved` centers; "legibility" means every descriptor is correct but the depiction keeps
   * two same-style glyphs at one atom and no CIP-safe relocation was found.
   */
  reason?: "stereochemistry" | "legibility";
} {
  const cloneBonds = (source: readonly MoleculeBond[]): MoleculeBond[] =>
    source.map((bond) => ({ ...bond, display: bond.display ? { ...bond.display } : undefined }));
  if (reference.size === 0) return { ok: true, bonds: cloneBonds(bonds), unresolved: [] };

  const atomIdByIndex = atoms.map((atom) => atom.id);
  const isWedge = (bond: MoleculeBond): boolean =>
    bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed";
  const signatureOf = (source: readonly MoleculeBond[]): string =>
    source.map((bond) => (bond.display?.bondStyle === "wedge" ? "W" : bond.display?.bondStyle === "hashed" ? "H" : "-")).join("");
  const perceiveOf = (source: readonly MoleculeBond[]) =>
    perceive(moleculeToMolfileV2000({ ...templateMolecule, atoms: atoms.slice(), bonds: source.slice() }, { fromDocFrame: true }));

  let current = cloneBonds(bonds);
  const seen = new Set<string>();
  const maxIterations = reference.size + 4;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const signature = signatureOf(current);
    if (seen.has(signature)) break; // revisited a configuration ⇒ cycling among wrong states, give up
    seen.add(signature);

    const perceived = perceiveOf(current);
    const wrong: number[] = [];
    for (const [index, want] of reference) {
      const got = perceived[index];
      if (!got || !got.isStereoCenter || got.descriptor !== want) wrong.push(index);
    }
    if (wrong.length === 0) {
      // CIP correctness is necessary but not sufficient for a readable perspective drawing:
      // two identical stereo glyphs meeting at one atom look like an accidental double wedge/hash.
      // Relocate one marker only through whole-molecule CIP-validated trials. This is deliberately
      // done here, not in the renderer, because swapping stereo endpoints during paint can change
      // or erase a stereocenter while leaving the stored molecule untouched.
      const readable = relocateRepeatedStereoMarkers(
        templateMolecule,
        atoms,
        current,
        reference,
        perceive,
        options.depthByAtomId
      );
      // Every CIP descriptor is already validated here, so a relocation failure is a pure
      // legibility refusal: report it as such rather than claiming centers would change.
      return readable
        ? { ok: true, bonds: readable, unresolved: [] }
        : { ok: false, bonds: current, unresolved: [], reason: "legibility" };
    }

    const next = cloneBonds(current);
    const unfixable: number[] = [];
    let flippedAny = false;
    for (const index of wrong) {
      const centerId = atomIdByIndex[index];
      // The encoder writes each center's wedge narrow-end-at-center (fromAtomId === center).
      const ownWedge = next.find((bond) => bond.fromAtomId === centerId && isWedge(bond));
      if (!ownWedge?.display) {
        unfixable.push(index); // defined by neighbours' wedges, no own wedge to flip
        continue;
      }
      ownWedge.display.bondStyle = ownWedge.display.bondStyle === "wedge" ? "hashed" : "wedge";
      flippedAny = true;
    }
    if (!flippedAny) {
      return {
        ok: false,
        bonds: current,
        unresolved: unfixable.length > 0 ? unfixable : wrong,
        reason: "stereochemistry"
      };
    }
    current = next;
  }
  return { ok: false, bonds: current, unresolved: [...reference.keys()], reason: "stereochemistry" };
}

type RepeatedStereoMarker = {
  atomId: string;
  style: "wedge" | "hashed";
  bondIds: string[];
};

function repeatedStereoMarkers(bonds: readonly MoleculeBond[]): RepeatedStereoMarker[] {
  const byEndpointAndStyle = new Map<string, RepeatedStereoMarker>();
  for (const bond of bonds) {
    const style = bond.display?.bondStyle;
    if (style !== "wedge" && style !== "hashed") continue;
    for (const atomId of [bond.fromAtomId, bond.toAtomId]) {
      const key = `${atomId}:${style}`;
      const entry = byEndpointAndStyle.get(key) ?? { atomId, style, bondIds: [] };
      entry.bondIds.push(bond.id);
      byEndpointAndStyle.set(key, entry);
    }
  }
  return [...byEndpointAndStyle.values()].filter((entry) => entry.bondIds.length > 1);
}

function relocateRepeatedStereoMarkers(
  templateMolecule: MoleculeObject,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  reference: ReadonlyMap<number, "R" | "S">,
  perceive: StereoPerceiver,
  depthByAtomId?: ReadonlyMap<string, number>
): MoleculeBond[] | undefined {
  const cloneBonds = (source: readonly MoleculeBond[]): MoleculeBond[] =>
    source.map((bond) => ({ ...bond, display: bond.display ? { ...bond.display } : undefined }));
  const atomIndexById = new Map(atoms.map((atom, index) => [atom.id, index] as const));
  const atomById = new Map(atoms.map((atom) => [atom.id, atom] as const));
  const projectedBondLengths = bonds
    .map((bond) => {
      const from = atomById.get(bond.fromAtomId);
      const to = atomById.get(bond.toAtomId);
      return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
    })
    .filter((length) => length > 0)
    .sort((left, right) => left - right);
  const projectedBondLengthMid = Math.floor(projectedBondLengths.length / 2);
  const medianProjectedBondLength = projectedBondLengths.length === 0
    ? 1
    : projectedBondLengths.length % 2 === 0
      ? (
        projectedBondLengths[projectedBondLengthMid - 1] +
        projectedBondLengths[projectedBondLengthMid]
      ) / 2
      : projectedBondLengths[projectedBondLengthMid];
  const minLegibleStereoBondLength =
    DEFAULT_MIN_PROJECTED_BOND_LENGTH_FRACTION * medianProjectedBondLength;
  const projectedLength = (fromAtomId: string, toAtomId: string): number => {
    const from = atomById.get(fromAtomId);
    const to = atomById.get(toAtomId);
    return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
  };
  const isStereo = (bond: MoleculeBond): boolean =>
    bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed";
  const signature = (source: readonly MoleculeBond[]): string =>
    JSON.stringify(source.map((bond) => [
      bond.id,
      bond.fromAtomId,
      bond.toAtomId,
      bond.display?.bondStyle ?? null
    ]));
  const referenceMatchCache = new Map<string, boolean>();
  let perceptionCalls = 0;
  let visitedStates = 1;
  let budgetExhausted = false;
  const maxPerceptionCalls = Math.max(64, Math.min(256, reference.size * 24));
  const maxVisitedStates = Math.max(96, Math.min(384, reference.size * 32));
  const referenceMatches = (source: readonly MoleculeBond[]): boolean => {
    const sourceSignature = signature(source);
    const cached = referenceMatchCache.get(sourceSignature);
    if (cached !== undefined) return cached;
    if (perceptionCalls >= maxPerceptionCalls) {
      budgetExhausted = true;
      return false;
    }
    perceptionCalls += 1;
    const perceived = perceive(
      moleculeToMolfileV2000(
        { ...templateMolecule, atoms: atoms.slice(), bonds: source.slice() },
        { fromDocFrame: true }
      )
    );
    for (const [index, descriptor] of reference) {
      const result = perceived[index];
      if (!result?.isStereoCenter || result.descriptor !== descriptor) {
        referenceMatchCache.set(sourceSignature, false);
        return false;
      }
    }
    referenceMatchCache.set(sourceSignature, true);
    return true;
  };
  const removeStereoStyle = (bond: MoleculeBond): void => {
    if (!bond.display) return;
    const { bondStyle: _removed, ...rest } = bond.display;
    void _removed;
    bond.display = Object.keys(rest).length > 0 ? rest : undefined;
  };
  const collisionPenalty = (source: readonly MoleculeBond[]): number =>
    repeatedStereoMarkers(source).reduce((sum, entry) => sum + entry.bondIds.length - 1, 0);

  type Trial = {
    bonds: MoleculeBond[];
    collisionPenalty: number;
    depthScore: number;
  };
  const maxDepth = Math.min(24, Math.max(12, reference.size * 3));
  const greatestRemainingDepthBySignature = new Map<string, number>([
    [signature(bonds), maxDepth]
  ]);

  const search = (source: MoleculeBond[], remainingDepth: number): MoleculeBond[] | undefined => {
    const collision = repeatedStereoMarkers(source)[0];
    if (!collision) return source;
    if (remainingDepth <= 0) return undefined;

    const stereoBondIds = new Set(source.filter(isStereo).map((bond) => bond.id));
    const trials: Trial[] = [];
    for (const sourceBondId of collision.bondIds) {
      const sourceBond = source.find((bond) => bond.id === sourceBondId);
      if (!sourceBond || !isStereo(sourceBond)) continue;
      // ChemDraft's stereo contract is narrow-end-at-center, so only that atom owns this marker.
      const centerId = sourceBond.fromAtomId;
      const centerIndex = atomIndexById.get(centerId);
      if (centerIndex === undefined || !reference.has(centerIndex)) continue;
      const centerAtom = atomById.get(centerId);
      if (!centerAtom) continue;

      for (const candidate of source) {
        if (candidate.order !== "single") continue;
        const neighborId = candidate.fromAtomId === centerId
          ? candidate.toAtomId
          : candidate.toAtomId === centerId
            ? candidate.fromAtomId
            : undefined;
        if (!neighborId) continue;
        if (candidate.id !== sourceBond.id && stereoBondIds.has(candidate.id)) continue;
        const neighborAtom = atomById.get(neighborId);
        if (!neighborAtom) continue;
        const candidateProjectedLength = projectedLength(centerId, neighborId);
        if (candidateProjectedLength < minLegibleStereoBondLength) continue;

        for (const style of ["wedge", "hashed"] as const) {
          if (
            candidate.id === sourceBond.id &&
            sourceBond.fromAtomId === centerId &&
            sourceBond.display?.bondStyle === style
          ) {
            continue;
          }
          const next = cloneBonds(source);
          const nextSource = next.find((bond) => bond.id === sourceBond.id);
          const nextCandidate = next.find((bond) => bond.id === candidate.id);
          if (!nextSource || !nextCandidate) continue;
          removeStereoStyle(nextSource);
          nextCandidate.fromAtomId = centerId;
          nextCandidate.toAtomId = neighborId;
          nextCandidate.display = { ...(nextCandidate.display ?? {}), bondStyle: style };

          const nextSignature = signature(next);
          const nextRemainingDepth = remainingDepth - 1;
          const greatestSeenRemaining =
            greatestRemainingDepthBySignature.get(nextSignature);
          if (
            greatestSeenRemaining !== undefined &&
            greatestSeenRemaining >= nextRemainingDepth
          ) {
            continue;
          }
          const centerDepth = depthByAtomId?.get(centerId);
          const neighborDepth = depthByAtomId?.get(neighborId);
          const signedDepth =
            centerDepth !== undefined && neighborDepth !== undefined
              ? neighborDepth - centerDepth
              : 0;
          const depthAlignment = style === "wedge" ? signedDepth : -signedDepth;
          trials.push({
            bonds: next,
            // Repeated glyph removal is a hard, lexicographically first requirement. Depth only
            // ranks equally readable, chemistry-valid depictions.
            collisionPenalty: collisionPenalty(next),
            depthScore:
              depthAlignment * 10 +
              Math.abs(signedDepth) +
              candidateProjectedLength * 0.01
          });
        }
      }
    }

    trials.sort((left, right) =>
      left.collisionPenalty - right.collisionPenalty ||
      right.depthScore - left.depthScore
    );
    for (const trial of trials) {
      if (budgetExhausted) return undefined;
      const trialSignature = signature(trial.bonds);
      const nextRemainingDepth = remainingDepth - 1;
      const greatestSeenRemaining =
        greatestRemainingDepthBySignature.get(trialSignature);
      if (
        greatestSeenRemaining !== undefined &&
        greatestSeenRemaining >= nextRemainingDepth
      ) {
        continue;
      }
      if (visitedStates >= maxVisitedStates) {
        budgetExhausted = true;
        return undefined;
      }
      visitedStates += 1;
      greatestRemainingDepthBySignature.set(trialSignature, nextRemainingDepth);
      if (!referenceMatches(trial.bonds)) continue;
      const resolved = search(trial.bonds, nextRemainingDepth);
      if (resolved) return resolved;
    }
    return undefined;
  };

  const readable = search(cloneBonds(bonds), maxDepth);
  if (!readable || !depthByAtomId) return readable;

  // Once repeated glyphs are gone, improve each center's perspective cue without weakening the
  // chemistry guard. A solid wedge should preferentially point to a nearer substituent and a hash
  // to a farther one. Every proposed relocation is reparsed and must preserve all reference CIP
  // descriptors, so depth can rank safe alternatives but can never manufacture stereochemistry.
  let depthAligned = readable;
  const ownedMarkers = () => depthAligned.filter((bond) => {
    if (!isStereo(bond)) return false;
    const centerIndex = atomIndexById.get(bond.fromAtomId);
    return centerIndex !== undefined && reference.has(centerIndex);
  });
  const depthCueScore = (
    centerId: string,
    neighborId: string,
    style: "wedge" | "hashed"
  ): number => {
    const centerDepth = depthByAtomId.get(centerId);
    const neighborDepth = depthByAtomId.get(neighborId);
    const centerAtom = atomById.get(centerId);
    const neighborAtom = atomById.get(neighborId);
    if (
      centerDepth === undefined ||
      neighborDepth === undefined ||
      !centerAtom ||
      !neighborAtom
    ) {
      return Number.NEGATIVE_INFINITY;
    }
    const signedDepth = neighborDepth - centerDepth;
    const alignment = style === "wedge" ? signedDepth : -signedDepth;
    return (
      alignment * 10 +
      Math.abs(signedDepth) +
      Math.hypot(neighborAtom.x - centerAtom.x, neighborAtom.y - centerAtom.y) * 0.01
    );
  };

  const markersByWorstCue = ownedMarkers().sort((left, right) => {
    const leftStyle = left.display?.bondStyle;
    const rightStyle = right.display?.bondStyle;
    return depthCueScore(
      left.fromAtomId,
      left.toAtomId,
      leftStyle === "hashed" ? "hashed" : "wedge"
    ) - depthCueScore(
      right.fromAtomId,
      right.toAtomId,
      rightStyle === "hashed" ? "hashed" : "wedge"
    );
  });
  for (const markerSnapshot of markersByWorstCue) {
    const currentMarker = depthAligned.find((bond) => bond.id === markerSnapshot.id);
    const currentStyle = currentMarker?.display?.bondStyle;
    if (
      !currentMarker ||
      (currentStyle !== "wedge" && currentStyle !== "hashed")
    ) {
      continue;
    }
    const centerId = currentMarker.fromAtomId;
    const currentScore = depthCueScore(centerId, currentMarker.toAtomId, currentStyle);
    const stereoBondIds = new Set(depthAligned.filter(isStereo).map((bond) => bond.id));
    let best: { bonds: MoleculeBond[]; score: number } | undefined;

    for (const candidate of depthAligned) {
      if (candidate.order !== "single") continue;
      const neighborId = candidate.fromAtomId === centerId
        ? candidate.toAtomId
        : candidate.toAtomId === centerId
          ? candidate.fromAtomId
          : undefined;
      if (!neighborId) continue;
      if (candidate.id !== currentMarker.id && stereoBondIds.has(candidate.id)) continue;
      if (projectedLength(centerId, neighborId) < minLegibleStereoBondLength) continue;

      for (const style of ["wedge", "hashed"] as const) {
        const score = depthCueScore(centerId, neighborId, style);
        if (score <= currentScore + 1e-6 || score <= (best?.score ?? Number.NEGATIVE_INFINITY)) {
          continue;
        }
        const trial = cloneBonds(depthAligned);
        const trialCurrent = trial.find((bond) => bond.id === currentMarker.id);
        const trialCandidate = trial.find((bond) => bond.id === candidate.id);
        if (!trialCurrent || !trialCandidate) continue;
        removeStereoStyle(trialCurrent);
        trialCandidate.fromAtomId = centerId;
        trialCandidate.toAtomId = neighborId;
        trialCandidate.display = { ...(trialCandidate.display ?? {}), bondStyle: style };
        if (budgetExhausted) return depthAligned;
        if (repeatedStereoMarkers(trial).length > 0) continue;
        const trialMatchesReference = referenceMatches(trial);
        // This second pass is optional perspective polish. If its private budget is spent, keep
        // the already collision-free, CIP-validated depiction instead of rejecting safe work.
        if (budgetExhausted) return depthAligned;
        if (!trialMatchesReference) continue;
        best = { bonds: trial, score };
      }
    }
    if (best) depthAligned = best.bonds;
  }

  return depthAligned;
}

/**
 * Commit a spun 3D conformer as a flattened 2D perspective depiction (Phase 5).
 *
 * `coords3d` is the spun conformer (math frame, y-up), indexed by the molecule's
 * atom order. This applies the coordinate-frame recipe (negate y in, negate y out;
 * see docs/architecture/3d-spin-flatten.md), rescales/recenters the projection to
 * the molecule's existing 2D footprint, rewrites the molfile `structure`, and bakes
 * any depth-derived over/under crossings — refusing (document untouched) when the
 * flatten cannot preserve identity. The whole result is one `applyPatches` call, so
 * a single undo reverts geometry, wedges, and crossings together.
 */
export function flattenSpunMolecule(
  document: ChemDraftDocument,
  objectId: string,
  coords3d: ArrayLike<number>,
  viewMatrix: ViewMatrix,
  options: { placement?: ScreenPlacement; stereoCenterAtomIds?: ReadonlySet<string>; perceiveStereo?: StereoPerceiver } = {}
): FlattenSpunOutcome {
  let pageId: string | undefined;
  let molecule: MoleculeObject | undefined;
  for (const page of document.pages) {
    const found = page.objects.find((object) => object.id === objectId);
    if (found && found.type === "molecule") {
      molecule = found;
      pageId = page.id;
      break;
    }
  }
  if (!molecule || !pageId || !isEditableNativeMoleculeGraph(molecule)) {
    return {
      document,
      status: "refused",
      warnings: [],
      refusalReasons: ["target is not an editable native molecule"],
      stereoCenters: []
    };
  }
  if (coords3d.length !== molecule.atoms.length * 3) {
    return {
      document,
      status: "refused",
      warnings: [],
      refusalReasons: [`conformer atom count ${coords3d.length / 3} ≠ molecule atom count ${molecule.atoms.length}`],
      stereoCenters: []
    };
  }

  // Frame recipe IN: document (y-down) → math (y-up), styles untouched.
  const mathMol: MoleculeObject = {
    ...molecule,
    atoms: molecule.atoms.map((atom) => ({ ...atom, y: -atom.y }))
  };
  const result = flattenPerspectiveFrom3D(mathMol, coords3d, viewMatrix, {
    objectId,
    stereoCenterAtomIds: options.stereoCenterAtomIds
  });
  if (result.status !== "committed" || !result.mol2dProjected) {
    return {
      document,
      status: "refused",
      warnings: result.warnings,
      refusalReasons: result.refusalReasons,
      stereoCenters: result.stereoCenters
    };
  }

  const projected = result.mol2dProjected;
  // Frame recipe OUT: math (y-up) → document (y-down), styles untouched.
  const projectedById = new Map(
    projected.atoms.map((atom) => [atom.id, { ...atom, y: -atom.y }] as const)
  );

  // Rescale/recenter the projection to its intended visual placement. Older call sites
  // keep the median-bond fallback; modeled Spin 3D paths pass a fixed ScreenPlacement
  // so flatten exactly matches the live overlay contract.
  const atomIndex = new Map(molecule.atoms.map((atom, index) => [atom.id, index] as const));
  const bondPairs = molecule.bonds
    .map((bond) => [atomIndex.get(bond.fromAtomId), atomIndex.get(bond.toAtomId)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
  const projectedInOrder = molecule.atoms.map((atom) => projectedById.get(atom.id) ?? atom);
  const projectedCentroid = atomsCentroid(projectedInOrder);
  const placement = options.placement;
  const scale = placement
    ? placement.scale
    : (() => {
        const medianOriginal = medianOf(pointBondLengths(molecule.atoms, bondPairs));
        const medianProjected = medianOf(pointBondLengths(projectedInOrder, bondPairs));
        return medianProjected > 0 ? medianOriginal / medianProjected : 1;
      })();
  const targetCenter = placement
    ? { x: placement.centerX, y: placement.centerY }
    : atomsCentroid(molecule.atoms);

  let nextAtoms: MoleculeAtom[] = molecule.atoms.map((atom) => {
    const p = projectedById.get(atom.id) ?? atom;
    return {
      ...atom,
      x: targetCenter.x + (p.x - projectedCentroid.x) * scale,
      y: targetCenter.y + (p.y - projectedCentroid.y) * scale
    };
  });
  // Clamp into the page bounds (mirrors scaleParsedMolfileAtoms).
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (page) {
    const geometry = moleculeGeometryFromAtoms(nextAtoms);
    const boundedX = clamp(geometry.x, 0, Math.max(0, page.width - geometry.width));
    const boundedY = clamp(geometry.y, 0, Math.max(0, page.height - geometry.height));
    const shiftX = boundedX - geometry.x;
    const shiftY = boundedY - geometry.y;
    if (Math.abs(shiftX) > 0.001 || Math.abs(shiftY) > 0.001) {
      nextAtoms = nextAtoms.map((atom) => ({ ...atom, x: atom.x + shiftX, y: atom.y + shiftY }));
    }
  }

  // Bonds carry the flatten's graph + any re-encoded wedges; double/aromatic orders
  // and atom pairings are preserved exactly (buildProjectedMolecule never moves them).
  const projectedBonds = projected.bonds.map((bond) => ({ ...bond }));
  const geometry = moleculeGeometryFromAtoms(nextAtoms);
  // Perspective depth cue: bake each bond's viewer-facing depth (mean rotated z of its
  // endpoints, normalized 0 = farthest … 1 = nearest) into display.depthWeight so the
  // committed 2D drawing keeps the near-heavy / far-light bond weighting of the live
  // overlay. Display-only — identity is untouched. A near-planar view (no meaningful
  // depth spread) writes none and clears stale weights from an earlier flatten.
  const depthOf = (atomId: string): number | undefined => {
    const index = atomIndex.get(atomId);
    if (index === undefined) return undefined;
    const x = coords3d[index * 3];
    const y = coords3d[index * 3 + 1];
    const z = coords3d[index * 3 + 2];
    return viewMatrix[8] * x + viewMatrix[9] * y + viewMatrix[10] * z + viewMatrix[11];
  };
  const bondDepths = projectedBonds.map((bond) => {
    const from = depthOf(bond.fromAtomId);
    const to = depthOf(bond.toAtomId);
    return from !== undefined && to !== undefined ? (from + to) / 2 : undefined;
  });
  const knownDepths = bondDepths.filter((depth): depth is number => depth !== undefined);
  // Loop rather than Math.min(...knownDepths): argument spread can blow the call-stack arg
  // limit (~65k) on a very large molecule.
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const depth of knownDepths) {
    if (depth < minDepth) minDepth = depth;
    if (depth > maxDepth) maxDepth = depth;
  }
  const depthSpan = maxDepth - minDepth;
  const median3d = medianOf(
    bondPairs.map(([from, to]) => Math.hypot(
      coords3d[from * 3] - coords3d[to * 3],
      coords3d[from * 3 + 1] - coords3d[to * 3 + 1],
      coords3d[from * 3 + 2] - coords3d[to * 3 + 2]
    ))
  );
  const meaningfulDepth = knownDepths.length > 1 && depthSpan > median3d * 0.12;
  const depthWeightFor = (bondIndex: number): number | undefined => {
    if (!meaningfulDepth) return undefined;
    const depth = bondDepths[bondIndex];
    if (depth === undefined) return undefined;
    return Math.round(((depth - minDepth) / depthSpan) * 100) / 100;
  };
  // The projection produced fresh 2D coordinates, so every double bond's "side" (which
  // way its inner line is drawn) must be recomputed from the new geometry — otherwise
  // ring double bonds default to the wrong side and render OUTSIDE the ring. Reuse the
  // app's own neighbor-mass heuristic so flattened depictions match drawn ones.
  const sideMolecule: MoleculeObject = { ...molecule, atoms: nextAtoms, bonds: projectedBonds, ...geometry };
  const ringInteriorSides = ringInteriorDoubleBondSides(sideMolecule);
  const nextBonds = projectedBonds.map((bond, bondIndex) => {
    const display: NonNullable<MoleculeBond["display"]> = { ...(bond.display ?? {}) };
    if (bond.order === "double") {
      // Baking a side unconditionally broke "releasing changes nothing visually": a bond that
      // renders as the symmetric straddle has no side, and writing one turned it one-sided the
      // instant the spin was committed. An explicit side is itself one of the conditions that
      // suppresses the straddle, so only bonds that really draw with a side get one.
      const fromAtom = nextAtoms.find((atom) => atom.id === bond.fromAtomId);
      const toAtom = nextAtoms.find((atom) => atom.id === bond.toAtomId);
      const symmetric = fromAtom !== undefined && toAtom !== undefined &&
        doubleBondRendersSymmetric(fromAtom, toAtom, sideMolecule, bond, ringInteriorSides.get(bond.id));
      if (symmetric) {
        delete display.doubleBondSide;
      } else {
        display.doubleBondSide = defaultDoubleBondSide(sideMolecule, bond);
      }
    }
    const depthWeight = depthWeightFor(bondIndex);
    if (depthWeight !== undefined) display.depthWeight = depthWeight;
    else delete display.depthWeight;
    return Object.keys(display).length > 0 ? { ...bond, display } : { ...bond, display: undefined };
  });
  // Read-back stereo guard: the encoder proved its wedges sound against its own geometric model,
  // but that model can mis-read the squished projection of a dense fused cage. Ask the real CIP
  // perceiver (injected) what the drawing actually says and flip any center that reads the wrong
  // hand; if the depiction can't be made to read back as the original stereochemistry, refuse the
  // view (document untouched) instead of silently committing a different stereoisomer.
  let committedBonds = nextBonds;
  if (options.perceiveStereo) {
    const perceive = options.perceiveStereo;
    const referenceStereo = perceive(moleculeToMolfileV2000(molecule, { fromDocFrame: true }));
    const reference = new Map<number, "R" | "S">();
    molecule.atoms.forEach((_, index) => {
      const entry = referenceStereo[index];
      if (entry?.isStereoCenter && (entry.descriptor === "R" || entry.descriptor === "S")) {
        reference.set(index, entry.descriptor);
      }
    });
    const depthByAtomId = new Map<string, number>();
    for (const atom of molecule.atoms) {
      const depth = depthOf(atom.id);
      if (depth !== undefined) depthByAtomId.set(atom.id, depth);
    }
    const reconciled = reconcileFlattenedStereo(
      molecule,
      nextAtoms,
      nextBonds,
      reference,
      perceive,
      { depthByAtomId }
    );
    if (!reconciled.ok) {
      return {
        document,
        status: "refused",
        warnings: result.warnings,
        refusalReasons: [
          reconciled.reason === "legibility"
            ? "flatten preserves stereochemistry but would draw two identical wedge/hash marks at one atom; re-orient and try again"
            : `flatten would change stereochemistry at ${reconciled.unresolved.length} center(s); re-orient and try again`
        ],
        stereoCenters: result.stereoCenters
      };
    }
    committedBonds = reconciled.bonds;
  }

  const stagedMolecule: MoleculeObject = {
    ...molecule,
    atoms: nextAtoms,
    bonds: committedBonds,
    ...geometry
  };
  const structure = moleculeToMolfileV2000(stagedMolecule, { fromDocFrame: true });

  const patches: DocumentPatch[] = [
    {
      op: "updateObject",
      objectId,
      changes: {
        atoms: nextAtoms,
        bonds: committedBonds,
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        structure,
        structureFormat: "molfile-v2000"
      }
    }
  ];
  // Replace this molecule's stale crossing overrides with the freshly baked ones.
  for (const crossing of page?.crossings ?? []) {
    if (crossing.bonds.every((ref) => ref.objectId === objectId)) {
      patches.push({ op: "clearCrossingOverride", pageId, bonds: crossing.bonds });
    }
  }
  for (const crossing of result.crossings) {
    patches.push({ op: "setCrossingOverride", pageId, crossing });
  }

  return {
    document: applyPatches(document, patches, { now: phase4Timestamp }),
    status: "committed",
    warnings: result.warnings,
    refusalReasons: [],
    stereoCenters: result.stereoCenters
  };
}

export function nativeMoleculeTransformState(molecule: MoleculeObject): MoleculeTransformState {
  const tiltXDegrees = normalizeProjectedPlaneTiltDegrees(molecule.transform?.tiltXDegrees);
  const tiltYDegrees = normalizeProjectedPlaneTiltDegrees(molecule.transform?.tiltYDegrees);
  return {
    scaleX: normalizeNativeMoleculeScale(molecule.transform?.scaleX ?? defaultNativeMoleculeTransform.scaleX),
    scaleY: normalizeNativeMoleculeScale(molecule.transform?.scaleY ?? defaultNativeMoleculeTransform.scaleY),
    rotationDegrees: normalizeDegrees(molecule.transform?.rotationDegrees ?? defaultNativeMoleculeTransform.rotationDegrees),
    ...(tiltXDegrees === undefined ? {} : { tiltXDegrees }),
    ...(tiltYDegrees === undefined ? {} : { tiltYDegrees })
  };
}

function withNativeMoleculeTransform(
  molecule: MoleculeObject,
  transform: MoleculeTransformState
): MoleculeObject {
  const tiltXDegrees = normalizeProjectedPlaneTiltDegrees(transform.tiltXDegrees);
  const tiltYDegrees = normalizeProjectedPlaneTiltDegrees(transform.tiltYDegrees);
  return {
    ...molecule,
    transform: {
      scaleX: normalizeNativeMoleculeScale(transform.scaleX),
      scaleY: normalizeNativeMoleculeScale(transform.scaleY),
      rotationDegrees: normalizeDegrees(transform.rotationDegrees),
      ...(tiltXDegrees === undefined ? {} : { tiltXDegrees }),
      ...(tiltYDegrees === undefined ? {} : { tiltYDegrees })
    }
  };
}

// Drops per-atom projected-plane depth so a 2D cleanup leaves a genuinely flat molecule.
// Without this, atoms keep stale `z` from a prior 3D tilt and `pointZ()` would still read
// that depth on the next projected-plane operation even though the transform reset to 2D.
function flattenNativeMoleculeDepth(molecule: MoleculeObject): MoleculeObject {
  return {
    ...molecule,
    atoms: molecule.atoms.map(({ z: _z, ...atom }) => atom)
  };
}

function cleanUpNativeMoleculeGeometry2d(molecule: MoleculeObject): MoleculeObject {
  if (molecule.atoms.length <= 1 || molecule.bonds.length === 0) {
    return withNativeMoleculeTransform(
      normalizeNativeMoleculeGeometry(flattenNativeMoleculeDepth(molecule)),
      defaultNativeMoleculeTransform
    );
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
    const componentBonds = molecule.bonds.filter((bond) => componentAtomSet.has(bond.fromAtomId) && componentAtomSet.has(bond.toAtomId));
    // A component with more than one ring (fused/bridged/spiro, or rings joined by a chain) is
    // beyond this polygon+tree pass: laying it out as a tree and then relaxing bond lengths shears
    // the rings into something WORSE than the drawing. First, do no harm — keep the drawn geometry;
    // 3D Cleanup does a full engine re-layout for these.
    const cyclomaticNumber = componentBonds.length - componentAtoms.length + 1;
    if (cyclomaticNumber >= 2) {
      return;
    }
    const componentCenter = averagePagePoint(componentAtoms);
    const layout = cleanUpNativeMoleculeComponent2d({
      componentAtoms,
      componentAtomSet,
      atomById,
      adjacency,
      bondByAtomPair
    });
    const layoutCenter = averagePagePoint([...layout.values()]);

    layout.forEach((point, atomId) => {
      nextAtomPoints.set(atomId, {
        x: roundGeometryCoordinate(componentCenter.x + point.x - layoutCenter.x),
        y: roundGeometryCoordinate(componentCenter.y + point.y - layoutCenter.y)
      });
    });
  });

  const atoms = molecule.atoms.map((atom) => {
    const point = nextAtomPoints.get(atom.id);
    const { z: _z, ...flatAtom } = atom;
    return point ? { ...flatAtom, ...point } : flatAtom;
  });
  // Cleanup re-idealizes to flat 2D geometry — perspective depth weights from an
  // earlier 3D flatten no longer describe anything and must not linger.
  const bonds = molecule.bonds.map((bond) => {
    if (bond.display?.depthWeight === undefined) return bond;
    const { depthWeight: _cleared, ...display } = bond.display;
    return { ...bond, display: Object.keys(display).length > 0 ? display : undefined };
  });

  return withNativeMoleculeTransform(
    normalizeNativeMoleculeGeometry({
      ...molecule,
      atoms,
      bonds
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

export function nativeMoleculeCenter(molecule: Pick<MoleculeObject, "atoms" | "x" | "y" | "width" | "height">): PagePoint {
  return molecule.atoms.length > 0 ? averagePagePoint(molecule.atoms) : objectCenter(molecule);
}

function nativeMoleculeGeometryOrTransformChanged(before: MoleculeObject, after: MoleculeObject): boolean {
  const beforeTransform = nativeMoleculeTransformState(before);
  const afterTransform = nativeMoleculeTransformState(after);
  if (
    Math.abs(beforeTransform.scaleX - afterTransform.scaleX) > 0.001 ||
    Math.abs(beforeTransform.scaleY - afterTransform.scaleY) > 0.001 ||
    Math.abs(beforeTransform.rotationDegrees - afterTransform.rotationDegrees) > 0.001 ||
    Math.abs((beforeTransform.tiltXDegrees ?? 0) - (afterTransform.tiltXDegrees ?? 0)) > 0.001 ||
    Math.abs((beforeTransform.tiltYDegrees ?? 0) - (afterTransform.tiltYDegrees ?? 0)) > 0.001
  ) {
    return true;
  }

  return before.atoms.some((atom, index) => {
    const nextAtom = after.atoms[index];
    return !nextAtom ||
      Math.abs(atom.x - nextAtom.x) > 0.001 ||
      Math.abs(atom.y - nextAtom.y) > 0.001 ||
      Math.abs(pointZ(atom) - pointZ(nextAtom)) > 0.001;
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
  const normalized = Number(wrapProjectedPlaneTiltValue(finiteDegrees, projectedPlaneTiltMaxDegrees).toFixed(3));
  return Math.abs(normalized) < 0.001 ? undefined : normalized;
}

function normalizeDocumentObjectProjectedPlaneTiltDegrees(degrees: number | undefined): number | undefined {
  const finiteDegrees = Number.isFinite(degrees) ? degrees ?? 0 : 0;
  const normalized = Number(wrapProjectedPlaneTiltValue(finiteDegrees, documentObjectProjectedPlaneTiltMaxDegrees).toFixed(3));
  return Math.abs(normalized) < 0.001 ? undefined : normalized;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
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
  const result = exportDocumentToCdxmlEnvelope(document);
  return {
    filename: `${sanitizeFilename(document.title.replace(/\.chemdraft$/i, ""))}.chemdraft`,
    mimeType: "chemical/x-cdxml",
    contents: result.contents,
    warnings: result.warnings,
    payloadHash: sha256Utf8Hex(result.contents)
  };
}

export function exportPhase4Cdxml(
  document: ChemDraftDocument,
  options: CdxmlTextExportOptions = {}
): TextExportResult {
  return exportDocumentToCdxmlText(document, options);
}

export function openNativeDocument(contents: string): ChemDraftOpenResult {
  return openChemDraftPayload(contents);
}

const importedPageFitPaddingPx = 24;

/** Round a page dimension UP to a tidy value in its unit, so the page always fully contains
 *  the content (rounding down could clip it): 0.01" for inches, 1 mm / 1 px otherwise. */
function roundUpPageSize(value: number, unit: PageSizeUnit): number {
  if (unit === "inch") return Math.ceil(value * 100) / 100;
  return Math.ceil(value);
}

function pageSizeUnitLabel(unit: PageSizeUnit): string {
  return unit === "inch" ? "in" : unit === "mm" ? "mm" : "px";
}

function formatPageSizeValue(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/**
 * Recommend a CUSTOM page sized to exactly contain the content (plus a small margin) when it
 * overflows the current page — including content larger than any standard preset. The custom
 * size is expressed in the current page's unit (US presets ⇒ inches, A-series ⇒ mm) so the
 * suggestion reads naturally and round-trips through the print/SVG path.
 */
export function recommendImportedPageFit(document: ChemDraftDocument): ImportedPageFitRecommendation | undefined {
  const page = document.pages[0];
  if (!page || page.objects.length === 0) {
    return undefined;
  }

  const contentBounds = boundsForPageObjects(page.objects);
  const overflowLeftPx = Math.max(0, -contentBounds.x);
  const overflowTopPx = Math.max(0, -contentBounds.y);
  const overflowRightPx = Math.max(0, contentBounds.x + contentBounds.width - page.width);
  const overflowBottomPx = Math.max(0, contentBounds.y + contentBounds.height - page.height);
  if (overflowLeftPx <= 0 && overflowTopPx <= 0 && overflowRightPx <= 0 && overflowBottomPx <= 0) {
    return undefined;
  }
  const requiredWidthPx = contentBounds.width + importedPageFitPaddingPx * 2;
  const requiredHeightPx = contentBounds.height + importedPageFitPaddingPx * 2;

  // Size a custom page to the content, in the current page's unit (rounded up so nothing clips).
  const unit = pageLayoutSourceUnit(page.layout);
  const widthValue = roundUpPageSize(cssPxToPageSize(requiredWidthPx, unit), unit);
  const heightValue = roundUpPageSize(cssPxToPageSize(requiredHeightPx, unit), unit);
  const currentMargin = pageMarginFromLayout(page.layout);
  const recommendedLayout = createCustomPageLayout(widthValue, heightValue, unit, currentMargin);

  const translateX = importedContentFitDelta(contentBounds.x, contentBounds.width, recommendedLayout.widthPx);
  const translateY = importedContentFitDelta(contentBounds.y, contentBounds.height, recommendedLayout.heightPx);

  return {
    pageId: page.id,
    pageIndex: 0,
    currentPresetId: page.layout.presetId,
    currentOrientation: page.layout.orientation,
    currentPageTitle: PageSizePresets.find((candidate) => candidate.id === page.layout.presetId)?.title ?? page.layout.presetId,
    recommendedPresetId: "custom",
    recommendedOrientation: recommendedLayout.orientation,
    recommendedPageTitle: `Custom ${formatPageSizeValue(widthValue)} × ${formatPageSizeValue(heightValue)} ${pageSizeUnitLabel(unit)}`,
    recommendedLayout,
    contentBounds,
    requiredWidthPx,
    requiredHeightPx,
    translateX,
    translateY,
    overflowLeftPx,
    overflowTopPx,
    overflowRightPx,
    overflowBottomPx
  };
}

export function applyImportedPageFitRecommendation(
  document: ChemDraftDocument,
  recommendation: ImportedPageFitRecommendation
): ChemDraftDocument {
  const withLayout = applyPatch(
    document,
    {
      op: "updatePageLayout",
      pageId: recommendation.pageId,
      layout: recommendation.recommendedLayout
    },
    { now: phase4Timestamp }
  );
  if (Math.abs(recommendation.translateX) < 1e-6 && Math.abs(recommendation.translateY) < 1e-6) {
    return withLayout;
  }

  const page = withLayout.pages.find((candidate) => candidate.id === recommendation.pageId);
  const objectIds = page?.objects.map((object) => object.id) ?? [];
  return moveDocumentObjects(withLayout, objectIds, recommendation.translateX, recommendation.translateY);
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

/** Apply a user-entered custom page size (width/height in `unit`), keeping current margins. */
export function setDocumentCustomPageSize(
  document: ChemDraftDocument,
  size: { width: number; height: number; unit: PageSizeUnit }
): ChemDraftDocument {
  const page = firstPage(document);
  const layout = createCustomPageLayout(size.width, size.height, size.unit, pageMarginFromLayout(page.layout));

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

function boundsForPageObjects(objects: readonly DocumentObject[]): PageObjectBounds {
  const xs = objects.flatMap((object) => [object.x, object.x + object.width]);
  const ys = objects.flatMap((object) => [object.y, object.y + object.height]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  };
}

function importedContentFitDelta(min: number, size: number, extent: number): number {
  const lowerBound = importedPageFitPaddingPx;
  const upperBound = extent - importedPageFitPaddingPx;
  const max = min + size;
  if (min < lowerBound) {
    return lowerBound - min;
  }
  if (max > upperBound) {
    return upperBound - max;
  }
  return 0;
}

/**
 * The objects "Copy As" serializes: the selection when there is one, the whole page otherwise —
 * matching how the plain Copy command scopes itself.
 */
export function copyAsScopeObjects(document: ChemDraftDocument): readonly DocumentObject[] {
  const page = firstPage(document);
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0 || !page.objects.some((object) => selectedIds.has(object.id))) {
    return page.objects;
  }

  // A selected molecule travels with its chemistry annotations: charge/electron marks anchored
  // to it, and electron-push arrows whose BOTH ends resolve inside the scope (a half-dangling
  // arrow would render nothing, so partially-attached arrows stay out).
  const scopeIds = new Set(selectedIds);
  page.objects.forEach((object) => {
    if (
      object.type === "electron-mark" &&
      object.anchor.kind === "atom" &&
      object.anchor.objectId !== undefined &&
      scopeIds.has(object.anchor.objectId)
    ) {
      scopeIds.add(object.id);
    }
  });
  page.objects.forEach((object) => {
    if (object.type !== "mechanism-arrow") {
      return;
    }
    const endpointInScope = (anchor: MechanismArrowObject["source"]) =>
      anchor.kind === "point" || (anchor.objectId !== undefined && scopeIds.has(anchor.objectId));
    if (endpointInScope(object.source) && endpointInScope(object.target)) {
      scopeIds.add(object.id);
    }
  });

  return page.objects.filter((object) => scopeIds.has(object.id));
}

export function copyAsScopeMolecules(document: ChemDraftDocument): readonly MoleculeObject[] {
  const isScopeMolecule = (object: DocumentObject): object is MoleculeObject =>
    object.type === "molecule" && isEditableNativeMoleculeGraph(object);
  const scoped = copyAsScopeObjects(document).filter(isScopeMolecule);
  if (scoped.length > 0) {
    return scoped;
  }
  // A selected charge mark or annotation has no chemistry of its own — chemistry formats fall
  // back to every molecule on the page rather than reporting nothing to copy.
  return firstPage(document).objects.filter(isScopeMolecule);
}

/**
 * One CTAB for the whole scope: disjoint molecules merge into a single molfile fragment set,
 * with atom/bond ids namespaced so cross-molecule collisions cannot corrupt the bond table.
 */
export function copyAsMergedMolecule(
  molecules: readonly MoleculeObject[]
): MoleculeObject | undefined {
  if (molecules.length === 0) {
    return undefined;
  }
  if (molecules.length === 1) {
    return molecules[0];
  }

  const atoms: MoleculeAtom[] = [];
  const bonds: MoleculeBond[] = [];
  molecules.forEach((molecule, index) => {
    const prefix = `m${index}_`;
    atoms.push(...molecule.atoms.map((atom) => ({ ...atom, id: `${prefix}${atom.id}` })));
    bonds.push(...molecule.bonds.map((bond) => ({
      ...bond,
      id: `${prefix}${bond.id}`,
      fromAtomId: `${prefix}${bond.fromAtomId}`,
      toAtomId: `${prefix}${bond.toAtomId}`
    })));
  });
  return { ...molecules[0], atoms, bonds };
}

export function copyAsSmiles(document: ChemDraftDocument): string | undefined {
  const parts = copyAsScopeMolecules(document)
    .map((molecule) =>
      molecule.structureFormat === "smiles" && molecule.structure
        ? molecule.structure
        : nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds)
    )
    .filter((smiles) => smiles.length > 0);
  return parts.length > 0 ? parts.join(".") : undefined;
}

export function copyAsMolfile(
  document: ChemDraftDocument,
  flavor: "v2000" | "v3000"
): string | undefined {
  const merged = copyAsMergedMolecule(copyAsScopeMolecules(document));
  if (!merged) {
    return undefined;
  }
  return flavor === "v2000"
    ? moleculeToMolfileV2000(merged, { fromDocFrame: true })
    : moleculeToMolfileV3000(merged, { fromDocFrame: true });
}

const copyAsPagePaddingPx = 16;

/**
 * A temporary document holding only the copy scope, translated onto a page fitted to its bounds —
 * so a copied SVG/PNG/CDXML frames the selection instead of reproducing a mostly-empty page.
 */
export function copyAsScopedDocument(document: ChemDraftDocument): ChemDraftDocument {
  const page = firstPage(document);
  const objects = copyAsScopeObjects(document);
  if (objects.length === 0) {
    return document;
  }

  const minX = Math.min(...objects.map((object) => object.x));
  const minY = Math.min(...objects.map((object) => object.y));
  const maxX = Math.max(...objects.map((object) => object.x + object.width));
  const maxY = Math.max(...objects.map((object) => object.y + object.height));

  const scopedWidth = maxX - minX + copyAsPagePaddingPx * 2;
  const scopedHeight = maxY - minY + copyAsPagePaddingPx * 2;
  let scoped: ChemDraftDocument = {
    ...document,
    pages: [{
      ...page,
      width: scopedWidth,
      height: scopedHeight,
      // The schema pins layout px to the page dimensions, so the fitted page carries a
      // matching custom layout (margins zeroed — a clipboard image has no print margins).
      layout: createCustomPageLayout(scopedWidth, scopedHeight, "css-px", { top: 0, right: 0, bottom: 0, left: 0 }),
      objects: [...objects]
    }],
    selection: { ...document.selection, objectIds: [] }
  };
  const dx = copyAsPagePaddingPx - minX;
  const dy = copyAsPagePaddingPx - minY;
  for (const object of objects) {
    scoped = moveDocumentObject(scoped, object.id, { x: object.x + dx, y: object.y + dy }, { clampToPage: false });
  }
  return scoped;
}

export function exportPhase4Svg(
  document: ChemDraftDocument,
  options: Pick<SvgExportOptions, "includeWarnings" | "includePageGuides" | "pageIndex" | "background"> = {}
): SvgExportResult {
  return exportDocumentToSvg(document, {
    ...options,
    includeWarnings: options.includeWarnings ?? true
  });
}

export async function exportPhase4Pdf(
  document: ChemDraftDocument,
  options: Pick<PdfExportOptions, "compress" | "includePageGuides" | "pageIndex"> = {}
): Promise<BinaryExportResult> {
  const { exportDocumentToPdf } = await import("@chemdraft/export-engine/pdf");
  return exportDocumentToPdf(document, options);
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

function findDocumentObject(document: ChemDraftDocument, objectId: string): DocumentObject | undefined {
  for (const page of document.pages) {
    const object = page.objects.find((candidate) => candidate.id === objectId);
    if (object) {
      return object;
    }
  }

  return undefined;
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

function nextObjectId(document: ChemDraftDocument, prefix: string, reserved?: ReadonlySet<string>): string {
  const existingIds = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  let index = existingIds.size + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;

  // `reserved` covers ids issued but not yet applied — see SmilesMoleculeSource.reservedObjectIds.
  while (existingIds.has(id) || reserved?.has(id)) {
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

// The page that owns the current selection. Operations on the selection (delete, align, distribute,
// etc.) must resolve objects from this page, not always the first page, or they silently no-op when
// the selection lives on a later page of a multi-page document.
function selectionPage(document: ChemDraftDocument): ChemDraftDocument["pages"][number] {
  return document.pages.find((candidate) => candidate.id === document.selection.pageId) ?? firstPage(document);
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
  page: ChemDraftDocument["pages"][number],
  targetBondLengthPx: number = nativeBondLengthPx
): ParsedMolfileGraph["atoms"] {
  const averageBondLength = averageParsedMolfileBondLength(graph);
  const scale = averageBondLength > 0 ? targetBondLengthPx / averageBondLength : targetBondLengthPx / 1.5;
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

/**
 * Append a run of carbons in one pass.
 *
 * Calling {@link extendNativeCarbonGraph} per vertex would re-derive the molecule's SMILES and
 * chemistry metadata for every atom, making a drag quadratic in chain length. The graph is grown in
 * plain arrays and refreshed once at the end instead.
 */
function appendNativeCarbonVertices(
  molecule: MoleculeObject,
  sourceAtomId: string,
  vertices: readonly PagePoint[],
  preview = false
): MoleculeObject | undefined {
  // Allocated up front. `nextIndexedId` rescans every existing id, so calling it per vertex is
  // quadratic in the molecule being extended — the same cost the batched refresh below avoids.
  const atomIds = nextIndexedIds("atom", molecule.atoms.map((atom) => atom.id), vertices.length);
  const bondIds = nextIndexedIds("bond", molecule.bonds.map((bond) => bond.id), vertices.length);
  const atoms = [...molecule.atoms];
  const bonds = [...molecule.bonds];
  let attachAtomId = sourceAtomId;
  let added = 0;

  for (const vertex of vertices) {
    // Valence is checked against the graph as grown so far, not the original molecule.
    if (!canGrowNativeAtom({ ...molecule, atoms, bonds }, attachAtomId)) {
      break;
    }
    const newAtom: MoleculeAtom = {
      id: atomIds[added],
      element: "C",
      x: vertex.x,
      y: vertex.y,
      formalCharge: 0
    };
    atoms.push(newAtom);
    bonds.push({
      id: bondIds[added],
      fromAtomId: attachAtomId,
      toAtomId: newAtom.id,
      order: "single" as const,
      ...nativeBondDisplayObject(undefined)
    });
    attachAtomId = newAtom.id;
    added += 1;
  }

  if (added === 0) {
    return undefined;
  }
  return preview
    ? normalizeNativeMoleculeGeometry({ ...molecule, atoms, bonds })
    : refreshNativeSingleBondGraph(molecule, atoms, bonds);
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

// Per-molecule cache of the ring-interior side map (molecule objects are immutable, so a new
// object is produced on every edit). Avoids recomputing ring perception for each bond when
// defaultDoubleBondSide is called inside a bond .map.
const ringInteriorSideCache = new WeakMap<MoleculeObject, Map<string, NativeDoubleBondSide>>();

function ringInteriorSideForBond(molecule: MoleculeObject, bondId: string): NativeDoubleBondSide | undefined {
  let sides = ringInteriorSideCache.get(molecule);
  if (!sides) {
    sides = ringInteriorDoubleBondSides(molecule);
    ringInteriorSideCache.set(molecule, sides);
  }
  return sides.get(bondId);
}

function defaultDoubleBondSide(molecule: MoleculeObject, bond: MoleculeBond): NativeDoubleBondSide {
  // A ring double bond's inner line belongs inside the ring — the authoritative default,
  // matching what layout-engine renders. Only fall back to the substituent heuristic for
  // non-ring (chain) double bonds.
  const ringSide = ringInteriorSideForBond(molecule, bond.id);
  if (ringSide) {
    return ringSide;
  }

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

function nativeMoleculeAfterPartDelete(
  molecule: MoleculeObject,
  target: NativeMoleculePartReorderTarget
): MoleculeObject | undefined {
  if (target.kind === "atom") {
    return deleteNativeCarbonAtom(molecule, target.atomId);
  }

  if (target.kind === "bond") {
    return deleteNativeCarbonBond(molecule, target.bondId, undefined);
  }

  const atomIdsToRemove = new Set(target.atomIds);
  const bondIdsToRemove = new Set(target.bondIds);
  const atoms = molecule.atoms.filter((atom) => !atomIdsToRemove.has(atom.id));
  const bonds = molecule.bonds.filter((bond) =>
    !bondIdsToRemove.has(bond.id) &&
    !atomIdsToRemove.has(bond.fromAtomId) &&
    !atomIdsToRemove.has(bond.toAtomId)
  );

  if (atoms.length === molecule.atoms.length && bonds.length === molecule.bonds.length) {
    return undefined;
  }

  return refreshNativeSingleBondGraph(molecule, atoms, bonds);
}

function refreshNativeSingleBondGraph(
  molecule: MoleculeObject,
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeObject {
  return normalizeNativeMoleculeGeometry({
    ...molecule,
    // `structure` is re-derived as SMILES here, so the format must say so. Leaving an imported
    // molfile format in place would hand SMILES text to a molfile parser — the plugin selection
    // snapshot and the Ketcher adapter both choose their parser from this field.
    structureFormat: "smiles",
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
  const radicalCount = atoms.reduce((sum, atom) => sum + (atom.markRadicals ?? 0), 0);
  const warnings = nativeInvalidAtomWarnings(atoms, bonds);

  atoms.forEach((atom) => {
    const element = nativeElementFromAtomLabel(atom.element);
    if (!element) {
      return;
    }
    elementCounts.set(element, (elementCounts.get(element) ?? 0) + 1);

    if (element !== "H") {
      const implicitHydrogens = nativeImplicitHydrogenCount(
        element,
        valenceUsage.get(atom.id) ?? 0,
        atom.formalCharge,
        atom.markRadicals ?? 0
      );
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
    radicalCount,
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

export function nativeSingleBondGraphSmiles(atoms: readonly MoleculeAtom[], bonds: readonly MoleculeBond[]): string {
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
    // Any graph the single-cycle renderer can't linearize — fused/bridged/spiro polycyclics
    // (naphthalene, decalin, steroids, …) or multiple components where at least one has a
    // ring — goes through the general DFS spanning-tree writer. The former fallback here
    // concatenated bare atom symbols, which SMILES reads as a bonded chain, silently turning
    // every multi-ring molecule into an acyclic one (10-carbon naphthalene → "CCCCCCCCCC").
    return nativeGeneralGraphSmiles(components, adjacency, atomById, bondByAtomPair);
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

/**
 * General SMILES writer for arbitrary connected graphs. It builds a depth-first spanning tree
 * and turns each non-tree ("back") edge into a ring-closure digit, so it linearizes any ring
 * system — fused, bridged, or spiro — that the single-cycle renderer above cannot. Bond orders
 * come from `bondOrderSymbol` and atom labels/charges from `nativeAtomSmiles`; it is a pure
 * graph→string function with no OpenChemLib dependency, keeping OCL worker-only.
 */
function nativeGeneralGraphSmiles(
  components: readonly (readonly string[])[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  atomById: ReadonlyMap<string, MoleculeAtom>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  return components
    .map((componentIds) => renderConnectedGraphSmiles(componentIds, adjacency, atomById, bondByAtomPair))
    .join(".");
}

function renderConnectedGraphSmiles(
  componentIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  atomById: ReadonlyMap<string, MoleculeAtom>,
  bondByAtomPair: ReadonlyMap<string, MoleculeBond>
): string {
  if (componentIds.length <= 1) {
    return nativeAtomSmiles(atomById.get(componentIds[0]));
  }

  const rootAtomId = [...componentIds].sort()[0];

  // Phase 1 — carve a spanning tree out of the component. Every undirected edge (keyed by
  // atomPairKey) is classified exactly once: an edge into an unvisited atom is a tree edge,
  // an edge into an already-visited atom is a back edge and becomes a ring closure.
  const visited = new Set<string>();
  const classifiedEdges = new Set<string>();
  const ringClosureEdgeKeys = new Set<string>();
  const treeChildren = new Map<string, string[]>();

  const buildSpanningTree = (atomId: string): void => {
    visited.add(atomId);
    const children: string[] = [];
    (adjacency.get(atomId) ?? []).forEach((neighborId) => {
      const edgeKey = atomPairKey(atomId, neighborId);
      if (classifiedEdges.has(edgeKey)) {
        return;
      }
      classifiedEdges.add(edgeKey);
      if (visited.has(neighborId)) {
        ringClosureEdgeKeys.add(edgeKey);
      } else {
        children.push(neighborId);
        buildSpanningTree(neighborId);
      }
    });
    treeChildren.set(atomId, children);
  };
  buildSpanningTree(rootAtomId);

  // Phase 2 — emit in the same pre-order the tree was built. A ring-closure digit is allocated
  // the first time an atom touches a closure edge (the opening end, always emitted before its
  // partner) and released when the partner closes it, so digits stay small and get reused.
  const openRingDigits = new Map<string, number>();
  const freedRingDigits: number[] = [];
  let nextRingDigit = 1;

  const acquireRingDigit = (): number => {
    if (freedRingDigits.length > 0) {
      freedRingDigits.sort((left, right) => left - right);
      return freedRingDigits.shift() as number;
    }
    const digit = nextRingDigit;
    nextRingDigit += 1;
    return digit;
  };

  const emitAtom = (atomId: string): string => {
    const ringClosures = (adjacency.get(atomId) ?? [])
      .map((neighborId) => atomPairKey(atomId, neighborId))
      .filter((edgeKey) => ringClosureEdgeKeys.has(edgeKey))
      .map((edgeKey) => {
        const openDigit = openRingDigits.get(edgeKey);
        if (openDigit !== undefined) {
          openRingDigits.delete(edgeKey);
          freedRingDigits.push(openDigit);
          return ringClosureDigitToken(openDigit);
        }
        const digit = acquireRingDigit();
        openRingDigits.set(edgeKey, digit);
        // The ring bond order is written once, at the opening end (SMILES allows it at either).
        return `${bondOrderSymbol(bondByAtomPair.get(edgeKey)?.order)}${ringClosureDigitToken(digit)}`;
      })
      .join("");

    const renderedChildren = (treeChildren.get(atomId) ?? []).map((childId) =>
      `${bondOrderSymbol(bondByAtomPair.get(atomPairKey(atomId, childId))?.order)}${emitAtom(childId)}`
    );
    const branches = renderedChildren.slice(0, -1).map((child) => `(${child})`).join("");
    const continuation = renderedChildren.length > 0 ? renderedChildren[renderedChildren.length - 1] : "";

    return `${nativeAtomSmiles(atomById.get(atomId))}${ringClosures}${branches}${continuation}`;
  };

  return emitAtom(rootAtomId);
}

function ringClosureDigitToken(digit: number): string {
  return digit < 10 ? String(digit) : `%${String(digit).padStart(2, "0")}`;
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

/**
 * Implicit hydrogens for the molecular formula, from the SAME derivation the drawn label uses.
 *
 * This counted against the neutral valence table and ignored `formalCharge`, so once
 * `atomDisplayLabel` became charge-aware the two disagreed: methoxide drew as "O-" with no hydrogen
 * while the formula still reported CH4O. A formula that contradicts the depiction beside it is
 * worse than either being wrong alone, and AGENTS.md 5.26 puts atom-label content in layout-engine.
 */
function nativeImplicitHydrogenCount(
  element: NativeElementSymbol,
  valenceUsed: number,
  formalCharge: number,
  radicals = 0
): number {
  return Math.max(0, nativeAtomValenceForCharge(element, formalCharge) - valenceUsed - radicals);
}

/**
 * Whether an atom of this element can legally carry `formalCharge` at `valenceUsed` drawn bonds.
 *
 * The octet-derived bond capacity (`nativeAtomValenceForCharge`, the same derivation the drawn
 * label and formula use) fills any shortfall with implicit hydrogens, so any usage at or below
 * that capacity is fine: O⁻ with one bond is a drawn alkoxide/carboxylate, not an error — the
 * old single-expected-charge rule flagged exactly that. The canonical-charge arm keeps the
 * hypervalent neutrals (P(V), S(IV), S(VI)) that the octet count cannot express.
 */
function nativeAtomChargeSupportsValence(
  element: NativeElementSymbol,
  valenceUsed: number,
  formalCharge: number
): boolean {
  const maxValence = nativeAtomMaxValence[element];
  if (maxValence !== undefined && valenceUsed > maxValence) {
    return false;
  }

  return valenceUsed <= nativeAtomValenceForCharge(element, formalCharge) ||
    nativeAtomFormalChargeForValence(element, valenceUsed) === formalCharge;
}

/** The smallest-magnitude charge that would make `valenceUsed` legal — the fix a charge tool offers. */
function nativeAtomSuggestedChargeForValence(
  element: NativeElementSymbol,
  valenceUsed: number
): number | undefined {
  const candidate = [0, -1, 1, -2, 2].find((charge) =>
    nativeAtomChargeSupportsValence(element, valenceUsed, charge)
  );
  return candidate ?? nativeAtomFormalChargeForValence(element, valenceUsed);
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
