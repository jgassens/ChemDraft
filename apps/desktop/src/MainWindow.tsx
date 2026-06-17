import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  graphicObjectIntersectsRect,
  maxGraphicCornerRadius,
  projectGraphicObjectPoint,
  unprojectGraphicObjectPoint,
  type NativeArtPoint
} from "@chemdraft/art-engine";
import {
  DefaultNativeTextStyle,
  applyPatches,
  createDocumentHistory,
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  redo as redoDocumentHistory,
  undo as undoDocumentHistory,
  type BondRef,
  type ArrowObject,
  type BracketObject,
  type ChemDraftDocument,
  type DocumentHistory,
  type DocumentObject,
  type DocumentPatch,
  type GraphicObject,
  type MoleculeObject,
  type NativeDrawingStyle,
  type NativeTextStyle,
  type ObjectReorderPlacement,
  type TextObject,
  type TextSpan
} from "@chemdraft/chem-core";
import { sha256Utf8Hex } from "@chemdraft/cdx-compat";
import { parseToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import {
  buildCrosshairTicks,
  centimeterRulerUnit,
  createRulerRenderState,
  createViewportState,
  inchRulerUnit,
  setViewportScale,
  viewportCssVars,
  wheelDeltaToZoomFactor,
  zoomViewportAtPoint,
  type RulerUnitState,
  type ViewportState
} from "@chemdraft/viewport-engine";
import ScenaRuler from "@scena/react-ruler";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { shouldIgnoreShortcutTarget } from "@chemdraft/shortcut-engine";
import {
  bondRefKey,
  planPageSvgRender,
  planNativeArtVisual,
  type PageSvgAttributeValue,
  type PageSvgElementFragment,
  type PageSvgFragment,
  type PageSvgRenderPlan,
  type NativeArtPaintPlan,
  type NativeArtVisualPlan,
  type ResolvedBondCrossing
} from "@chemdraft/layout-engine";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  exportFormatDescriptors,
  getExportFormatDescriptor,
  type ExportFormatDescriptor,
  type ExportFormatGroup,
  type ExportFormatId,
  type ExportResult
} from "@chemdraft/export-engine";
import {
  atomElementActions,
  atomElementCommandId,
  createLayerActions,
  createQuickActions,
  editActions,
  objectColorForCommand,
  objectFillOpacityCommandId,
  objectOpacityCommandId,
  objectOpacityForCommand,
  objectStyleActions,
  objectStrokeDashCommands,
  objectStrokeLineCapCommands,
  objectStrokeLineJoinCommands,
  objectStrokeOpacityCommandId,
  objectStrokeWidthCommands,
  objectStyleNoneCommands,
  objectStyleSwapCommand,
  objectStyleTargetCommands,
  pageOrientationActions,
  pageSizeActions,
  structureCleanup3dCommandId,
  structureCleanupCommandId,
  textScriptForCommand,
  textStylePatchForCommand,
  textToolbarActions,
  toolbarCustomizationActions,
  viewActions,
  type CommandSpec
} from "./commands";
import {
  activateDrawingToolCommand,
  createActiveToolState,
  isDrawingToolCommand,
  withStandaloneDrawingToolCommands,
  type ActiveToolState
} from "./drawingTools";
import { clipboardPayloadFromDataTransfer, readClipboardPayload } from "./clipboard";
import {
  applyClipboardPastePayload,
  applyImportedPageFitRecommendation,
  applyNativeCarbonylAtAtomTarget,
  applyNativeAtomElementTarget,
  applyChargeToolAtPoint,
  applyChargeToolAtNativeAtom,
  applyDocumentObjectProjectedPlaneTilt,
  applyNativeBondDisplayStyleTarget,
  applyNativeDoubleBondSideTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget,
  applyNativeMoleculeDeleteTarget,
  applyNativeMoleculePartDeleteTarget,
  applyEditorSaveResultToSelectedMolecule,
  applyAnalysisToSelectedMolecule,
  applyFreeformSingleBondToolAtPoint,
  applyNativeTemplateToolAtTarget,
  applyNativeTemplateToolAtPoint,
  planNativeTemplatePlacement,
  type NativeTemplatePlacementPlan,
  applySingleBondToolAtPoint,
  applySingleBondToolAtNativeAtom,
  applyToolbarColorToSelection,
  applyGraphicObjectColorToSelection,
  applyGraphicObjectNoneToSelection,
  applyGraphicObjectOpacityToSelection,
  applyGraphicObjectStrokeStyleToSelection,
  createNativeSavePayload,
  createPhase4Document,
  cleanUpNativeMolecules2d,
  deleteSelectedDocumentObjects,
  exportPhase4Cdxml,
  exportPhase4Pdf,
  exportPhase4Svg,
  getSelectedMolecule,
  getSelectedTextObject,
  insertNativeTextObject,
  insertNativeArtGraphicObject,
  nativeAtomDisplayLabel,
  documentObjectProjectedPlaneTilt,
  nativeChargeAssociationsForMolecule,
  nativeChargeByAtomIdFromAssociations,
  nativeBondStyleForToolCommand,
  nativeElementFromKeyboardKey,
  nativeMoleculeInvalidAtomStates,
  nativeMoleculePartBounds,
  nativeGraphicCornerRadiusEditPoint,
  nativeGraphicPathEditPoints,
  nativeMoleculeCenter,
  nativeMoleculeTransformState,
  nativeArtToolForCommand,
  nativeTemplateForToolCommand,
  projectedPlaneTiltMaxRadians,
  wrapProjectedPlaneTiltVectorRadians,
  moveDocumentObject,
  moveDocumentObjects,
  selectionBounds,
  type SelectionBounds,
  rotateDocumentObjectsAroundPoint,
  scaleDocumentObjectsAroundPoint,
  moveNativeMoleculeParts,
  openNativeDocument,
  previewNativeMoleculeBondGrowth,
  previewNativeMoleculeFreeformBondGrowth,
  prepareGraphicPathForDirectEdit,
  recommendImportedPageFit,
  reorderSelectedDocumentObject,
  resizeNativeMoleculeParts,
  resizeNativeMoleculeObject,
  resizeNativeTextObjectBox,
  resolveToolbarColorSelection,
  selectedGraphicObjectIds,
  rotateNativeMoleculeParts,
  rotateDocumentObject,
  rotateNativeMoleculeObjectAroundPoint,
  tiltNativeMoleculeProjectedPlane,
  tiltNativeMoleculeObjectsProjectedPlane,
  tiltNativeMoleculePartsProjectedPlane,
  selectAllDocumentObjects,
  selectDocumentObject,
  selectDocumentObjects,
  setDocumentPageOrientation,
  setDocumentPageSize,
  updateNativeTextObjectScript,
  updateNativeTextObjectScriptRange,
  updateNativeTextObjectStyle,
  updateNativeTextObjectStyleRange,
  updateNativeTextObjectText,
  updateNativeGraphicCornerRadius,
  updateNativeGraphicMarkerHandle,
  updateNativeGraphicPathHandle,
  swapGraphicObjectFillAndStroke,
  type GraphicStylePaintTarget,
  type NativeGraphicMarkerHandleId,
  type NativeGraphicPathEditHandle,
  type NativeGraphicPathEditPoints,
  type NativeTextSelectionRange,
  type ToolbarColorSelection,
  type NativeBondDisplayStyle,
  type NativeMoleculeTemplateId,
  type NativeMoleculeDeleteHit,
  type NativeDoubleBondSide,
  type NativeMoleculeDeleteTarget,
  type NativeBondOrderTarget,
  type NativeBondOrderValue,
  type NativeChargeValue,
  type NativeSingleLetterElement,
  type ImportedPageFitRecommendation
} from "./documentWorkflow";
import { KetcherEditorHost } from "./KetcherEditorHost";
import { initialInteractionState, interactionReducer, type InteractionState } from "./interaction/machine";
import { ToolPalette } from "./ToolPalette";
import {
  DEFAULT_TOOLSET_ID,
  broadcastToolsetActiveTool,
  broadcastToolsetTextStyle,
  createToolsetTextStylePayload,
  focusCurrentWindowAndWebview,
  isDesktopRuntime,
  listToolsetWindowStates,
  listenForToolsetActiveToolRequests,
  listenForToolsetTextStyleRequests,
  loadToolsetLayoutState,
  listenForToolsetCommands,
  listenForToolsetWindowStates,
  toggleToolsetWindow,
  type ToolsetArtPaintTarget,
} from "./window-manager";
import {
  createDefaultVisibleToolsetIds,
  createDesktopToolsetRegistry,
  defaultVisibleToolsetIds,
  desktopToolsetRegistry,
  getToolsetCommandGroups,
  getToolsetCommandSpecs,
  getToolsetToggleActions,
  isDisabledPlaceholderCommand,
  type DesktopToolsetRegistry
} from "./toolsets";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import { rasterizeSvgNative, type NativeRasterExportFormat } from "./nativeRasterExport";
import { clientToPage, pageToClient } from "./interaction/camera";
import {
  BOND_HIT_CATCHER_STROKE_PX,
  currentTemplateTargetFromHoverOrHit,
  hitToleranceForScale,
  nativeMoleculeCanvasHoverTarget,
  nativeMoleculeHitFromPointerTarget,
  nativeMoleculeTemplateHoverTarget,
  type TemplateHoverSample
} from "./interaction/hitTest";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";

// Re-exported so existing tests can keep importing it from "./MainWindow" while the
// implementation lives in the pure, separately-tested interaction layer.
export { nativeMoleculeCanvasHoverTarget };

type PaletteMode = "floating" | "hidden";
type PalettePosition = { x: number; y: number };
type ClientPoint = { x: number; y: number };
type ObjectPointerEvent = PointerEvent<Element>;
type ObjectMouseEvent = ReactMouseEvent<Element>;
type PaletteDragState = {
  toolsetId: string;
  pointerId: number;
  originX: number;
  originY: number;
  startX: number;
  startY: number;
};
type WebKitGestureEvent = Event & {
  clientX?: number;
  clientY?: number;
  scale?: number;
};
type RulerFrame = {
  horizontalScrollPx: number;
  verticalScrollPx: number;
  width: number;
  height: number;
};
type HoveredNativeAtom = {
  objectId: string;
  atomId: string;
  direction: ClientPoint;
  candidateDirections: ClientPoint[];
  newAtomPoint: ClientPoint;
};
type FreeformNativeBondPreview = {
  objectId: string;
  atomId: string;
  targetAtomId?: string;
  newAtomPoint: ClientPoint;
  customLength: boolean;
  lengthAngstrom: number;
};
type NativeBondDragState = {
  pointerId: number;
  objectId: string;
  atomId: string;
  bondStyle?: NativeBondDisplayStyle;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
  freeformUnlocked: boolean;
};
type NativePlacementDragState = {
  pointerId: number;
  kind: "single-bond" | "template";
  startDocument: ChemDraftDocument;
  placementDocument: ChemDraftDocument;
  objectId: string;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  bondStyle?: NativeBondDisplayStyle;
  templateId?: NativeMoleculeTemplateId;
  dragging: boolean;
};
type NativeBondEditDragState = {
  pointerId: number;
  objectId: string;
  target: NativeBondOrderTarget;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type NativeDoubleBondSidePreview = {
  objectId: string;
  bondId: string;
  side: NativeDoubleBondSide;
};
type ObjectDragState = {
  pointerId: number;
  objectId: string;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  startObjectX: number;
  startObjectY: number;
  bondTarget?: NativeBondOrderTarget;
  // When the grabbed object is part of a multi-object selection, the whole set moves
  // together by the pointer delta (group move). Undefined ⇒ single-object move.
  groupObjectIds?: readonly string[];
  dragging: boolean;
};
type GraphicPathEditDragState = {
  pointerId: number;
  objectId: string;
  handle: NativeGraphicPathEditHandle;
  startDocument: ChemDraftDocument;
  workingDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type GraphicMarkerDragState = {
  pointerId: number;
  objectId: string;
  markerId: NativeGraphicMarkerHandleId;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type GraphicCornerRadiusDragState = {
  pointerId: number;
  objectId: string;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type GraphicCornerRadiusReadoutState = {
  objectId: string;
  radius: number;
};
type ObjectRotateDragState = {
  pointerId: number;
  objectId: string;
  target?: NativeMoleculeSelectionPart;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  startPoint: ClientPoint;
  startRotationDegrees: number;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type ObjectRotateReadoutState = {
  objectId: string;
  degrees: number;
};
type ProjectedPlaneTiltDragState = {
  pointerId: number;
  objectId: string;
  target?: NativeMoleculeSelectionPart;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  axisAngleRad: number;
  startPoint: ClientPoint;
  startTiltXRad: number;
  startTiltYRad: number;
  startRotationDegrees: number;
  latestPoint: ClientPoint;
  latestTiltXRad: number;
  latestTiltYRad: number;
  clamped: boolean;
  dragging: boolean;
};
type ProjectedPlaneTiltReadoutState = {
  objectId: string;
  label: string;
  limited: boolean;
};
type RotationInputBase = {
  objectId: string;
  target?: NativeMoleculeSelectionPart;
  targetLabel: string;
  startDocument: ChemDraftDocument;
};

type RotationInputState =
  | (RotationInputBase & {
      kind: "z";
      draftZDegrees: string;
      homeZDegrees: string;
    })
  | (RotationInputBase & {
      kind: "xy";
      draftXDegrees: string;
      draftYDegrees: string;
      homeXDegrees: string;
      homeYDegrees: string;
    });

type RotationInputDraftDocumentResult =
  | {
      kind: "z";
      document: ChemDraftDocument;
      zDegrees: number;
    }
  | {
      kind: "xy";
      document: ChemDraftDocument;
      tiltXRad: number;
      tiltYRad: number;
      clamped: boolean;
    };
type ObjectResizeInputState = {
  objectId: string;
  target?: NativeMoleculeSelectionPart;
  targetLabel: string;
  corner: ObjectResizeCorner;
  startDocument: ChemDraftDocument;
  draftXPercent: string;
  draftYPercent: string;
  homeXPercent: string;
  homeYPercent: string;
};
type ObjectResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type ObjectResizeDragState = {
  pointerId: number;
  objectId: string;
  target?: NativeMoleculeSelectionPart;
  corner: ObjectResizeCorner;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  startPoint: ClientPoint;
  startCumulativeScale: ObjectResizeScale;
  latestPoint: ClientPoint;
  latestScale: ObjectResizeScale;
  latestCumulativeScale: ObjectResizeScale;
  stretching: boolean;
  dragging: boolean;
};
type ObjectResizeReadoutState = {
  objectId: string;
  scaleXPercent: number;
  scaleYPercent: number;
};
type ArtTransformQaDraft = {
  rotationDegrees: string;
  tiltXDegrees: string;
  tiltYDegrees: string;
};
type ObjectResizeScale = {
  x: number;
  y: number;
};
// One drag that rotates or scales a whole multi-object selection about its shared center.
type GroupTransformDragState = {
  pointerId: number;
  mode: "rotate" | "resize" | "projected-plane-tilt";
  objectIds: readonly string[];
  startDocument: ChemDraftDocument;
  center: ClientPoint;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  latestTiltXRad?: number;
  latestTiltYRad?: number;
  clamped?: boolean;
  dragging: boolean;
};
type MoleculeTransformFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type TextResizeEdge = "left" | "right" | "top" | "bottom";
type TextResizeState = {
  pointerId: number;
  objectId: string;
  edge: TextResizeEdge;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  startObjectX: number;
  startObjectY: number;
  startObjectWidth: number;
  startObjectHeight: number;
};
type NativeFileState = {
  path?: string;
  dirty: boolean;
  lastSavedPayloadHash?: string;
};
type ResolvedOpenDocument = {
  document: ChemDraftDocument;
  source: ReturnType<typeof openNativeDocument>["source"];
  statusSourceLabel?: string;
};
export type NativeMoleculeSelectionPart =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "parts"; atomIds: readonly string[]; bondIds: readonly string[] };
type ToolbarStyleTargetSnapshot = ToolbarColorSelection;
type NativePartDragState = {
  pointerId: number;
  objectId: string;
  target: NativeMoleculeSelectionPart;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
export type NativeMoleculeSelectionDragIntent =
  | { kind: "whole-object" }
  | { kind: "native-part"; target: NativeMoleculeSelectionPart }
  | { kind: "none" };
type AtomLabelEditState = {
  objectId: string;
  atomId: string;
  initialElement: string;
  draft: string;
};
type AtomLabelEditOptions = {
  clearDraft?: boolean;
};
type SelectionMarqueeState = {
  pointerId: number;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
type ObjectContextMenuState = {
  objectId: string;
  targetKind: "object" | NativeMoleculeSelectionPart["kind"];
  bondDepthContext?: BondDepthContext;
  x: number;
  y: number;
};
type BondDepthMenuCrossing = Pick<ResolvedBondCrossing, "key" | "bonds" | "front" | "back" | "hasOverride">;
export type BondDepthCommandId = "bondDepth.bringInFront" | "bondDepth.sendBehind" | "bondDepth.useDefault";
export interface BondDepthContext {
  targetBondRefs: BondRef[];
  relevantCrossings: BondDepthMenuCrossing[];
  hasOverrides: boolean;
}
type LayerContextMenuItem = {
  commandId: string;
  label: string;
};
type ExportDialogFormat = ExportFormatId;
type SvgDialogExportOptions = {
  includeWarnings: boolean;
  includePageGuides: boolean;
};
type PdfDialogExportOptions = {
  compress: boolean;
  includePageGuides: boolean;
  page: "current";
  pdfType: "vector";
  background: "white";
};
type RasterDialogExportOptions = {
  scale: number;
  background: "white" | "transparent";
  jpegQuality: number;
  maxDimensionPx: number;
};
type CdxmlDialogExportOptions = {
  creationProgram: string;
};
type ExportDialogState = {
  format: ExportDialogFormat;
  filename: string;
  destinationPath?: string;
  svg: SvgDialogExportOptions;
  pdf: PdfDialogExportOptions;
  raster: RasterDialogExportOptions;
  cdxml: CdxmlDialogExportOptions;
  busy: boolean;
};
type ImportedPageFitPromptState = ImportedPageFitRecommendation & {
  displayName: string;
};

const RULER_THICKNESS = 32;
const FREEFORM_BOND_DRAG_THRESHOLD = 6;
const DOUBLE_BOND_SIDE_DRAG_THRESHOLD = 4;
const DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX = 13;
const VIEW_ZOOM_COMMAND_FACTOR = 1.25;
const rasterExportFormatsByFormatId: Partial<Record<ExportFormatId, NativeRasterExportFormat>> = {
  png: "png",
  jpeg: "jpeg",
  bmp: "bmp",
  gif: "gif",
  tiff: "tiff"
};
const exportFormatGroups: readonly ExportFormatGroup[] = ["graphics", "chemistry", "compatibility", "legacy", "model3d"];
const exportFormatGroupLabels: Record<ExportFormatGroup, string> = {
  graphics: "Graphics",
  chemistry: "Chemistry",
  compatibility: "Compatibility",
  legacy: "Legacy",
  model3d: "3D"
};
const exportFormatOptionExtensions = [...new Set(exportFormatDescriptors.flatMap((descriptor) => descriptor.extensions))];
const PROJECTED_PLANE_TILT_DRAG_PX = 360;
const OBJECT_ROTATE_TANGENTIAL_DEGREES_PER_PIXEL = 360 / PROJECTED_PLANE_TILT_DRAG_PX;
const OBJECT_DRAG_THRESHOLD = 4;
const GRAPHIC_HANDLE_DRAG_THRESHOLD = 1;
const OBJECT_RESIZE_MIN_SCALE = 0.12;
const DOCUMENT_HISTORY_LIMIT = 100;
const CURRENT_BUILD_STAMP = "6.16.21.47-codex";
const ART_TRANSFORM_QA_OBJECT_IDS = ["art_qa_rect", "art_qa_ellipse"] as const;
const ART_STYLE_QA_OBJECT_IDS = ["art_style_qa_rect", "art_style_qa_ellipse", "art_style_qa_line", "art_style_qa_arc"] as const;
// Whole-molecule double-click is normally read from the browser's `event.detail` click
// counter. That counter is unreliable when the first press mutates the DOM/selection under
// the pointer (seen at low zoom, where the wide bond catcher routes the press to the object
// handler and the first click selects a part, so the second press never reaches detail 2).
// We OR `event.detail` with a self-tracked detector keyed on wall-clock time and SCREEN
// distance (zoom-independent), shared by the page and object selection handlers.
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_SCREEN_PX = 6;

export interface SelectionPressSample {
  time: number;
  x: number;
  y: number;
  /** The document object resolved under the press, if any. */
  objectId?: string;
}

type TransformHandlePressKind =
  | "rotate-z"
  | "rotate-xy"
  | `resize-${ObjectResizeCorner}`;

interface TransformHandlePressSample extends SelectionPressSample {
  objectId: string;
  handleKind: TransformHandlePressKind;
}

/**
 * True when `current` is the second press of a double-click. Two presses that resolve to the
 * same object within the time window count, even when they land on different visible parts —
 * a small low-zoom object can span more than the screen-distance fallback, and the first press
 * mutates selection so the browser's `event.detail` counter is unreliable. Empty-canvas /
 * cross-target presses fall back to a tight screen-distance check.
 */
export function isSelectionDoublePress(
  previous: SelectionPressSample | undefined,
  current: SelectionPressSample,
  windowMs: number = DOUBLE_PRESS_MS,
  radiusPx: number = DOUBLE_PRESS_SCREEN_PX
): boolean {
  if (!previous || current.time - previous.time > windowMs) {
    return false;
  }
  // When both presses resolve to an object, the double-click is defined by the same object
  // (regardless of screen distance — a small low-zoom object exceeds the fallback radius).
  if (previous.objectId !== undefined && current.objectId !== undefined) {
    return previous.objectId === current.objectId;
  }
  // Empty-canvas / unresolved presses fall back to a tight screen-distance check.
  return Math.hypot(current.x - previous.x, current.y - previous.y) <= radiusPx;
}

function isTransformHandleDoublePress(
  previous: TransformHandlePressSample | undefined,
  current: TransformHandlePressSample,
  windowMs: number = DOUBLE_PRESS_MS,
  radiusPx: number = 18
): boolean {
  return Boolean(
    previous &&
    current.time - previous.time <= windowMs &&
    previous.objectId === current.objectId &&
    previous.handleKind === current.handleKind &&
    Math.hypot(current.x - previous.x, current.y - previous.y) <= radiusPx
  );
}
const layerContextMenuItems: readonly LayerContextMenuItem[] = [
  { commandId: "layout.bringForward", label: "Move Object Forward" },
  { commandId: "layout.bringToFront", label: "Move Object to Front" },
  { commandId: "layout.sendBackward", label: "Move Object Backward" },
  { commandId: "layout.sendToBack", label: "Move Object to Back" }
];
const nativeOpenDocumentEvent = "chemdraft://open-document";
// Window for coalescing the multi-channel delivery (Tauri event + pending-document poll)
// of a single OS file-open, while still allowing a deliberate later re-open.
const NATIVE_OPEN_DEDUPE_WINDOW_MS = 1500;

interface NativeOpenDocumentPayload {
  path: string;
  displayName: string;
  contents: string;
}

type ChemDraftAgentOpenResult =
  | { ok: true }
  | { ok: false; error: string };

interface ChemDraftAgentSnapshot {
  status: string;
  fileState: NativeFileState;
  pageCount: number;
  pages: Array<{
    id: string;
    width: number;
    height: number;
    objectCount: number;
    objectTypes: Partial<Record<DocumentObject["type"], number>>;
    crossingCount: number;
  }>;
  compatibilityWarnings: number;
}

interface ChemDraftAgentArtDebugSnapshot {
  ok: true;
  object: GraphicObject;
  editPoints?: NativeGraphicPathEditPoints;
  projectedEditPoints?: NativeGraphicPathEditPoints;
  plan: {
    pathD?: string;
    frameBounds: ReturnType<typeof planNativeArtVisual>["frameBounds"];
    markerHandles: ReturnType<typeof planNativeArtVisual>["markerHandles"];
    projectionTransform?: string;
    width: number;
    height: number;
  };
}

interface ChemDraftAgentBridge {
  openDocument(payload: { contents: string; displayName?: string; path?: string }): ChemDraftAgentOpenResult;
  snapshot(): ChemDraftAgentSnapshot;
  debugArtObject(objectId: string): ChemDraftAgentArtDebugSnapshot | { ok: false; error: string };
  waitForIdle(): Promise<void>;
}

declare global {
  interface Window {
    __CHEMDRAFT_AGENT__?: ChemDraftAgentBridge;
  }
}

export interface MainWindowProps {
  initialPaletteMode?: PaletteMode;
  initialRulersVisible?: boolean;
  initialCrosshairsVisible?: boolean;
  initialDocument?: ChemDraftDocument;
  initialActiveToolCommandId?: string;
  nativePalette?: boolean;
}

export function MainWindow({
  initialPaletteMode = "floating",
  initialRulersVisible = true,
  initialCrosshairsVisible = true,
  initialDocument,
  initialActiveToolCommandId,
  nativePalette = false
}: MainWindowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRegionRef = useRef<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const webPaletteDragRef = useRef<PaletteDragState | null>(null);
  const nativeBondDragRef = useRef<NativeBondDragState | null>(null);
  const nativePlacementDragRef = useRef<NativePlacementDragState | null>(null);
  const nativeBondEditDragRef = useRef<NativeBondEditDragState | null>(null);
  const nativePartDragRef = useRef<NativePartDragState | null>(null);
  const objectDragRef = useRef<ObjectDragState | null>(null);
  const graphicCornerRadiusDragRef = useRef<GraphicCornerRadiusDragState | null>(null);
  const graphicPathEditDragRef = useRef<GraphicPathEditDragState | null>(null);
  const graphicMarkerDragRef = useRef<GraphicMarkerDragState | null>(null);
  const objectRotateDragRef = useRef<ObjectRotateDragState | null>(null);
  const objectRotateReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const projectedPlaneTiltDragRef = useRef<ProjectedPlaneTiltDragState | null>(null);
  const projectedPlaneTiltReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const objectResizeDragRef = useRef<ObjectResizeDragState | null>(null);
  const objectResizeReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const groupTransformDragRef = useRef<GroupTransformDragState | null>(null);
  const textResizeRef = useRef<TextResizeState | null>(null);
  const artStylePreviewRef = useRef<{ startDocument: ChemDraftDocument } | null>(null);
  const lastNativeOpenPayloadKeyRef = useRef<{ key: string; at: number } | undefined>(undefined);
  const textEditorFocusTimeoutsRef = useRef<number[]>([]);
  const selectionMarqueeRef = useRef<SelectionMarqueeState | null>(null);
  const marqueeMachineRef = useRef<InteractionState>(initialInteractionState());
  const placementMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectRotateMachineRef = useRef<InteractionState>(initialInteractionState());
  const projectedPlaneTiltMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectDragMachineRef = useRef<InteractionState>(initialInteractionState());
  const groupTransformMachineRef = useRef<InteractionState>(initialInteractionState());
  const hoveredNativeAtomPointRef = useRef<{ objectId: string; point: ClientPoint } | undefined>(undefined);
  const gestureStartScaleRef = useRef(1);
  const lastCanvasPointerClientPointRef = useRef<ClientPoint | undefined>(undefined);
  const chemistryAdapter = useMemo(() => createRdkitPlaceholderAdapter(), []);
  const [documentHistory, setDocumentHistory] = useState(() =>
    createDocumentHistory(initialDocument ?? createPhase4Document())
  );
  const document = documentHistory.present;
  const [fileState, setFileState] = useState<NativeFileState>({ dirty: false });
  const [activeEditorObjectId, setActiveEditorObjectId] = useState<string | undefined>();
  const [activeTextEditObjectId, setActiveTextEditObjectId] = useState<string | undefined>();
  const [activeTextSelection, setActiveTextSelection] = useState<{ objectId: string; range: NativeTextSelectionRange } | undefined>();
  const [activeGraphicTransformObjectId, setActiveGraphicTransformObjectId] = useState<string | undefined>();
  const [activeArtPaintTarget, setActiveArtPaintTarget] = useState<GraphicStylePaintTarget>("fill");
  const [activeAtomLabelEdit, setActiveAtomLabelEdit] = useState<AtomLabelEditState | undefined>();
  const [textStyleDefaults, setTextStyleDefaults] = useState<NativeTextStyle>(DefaultNativeTextStyle);
  const [activeToolState, setActiveToolState] = useState(() => createActiveToolState(initialActiveToolCommandId));
  const [toolsetRegistry, setToolsetRegistry] = useState<DesktopToolsetRegistry>(() => desktopToolsetRegistry);
  const [visibleToolsetIds, setVisibleToolsetIds] = useState(() =>
    initialPaletteMode === "hidden" ? new Set<string>() : new Set(defaultVisibleToolsetIds)
  );
  const [webPaletteFallback, setWebPaletteFallback] = useState(false);
  const effectiveNativePalette = nativePalette && !webPaletteFallback;
  const [webPalettePositions, setWebPalettePositions] = useState<Record<string, PalettePosition>>(() =>
    createDefaultToolsetPositions(desktopToolsetRegistry)
  );
  const [rulersVisible, setRulersVisible] = useState(initialRulersVisible);
  const [crosshairsVisible, setCrosshairsVisible] = useState(initialCrosshairsVisible);
  const [hoveredNativeAtom, setHoveredNativeAtom] = useState<HoveredNativeAtom | undefined>();
  const [hoveredNativeDeleteTarget, setHoveredNativeDeleteTarget] = useState<NativeMoleculeDeleteTarget | undefined>();
  // The ghost of the ring a template click would place (fuse / spiro / standalone / closure),
  // rendered from the same plan the click commits so preview and result can never diverge.
  const [templatePreview, setTemplatePreview] = useState<NativeTemplatePlacementPlan | undefined>();
  const [selectedNativeMoleculePart, setSelectedNativeMoleculePart] = useState<NativeMoleculeSelectionPart | undefined>();
  const [selectionMarquee, setSelectionMarquee] = useState<SelectionMarqueeState | undefined>();
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuState | undefined>();
  const [freeformNativeBond, setFreeformNativeBond] = useState<FreeformNativeBondPreview | undefined>();
  const [nativeDoubleBondSidePreview, setNativeDoubleBondSidePreview] = useState<NativeDoubleBondSidePreview | undefined>();
  const [graphicCornerRadiusReadout, setGraphicCornerRadiusReadout] = useState<GraphicCornerRadiusReadoutState | undefined>();
  const [objectRotateReadout, setObjectRotateReadout] = useState<ObjectRotateReadoutState | undefined>();
  const [projectedPlaneTiltReadout, setProjectedPlaneTiltReadout] = useState<ProjectedPlaneTiltReadoutState | undefined>();
  const [rotationInput, setRotationInput] = useState<RotationInputState | undefined>();
  const [objectResizeInput, setObjectResizeInput] = useState<ObjectResizeInputState | undefined>();
  const [objectResizeReadout, setObjectResizeReadout] = useState<ObjectResizeReadoutState | undefined>();
  const [artTransformQaDraft, setArtTransformQaDraft] = useState<ArtTransformQaDraft>({
    rotationDegrees: "28",
    tiltXDegrees: "35",
    tiltYDegrees: "-20"
  });
  const artTransformQaEnabled = useMemo(() => shouldEnableArtTransformQaLayer(), []);
  const artStyleQaEnabled = useMemo(() => shouldEnableArtStyleQaLayer(), []);
  const [artStyleQaRunCount, setArtStyleQaRunCount] = useState(0);
  const [viewport, setViewport] = useState(() =>
    createViewportState({ rulerUnit: rulerUnitForDocument(initialDocument) })
  );
  const [rulerFrame, setRulerFrame] = useState<RulerFrame>(() => ({
    horizontalScrollPx: 0,
    verticalScrollPx: 0,
    width: 0,
    height: 0
  }));
  const [status, setStatus] = useState("Blank native document");
  const [exportDialog, setExportDialog] = useState<ExportDialogState | undefined>();
  const [pageFitPrompt, setPageFitPrompt] = useState<ImportedPageFitPromptState | undefined>();
  const [, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);
  const invokeCommandRef = useRef<(commandId: string) => void>(() => undefined);
  const documentRef = useRef(document);
  const documentHistoryRef = useRef<DocumentHistory>(documentHistory);
  const fileStateRef = useRef<NativeFileState>(fileState);
  const statusRef = useRef(status);
  const rotationInputRef = useRef<RotationInputState | undefined>(undefined);
  const objectResizeInputRef = useRef<ObjectResizeInputState | undefined>(undefined);
  const activeToolCommandIdRef = useRef(activeToolState.activeCommandId);
  const toolBeforeTextPlacementRef = useRef<ActiveToolState | undefined>(undefined);
  const hoveredNativeDeleteTargetRef = useRef<NativeMoleculeDeleteTarget | undefined>(undefined);
  // The last template-tool hover (page point + tool/template identity + resolved target), so a
  // template click can reuse exactly what the highlight is painting (see
  // currentTemplateTargetFromHoverOrHit) rather than recompute a possibly-disagreeing hit.
  const templateHoverTargetRef = useRef<TemplateHoverSample | undefined>(undefined);
  // Memo key for the ghost preview so we only recompute the plan (and its Kekulé pass) when the
  // hovered target or pointer cell changes, not on every sub-pixel pointer move.
  const templatePreviewKeyRef = useRef<string | undefined>(undefined);
  const activeTextSelectionRef = useRef<{ objectId: string; range: NativeTextSelectionRange } | undefined>(undefined);
  const toolbarStyleTargetRef = useRef<ToolbarStyleTargetSnapshot | undefined>(undefined);
  const viewportRef = useRef(viewport);
  // Shared across the page and object selection handlers so a whole-molecule double-click is
  // detected regardless of which handler each of the two presses routes to (see
  // isSelectionDoublePress).
  const lastSelectionPressRef = useRef<SelectionPressSample | undefined>(undefined);
  const lastTransformHandlePressRef = useRef<TransformHandlePressSample | undefined>(undefined);

  documentRef.current = document;
  documentHistoryRef.current = documentHistory;
  fileStateRef.current = fileState;
  statusRef.current = status;
  rotationInputRef.current = rotationInput;
  objectResizeInputRef.current = objectResizeInput;
  activeToolCommandIdRef.current = activeToolState.activeCommandId;
  hoveredNativeDeleteTargetRef.current = hoveredNativeDeleteTarget;

  const selectedMolecule = getSelectedMolecule(document);
  const selectedTextObject = getSelectedTextObject(document);
  const selectedTextRange = selectedTextObject &&
    activeTextEditObjectId === selectedTextObject.id &&
    activeTextSelection?.objectId === selectedTextObject.id &&
    activeTextSelection.range.start !== activeTextSelection.range.end
    ? activeTextSelection.range
    : undefined;
  const selectedTextScript = selectedTextObject
    ? selectedTextRange
      ? textScriptForTextRange(selectedTextObject, selectedTextRange)
      : textScriptForTextObject(selectedTextObject)
    : "normal";
  const selectedNativePartObject = selectedNativeMoleculePart
    ? findDocumentObject(document, selectedNativeMoleculePart.objectId)
    : undefined;
  const selectedMoleculeForStyle = selectedNativePartObject?.type === "molecule"
    ? selectedNativePartObject
    : selectedMolecule;
  const selectedToolbarObject = document.selection.objectIds.length === 1
    ? findDocumentObject(document, document.selection.objectIds[0])
    : undefined;
  const currentToolbarTextStyle = useMemo(() => {
    if (selectedTextObject) {
      return selectedTextRange
        ? nativeTextStyleFromObjectStyle({
            ...selectedTextObject.style,
            ...textStyleForTextRange(selectedTextObject, selectedTextRange)
          })
        : nativeTextStyleFromObjectStyle(selectedTextObject.style);
    }

    if (selectedMoleculeForStyle) {
      const drawingStyle = nativeDrawingStyleFromObjectStyle(selectedMoleculeForStyle.style);
      return nativeTextStyleFromObjectStyle({
        ...textStyleDefaults,
        color: selectedNativeMoleculePart?.objectId === selectedMoleculeForStyle.id
          ? nativeMoleculeSelectionColor(selectedMoleculeForStyle, selectedNativeMoleculePart, drawingStyle)
          : drawingStyle.bondColor
      });
    }

    if (selectedToolbarObject) {
      return nativeTextStyleFromObjectStyle({
        ...textStyleDefaults,
        color: documentObjectToolbarColor(selectedToolbarObject)
      });
    }

    return textStyleDefaults;
  }, [
    selectedMoleculeForStyle,
    selectedNativeMoleculePart,
    selectedTextObject,
    selectedTextRange,
    selectedToolbarObject,
    textStyleDefaults
  ]);
  const currentToolbarObjectColor = useMemo(() => {
    if (selectedMoleculeForStyle) {
      const drawingStyle = nativeDrawingStyleFromObjectStyle(selectedMoleculeForStyle.style);
      return selectedNativeMoleculePart?.objectId === selectedMoleculeForStyle.id
        ? nativeMoleculeSelectionColor(selectedMoleculeForStyle, selectedNativeMoleculePart, drawingStyle)
        : drawingStyle.bondColor;
    }

    if (selectedToolbarObject) {
      return documentObjectToolbarColor(selectedToolbarObject);
    }

    return textStyleDefaults.color;
  }, [
    selectedMoleculeForStyle,
    selectedNativeMoleculePart,
    selectedToolbarObject,
    textStyleDefaults.color
  ]);
  const currentArtStyle = useMemo(() => {
    const model = createArtInspectorModel({
      document,
      selectedGraphicObjects: selectedGraphicObjectsForArtInspector(document),
      requestedPaintTarget: activeArtPaintTarget
    });
    return model.selectedCount > 0 ? model : undefined;
  }, [activeArtPaintTarget, document]);
  const currentToolbarTextScript = selectedTextObject ? selectedTextScript : "normal";

  useEffect(() => {
    if (!currentArtStyle || currentArtStyle.selectedCount === 0) {
      return;
    }

    if (activeArtPaintTarget !== currentArtStyle.activePaintTarget) {
      setActiveArtPaintTarget(currentArtStyle.activePaintTarget);
    }
  }, [activeArtPaintTarget, currentArtStyle]);

  const currentToolbarTextStateRef = useRef(
    createToolsetTextStylePayload(currentToolbarTextStyle, currentToolbarTextScript, currentArtStyle, activeArtPaintTarget)
  );
  currentToolbarTextStateRef.current = createToolsetTextStylePayload(
    currentToolbarTextStyle,
    currentToolbarTextScript,
    currentArtStyle,
    activeArtPaintTarget
  );
  const activeEditorMolecule =
    selectedMolecule && selectedMolecule.id === activeEditorObjectId ? selectedMolecule : undefined;
  const activeNativeBondToolStyle = nativeBondStyleForToolCommand(activeToolState.activeCommandId);
  const activeNativeBondDisplayStyle = activeNativeBondToolStyle && activeNativeBondToolStyle !== "solid"
    ? activeNativeBondToolStyle
    : undefined;
  const activeNativeTemplateId = nativeTemplateForToolCommand(activeToolState.activeCommandId);
  const bondToolActive = activeNativeBondToolStyle !== undefined;
  const activeChargeToolValue = chargeValueForToolCommand(activeToolState.activeCommandId);
  const activeNativeArtTool = nativeArtToolForCommand(activeToolState.activeCommandId);
  const activePage = document.pages[0];
  const plannedDisplayPage = useMemo(() => {
    if (!nativeDoubleBondSidePreview) {
      return activePage;
    }

    return {
      ...activePage,
      objects: activePage.objects.map((object) => {
        if (object.type !== "molecule" || object.id !== nativeDoubleBondSidePreview.objectId) {
          return object;
        }

        return {
          ...object,
          bonds: object.bonds.map((bond) => (
            bond.id === nativeDoubleBondSidePreview.bondId && bond.order === "double"
              ? { ...bond, display: { ...(bond.display ?? {}), doubleBondSide: nativeDoubleBondSidePreview.side } }
              : bond
          ))
        };
      })
    };
  }, [activePage, nativeDoubleBondSidePreview]);
  const editorSvgDisplayPage = useMemo(() => {
    const svgObjects = plannedDisplayPage.objects.filter((object) => object.type !== "graphic");
    if (svgObjects.length === plannedDisplayPage.objects.length) {
      return plannedDisplayPage;
    }

    return { ...plannedDisplayPage, objects: svgObjects };
  }, [plannedDisplayPage]);
  const pageSvgRenderPlan = useMemo(() => planPageSvgRender(editorSvgDisplayPage), [editorSvgDisplayPage]);
  const pageRulerUnit = useMemo(() => rulerUnitForPageLayout(activePage.layout), [activePage.layout.sourceUnit]);
  const canUndo = documentHistory.past.length > 0;
  const canRedo = documentHistory.future.length > 0;
  const quickActions = useMemo(
    () => createQuickActions(document, selectedMolecule, { canUndo, canRedo }),
    [canRedo, canUndo, document, selectedMolecule]
  );
  const layerActions = useMemo(() => createLayerActions(document), [document]);
  const pageCssVars = useMemo(
    () =>
      ({
        "--page-layout-width": `${activePage.width}px`,
        "--page-layout-height": `${activePage.height}px`,
        // Bond pointer catcher width — single source of truth in hitTest.ts so the DOM
        // catcher stays a routing superset of the model tolerance (invariant #1).
        "--bond-hit-stroke-px": `${BOND_HIT_CATCHER_STROKE_PX}`
      }) as CSSProperties,
    [activePage.height, activePage.width]
  );
  const horizontalCrosshairTicks = useMemo(
    () => buildCrosshairTicks(activePage.width, pageRulerUnit),
    [activePage.width, pageRulerUnit]
  );
  const verticalCrosshairTicks = useMemo(
    () => buildCrosshairTicks(activePage.height, pageRulerUnit),
    [activePage.height, pageRulerUnit]
  );
  const visibleFloatingToolsets = useMemo(
    () => toolsetRegistry.listToolsets().filter((toolset) => visibleToolsetIds.has(toolset.id)),
    [toolsetRegistry, visibleToolsetIds]
  );
  const chargeResolutionByMoleculeId = useMemo(() => {
    const byMoleculeId = new Map<string, ReadonlyMap<string, number>>();
    activePage.objects.forEach((object) => {
      if (object.type !== "molecule") {
        return;
      }

      const associations = nativeChargeAssociationsForMolecule(object, activePage.objects);
      byMoleculeId.set(object.id, nativeChargeByAtomIdFromAssociations(associations));
    });
    return byMoleculeId;
  }, [activePage.objects]);
  const activeTool = activeToolState.activeCommandId;
  const toolCommandSpecs = useMemo(
    () => withStandaloneDrawingToolCommands(getToolsetCommandSpecs(toolsetRegistry)),
    [toolsetRegistry]
  );
  const shortcutCommands = useMemo(
    () => [
      ...quickActions,
      ...layerActions,
      ...editActions,
      ...toolCommandSpecs,
      ...viewActions,
      ...pageSizeActions,
      ...pageOrientationActions,
      ...textToolbarActions,
      ...toolbarCustomizationActions
    ],
    [layerActions, quickActions, toolCommandSpecs]
  );
  const shortcutRegistry = useMemo(
    () => createDesktopShortcutRegistry(shortcutCommands),
    [shortcutCommands]
  );
  const assignHoveredNativeDeleteTarget = useCallback((target: NativeMoleculeDeleteTarget | undefined) => {
    hoveredNativeDeleteTargetRef.current = target;
    if (!target || target.kind !== "atom") {
      hoveredNativeAtomPointRef.current = undefined;
    }
    setHoveredNativeDeleteTarget(target);
  }, []);
  const updateToolbarStyleTargetSnapshot = useCallback((
    nextDocument: ChemDraftDocument,
    moleculePart: NativeMoleculeSelectionPart | undefined = selectedNativeMoleculePart
  ) => {
    const objectIds = [...nextDocument.selection.objectIds];
    const textRange = activeTextSelectionRef.current;
    if (objectIds.length === 0 && !moleculePart && !textRange) {
      return;
    }

    toolbarStyleTargetRef.current = {
      objectIds,
      moleculePart,
      textRange
    };
  }, [selectedNativeMoleculePart]);
  const installDocumentHistory = useCallback((history: DocumentHistory) => {
    documentHistoryRef.current = history;
    documentRef.current = history.present;
    updateToolbarStyleTargetSnapshot(history.present);
    setDocumentHistory(history);
  }, [updateToolbarStyleTargetSnapshot]);
  const resetDocumentHistory = useCallback((nextDocument: ChemDraftDocument, nextFileState: NativeFileState = { dirty: false }) => {
    if (nextDocument.selection.objectIds.length === 0) {
      toolbarStyleTargetRef.current = undefined;
    }
    installDocumentHistory(createDocumentHistory(nextDocument));
    fileStateRef.current = nextFileState;
    setFileState(nextFileState);
  }, [installDocumentHistory]);
  const replacePresentDocument = useCallback((
    nextDocumentOrUpdate: ChemDraftDocument | ((current: ChemDraftDocument) => ChemDraftDocument)
  ): boolean => {
    const currentHistory = documentHistoryRef.current;
    const nextDocument = typeof nextDocumentOrUpdate === "function"
      ? nextDocumentOrUpdate(currentHistory.present)
      : nextDocumentOrUpdate;
    if (nextDocument === currentHistory.present) {
      return false;
    }

    installDocumentHistory({
      ...currentHistory,
      present: nextDocument
    });
    return true;
  }, [installDocumentHistory]);
  const commitDocumentChange = useCallback((
    nextDocumentOrUpdate: ChemDraftDocument | ((current: ChemDraftDocument) => ChemDraftDocument)
  ): boolean => {
    const currentHistory = documentHistoryRef.current;
    const nextDocument = typeof nextDocumentOrUpdate === "function"
      ? nextDocumentOrUpdate(currentHistory.present)
      : nextDocumentOrUpdate;
    if (nextDocument === currentHistory.present) {
      return false;
    }

    installDocumentHistory({
      past: [...currentHistory.past, currentHistory.present].slice(-DOCUMENT_HISTORY_LIMIT),
      present: nextDocument,
      future: []
    });
    setFileState((current) => {
      const nextFileState = { ...current, dirty: true };
      fileStateRef.current = nextFileState;
      return nextFileState;
    });
    return true;
  }, [installDocumentHistory]);
  const applyArtTransformQaScene = useCallback(() => {
    const changed = commitDocumentChange((current) => artTransformQaSceneDocument(current, artTransformQaDraft));
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setStatus("Art QA scene applied");
    }
  }, [artTransformQaDraft, commitDocumentChange]);
  const applyArtTransformQaToSelection = useCallback(() => {
    const changed = commitDocumentChange((current) =>
      artTransformQaSelectionDocument(current, artTransformQaDraft)
    );
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setStatus("Art QA transform applied");
    } else {
      setStatus("Art QA needs a selected graphic object");
    }
  }, [artTransformQaDraft, commitDocumentChange]);
  const applyArtStyleQaScene = useCallback(() => {
    const changed = commitDocumentChange(artStyleQaSceneDocument);
    setArtStyleQaRunCount(0);
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setStatus("Art style QA scene applied");
    }
  }, [commitDocumentChange]);
  const runArtStyleQaStress = useCallback(() => {
    const nextRunCount = artStyleQaRunCount + 1;
    const changed = commitDocumentChange((current) => artStyleQaStressDocument(current, nextRunCount));
    if (changed) {
      setSelectedNativeMoleculePart(undefined);
      setArtStyleQaRunCount(nextRunCount);
      setStatus(`Art style QA stress pass ${nextRunCount}`);
    } else {
      setStatus("Art style QA stress could not create graphics");
    }
  }, [artStyleQaRunCount, commitDocumentChange]);
  const updateRotationInput = useCallback((nextInput: RotationInputState | undefined) => {
    rotationInputRef.current = nextInput;
    setRotationInput(nextInput);
  }, []);
  const updateObjectResizeInput = useCallback((nextInput: ObjectResizeInputState | undefined) => {
    objectResizeInputRef.current = nextInput;
    setObjectResizeInput(nextInput);
  }, []);
  const markDocumentDirty = useCallback(() => {
    setFileState((current) => {
      const nextFileState = { ...current, dirty: true };
      fileStateRef.current = nextFileState;
      return nextFileState;
    });
  }, []);
  const commitLiveInputPreview = useCallback((startDocument: ChemDraftDocument): boolean => {
    const currentHistory = documentHistoryRef.current;
    if (currentHistory.present === startDocument) {
      return false;
    }

    installDocumentHistory({
      past: [...currentHistory.past, startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: currentHistory.present,
      future: []
    });
    markDocumentDirty();
    return true;
  }, [installDocumentHistory, markDocumentDirty]);

  useEffect(() => {
    if (!bondToolActive) {
      setNativeDoubleBondSidePreview(undefined);
    }
  }, [bondToolActive]);

  useEffect(() => {
    if (!nativePalette) {
      return undefined;
    }

    let active = true;
    void loadToolsetLayoutState()
      .then((layoutState) => {
        if (!active || layoutState === undefined) {
          return;
        }

        const nextRegistry = createDesktopToolsetRegistry(layoutState);
        setToolsetRegistry(nextRegistry);
        setWebPalettePositions(createDefaultToolsetPositions(nextRegistry));
        setVisibleToolsetIds((current) => {
          const knownVisibleIds = [...current].filter((toolsetId) => nextRegistry.get(toolsetId));
          if (current.size === 0) {
            return createDefaultVisibleToolsetIds(nextRegistry);
          }
          return current.size === knownVisibleIds.length
            ? current
            : new Set(knownVisibleIds.length > 0 ? knownVisibleIds : createDefaultVisibleToolsetIds(nextRegistry));
        });
      })
      .catch((error: unknown) => {
        setWebPaletteFallback(true);
        setVisibleToolsetIds(createDefaultVisibleToolsetIds(desktopToolsetRegistry));
        setStatus(`Native toolbar layout unavailable; using in-window toolbars (${error instanceof Error ? error.message : String(error)})`);
      });

    return () => {
      active = false;
    };
  }, [nativePalette]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => () => {
    if (objectRotateReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(objectRotateReadoutTimeoutRef.current);
    }
    if (projectedPlaneTiltReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(projectedPlaneTiltReadoutTimeoutRef.current);
    }
    if (objectResizeReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(objectResizeReadoutTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    void broadcastToolsetActiveTool(activeToolState.activeCommandId).catch(() => undefined);
  }, [activeToolState.activeCommandId]);

  useEffect(() => {
    void broadcastToolsetTextStyle(
      createToolsetTextStylePayload(currentToolbarTextStyle, currentToolbarTextScript, currentArtStyle, activeArtPaintTarget)
    ).catch(() => undefined);
  }, [activeArtPaintTarget, currentArtStyle, currentToolbarTextScript, currentToolbarTextStyle]);

  useEffect(() => {
    if (!bondToolActive) {
      nativeBondDragRef.current = null;
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
    }
  }, [bondToolActive]);

  useEffect(() => {
    setSelectedNativeMoleculePart((current) => {
      if (!current) {
        return current;
      }

      const object = findDocumentObject(document, current.objectId);
      if (object?.type !== "molecule") {
        return undefined;
      }

      if (current.kind === "atom") {
        return object.atoms.some((atom) => atom.id === current.atomId) ? current : undefined;
      }

      if (current.kind === "bond") {
        return object.bonds.some((bond) => bond.id === current.bondId) ? current : undefined;
      }

      const atomIds = current.atomIds.filter((atomId) => object.atoms.some((atom) => atom.id === atomId));
      const bondIds = current.bondIds.filter((bondId) => object.bonds.some((bond) => bond.id === bondId));
      return atomIds.length > 0 || bondIds.length > 0
        ? { ...current, atomIds, bondIds }
        : undefined;
    });
  }, [document]);

  useEffect(() => {
    setActiveTextEditObjectId((current) => {
      if (!current) {
        return current;
      }

      return findDocumentObject(document, current)?.type === "text" ? current : undefined;
    });
  }, [document]);

  useEffect(() => {
    setActiveAtomLabelEdit((current) => {
      if (!current) {
        return current;
      }

      const object = findDocumentObject(document, current.objectId);
      if (object?.type !== "molecule" || !object.atoms.some((atom) => atom.id === current.atomId)) {
        return undefined;
      }

      return current;
    });
  }, [document]);

  useEffect(() => {
    setViewport((current) => {
      if (current.rulerUnit.kind === pageRulerUnit.kind) {
        return current;
      }

      const next = { ...current, rulerUnit: pageRulerUnit };
      viewportRef.current = next;
      return next;
    });
  }, [pageRulerUnit]);

  useEffect(() => {
    if (objectContextMenu && !findDocumentObject(document, objectContextMenu.objectId)) {
      setObjectContextMenu(undefined);
    }
  }, [document, objectContextMenu]);

  const updateRulerFrame = useCallback(() => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    if (!canvas || !page) {
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const thickness = rulersVisible ? RULER_THICKNESS : 0;
    const nextFrame = {
      horizontalScrollPx: (canvasRect.left + thickness - pageRect.left) / viewportRef.current.scale,
      verticalScrollPx: (canvasRect.top + thickness - pageRect.top) / viewportRef.current.scale,
      width: Math.max(0, canvas.clientWidth - thickness),
      height: Math.max(0, canvas.clientHeight - thickness)
    };

    setRulerFrame((current) =>
      rulerFramesEqual(current, nextFrame) ? current : nextFrame
    );
  }, [rulersVisible]);

  useEffect(() => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    if (!canvas || !page) {
      return undefined;
    }

    let animationFrame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateRulerFrame);
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);

    canvas.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    resizeObserver.observe(canvas);
    resizeObserver.observe(page);
    scheduleUpdate();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver.disconnect();
    };
  }, [rulersVisible, updateRulerFrame, viewport.scale]);

  const zoomCanvasAtClientPoint = useCallback((nextScale: number, clientPoint: ClientPoint) => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    const currentScale = viewportRef.current.scale;

    if (!canvas || !page) {
      setViewport((current) => {
        const next = setViewportScale(current, nextScale);
        viewportRef.current = next;
        return next;
      });
      return;
    }

    const pageRect = page.getBoundingClientRect();
    const focalPagePoint = clientToPage(clientPoint, { pageRect, scale: currentScale });

    setViewport((current) => {
      const next = setViewportScale(current, nextScale);
      viewportRef.current = next;
      return next;
    });

    window.requestAnimationFrame(() => {
      const nextCanvas = canvasRegionRef.current;
      const nextPage = pageRef.current;
      if (!nextCanvas || !nextPage) {
        return;
      }

      const nextPageRect = nextPage.getBoundingClientRect();
      const nextClientPoint = pageToClient(focalPagePoint, {
        pageRect: nextPageRect,
        scale: viewportRef.current.scale
      });

      nextCanvas.scrollLeft += nextClientPoint.x - clientPoint.x;
      nextCanvas.scrollTop += nextClientPoint.y - clientPoint.y;
    });
  }, []);

  const zoomCanvasFromWheelEvent = useCallback((event: Pick<globalThis.WheelEvent, "clientX" | "clientY" | "ctrlKey" | "deltaY" | "metaKey">) => {
    if (!shouldUseViewportWheelZoom(event)) {
      return false;
    }

    zoomCanvasAtClientPoint(viewportRef.current.scale * wheelDeltaToZoomFactor(event.deltaY), {
      x: event.clientX,
      y: event.clientY
    });
    return true;
  }, [zoomCanvasAtClientPoint]);

  // Bind zoom gestures directly to the canvas element. Earlier this lived on
  // `window` behind an `eventIsInsideCanvas` guard that relied on `event.target`
  // (unreliable for WebKit gesture events) and a stale pointer-tracking ref, which
  // silently rejected valid trackpad pinches. Listening on the canvas makes every
  // event in-scope by construction, so no guard is needed.
  useEffect(() => {
    const canvas = canvasRegionRef.current;
    if (!canvas) {
      return undefined;
    }

    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      if (!zoomCanvasFromWheelEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      gestureStartScaleRef.current = viewportRef.current.scale;
    };
    const handleGestureChange = (event: Event) => {
      const gesture = event as WebKitGestureEvent;
      event.preventDefault();
      event.stopPropagation();
      zoomCanvasAtClientPoint(
        gestureStartScaleRef.current * (gesture.scale ?? 1),
        clientPointFromGesture(gesture, canvas, lastCanvasPointerClientPointRef.current)
      );
    };
    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      gestureStartScaleRef.current = viewportRef.current.scale;
    };
    const listenerOptions = { capture: true, passive: false } as AddEventListenerOptions;

    canvas.addEventListener("wheel", handleNativeWheel, listenerOptions);
    canvas.addEventListener("gesturestart", handleGestureStart, listenerOptions);
    canvas.addEventListener("gesturechange", handleGestureChange, listenerOptions);
    canvas.addEventListener("gestureend", handleGestureEnd, listenerOptions);

    return () => {
      canvas.removeEventListener("wheel", handleNativeWheel, listenerOptions);
      canvas.removeEventListener("gesturestart", handleGestureStart, listenerOptions);
      canvas.removeEventListener("gesturechange", handleGestureChange, listenerOptions);
      canvas.removeEventListener("gestureend", handleGestureEnd, listenerOptions);
    };
  }, [zoomCanvasAtClientPoint, zoomCanvasFromWheelEvent]);

  const toggleToolset = useCallback(async (toolsetId: string) => {
    if (!toolsetRegistry.get(toolsetId)) {
      setStatus(`Unknown toolbar ${toolsetId}`);
      return;
    }

    if (effectiveNativePalette) {
      const nextState = await toggleToolsetWindow(toolsetId);
      setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, nextState.open));
      setStatus(nextState.open ? `${toolsetRegistry.require(toolsetId).title} open` : `${toolsetRegistry.require(toolsetId).title} closed`);
      return;
    }

    setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, !current.has(toolsetId)));
    setStatus(`Toggled ${toolsetRegistry.require(toolsetId).title}`);
  }, [effectiveNativePalette, toolsetRegistry]);

  const deleteHoveredNativeTarget = useCallback(() => {
    const currentDocument = documentRef.current;
    const selectedFragmentTarget = selectedNativeMoleculePart?.kind === "parts"
      ? selectedNativeMoleculePart
      : undefined;
    const target = selectedFragmentTarget ? undefined : hoveredNativeDeleteTargetRef.current;
    const selectedPartTarget = selectedFragmentTarget ?? selectedNativeMoleculePart;
    if (!target && selectedPartTarget) {
      const nextDocument = applyNativeMoleculePartDeleteTarget(currentDocument, selectedPartTarget);
      if (nextDocument === currentDocument) {
        setStatus("No selected atom, bond, or fragment");
        return;
      }

      commitDocumentChange(nextDocument);
      toolbarStyleTargetRef.current = undefined;
      setActiveEditorObjectId((current) => current === selectedPartTarget.objectId ? undefined : current);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      setObjectContextMenu(undefined);
      setStatus(selectedPartTarget.kind === "parts"
        ? "Deleted selected molecule fragment"
        : selectedPartTarget.kind === "atom" ? "Deleted carbon atom" : "Deleted carbon bond");
      return;
    }

    if (!target) {
      const nextDocument = deleteSelectedDocumentObjects(currentDocument);
      if (nextDocument === currentDocument) {
        setStatus("No selected object, atom, or bond");
        return;
      }

      const deletedCount = currentDocument.selection.objectIds.length;
      commitDocumentChange(nextDocument);
      toolbarStyleTargetRef.current = undefined;
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      setObjectContextMenu(undefined);
      setStatus(deletedCount === 1 ? "Deleted selected object" : `Deleted ${deletedCount} selected objects`);
      return;
    }

    const nextDocument = applyNativeMoleculeDeleteTarget(currentDocument, target);
    if (nextDocument === currentDocument) {
      setStatus("No hovered atom or bond");
      return;
    }

    commitDocumentChange(nextDocument);
    toolbarStyleTargetRef.current = undefined;
    setActiveEditorObjectId((current) => current === target.objectId ? undefined : current);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    setStatus(target.kind === "atom"
      ? "Deleted carbon atom"
      : target.terminalAtomId ? "Deleted terminal carbon" : "Deleted carbon bond");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const cycleNativeBondOrder = useCallback((target: NativeBondOrderTarget) => {
    const currentDocument = documentRef.current;
    const selectedDocument = selectDocumentObject(currentDocument, target.objectId);
    const nextDocument = applyNativeMoleculeBondOrderTarget(selectedDocument, target);
    if (nextDocument === selectedDocument) {
      setStatus("Bond is already at its maximum allowed order");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Changed bond order");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const setHoveredNativeBondOrder = useCallback((order: NativeBondOrderValue) => {
    const currentDocument = documentRef.current;
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(currentDocument, selectedNativeMoleculePart);
    if (!target || target.kind !== "bond") {
      setStatus(`No hovered bond for ${order} bond`);
      return;
    }

    const selectedDocument = selectDocumentObject(currentDocument, target.objectId);
    const nextDocument = applyNativeMoleculeBondOrderValueTarget(selectedDocument, target, order);
    if (nextDocument === selectedDocument) {
      setStatus(`Cannot set hovered bond to ${order}`);
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus(`Set hovered bond to ${order}`);
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const setHoveredNativeAtomElement = useCallback((element: NativeSingleLetterElement) => {
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus(`No hovered atom for ${element}`);
      return;
    }

    const currentDocument = documentRef.current;
    const nextDocument = applyNativeAtomElementTarget(currentDocument, target, element);
    if (nextDocument === currentDocument) {
      setStatus(`Cannot set hovered atom to ${element}`);
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus(`Set hovered atom to ${element}`);
  }, [commitDocumentChange, selectedNativeMoleculePart]);

  const addCarbonylToHoveredNativeAtom = useCallback(() => {
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus("No hovered carbon for C=O");
      return;
    }

    const currentDocument = documentRef.current;
    const steeringPoint = hoveredNativeAtomPointRef.current?.objectId === target.objectId
      ? hoveredNativeAtomPointRef.current.point
      : undefined;
    const nextDocument = applyNativeCarbonylAtAtomTarget(currentDocument, target, steeringPoint);
    if (nextDocument === currentDocument) {
      setStatus("Cannot add C=O to hovered atom");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Added C=O to hovered carbon");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const addSingleBondToHoveredNativeAtom = useCallback(() => {
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus("No hovered atom for single bond");
      return;
    }

    const currentDocument = documentRef.current;
    const steeringPoint = hoveredNativeAtomPointRef.current?.objectId === target.objectId
      ? hoveredNativeAtomPointRef.current.point
      : undefined;
    const nextDocument = applySingleBondToolAtNativeAtom(currentDocument, target, steeringPoint);
    if (nextDocument === currentDocument) {
      setStatus("Cannot add a single bond to hovered atom");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Added single bond to hovered atom");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const addChargeToHoveredNativeAtom = useCallback((charge: NativeChargeValue, explicitTarget?: NativeMoleculeDeleteTarget) => {
    const target = explicitTarget
      ?? hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    if (!target || target.kind !== "atom") {
      setStatus(charge > 0 ? "No hovered atom for positive charge" : "No hovered atom for negative charge");
      return;
    }

    const currentDocument = documentRef.current;
    const nextDocument = applyChargeToolAtNativeAtom(currentDocument, charge, target);
    if (nextDocument === currentDocument) {
      setStatus(charge > 0 ? "Cannot place positive charge on hovered atom" : "Cannot place negative charge on hovered atom");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setStatus(charge > 0 ? "Placed positive charge on hovered atom" : "Placed negative charge on hovered atom");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const cleanUpSelectedStructure = useCallback(() => {
    const currentDocument = documentRef.current;
    const targetObjectIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];
    if (targetObjectIds.length === 0) {
      setStatus("No selected structure to clean up");
      return;
    }

    const changed = commitDocumentChange((current) => cleanUpNativeMolecules2d(current, targetObjectIds));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    const targetLabel = targetObjectIds.length === 1 ? "structure" : "structures";
    setStatus(changed ? `Cleaned up selected ${targetLabel}` : `Selected ${targetLabel} already clean`);
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, selectedNativeMoleculePart]);

  const cleanUpSelectedStructure3d = useCallback(() => {
    const currentDocument = documentRef.current;
    const selectedObjectIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];

    if (selectedObjectIds.length === 0) {
      setStatus("No selected structure for 3D cleanup");
      return;
    }

    if (selectedObjectIds.length !== 1) {
      setStatus("Select a single structure for 3D cleanup");
      return;
    }

    const objectId = selectedObjectIds[0];
    const object = objectId ? findDocumentObject(currentDocument, objectId) : undefined;
    if (object?.type !== "molecule" || !isNativeMoleculeGraph(object) || object.atoms.length < 2) {
      setStatus("3D cleanup needs an editable native molecule");
      return;
    }

    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    setStatus("3D cleanup requires the conformer-backed cleanup engine");
  }, [assignHoveredNativeDeleteTarget, selectedNativeMoleculePart]);

  const selectAllCanvasObjects = useCallback(() => {
    const currentDocument = documentRef.current;
    const page = currentDocument.pages[0];
    if (!page || page.objects.length === 0) {
      setStatus("No canvas objects to select");
      return;
    }

    const pageId = page.id;
    const changed = replacePresentDocument((current) => selectAllDocumentObjects(current, pageId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setObjectContextMenu(undefined);
    toolBeforeTextPlacementRef.current = undefined;
    const selectToolState = createActiveToolState("tool.select");
    activeToolCommandIdRef.current = selectToolState.activeCommandId;
    setActiveToolState(selectToolState);
    setStatus(changed
      ? page.objects.length === 1 ? "Selected 1 canvas object" : `Selected ${page.objects.length} canvas objects`
      : "All canvas objects already selected");
  }, [assignHoveredNativeDeleteTarget, replacePresentDocument]);

  const startAtomLabelEdit = useCallback((target: NativeMoleculeDeleteTarget, options: AtomLabelEditOptions = {}): boolean => {
    if (target.kind !== "atom") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, target.objectId);
    if (object?.type !== "molecule") {
      return false;
    }

    const atom = object.atoms.find((candidate) => candidate.id === target.atomId);
    if (!atom) {
      return false;
    }

    replacePresentDocument((current) => selectDocumentObject(current, target.objectId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit({
      objectId: target.objectId,
      atomId: target.atomId,
      initialElement: atom.element,
      draft: options.clearDraft ? "" : atom.element
    });
    setSelectedNativeMoleculePart({ objectId: target.objectId, kind: "atom", atomId: target.atomId });
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Editing atom label");
    return true;
  }, [replacePresentDocument]);

  const updateAtomLabelDraft = useCallback((state: AtomLabelEditState, draft: string) => {
    setActiveAtomLabelEdit((current) =>
      current && current.objectId === state.objectId && current.atomId === state.atomId
        ? { ...current, draft }
        : current
    );

    if (draft.trim().length === 0) {
      return;
    }

    replacePresentDocument((current) =>
      applyNativeAtomElementTarget(current, {
        objectId: state.objectId,
        kind: "atom",
        atomId: state.atomId,
        distanceToPointer: 0
      }, draft)
    );
  }, [replacePresentDocument]);

  const cancelAtomLabelEdit = useCallback((state: AtomLabelEditState) => {
    replacePresentDocument((current) =>
      applyNativeAtomElementTarget(current, {
        objectId: state.objectId,
        kind: "atom",
        atomId: state.atomId,
        distanceToPointer: 0
      }, state.initialElement)
    );
    setActiveAtomLabelEdit(undefined);
    setStatus("Atom label unchanged");
  }, [replacePresentDocument]);

  const pastePointForViewport = useCallback((): ClientPoint => {
    const canvas = canvasRegionRef.current;
    const page = pageRef.current;
    if (!canvas || !page) {
      return {
        x: activePage.margin.left + 24,
        y: activePage.margin.top + 24
      };
    }

    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const clientPoint = {
      x: canvasRect.left + canvas.clientWidth / 2,
      y: canvasRect.top + canvas.clientHeight / 2
    };

    return {
      x: clamp((clientPoint.x - pageRect.left) / viewportRef.current.scale, 0, activePage.width),
      y: clamp((clientPoint.y - pageRect.top) / viewportRef.current.scale, 0, activePage.height)
    };
  }, [activePage.height, activePage.margin.left, activePage.margin.top, activePage.width]);

  const clearScheduledTextEditorFocus = useCallback(() => {
    textEditorFocusTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    textEditorFocusTimeoutsRef.current = [];
  }, []);

  const focusTextObjectEditor = useCallback((objectId: string) => {
    clearScheduledTextEditorFocus();

    const focusEditor = () => {
      const editor = pageRef.current?.querySelector<HTMLTextAreaElement>(
        `[data-object-id="${objectId}"] .text-object-editor`
      );
      if (!editor) {
        return;
      }

      window.focus();
      editor.focus({ preventScroll: true });
      if (editor.value === "Text") {
        editor.select();
      }
    };

    const focusNativeSurfaceAndEditor = () => {
      void focusCurrentWindowAndWebview().finally(focusEditor);
      focusEditor();
    };

    focusNativeSurfaceAndEditor();
    textEditorFocusTimeoutsRef.current = [0, 16, 80].map((delay) =>
      window.setTimeout(focusNativeSurfaceAndEditor, delay)
    );
  }, [clearScheduledTextEditorFocus]);

  const recordTextSelection = useCallback((objectId: string, range: NativeTextSelectionRange) => {
    const nextSelection = { objectId, range };
    activeTextSelectionRef.current = nextSelection;
    setActiveTextSelection((current) =>
      current?.objectId === objectId &&
      current.range.start === range.start &&
      current.range.end === range.end
        ? current
        : nextSelection
    );
  }, []);

  useEffect(() => () => {
    clearScheduledTextEditorFocus();
  }, [clearScheduledTextEditorFocus]);

  const restoreToolAfterTextPlacement = useCallback(() => {
    const previousToolState = toolBeforeTextPlacementRef.current;
    toolBeforeTextPlacementRef.current = undefined;
    if (!previousToolState || previousToolState.activeCommandId === "tool.text") {
      return;
    }

    activeToolCommandIdRef.current = previousToolState.activeCommandId;
    setActiveToolState(previousToolState);
    void broadcastToolsetActiveTool(previousToolState.activeCommandId).catch(() => undefined);
  }, []);

  const applyTextDocumentAtPoint = useCallback((point: ClientPoint) => {
    const currentDocument = documentRef.current;
    const nextDocument = insertNativeTextObject(currentDocument, point, "Text", textStyleDefaults);
    const inserted = getSelectedTextObject(nextDocument);
    commitDocumentChange(nextDocument);
    restoreToolAfterTextPlacement();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(inserted?.id);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    if (inserted) {
      focusTextObjectEditor(inserted.id);
    }
    setStatus("Inserted text - type to replace placeholder");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, focusTextObjectEditor, restoreToolAfterTextPlacement, textStyleDefaults]);

  const applyNativeArtDocumentAtPoint = useCallback((point: ClientPoint, commandId: string) => {
    const currentDocument = documentRef.current;
    const nextDocument = insertNativeArtGraphicObject(currentDocument, point, commandId);
    if (nextDocument === currentDocument) {
      setStatus("Art tool unavailable");
      return;
    }

    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    const selectToolState = createActiveToolState("tool.select");
    activeToolCommandIdRef.current = selectToolState.activeCommandId;
    setActiveToolState(selectToolState);
    void broadcastToolsetActiveTool(selectToolState.activeCommandId).catch(() => undefined);
    setStatus("Inserted art object");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const applyDetectedClipboardPayload = useCallback((detectedPayload: ReturnType<typeof inspectClipboardPayload>) => {
    const result = applyClipboardPastePayload(
      documentRef.current,
      detectedPayload,
      pastePointForViewport(),
      textStyleDefaults
    );

    if (result.document !== documentRef.current) {
      commitDocumentChange(result.document);
    }

    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(result.editTextObjectId);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus(result.status);
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, pastePointForViewport, textStyleDefaults]);

  const pasteClipboard = useCallback(async () => {
    const rawPayload = await readClipboardPayload();
    applyDetectedClipboardPayload(inspectClipboardPayload(rawPayload));
  }, [applyDetectedClipboardPayload]);

  const updateTextObjectContent = useCallback((objectId: string, text: string) => {
    replacePresentDocument((current) => updateNativeTextObjectText(current, objectId, text));
  }, [replacePresentDocument]);

  const startTextObjectEdit = useCallback((objectId: string) => {
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object?.type !== "text") {
      return;
    }

    replacePresentDocument((current) => selectDocumentObject(current, objectId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(objectId);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    focusTextObjectEditor(objectId);
    setStatus("Editing text");
  }, [assignHoveredNativeDeleteTarget, focusTextObjectEditor, replacePresentDocument]);

  const applyTextStyleCommand = useCallback((commandId: string): boolean => {
    const currentDocument = documentRef.current;
    const toolbarStyleTarget = toolbarStyleTargetRef.current;
    const snapshotTextSelection = toolbarStyleTarget?.textRange;
    const activeTextObject = activeTextEditObjectId
      ? findDocumentObject(currentDocument, activeTextEditObjectId)
      : undefined;
    const selectedTextObject = getSelectedTextObject(currentDocument) ?? (
      activeTextObject?.type === "text" ? activeTextObject : undefined
    );
    const snapshotTextObject = !selectedTextObject && snapshotTextSelection
      ? findDocumentObject(currentDocument, snapshotTextSelection.objectId)
      : undefined;
    const selected = selectedTextObject ?? (
      snapshotTextObject?.type === "text" ? snapshotTextObject : undefined
    );
    const selectedTextRange = selected && (
      activeTextEditObjectId === selected.id &&
      activeTextSelectionRef.current?.objectId === selected.id
      ? activeTextSelectionRef.current.range
      : snapshotTextSelection?.objectId === selected.id
        ? snapshotTextSelection.range
        : undefined
    );
    const hasSelectedTextRange = Boolean(
      selectedTextRange && selectedTextRange.start !== selectedTextRange.end
    );
    const textScript = textScriptForCommand(commandId);
    if (textScript) {
      if (selected) {
        const currentScript = hasSelectedTextRange && selectedTextRange
          ? textScriptForTextRange(selected, selectedTextRange)
          : textScriptForTextObject(selected);
        const nextScript = textScript === "normal" || currentScript !== textScript ? textScript : "normal";
        const changed = commitDocumentChange(hasSelectedTextRange && selectedTextRange
          ? updateNativeTextObjectScriptRange(currentDocument, selected.id, selectedTextRange, nextScript)
          : updateNativeTextObjectScript(currentDocument, selected.id, nextScript));
        setActiveTextEditObjectId((current) => current === selected.id ? current : undefined);
        setActiveEditorObjectId(undefined);
        setStatus(changed ? "Updated selected text script" : "Selected text script unchanged");
        return true;
      }

      setStatus("Select text before changing baseline script");
      return true;
    }

    const currentStyle = selected
      ? nativeTextStyleFromObjectStyle(selected.style)
      : textStyleDefaults;
    const stylePatch = textStylePatchForCommand(commandId, currentStyle);

    if (!stylePatch) {
      return false;
    }

    setTextStyleDefaults((current) => nativeTextStyleFromObjectStyle({
      ...current,
      ...stylePatch
    }));

    if (stylePatch.color) {
      const selectedColor = stylePatch.color;
      const liveColorSelection: ToolbarColorSelection = {
        objectIds: [
          ...currentDocument.selection.objectIds,
          ...(activeTextEditObjectId ? [activeTextEditObjectId] : [])
        ],
        moleculePart: selectedNativeMoleculePart,
        textRange: hasSelectedTextRange && selected && selectedTextRange
          ? { objectId: selected.id, range: selectedTextRange }
          : undefined
      };
      const colorSelection = resolveToolbarColorSelection(currentDocument, liveColorSelection, toolbarStyleTarget);
      const colorResult = applyToolbarColorToSelection(currentDocument, selectedColor, colorSelection);

      if (colorResult.targetedSelection) {
        const changed = commitDocumentChange(colorResult.document);
        setActiveTextEditObjectId((current) => selected && current === selected.id ? current : undefined);
        setActiveEditorObjectId(undefined);
        setStatus(changed ? "Updated selected color" : "Selected color unchanged");
        return true;
      }

      setStatus("Updated text defaults");
      return true;
    }

    if (selected) {
      const changed = commitDocumentChange(hasSelectedTextRange && selectedTextRange
        ? updateNativeTextObjectStyleRange(currentDocument, selected.id, selectedTextRange, stylePatch as Record<string, unknown>)
        : updateNativeTextObjectStyle(currentDocument, selected.id, stylePatch));
      setActiveTextEditObjectId((current) => current === selected.id ? current : undefined);
      setActiveEditorObjectId(undefined);
      setStatus(changed ? "Updated selected text style" : "Selected text style unchanged");
      return true;
    }

    setStatus("Updated text defaults");
    return true;
  }, [activeTextEditObjectId, commitDocumentChange, selectedNativeMoleculePart, textStyleDefaults]);

  const applyObjectStyleCommandToDocument = useCallback((
    currentDocument: ChemDraftDocument,
    commandId: string,
    target: GraphicStylePaintTarget
  ): { document: ChemDraftDocument; handled: boolean; targeted: boolean; message: string } => {
    const targetCommand = objectStyleTargetCommands.find((command) => command.id === commandId);
    if (targetCommand) {
      return { document: currentDocument, handled: true, targeted: true, message: `Targeting ${targetCommand.target}` };
    }

    const graphicObjectIds = selectedGraphicObjectIds(currentDocument);

    const noneCommand = objectStyleNoneCommands.find((command) => command.id === commandId);
    if (noneCommand) {
      return {
        document: applyGraphicObjectNoneToSelection(currentDocument, noneCommand.target, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: noneCommand.target === "fill" ? "Removed selected graphic fill" : "Removed selected graphic stroke"
      };
    }

    if (commandId === objectStyleSwapCommand.id) {
      return {
        document: swapGraphicObjectFillAndStroke(currentDocument, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Swapped selected graphic fill and stroke"
      };
    }

    const opacity = objectOpacityForCommand(commandId);
    if (opacity) {
      return {
        document: applyGraphicObjectOpacityToSelection(currentDocument, opacity.key, opacity.value, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic opacity"
      };
    }

    const strokeWidth = objectStrokeWidthCommands.find((command) => command.id === commandId);
    if (strokeWidth) {
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, { strokeWidth: strokeWidth.strokeWidth }, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic stroke width"
      };
    }

    const strokeDash = objectStrokeDashCommands.find((command) => command.id === commandId);
    if (strokeDash) {
      const strokeStyle = {
        strokeDasharray: strokeDash.strokeDasharray,
        ...("strokeLineCap" in strokeDash && strokeDash.strokeLineCap ? { strokeLineCap: strokeDash.strokeLineCap } : {})
      };
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, strokeStyle, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic dash"
      };
    }

    const strokeCap = objectStrokeLineCapCommands.find((command) => command.id === commandId);
    if (strokeCap) {
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, { strokeLineCap: strokeCap.strokeLineCap }, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic cap"
      };
    }

    const strokeJoin = objectStrokeLineJoinCommands.find((command) => command.id === commandId);
    if (strokeJoin) {
      return {
        document: applyGraphicObjectStrokeStyleToSelection(currentDocument, { strokeLineJoin: strokeJoin.strokeLineJoin }, graphicObjectIds),
        handled: true,
        targeted: graphicObjectIds.length > 0,
        message: "Updated selected graphic join"
      };
    }

    const selectedColor = objectColorForCommand(commandId);
    if (!selectedColor) {
      return { document: currentDocument, handled: false, targeted: false, message: "" };
    }

    if (graphicObjectIds.length > 0) {
      return {
        document: applyGraphicObjectColorToSelection(currentDocument, target, selectedColor, graphicObjectIds),
        handled: true,
        targeted: true,
        message: target === "fill" ? "Updated selected graphic fill" : "Updated selected graphic stroke"
      };
    }

    const toolbarStyleTarget = toolbarStyleTargetRef.current;
    const objectStyleObjectIds = currentDocument.selection.objectIds.filter((objectId) =>
      findDocumentObject(currentDocument, objectId)?.type !== "text"
    );
    const objectStyleTarget = toolbarStyleTarget
      ? {
          objectIds: toolbarStyleTarget.objectIds.filter((objectId) =>
            findDocumentObject(currentDocument, objectId)?.type !== "text"
          ),
          moleculePart: toolbarStyleTarget.moleculePart
        }
      : undefined;
    const liveColorSelection: ToolbarColorSelection = {
      objectIds: objectStyleObjectIds,
      moleculePart: selectedNativeMoleculePart
    };
    const colorSelection = resolveToolbarColorSelection(currentDocument, liveColorSelection, objectStyleTarget);
    const colorResult = applyToolbarColorToSelection(currentDocument, selectedColor, colorSelection);
    return {
      document: colorResult.document,
      handled: true,
      targeted: colorResult.targetedSelection,
      message: colorResult.changed ? "Updated selected object color" : "Selected object color unchanged"
    };
  }, [selectedNativeMoleculePart]);

  const applyObjectStyleCommand = useCallback((commandId: string): boolean => {
    const targetCommand = objectStyleTargetCommands.find((command) => command.id === commandId);
    if (targetCommand) {
      if (targetCommand.target === "fill" && currentArtStyle && !currentArtStyle.supportsFillAny && currentArtStyle.supportsStrokeAny) {
        setActiveArtPaintTarget("stroke");
        setStatus("Selected graphic uses stroke only");
        return true;
      }
      if (targetCommand.target === "stroke" && currentArtStyle && !currentArtStyle.supportsStrokeAny && currentArtStyle.supportsFillAny) {
        setActiveArtPaintTarget("fill");
        setStatus("Selected graphic uses fill only");
        return true;
      }
      setActiveArtPaintTarget(targetCommand.target);
      setStatus(targetCommand.target === "fill" ? "Targeting graphic fill" : "Targeting graphic stroke");
      return true;
    }

    const result = applyObjectStyleCommandToDocument(documentRef.current, commandId, activeArtPaintTarget);
    if (!result.handled) {
      return false;
    }

    if (!result.targeted) {
      setStatus("Select a graphic before changing object style");
      return true;
    }

    const changed = commitDocumentChange(result.document);
    setActiveEditorObjectId(undefined);
    setStatus(changed ? result.message : "Selected object style unchanged");
    return true;
  }, [activeArtPaintTarget, applyObjectStyleCommandToDocument, commitDocumentChange, currentArtStyle]);

  const previewObjectStyleCommand = useCallback((commandId: string) => {
    const session = artStylePreviewRef.current ?? { startDocument: documentRef.current };
    artStylePreviewRef.current = session;
    const result = applyObjectStyleCommandToDocument(session.startDocument, commandId, activeArtPaintTarget);
    if (!result.handled || !result.targeted) {
      return;
    }

    replacePresentDocument(result.document);
  }, [activeArtPaintTarget, applyObjectStyleCommandToDocument, replacePresentDocument]);

  const commitObjectStylePreview = useCallback((commandId: string) => {
    const session = artStylePreviewRef.current;
    if (!session) {
      applyObjectStyleCommand(commandId);
      return;
    }

    const result = applyObjectStyleCommandToDocument(session.startDocument, commandId, activeArtPaintTarget);
    artStylePreviewRef.current = null;
    replacePresentDocument(session.startDocument);
    if (!result.handled || !result.targeted) {
      setStatus("Select a graphic before changing object style");
      return;
    }

    const changed = commitDocumentChange(result.document);
    setActiveEditorObjectId(undefined);
    setStatus(changed ? result.message : "Selected object style unchanged");
  }, [activeArtPaintTarget, applyObjectStyleCommand, applyObjectStyleCommandToDocument, commitDocumentChange, replacePresentDocument]);

  const cancelObjectStylePreview = useCallback(() => {
    const session = artStylePreviewRef.current;
    if (!session) {
      return;
    }

    artStylePreviewRef.current = null;
    replacePresentDocument(session.startDocument);
    setStatus("Canceled graphic style edit");
  }, [replacePresentDocument]);

  const restoreDocumentHistory = useCallback((direction: "undo" | "redo") => {
    const currentHistory = documentHistoryRef.current;
    const nextHistory = direction === "undo"
      ? undoDocumentHistory(currentHistory)
      : redoDocumentHistory(currentHistory);
    if (nextHistory === currentHistory) {
      setStatus(direction === "undo" ? "Nothing to undo" : "Nothing to redo");
      return;
    }

    installDocumentHistory(nextHistory);
    setFileState((current) => {
      const nextFileState = { ...current, dirty: true };
      fileStateRef.current = nextFileState;
      return nextFileState;
    });
    if (nextHistory.present.selection.objectIds.length === 0) {
      toolbarStyleTargetRef.current = undefined;
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setLastAnalysis(null);
    setStatus(direction === "undo" ? "Undid last document change" : "Redid document change");
  }, [assignHoveredNativeDeleteTarget, installDocumentHistory]);

  const clearDocumentInteractionState = useCallback(() => {
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveTextSelection(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setLastAnalysis(null);
  }, [assignHoveredNativeDeleteTarget]);

  const openDocumentContents = useCallback((
    contents: string,
    displayName: string,
    path?: string
  ) => {
    const opened = openNativeDocument(contents);
    const resolvedOpen = resolveOpenResultDocument(opened);
    if (!resolvedOpen) {
      throw new Error(formatOpenFailure(opened.warnings));
    }
    const fitRecommendation = resolvedOpen.source === "external-cdxml"
      ? recommendImportedPageFit(resolvedOpen.document)
      : undefined;
    resetDocumentHistory(resolvedOpen.document, {
      path,
      dirty: false,
      lastSavedPayloadHash: sha256Utf8Hex(contents)
    });
    clearDocumentInteractionState();
    setPageFitPrompt(fitRecommendation ? { ...fitRecommendation, displayName } : undefined);
    const openStatus = formatOpenStatus(displayName, resolvedOpen.source, opened.warnings, resolvedOpen.statusSourceLabel);
    setStatus(fitRecommendation
      ? `${openStatus}; imported content exceeds ${pageFitPromptLayoutLabel(fitRecommendation.currentPageTitle, fitRecommendation.currentOrientation)}`
      : openStatus);
  }, [clearDocumentInteractionState, resetDocumentHistory]);

  const acceptPageFitRecommendation = useCallback(() => {
    if (!pageFitPrompt) {
      return;
    }

    const changed = commitDocumentChange((current) => applyImportedPageFitRecommendation(current, pageFitPrompt));
    setPageFitPrompt(undefined);
    setStatus(changed
      ? `Page changed to ${pageFitPromptLayoutLabel(pageFitPrompt.recommendedPageTitle, pageFitPrompt.recommendedOrientation)}`
      : "Page already fits imported content");
  }, [commitDocumentChange, pageFitPrompt]);

  const keepImportedPageOverflow = useCallback(() => {
    if (!pageFitPrompt) {
      return;
    }

    setPageFitPrompt(undefined);
    setStatus(`Kept ${pageFitPromptLayoutLabel(pageFitPrompt.currentPageTitle, pageFitPrompt.currentOrientation)}; imported content may extend beyond the page`);
  }, [pageFitPrompt]);

  const openDocumentFromNativePicker = useCallback(async () => {
    if (!isDesktopRuntime()) {
      fileInputRef.current?.click();
      return;
    }

    const path = await pickNativeOpenPath();
    if (!path) {
      setStatus("Open canceled");
      return;
    }

    try {
      const contents = await readNativeTextFile(path);
      openDocumentContents(contents, nativePathBasename(path), path);
    } catch (error) {
      setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [openDocumentContents]);

  useEffect(() => {
    if (!shouldEnableAgentBridge()) {
      return undefined;
    }

    const bridge: ChemDraftAgentBridge = {
      openDocument: ({ contents, displayName = "Agent document", path }) => {
        try {
          openDocumentContents(contents, displayName, path);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      snapshot: () => {
        const currentDocument = documentRef.current;
        return {
          status: statusRef.current,
          fileState: fileStateRef.current,
          pageCount: currentDocument.pages.length,
          pages: currentDocument.pages.map((page) => ({
            id: page.id,
            width: page.width,
            height: page.height,
            objectCount: page.objects.length,
            objectTypes: page.objects.reduce<Partial<Record<DocumentObject["type"], number>>>((counts, object) => {
              counts[object.type] = (counts[object.type] ?? 0) + 1;
              return counts;
            }, {}),
            crossingCount: page.crossings.length
          })),
          compatibilityWarnings: currentDocument.compatibility?.warnings.length ?? 0
        };
      },
      debugArtObject: (objectId) => {
        const currentDocument = documentRef.current;
        const object = findDocumentObject(currentDocument, objectId);
        if (object?.type !== "graphic") {
          return { ok: false, error: `Graphic object not found: ${objectId}` };
        }
        const editPoints = nativeGraphicPathEditPoints(object);
        const projectedEditPoints = editPoints
          ? {
              pathKind: editPoints.pathKind,
              start: projectGraphicObjectPoint(object, editPoints.start),
              middle: projectGraphicObjectPoint(object, editPoints.middle),
              end: projectGraphicObjectPoint(object, editPoints.end)
            }
          : undefined;
        const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
        return {
          ok: true,
          object,
          editPoints,
          projectedEditPoints,
          plan: {
            pathD: plan.pathD,
            frameBounds: plan.frameBounds,
            markerHandles: plan.markerHandles,
            projectionTransform: plan.projectionTransform,
            width: plan.width,
            height: plan.height
          }
        };
      },
      waitForIdle: async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
    };

    window.__CHEMDRAFT_AGENT__ = bridge;
    window.dispatchEvent(new CustomEvent("chemdraft-agent-ready"));
    return () => {
      if (window.__CHEMDRAFT_AGENT__ === bridge) {
        delete window.__CHEMDRAFT_AGENT__;
      }
    };
  }, [openDocumentContents]);

  useEffect(() => {
    if (!shouldEnableAgentBridge()) {
      return undefined;
    }

    const openPayloadFromHash = () => {
      const payload = agentBridgeDocumentPayloadFromHash();
      if (!payload) {
        return;
      }

      try {
        openDocumentContents(payload.contents, payload.displayName, payload.path);
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      } catch (error) {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    openPayloadFromHash();
    window.addEventListener("hashchange", openPayloadFromHash);
    return () => window.removeEventListener("hashchange", openPayloadFromHash);
  }, [openDocumentContents]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return undefined;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    const openNativePayload = (payload: NativeOpenDocumentPayload) => {
      const payloadKey = `${payload.path}\n${sha256Utf8Hex(payload.contents)}`;
      const now = Date.now();
      const last = lastNativeOpenPayloadKeyRef.current;
      // A single OS open is delivered via both the Tauri event and the pending-document
      // poll, so coalesce identical payloads that arrive close together. Use a time window
      // rather than a permanent key so re-opening the same file later (e.g. to discard
      // in-app edits) still works.
      if (last && last.key === payloadKey && now - last.at < NATIVE_OPEN_DEDUPE_WINDOW_MS) {
        return;
      }
      lastNativeOpenPayloadKeyRef.current = { key: payloadKey, at: now };
      try {
        openDocumentContents(payload.contents, payload.displayName, payload.path);
      } catch (error) {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    void listenForNativeOpenDocuments((payload) => {
      if (!disposed) {
        openNativePayload(payload);
      }
    })
      .then((cleanup) => {
        // The dynamic import may resolve after the effect was torn down; unsubscribe
        // immediately in that case instead of leaking the listener.
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => undefined);
    void takePendingNativeOpenDocument()
      .then((payload) => {
        if (!disposed && payload) {
          openNativePayload(payload);
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openDocumentContents]);

  const saveCurrentDocument = useCallback(async (forceSaveAs: boolean) => {
    const payload = createNativeSavePayload(documentRef.current);

    if (!isDesktopRuntime()) {
      downloadText(payload.filename, payload.contents, payload.mimeType);
      setFileState((current) => {
        const nextFileState = {
          ...current,
          dirty: false,
          lastSavedPayloadHash: payload.payloadHash
        };
        fileStateRef.current = nextFileState;
        return nextFileState;
      });
      setStatus(formatSaveStatus(payload.filename, payload.warnings));
      return;
    }

    let path = forceSaveAs ? undefined : fileStateRef.current.path;
    if (!path) {
      path = await pickNativeSavePath(fileStateRef.current.path ?? payload.filename);
    }
    if (!path) {
      setStatus("Save canceled");
      return;
    }

    const finalPath = ensureChemDraftFileExtension(path);
    try {
      await writeNativeTextFile(finalPath, payload.contents);
      const nextFileState = {
        path: finalPath,
        dirty: false,
        lastSavedPayloadHash: payload.payloadHash
      };
      fileStateRef.current = nextFileState;
      setFileState(nextFileState);
      setStatus(formatSaveStatus(nativePathBasename(finalPath), payload.warnings));
    } catch (error) {
      setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const openExportDialog = useCallback(() => {
    setExportDialog(createDefaultExportDialogState(documentRef.current));
    setStatus("Export ready");
  }, []);

  const chooseExportDestination = useCallback(async () => {
    if (!exportDialog || exportDialog.busy) {
      return;
    }

    const descriptor = getExportFormatDescriptor(exportDialog.format);
    if (descriptor.status !== "implemented") {
      setStatus(`${descriptor.menuLabel} export is not available yet`);
      return;
    }

    if (!isDesktopRuntime()) {
      setStatus("Browser export will download the file");
      return;
    }

    try {
      const path = await pickNativeExportPath(
        exportDialog.destinationPath ?? exportDialog.filename,
        descriptor.menuLabel,
        descriptor.extensions
      );
      if (!path) {
        setStatus("Export location unchanged");
        return;
      }

      setExportDialog((current) => current
        ? {
            ...current,
            destinationPath: path,
            filename: nativePathBasename(path)
          }
        : current);
      setStatus(`Export location: ${nativePathBasename(path)}`);
    } catch (error) {
      setStatus(`Export location failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [exportDialog]);

  const submitExportDialog = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!exportDialog || exportDialog.busy) {
      return;
    }

    const dialog = exportDialog;
    const descriptor = getExportFormatDescriptor(dialog.format);
    setExportDialog({ ...dialog, busy: true });

    try {
      if (descriptor.status !== "implemented") {
        setStatus(`${descriptor.menuLabel} export is not available yet`);
        setExportDialog((current) => current ? { ...current, busy: false } : current);
        return;
      }

      const result = await createDialogExportResult(documentRef.current, dialog);
      const filename = ensureExportFileExtension(dialog.filename, descriptor.extensions);

      if (!isDesktopRuntime()) {
        downloadExportResult(filename, result);
        setStatus(formatExportStatus(descriptor.menuLabel, result.warnings.length));
        setExportDialog(undefined);
        return;
      }

      const path = dialog.destinationPath
        ? ensureExportFileExtension(dialog.destinationPath, descriptor.extensions)
        : await pickNativeExportPath(filename, descriptor.menuLabel, descriptor.extensions);

      if (!path) {
        setStatus(`${descriptor.menuLabel} export canceled`);
        setExportDialog((current) => current ? { ...current, busy: false } : current);
        return;
      }

      await writeNativeExportResult(path, result);
      setStatus(formatExportStatus(descriptor.menuLabel, result.warnings.length));
      setExportDialog(undefined);
    } catch (error) {
      setStatus(`${descriptor.menuLabel} export failed: ${error instanceof Error ? error.message : String(error)}`);
      setExportDialog((current) => current ? { ...current, busy: false } : current);
    }
  }, [exportDialog]);

  const cancelExportDialog = useCallback(() => {
    if (!exportDialog?.busy) {
      setExportDialog(undefined);
      setStatus("Export canceled");
    }
  }, [exportDialog]);

  const registry = useMemo(() => {
    const commandRegistry = new CommandRegistry();
    const register = (definition: CommandSpec, handler?: () => void | Promise<void>) => {
      commandRegistry.register(definition, async () => {
        await handler?.();
        return { ok: definition.enabled !== false, commandId: definition.id };
      });
    };

    quickActions.forEach((action) => {
      register(action, async () => {
        if (action.id === "document.new") {
          resetDocumentHistory(createPhase4Document());
          setActiveEditorObjectId(undefined);
          setActiveTextEditObjectId(undefined);
          setActiveAtomLabelEdit(undefined);
          setHoveredNativeAtom(undefined);
          assignHoveredNativeDeleteTarget(undefined);
          setFreeformNativeBond(undefined);
          setPageFitPrompt(undefined);
          setLastAnalysis(null);
          setStatus("Blank native document");
        }
        if (action.id === "edit.undo") {
          restoreDocumentHistory("undo");
        }
        if (action.id === "edit.redo") {
          restoreDocumentHistory("redo");
        }
        if (action.id === "edit.selectAll") {
          selectAllCanvasObjects();
        }
        if (action.id === "document.open") {
          await openDocumentFromNativePicker();
        }
        if (action.id === "document.save") {
          await saveCurrentDocument(false);
        }
        if (action.id === "document.saveAs") {
          await saveCurrentDocument(true);
        }
        if (action.id === "clipboard.paste") {
          await pasteClipboard();
        }
        if (action.id === "view.zoomOut") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale / VIEW_ZOOM_COMMAND_FACTOR, pageCenterPoint(current, activePage)));
        }
        if (action.id === "view.zoomIn") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale * VIEW_ZOOM_COMMAND_FACTOR, pageCenterPoint(current, activePage)));
        }
        if (action.id === "view.toggleToolPalette") {
          await toggleToolset(DEFAULT_TOOLSET_ID);
          setStatus("Toggled main toolbar");
        }
        if (action.id === "export.open") {
          openExportDialog();
        }
        if (action.id === "chemistry.validateSelection") {
          const molecule = getSelectedMolecule(document);
          if (!molecule) {
            setStatus("No selected structure");
            return;
          }

          const analysis = await chemistryAdapter.analyzeStructure({
            format: molecule.structureFormat === "smiles" ? "smiles" : "unknown",
            value: molecule.structure
          });
          setLastAnalysis(analysis);

          if (analysis.validation.valid) {
            const analyzed = applyAnalysisToSelectedMolecule(document, analysis);
            commitDocumentChange(analyzed);
            setStatus(formatAnalysisStatus(analysis));
            return;
          }

          setStatus(formatValidationFailure(analysis));
        }
      });
    });

    editActions.forEach((action) => {
      register(action, () => {
        if (action.id === "atom.addSingleBondToHoveredAtom") {
          addSingleBondToHoveredNativeAtom();
          return;
        }

        if (action.id === "bond.setHoveredBondOrder.single") {
          setHoveredNativeBondOrder("single");
          return;
        }

        if (action.id === "bond.setHoveredBondOrder.double") {
          setHoveredNativeBondOrder("double");
          return;
        }

        if (action.id === "bond.setHoveredBondOrder.triple") {
          setHoveredNativeBondOrder("triple");
          return;
        }

        if (action.id === "atom.addCarbonylToHoveredAtom") {
          addCarbonylToHoveredNativeAtom();
          return;
        }

        if (action.id === "atom.addPositiveChargeToHoveredAtom") {
          addChargeToHoveredNativeAtom(1);
          return;
        }

        if (action.id === "atom.addNegativeChargeToHoveredAtom") {
          addChargeToHoveredNativeAtom(-1);
          return;
        }

        deleteHoveredNativeTarget();
      });
    });

    layerActions.forEach((action) => {
      register(action, () => {
        const placement = action.id === "layout.bringToFront"
          ? "front"
          : action.id === "layout.bringForward"
            ? "forward"
            : action.id === "layout.sendToBack"
              ? "back"
              : "backward";
        const changed = commitDocumentChange((current) =>
          reorderSelectedDocumentObjectWithCrossingDefaults(current, placement)
        );
        setStatus(changed ? action.title : "No selected object");
      });
    });

    atomElementActions.forEach((action) => {
      register(action, () => {
        const element = action.id.replace("atom.setHoveredElement.", "");
        const parsed = nativeElementFromKeyboardKey(element);
        if (parsed) {
          setHoveredNativeAtomElement(parsed);
        }
      });
    });

    toolCommandSpecs.forEach((tool) => {
      if (isLayerCommandId(tool.id)) {
        return;
      }

      register(tool, () => {
        if (isDisabledPlaceholderCommand(tool)) {
          setStatus(tool.disabledReason ?? "Tool unavailable");
          return;
        }
        if (tool.id === "plugin.fixture.toolset.ping") {
          setStatus("Fixture plugin toolset command routed");
          return;
        }

        if (tool.id === structureCleanupCommandId) {
          cleanUpSelectedStructure();
          return;
        }

        if (tool.id === structureCleanup3dCommandId) {
          cleanUpSelectedStructure3d();
          return;
        }

        if (applyTextStyleCommand(tool.id)) {
          return;
        }

        if (!isDrawingToolCommand(tool.id)) {
          setStatus(`${tool.title} command routed`);
          return;
        }

        if (tool.id === "tool.text") {
          toolBeforeTextPlacementRef.current =
            activeToolState.activeCommandId === "tool.text" ? undefined : activeToolState;
        } else {
          toolBeforeTextPlacementRef.current = undefined;
        }

        const result = activateDrawingToolCommand(activeToolState, tool);
        setActiveToolState(result.state);
        if (result.outcome === "activated") {
          setActiveTextEditObjectId(undefined);
          setActiveAtomLabelEdit(undefined);
        }
        setStatus(result.status);
      });
    });

    textToolbarActions.forEach((action) => {
      register(action, () => {
        if (!applyTextStyleCommand(action.id)) {
          setStatus(`${action.title} unavailable`);
        }
      });
    });

    objectStyleActions.forEach((action) => {
      register(action, () => {
        if (!applyObjectStyleCommand(action.id)) {
          setStatus(`${action.title} unavailable`);
        }
      });
    });

    getToolsetToggleActions(toolsetRegistry).forEach((action) => {
      register(action, async () => {
        const toolsetId = parseToolsetToggleCommandId(action.id);
        if (!toolsetId) {
          return;
        }

        await toggleToolset(toolsetId);
      });
    });

    viewActions.forEach((action) => {
      register(action, () => {
        if (action.id === "view.toggleRulers") {
          setRulersVisible((visible) => !visible);
          return;
        }

        if (action.id === "view.toggleCrosshairs") {
          setCrosshairsVisible((visible) => !visible);
        }
      });
    });

    pageSizeActions.forEach((action) => {
      register(action, () => {
        const presetId = action.id.replace("page.setSize.", "");
        commitDocumentChange((current) => setDocumentPageSize(current, presetId as Parameters<typeof setDocumentPageSize>[1]));
        setStatus(action.title.replace("Set Page Size: ", "Page size: "));
      });
    });

    pageOrientationActions.forEach((action) => {
      register(action, () => {
        const orientation = action.id.endsWith(".landscape") ? "landscape" : "portrait";
        commitDocumentChange((current) => setDocumentPageOrientation(current, orientation));
        setStatus(action.title.replace("Set Page Orientation: ", "Page orientation: "));
      });
    });

    toolbarCustomizationActions.forEach((action) => {
      register(action, () => {
        setStatus(action.disabledReason ?? "Toolbar customization UI is not implemented yet");
      });
    });

    return commandRegistry;
  }, [
    activeToolState,
    addChargeToHoveredNativeAtom,
    addCarbonylToHoveredNativeAtom,
    addSingleBondToHoveredNativeAtom,
    applyObjectStyleCommand,
    applyTextStyleCommand,
    assignHoveredNativeDeleteTarget,
    chemistryAdapter,
    cleanUpSelectedStructure3d,
    cleanUpSelectedStructure,
    commitDocumentChange,
    deleteHoveredNativeTarget,
    document,
    layerActions,
    nativePalette,
    openExportDialog,
    openDocumentFromNativePicker,
    pasteClipboard,
    quickActions,
    resetDocumentHistory,
    restoreDocumentHistory,
    saveCurrentDocument,
    selectAllCanvasObjects,
    selectedNativeMoleculePart,
    setHoveredNativeAtomElement,
    setHoveredNativeBondOrder,
    toggleToolset,
    toolCommandSpecs,
    toolsetRegistry
  ]);

  const invoke = useCallback((commandId: string) => {
    if (applyTextStyleCommand(commandId)) {
      return;
    }

    if (applyObjectStyleCommand(commandId)) {
      return;
    }

    void registry.invoke(commandId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Command failed: ${message}`);
    });
  }, [applyObjectStyleCommand, applyTextStyleCommand, registry]);

  invokeCommandRef.current = invoke;

  useEffect(() => {
    if (!activeTextEditObjectId) {
      activeTextSelectionRef.current = undefined;
      setActiveTextSelection(undefined);
      return;
    }

    focusTextObjectEditor(activeTextEditObjectId);
  }, [activeTextEditObjectId, document, focusTextObjectEditor]);

  useEffect(() => {
    const objectIds = [...document.selection.objectIds];
    const textRange = activeTextSelectionRef.current;
    if (objectIds.length === 0 && !selectedNativeMoleculePart && !textRange) {
      return;
    }

    toolbarStyleTargetRef.current = {
      objectIds,
      moleculePart: selectedNativeMoleculePart,
      textRange
    };
  }, [activeTextSelection, document.selection.objectIds, selectedNativeMoleculePart]);

  useEffect(() => {
    if (!rotationInput) {
      return;
    }

    const stillSelected =
      document.selection.objectIds.includes(rotationInput.objectId) ||
      selectedNativeMoleculePart?.objectId === rotationInput.objectId;
    if (!stillSelected) {
      updateRotationInput(undefined);
    }
  }, [document.selection.objectIds, rotationInput, selectedNativeMoleculePart, updateRotationInput]);

  useEffect(() => {
    if (!objectResizeInput) {
      return;
    }

    const stillSelected =
      document.selection.objectIds.includes(objectResizeInput.objectId) ||
      selectedNativeMoleculePart?.objectId === objectResizeInput.objectId;
    if (!stillSelected) {
      updateObjectResizeInput(undefined);
    }
  }, [document.selection.objectIds, objectResizeInput, selectedNativeMoleculePart, updateObjectResizeInput]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || shouldIgnoreShortcutTarget(event.target) || !event.clipboardData) {
        return;
      }

      const detectedPayload = inspectClipboardPayload(clipboardPayloadFromDataTransfer(event.clipboardData));
      if (detectedPayload.kind === "empty") {
        return;
      }

      event.preventDefault();
      applyDetectedClipboardPayload(detectedPayload);
    };

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [applyDetectedClipboardPayload]);

  const clearProjectedPlaneTiltDrag = useCallback((event?: { pointerId: number; currentTarget?: Element }) => {
    const drag = projectedPlaneTiltDragRef.current;
    if (!drag || (event && drag.pointerId !== event.pointerId)) {
      return;
    }

    projectedPlaneTiltDragRef.current = null;
    const page = pageRef.current;
    if (page?.hasPointerCapture(drag.pointerId)) {
      page.releasePointerCapture(drag.pointerId);
    }
    const currentTarget = event?.currentTarget;
    if (currentTarget?.hasPointerCapture(drag.pointerId)) {
      currentTarget.releasePointerCapture(drag.pointerId);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcutTarget(event.target) || event.defaultPrevented) {
        return;
      }

      if (event.key === "Escape" && graphicCornerRadiusDragRef.current) {
        const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
        event.preventDefault();
        replacePresentDocument(graphicCornerRadiusDrag.startDocument);
        graphicCornerRadiusDragRef.current = null;
        setGraphicCornerRadiusReadout(undefined);
        const page = pageRef.current;
        if (page?.hasPointerCapture(graphicCornerRadiusDrag.pointerId)) {
          page.releasePointerCapture(graphicCornerRadiusDrag.pointerId);
        }
        setStatus("Corner radius canceled");
        return;
      }

      if (event.key === "Escape" && projectedPlaneTiltDragRef.current) {
        const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
        event.preventDefault();
        projectedPlaneTiltMachineRef.current = initialInteractionState();
        replacePresentDocument(projectedPlaneTiltDrag.startDocument);
        setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
        clearProjectedPlaneTiltDrag();
        setProjectedPlaneTiltReadout(undefined);
        setStatus("3D rotate canceled");
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const hoveredTargetCommandId = activeNativeTargetShortcutCommand(
          documentRef.current,
          selectedNativeMoleculePart,
          hoveredNativeDeleteTargetRef.current,
          event.key
        );
        if (hoveredTargetCommandId) {
          event.preventDefault();
          invokeCommandRef.current(hoveredTargetCommandId);
          return;
        }
      }

      const commandId = shortcutRegistry.resolve(event);
      if (!commandId) {
        return;
      }

      event.preventDefault();
      invokeCommandRef.current(commandId);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [clearProjectedPlaneTiltDrag, replacePresentDocument, selectedNativeMoleculePart, shortcutRegistry]);

  useEffect(() => {
    if (!effectiveNativePalette) {
      return;
    }

    void listToolsetWindowStates()
      .then((states) => {
        const openToolsetIds = states
          .filter((state) => state.open && toolsetRegistry.get(state.toolsetId))
          .map((state) => state.toolsetId);
        if (openToolsetIds.length === 0) {
          setWebPaletteFallback(true);
          setVisibleToolsetIds(createDefaultVisibleToolsetIds(toolsetRegistry));
          setStatus("Native toolset windows unavailable; using in-window toolbars");
          return;
        }
        setVisibleToolsetIds(new Set(openToolsetIds));
      })
      .catch(() => {
        setWebPaletteFallback(true);
        setVisibleToolsetIds(createDefaultVisibleToolsetIds(toolsetRegistry));
        setStatus("Native toolset windows unavailable; using in-window toolbars");
      });
  }, [effectiveNativePalette, toolsetRegistry]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;
    let unlistenActiveToolRequest: (() => void) | undefined;
    let unlistenTextStyleRequest: (() => void) | undefined;
    void listenForToolsetCommands((commandId) => {
      invokeCommandRef.current(commandId);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        setStatus("Toolset command bridge unavailable");
      });
    void listenForToolsetWindowStates((state) => {
      setVisibleToolsetIds((current) => updateVisibleToolsets(current, state.toolsetId, state.open));
    })
      .then((cleanup) => {
        unlistenState = cleanup;
      })
      .catch(() => {
        setStatus("Toolset state bridge unavailable");
      });
    void listenForToolsetActiveToolRequests(() => {
      void broadcastToolsetActiveTool(activeToolCommandIdRef.current).catch(() => undefined);
    })
      .then((cleanup) => {
        unlistenActiveToolRequest = cleanup;
      })
      .catch(() => undefined);
    void listenForToolsetTextStyleRequests(() => {
      void broadcastToolsetTextStyle(currentToolbarTextStateRef.current).catch(() => undefined);
    })
      .then((cleanup) => {
        unlistenTextStyleRequest = cleanup;
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
      unlistenState?.();
      unlistenActiveToolRequest?.();
      unlistenTextStyleRequest?.();
    };
  }, []);

  const handleOpenFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    void file
      .text()
      .then((contents) => {
        openDocumentContents(contents, file.name);
      })
      .catch((error: unknown) => {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const startWebPaletteDrag = useCallback((toolsetId: string, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select, input, textarea, [data-palette-control]")) {
      return;
    }

    const position = webPalettePositions[toolsetId] ?? defaultToolsetPosition(toolsetId, toolsetRegistry);
    webPaletteDragRef.current = {
      toolsetId,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: position.x,
      startY: position.y
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [toolsetRegistry, webPalettePositions]);

  const moveWebPalette = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = webPaletteDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const maxX = Math.max(8, globalThis.innerWidth - 112);
    const maxY = Math.max(8, globalThis.innerHeight - 120);
    setWebPalettePositions((current) => ({
      ...current,
      [drag.toolsetId]: {
        x: clamp(drag.startX + event.clientX - drag.originX, 8, maxX),
        y: clamp(drag.startY + event.clientY - drag.originY, 44, maxY)
      }
    }));
  }, []);

  const stopWebPaletteDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    if (webPaletteDragRef.current?.pointerId === event.pointerId) {
      webPaletteDragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const pagePointFromClientPoint = useCallback((clientPoint: ClientPoint): ClientPoint | undefined => {
    const page = pageRef.current;
    if (!page) {
      return undefined;
    }

    const rect = page.getBoundingClientRect();
    return pagePointFromRenderedPageRect(rect, viewportRef.current.scale, clientPoint);
  }, []);

  const pagePointFromPointerEvent = useCallback((event: { clientX: number; clientY: number }): ClientPoint | undefined =>
    pagePointFromClientPoint({ x: event.clientX, y: event.clientY }), [pagePointFromClientPoint]);

  const applySingleBondDocumentAtPoint = useCallback((
    sourceDocument: ChemDraftDocument,
    point: ClientPoint,
    bondStyle?: NativeBondDisplayStyle
  ) => {
    const nextDocument = applySingleBondToolAtPoint(sourceDocument, point, { bondStyle });
    const selected = getSelectedMolecule(nextDocument);
    const atomCount = selected?.atoms.length ?? 0;
    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus(atomCount > 2
      ? `Extended carbon chain to ${atomCount} atoms`
      : `Inserted ${nativeBondToolStatusLabel(bondStyle)} molecule`);
  }, [commitDocumentChange]);

  const applyNativeTemplateDocumentAtPoint = useCallback((
    point: ClientPoint,
    templateId: NonNullable<ReturnType<typeof nativeTemplateForToolCommand>>,
    target?: NativeMoleculeDeleteTarget
  ) => {
    const nextDocument = target
      ? applyNativeTemplateToolAtTarget(documentRef.current, target, point, templateId)
      : applyNativeTemplateToolAtPoint(documentRef.current, point, templateId);
    if (nextDocument !== documentRef.current) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setTemplatePreview(undefined);
    templatePreviewKeyRef.current = undefined;
    setStatus(nativeTemplateStatusForApplication(templateId, target, nextDocument !== documentRef.current));
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const startNativePlacementDrag = useCallback((
    event: ObjectPointerEvent,
    point: ClientPoint,
    placement: { kind: "single-bond"; bondStyle?: NativeBondDisplayStyle } | { kind: "template"; templateId: NativeMoleculeTemplateId }
  ): boolean => {
    const startDocument = documentRef.current;
    const placementDocument = placement.kind === "template"
      ? applyNativeTemplateToolAtPoint(startDocument, point, placement.templateId)
      : applySingleBondToolAtPoint(startDocument, point, { bondStyle: placement.bondStyle });
    const objectId = placementDocument.selection.objectIds[0];
    if (placementDocument === startDocument || !objectId || findDocumentObject(startDocument, objectId)) {
      return false;
    }

    nativePlacementDragRef.current = {
      pointerId: event.pointerId,
      kind: placement.kind,
      startDocument,
      placementDocument,
      objectId,
      startPoint: point,
      latestPoint: point,
      bondStyle: placement.kind === "single-bond" ? placement.bondStyle : undefined,
      templateId: placement.kind === "template" ? placement.templateId : undefined,
      dragging: false
    };
    placementMachineRef.current = interactionReducer(initialInteractionState(), { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "empty" }, dragKind: "placement" });
    replacePresentDocument(placementDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setSelectedNativeMoleculePart(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    // The drag commits a live preview document, so the hover ghost would double up — drop it.
    setTemplatePreview(undefined);
    templatePreviewKeyRef.current = undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    return true;
  }, [assignHoveredNativeDeleteTarget, replacePresentDocument]);

  const applyNativeBondDisplayStyleDocumentTarget = useCallback((
    target: NativeBondOrderTarget,
    bondStyle: NativeBondDisplayStyle
  ) => {
    const nextDocument = applyNativeBondDisplayStyleTarget(documentRef.current, target, bondStyle);
    if (nextDocument !== documentRef.current) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setStatus(nextDocument === documentRef.current
      ? `${nativeBondToolStatusLabel(bondStyle)} already applied`
      : `Applied ${nativeBondToolStatusLabel(bondStyle)} style`);
  }, [commitDocumentChange]);

  const applyChargeDocumentAtPoint = useCallback((charge: NativeChargeValue, point: ClientPoint) => {
    const nextDocument = applyChargeToolAtPoint(documentRef.current, charge, point);
    if (nextDocument !== documentRef.current) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setStatus(charge > 0 ? "Placed positive charge" : "Placed negative charge");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

  const applyFreeformBondDocumentAtPoint = useCallback((
    sourceDocument: ChemDraftDocument,
    objectId: string,
    atomId: string,
    point: ClientPoint,
    forceCustomLength: boolean,
    bondStyle?: NativeBondDisplayStyle
  ) => {
    const previousMolecule = findDocumentObject(sourceDocument, objectId);
    const nextDocument = applyFreeformSingleBondToolAtPoint(sourceDocument, objectId, atomId, point, {
      forceCustomLength,
      bondStyle
    });
    const selected = getSelectedMolecule(nextDocument);
    const atomCount = selected?.atoms.length ?? 0;
    const connectedExistingAtoms =
      previousMolecule?.type === "molecule" &&
      selected !== undefined &&
      selected.atoms.length === previousMolecule.atoms.length &&
      selected.bonds.length > previousMolecule.bonds.length;
    if (nextDocument !== sourceDocument) {
      commitDocumentChange(nextDocument);
    }
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus(
      nextDocument === sourceDocument
        ? "Freeform bond not placed"
        : connectedExistingAtoms
          ? `Connected carbon atoms; molecule has ${atomCount} atoms`
          : `Placed freeform carbon bond; molecule has ${atomCount} atoms`
    );
  }, [commitDocumentChange]);

  const updateBondGrowthPreview = useCallback((sourceDocument: ChemDraftDocument, point: ClientPoint | undefined) => {
    if (!bondToolActive || !point) {
      setHoveredNativeAtom(undefined);
      return;
    }

    const page = sourceDocument.pages[0];
    const previews = page.objects
      .filter((object): object is MoleculeObject => object.type === "molecule")
      .map((object) => ({
        object,
        preview: previewNativeMoleculeBondGrowth(object, point, page.width, page.height)
      }))
      .filter((entry): entry is { object: MoleculeObject; preview: NonNullable<ReturnType<typeof previewNativeMoleculeBondGrowth>> } =>
        entry.preview !== undefined
      )
      .sort((left, right) =>
        left.preview.distanceToPointer - right.preview.distanceToPointer || left.object.id.localeCompare(right.object.id)
      );
    const target = previews[0];

    setHoveredNativeAtom(target ? {
      objectId: target.object.id,
      atomId: target.preview.atomId,
      direction: target.preview.direction,
      candidateDirections: target.preview.candidateDirections,
      newAtomPoint: target.preview.newAtomPoint
    } : undefined);
  }, [bondToolActive]);

  const updateNativeCanvasHover = useCallback((
    sourceDocument: ChemDraftDocument,
    point: ClientPoint | undefined,
    eventTarget?: EventTarget | null
  ) => {
    if (!point) {
      setHoveredNativeAtom(undefined);
      setNativeDoubleBondSidePreview(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setTemplatePreview(undefined);
      templatePreviewKeyRef.current = undefined;
      return;
    }

    // Ring/template tools resolve the hover with the bond-preferring template resolver (purely
    // geometric) so the highlight matches what a click will fuse/attach. Every other tool keeps
    // the generic atom-first hover (with its DOM tiebreak) unchanged.
    const target = activeNativeTemplateId
      ? nativeMoleculeTemplateHoverTarget(
          sourceDocument,
          point,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : nativeMoleculeCanvasHoverTarget(
          sourceDocument,
          point,
          eventTarget,
          hitToleranceForScale(viewportRef.current.scale)
        );
    assignHoveredNativeDeleteTarget(target);
    hoveredNativeAtomPointRef.current = target?.kind === "atom"
      ? { objectId: target.objectId, point }
      : undefined;
    // Capture the hover for a template click to reuse verbatim, so the committed placement
    // matches the painted highlight (no per-object recompute that can flip bond->atom).
    templateHoverTargetRef.current = activeNativeTemplateId && target
      ? {
          pagePoint: point,
          toolCommandId: activeToolState.activeCommandId,
          templateId: activeNativeTemplateId,
          target
        }
      : undefined;

    // Ghost preview: the exact ring a click would place. A fuse/spiro plan is determined by its
    // target (the shared edge/atom), so we key on that and skip recomputing the Kekulé pass while
    // the pointer wanders the same bond — only a standalone ring follows the cursor cell-by-cell.
    if (activeNativeTemplateId) {
      const previewKey = target
        ? [activeNativeTemplateId, target.objectId, target.kind, target.kind === "bond" ? target.bondId : target.atomId].join("|")
        : ["standalone", activeNativeTemplateId, Math.round(point.x / 4), Math.round(point.y / 4)].join("|");
      if (previewKey !== templatePreviewKeyRef.current) {
        templatePreviewKeyRef.current = previewKey;
        setTemplatePreview(planNativeTemplatePlacement(sourceDocument, { point, target: target ?? undefined }, activeNativeTemplateId));
      }
    } else if (templatePreviewKeyRef.current !== undefined) {
      templatePreviewKeyRef.current = undefined;
      setTemplatePreview(undefined);
    }

    if (activeToolState.activeCommandId === "tool.bond" && target) {
      const object = findDocumentObject(sourceDocument, target.objectId);
      setNativeDoubleBondSidePreview(object?.type === "molecule"
        ? nativeDoubleBondSidePreviewFromHit(target.objectId, object, target, point)
        : undefined);
    } else {
      setNativeDoubleBondSidePreview(undefined);
    }

    if (bondToolActive) {
      updateBondGrowthPreview(sourceDocument, point);
      return;
    }

    setHoveredNativeAtom(undefined);
  }, [
    activeNativeTemplateId,
    activeToolState.activeCommandId,
    assignHoveredNativeDeleteTarget,
    bondToolActive,
    updateBondGrowthPreview
  ]);

  useEffect(() => {
    const handleWindowPointerMove = (event: globalThis.MouseEvent) => {
      const clientPoint = { x: event.clientX, y: event.clientY };
      const canvas = canvasRegionRef.current;
      if (canvas && clientPointIsInsideRect(clientPoint, canvas.getBoundingClientRect())) {
        lastCanvasPointerClientPointRef.current = clientPoint;
      }
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { capture: true });
    window.addEventListener("mousemove", handleWindowPointerMove, { capture: true });
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove, { capture: true });
      window.removeEventListener("mousemove", handleWindowPointerMove, { capture: true });
    };
  }, []);

  const updateFreeformBondPreview = useCallback((
    sourceDocument: ChemDraftDocument,
    drag: NativeBondDragState,
    point: ClientPoint | undefined
  ) => {
    if (!point) {
      return;
    }

    drag.latestPoint = point;
    const molecule = findDocumentObject(sourceDocument, drag.objectId);
    if (molecule?.type !== "molecule") {
      setFreeformNativeBond(undefined);
      return;
    }

    const page = sourceDocument.pages[0];
    const preview = previewNativeMoleculeFreeformBondGrowth(
      molecule,
      drag.atomId,
      point,
      page.width,
      page.height,
      { forceCustomLength: drag.freeformUnlocked }
    );
    if (preview?.customLength) {
      drag.freeformUnlocked = true;
    }
    setFreeformNativeBond(preview ? {
      objectId: molecule.id,
      atomId: preview.atomId,
      targetAtomId: preview.targetAtomId,
      newAtomPoint: preview.newAtomPoint,
      customLength: preview.customLength,
      lengthAngstrom: preview.lengthAngstrom
    } : undefined);
  }, []);

  const clearNativeBondDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativeBondDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativeBondDragRef.current = null;
      setFreeformNativeBond(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearNativeBondEditDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativeBondEditDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativeBondEditDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearNativePlacementDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativePlacementDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativePlacementDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const nativePlacementDocumentFromDrag = useCallback((
    drag: NativePlacementDragState,
    point: ClientPoint
  ): ChemDraftDocument => rotateNativeMoleculeObjectAroundPoint(
    drag.placementDocument,
    drag.objectId,
    drag.startPoint,
    nativePlacementRotationDegrees(drag.startPoint, point)
  ), []);

  const previewNativePlacementDrag = useCallback((drag: NativePlacementDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(nativePlacementDocumentFromDrag(drag, point));
  }, [nativePlacementDocumentFromDrag, replacePresentDocument]);

  const commitNativePlacementDrag = useCallback((drag: NativePlacementDragState, point: ClientPoint): boolean => {
    const placed = drag.dragging
      ? nativePlacementDocumentFromDrag(drag, point)
      : drag.placementDocument;
    if (placed === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: placed,
      future: []
    });
    return true;
  }, [installDocumentHistory, nativePlacementDocumentFromDrag, replacePresentDocument]);

  const objectDragDocument = useCallback((drag: ObjectDragState, point: ClientPoint): ChemDraftDocument => {
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    return drag.groupObjectIds && drag.groupObjectIds.length > 1
      ? moveDocumentObjects(drag.startDocument, drag.groupObjectIds, dx, dy)
      : moveDocumentObject(drag.startDocument, drag.objectId, {
          x: drag.startObjectX + dx,
          y: drag.startObjectY + dy
        });
  }, []);

  const previewObjectDrag = useCallback((drag: ObjectDragState, point: ClientPoint) => {
    replacePresentDocument(objectDragDocument(drag, point));
  }, [objectDragDocument, replacePresentDocument]);

  const graphicCornerRadiusDocumentFromDrag = useCallback((drag: GraphicCornerRadiusDragState, point: ClientPoint): ChemDraftDocument =>
    updateNativeGraphicCornerRadius(
      drag.startDocument,
      drag.objectId,
      nativeGraphicCornerRadiusPointFromProjectedDrag(drag.startDocument, drag.objectId, point)
    ), []);

  const previewGraphicCornerRadius = useCallback((drag: GraphicCornerRadiusDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    const nextDocument = graphicCornerRadiusDocumentFromDrag(drag, point);
    const object = findDocumentObject(nextDocument, drag.objectId);
    if (object?.type === "graphic") {
      setGraphicCornerRadiusReadout({
        objectId: drag.objectId,
        radius: graphicCornerRadiusReadoutValue(object)
      });
    }
    replacePresentDocument(nextDocument);
  }, [graphicCornerRadiusDocumentFromDrag, replacePresentDocument]);

  const graphicPathEditDocumentFromDrag = useCallback((drag: GraphicPathEditDragState, point: ClientPoint): ChemDraftDocument => {
    const preparedDocument = prepareGraphicPathForDirectEdit(drag.workingDocument, drag.objectId);
    const editPoint = nativeGraphicPathEditPointFromProjectedDrag(preparedDocument, drag.objectId, point);
    return updateNativeGraphicPathHandle(preparedDocument, drag.objectId, drag.handle, editPoint);
  }, []);

  const previewGraphicPathEdit = useCallback((drag: GraphicPathEditDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    const nextDocument = graphicPathEditDocumentFromDrag(drag, point);
    drag.workingDocument = nextDocument;
    replacePresentDocument(nextDocument);
  }, [graphicPathEditDocumentFromDrag, replacePresentDocument]);

  const graphicMarkerDocumentFromDrag = useCallback((drag: GraphicMarkerDragState, point: ClientPoint): ChemDraftDocument => {
    const editPoint = nativeGraphicPathEditPointFromProjectedDrag(drag.startDocument, drag.objectId, point);
    return updateNativeGraphicMarkerHandle(drag.startDocument, drag.objectId, drag.markerId, editPoint);
  }, []);

  const previewGraphicMarkerDrag = useCallback((drag: GraphicMarkerDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(graphicMarkerDocumentFromDrag(drag, point));
  }, [graphicMarkerDocumentFromDrag, replacePresentDocument]);

  const commitGraphicMarkerDrag = useCallback((drag: GraphicMarkerDragState, point: ClientPoint): boolean => {
    const edited = graphicMarkerDocumentFromDrag(drag, point);
    if (edited === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: edited,
      future: []
    });
    return true;
  }, [graphicMarkerDocumentFromDrag, installDocumentHistory, replacePresentDocument]);

  const objectRotateDocumentFromDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint): ChemDraftDocument => {
    const degrees = rotationDeltaDegrees(drag.centerPoint, drag.startPoint, point);
    return drag.target
      ? rotateNativeMoleculeParts(drag.startDocument, drag.target, degrees)
      : rotateDocumentObject(drag.startDocument, drag.objectId, degrees);
  }, []);

  const projectedPlaneTiltFromDrag = useCallback((
    drag: ProjectedPlaneTiltDragState,
    point: ClientPoint
  ) => {
    const object = findDocumentObject(drag.startDocument, drag.objectId);
    const tiltDelta = object && object.type !== "molecule"
      ? documentObjectProjectedPlaneTiltVectorFromDrag(drag.startPoint, point)
      : projectedPlaneTiltVectorFromDrag(drag.startPoint, point);
    const rawTiltXRad = drag.startTiltXRad + tiltDelta.xRad;
    const rawTiltYRad = drag.startTiltYRad + tiltDelta.yRad;
    if (object && object.type !== "molecule") {
      const wrappedTilt = wrapProjectedPlaneTiltVectorRadians(rawTiltXRad, rawTiltYRad);
      const tiltXRad = wrappedTilt.tiltXRad;
      const tiltYRad = wrappedTilt.tiltYRad;
      const document = applyDocumentObjectProjectedPlaneTilt(
        drag.startDocument,
        drag.objectId,
        radiansToDegrees(tiltXRad),
        radiansToDegrees(tiltYRad)
      );
      return {
        document,
        tiltXRad,
        tiltYRad,
        clamped: wrappedTilt.clamped,
        changed: document !== drag.startDocument
      };
    }

    const tiltXRad = rawTiltXRad;
    const tiltYRad = rawTiltYRad;
    return drag.target
      ? tiltNativeMoleculePartsProjectedPlane(
        drag.startDocument,
        drag.target,
        drag.centerPoint,
        drag.axisAngleRad,
        tiltXRad,
        {
          fromTiltRad: drag.startTiltXRad,
          fromTiltYRad: drag.startTiltYRad,
          tiltYRad,
          fromRotationDegrees: drag.startRotationDegrees,
          rotationDegrees: drag.startRotationDegrees
        }
      )
      : tiltNativeMoleculeProjectedPlane(
        drag.startDocument,
        drag.objectId,
        drag.centerPoint,
        drag.axisAngleRad,
        tiltXRad,
        {
          fromTiltRad: drag.startTiltXRad,
          fromTiltYRad: drag.startTiltYRad,
          tiltYRad,
          fromRotationDegrees: drag.startRotationDegrees,
          rotationDegrees: drag.startRotationDegrees,
          persistTransform: true
        }
      );
  }, []);

  const previewObjectRotateDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    const degrees = rotationDeltaDegrees(drag.centerPoint, drag.startPoint, point);
    if (objectRotateReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(objectRotateReadoutTimeoutRef.current);
    }
    setObjectRotateReadout({
      objectId: drag.objectId,
      degrees: cumulativeRotationReadoutDegrees(drag.startRotationDegrees, degrees)
    });
    objectRotateReadoutTimeoutRef.current = window.setTimeout(() => {
      objectRotateReadoutTimeoutRef.current = undefined;
      setObjectRotateReadout(undefined);
    }, 1200);
    replacePresentDocument(objectRotateDocumentFromDrag(drag, point));
  }, [objectRotateDocumentFromDrag, replacePresentDocument]);

  const showProjectedPlaneTiltReadout = useCallback((
    objectId: string,
    tiltXRad: number,
    tiltYRad: number,
    limited: boolean,
    hold = false
  ) => {
    if (projectedPlaneTiltReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(projectedPlaneTiltReadoutTimeoutRef.current);
      projectedPlaneTiltReadoutTimeoutRef.current = undefined;
    }

    setProjectedPlaneTiltReadout({
      objectId,
      label: projectedPlaneTiltReadoutLabel(tiltXRad, tiltYRad),
      limited
    });

    if (hold) {
      projectedPlaneTiltReadoutTimeoutRef.current = window.setTimeout(() => {
        projectedPlaneTiltReadoutTimeoutRef.current = undefined;
        setProjectedPlaneTiltReadout(undefined);
      }, 1200);
    }
  }, []);

  const previewProjectedPlaneTilt = useCallback((drag: ProjectedPlaneTiltDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    const result = projectedPlaneTiltFromDrag(drag, point);
    drag.latestTiltXRad = result.tiltXRad;
    drag.latestTiltYRad = result.tiltYRad;
    drag.clamped = result.clamped;
    showProjectedPlaneTiltReadout(
      drag.objectId,
      result.tiltXRad,
      result.tiltYRad,
      result.clamped
    );
    replacePresentDocument(result.document);
    setStatus(`3D rotate: ${projectedPlaneTiltReadoutLabel(result.tiltXRad, result.tiltYRad)}`);
  }, [projectedPlaneTiltFromDrag, replacePresentDocument, showProjectedPlaneTiltReadout]);

  const previewNativeDoubleBondSideDrag = useCallback((drag: NativeBondEditDragState, point: ClientPoint) => {
    const selectedStartDocument = selectDocumentObject(drag.startDocument, drag.target.objectId);
    const nextDocument = applyNativeDoubleBondSideTarget(selectedStartDocument, drag.target, point);
    replacePresentDocument(nextDocument);
  }, [replacePresentDocument]);

  const commitNativeDoubleBondSideDrag = useCallback((drag: NativeBondEditDragState, point: ClientPoint): boolean => {
    const selectedStartDocument = selectDocumentObject(drag.startDocument, drag.target.objectId);
    const moved = applyNativeDoubleBondSideTarget(selectedStartDocument, drag.target, point);
    if (moved === selectedStartDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: moved,
      future: []
    });
    return true;
  }, [installDocumentHistory, replacePresentDocument]);

  const commitObjectDrag = useCallback((drag: ObjectDragState, point: ClientPoint): boolean => {
    const moved = objectDragDocument(drag, point);
    if (moved === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: moved,
      future: []
    });
    return true;
  }, [installDocumentHistory, objectDragDocument, replacePresentDocument]);

  const commitGraphicCornerRadius = useCallback((drag: GraphicCornerRadiusDragState, point: ClientPoint): boolean => {
    const edited = graphicCornerRadiusDocumentFromDrag(drag, point);
    if (edited === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: edited,
      future: []
    });
    return true;
  }, [graphicCornerRadiusDocumentFromDrag, installDocumentHistory, replacePresentDocument]);

  const commitGraphicPathEdit = useCallback((drag: GraphicPathEditDragState, point: ClientPoint): boolean => {
    const edited = drag.workingDocument === drag.startDocument
      ? graphicPathEditDocumentFromDrag(drag, point)
      : drag.workingDocument;
    if (edited === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: edited,
      future: []
    });
    return true;
  }, [graphicPathEditDocumentFromDrag, installDocumentHistory, replacePresentDocument]);

  const commitObjectRotateDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint): boolean => {
    const rotated = objectRotateDocumentFromDrag(drag, point);
    if (rotated === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: rotated,
      future: []
    });
    return true;
  }, [installDocumentHistory, objectRotateDocumentFromDrag, replacePresentDocument]);

  const commitProjectedPlaneTilt = useCallback((drag: ProjectedPlaneTiltDragState, point: ClientPoint): boolean => {
    const result = projectedPlaneTiltFromDrag(drag, point);
    drag.latestTiltXRad = result.tiltXRad;
    drag.latestTiltYRad = result.tiltYRad;
    drag.clamped = result.clamped;
    showProjectedPlaneTiltReadout(
      drag.objectId,
      result.tiltXRad,
      result.tiltYRad,
      result.clamped,
      true
    );
    if (!result.changed || result.document === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory(projectedPlaneTiltCommitHistory(currentHistory, drag.startDocument, result.document));
    return true;
  }, [installDocumentHistory, projectedPlaneTiltFromDrag, replacePresentDocument, showProjectedPlaneTiltReadout]);

  const rotationInputDocumentFromDraft = useCallback((input: RotationInputState): RotationInputDraftDocumentResult | undefined => {
    const object = findDocumentObject(input.startDocument, input.objectId);
    if (!object) {
      return undefined;
    }

    if (input.kind === "z") {
      const zDegrees = parseRotationInputDegrees(input.draftZDegrees);
      if (zDegrees === undefined) {
        return undefined;
      }

      const nextDocument = object.type === "molecule" && isNativeMoleculeGraph(object)
        ? input.target
          ? rotateNativeMoleculeParts(input.startDocument, input.target, zDegrees)
          : rotateDocumentObject(
              input.startDocument,
              input.objectId,
              manualRotationDeltaDegrees(nativeMoleculeTransformState(object).rotationDegrees, zDegrees)
            )
        : rotateDocumentObject(input.startDocument, input.objectId, manualRotationDeltaDegrees(object.rotation, zDegrees));
      return { kind: "z", document: nextDocument, zDegrees };
    }

    const xDegrees = parseRotationInputDegrees(input.draftXDegrees);
    const yDegrees = parseRotationInputDegrees(input.draftYDegrees);
    if (xDegrees === undefined || yDegrees === undefined) {
      return undefined;
    }

    if (object.type !== "molecule") {
      const wrappedTilt = wrapProjectedPlaneTiltVectorRadians(
        degreesToRadians(xDegrees),
        degreesToRadians(yDegrees)
      );
      const tiltXDegrees = radiansToDegrees(wrappedTilt.tiltXRad);
      const tiltYDegrees = radiansToDegrees(wrappedTilt.tiltYRad);
      return {
        kind: "xy",
        document: applyDocumentObjectProjectedPlaneTilt(
          input.startDocument,
          input.objectId,
          tiltXDegrees,
          tiltYDegrees
        ),
        tiltXRad: degreesToRadians(tiltXDegrees),
        tiltYRad: degreesToRadians(tiltYDegrees),
        clamped: wrappedTilt.clamped
      };
    }

    if (!isNativeMoleculeGraph(object)) {
      return undefined;
    }

    const fragmentBounds = input.target ? nativeMoleculePartBounds(object, input.target) : undefined;
    const center = fragmentBounds ? documentObjectCenter(fragmentBounds) : nativeMoleculeCenter(object);
    const transform = nativeMoleculeTransformState(object);
    const result = input.target
      ? tiltNativeMoleculePartsProjectedPlane(
          input.startDocument,
          input.target,
          center,
          0,
          degreesToRadians(xDegrees),
          {
            fromTiltRad: 0,
            fromTiltYRad: 0,
            tiltYRad: degreesToRadians(yDegrees),
            fromRotationDegrees: 0,
            rotationDegrees: 0
          }
        )
      : tiltNativeMoleculeProjectedPlane(
          input.startDocument,
          input.objectId,
          center,
          0,
          degreesToRadians(xDegrees),
          {
            fromTiltRad: degreesToRadians(transform.tiltXDegrees ?? 0),
            fromTiltYRad: degreesToRadians(transform.tiltYDegrees ?? 0),
            tiltYRad: degreesToRadians(yDegrees),
            fromRotationDegrees: transform.rotationDegrees,
            rotationDegrees: transform.rotationDegrees,
            persistTransform: true
          }
        );

    return {
      kind: "xy",
      document: result.document,
      tiltXRad: result.tiltXRad,
      tiltYRad: result.tiltYRad,
      clamped: result.clamped
    };
  }, []);

  const handleRotationInputChange = useCallback((nextInput: RotationInputState) => {
    updateRotationInput(nextInput);
    const result = rotationInputDocumentFromDraft(nextInput);
    if (!result) {
      setStatus(nextInput.kind === "z" ? "Enter a valid Z rotation" : "Enter valid X and Y rotations");
      return;
    }

    replacePresentDocument(result.document);
    if (result.kind === "xy") {
      showProjectedPlaneTiltReadout(nextInput.objectId, result.tiltXRad, result.tiltYRad, result.clamped, false);
    } else {
      setObjectRotateReadout({ objectId: nextInput.objectId, degrees: result.zDegrees });
    }
  }, [replacePresentDocument, rotationInputDocumentFromDraft, showProjectedPlaneTiltReadout, updateRotationInput]);

  const handleRotationInputHome = useCallback((input: RotationInputState) => {
    const nextInput: RotationInputState = input.kind === "z"
      ? { ...input, ...rotationInputHomeDraftDegrees("z") }
      : { ...input, ...rotationInputHomeDraftDegrees("xy") };
    handleRotationInputChange(nextInput);
    setStatus(nextInput.kind === "z" ? "Z rotation set to 0" : "X/Y rotation set to 0");
  }, [handleRotationInputChange]);

  const handleRotationInputCancel = useCallback((input?: RotationInputState) => {
    const session = input ?? rotationInputRef.current;
    if (session) {
      replacePresentDocument(session.startDocument);
    }
    updateRotationInput(undefined);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    setStatus("Rotation entry canceled");
  }, [replacePresentDocument, updateRotationInput]);

  const handleRotationInputKeep = useCallback((input?: RotationInputState) => {
    const session = input ?? rotationInputRef.current;
    if (!session) {
      return false;
    }

    const changed = commitLiveInputPreview(session.startDocument);
    updateRotationInput(undefined);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    setStatus(changed ? "Rotation applied" : "Rotation unchanged");
    return changed;
  }, [commitLiveInputPreview, updateRotationInput]);

  const showObjectResizeReadout = useCallback((objectId: string, scale: ObjectResizeScale, hold = false) => {
    if (objectResizeReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(objectResizeReadoutTimeoutRef.current);
      objectResizeReadoutTimeoutRef.current = undefined;
    }

    setObjectResizeReadout({
      objectId,
      scaleXPercent: objectResizeReadoutPercent(scale.x),
      scaleYPercent: objectResizeReadoutPercent(scale.y)
    });

    if (hold) {
      objectResizeReadoutTimeoutRef.current = window.setTimeout(() => {
        objectResizeReadoutTimeoutRef.current = undefined;
        setObjectResizeReadout(undefined);
      }, 1200);
    }
  }, []);

  const objectResizeInputDocumentFromDraft = useCallback((input: ObjectResizeInputState) => {
    const object = findDocumentObject(input.startDocument, input.objectId);
    if (!object) {
      return undefined;
    }

    const xPercent = parseObjectResizeInputPercent(input.draftXPercent);
    const yPercent = parseObjectResizeInputPercent(input.draftYPercent);
    if (xPercent === undefined || yPercent === undefined) {
      return undefined;
    }

    const targetScale = {
      x: xPercent / 100,
      y: yPercent / 100
    };
    if (object.type !== "molecule") {
      return {
        document: scaleDocumentObjectsAroundPoint(
          input.startDocument,
          [input.objectId],
          documentObjectCenter(object),
          targetScale.x,
          targetScale.y
        ),
        targetScale
      };
    }

    if (!isNativeMoleculeGraph(object)) {
      return undefined;
    }

    const transform = nativeMoleculeTransformState(object);
    const resizeScale = input.target
      ? targetScale
      : {
          x: targetScale.x / transform.scaleX,
          y: targetScale.y / transform.scaleY
    };
    const nextDocument = input.target
      ? resizeNativeMoleculeParts(input.startDocument, input.target, resizeScale)
      : resizeNativeMoleculeObject(input.startDocument, input.objectId, resizeScale);
    return { document: nextDocument, targetScale };
  }, []);

  const handleObjectResizeInputChange = useCallback((nextInput: ObjectResizeInputState) => {
    updateObjectResizeInput(nextInput);
    const result = objectResizeInputDocumentFromDraft(nextInput);
    if (!result) {
      setStatus("Enter valid X and Y stretch percentages");
      return;
    }

    replacePresentDocument(result.document);
    showObjectResizeReadout(nextInput.objectId, result.targetScale, false);
  }, [objectResizeInputDocumentFromDraft, replacePresentDocument, showObjectResizeReadout, updateObjectResizeInput]);

  const handleObjectResizeInputHome = useCallback((input: ObjectResizeInputState) => {
    replacePresentDocument(input.startDocument);
    updateObjectResizeInput({
      ...input,
      draftXPercent: input.homeXPercent,
      draftYPercent: input.homeYPercent
    });
    setObjectResizeReadout(undefined);
    setStatus("Stretch restored home");
  }, [replacePresentDocument, updateObjectResizeInput]);

  const handleObjectResizeInputCancel = useCallback((input?: ObjectResizeInputState) => {
    const session = input ?? objectResizeInputRef.current;
    if (session) {
      replacePresentDocument(session.startDocument);
    }
    updateObjectResizeInput(undefined);
    setObjectResizeReadout(undefined);
    setStatus("Stretch entry canceled");
  }, [replacePresentDocument, updateObjectResizeInput]);

  const handleObjectResizeInputKeep = useCallback((input?: ObjectResizeInputState) => {
    const session = input ?? objectResizeInputRef.current;
    if (!session) {
      return false;
    }

    const changed = commitLiveInputPreview(session.startDocument);
    updateObjectResizeInput(undefined);
    setObjectResizeReadout(undefined);
    setStatus(changed ? "Stretch applied" : "Stretch unchanged");
    return changed;
  }, [commitLiveInputPreview, updateObjectResizeInput]);

  // Clears the transient interaction "chrome" — open editors, hover highlights, and in-flight
  // previews — without touching the selection. Numeric transform sessions are first kept as
  // one undoable change so clicking elsewhere on the viewport preserves the live-preview values.
  const clearTransientInteractionChrome = useCallback(() => {
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, [
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep
  ]);

  const objectResizeDocumentFromDrag = useCallback((
    drag: ObjectResizeDragState,
    point: ClientPoint,
    stretching: boolean
  ): ChemDraftDocument => {
    const scale = objectResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, stretching);
    const object = findDocumentObject(drag.startDocument, drag.objectId);
    if (!drag.target && object?.type !== "molecule") {
      return scaleDocumentObjectsAroundPoint(drag.startDocument, [drag.objectId], drag.centerPoint, scale.x, scale.y);
    }

    return drag.target
      ? resizeNativeMoleculeParts(drag.startDocument, drag.target, scale)
      : resizeNativeMoleculeObject(drag.startDocument, drag.objectId, scale);
  }, []);

  const previewObjectResize = useCallback((drag: ObjectResizeDragState, point: ClientPoint, stretching: boolean) => {
    drag.latestPoint = point;
    drag.stretching = stretching;
    drag.latestScale = objectResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, stretching);
    drag.latestCumulativeScale = cumulativeObjectResizeScale(drag.startCumulativeScale, drag.latestScale);
    showObjectResizeReadout(drag.objectId, drag.latestCumulativeScale);
    replacePresentDocument(objectResizeDocumentFromDrag(drag, point, stretching));
  }, [objectResizeDocumentFromDrag, replacePresentDocument, showObjectResizeReadout]);

  const commitObjectResize = useCallback((drag: ObjectResizeDragState, point: ClientPoint): boolean => {
    drag.latestScale = objectResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, drag.stretching);
    drag.latestCumulativeScale = cumulativeObjectResizeScale(drag.startCumulativeScale, drag.latestScale);
    const resized = objectResizeDocumentFromDrag(drag, point, drag.stretching);
    showObjectResizeReadout(drag.objectId, drag.latestCumulativeScale, true);
    if (resized === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: resized,
      future: []
    });
    return true;
  }, [installDocumentHistory, objectResizeDocumentFromDrag, replacePresentDocument, showObjectResizeReadout]);

  const nativePartDocumentFromDrag = useCallback((drag: NativePartDragState, point: ClientPoint): ChemDraftDocument =>
    moveNativeMoleculeParts(drag.startDocument, drag.target, {
      x: point.x - drag.startPoint.x,
      y: point.y - drag.startPoint.y
    }), []);

  const previewNativePartDrag = useCallback((drag: NativePartDragState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(nativePartDocumentFromDrag(drag, point));
  }, [nativePartDocumentFromDrag, replacePresentDocument]);

  const commitNativePartDrag = useCallback((drag: NativePartDragState, point: ClientPoint): boolean => {
    const moved = nativePartDocumentFromDrag(drag, point);
    if (moved === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: moved,
      future: []
    });
    return true;
  }, [installDocumentHistory, nativePartDocumentFromDrag, replacePresentDocument]);

  const resizeTextDocumentFromDrag = useCallback((drag: TextResizeState, point: ClientPoint): ChemDraftDocument => {
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    const frame = drag.edge === "right"
      ? {
          x: drag.startObjectX,
          width: drag.startObjectWidth + dx
        }
      : drag.edge === "left" ? {
          x: drag.startObjectX + dx,
          width: drag.startObjectWidth - dx
        }
      : drag.edge === "bottom" ? {
          y: drag.startObjectY,
          height: drag.startObjectHeight + dy
        }
      : {
          y: drag.startObjectY + dy,
          height: drag.startObjectHeight - dy
        };

    return resizeNativeTextObjectBox(drag.startDocument, drag.objectId, frame);
  }, []);

  const previewTextResize = useCallback((drag: TextResizeState, point: ClientPoint) => {
    drag.latestPoint = point;
    replacePresentDocument(resizeTextDocumentFromDrag(drag, point));
  }, [replacePresentDocument, resizeTextDocumentFromDrag]);

  const commitTextResize = useCallback((drag: TextResizeState, point: ClientPoint): boolean => {
    const resized = resizeTextDocumentFromDrag(drag, point);
    if (resized === drag.startDocument) {
      replacePresentDocument(drag.startDocument);
      return false;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, drag.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: resized,
      future: []
    });
    return true;
  }, [installDocumentHistory, replacePresentDocument, resizeTextDocumentFromDrag]);

  const clearObjectDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = objectDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      objectDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearGraphicCornerRadiusDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = graphicCornerRadiusDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      graphicCornerRadiusDragRef.current = null;
      setGraphicCornerRadiusReadout(undefined);
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearGraphicPathEditDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = graphicPathEditDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      graphicPathEditDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearGraphicMarkerDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = graphicMarkerDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      graphicMarkerDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearObjectRotateDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = objectRotateDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      objectRotateDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearObjectResizeDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = objectResizeDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      objectResizeDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearNativePartDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = nativePartDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativePartDragRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearTextResize = useCallback((event: ObjectPointerEvent) => {
    const drag = textResizeRef.current;
    if (drag?.pointerId === event.pointerId) {
      textResizeRef.current = null;
      const page = pageRef.current;
      if (page?.hasPointerCapture(event.pointerId)) {
        page.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const startTextResize = useCallback((
    objectId: string,
    edge: TextResizeEdge,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    const point = pagePointFromPointerEvent(event);
    const object = findDocumentObject(documentRef.current, objectId);
    if (!point || object?.type !== "text") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    textResizeRef.current = {
      pointerId: event.pointerId,
      objectId,
      edge,
      startDocument: documentRef.current,
      startPoint: point,
      latestPoint: point,
      startObjectX: object.x,
      startObjectY: object.y,
      startObjectWidth: object.width,
      startObjectHeight: object.height
    };
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId((current) => current === objectId ? current : undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    pageRef.current?.setPointerCapture(event.pointerId);
  }, [assignHoveredNativeDeleteTarget, pagePointFromPointerEvent]);

  const groupProjectedPlaneTiltFromDrag = useCallback((
    drag: GroupTransformDragState,
    point: ClientPoint
  ) => {
    const tiltDelta = projectedPlaneTiltVectorFromDrag(drag.startPoint, point);
    return tiltNativeMoleculeObjectsProjectedPlane(
      drag.startDocument,
      drag.objectIds,
      drag.center,
      0,
      tiltDelta.xRad,
      {
        fromTiltRad: 0,
        fromTiltYRad: 0,
        tiltYRad: tiltDelta.yRad,
        fromRotationDegrees: 0,
        rotationDegrees: 0
      }
    );
  }, []);

  // Transform the whole selected group about its shared visual selection-box center.
  const groupTransformDocument = useCallback((
    drag: GroupTransformDragState,
    point: ClientPoint,
    stretch = false
  ): ChemDraftDocument => {
    if (drag.mode === "rotate") {
      const degrees = rotationDeltaDegrees(drag.center, drag.startPoint, point);
      return rotateDocumentObjectsAroundPoint(drag.startDocument, drag.objectIds, drag.center, degrees);
    }
    if (drag.mode === "projected-plane-tilt") {
      return groupProjectedPlaneTiltFromDrag(drag, point).document;
    }
    const scale = objectResizeScaleFromDrag(drag.center, drag.startPoint, point, stretch);
    return scaleDocumentObjectsAroundPoint(drag.startDocument, drag.objectIds, drag.center, scale.x, scale.y);
  }, [groupProjectedPlaneTiltFromDrag]);

  const handleGroupTransformPointerDown = useCallback((
    mode: GroupTransformDragState["mode"],
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    const ids = mode === "projected-plane-tilt"
      ? nativeMoleculeObjectIdsForGroupProjectedPlaneTilt(document.pages[0].objects, document.selection.objectIds)
      : document.selection.objectIds;
    const point = pagePointFromPointerEvent(event);
    const bounds = ids.length > 1 ? selectionBounds(document.pages[0].objects, ids) : undefined;
    if (!point || !bounds) {
      if (mode === "projected-plane-tilt") {
        setStatus("Select multiple native molecules for 3D rotate");
      }
      return;
    }

    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    groupTransformDragRef.current = {
      pointerId: event.pointerId,
      mode,
      objectIds: [...ids],
      startDocument: document,
      center: { x: bounds.centerX, y: bounds.centerY },
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    groupTransformMachineRef.current = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: event.pointerId,
      world: point,
      target: { kind: "empty" },
      dragKind: mode === "rotate"
        ? "group-rotate"
        : mode === "projected-plane-tilt" ? "group-projected-plane-tilt" : "group-resize"
    });
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(
      mode === "rotate"
        ? "Rotate selected group"
        : mode === "projected-plane-tilt" ? "3D rotate: drag to tilt/twist selected molecules" : "Resize selected group"
    );
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    document,
    pagePointFromPointerEvent
  ]);

  const handleGroupRotatePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) =>
    handleGroupTransformPointerDown("rotate", event), [handleGroupTransformPointerDown]);
  const handleGroupProjectedPlaneTiltPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) =>
    handleGroupTransformPointerDown("projected-plane-tilt", event), [handleGroupTransformPointerDown]);
  const handleGroupResizePointerDown = useCallback((_corner: ObjectResizeCorner) =>
    (event: PointerEvent<HTMLButtonElement>) => handleGroupTransformPointerDown("resize", event),
  [handleGroupTransformPointerDown]);

  const handlePagePointerDown = useCallback((event: ObjectPointerEvent) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    setObjectContextMenu(undefined);
    const point = pagePointFromPointerEvent(event);
    if (!point) {
      return;
    }

    if (activeToolState.activeKind === "selection") {
      const pressObject = nativeMoleculeObjectAtPoint(document.pages[0].objects, point);
      const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId: pressObject?.id };
      const doublePress = event.detail >= 2 || isSelectionDoublePress(lastSelectionPressRef.current, press);
      lastSelectionPressRef.current = press;
      if (doublePress) {
        const object = pressObject;
        if (object) {
          event.preventDefault();
          event.stopPropagation();
          replacePresentDocument((current) => selectDocumentObject(current, object.id));
          setSelectedNativeMoleculePart(undefined);
          setActiveGraphicTransformObjectId(undefined);
          clearTransientInteractionChrome();
          setStatus("Selected molecule");
          return;
        }
      }

      event.preventDefault();
      selectionMarqueeRef.current = {
        pointerId: event.pointerId,
        startPoint: point,
        latestPoint: point,
        dragging: false
      };
      marqueeMachineRef.current = interactionReducer(initialInteractionState(), { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "empty" }, dragKind: "marquee" });
      setSelectedNativeMoleculePart(undefined);
      setActiveGraphicTransformObjectId(undefined);
      clearTransientInteractionChrome();
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (activeChargeToolValue) {
      applyChargeDocumentAtPoint(activeChargeToolValue, point);
      return;
    }

    if (activeNativeTemplateId) {
      event.preventDefault();
      event.stopPropagation();
      // Ask the same question the object path asks: is there a current template target? If so,
      // fuse/attach to it instead of dropping a standalone ring in the gap. Only true empty
      // space (no resolved target) starts standalone placement.
      const templateTarget = currentTemplateTargetFromHoverOrHit(
        document,
        { pagePoint: point, toolCommandId: activeToolState.activeCommandId, templateId: activeNativeTemplateId },
        templateHoverTargetRef.current,
        viewportRef.current.scale
      );
      if (templateTarget) {
        applyNativeTemplateDocumentAtPoint(point, activeNativeTemplateId, templateTarget);
      } else if (!startNativePlacementDrag(event, point, { kind: "template", templateId: activeNativeTemplateId })) {
        applyNativeTemplateDocumentAtPoint(point, activeNativeTemplateId);
      }
      return;
    }

    if (activeNativeArtTool) {
      event.preventDefault();
      event.stopPropagation();
      applyNativeArtDocumentAtPoint(point, activeNativeArtTool.commandId);
      return;
    }

    if (activeToolState.activeCommandId === "tool.text") {
      event.preventDefault();
      event.stopPropagation();
      applyTextDocumentAtPoint(point);
      return;
    }

    if (activeNativeBondToolStyle) {
      event.preventDefault();
      event.stopPropagation();
      if (!startNativePlacementDrag(event, point, { kind: "single-bond", bondStyle: activeNativeBondDisplayStyle })) {
        applySingleBondDocumentAtPoint(document, point, activeNativeBondDisplayStyle);
      }
    }
  }, [
    activeChargeToolValue,
    activeNativeBondDisplayStyle,
    activeNativeBondToolStyle,
    activeNativeTemplateId,
    activeNativeArtTool,
    activeToolState.activeCommandId,
    applyChargeDocumentAtPoint,
    applyNativeArtDocumentAtPoint,
    applyNativeTemplateDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    applyTextDocumentAtPoint,
    document,
    pagePointFromPointerEvent,
    startNativePlacementDrag
  ]);

  const handlePageContextMenu = useCallback((event: ObjectMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setObjectContextMenu(undefined);
  }, []);

  const handlePagePointerMove = useCallback((event: ObjectPointerEvent) => {
    const groupTransform = groupTransformDragRef.current;
    if (groupTransform?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }
      groupTransform.latestPoint = point;
      groupTransformMachineRef.current = interactionReducer(groupTransformMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = groupTransformMachineRef.current.phase === "dragging";
      if (!groupTransform.dragging && nowDragging) {
        groupTransform.dragging = true;
      }
      if (groupTransform.dragging) {
        if (groupTransform.mode === "projected-plane-tilt") {
          const result = groupProjectedPlaneTiltFromDrag(groupTransform, point);
          groupTransform.latestTiltXRad = result.tiltXRad;
          groupTransform.latestTiltYRad = result.tiltYRad;
          groupTransform.clamped = result.clamped;
          replacePresentDocument(result.document);
          setStatus(`3D rotate: ${projectedPlaneTiltReadoutLabel(result.tiltXRad, result.tiltYRad)}`);
        } else {
          replacePresentDocument(groupTransformDocument(groupTransform, point, event.shiftKey));
        }
      }
      return;
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (point) {
        previewTextResize(textResize, point);
      }
      return;
    }

    const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
    if (projectedPlaneTiltDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      projectedPlaneTiltDrag.latestPoint = point;
      projectedPlaneTiltMachineRef.current = interactionReducer(projectedPlaneTiltMachineRef.current, {
        type: "pointerMove",
        pointerId: event.pointerId,
        world: point,
        target: { kind: "empty" }
      });
      const nowDragging = projectedPlaneTiltMachineRef.current.phase === "dragging";
      if (!projectedPlaneTiltDrag.dragging && nowDragging) {
        projectedPlaneTiltDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (projectedPlaneTiltDrag.dragging) {
        previewProjectedPlaneTilt(projectedPlaneTiltDrag, point);
      }
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectRotateDrag.latestPoint = point;
      objectRotateMachineRef.current = interactionReducer(objectRotateMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = objectRotateMachineRef.current.phase === "dragging";
      if (!objectRotateDrag.dragging && nowDragging) {
        objectRotateDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        if (!objectRotateDrag.target) {
          setSelectedNativeMoleculePart(undefined);
        }
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectRotateDrag.dragging) {
        previewObjectRotateDrag(objectRotateDrag, point);
      }
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectResizeDrag.latestPoint = point;
      if (!objectResizeDrag.dragging && clientPointDistance(objectResizeDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        objectResizeDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        if (!objectResizeDrag.target) {
          setSelectedNativeMoleculePart(undefined);
        }
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectResizeDrag.dragging) {
        previewObjectResize(objectResizeDrag, point, event.shiftKey);
      }
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicCornerRadiusDrag.latestPoint = point;
      if (!graphicCornerRadiusDrag.dragging && clientPointDistance(graphicCornerRadiusDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicCornerRadiusDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicCornerRadiusDrag.dragging) {
        previewGraphicCornerRadius(graphicCornerRadiusDrag, point);
      }
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicPathEditDrag.latestPoint = point;
      if (
        !graphicPathEditDrag.dragging &&
        (
          graphicPathEditDrag.handle === "middle" ||
          clientPointDistance(graphicPathEditDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD
        )
      ) {
        graphicPathEditDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicPathEditDrag.dragging) {
        previewGraphicPathEdit(graphicPathEditDrag, point);
      }
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicMarkerDrag.latestPoint = point;
      if (!graphicMarkerDrag.dragging && clientPointDistance(graphicMarkerDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicMarkerDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicMarkerDrag.dragging) {
        previewGraphicMarkerDrag(graphicMarkerDrag, point);
      }
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectDrag.latestPoint = point;
      objectDragMachineRef.current = interactionReducer(objectDragMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = objectDragMachineRef.current.phase === "dragging";
      if (!objectDrag.dragging && nowDragging) {
        objectDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }
      if (objectDrag.dragging) {
        previewObjectDrag(objectDrag, point);
      }
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      nativePartDrag.latestPoint = point;
      if (!nativePartDrag.dragging && clientPointDistance(nativePartDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        nativePartDrag.dragging = true;
        clearTransientInteractionChrome();
      }

      if (nativePartDrag.dragging) {
        previewNativePartDrag(nativePartDrag, point);
      }
      return;
    }

    const nativePlacementDrag = nativePlacementDragRef.current;
    if (nativePlacementDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      nativePlacementDrag.latestPoint = point;
      placementMachineRef.current = interactionReducer(placementMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = placementMachineRef.current.phase === "dragging";
      if (!nativePlacementDrag.dragging && nowDragging) {
        nativePlacementDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setSelectedNativeMoleculePart(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (nativePlacementDrag.dragging) {
        previewNativePlacementDrag(nativePlacementDrag, point);
      }
      return;
    }

    const marquee = selectionMarqueeRef.current;
    if (marquee?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      marquee.latestPoint = point;
      marqueeMachineRef.current = interactionReducer(marqueeMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      marquee.dragging = marqueeMachineRef.current.phase === "dragging";
      setSelectionMarquee(marquee.dragging ? { ...marquee } : undefined);
      return;
    }

    updateNativeCanvasHover(document, pagePointFromPointerEvent(event), event.target);
  }, [
    assignHoveredNativeDeleteTarget,
    document,
    groupProjectedPlaneTiltFromDrag,
    groupTransformDocument,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
    previewProjectedPlaneTilt,
    previewObjectResize,
    previewGraphicCornerRadius,
    previewGraphicPathEdit,
    previewGraphicMarkerDrag,
    previewNativePartDrag,
    previewNativePlacementDrag,
    previewTextResize,
    replacePresentDocument,
    updateNativeCanvasHover
  ]);

  const handlePagePointerUp = useCallback((event: ObjectPointerEvent) => {
    const groupTransform = groupTransformDragRef.current;
    if (groupTransform?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? groupTransform.latestPoint;
      groupTransformMachineRef.current = initialInteractionState();
      if (groupTransform.dragging) {
        const result = groupTransform.mode === "projected-plane-tilt"
          ? groupProjectedPlaneTiltFromDrag(groupTransform, point)
          : undefined;
        const next = result?.document ?? groupTransformDocument(groupTransform, point, event.shiftKey);
        if (next !== groupTransform.startDocument) {
          const currentHistory = documentHistoryRef.current;
          installDocumentHistory({
            past: [...currentHistory.past, groupTransform.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
            present: next,
            future: []
          });
        }
        setStatus(
          groupTransform.mode === "rotate"
            ? "Rotated selection"
            : groupTransform.mode === "projected-plane-tilt"
              ? "3D rotate applied"
              : "Resized selection"
        );
      }
      groupTransformDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? textResize.latestPoint;
      const changed = commitTextResize(textResize, point);
      clearTextResize(event);
      setStatus(changed ? "Resized text box" : "Text box size unchanged");
      return;
    }

    const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
    if (projectedPlaneTiltDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? projectedPlaneTiltDrag.latestPoint;
      projectedPlaneTiltMachineRef.current = initialInteractionState();
      if (projectedPlaneTiltDrag.dragging) {
        const changed = commitProjectedPlaneTilt(projectedPlaneTiltDrag, point);
        setStatus(changed
          ? "3D rotate applied"
          : "3D rotate canceled");
      } else {
        replacePresentDocument(projectedPlaneTiltDrag.startDocument);
        setProjectedPlaneTiltReadout(undefined);
        setStatus("3D rotate canceled");
      }
      setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
      clearProjectedPlaneTiltDrag(event);
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectRotateDrag.latestPoint;
      if (objectRotateDrag.dragging) {
        const changed = commitObjectRotateDrag(objectRotateDrag, point);
        const object = findDocumentObject(documentRef.current, objectRotateDrag.objectId);
        const label = objectRotateDrag.target ? "selected molecule fragment" : documentObjectTransformLabel(object);
        setStatus(changed ? `Rotated ${label}` : `${capitalizeLabel(label)} rotation unchanged`);
      }
      clearObjectRotateDrag(event);
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectResizeDrag.latestPoint;
      if (objectResizeDrag.dragging) {
        objectResizeDrag.latestScale = objectResizeScaleFromDrag(
          objectResizeDrag.centerPoint,
          objectResizeDrag.startPoint,
          point,
          objectResizeDrag.stretching
        );
        const changed = commitObjectResize(objectResizeDrag, point);
        const object = findDocumentObject(documentRef.current, objectResizeDrag.objectId);
        const targetLabel = objectResizeDrag.target ? "selected molecule fragment" : documentObjectTransformLabel(object);
        setStatus(changed
          ? objectResizeDrag.stretching ? `Stretched ${targetLabel}` : `Resized ${targetLabel}`
          : `${capitalizeLabel(targetLabel)} size unchanged`);
      }
      clearObjectResizeDrag(event);
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicCornerRadiusDrag.latestPoint;
      if (graphicCornerRadiusDrag.dragging) {
        const changed = commitGraphicCornerRadius(graphicCornerRadiusDrag, point);
        setStatus(changed ? "Adjusted corner radius" : "Corner radius unchanged");
      } else {
        setStatus("Selected rounded rectangle");
      }
      clearGraphicCornerRadiusDrag(event);
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicPathEditDrag.latestPoint;
      if (graphicPathEditDrag.dragging) {
        const changed = commitGraphicPathEdit(graphicPathEditDrag, point);
        setStatus(graphicPathEditStatus(graphicPathEditDrag, changed));
      } else {
        setStatus("Selected art path");
      }
      clearGraphicPathEditDrag(event);
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicMarkerDrag.latestPoint;
      if (graphicMarkerDrag.dragging) {
        const changed = commitGraphicMarkerDrag(graphicMarkerDrag, point);
        setStatus(changed ? "Adjusted arrowhead size" : "Arrowhead size unchanged");
      } else {
        setStatus("Selected arrowhead");
      }
      clearGraphicMarkerDrag(event);
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectDrag.latestPoint;
      objectDragMachineRef.current = initialInteractionState();
      if (objectDrag.dragging) {
        const changed = commitObjectDrag(objectDrag, point);
        setStatus(changed ? "Moved selected object" : "Object did not move");
      } else if (objectDrag.bondTarget) {
        cycleNativeBondOrder(objectDrag.bondTarget);
      } else {
        const object = findDocumentObject(documentRef.current, objectDrag.objectId);
        if (shouldOpenMoleculeEditorFromObjectClick(object, activeToolState.activeKind, event.detail)) {
          setActiveEditorObjectId(object.id);
        }
      }
      clearObjectDrag(event);
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? nativePartDrag.latestPoint;
      if (nativePartDrag.dragging) {
        const changed = commitNativePartDrag(nativePartDrag, point);
        setStatus(changed ? "Moved selected molecule part" : "Molecule part did not move");
      }
      clearNativePartDrag(event);
      return;
    }

    const nativePlacementDrag = nativePlacementDragRef.current;
    if (nativePlacementDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? nativePlacementDrag.latestPoint;
      const changed = commitNativePlacementDrag(nativePlacementDrag, point);
      const label = nativePlacementStatusLabel(nativePlacementDrag);
      setStatus(changed
        ? nativePlacementDrag.dragging ? `Inserted rotated ${label}` : `Inserted ${label}`
        : `${capitalizeLabel(label)} not placed`);
      clearNativePlacementDrag(event);
      return;
    }

    const marquee = selectionMarqueeRef.current;
    if (!marquee || marquee.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    const point = pagePointFromPointerEvent(event) ?? marquee.latestPoint;
    marquee.latestPoint = point;
    const wasDragging = marqueeMachineRef.current.phase === "dragging";
    const selection = wasDragging
      ? selectionInSelectionRect(document.pages[0].objects, marquee.startPoint, point)
      : { objectIds: [], nativeSelection: undefined };
    replacePresentDocument((current) => selectDocumentObjects(current, current.pages[0].id, selection.objectIds));
    setSelectedNativeMoleculePart(selection.nativeSelection);
    if (selection.objectIds.length === 0 && !selection.nativeSelection) {
      toolbarStyleTargetRef.current = undefined;
    }
    setSelectionMarquee(undefined);
    selectionMarqueeRef.current = null;
    setStatus(selectionStatusLabel(selection));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [
    activeToolState.activeKind,
    clearNativePartDrag,
    clearObjectDrag,
    clearObjectRotateDrag,
    clearObjectResizeDrag,
    clearGraphicCornerRadiusDrag,
    clearGraphicPathEditDrag,
    clearGraphicMarkerDrag,
    clearProjectedPlaneTiltDrag,
    clearNativePlacementDrag,
    clearTextResize,
    commitGraphicCornerRadius,
    commitGraphicPathEdit,
    commitGraphicMarkerDrag,
    commitNativePlacementDrag,
    commitNativePartDrag,
    commitTextResize,
    commitObjectDrag,
    commitObjectRotateDrag,
    commitObjectResize,
    commitProjectedPlaneTilt,
    cycleNativeBondOrder,
    document.pages,
    groupProjectedPlaneTiltFromDrag,
    groupTransformDocument,
    installDocumentHistory,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handlePagePointerCancel = useCallback((event: ObjectPointerEvent) => {
    const groupTransform = groupTransformDragRef.current;
    if (groupTransform?.pointerId === event.pointerId) {
      if (groupTransform.dragging) {
        replacePresentDocument(groupTransform.startDocument);
      }
      if (groupTransform.mode === "projected-plane-tilt") {
        setStatus("3D rotate canceled");
      }
      groupTransformDragRef.current = null;
      groupTransformMachineRef.current = initialInteractionState();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }

    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      replacePresentDocument(textResize.startDocument);
      clearTextResize(event);
    }

    const projectedPlaneTiltDrag = projectedPlaneTiltDragRef.current;
    if (projectedPlaneTiltDrag?.pointerId === event.pointerId) {
      projectedPlaneTiltMachineRef.current = initialInteractionState();
      if (projectedPlaneTiltDrag.dragging) {
        replacePresentDocument(projectedPlaneTiltDrag.startDocument);
      }
      setSelectedNativeMoleculePart(projectedPlaneTiltDrag.target);
      clearProjectedPlaneTiltDrag(event);
      setProjectedPlaneTiltReadout(undefined);
      setStatus("3D rotate canceled");
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId) {
      objectRotateMachineRef.current = initialInteractionState();
      if (objectRotateDrag.dragging) {
        replacePresentDocument(objectRotateDrag.startDocument);
      }
      clearObjectRotateDrag(event);
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId) {
      if (graphicPathEditDrag.dragging) {
        replacePresentDocument(graphicPathEditDrag.startDocument);
      }
      clearGraphicPathEditDrag(event);
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId) {
      if (graphicMarkerDrag.dragging) {
        replacePresentDocument(graphicMarkerDrag.startDocument);
      }
      clearGraphicMarkerDrag(event);
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.dragging) {
      replacePresentDocument(nativePartDrag.startDocument);
      clearNativePartDrag(event);
    }

    const nativePlacementDrag = nativePlacementDragRef.current;
    if (nativePlacementDrag?.pointerId === event.pointerId) {
      placementMachineRef.current = initialInteractionState();
      replacePresentDocument(nativePlacementDrag.startDocument);
      clearNativePlacementDrag(event);
    }

    const marquee = selectionMarqueeRef.current;
    if (marquee?.pointerId === event.pointerId) {
      marqueeMachineRef.current = initialInteractionState();
      selectionMarqueeRef.current = null;
      setSelectionMarquee(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, [clearGraphicPathEditDrag, clearGraphicMarkerDrag, clearNativePartDrag, clearNativePlacementDrag, clearObjectRotateDrag, clearProjectedPlaneTiltDrag, clearTextResize, replacePresentDocument]);

  const handlePagePointerLeave = useCallback(() => {
    if (nativeBondDragRef.current) {
      return;
    }

    if (nativePlacementDragRef.current) {
      return;
    }

    if (selectionMarqueeRef.current) {
      return;
    }

    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, []);

  const handleObjectPointerDown = useCallback((objectId: string, event: ObjectPointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    const point = pagePointFromPointerEvent(event);
    // Slice 1b: resolve the press by geometry, not by whichever overlapping wrapper the
    // browser happened to deliver the event to. A molecule's rectangular wrapper otherwise
    // swallows a press meant for a molecule beneath it (the rotaxane-overlap bug: hover
    // highlights the lower atom in red but the press selects nothing). This mirrors the hover
    // hit path so click and hover can never disagree. We only re-target among molecules — a
    // press the DOM delivered to a non-molecule object (text, charge mark) is never hijacked —
    // and we move pointer capture to the resolved molecule's wrapper so every drag/up handler
    // (all keyed by objectId) stays consistent with the re-targeted object.
    let captureElement: Element = event.currentTarget;
    if (point && findDocumentObject(document, objectId)?.type === "molecule") {
      const resolved = nativeMoleculeCanvasHoverTarget(
        document,
        point,
        event.target,
        hitToleranceForScale(viewportRef.current.scale)
      );
      if (resolved && resolved.objectId !== objectId) {
        objectId = resolved.objectId;
        const resolvedWrapper = pageRef.current?.querySelector(`[data-object-id="${CSS.escape(objectId)}"]`);
        if (resolvedWrapper) {
          captureElement = resolvedWrapper;
        }
      }
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const chargeMarkActive = object?.type === "electron-mark" && object.markKind === "charge";
    const nativeMoleculeHit = object?.type === "molecule" && point
      ? nativeMoleculeHitFromPointerTarget(
          object,
          point,
          event.target,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : undefined;

    if (activeChargeToolValue && point && !chargeMarkActive) {
      event.stopPropagation();
      if (nativeMoleculeHit?.kind === "atom") {
        addChargeToHoveredNativeAtom(activeChargeToolValue, { objectId, ...nativeMoleculeHit });
        return;
      }

      applyChargeDocumentAtPoint(activeChargeToolValue, point);
      return;
    }

    if (activeToolState.activeCommandId === "tool.text" && object?.type === "text") {
      event.stopPropagation();
      replacePresentDocument((current) => selectDocumentObject(current, objectId));
      restoreToolAfterTextPlacement();
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(objectId);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      setFreeformNativeBond(undefined);
      return;
    }

    if (activeToolState.activeCommandId === "tool.text" && object?.type === "molecule" && point) {
      if (nativeMoleculeHit?.kind === "atom") {
        event.stopPropagation();
        startAtomLabelEdit({ objectId, ...nativeMoleculeHit }, { clearDraft: true });
        return;
      }
    }

    if (activeNativeTemplateId && point) {
      event.preventDefault();
      event.stopPropagation();
      // Commit the highlighted target (parity), not a fresh per-object recompute whose DOM
      // tiebreak can flip a bond-hover into an atom and silently spiro instead of fusing.
      const templateTarget = currentTemplateTargetFromHoverOrHit(
        document,
        { pagePoint: point, toolCommandId: activeToolState.activeCommandId, templateId: activeNativeTemplateId },
        templateHoverTargetRef.current,
        viewportRef.current.scale
      );
      applyNativeTemplateDocumentAtPoint(point, activeNativeTemplateId, templateTarget);
      return;
    }

    if (activeNativeBondDisplayStyle && object?.type === "molecule" && point && nativeMoleculeHit?.kind === "bond") {
      event.preventDefault();
      event.stopPropagation();
      applyNativeBondDisplayStyleDocumentTarget({ objectId, ...nativeMoleculeHit }, activeNativeBondDisplayStyle);
      return;
    }

    if (activeToolState.activeKind === "selection" && object?.type === "molecule" && point) {
      event.preventDefault();
      const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId };
      const doublePress = event.detail >= 2 || isSelectionDoublePress(lastSelectionPressRef.current, press);
      lastSelectionPressRef.current = press;
      if (object.type === "molecule" && doublePress) {
        event.stopPropagation();
        replacePresentDocument((current) => selectDocumentObject(current, objectId));
        clearTransientInteractionChrome();
        setActiveGraphicTransformObjectId(undefined);
        hoveredNativeAtomPointRef.current = undefined;
        setSelectedNativeMoleculePart(undefined);
        setStatus("Selected molecule");
        return;
      }

      if (event.shiftKey && nativeMoleculeHit) {
        event.stopPropagation();
        const nextSelectedNativePart = nativeSelectionWithHitToggled(
          selectedNativeMoleculePart?.objectId === objectId ? selectedNativeMoleculePart : undefined,
          objectId,
          nativeMoleculeHit
        );
        let nextDocument = selectDocumentObjects(document, document.pages[0].id, []);
        if (nextSelectedNativePart) {
          nextDocument = document.selection.objectIds.includes(objectId)
            ? document
            : selectDocumentObject(document, objectId);
        }
        replacePresentDocument(nextDocument);
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveGraphicTransformObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget({ objectId, ...nativeMoleculeHit });
        hoveredNativeAtomPointRef.current = nativeMoleculeHit.kind === "atom" ? { objectId, point } : undefined;
        setSelectedNativeMoleculePart(nextSelectedNativePart);
        setStatus(selectionStatusLabel({
          objectIds: nextSelectedNativePart ? [objectId] : [],
          nativeSelection: nextSelectedNativePart
        }));
        return;
      }

      const dragIntent = nativeMoleculeSelectionDragIntent(document, objectId, selectedNativeMoleculePart, nativeMoleculeHit);
      if (dragIntent.kind === "whole-object") {
        event.stopPropagation();
        const groupObjectIds = document.selection.objectIds.length > 1 &&
          document.selection.objectIds.includes(objectId)
          ? [...document.selection.objectIds]
          : undefined;
        objectDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          startDocument: document,
          startPoint: point,
          latestPoint: point,
          startObjectX: object.x,
          startObjectY: object.y,
          groupObjectIds,
          dragging: false
        };
        captureElement.setPointerCapture(event.pointerId);
        return;
      }

      if (dragIntent.kind === "native-part") {
        event.stopPropagation();
        const selectedDocument = document.selection.objectIds.includes(objectId)
          ? document
          : selectDocumentObject(document, objectId);
        replacePresentDocument(selectedDocument);
        clearTransientInteractionChrome();
        setActiveGraphicTransformObjectId(undefined);
        hoveredNativeAtomPointRef.current = undefined;
        setSelectedNativeMoleculePart(dragIntent.target);
        nativePartDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          target: dragIntent.target,
          startDocument: selectedDocument,
          startPoint: point,
          latestPoint: point,
          dragging: false
        };
        objectDragMachineRef.current = interactionReducer(initialInteractionState(), { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "object", objectId }, dragKind: "object-move" });
        (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
        setStatus(dragIntent.target.kind === "atom"
          ? "Selected atom"
          : dragIntent.target.kind === "bond" ? "Selected bond" : "Selected molecule parts");
        return;
      }

      if (nativeMoleculeHit) {
        event.stopPropagation();
        replacePresentDocument((current) => selectDocumentObject(current, objectId));
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveGraphicTransformObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget({ objectId, ...nativeMoleculeHit });
        hoveredNativeAtomPointRef.current = nativeMoleculeHit.kind === "atom" ? { objectId, point } : undefined;
        setSelectedNativeMoleculePart(nativeSelectionFromHit(objectId, nativeMoleculeHit));
        setStatus(nativeMoleculeHit.kind === "atom" ? "Selected atom" : "Selected bond");
        return;
      }

      return;
    }

    if (object?.type === "molecule" && point && !nativeMoleculeHit) {
      return;
    }

    if (activeToolState.activeKind === "selection" && object?.type === "graphic" && nativeGraphicPathEditPoints(object)) {
      const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId };
      const doublePress = event.detail >= 2 || isSelectionDoublePress(lastSelectionPressRef.current, press);
      lastSelectionPressRef.current = press;
      if (doublePress) {
        event.preventDefault();
        event.stopPropagation();
        const selectedDocument = document.selection.objectIds.includes(objectId)
          ? document
          : selectDocumentObject(document, objectId);
        replacePresentDocument(selectedDocument);
        clearTransientInteractionChrome();
        setSelectedNativeMoleculePart(undefined);
        setActiveGraphicTransformObjectId(objectId);
        setStatus("Selected art object");
        return;
      }
    }

    if (shouldDragDocumentObject(object, activeToolState.activeKind)) {
      event.preventDefault();
      event.stopPropagation();
      if (!shouldActivateDocumentObject(object, "selection")) {
        return;
      }

      const selectedDocument = selectDocumentObject(document, objectId);
      replacePresentDocument(selectedDocument);
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveGraphicTransformObjectId((current) =>
        current === objectId && object?.type === "graphic" && nativeGraphicPathEditPoints(object) ? current : undefined
      );
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      setSelectedNativeMoleculePart(undefined);
      assignHoveredNativeDeleteTarget(undefined);

      if (object && point) {
        objectDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          startDocument: selectedDocument,
          startPoint: point,
          latestPoint: point,
          startObjectX: object.x,
          startObjectY: object.y,
          bondTarget: nativeMoleculeHit?.kind === "bond" ? { objectId, ...nativeMoleculeHit } : undefined,
          dragging: false
        };
        objectDragMachineRef.current = interactionReducer(initialInteractionState(), {
          type: "pointerDown",
          pointerId: event.pointerId,
          world: point,
          target: { kind: "object", objectId },
          dragKind: "object-move"
        });
        captureElement.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (activeToolState.activeCommandId === "tool.bond" && object?.type === "molecule" && point) {
      if (nativeMoleculeHit?.kind === "bond") {
        event.stopPropagation();
        nativeBondEditDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          target: { objectId, ...nativeMoleculeHit },
          startDocument: document,
          startPoint: point,
          latestPoint: point,
          dragging: false
        };
        captureElement.setPointerCapture(event.pointerId);
        return;
      }
    }

    if (activeNativeBondToolStyle && object?.type === "molecule") {
      event.stopPropagation();
      if (!point) {
        return;
      }

      const page = document.pages[0];
      const preview = previewNativeMoleculeBondGrowth(object, point, page.width, page.height);
      if (!preview) {
        applySingleBondDocumentAtPoint(selectDocumentObject(document, objectId), point, activeNativeBondDisplayStyle);
        return;
      }

      nativeBondDragRef.current = {
        pointerId: event.pointerId,
        objectId,
        atomId: preview.atomId,
        bondStyle: activeNativeBondDisplayStyle,
        startPoint: point,
        latestPoint: point,
        dragging: false,
        freeformUnlocked: false
      };
      captureElement.setPointerCapture(event.pointerId);
      setHoveredNativeAtom({
        objectId,
        atomId: preview.atomId,
        direction: preview.direction,
        candidateDirections: preview.candidateDirections,
        newAtomPoint: preview.newAtomPoint
      });
      setFreeformNativeBond(undefined);
      return;
    }

    event.stopPropagation();
    if (!shouldActivateDocumentObject(object, activeToolState.activeKind)) {
      return;
    }

    replacePresentDocument((current) => selectDocumentObject(current, objectId));
    setActiveEditorObjectId(object?.type === "molecule" ? object.id : undefined);
    setActiveTextEditObjectId(undefined);
    setActiveGraphicTransformObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
  }, [
    activeToolState.activeCommandId,
    activeToolState.activeKind,
    activeChargeToolValue,
    activeNativeBondDisplayStyle,
    activeNativeBondToolStyle,
    activeNativeTemplateId,
    addChargeToHoveredNativeAtom,
    assignHoveredNativeDeleteTarget,
    applyChargeDocumentAtPoint,
    applyNativeBondDisplayStyleDocumentTarget,
    applyNativeTemplateDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    cycleNativeBondOrder,
    document,
    pagePointFromPointerEvent,
    replacePresentDocument,
    restoreToolAfterTextPlacement,
    selectedNativeMoleculePart,
    startAtomLabelEdit
  ]);

  function isTransformHandleSecondPress(
    objectId: string,
    handleKind: TransformHandlePressKind,
    event: PointerEvent<HTMLButtonElement>
  ): boolean {
    const current = {
      time: Date.now(),
      x: event.clientX,
      y: event.clientY,
      objectId,
      handleKind
    };
    const isDouble = (event.detail ?? 0) >= 2 ||
      isTransformHandleDoublePress(lastTransformHandlePressRef.current, current);
    lastTransformHandlePressRef.current = current;
    return isDouble;
  }

  const openObjectRotateInput = useCallback((objectId: string): boolean => {
    if (activeToolState.activeKind !== "selection") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const selectedFragmentTarget = object?.type === "molecule" && selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canOpenRotationEntry = object && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) && (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canOpenRotationEntry) {
      setStatus("Select an object for rotation entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const targetLabel = selectedFragmentTarget
      ? "selected molecule fragment"
      : object.type === "molecule" ? "selected molecule" : "selected art object";
    const homeZDegrees = rotationInputDraftDegrees(
      object.type === "molecule" ? nativeMoleculeTransformState(object).rotationDegrees : object.rotation
    );
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    updateObjectResizeInput(undefined);
    updateRotationInput({
      kind: "z",
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      startDocument: currentDocument,
      draftZDegrees: homeZDegrees,
      homeZDegrees
    });
    setStatus("Z rotation entry");
    return true;
  }, [activeToolState.activeKind, selectedNativeMoleculePart, updateObjectResizeInput, updateRotationInput]);

  const handleObjectRotatePointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object && documentObjectSupportsArtTransform(object) && isTransformHandleSecondPress(objectId, "rotate-z", event)) {
      openObjectRotateInput(objectId);
      return;
    }
    const point = pagePointFromPointerEvent(event);
    const selectedFragmentTarget = object?.type === "molecule" && selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canRotateObject =
      object?.type === "text" ||
      (object !== undefined && documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)) ||
      (object?.type === "molecule" && (
        isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
        selectedFragmentBounds !== undefined
      ));
    if (!object || !point || !canRotateObject) {
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? currentDocument
      : currentDocument.selection.objectIds.includes(objectId)
        ? currentDocument
        : selectDocumentObject(currentDocument, objectId);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    replacePresentDocument(selectedDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(selectedFragmentTarget);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    objectRotateDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      target: selectedFragmentTarget,
      startDocument: selectedDocument,
      centerPoint: selectedFragmentBounds
        ? documentObjectCenter(selectedFragmentBounds)
        : object.type === "molecule" ? nativeMoleculeCenter(object) : documentObjectCenter(object),
      startPoint: point,
      startRotationDegrees: object.type === "molecule"
        ? selectedFragmentTarget ? 0 : nativeMoleculeTransformState(object).rotationDegrees
        : object.rotation,
      latestPoint: point,
      dragging: false
    };
    objectRotateMachineRef.current = interactionReducer(initialInteractionState(), { type: "pointerDown", pointerId: event.pointerId, world: point, target: { kind: "object", objectId }, dragKind: "object-rotate" });
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(
      object.type === "text"
        ? "Rotate selected text box"
        : object.type === "molecule"
          ? selectedFragmentTarget ? "Rotate selected molecule fragment" : "Rotate selected molecule"
          : "Rotate selected art object"
    );
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument,
    openObjectRotateInput,
    selectedNativeMoleculePart,
  ]);

  const handleObjectRotateDoubleClick = useCallback((objectId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openObjectRotateInput(objectId);
  }, [openObjectRotateInput]);

  const openProjectedPlaneTiltInput = useCallback((objectId: string): boolean => {
    if (activeToolState.activeKind !== "selection") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canOpenTiltEntry = object && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) && (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canOpenTiltEntry) {
      setStatus("Select an object for X/Y rotation entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const transform = object.type === "molecule"
      ? nativeMoleculeTransformState(object)
      : {
          ...documentObjectProjectedPlaneTilt(object),
          rotationDegrees: object.rotation
        };
    const targetLabel = selectedFragmentTarget
      ? "selected molecule fragment"
      : object.type === "molecule" ? "selected molecule" : "selected art object";
    const homeXDegrees = rotationInputDraftDegrees(selectedFragmentTarget ? 0 : transform.tiltXDegrees ?? 0);
    const homeYDegrees = rotationInputDraftDegrees(selectedFragmentTarget ? 0 : transform.tiltYDegrees ?? 0);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    updateObjectResizeInput(undefined);
    updateRotationInput({
      kind: "xy",
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      startDocument: currentDocument,
      draftXDegrees: homeXDegrees,
      draftYDegrees: homeYDegrees,
      homeXDegrees,
      homeYDegrees
    });
    setStatus("3D rotation entry");
    return true;
  }, [activeToolState.activeKind, selectedNativeMoleculePart, updateObjectResizeInput, updateRotationInput]);

  const handleProjectedPlaneTiltPointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object && documentObjectSupportsArtTransform(object) && isTransformHandleSecondPress(objectId, "rotate-xy", event)) {
      openProjectedPlaneTiltInput(objectId);
      return;
    }
    const point = pagePointFromPointerEvent(event);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canTiltObject = object && point && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) &&
          object.atoms.length > 0 &&
          (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canTiltObject || !object || !point) {
      setStatus("Select an object for X/Y rotate");
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? currentDocument
      : currentDocument.selection.objectIds.includes(objectId)
        ? currentDocument
        : selectDocumentObject(currentDocument, objectId);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    replacePresentDocument(selectedDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(selectedFragmentTarget);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    setProjectedPlaneTiltReadout(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    const transform = object.type === "molecule"
      ? nativeMoleculeTransformState(object)
      : {
          ...documentObjectProjectedPlaneTilt(object),
          rotationDegrees: object.rotation
        };
    const startTiltXRad = selectedFragmentTarget
      ? 0
      : (transform.tiltXDegrees ?? 0) * Math.PI / 180;
    const startTiltYRad = selectedFragmentTarget
      ? 0
      : (transform.tiltYDegrees ?? 0) * Math.PI / 180;
    const startRotationDegrees = selectedFragmentTarget ? 0 : transform.rotationDegrees;
    projectedPlaneTiltDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      target: selectedFragmentTarget,
      startDocument: selectedDocument,
      centerPoint: selectedFragmentBounds
        ? documentObjectCenter(selectedFragmentBounds)
        : object.type === "molecule" ? nativeMoleculeCenter(object) : documentObjectCenter(object),
      axisAngleRad: 0,
      startPoint: point,
      startTiltXRad,
      startTiltYRad,
      startRotationDegrees,
      latestPoint: point,
      latestTiltXRad: startTiltXRad,
      latestTiltYRad: startTiltYRad,
      clamped: false,
      dragging: false
    };
    projectedPlaneTiltMachineRef.current = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: event.pointerId,
      world: point,
      target: { kind: "object", objectId },
      dragKind: "projected-plane-tilt"
    });
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(selectedFragmentTarget
      ? "3D rotate: drag to tilt/twist selected fragment"
      : object.type === "molecule" ? "3D rotate: drag to tilt/twist" : "X/Y rotate selected art object");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    openProjectedPlaneTiltInput,
    replacePresentDocument,
    selectedNativeMoleculePart,
  ]);

  const handleProjectedPlaneTiltDoubleClick = useCallback((objectId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectedPlaneTiltInput(objectId);
  }, [openProjectedPlaneTiltInput]);

  const openObjectResizeInput = useCallback((objectId: string, corner: ObjectResizeCorner): boolean => {
    if (activeToolState.activeKind !== "selection") {
      return false;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canOpenResizeEntry = object && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : isNativeMoleculeGraph(object) && (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canOpenResizeEntry) {
      setStatus("Select an object for stretch entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const transform = object.type === "molecule" ? nativeMoleculeTransformState(object) : undefined;
    const targetLabel = selectedFragmentTarget
      ? "selected molecule fragment"
      : object.type === "molecule" ? "selected molecule" : "selected art object";
    const homeXPercent = objectResizeInputDraftPercent(selectedFragmentTarget ? 1 : transform?.scaleX ?? 1);
    const homeYPercent = objectResizeInputDraftPercent(selectedFragmentTarget ? 1 : transform?.scaleY ?? 1);
    updateRotationInput(undefined);
    setObjectResizeReadout(undefined);
    updateObjectResizeInput({
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      corner,
      startDocument: currentDocument,
      draftXPercent: homeXPercent,
      draftYPercent: homeYPercent,
      homeXPercent,
      homeYPercent
    });
    setStatus("Stretch entry");
    return true;
  }, [activeToolState.activeKind, selectedNativeMoleculePart, updateObjectResizeInput, updateRotationInput]);

  const handleGraphicCornerRadiusPointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable if the browser has already canceled the press.
    }

    const point = pagePointFromPointerEvent(event);
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const editPoint = object?.type === "graphic" ? nativeGraphicCornerRadiusEditPoint(object) : undefined;
    if (!point || object?.type !== "graphic" || !editPoint) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    replacePresentDocument(selectedDocument);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setGraphicCornerRadiusReadout({
      objectId,
      radius: graphicCornerRadiusReadoutValue(object)
    });
    graphicCornerRadiusDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      startDocument: selectedDocument,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus("Adjust selected rectangle corner radius");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handleGraphicCornerRadiusDoubleClick = useCallback((objectId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object?.type !== "graphic" || !nativeGraphicCornerRadiusEditPoint(object)) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    const currentRadius = graphicCornerRadiusReadoutValue(object);
    const nextRadius = currentRadius <= 0.001 ? maxGraphicCornerRadius(object) : 0;
    const edited = updateNativeGraphicCornerRadius(selectedDocument, objectId, { x: nextRadius, y: 0 });
    if (edited === selectedDocument) {
      replacePresentDocument(selectedDocument);
      setStatus("Corner radius unchanged");
      return;
    }

    const currentHistory = documentHistoryRef.current;
    installDocumentHistory({
      past: [...currentHistory.past, selectedDocument].slice(-DOCUMENT_HISTORY_LIMIT),
      present: edited,
      future: []
    });
    setGraphicCornerRadiusReadout({
      objectId,
      radius: nextRadius
    });
    setStatus(nextRadius <= 0.001 ? "Reset corner radius" : "Maxed corner radius");
  }, [activeToolState.activeKind, installDocumentHistory, replacePresentDocument]);

  const handleGraphicPathEditPointerDown = useCallback((
    objectId: string,
    handle: NativeGraphicPathEditHandle,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable if the browser has already canceled the press.
    }

    const point = pagePointFromPointerEvent(event);
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const editPoints = object?.type === "graphic" ? nativeGraphicPathEditPoints(object) : undefined;
    if (!point || object?.type !== "graphic" || !editPoints) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    replacePresentDocument(selectedDocument);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    graphicPathEditDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      handle,
      startDocument: selectedDocument,
      workingDocument: selectedDocument,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(isSemanticCircularGraphicArc(object, editPoints)
      ? handle === "middle" ? "Adjust selected arc radius" : "Adjust selected arc sweep"
      : handle === "middle" ? "Bend selected line into a curve" : "Adjust selected line endpoint");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handleGraphicMarkerPointerDown = useCallback((
    objectId: string,
    markerId: NativeGraphicMarkerHandleId,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can be unavailable if the browser has already canceled the press.
    }

    const point = pagePointFromPointerEvent(event);
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const plan = object?.type === "graphic" ? planNativeArtVisual(object, { coordinateSpace: "local" }) : undefined;
    if (!point || object?.type !== "graphic" || !plan?.markerHandles.some((handle) => handle.id === markerId)) {
      return;
    }

    const selectedDocument = currentDocument.selection.objectIds.includes(objectId)
      ? currentDocument
      : selectDocumentObject(currentDocument, objectId);
    replacePresentDocument(selectedDocument);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    graphicMarkerDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      markerId,
      startDocument: selectedDocument,
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(markerId === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handleObjectResizePointerDown = useCallback((
    objectId: string,
    corner: ObjectResizeCorner,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    if (object && documentObjectSupportsArtTransform(object) && isTransformHandleSecondPress(objectId, `resize-${corner}`, event)) {
      openObjectResizeInput(objectId, corner);
      return;
    }
    const point = pagePointFromPointerEvent(event);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    const canResizeObject = object && point && (
      object.type !== "molecule"
        ? documentObjectSupportsArtTransform(object) && currentDocument.selection.objectIds.includes(objectId)
        : object.atoms.length > 0 &&
          (
            isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart) ||
            selectedFragmentBounds !== undefined
          )
    );
    if (!canResizeObject || !object || !point) {
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? currentDocument
      : currentDocument.selection.objectIds.includes(objectId)
        ? currentDocument
        : selectDocumentObject(currentDocument, objectId);
    handleRotationInputKeep();
    handleObjectResizeInputKeep();
    replacePresentDocument(selectedDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(selectedFragmentTarget);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    const transform = object.type === "molecule" ? nativeMoleculeTransformState(object) : undefined;
    const startCumulativeScale = selectedFragmentTarget
      ? { x: 1, y: 1 }
      : {
          x: transform?.scaleX ?? 1,
          y: transform?.scaleY ?? 1
        };
    objectResizeDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      target: selectedFragmentTarget,
      corner,
      startDocument: selectedDocument,
      centerPoint: selectedFragmentBounds ? documentObjectCenter(selectedFragmentBounds) : documentObjectCenter(object),
      startPoint: point,
      startCumulativeScale,
      latestPoint: point,
      latestScale: { x: 1, y: 1 },
      latestCumulativeScale: startCumulativeScale,
      stretching: event.shiftKey,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(selectedFragmentTarget
      ? "Resize selected molecule fragment"
      : object.type === "molecule" ? "Resize selected molecule" : "Resize selected art object");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    handleObjectResizeInputKeep,
    handleRotationInputKeep,
    openObjectResizeInput,
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart,
  ]);

  const handleObjectResizeDoubleClick = useCallback((
    objectId: string,
    corner: ObjectResizeCorner,
    event: ReactMouseEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openObjectResizeInput(objectId, corner);
  }, [openObjectResizeInput]);

  const handleObjectContextMenu = useCallback((objectId: string, event: ObjectMouseEvent) => {
    const currentDocument = documentRef.current;
    const point = pagePointFromPointerEvent(event);
    const crossingHit = point ? findNearestCrossingHit(pageSvgRenderPlan.crossings, point) : undefined;

    // Resolve by geometry before crossing actions, so a right-click at a weave still acts
    // on the atom/bond under the pointer. Crossing state is secondary menu context.
    const resolvedNativeHit = point
      ? nativeMoleculeCanvasHoverTarget(
          currentDocument,
          point,
          event.target,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : undefined;
    let nativeMoleculeHit: NativeMoleculeDeleteHit | undefined;
    if (resolvedNativeHit) {
      objectId = resolvedNativeHit.objectId;
      nativeMoleculeHit = resolvedNativeHit.kind === "atom"
        ? {
            kind: "atom",
            atomId: resolvedNativeHit.atomId,
            distanceToPointer: resolvedNativeHit.distanceToPointer
          }
        : {
            kind: "bond",
            bondId: resolvedNativeHit.bondId,
            fromAtomId: resolvedNativeHit.fromAtomId,
            toAtomId: resolvedNativeHit.toAtomId,
            distanceToPointer: resolvedNativeHit.distanceToPointer
          };
    } else if (crossingHit) {
      objectId = crossingHit.front.objectId;
    }
    const object = findDocumentObject(currentDocument, objectId);
    nativeMoleculeHit ??= object?.type === "molecule" && point
      ? nativeMoleculeHitFromPointerTarget(
          object,
          point,
          event.target,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : undefined;
    let nextSelectedNativePart: NativeMoleculeSelectionPart | undefined;
    let targetKind: ObjectContextMenuState["targetKind"] = "object";

    if (object?.type === "molecule" && nativeMoleculeHit) {
      const selectionResolution = nativeContextMenuSelectionResolutionFromHit(
        currentDocument,
        objectId,
        nativeMoleculeHit,
        selectedNativeMoleculePart
      );
      nextSelectedNativePart = selectionResolution.selectedPart;
      targetKind = selectionResolution.targetKind;
    } else if (object?.type === "molecule" && !nativeMoleculeHit) {
      return;
    }

    if (!object || !shouldActivateDocumentObject(object, "selection")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    replacePresentDocument((current) => selectDocumentObject(current, objectId));
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(nextSelectedNativePart);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setObjectContextMenu({
      objectId,
      targetKind,
      bondDepthContext: bondDepthContextFromNativeSelection(nextSelectedNativePart, pageSvgRenderPlan.crossings),
      x: event.clientX,
      y: event.clientY
    });
    setStatus(crossingHit && targetKind !== "object"
        ? "Layer and bond depth options for selected molecule part"
        : targetKind === "object" ? "Layer options for selected object" : "Layer options for selected molecule part");
  }, [
    assignHoveredNativeDeleteTarget,
    pagePointFromPointerEvent,
    pageSvgRenderPlan.crossings,
    replacePresentDocument,
    selectedNativeMoleculePart
  ]);

  const handleObjectPointerMove = useCallback((objectId: string, event: ObjectPointerEvent) => {
    event.stopPropagation();
    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId && textResize.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (point) {
        previewTextResize(textResize, point);
      }
      return;
    }

    const editDrag = nativeBondEditDragRef.current;
    if (editDrag?.pointerId === event.pointerId && editDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      editDrag.latestPoint = point;
      setNativeDoubleBondSidePreview(undefined);
      if (!editDrag.dragging && clientPointDistance(editDrag.startPoint, point) >= DOUBLE_BOND_SIDE_DRAG_THRESHOLD) {
        editDrag.dragging = true;
      }
      if (editDrag.dragging) {
        previewNativeDoubleBondSideDrag(editDrag, point);
      }
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      nativePartDrag.latestPoint = point;
      if (!nativePartDrag.dragging && clientPointDistance(nativePartDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        nativePartDrag.dragging = true;
        clearTransientInteractionChrome();
      }

      if (nativePartDrag.dragging) {
        previewNativePartDrag(nativePartDrag, point);
      }
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId && objectRotateDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectRotateDrag.latestPoint = point;
      objectRotateMachineRef.current = interactionReducer(objectRotateMachineRef.current, { type: "pointerMove", pointerId: event.pointerId, world: point, target: { kind: "empty" } });
      const nowDragging = objectRotateMachineRef.current.phase === "dragging";
      if (!objectRotateDrag.dragging && nowDragging) {
        objectRotateDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectRotateDrag.dragging) {
        previewObjectRotateDrag(objectRotateDrag, point);
      }
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId && objectResizeDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectResizeDrag.latestPoint = point;
      if (!objectResizeDrag.dragging && clientPointDistance(objectResizeDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        objectResizeDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectResizeDrag.dragging) {
        previewObjectResize(objectResizeDrag, point, event.shiftKey);
      }
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId && graphicCornerRadiusDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicCornerRadiusDrag.latestPoint = point;
      if (!graphicCornerRadiusDrag.dragging && clientPointDistance(graphicCornerRadiusDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicCornerRadiusDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicCornerRadiusDrag.dragging) {
        previewGraphicCornerRadius(graphicCornerRadiusDrag, point);
      }
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId && graphicPathEditDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicPathEditDrag.latestPoint = point;
      if (
        !graphicPathEditDrag.dragging &&
        (
          graphicPathEditDrag.handle === "middle" ||
          clientPointDistance(graphicPathEditDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD
        )
      ) {
        graphicPathEditDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicPathEditDrag.dragging) {
        previewGraphicPathEdit(graphicPathEditDrag, point);
      }
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId && graphicMarkerDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      graphicMarkerDrag.latestPoint = point;
      if (!graphicMarkerDrag.dragging && clientPointDistance(graphicMarkerDrag.startPoint, point) >= GRAPHIC_HANDLE_DRAG_THRESHOLD) {
        graphicMarkerDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (graphicMarkerDrag.dragging) {
        previewGraphicMarkerDrag(graphicMarkerDrag, point);
      }
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      objectDrag.latestPoint = point;
      if (!objectDrag.dragging && clientPointDistance(objectDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        objectDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (objectDrag.dragging) {
        previewObjectDrag(objectDrag, point);
      }
      return;
    }

    const drag = nativeBondDragRef.current;
    if (drag?.pointerId === event.pointerId && drag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      if (!drag.dragging && clientPointDistance(drag.startPoint, point) >= FREEFORM_BOND_DRAG_THRESHOLD) {
        drag.dragging = true;
        setHoveredNativeAtom(undefined);
      }

      if (drag.dragging) {
        updateFreeformBondPreview(document, drag, point);
      } else {
        updateBondGrowthPreview(document, point);
      }
      return;
    }

    updateNativeCanvasHover(document, pagePointFromPointerEvent(event), event.target);
  }, [
    assignHoveredNativeDeleteTarget,
    document,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
    previewObjectResize,
    previewGraphicCornerRadius,
    previewGraphicPathEdit,
    previewGraphicMarkerDrag,
    previewNativeDoubleBondSideDrag,
    previewNativePartDrag,
    previewTextResize,
    updateFreeformBondPreview,
    updateNativeCanvasHover
  ]);

  const handleObjectPointerUp = useCallback((objectId: string, event: ObjectPointerEvent) => {
    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId && textResize.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? textResize.latestPoint;
      const changed = commitTextResize(textResize, point);
      clearTextResize(event);
      setStatus(changed ? "Resized text box" : "Text box size unchanged");
      return;
    }

    const editDrag = nativeBondEditDragRef.current;
    if (editDrag?.pointerId === event.pointerId && editDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? editDrag.latestPoint;
      if (editDrag.dragging) {
        const changed = commitNativeDoubleBondSideDrag(editDrag, point);
        if (changed) {
          clearTransientInteractionChrome();
        }
        setStatus(changed ? "Moved double bond line" : "Double bond side unchanged");
      } else {
        cycleNativeBondOrder(editDrag.target);
      }
      clearNativeBondEditDrag(event);
      return;
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? nativePartDrag.latestPoint;
      if (nativePartDrag.dragging) {
        const changed = commitNativePartDrag(nativePartDrag, point);
        setStatus(changed ? "Moved selected molecule part" : "Molecule part did not move");
      }
      clearNativePartDrag(event);
      return;
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId && objectRotateDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectRotateDrag.latestPoint;
      if (objectRotateDrag.dragging) {
        const changed = commitObjectRotateDrag(objectRotateDrag, point);
        const object = findDocumentObject(documentRef.current, objectRotateDrag.objectId);
        const label = documentObjectTransformLabel(object);
        setStatus(changed ? `Rotated ${label}` : `${capitalizeLabel(label)} rotation unchanged`);
      }
      clearObjectRotateDrag(event);
      return;
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId && objectResizeDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectResizeDrag.latestPoint;
      if (objectResizeDrag.dragging) {
        objectResizeDrag.latestScale = objectResizeScaleFromDrag(
          objectResizeDrag.centerPoint,
          objectResizeDrag.startPoint,
          point,
          objectResizeDrag.stretching
        );
        const changed = commitObjectResize(objectResizeDrag, point);
        const object = findDocumentObject(documentRef.current, objectResizeDrag.objectId);
        const label = documentObjectTransformLabel(object);
        setStatus(changed
          ? objectResizeDrag.stretching ? `Stretched ${label}` : `Resized ${label}`
          : `${capitalizeLabel(label)} size unchanged`);
      }
      clearObjectResizeDrag(event);
      return;
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId && graphicCornerRadiusDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicCornerRadiusDrag.latestPoint;
      if (graphicCornerRadiusDrag.dragging) {
        const changed = commitGraphicCornerRadius(graphicCornerRadiusDrag, point);
        setStatus(changed ? "Adjusted corner radius" : "Corner radius unchanged");
      } else {
        setStatus("Selected rounded rectangle");
      }
      clearGraphicCornerRadiusDrag(event);
      return;
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId && graphicPathEditDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicPathEditDrag.latestPoint;
      if (graphicPathEditDrag.dragging) {
        const changed = commitGraphicPathEdit(graphicPathEditDrag, point);
        setStatus(graphicPathEditStatus(graphicPathEditDrag, changed));
      } else {
        setStatus("Selected art path");
      }
      clearGraphicPathEditDrag(event);
      return;
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId && graphicMarkerDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? graphicMarkerDrag.latestPoint;
      if (graphicMarkerDrag.dragging) {
        const changed = commitGraphicMarkerDrag(graphicMarkerDrag, point);
        setStatus(changed ? "Adjusted arrowhead size" : "Arrowhead size unchanged");
      } else {
        setStatus("Selected arrowhead");
      }
      clearGraphicMarkerDrag(event);
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectDrag.latestPoint;
      if (objectDrag.dragging) {
        const changed = commitObjectDrag(objectDrag, point);
        setStatus(changed ? "Moved selected object" : "Object did not move");
      } else if (objectDrag.bondTarget) {
        cycleNativeBondOrder(objectDrag.bondTarget);
      } else {
        const object = findDocumentObject(documentRef.current, objectId);
        if (shouldOpenMoleculeEditorFromObjectClick(object, activeToolState.activeKind, event.detail)) {
          setActiveEditorObjectId(object.id);
        }
      }
      clearObjectDrag(event);
      return;
    }

    const drag = nativeBondDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.objectId !== objectId) {
      return;
    }

    event.stopPropagation();
    const point = pagePointFromPointerEvent(event) ?? drag.latestPoint;
    const selectedDocument = selectDocumentObject(document, objectId);
    if (drag.dragging) {
      applyFreeformBondDocumentAtPoint(selectedDocument, objectId, drag.atomId, point, drag.freeformUnlocked, drag.bondStyle);
    } else {
      applySingleBondDocumentAtPoint(selectedDocument, point, drag.bondStyle);
    }
    clearNativeBondDrag(event);
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    applyFreeformBondDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    clearNativeBondEditDrag,
    clearNativeBondDrag,
    clearNativePartDrag,
    clearObjectDrag,
    clearObjectRotateDrag,
    clearObjectResizeDrag,
    clearGraphicCornerRadiusDrag,
    clearGraphicPathEditDrag,
    clearGraphicMarkerDrag,
    clearTextResize,
    commitGraphicPathEdit,
    commitGraphicMarkerDrag,
    commitNativeDoubleBondSideDrag,
    commitNativePartDrag,
    commitObjectResize,
    commitGraphicCornerRadius,
    commitTextResize,
    commitObjectDrag,
    commitObjectRotateDrag,
    cycleNativeBondOrder,
    document,
    pagePointFromPointerEvent
  ]);

  const handleObjectPointerCancel = useCallback((event: ObjectPointerEvent) => {
    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      replacePresentDocument(textResize.startDocument);
      clearTextResize(event);
    }

    const editDrag = nativeBondEditDragRef.current;
    if (editDrag?.pointerId === event.pointerId && editDrag.dragging) {
      replacePresentDocument(editDrag.startDocument);
    }

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId && nativePartDrag.dragging) {
      replacePresentDocument(nativePartDrag.startDocument);
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId && objectRotateDrag.dragging) {
      replacePresentDocument(objectRotateDrag.startDocument);
    }

    const objectResizeDrag = objectResizeDragRef.current;
    if (objectResizeDrag?.pointerId === event.pointerId && objectResizeDrag.dragging) {
      replacePresentDocument(objectResizeDrag.startDocument);
      setObjectResizeReadout(undefined);
    }

    const graphicCornerRadiusDrag = graphicCornerRadiusDragRef.current;
    if (graphicCornerRadiusDrag?.pointerId === event.pointerId && graphicCornerRadiusDrag.dragging) {
      replacePresentDocument(graphicCornerRadiusDrag.startDocument);
    }

    const graphicPathEditDrag = graphicPathEditDragRef.current;
    if (graphicPathEditDrag?.pointerId === event.pointerId && graphicPathEditDrag.dragging) {
      replacePresentDocument(graphicPathEditDrag.startDocument);
    }

    const graphicMarkerDrag = graphicMarkerDragRef.current;
    if (graphicMarkerDrag?.pointerId === event.pointerId && graphicMarkerDrag.dragging) {
      replacePresentDocument(graphicMarkerDrag.startDocument);
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.dragging) {
      replacePresentDocument(objectDrag.startDocument);
    }
    clearNativePartDrag(event);
    clearObjectRotateDrag(event);
    clearObjectResizeDrag(event);
    clearGraphicCornerRadiusDrag(event);
    clearGraphicPathEditDrag(event);
    clearGraphicMarkerDrag(event);
    clearObjectDrag(event);
    clearNativeBondEditDrag(event);
    clearNativeBondDrag(event);
    setHoveredNativeAtom(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, [
    assignHoveredNativeDeleteTarget,
    clearNativeBondDrag,
    clearNativeBondEditDrag,
    clearNativePartDrag,
    clearGraphicCornerRadiusDrag,
    clearGraphicPathEditDrag,
    clearGraphicMarkerDrag,
    clearObjectResizeDrag,
    clearObjectDrag,
    clearObjectRotateDrag,
    clearTextResize,
    replacePresentDocument
  ]);

  const handleObjectPointerLeave = useCallback((objectId: string) => {
    if (
      nativeBondDragRef.current?.objectId === objectId ||
      nativeBondEditDragRef.current?.objectId === objectId ||
      nativePartDragRef.current?.objectId === objectId ||
      objectDragRef.current?.objectId === objectId ||
      graphicCornerRadiusDragRef.current?.objectId === objectId ||
      graphicPathEditDragRef.current?.objectId === objectId ||
      graphicMarkerDragRef.current?.objectId === objectId ||
      objectRotateDragRef.current?.objectId === objectId ||
      objectResizeDragRef.current?.objectId === objectId
    ) {
      return;
    }

    setHoveredNativeAtom((current) => current?.objectId === objectId ? undefined : current);
    setNativeDoubleBondSidePreview((current) => current?.objectId === objectId ? undefined : current);
    assignHoveredNativeDeleteTarget(
      hoveredNativeDeleteTargetRef.current?.objectId === objectId ? undefined : hoveredNativeDeleteTargetRef.current
    );
  }, [assignHoveredNativeDeleteTarget]);

  const handleApplyKetcherEdit = useCallback((result: Parameters<typeof applyEditorSaveResultToSelectedMolecule>[1]) => {
    commitDocumentChange((current) => applyEditorSaveResultToSelectedMolecule(current, result));
  }, [commitDocumentChange]);

  return (
    <main
      className={["app-shell", effectiveNativePalette ? "native-shell" : "web-shell"].join(" ")}
      aria-label="ChemDraft desktop workspace"
      data-active-tool={activeToolState.activeCommandId}
      data-active-tool-kind={activeToolState.activeKind}
      data-can-undo={canUndo ? "true" : "false"}
      data-can-redo={canRedo ? "true" : "false"}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".chemdraft,.cdxml,.xml,.json,chemical/x-cdxml,application/xml,text/xml,application/json,application/vnd.chemdraft+json"
        className="native-file-input"
        aria-label="Open native ChemDraft document"
        onChange={handleOpenFile}
      />

      {!effectiveNativePalette
        ? visibleFloatingToolsets.map((toolset) => {
            const position = webPalettePositions[toolset.id] ?? defaultToolsetPosition(toolset.id, toolsetRegistry);
            return (
              <section
                className="web-floating-palette"
                aria-label={`Floating ${toolset.title}`}
                data-floating-palette="web-preview"
                data-toolset-id={toolset.id}
                key={toolset.id}
                style={
                  {
                    "--palette-x": `${position.x}px`,
                    "--palette-y": `${position.y}px`,
                    "--palette-width": `${toolset.preferredWindowSize?.width ?? 96}px`
                  } as CSSProperties
                }
                onPointerDown={(event) => startWebPaletteDrag(toolset.id, event)}
                onPointerMove={moveWebPalette}
                onPointerUp={stopWebPaletteDrag}
                onPointerCancel={stopWebPaletteDrag}
              >
                <div
                  className="palette-title"
                  data-palette-title-drag-surface="true"
                  data-web-palette-drag-region="true"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    startWebPaletteDrag(toolset.id, event);
                  }}
                  onPointerMove={moveWebPalette}
                  onPointerUp={stopWebPaletteDrag}
                  onPointerCancel={stopWebPaletteDrag}
                >
                  <span className="palette-title-label">{toolset.title.replace(/ Toolbar$/, "")}</span>
                </div>
                <ToolPalette
                  groups={getToolsetCommandGroups(toolset.id, toolsetRegistry)}
                  activeTool={activeTool}
                  mode="floating"
                  orientation={toolset.gridLayout?.orientation ?? "vertical"}
                  title={toolset.title}
                  showMainStyleControls={toolset.id === "core.main"}
                  showTextStyleControls={toolset.id === "core.text"}
                  showArtStyleControls={toolset.id === "core.art"}
                  currentObjectColor={currentToolbarObjectColor}
                  currentArtStyle={currentArtStyle}
                  currentArtStyleTarget={activeArtPaintTarget}
                  currentTextStyle={currentToolbarTextStyle}
                  currentTextScript={currentToolbarTextScript}
                  onArtStylePreview={previewObjectStyleCommand}
                  onArtStyleCommit={commitObjectStylePreview}
                  onArtStyleCancel={cancelObjectStylePreview}
                  onInvoke={invoke}
                />
              </section>
            );
          })
        : null}

      <section className="workspace">
        <section
          ref={canvasRegionRef}
          className={["canvas-region", rulersVisible ? "rulers-visible" : ""].filter(Boolean).join(" ")}
          aria-label="Document workspace"
          data-zoom-surface="document"
        >
          {rulersVisible ? (
            <DocumentRulers
              viewport={viewport}
              frame={rulerFrame}
              pageWidth={activePage.width}
              pageHeight={activePage.height}
            />
          ) : null}
          <div className="page-stage" style={{ ...viewportCssVars(viewport), ...pageCssVars } as CSSProperties}>
            <div className="document-board without-rulers">
              <div
                ref={pageRef}
                className={["page", crosshairsVisible ? "crosshairs-visible" : "crosshairs-hidden"].join(" ")}
                aria-label={document.title}
                onPointerDown={handlePagePointerDown}
                onPointerMove={handlePagePointerMove}
                onPointerUp={handlePagePointerUp}
                onPointerCancel={handlePagePointerCancel}
                onPointerLeave={handlePagePointerLeave}
                onContextMenu={handlePageContextMenu}
              >
                {crosshairsVisible ? (
                  <CrosshairOverlay
                    horizontalTicks={horizontalCrosshairTicks}
                    verticalTicks={verticalCrosshairTicks}
                  />
                ) : null}
                <PageSvgSurface
                  ariaLabel={document.title}
                  pageHeight={activePage.height}
                  pageWidth={activePage.width}
                  plan={pageSvgRenderPlan}
                  onContextMenu={handleObjectContextMenu}
                  onPointerCancel={handleObjectPointerCancel}
                  onPointerDown={handleObjectPointerDown}
                  onPointerLeave={handleObjectPointerLeave}
                  onPointerMove={handleObjectPointerMove}
                  onPointerUp={handleObjectPointerUp}
                />
                {activeNativeTemplateId && templatePreview ? (
                  <NativeTemplateGhostOverlay
                    plan={templatePreview}
                    pageWidth={activePage.width}
                    pageHeight={activePage.height}
                  />
                ) : null}
                {selectionMarquee ? (
                  <SelectionMarqueeOverlay
                    startPoint={selectionMarquee.startPoint}
                    latestPoint={selectionMarquee.latestPoint}
                  />
                ) : null}
                {(() => {
                  const groupSelectionActive = activeToolState.activeKind === "selection" &&
                    document.selection.objectIds.length > 1 &&
                    !selectedNativeMoleculePart;
                  const groupSelectionBounds = groupSelectionActive
                    ? selectionBounds(document.pages[0].objects, document.selection.objectIds)
                    : undefined;
                  const groupProjectedPlaneTiltObjectIds = groupSelectionBounds
                    ? nativeMoleculeObjectIdsForGroupProjectedPlaneTilt(document.pages[0].objects, document.selection.objectIds)
                    : [];
                  return (
                  <>
                {document.pages[0].objects.map((object, layerIndex) => {
                  const selectionChromeActive = activeToolState.activeKind === "selection";
                  const selectedPart = selectionChromeActive && selectedNativeMoleculePart?.objectId === object.id
                    ? selectedNativeMoleculePart
                    : undefined;
                  const selected = selectionChromeActive &&
                    document.selection.objectIds.includes(object.id) &&
                    selectedPart === undefined;
                  // While a multi-selection group is active, individual members defer their
                  // own resize/rotate handles to the single group overlay.
                  const inGroupSelection = groupSelectionBounds !== undefined &&
                    document.selection.objectIds.includes(object.id);
                  const objectRenderKey = object.type === "molecule"
                    ? `${object.id}:${selected ? "selected" : "idle"}:${inGroupSelection ? "grouped" : "solo"}:${nativeSelectionRenderKey(selectedPart)}`
                    : object.id;

                  return (
                    <DocumentObjectView
                      key={objectRenderKey}
                      object={object}
                      layerIndex={layerIndex}
                      pageHeight={activePage.height}
                      pageWidth={activePage.width}
                      selected={selected}
                      inGroupSelection={inGroupSelection}
                      graphicTransformActive={activeGraphicTransformObjectId === object.id}
                      selectedPart={selectedPart}
                      editingText={activeTextEditObjectId === object.id}
                      editingAtomLabel={activeAtomLabelEdit?.objectId === object.id ? activeAtomLabelEdit : undefined}
                      chargeByAtomId={object.type === "molecule" ? chargeResolutionByMoleculeId.get(object.id) : undefined}
                      growthPreview={hoveredNativeAtom?.objectId === object.id ? hoveredNativeAtom : undefined}
                      deleteTarget={hoveredNativeDeleteTarget?.objectId === object.id ? hoveredNativeDeleteTarget : undefined}
                      hoverDestructive={activeToolState.activeCommandId === "tool.eraser"}
                      freeformPreview={freeformNativeBond?.objectId === object.id ? freeformNativeBond : undefined}
                      doubleBondSidePreview={
                        nativeDoubleBondSidePreview?.objectId === object.id ? nativeDoubleBondSidePreview : undefined
                      }
                      rotateReadout={objectRotateReadout?.objectId === object.id ? objectRotateReadout : undefined}
                      projectedPlaneTiltReadout={
                        projectedPlaneTiltReadout?.objectId === object.id ? projectedPlaneTiltReadout : undefined
                      }
                      rotationInput={rotationInput?.objectId === object.id ? rotationInput : undefined}
                      resizeReadout={objectResizeReadout?.objectId === object.id ? objectResizeReadout : undefined}
                      resizeInput={objectResizeInput?.objectId === object.id ? objectResizeInput : undefined}
                      graphicCornerRadiusReadout={
                        graphicCornerRadiusReadout?.objectId === object.id ? graphicCornerRadiusReadout : undefined
                      }
                      onPointerDown={handleObjectPointerDown}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onPointerCancel={handleObjectPointerCancel}
                      onPointerLeave={handleObjectPointerLeave}
                      onRotatePointerDown={handleObjectRotatePointerDown}
                      onRotateDoubleClick={handleObjectRotateDoubleClick}
                      onProjectedPlaneTiltPointerDown={handleProjectedPlaneTiltPointerDown}
                      onProjectedPlaneTiltDoubleClick={handleProjectedPlaneTiltDoubleClick}
                      onGraphicCornerRadiusPointerDown={handleGraphicCornerRadiusPointerDown}
                      onGraphicCornerRadiusDoubleClick={handleGraphicCornerRadiusDoubleClick}
                      onGraphicPathEditPointerDown={handleGraphicPathEditPointerDown}
                      onGraphicMarkerPointerDown={handleGraphicMarkerPointerDown}
                      onRotationInputChange={handleRotationInputChange}
                      onRotationInputKeep={handleRotationInputKeep}
                      onRotationInputHome={handleRotationInputHome}
                      onRotationInputCancel={handleRotationInputCancel}
                      onObjectResizePointerDown={handleObjectResizePointerDown}
                      onObjectResizeDoubleClick={handleObjectResizeDoubleClick}
                      onObjectResizeInputChange={handleObjectResizeInputChange}
                      onObjectResizeInputKeep={handleObjectResizeInputKeep}
                      onObjectResizeInputHome={handleObjectResizeInputHome}
                      onObjectResizeInputCancel={handleObjectResizeInputCancel}
                      onContextMenu={handleObjectContextMenu}
                      onTextChange={updateTextObjectContent}
                      onTextEditStart={startTextObjectEdit}
                      onTextEditFinish={() => setActiveTextEditObjectId(undefined)}
                      onTextSelectionChange={recordTextSelection}
                      onTextResizeStart={startTextResize}
                      onAtomLabelChange={updateAtomLabelDraft}
                      onAtomLabelCancel={cancelAtomLabelEdit}
                      onAtomLabelFinish={() => setActiveAtomLabelEdit(undefined)}
                    />
                  );
                })}
                {groupSelectionBounds ? (
                  <GroupSelectionOverlay
                    bounds={groupSelectionBounds}
                    canProjectedPlaneTilt={groupProjectedPlaneTiltObjectIds.length > 1}
                    onProjectedPlaneTiltStart={handleGroupProjectedPlaneTiltPointerDown}
                    onRotateStart={handleGroupRotatePointerDown}
                    onResizeStart={handleGroupResizePointerDown}
                  />
                ) : null}
                  </>
                  );
                })()}
                {artTransformQaEnabled ? (
                  <ArtTransformQaLayer
                    draft={artTransformQaDraft}
                    page={activePage}
                    selectionObjectIds={document.selection.objectIds}
                    onApplyScene={applyArtTransformQaScene}
                    onApplySelection={applyArtTransformQaToSelection}
                    onDraftChange={setArtTransformQaDraft}
                  />
                ) : null}
                {artStyleQaEnabled ? (
                  <ArtStyleQaLayer
                    page={activePage}
                    runCount={artStyleQaRunCount}
                    selectionObjectIds={document.selection.objectIds}
                    onApplyScene={applyArtStyleQaScene}
                    onRunStress={runArtStyleQaStress}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </section>
        {activeEditorMolecule ? (
          <KetcherEditorHost
            molecule={activeEditorMolecule}
            onApply={handleApplyKetcherEdit}
            onClose={() => setActiveEditorObjectId(undefined)}
            onStatus={setStatus}
          />
        ) : null}
        {exportDialog ? (
          <ExportDialog
            state={exportDialog}
            onCancel={cancelExportDialog}
            onChooseDestination={chooseExportDestination}
            onFilenameChange={(filename) => {
              // Editing the name makes it authoritative again; drop any previously chosen
              // destination so submit re-prompts with the new name instead of writing the old path.
              setExportDialog((current) => current ? { ...current, filename, destinationPath: undefined } : current);
            }}
            onFormatChange={(format) => {
              const descriptor = getExportFormatDescriptor(format);
              setExportDialog((current) => current ? updateExportDialogFormat(current, format) : current);
              setStatus(descriptor.status === "implemented"
                ? `Export ready: ${descriptor.menuLabel}`
                : `${descriptor.menuLabel} export is not available yet`);
            }}
            onSvgOptionsChange={(svg) => {
              setExportDialog((current) => current
                ? { ...current, svg: { ...current.svg, ...svg } }
                : current);
            }}
            onPdfOptionsChange={(pdf) => {
              setExportDialog((current) => current
                ? { ...current, pdf: { ...current.pdf, ...pdf } }
                : current);
            }}
            onRasterOptionsChange={(raster) => {
              setExportDialog((current) => current
                ? { ...current, raster: { ...current.raster, ...raster } }
                : current);
            }}
            onCdxmlOptionsChange={(cdxml) => {
              setExportDialog((current) => current
                ? { ...current, cdxml: { ...current.cdxml, ...cdxml } }
                : current);
            }}
            onSubmit={submitExportDialog}
          />
        ) : null}
        {pageFitPrompt ? (
          <ImportedPageFitPrompt
            recommendation={pageFitPrompt}
            onKeep={keepImportedPageOverflow}
            onResize={acceptPageFitRecommendation}
          />
        ) : null}
        <div style={{ position: "absolute", bottom: 8, right: 8, color: "var(--cd-text-secondary)", opacity: 0.5, pointerEvents: "none", fontSize: 10, zIndex: 1000 }}>
          Build {CURRENT_BUILD_STAMP} / {__BUILD_STAMP__}
        </div>
        <div
          aria-live="polite"
          role="status"
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            maxWidth: "min(560px, calc(100% - 280px))",
            overflow: "hidden",
            color: "var(--cd-text-secondary)",
            fontSize: 11,
            pointerEvents: "none",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            zIndex: 1000
          }}
        >
          {status}
        </div>
      </section>
      {objectContextMenu ? (
        <ObjectLayerContextMenu
          objectId={objectContextMenu.objectId}
          objectIndex={activePage.objects.findIndex((object) => object.id === objectContextMenu.objectId)}
          objectCount={activePage.objects.length}
          targetKind={objectContextMenu.targetKind}
          bondDepthContext={objectContextMenu.bondDepthContext}
          position={{ x: objectContextMenu.x, y: objectContextMenu.y }}
          onInvoke={(commandId) => {
            const menu = objectContextMenu;
            setObjectContextMenu(undefined);
            if (isBondDepthCommandId(commandId) && menu?.bondDepthContext) {
              const changed = commitDocumentChange((current) => {
                const patches = planBondDepthPatches(current.pages[0].id, menu.bondDepthContext, commandId);
                return patches.length > 0 ? applyPatches(current, patches) : current;
              });
              setStatus(changed ? bondDepthStatusForCommand(commandId) : "Bond depth unchanged");
              return;
            }
            invoke(commandId);
          }}
        />
      ) : null}
    </main>
  );
}

interface ImportedPageFitPromptProps {
  recommendation: ImportedPageFitPromptState;
  onKeep: () => void;
  onResize: () => void;
}

function ImportedPageFitPrompt({ recommendation, onKeep, onResize }: ImportedPageFitPromptProps) {
  const currentLabel = pageFitPromptLayoutLabel(recommendation.currentPageTitle, recommendation.currentOrientation);
  const recommendedLabel = pageFitPromptLayoutLabel(recommendation.recommendedPageTitle, recommendation.recommendedOrientation);
  const overflow = [
    recommendation.overflowLeftPx > 0 ? `${Math.ceil(recommendation.overflowLeftPx)} px left of the page` : undefined,
    recommendation.overflowTopPx > 0 ? `${Math.ceil(recommendation.overflowTopPx)} px above the page` : undefined,
    recommendation.overflowRightPx > 0 ? `${Math.ceil(recommendation.overflowRightPx)} px wider` : undefined,
    recommendation.overflowBottomPx > 0 ? `${Math.ceil(recommendation.overflowBottomPx)} px taller` : undefined
  ].filter(Boolean).join(" and ");

  return (
    <div
      aria-label="Imported content page size"
      aria-modal="true"
      role="dialog"
      style={exportDialogBackdropStyle}
    >
      <section style={exportDialogPanelStyle}>
        <div style={exportDialogHeaderStyle}>
          <h2 style={exportDialogTitleStyle}>Imported Content Exceeds Page</h2>
        </div>
        <p style={exportDialogHintStyle}>
          {recommendation.displayName} extends beyond {currentLabel}{overflow ? ` by about ${overflow}` : ""}.
        </p>
        <p style={exportDialogHintStyle}>
          Resize the page to {recommendedLabel} and place the import on the page, or keep the current page size and leave the overflow unchanged.
        </p>
        <div style={exportDialogFooterStyle}>
          <button type="button" style={exportDialogButtonStyle} onClick={onKeep}>
            Keep Current Page
          </button>
          <button type="button" style={exportDialogPrimaryButtonStyle} onClick={onResize}>
            Use {recommendedLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function pageFitPromptLayoutLabel(pageTitle: string, orientation: "portrait" | "landscape"): string {
  return `${pageTitle} ${orientation === "landscape" ? "Landscape" : "Portrait"}`;
}

interface ExportDialogProps {
  state: ExportDialogState;
  onCancel: () => void;
  onChooseDestination: () => void | Promise<void>;
  onFilenameChange: (filename: string) => void;
  onFormatChange: (format: ExportDialogFormat) => void;
  onSvgOptionsChange: (options: Partial<SvgDialogExportOptions>) => void;
  onPdfOptionsChange: (options: Partial<PdfDialogExportOptions>) => void;
  onRasterOptionsChange: (options: Partial<RasterDialogExportOptions>) => void;
  onCdxmlOptionsChange: (options: Partial<CdxmlDialogExportOptions>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}

function ExportDialog({
  state,
  onCancel,
  onChooseDestination,
  onFilenameChange,
  onFormatChange,
  onSvgOptionsChange,
  onPdfOptionsChange,
  onRasterOptionsChange,
  onCdxmlOptionsChange,
  onSubmit
}: ExportDialogProps) {
  const descriptor = getExportFormatDescriptor(state.format);
  const implemented = descriptor.status === "implemented";
  const rasterFormat = rasterExportFormatForDialogFormat(state.format);
  const destinationLabel = state.destinationPath ?? (isDesktopRuntime() ? "Choose a location" : "Downloads");
  const exportDisabled = state.busy || state.filename.trim() === "" || !implemented;

  return (
    <div
      aria-label="Export"
      aria-modal="true"
      role="dialog"
      style={exportDialogBackdropStyle}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <form style={exportDialogPanelStyle} onSubmit={onSubmit}>
        <div style={exportDialogHeaderStyle}>
          <h2 style={exportDialogTitleStyle}>Export</h2>
          <button
            aria-label="Close export"
            disabled={state.busy}
            type="button"
            style={exportDialogIconButtonStyle}
            onClick={onCancel}
          >
            x
          </button>
        </div>

        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-filename">
          Save as
        </label>
        <input
          id="chemdraft-export-filename"
          disabled={state.busy}
          value={state.filename}
          style={exportDialogInputStyle}
          onChange={(event) => onFilenameChange(event.currentTarget.value)}
        />

        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-format">
          Export as
        </label>
        <select
          id="chemdraft-export-format"
          disabled={state.busy}
          value={state.format}
          style={exportDialogInputStyle}
          onChange={(event) => {
            onFormatChange(event.currentTarget.value as ExportDialogFormat);
          }}
        >
          {exportFormatGroups.map((group) => (
            <optgroup key={group} label={exportFormatGroupLabels[group]}>
              {exportFormatDescriptors
                .filter((candidate) => candidate.group === group)
                .map((candidate) => {
                  const rasterOnly = rasterExportFormatForDialogFormat(candidate.id) !== undefined;
                  const unavailableInBrowser = rasterOnly && !isDesktopRuntime();
                  return (
                    <option key={candidate.id} value={candidate.id} disabled={unavailableInBrowser}>
                      {candidate.label}
                      {candidate.status === "implemented" ? "" : ` (${candidate.status})`}
                      {unavailableInBrowser ? " (desktop only)" : ""}
                    </option>
                  );
                })}
            </optgroup>
          ))}
        </select>
        {descriptor.warningSummary || !implemented ? (
          <p style={implemented ? exportDialogHintStyle : exportDialogWarningStyle}>
            {descriptor.warningSummary ?? `${descriptor.menuLabel} export is not available yet.`}
          </p>
        ) : null}

        <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-destination">
          Where
        </label>
        <div style={exportDialogDestinationRowStyle}>
          <input
            id="chemdraft-export-destination"
            readOnly
            value={destinationLabel}
            style={{ ...exportDialogInputStyle, ...exportDialogDestinationInputStyle }}
          />
          <button
            disabled={state.busy || !isDesktopRuntime() || !implemented}
            type="button"
            style={exportDialogButtonStyle}
            onClick={() => {
              void onChooseDestination();
            }}
          >
            Choose...
          </button>
        </div>

        {state.format === "svg" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>SVG</legend>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.svg.includeWarnings}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onSvgOptionsChange({ includeWarnings: event.currentTarget.checked })}
              />
              Include warning metadata
            </label>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.svg.includePageGuides}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onSvgOptionsChange({ includePageGuides: event.currentTarget.checked })}
              />
              Include page guides
            </label>
          </fieldset>
        ) : null}

        {state.format === "pdf" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>PDF</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-type">
              PDF type
            </label>
            <select
              id="chemdraft-export-pdf-type"
              disabled={state.busy}
              value={state.pdf.pdfType}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="vector">Vector PDF</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-page">
              Page
            </label>
            <select
              id="chemdraft-export-pdf-page"
              disabled={state.busy}
              value={state.pdf.page}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="current">Current page</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-pdf-background">
              Background
            </label>
            <select
              id="chemdraft-export-pdf-background"
              disabled={state.busy}
              value={state.pdf.background}
              style={exportDialogInputStyle}
              onChange={() => undefined}
            >
              <option value="white">White page</option>
            </select>

            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.pdf.compress}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onPdfOptionsChange({ compress: event.currentTarget.checked })}
              />
              Compress PDF
            </label>
            <label style={exportDialogCheckboxRowStyle}>
              <input
                checked={state.pdf.includePageGuides}
                disabled={state.busy}
                type="checkbox"
                onChange={(event) => onPdfOptionsChange({ includePageGuides: event.currentTarget.checked })}
              />
              Include page guides
            </label>
          </fieldset>
        ) : null}

        {rasterFormat ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>{descriptor.menuLabel}</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-scale">
              Scale
            </label>
            <select
              id="chemdraft-export-raster-scale"
              disabled={state.busy}
              value={String(state.raster.scale)}
              style={exportDialogInputStyle}
              onChange={(event) => onRasterOptionsChange({ scale: Number(event.currentTarget.value) })}
            >
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="3">3x</option>
              <option value="4">4x</option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-background">
              Background
            </label>
            <select
              id="chemdraft-export-raster-background"
              disabled={state.busy}
              value={state.raster.background}
              style={exportDialogInputStyle}
              onChange={(event) => {
                const value = event.currentTarget.value === "transparent" ? "transparent" : "white";
                onRasterOptionsChange({ background: value });
              }}
            >
              <option value="white">White page</option>
              <option value="transparent" disabled={rasterFormat !== "png"}>
                Transparent
              </option>
            </select>

            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-raster-max">
              Max dimension
            </label>
            <input
              id="chemdraft-export-raster-max"
              disabled={state.busy}
              min={256}
              max={8192}
              step={256}
              type="number"
              value={state.raster.maxDimensionPx}
              style={exportDialogInputStyle}
              onChange={(event) => onRasterOptionsChange({ maxDimensionPx: Number(event.currentTarget.value) })}
            />

            {rasterFormat === "jpeg" ? (
              <>
                <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-jpeg-quality">
                  JPEG quality
                </label>
                <input
                  id="chemdraft-export-jpeg-quality"
                  disabled={state.busy}
                  min={1}
                  max={100}
                  step={1}
                  type="range"
                  value={state.raster.jpegQuality}
                  style={exportDialogInputStyle}
                  onChange={(event) => onRasterOptionsChange({ jpegQuality: Number(event.currentTarget.value) })}
                />
              </>
            ) : null}
          </fieldset>
        ) : null}

        {state.format === "cdxml" ? (
          <fieldset style={exportDialogFieldsetStyle}>
            <legend style={exportDialogLegendStyle}>CDXML</legend>
            <label style={exportDialogLabelStyle} htmlFor="chemdraft-export-cdxml-program">
              Creation program
            </label>
            <input
              id="chemdraft-export-cdxml-program"
              disabled={state.busy}
              value={state.cdxml.creationProgram}
              style={exportDialogInputStyle}
              onChange={(event) => onCdxmlOptionsChange({ creationProgram: event.currentTarget.value })}
            />
          </fieldset>
        ) : null}

        <div style={exportDialogFooterStyle}>
          <button disabled={state.busy} type="button" style={exportDialogButtonStyle} onClick={onCancel}>
            Cancel
          </button>
          <button disabled={exportDisabled} type="submit" style={exportDialogPrimaryButtonStyle}>
            {state.busy ? "Exporting..." : "Export"}
          </button>
        </div>
      </form>
    </div>
  );
}

function createDefaultExportDialogState(document: ChemDraftDocument): ExportDialogState {
  const descriptor = getExportFormatDescriptor("pdf");
  return {
    format: descriptor.id,
    filename: createExportFilename(document, descriptor.extensions[0] ?? descriptor.id),
    svg: {
      includeWarnings: true,
      includePageGuides: false
    },
    pdf: {
      compress: true,
      includePageGuides: false,
      page: "current",
      pdfType: "vector",
      background: "white"
    },
    raster: {
      scale: 1,
      background: "white",
      jpegQuality: 90,
      maxDimensionPx: 8192
    },
    cdxml: {
      creationProgram: "ChemDraft"
    },
    busy: false
  };
}

function updateExportDialogFormat(state: ExportDialogState, format: ExportDialogFormat): ExportDialogState {
  const descriptor = getExportFormatDescriptor(format);
  const rasterFormat = rasterExportFormatForDialogFormat(format);
  return {
    ...state,
    format,
    filename: replaceExportFileExtension(state.filename, descriptor),
    destinationPath: undefined,
    raster: {
      ...state.raster,
      background: rasterFormat === "png" ? state.raster.background : "white"
    }
  };
}

function rasterExportFormatForDialogFormat(format: ExportFormatId): NativeRasterExportFormat | undefined {
  return rasterExportFormatsByFormatId[format];
}

function replaceExportFileExtension(filename: string, descriptor: ExportFormatDescriptor): string {
  const extension = descriptor.extensions[0] ?? descriptor.id;
  const trimmed = filename.trim() || "Untitled";
  const escapedExtensions = exportFormatOptionExtensions.map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const knownExportExtension = new RegExp(`\\.(${escapedExtensions.join("|")})$`, "i");
  return `${trimmed.replace(knownExportExtension, "")}.${extension}`;
}

const exportDialogBackdropStyle: CSSProperties = {
  alignItems: "center",
  background: "rgba(12, 18, 24, 0.22)",
  display: "flex",
  inset: 0,
  justifyContent: "center",
  padding: 24,
  position: "absolute",
  zIndex: 1200
};

const exportDialogPanelStyle: CSSProperties = {
  background: "#f7f9fb",
  border: "1px solid #b7c1ca",
  borderRadius: 8,
  boxShadow: "0 18px 48px rgba(20, 30, 40, 0.22)",
  color: "#18212a",
  display: "grid",
  gap: 8,
  maxHeight: "calc(100vh - 64px)",
  maxWidth: "calc(100vw - 48px)",
  overflow: "auto",
  padding: 16,
  width: 480
};

const exportDialogHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 4
};

const exportDialogTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 650,
  lineHeight: 1.2,
  margin: 0
};

const exportDialogLabelStyle: CSSProperties = {
  color: "#44515e",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.2,
  marginTop: 4
};

const exportDialogInputStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #aeb8c2",
  borderRadius: 6,
  boxSizing: "border-box",
  color: "#18212a",
  font: "inherit",
  fontSize: 13,
  minHeight: 30,
  padding: "4px 8px",
  width: "100%"
};

const exportDialogHintStyle: CSSProperties = {
  color: "#52606d",
  fontSize: 12,
  lineHeight: 1.3,
  margin: "0 0 2px"
};

const exportDialogWarningStyle: CSSProperties = {
  ...exportDialogHintStyle,
  color: "#875300"
};

const exportDialogDestinationRowStyle: CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: 8,
  gridTemplateColumns: "minmax(0, 1fr) auto"
};

const exportDialogDestinationInputStyle: CSSProperties = {
  color: "#52606d",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const exportDialogFieldsetStyle: CSSProperties = {
  border: "1px solid #c8d0d8",
  borderRadius: 8,
  display: "grid",
  gap: 8,
  margin: "8px 0 0",
  padding: "10px 12px 12px"
};

const exportDialogLegendStyle: CSSProperties = {
  color: "#44515e",
  fontSize: 12,
  fontWeight: 650,
  padding: "0 4px"
};

const exportDialogCheckboxRowStyle: CSSProperties = {
  alignItems: "center",
  color: "#28343f",
  display: "flex",
  fontSize: 13,
  gap: 8,
  lineHeight: 1.2,
  marginTop: 4
};

const exportDialogFooterStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 10
};

const exportDialogButtonStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #aeb8c2",
  borderRadius: 6,
  color: "#18212a",
  font: "inherit",
  fontSize: 13,
  minHeight: 30,
  padding: "4px 12px"
};

const exportDialogPrimaryButtonStyle: CSSProperties = {
  ...exportDialogButtonStyle,
  background: "#1967d2",
  borderColor: "#1967d2",
  color: "#ffffff"
};

const exportDialogIconButtonStyle: CSSProperties = {
  ...exportDialogButtonStyle,
  borderRadius: 999,
  height: 28,
  minHeight: 28,
  padding: 0,
  width: 28
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clientPointDistance(left: ClientPoint, right: ClientPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function findNearestCrossingHit(
  crossings: readonly ResolvedBondCrossing[],
  point: ClientPoint,
  hitRadius = 10
): ResolvedBondCrossing | undefined {
  return crossings
    .map((crossing) => ({
      crossing,
      distance: clientPointDistance(point, crossing.point)
    }))
    .filter((candidate) => candidate.distance <= hitRadius)
    .sort((left, right) => left.distance - right.distance || left.crossing.key.localeCompare(right.crossing.key))[0]?.crossing;
}

function documentObjectCenter(object: Pick<DocumentObject, "x" | "y" | "width" | "height">): ClientPoint {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function nativeMoleculeObjectIdsForGroupProjectedPlaneTilt(
  objects: readonly DocumentObject[],
  objectIds: readonly string[]
): string[] {
  if (objectIds.length <= 1) {
    return [];
  }
  const selected = new Set(objectIds);
  const molecules = objects.filter((object): object is MoleculeObject => selected.has(object.id) && object.type === "molecule");
  if (molecules.length !== objectIds.length) {
    return [];
  }
  return molecules.every((object) => isNativeMoleculeGraph(object) && object.atoms.length > 0)
    ? molecules.map((object) => object.id)
    : [];
}

export function rotationDeltaDegrees(center: ClientPoint, start: ClientPoint, latest: ClientPoint): number {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const latestAngle = Math.atan2(latest.y - center.y, latest.x - center.x);
  let angularDelta = (latestAngle - startAngle) * 180 / Math.PI;
  if (angularDelta > 180) {
    angularDelta -= 360;
  }
  if (angularDelta < -180) {
    angularDelta += 360;
  }

  const radius = clientPointDistance(center, start);
  if (radius <= 0.001) {
    return Number(angularDelta.toFixed(3));
  }

  const tangent = {
    x: -(start.y - center.y) / radius,
    y: (start.x - center.x) / radius
  };
  const dragVector = {
    x: latest.x - start.x,
    y: latest.y - start.y
  };
  return Number(((dragVector.x * tangent.x + dragVector.y * tangent.y) *
    OBJECT_ROTATE_TANGENTIAL_DEGREES_PER_PIXEL).toFixed(3));
}

export function parseRotationInputDegrees(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function rotationInputDraftDegrees(degrees: number): string {
  return `${Number(degrees.toFixed(3))}`;
}

export function rotationInputHomeDraftDegrees(kind: "z"): { draftZDegrees: string };
export function rotationInputHomeDraftDegrees(kind: "xy"): { draftXDegrees: string; draftYDegrees: string };
export function rotationInputHomeDraftDegrees(kind: "z" | "xy") {
  return kind === "z"
    ? { draftZDegrees: "0" }
    : { draftXDegrees: "0", draftYDegrees: "0" };
}

export function parseObjectResizeInputPercent(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function objectResizeInputDraftPercent(scale: number): string {
  return `${objectResizeReadoutPercent(scale)}`;
}

export function manualRotationDeltaDegrees(fromDegrees: number, toDegrees: number): number {
  let delta = normalizeRotationInputDegrees(toDegrees) - normalizeRotationInputDegrees(fromDegrees);
  if (delta > 180) {
    delta -= 360;
  }
  if (delta < -180) {
    delta += 360;
  }
  return Number(delta.toFixed(3));
}

function normalizeRotationInputDegrees(degrees: number): number {
  let normalized = degrees % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return Number(normalized.toFixed(3));
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

export function nativePlacementRotationDegrees(start: ClientPoint, latest: ClientPoint): number {
  const dx = latest.x - start.x;
  const dy = latest.y - start.y;
  if (Math.hypot(dx, dy) <= 0.001) {
    return 0;
  }

  return Number((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(3));
}

export function projectedPlaneTiltRadiansFromDrag(start: ClientPoint, latest: ClientPoint): number {
  const rawTilt = (start.y - latest.y) / PROJECTED_PLANE_TILT_DRAG_PX * projectedPlaneTiltMaxRadians;
  return Number(wrapProjectedPlaneTiltVectorRadians(rawTilt, 0).tiltXRad.toFixed(6));
}

export function projectedPlaneTiltVectorFromDrag(start: ClientPoint, latest: ClientPoint): { xRad: number; yRad: number } {
  const rawXTilt = (start.y - latest.y) / PROJECTED_PLANE_TILT_DRAG_PX * projectedPlaneTiltMaxRadians;
  const rawYTilt = (latest.x - start.x) / PROJECTED_PLANE_TILT_DRAG_PX * projectedPlaneTiltMaxRadians;
  const wrapped = wrapProjectedPlaneTiltVectorRadians(rawXTilt, rawYTilt);
  return {
    xRad: Number(wrapped.tiltXRad.toFixed(6)),
    yRad: Number(wrapped.tiltYRad.toFixed(6))
  };
}

export function documentObjectProjectedPlaneTiltVectorFromDrag(
  start: ClientPoint,
  latest: ClientPoint
): { xRad: number; yRad: number } {
  return projectedPlaneTiltVectorFromDrag(start, latest);
}

export function projectedPlaneTiltReadoutDegrees(tiltRad: number): number {
  return Math.round(Math.abs(tiltRad) * 180 / Math.PI);
}

function projectedPlaneTiltSignedReadoutDegrees(tiltRad: number): number {
  const degrees = Math.round(tiltRad * 180 / Math.PI);
  return Object.is(degrees, -0) ? 0 : degrees;
}

export function projectedPlaneTiltReadoutLabel(tiltXRad: number, tiltYRad = 0): string {
  const xDegrees = projectedPlaneTiltSignedReadoutDegrees(tiltXRad);
  const yDegrees = projectedPlaneTiltSignedReadoutDegrees(tiltYRad);
  if (yDegrees === 0) {
    return `${Math.abs(xDegrees)}°`;
  }
  if (xDegrees === 0) {
    return `Y ${yDegrees}°`;
  }
  // Both axes are non-zero here (the single-axis cases returned above).
  return `X ${xDegrees}° / Y ${yDegrees}°`;
}

export function projectedPlaneTiltCommitHistory(
  currentHistory: DocumentHistory,
  startDocument: ChemDraftDocument,
  nextDocument: ChemDraftDocument
): DocumentHistory {
  return {
    past: [...currentHistory.past, startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
    present: nextDocument,
    future: []
  };
}

export function rotationReadoutDegrees(angleDegrees: number): number {
  const normalized = ((angleDegrees % 360) + 360) % 360;
  const rounded = Math.round(normalized);
  if (rounded === 0 && Math.abs(angleDegrees) >= 0.5) {
    return 360;
  }
  return rounded === 360 ? 360 : rounded;
}

export function cumulativeRotationReadoutDegrees(startDegrees: number, deltaDegrees: number): number {
  return rotationReadoutDegrees(startDegrees + deltaDegrees);
}

export function objectResizeScaleFromDrag(
  center: ClientPoint,
  start: ClientPoint,
  latest: ClientPoint,
  stretch: boolean
): ObjectResizeScale {
  const startVector = {
    x: start.x - center.x,
    y: start.y - center.y
  };
  const latestVector = {
    x: latest.x - center.x,
    y: latest.y - center.y
  };
  const startLengthSquared = startVector.x * startVector.x + startVector.y * startVector.y;
  if (startLengthSquared <= 0.001) {
    return { x: 1, y: 1 };
  }

  if (!stretch) {
    const projectedScale =
      (latestVector.x * startVector.x + latestVector.y * startVector.y) / startLengthSquared;
    const uniformScale = clampObjectResizeScale(projectedScale);
    return { x: uniformScale, y: uniformScale };
  }

  return {
    x: clampObjectResizeScale(Math.abs(startVector.x) <= 0.001 ? 1 : latestVector.x / startVector.x),
    y: clampObjectResizeScale(Math.abs(startVector.y) <= 0.001 ? 1 : latestVector.y / startVector.y)
  };
}

export function objectResizeReadoutPercent(scale: number): number {
  return Math.round(scale * 100);
}

export function cumulativeObjectResizeScale(
  startScale: ObjectResizeScale,
  deltaScale: ObjectResizeScale
): ObjectResizeScale {
  return {
    x: Number((startScale.x * deltaScale.x).toFixed(4)),
    y: Number((startScale.y * deltaScale.y).toFixed(4))
  };
}

function clampObjectResizeScale(scale: number): number {
  return Number(Math.max(OBJECT_RESIZE_MIN_SCALE, scale).toFixed(4));
}

function capitalizeLabel(label: string): string {
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function graphicPathEditStatus(drag: GraphicPathEditDragState, changed: boolean): string {
  const semanticArc = graphicPathEditDragIsSemanticArc(drag);
  if (!changed) {
    return semanticArc ? "Selected arc geometry unchanged" : "Selected line geometry unchanged";
  }
  if (semanticArc) {
    return drag.handle === "middle" ? "Adjusted selected arc radius" : "Adjusted selected arc sweep";
  }
  return drag.handle === "middle" ? "Bent selected line into a curve" : "Adjusted selected line endpoint";
}

function graphicPathEditDragIsSemanticArc(drag: GraphicPathEditDragState): boolean {
  const object = findDocumentObject(drag.workingDocument, drag.objectId) ??
    findDocumentObject(drag.startDocument, drag.objectId);
  const points = object?.type === "graphic" ? nativeGraphicPathEditPoints(object) : undefined;
  return object?.type === "graphic" && points !== undefined && isSemanticCircularGraphicArc(object, points);
}

function nativeGraphicPathEditPointFromProjectedDrag(
  document: ChemDraftDocument,
  objectId: string,
  point: ClientPoint
): ClientPoint {
  const object = findDocumentObject(document, objectId);
  if (object?.type !== "graphic") {
    return point;
  }
  return unprojectGraphicObjectPoint(object, point, { coordinateSpace: "page" });
}

function nativeGraphicCornerRadiusPointFromProjectedDrag(
  document: ChemDraftDocument,
  objectId: string,
  point: ClientPoint
): ClientPoint {
  const object = findDocumentObject(document, objectId);
  if (object?.type !== "graphic") {
    return point;
  }
  const unprojected = unprojectGraphicObjectPoint(object, point);
  return {
    x: unprojected.x - object.x,
    y: unprojected.y - object.y
  };
}

function graphicCornerRadiusReadoutValue(object: GraphicObject): number {
  const point = nativeGraphicCornerRadiusEditPoint(object);
  return point ? point.x : 0;
}

function graphicArcSweepRadiansLabel(object: GraphicObject): string {
  const rawSweep = typeof object.data.arcSweepRadians === "number" && Number.isFinite(object.data.arcSweepRadians)
    ? object.data.arcSweepRadians
    : Math.PI;
  const sweep = Math.max(Math.PI / 180, Math.min(Math.PI * 2 - Math.PI / 1800, Math.abs(rawSweep)));
  return `${sweep.toFixed(3)} rad`;
}

function isSemanticCircularGraphicArc(
  object: GraphicObject,
  points: NativeGraphicPathEditPoints
): boolean {
  return points.pathKind === "arc" && object.data.pathControlPoint === undefined;
}

function nativeBondToolStatusLabel(bondStyle: NativeBondDisplayStyle | undefined): string {
  if (bondStyle === "wedge") {
    return "solid wedge bond";
  }
  if (bondStyle === "hashed") {
    return "hashed wedge bond";
  }
  if (bondStyle === "dashed") {
    return "dashed bond";
  }
  if (bondStyle === "bold") {
    return "bold bond";
  }

  return "single bond";
}

function nativePlacementStatusLabel(drag: NativePlacementDragState): string {
  return drag.kind === "template" && drag.templateId
    ? `${nativeTemplateStatusLabel(drag.templateId)} template`
    : `${nativeBondToolStatusLabel(drag.bondStyle)} molecule`;
}

function nativeTemplateStatusLabel(templateId: NativeMoleculeTemplateId): string {
  switch (templateId) {
    case "cyclopentane":
      return "cyclopentane";
    case "cyclohexane":
      return "cyclohexane";
    case "benzene":
      return "benzene";
    case "chairCyclohexaneA":
      return "chair cyclohexane A";
    case "chairCyclohexaneB":
      return "chair cyclohexane B";
    default:
      return "structure";
  }
}

function nativeTemplateStatusForApplication(
  templateId: NativeMoleculeTemplateId,
  target: NativeMoleculeDeleteTarget | undefined,
  changed: boolean
): string {
  if (!target) {
    return `Inserted ${nativeTemplateStatusLabel(templateId)} template`;
  }

  if (!changed) {
    return `${capitalizeLabel(nativeTemplateStatusLabel(templateId))} template not applied`;
  }

  return target.kind === "bond"
    ? `Fused ${nativeTemplateStatusLabel(templateId)} template`
    : `Made spiro ${nativeTemplateStatusLabel(templateId)} template`;
}

function nativeAtomBondCount(molecule: MoleculeObject, atomId: string): number {
  return molecule.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId).length;
}

function nativeDoubleBondSidePreviewFromHit(
  objectId: string,
  molecule: MoleculeObject,
  hit: NativeMoleculeDeleteHit,
  point: ClientPoint
): NativeDoubleBondSidePreview | undefined {
  if (hit.kind !== "bond") {
    return undefined;
  }

  const bond = molecule.bonds.find((candidate) => candidate.id === hit.bondId);
  if (!bond || bond.order !== "double") {
    return undefined;
  }

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

  const normal = {
    x: -dy / length,
    y: dx / length
  };
  const midpoint = {
    x: (fromAtom.x + toAtom.x) / 2,
    y: (fromAtom.y + toAtom.y) / 2
  };
  const score = (point.x - midpoint.x) * normal.x + (point.y - midpoint.y) * normal.y;

  return {
    objectId,
    bondId: bond.id,
    side: score >= 0 ? "left" : "right"
  };
}

interface NativeBondLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  segment: "primary" | "secondary" | "outer";
  doubleBondSide?: NativeDoubleBondSide;
}

function isTerminalHeteroatomDoubleBond(
  fromAtom: MoleculeObject["atoms"][number],
  toAtom: MoleculeObject["atoms"][number],
  object: MoleculeObject,
  bond: MoleculeObject["bonds"][number]
): boolean {
  if (bond.order !== "double") {
    return false;
  }

  return isTerminalHeteroatom(fromAtom, object) || isTerminalHeteroatom(toAtom, object);
}

function isTerminalHeteroatom(atom: MoleculeObject["atoms"][number], object: MoleculeObject): boolean {
  return atom.element !== "C" && atom.element !== "H" && nativeAtomBondCount(object, atom.id) === 1;
}

function bondLineSegments(
  fromAtom: MoleculeObject["atoms"][number],
  toAtom: MoleculeObject["atoms"][number],
  object: MoleculeObject,
  bond: MoleculeObject["bonds"][number],
  drawingStyle: NativeDrawingStyle,
  fromLabel?: string,
  toLabel?: string
): NativeBondLineSegment[] {
  const rawX1 = fromAtom.x - object.x;
  const rawY1 = fromAtom.y - object.y;
  const rawX2 = toAtom.x - object.x;
  const rawY2 = toAtom.y - object.y;
  const dx = rawX2 - rawX1;
  const dy = rawY2 - rawY1;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return [{ x1: rawX1, y1: rawY1, x2: rawX2, y2: rawY2, segment: "primary" }];
  }

  const unit = {
    x: dx / length,
    y: dy / length
  };
  const clearance = labelEndpointClearance(fromLabel, toLabel, drawingStyle, length, unit);
  const x1 = rawX1 + unit.x * clearance.from;
  const y1 = rawY1 + unit.y * clearance.from;
  const x2 = rawX2 - unit.x * clearance.to;
  const y2 = rawY2 - unit.y * clearance.to;
  const trimmedLength = Math.hypot(x2 - x1, y2 - y1);
  const normal = {
    x: -unit.y,
    y: unit.x
  };
  const gap = drawingStyle.multipleBondGapPx;

  if (bond.order === "double") {
    const doubleBondSide = bond.display?.doubleBondSide ?? "left";
    if (isTerminalHeteroatomDoubleBond(fromAtom, toAtom, object, bond)) {
      const offset = gap / 2;
      return [
        {
          x1: x1 + normal.x * offset,
          y1: y1 + normal.y * offset,
          x2: x2 + normal.x * offset,
          y2: y2 + normal.y * offset,
          segment: "primary",
          doubleBondSide
        },
        {
          x1: x1 - normal.x * offset,
          y1: y1 - normal.y * offset,
          x2: x2 - normal.x * offset,
          y2: y2 - normal.y * offset,
          segment: "secondary",
          doubleBondSide
        }
      ];
    }

    const offset = doubleBondSide === "left" ? gap : -gap;
    const minimumSecondaryLength = Math.min(DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX, trimmedLength);
    const inset = Math.min(
      drawingStyle.doubleBondInsetPx,
      Math.max(0, (trimmedLength - minimumSecondaryLength) / 2)
    );
    return [
      { x1, y1, x2, y2, segment: "primary", doubleBondSide },
      {
        x1: x1 + unit.x * inset + normal.x * offset,
        y1: y1 + unit.y * inset + normal.y * offset,
        x2: x2 - unit.x * inset + normal.x * offset,
        y2: y2 - unit.y * inset + normal.y * offset,
        segment: "secondary",
        doubleBondSide
      }
    ];
  }

  if (bond.order === "triple") {
    return [-gap, 0, gap].map((offset, index) => ({
      x1: x1 + normal.x * offset,
      y1: y1 + normal.y * offset,
      x2: x2 + normal.x * offset,
      y2: y2 + normal.y * offset,
      segment: index === 1 ? "primary" : "outer"
    }));
  }

  return [{ x1, y1, x2, y2, segment: "primary" }];
}

function nativeBondDisplayStyle(bond: MoleculeObject["bonds"][number]): NativeBondDisplayStyle | undefined {
  return bond.display?.bondStyle;
}

function nativeBondStrokeWidth(
  bond: MoleculeObject["bonds"][number],
  drawingStyle: NativeDrawingStyle
): number {
  return nativeBondDisplayStyle(bond) === "bold"
    ? drawingStyle.bondStrokeWidthPx * 2.4
    : drawingStyle.bondStrokeWidthPx;
}

function nativeDashedBondDashArray(drawingStyle: NativeDrawingStyle): string {
  const dash = Math.max(3, drawingStyle.bondStrokeWidthPx * 2.2);
  const gap = Math.max(3, drawingStyle.bondStrokeWidthPx * 1.8);
  return `${dash} ${gap}`;
}

function nativeWedgeWidth(drawingStyle: NativeDrawingStyle): number {
  return Math.max(8, drawingStyle.bondStrokeWidthPx * 5.2);
}

function nativeWedgePolygonPoints(
  segment: Pick<NativeBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): string {
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return `${segment.x1},${segment.y1} ${segment.x2},${segment.y2}`;
  }

  const width = nativeWedgeWidth(drawingStyle);
  const halfWidth = width / 2;
  const wideLeft = {
    x: segment.x2 + geometry.normal.x * halfWidth,
    y: segment.y2 + geometry.normal.y * halfWidth
  };
  const wideRight = {
    x: segment.x2 - geometry.normal.x * halfWidth,
    y: segment.y2 - geometry.normal.y * halfWidth
  };
  return [
    `${formatSvgPoint(segment.x1)},${formatSvgPoint(segment.y1)}`,
    `${formatSvgPoint(wideLeft.x)},${formatSvgPoint(wideLeft.y)}`,
    `${formatSvgPoint(wideRight.x)},${formatSvgPoint(wideRight.y)}`
  ].join(" ");
}

function nativeHashedWedgeSegments(
  segment: Pick<NativeBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): Pick<NativeBondLineSegment, "x1" | "y1" | "x2" | "y2">[] {
  const geometry = nativeSegmentVectorGeometry(segment);
  if (!geometry) {
    return [];
  }

  const hashCount = Math.max(5, Math.min(9, Math.round(geometry.length / 9)));
  const maxWidth = nativeWedgeWidth(drawingStyle);
  return Array.from({ length: hashCount }, (_, index) => {
    const t = (index + 1) / (hashCount + 1);
    const center = {
      x: segment.x1 + geometry.unit.x * geometry.length * t,
      y: segment.y1 + geometry.unit.y * geometry.length * t
    };
    const halfWidth = maxWidth * t / 2;
    return {
      x1: center.x + geometry.normal.x * halfWidth,
      y1: center.y + geometry.normal.y * halfWidth,
      x2: center.x - geometry.normal.x * halfWidth,
      y2: center.y - geometry.normal.y * halfWidth
    };
  });
}

function nativeSegmentVectorGeometry(
  segment: Pick<NativeBondLineSegment, "x1" | "y1" | "x2" | "y2">
): { length: number; unit: { x: number; y: number }; normal: { x: number; y: number } } | undefined {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const unit = { x: dx / length, y: dy / length };
  return {
    length,
    unit,
    normal: { x: -unit.y, y: unit.x }
  };
}

function formatSvgPoint(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function labelEndpointClearance(
  fromLabel: string | undefined,
  toLabel: string | undefined,
  drawingStyle: NativeDrawingStyle,
  bondLength: number,
  unit: { x: number; y: number }
): { from: number; to: number } {
  const from = atomLabelBondClearance(fromLabel, drawingStyle, unit);
  const to = atomLabelBondClearance(toLabel, drawingStyle, { x: -unit.x, y: -unit.y });
  const total = from + to;
  const maximumTotal = bondLength * 0.55;
  if (total <= maximumTotal || total === 0) {
    return { from, to };
  }

  const scale = maximumTotal / total;
  return {
    from: from * scale,
    to: to * scale
  };
}

function atomLabelBondClearance(
  label: string | undefined,
  drawingStyle: NativeDrawingStyle,
  direction: { x: number; y: number }
): number {
  if (!label) {
    return 0;
  }

  const { bounds } = atomLabelLayout(label, drawingStyle);
  const horizontalDistance = direction.x > 0.0001
    ? (bounds.x + bounds.width) / direction.x
    : direction.x < -0.0001
      ? bounds.x / direction.x
      : Number.POSITIVE_INFINITY;
  const verticalDistance = direction.y > 0.0001
    ? (bounds.y + bounds.height) / direction.y
    : direction.y < -0.0001
      ? bounds.y / direction.y
      : Number.POSITIVE_INFINITY;
  const labelBoundaryDistance = Math.min(horizontalDistance, verticalDistance);

  return Math.max(drawingStyle.atomLabelBondClearancePx, Math.max(0, labelBoundaryDistance));
}

function atomLabelBox(
  atom: MoleculeObject["atoms"][number],
  object: MoleculeObject,
  label: string,
  drawingStyle: NativeDrawingStyle
): { x: number; y: number; width: number; height: number } {
  const { bounds } = atomLabelLayout(label, drawingStyle);
  return {
    x: atom.x - object.x + bounds.x,
    y: atom.y - object.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

type AtomLabelScript = "normal" | "subscript" | "superscript";

interface AtomLabelRun {
  text: string;
  script: AtomLabelScript;
}

interface AtomLabelLayoutRun extends AtomLabelRun {
  x: number;
  y: number;
  textAnchor: "middle" | "start";
}

interface AtomLabelLayout {
  bounds: { x: number; y: number; width: number; height: number };
  runs: AtomLabelLayoutRun[];
}

function atomLabelLayout(label: string, drawingStyle: NativeDrawingStyle): AtomLabelLayout {
  const { bodyRuns, chargeRun } = atomLabelParts(label);
  const baseText = bodyRuns.filter((run) => run.script === "normal").map((run) => run.text).join("") || label;
  const suffixRuns = bodyRuns.filter((run) => run.script !== "normal");
  const baseWidth = atomLabelRunWidth({ text: baseText, script: "normal" }, drawingStyle);
  const baseHalfWidth = baseWidth / 2;
  const baseHalfHeight = drawingStyle.atomLabelFontSizePx * 0.54;
  const runs: AtomLabelLayoutRun[] = [
    {
      text: baseText,
      script: "normal",
      x: 0,
      y: 0,
      textAnchor: "middle"
    }
  ];
  let right = baseHalfWidth;
  let top = -baseHalfHeight;
  let bottom = baseHalfHeight;
  let cursor = baseHalfWidth + drawingStyle.atomLabelFontSizePx * 0.04;

  for (const run of suffixRuns) {
    const fontSize = atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
    const width = atomLabelRunWidth(run, drawingStyle);
    const y = run.script === "subscript"
      ? drawingStyle.atomLabelFontSizePx * 0.34
      : -drawingStyle.atomLabelFontSizePx * 0.42;
    runs.push({
      ...run,
      x: cursor,
      y,
      textAnchor: "start"
    });
    right = Math.max(right, cursor + width);
    top = Math.min(top, y - fontSize * 0.52);
    bottom = Math.max(bottom, y + fontSize * 0.52);
    cursor += width + drawingStyle.atomLabelFontSizePx * 0.03;
  }

  if (chargeRun) {
    const fontSize = atomLabelRunFontSize(chargeRun.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
    const width = atomLabelRunWidth(chargeRun, drawingStyle);
    const x = Math.max(cursor, baseHalfWidth + drawingStyle.atomLabelFontSizePx * 0.08);
    const y = -drawingStyle.atomLabelFontSizePx * 0.48;
    runs.push({
      ...chargeRun,
      x,
      y,
      textAnchor: "start"
    });
    right = Math.max(right, x + width);
    top = Math.min(top, y - fontSize * 0.52);
    bottom = Math.max(bottom, y + fontSize * 0.52);
  }

  const padding = drawingStyle.atomLabelPaddingPx;
  return {
    bounds: {
      x: -baseHalfWidth - padding,
      y: top - padding,
      width: right + baseHalfWidth + padding * 2,
      height: bottom - top + padding * 2
    },
    runs
  };
}

function atomLabelParts(label: string): { bodyRuns: AtomLabelRun[]; chargeRun?: AtomLabelRun } {
  const { body, charge } = splitAtomLabelCharge(label);
  const runs = Array.from(body).reduce<AtomLabelRun[]>((currentRuns, character) => {
    const script = atomLabelScript(character);
    const previous = currentRuns[currentRuns.length - 1];
    if (previous?.script === script) {
      previous.text += character;
      return currentRuns;
    }

    currentRuns.push({ text: character, script });
    return currentRuns;
  }, []);

  return {
    bodyRuns: runs.length > 0 ? runs : [{ text: label, script: "normal" }],
    chargeRun: charge ? { text: charge, script: "superscript" } : undefined
  };
}

function splitAtomLabelCharge(label: string): { body: string; charge?: string } {
  const twoCharacterCharge = label.match(/^(.*?)(\d[+-])$/);
  if (twoCharacterCharge && twoCharacterCharge[1] && !twoCharacterCharge[1].endsWith("H")) {
    return { body: twoCharacterCharge[1], charge: twoCharacterCharge[2] };
  }

  const oneCharacterCharge = label.match(/^(.*)([+-])$/);
  if (oneCharacterCharge && oneCharacterCharge[1]) {
    return { body: oneCharacterCharge[1], charge: oneCharacterCharge[2] };
  }

  return { body: label };
}

function atomLabelRunWidth(run: AtomLabelRun, drawingStyle: NativeDrawingStyle): number {
  const fontSize = atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx;
  const widthFactor = run.script === "normal" ? 0.62 : 0.5;
  return run.text.length * fontSize * widthFactor;
}

function atomLabelScript(character: string): AtomLabelScript {
  if (/\d/.test(character)) {
    return "subscript";
  }
  if (character === "+" || character === "-") {
    return "superscript";
  }
  return "normal";
}

function atomLabelRunFontSize(script: AtomLabelScript, drawingStyle: NativeDrawingStyle): number | undefined {
  if (script === "normal") {
    return undefined;
  }

  return drawingStyle.atomLabelFontSizePx * (script === "superscript" ? 0.88 : 0.72);
}

function updateVisibleToolsets(current: ReadonlySet<string>, toolsetId: string, visible: boolean): Set<string> {
  const next = new Set(current);
  if (visible) {
    next.add(toolsetId);
  } else {
    next.delete(toolsetId);
  }

  return next;
}

export function shouldActivateDocumentObject(object: DocumentObject | undefined, activeToolKind: string): boolean {
  return object !== undefined && activeToolKind === "selection";
}

export function shouldDragDocumentObject(object: DocumentObject | undefined, activeToolKind: string): boolean {
  if (activeToolKind === "selection") {
    return true;
  }

  return activeToolKind === "charge" && object?.type === "electron-mark" && object.markKind === "charge";
}

export function shouldOpenMoleculeEditorFromObjectClick(
  object: DocumentObject | undefined,
  activeToolKind: string,
  clickCount: number
): object is MoleculeObject {
  void object;
  void activeToolKind;
  void clickCount;
  return false;
}

export function hoveredNativeTargetShortcutCommand(
  target: NativeMoleculeDeleteTarget | undefined,
  key: string
): string | undefined {
  if (target?.kind === "bond") {
    if (key === "1") {
      return "bond.setHoveredBondOrder.single";
    }
    if (key === "2") {
      return "bond.setHoveredBondOrder.double";
    }
    if (key === "3") {
      return "bond.setHoveredBondOrder.triple";
    }
    return undefined;
  }

  if (target?.kind !== "atom") {
    return undefined;
  }

  if (key === "1") {
    return "atom.addSingleBondToHoveredAtom";
  }
  if (key.toLowerCase() === "k") {
    return "atom.addCarbonylToHoveredAtom";
  }
  if (key === "+") {
    return "atom.addPositiveChargeToHoveredAtom";
  }
  if (key === "-") {
    return "atom.addNegativeChargeToHoveredAtom";
  }

  const element = nativeElementFromKeyboardKey(key);
  return element ? atomElementCommandId(element) : undefined;
}

export function activeNativeTargetShortcutCommand(
  document: ChemDraftDocument,
  selectedPart: NativeMoleculeSelectionPart | undefined,
  hoveredTarget: NativeMoleculeDeleteTarget | undefined,
  key: string
): string | undefined {
  return hoveredNativeTargetShortcutCommand(
    hoveredTarget ?? nativeDeleteTargetFromSelectionPart(document, selectedPart),
    key
  );
}

export function nativeDeleteTargetFromSelectionPart(
  document: ChemDraftDocument,
  part: NativeMoleculeSelectionPart | undefined
): NativeMoleculeDeleteTarget | undefined {
  if (!part) {
    return undefined;
  }

  const object = findDocumentObject(document, part.objectId);
  if (object?.type !== "molecule") {
    return undefined;
  }

  if (part.kind === "atom") {
    return object.atoms.some((atom) => atom.id === part.atomId)
      ? {
          objectId: part.objectId,
          kind: "atom",
          atomId: part.atomId,
          distanceToPointer: 0
        }
      : undefined;
  }

  if (part.kind !== "bond") {
    return undefined;
  }

  const bond = object.bonds.find((candidate) => candidate.id === part.bondId);
  return bond
    ? {
        objectId: part.objectId,
        kind: "bond",
        bondId: bond.id,
        fromAtomId: bond.fromAtomId,
        toAtomId: bond.toAtomId,
        distanceToPointer: 0
      }
    : undefined;
}

function isLayerCommandId(commandId: string): boolean {
  return (
    commandId === "layout.bringToFront" ||
    commandId === "layout.bringForward" ||
    commandId === "layout.sendBackward" ||
    commandId === "layout.sendToBack"
  );
}

function createDefaultToolsetPositions(registry: DesktopToolsetRegistry): Record<string, PalettePosition> {
  return Object.fromEntries(
    registry.listToolsets().map((toolset, index) => [
      toolset.id,
      { x: 34 + index * 18, y: 116 + index * 18 }
    ])
  );
}

function defaultToolsetPosition(toolsetId: string, registry: DesktopToolsetRegistry): PalettePosition {
  const index = Math.max(0, registry.listToolsets().findIndex((toolset) => toolset.id === toolsetId));
  return { x: 34 + index * 18, y: 116 + index * 18 };
}

function clientPointFromElementCenter(element: HTMLElement): ClientPoint {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function clientPointFromGesture(
  event: WebKitGestureEvent,
  element: HTMLElement,
  fallback?: ClientPoint
): ClientPoint {
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    return { x: event.clientX, y: event.clientY };
  }

  return fallback ?? clientPointFromElementCenter(element);
}

export function shouldUseViewportWheelZoom(event: Pick<globalThis.WheelEvent, "ctrlKey" | "deltaY" | "metaKey">): boolean {
  return Number.isFinite(event.deltaY) && event.deltaY !== 0 && (event.ctrlKey || event.metaKey);
}

export function pagePointFromRenderedPageRect(
  rect: Pick<DOMRect, "left" | "top">,
  scale: number,
  clientPoint: ClientPoint
): ClientPoint {
  // The page-coordinate conversion lives in the camera module (single source of truth);
  // this thin wrapper preserves the existing call sites and test imports.
  return clientToPage(clientPoint, { pageRect: rect, scale });
}

function clientPointIsInsideRect(
  point: ClientPoint,
  rect: Pick<DOMRect, "bottom" | "left" | "right" | "top">
): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function pageCenterPoint(
  viewport: ViewportState,
  page: ChemDraftDocument["pages"][number]
): { x: number; y: number } {
  return {
    x: viewport.pageOriginX + viewport.translateX + (page.width / 2) * viewport.scale,
    y: viewport.pageOriginY + viewport.translateY + (page.height / 2) * viewport.scale
  };
}

function rulerUnitForDocument(document: ChemDraftDocument | undefined): RulerUnitState {
  return rulerUnitForPageLayout(document?.pages[0]?.layout);
}

function rulerUnitForPageLayout(layout: ChemDraftDocument["pages"][number]["layout"] | undefined): RulerUnitState {
  return layout?.sourceUnit === "mm" ? centimeterRulerUnit : inchRulerUnit;
}

function DocumentRulers({
  viewport,
  frame,
  pageWidth,
  pageHeight
}: {
  viewport: ViewportState;
  frame: RulerFrame;
  pageWidth: number;
  pageHeight: number;
}) {
  const horizontalRuler = createRulerRenderState(viewport, pageWidth, frame.horizontalScrollPx);
  const verticalRuler = createRulerRenderState(viewport, pageHeight, frame.verticalScrollPx);

  return (
    <div className="document-rulers-overlay" aria-hidden="true">
      <div className="ruler-corner" aria-hidden="true" />
      <div className="ruler ruler-top" style={{ width: frame.width, height: RULER_THICKNESS }}>
        <ScenaRuler
          type="horizontal"
          width={frame.width}
          height={RULER_THICKNESS}
          scrollPos={horizontalRuler.scrollPos}
          zoom={horizontalRuler.zoom}
          unit={horizontalRuler.unit}
          segment={horizontalRuler.segment}
          range={horizontalRuler.range}
          negativeRuler={false}
          backgroundColor="#f9faf9"
          lineColor="#8f9aa1"
          textColor="#2a3035"
          font="11px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          mainLineSize={22}
          longLineSize={15}
          shortLineSize={8}
          textOffset={[4, -5]}
          textFormat={(value) => formatRulerText(value)}
          useResizeObserver={false}
        />
      </div>
      <div className="ruler ruler-left" style={{ width: RULER_THICKNESS, height: frame.height }}>
        <ScenaRuler
          type="vertical"
          width={RULER_THICKNESS}
          height={frame.height}
          scrollPos={verticalRuler.scrollPos}
          zoom={verticalRuler.zoom}
          unit={verticalRuler.unit}
          segment={verticalRuler.segment}
          range={verticalRuler.range}
          negativeRuler={false}
          backgroundColor="#f9faf9"
          lineColor="#8f9aa1"
          textColor="#2a3035"
          font="11px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          mainLineSize={22}
          longLineSize={15}
          shortLineSize={8}
          textOffset={[4, -5]}
          textFormat={(value) => formatRulerText(value)}
          useResizeObserver={false}
        />
      </div>
      <span className="ruler-unit-label" aria-hidden="true">
        {viewport.rulerUnit.label}
      </span>
    </div>
  );
}

function rulerFramesEqual(left: RulerFrame, right: RulerFrame): boolean {
  return (
    Math.abs(left.horizontalScrollPx - right.horizontalScrollPx) < 0.5 &&
    Math.abs(left.verticalScrollPx - right.verticalScrollPx) < 0.5 &&
    left.width === right.width &&
    left.height === right.height
  );
}

function formatRulerText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function CrosshairOverlay({
  horizontalTicks,
  verticalTicks
}: {
  horizontalTicks: ReturnType<typeof buildCrosshairTicks>;
  verticalTicks: ReturnType<typeof buildCrosshairTicks>;
}) {
  return (
    <div className="crosshair-overlay" aria-hidden="true">
      <div className="crosshair-axis crosshair-axis-vertical" />
      <div className="crosshair-axis crosshair-axis-horizontal" />
      {verticalTicks.map((tick) => (
        <span
          className={["crosshair-tick", "crosshair-tick-on-vertical", `crosshair-tick-${tick.kind}`].join(" ")}
          key={`vertical-${tick.index}`}
          style={{ top: `calc(${tick.position}px * var(--page-scale))` }}
        />
      ))}
      {horizontalTicks.map((tick) => (
        <span
          className={["crosshair-tick", "crosshair-tick-on-horizontal", `crosshair-tick-${tick.kind}`].join(" ")}
          key={`horizontal-${tick.index}`}
          style={{ left: `calc(${tick.position}px * var(--page-scale))` }}
        />
      ))}
    </div>
  );
}

// A non-interactive ghost of the ring a template click will place, drawn from the SAME plan the
// click commits (so what you see is exactly what lands). Only the parts NEW to this placement are
// drawn — a full hexagon for a standalone insert, the open arc that shares the targeted edge for a
// fusion, the arc hanging off the shared atom for a spiro, and just the missing edges for a
// closure. The ghost only turns red (data-ghost-invalid) when the placement would actually make
// one of the atoms it touches invalid — the same predicate that paints the red "!" — so valid
// spiro rings (cyclohexane/cyclopentane, degree-4 sp3) stay neutral and only genuinely bad
// products (e.g. a spiro carbon shared by two aromatic rings) warn.
function NativeTemplateGhostOverlay({
  plan,
  pageWidth,
  pageHeight
}: {
  plan: NativeTemplatePlacementPlan;
  pageWidth: number;
  pageHeight: number;
}) {
  const atomById = new Map(plan.molecule.atoms.map((atom) => [atom.id, atom] as const));
  const addedBondIds = new Set(plan.addedBondIds);
  const ghostBonds = plan.molecule.bonds.filter((bond) => addedBondIds.has(bond.id));
  const invalidAtomIds = new Set(nativeMoleculeInvalidAtomStates(plan.molecule).map((state) => state.atomId));
  const touchedAtomIds = new Set<string>(plan.addedAtomIds);
  ghostBonds.forEach((bond) => {
    touchedAtomIds.add(bond.fromAtomId);
    touchedAtomIds.add(bond.toAtomId);
  });
  const producesInvalidAtom = [...touchedAtomIds].some((atomId) => invalidAtomIds.has(atomId));
  return (
    <svg
      className="native-template-ghost-surface"
      data-ghost-invalid={producesInvalidAtom ? "true" : undefined}
      aria-hidden="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
    >
      {ghostBonds.map((bond) => {
        const from = atomById.get(bond.fromAtomId);
        const to = atomById.get(bond.toAtomId);
        return from && to ? (
          <line
            key={bond.id}
            className="native-template-ghost-bond"
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        ) : null;
      })}
      {plan.addedAtomIds.map((atomId) => {
        const atom = atomById.get(atomId);
        return atom ? (
          <circle key={atomId} className="native-template-ghost-atom" cx={atom.x} cy={atom.y} r={2.5} />
        ) : null;
      })}
    </svg>
  );
}

export function SelectionMarqueeOverlay({
  startPoint,
  latestPoint
}: {
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
}) {
  const rect = normalizedRect(startPoint, latestPoint);
  return (
    <div
      className="selection-marquee"
      aria-hidden="true"
      style={{
        left: `calc(${rect.x}px * var(--page-scale))`,
        top: `calc(${rect.y}px * var(--page-scale))`,
        width: `calc(${rect.width}px * var(--page-scale))`,
        height: `calc(${rect.height}px * var(--page-scale))`
      }}
    />
  );
}

// One bounding box + rotate/resize handles around a multi-object selection, so the
// whole group can be rotated or scaled as one. Reuses the per-molecule handle classes.
function GroupSelectionOverlay({
  bounds,
  canProjectedPlaneTilt,
  onProjectedPlaneTiltStart,
  onRotateStart,
  onResizeStart
}: {
  bounds: SelectionBounds;
  canProjectedPlaneTilt: boolean;
  onProjectedPlaneTiltStart(event: PointerEvent<HTMLButtonElement>): void;
  onRotateStart(event: PointerEvent<HTMLButtonElement>): void;
  onResizeStart(corner: ObjectResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      className="object-transform-frame group-selection-frame"
      data-group-selection="true"
      data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}
      style={{
        left: `calc(${bounds.x}px * var(--page-scale))`,
        top: `calc(${bounds.y}px * var(--page-scale))`,
        width: `calc(${bounds.width}px * var(--page-scale))`,
        height: `calc(${bounds.height}px * var(--page-scale))`
      }}
    >
      <ObjectResizeHandles
        targetLabel="selected group"
        onResizeDoubleClick={() => (event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onResizeStart={onResizeStart}
      />
      <button
        type="button"
        className="object-rotate-handle"
        aria-label="Rotate selected group"
        data-selection-rotate-handle="true"
        data-group-rotate-handle="true"
        title="Rotate selected group"
        onPointerDown={onRotateStart}
      >
        <RotateSelectionIcon />
      </button>
      {canProjectedPlaneTilt ? (
        <button
          type="button"
          className="object-tilt3d-handle"
          aria-label="3D rotate selected molecules"
          data-selection-tilt3d-handle="true"
          data-group-tilt3d-handle="true"
          title="3D rotate selected molecules"
          onPointerDown={onProjectedPlaneTiltStart}
        >
          <ProjectedPlaneTiltIcon />
        </button>
      ) : null}
    </div>
  );
}

function ArtTransformQaLayer({
  page,
  selectionObjectIds,
  draft,
  onDraftChange,
  onApplyScene,
  onApplySelection
}: {
  page: ChemDraftDocument["pages"][number];
  selectionObjectIds: readonly string[];
  draft: ArtTransformQaDraft;
  onDraftChange(nextDraft: ArtTransformQaDraft): void;
  onApplyScene(): void;
  onApplySelection(): void;
}) {
  const selectionSet = new Set(selectionObjectIds);
  const graphicTargets = page.objects.filter((object): object is GraphicObject => object.type === "graphic");
  const targetObjects = graphicTargets.filter((object) =>
    selectionSet.has(object.id) || ART_TRANSFORM_QA_OBJECT_IDS.includes(object.id as typeof ART_TRANSFORM_QA_OBJECT_IDS[number])
  );
  const overlayObjects = targetObjects.length > 0 ? targetObjects : graphicTargets;
  const selectedGraphicIds = graphicTargets.filter((object) => selectionSet.has(object.id)).map((object) => object.id);
  const handleDraftChange = (field: keyof ArtTransformQaDraft) => (event: ChangeEvent<HTMLInputElement>) => {
    onDraftChange({ ...draft, [field]: event.currentTarget.value });
  };

  return (
    <>
      <svg
        className="art-transform-qa-overlay"
        data-art-transform-qa-layer="true"
        data-art-transform-qa-object-count={overlayObjects.length}
        data-art-transform-qa-selected-ids={selectedGraphicIds.join(",")}
        aria-hidden="true"
        viewBox={`0 0 ${page.width} ${page.height}`}
      >
        {overlayObjects.map((object) => {
          const corners = artTransformQaProjectedCorners(object);
          const projection = documentObjectProjectedPlaneProjection(object);
          const projectedBounds = projection
            ? {
                x: object.x + (Number.parseFloat(`${projection.frameStyle?.left ?? 0}`) || 0),
                y: object.y + (Number.parseFloat(`${projection.frameStyle?.top ?? 0}`) || 0),
                width: Number.parseFloat(`${projection.frameStyle?.width ?? object.width}`) || object.width,
                height: Number.parseFloat(`${projection.frameStyle?.height ?? object.height}`) || object.height
              }
            : { x: object.x, y: object.y, width: object.width, height: object.height };

          return (
            <g data-art-transform-qa-object-id={object.id} key={object.id}>
              <rect
                className="art-transform-qa-model-frame"
                x={object.x}
                y={object.y}
                width={object.width}
                height={object.height}
              />
              <polygon
                className="art-transform-qa-projected-corners"
                points={corners.map((point) => `${formatSvgNumber(point.x)},${formatSvgNumber(point.y)}`).join(" ")}
              />
              <rect
                className="art-transform-qa-projected-bounds"
                x={projectedBounds.x}
                y={projectedBounds.y}
                width={projectedBounds.width}
                height={projectedBounds.height}
              />
              <text className="art-transform-qa-label" x={object.x} y={Math.max(10, object.y - 8)}>
                {object.id}
              </text>
            </g>
          );
        })}
      </svg>
      <section
        className="art-transform-qa-panel"
        data-art-transform-qa-panel="true"
        data-art-transform-qa-selected-ids={selectedGraphicIds.join(",")}
        data-art-transform-qa-target-count={overlayObjects.length}
        aria-label="Art transform QA"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="art-transform-qa-title">Art QA</div>
        <div className="art-transform-qa-fields">
          <label>
            Z
            <input
              aria-label="Art QA Z degrees"
              data-art-transform-qa-input="z"
              inputMode="decimal"
              type="number"
              value={draft.rotationDegrees}
              onChange={handleDraftChange("rotationDegrees")}
            />
          </label>
          <label>
            X
            <input
              aria-label="Art QA X degrees"
              data-art-transform-qa-input="x"
              inputMode="decimal"
              type="number"
              value={draft.tiltXDegrees}
              onChange={handleDraftChange("tiltXDegrees")}
            />
          </label>
          <label>
            Y
            <input
              aria-label="Art QA Y degrees"
              data-art-transform-qa-input="y"
              inputMode="decimal"
              type="number"
              value={draft.tiltYDegrees}
              onChange={handleDraftChange("tiltYDegrees")}
            />
          </label>
        </div>
        <div className="art-transform-qa-actions">
          <button type="button" data-art-transform-qa-action="scene" onClick={onApplyScene}>
            Scene
          </button>
          <button type="button" data-art-transform-qa-action="apply" onClick={onApplySelection}>
            Apply
          </button>
        </div>
        <output className="art-transform-qa-output" data-art-transform-qa-output="true">
          {selectedGraphicIds.length > 0 ? selectedGraphicIds.join(", ") : "no graphic selected"}
        </output>
      </section>
    </>
  );
}

function ArtStyleQaLayer({
  page,
  runCount,
  selectionObjectIds,
  onApplyScene,
  onRunStress
}: {
  page: ChemDraftDocument["pages"][number];
  runCount: number;
  selectionObjectIds: readonly string[];
  onApplyScene(): void;
  onRunStress(): void;
}) {
  const styleObjectCount = page.objects.filter((object) =>
    object.type === "graphic" && ART_STYLE_QA_OBJECT_IDS.includes(object.id as typeof ART_STYLE_QA_OBJECT_IDS[number])
  ).length;
  const selectedStyleObjectIds = selectionObjectIds.filter((objectId) =>
    ART_STYLE_QA_OBJECT_IDS.includes(objectId as typeof ART_STYLE_QA_OBJECT_IDS[number])
  );

  return (
    <section
      className="art-style-qa-panel"
      data-art-style-qa-panel="true"
      data-art-style-qa-count={styleObjectCount}
      data-art-style-qa-run-count={runCount}
      data-art-style-qa-selected-ids={selectedStyleObjectIds.join(",")}
      aria-label="Art style QA"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="art-style-qa-title">Art Style QA</div>
      <div className="art-style-qa-actions">
        <button type="button" data-art-style-qa-action="scene" onClick={onApplyScene}>
          Scene
        </button>
        <button type="button" data-art-style-qa-action="stress" onClick={onRunStress}>
          Stress
        </button>
      </div>
      <output className="art-style-qa-output" data-art-style-qa-output="true">
        {styleObjectCount} graphics / pass {runCount}
      </output>
    </section>
  );
}

export function ObjectLayerContextMenu({
  objectId,
  objectIndex,
  objectCount,
  targetKind,
  bondDepthContext,
  position,
  onInvoke
}: {
  objectId: string;
  objectIndex: number;
  objectCount: number;
  targetKind: ObjectContextMenuState["targetKind"];
  bondDepthContext?: ObjectContextMenuState["bondDepthContext"];
  position: ClientPoint;
  onInvoke(commandId: string): void;
}) {
  const layerLabel = contextMenuLayerLabel(targetKind, objectIndex, objectCount);
  const hasBondDepthContext = bondDepthContext !== undefined && bondDepthContext.relevantCrossings.length > 0;
  const hasMultipleBondTargets = (bondDepthContext?.targetBondRefs.length ?? 0) > 1;

  return (
    <div
      className="object-context-menu"
      role="menu"
      aria-label="Object layer options"
      data-context-object-id={objectId}
      data-context-target-kind={targetKind}
      data-context-layer-index={objectIndex >= 0 ? objectIndex : undefined}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {hasBondDepthContext ? (
        <>
          <div className="object-context-menu-title">Bond depth</div>
          <button
            type="button"
            role="menuitem"
            className="object-context-menu-item"
            data-command-id="bondDepth.bringInFront"
            onClick={() => onInvoke("bondDepth.bringInFront")}
          >
            {hasMultipleBondTargets ? "Bring Selected Bonds In Front" : "Bring Bond In Front"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="object-context-menu-item"
            data-command-id="bondDepth.sendBehind"
            onClick={() => onInvoke("bondDepth.sendBehind")}
          >
            {hasMultipleBondTargets ? "Send Selected Bonds Behind" : "Send Bond Behind"}
          </button>
          {bondDepthContext?.hasOverrides ? (
            <button
              type="button"
              role="menuitem"
              className="object-context-menu-item"
              data-command-id="bondDepth.useDefault"
              onClick={() => onInvoke("bondDepth.useDefault")}
            >
              Use Default Bond Depth
            </button>
          ) : null}
          <div className="object-context-menu-separator" role="separator" />
        </>
      ) : null}
      <div className="object-context-menu-title">{layerLabel}</div>
      {layerContextMenuItems.map((item) => (
        <button
          type="button"
          role="menuitem"
          className="object-context-menu-item"
          data-command-id={item.commandId}
          key={item.commandId}
          onClick={() => onInvoke(item.commandId)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function contextMenuLayerLabel(
  targetKind: ObjectContextMenuState["targetKind"],
  objectIndex: number,
  objectCount: number
): string {
  if (targetKind === "atom" || targetKind === "bond" || targetKind === "parts") {
    return "Molecule layer";
  }

  return objectIndex >= 0 ? `Layer ${objectIndex + 1} of ${objectCount}` : "Layer options";
}

function normalizedRect(startPoint: ClientPoint, latestPoint: ClientPoint): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const x = Math.min(startPoint.x, latestPoint.x);
  const y = Math.min(startPoint.y, latestPoint.y);
  return {
    x,
    y,
    width: Math.abs(startPoint.x - latestPoint.x),
    height: Math.abs(startPoint.y - latestPoint.y)
  };
}

export function selectionInSelectionRect(
  objects: readonly DocumentObject[],
  startPoint: ClientPoint,
  latestPoint: ClientPoint
): { objectIds: string[]; nativeSelection?: NativeMoleculeSelectionPart } {
  const rect = normalizedRect(startPoint, latestPoint);
  const objectIds: string[] = [];
  let nativeSelection: NativeMoleculeSelectionPart | undefined;

  for (const object of objects) {
    if (object.type === "molecule" && isNativeMoleculeGraph(object)) {
      const moleculeSelection = nativeMoleculeSelectionInRect(object, rect);
      if (!moleculeSelection) {
        continue;
      }

      if (nativeMoleculeSelectionCoversWholeObject(object, moleculeSelection)) {
        objectIds.push(object.id);
        continue;
      }

      nativeSelection ??= moleculeSelection;
      continue;
    }

    if (object.type === "graphic") {
      if (graphicObjectIntersectsRect(object, rect)) {
        objectIds.push(object.id);
      }
      continue;
    }

    if (rectangleContainsRect(rect, objectBounds(object))) {
      objectIds.push(object.id);
    }
  }

  return { objectIds, nativeSelection };
}

function nativeMoleculeSelectionCoversWholeObject(
  object: MoleculeObject,
  selection: NativeMoleculeSelectionPart
): boolean {
  if (selection.kind === "atom") {
    return object.atoms.length === 1 && object.bonds.length === 0;
  }
  if (selection.kind === "bond") {
    return object.atoms.length === 0 && object.bonds.length === 1;
  }

  return (
    selection.atomIds.length === object.atoms.length &&
    selection.bondIds.length === object.bonds.length
  );
}

function rectangleContainsRect(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    inner.x >= outer.x &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y >= outer.y &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function objectBounds(object: DocumentObject): { x: number; y: number; width: number; height: number } {
  return {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height
  };
}

function pointInsideObjectBounds(
  point: ClientPoint,
  object: DocumentObject,
  paddingPx = 0
): boolean {
  const bounds = objectBounds(object);
  return (
    point.x >= bounds.x - paddingPx &&
    point.x <= bounds.x + bounds.width + paddingPx &&
    point.y >= bounds.y - paddingPx &&
    point.y <= bounds.y + bounds.height + paddingPx
  );
}

export function nativeMoleculeObjectAtPoint(
  objects: readonly DocumentObject[],
  point: ClientPoint
): MoleculeObject | undefined {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index];
    if (object.type === "molecule" && isNativeMoleculeGraph(object) && pointInsideObjectBounds(point, object, 4)) {
      return object;
    }
  }
  return undefined;
}

function moleculeTransformFrameForSelection(
  object: MoleculeObject,
  selectedPartBounds: { x: number; y: number; width: number; height: number } | undefined
): MoleculeTransformFrame {
  const rawFrame = selectedPartBounds
    ? {
        x: selectedPartBounds.x - object.x,
        y: selectedPartBounds.y - object.y,
        width: selectedPartBounds.width,
        height: selectedPartBounds.height
      }
    : {
        x: 0,
        y: 0,
        width: object.width,
        height: object.height
      };
  const minSize = 28;
  const width = Math.max(rawFrame.width, minSize);
  const height = Math.max(rawFrame.height, minSize);
  const center = {
    x: rawFrame.x + rawFrame.width / 2,
    y: rawFrame.y + rawFrame.height / 2
  };

  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height
  };
}

function nativeMoleculeSelectionInRect(
  object: MoleculeObject,
  rect: { x: number; y: number; width: number; height: number }
): NativeMoleculeSelectionPart | undefined {
  const atomIds = object.atoms
    .filter((atom) => pointInRect(atom, rect))
    .map((atom) => atom.id);
  const bondIds = object.bonds
    .filter((bond) => nativeBondIntersectsRect(object, bond, rect))
    .map((bond) => bond.id);

  if (atomIds.length === 0 && bondIds.length === 0) {
    return undefined;
  }

  if (atomIds.length === 1 && bondIds.length === 0) {
    return { objectId: object.id, kind: "atom", atomId: atomIds[0] };
  }

  if (atomIds.length === 0 && bondIds.length === 1) {
    return { objectId: object.id, kind: "bond", bondId: bondIds[0] };
  }

  return { objectId: object.id, kind: "parts", atomIds, bondIds };
}

function nativeBondIntersectsRect(
  object: MoleculeObject,
  bond: MoleculeObject["bonds"][number],
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return false;
  }

  return (
    pointInRect(fromAtom, rect) ||
    pointInRect(toAtom, rect) ||
    lineIntersectsRect(fromAtom, toAtom, rect)
  );
}

function pointInRect(
  point: ClientPoint,
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function lineIntersectsRect(
  start: ClientPoint,
  end: ClientPoint,
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  return (
    segmentsIntersect(start, end, { x: left, y: top }, { x: right, y: top }) ||
    segmentsIntersect(start, end, { x: right, y: top }, { x: right, y: bottom }) ||
    segmentsIntersect(start, end, { x: right, y: bottom }, { x: left, y: bottom }) ||
    segmentsIntersect(start, end, { x: left, y: bottom }, { x: left, y: top })
  );
}

function segmentsIntersect(a: ClientPoint, b: ClientPoint, c: ClientPoint, d: ClientPoint): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denominator = abx * cdy - aby * cdx;

  if (denominator === 0) {
    return false;
  }

  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const t = (acx * cdy - acy * cdx) / denominator;
  const u = (acx * aby - acy * abx) / denominator;

  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function nativeSelectionFromHit(
  objectId: string,
  hit: NativeMoleculeDeleteHit
): NativeMoleculeSelectionPart {
  return hit.kind === "atom"
    ? { objectId, kind: "atom", atomId: hit.atomId }
    : { objectId, kind: "bond", bondId: hit.bondId };
}

export function nativeContextMenuSelectionFromHit(
  objectId: string,
  hit: NativeMoleculeDeleteHit,
  currentPart: NativeMoleculeSelectionPart | undefined,
  molecule?: MoleculeObject
): NativeMoleculeSelectionPart {
  const compatibleCurrentPart = currentPart?.objectId === objectId ? currentPart : undefined;
  // Preserve the existing (possibly multi-part) selection when the hit is inside the visible
  // selected fragment — including an endpoint atom of a selected bond — not just when the raw
  // primitive id is explicitly listed. Falls back to strict containment without the molecule.
  const preserve = compatibleCurrentPart !== undefined && (
    molecule
      ? nativeSelectionContextContainsHit(molecule, compatibleCurrentPart, hit)
      : nativeSelectionContainsHit(compatibleCurrentPart, hit)
  );
  return preserve && compatibleCurrentPart
    ? compatibleCurrentPart
    : nativeSelectionFromHit(objectId, hit);
}

export function nativeContextMenuSelectionResolutionFromHit(
  document: ChemDraftDocument,
  objectId: string,
  hit: NativeMoleculeDeleteHit,
  currentPart: NativeMoleculeSelectionPart | undefined
): {
  selectedPart?: NativeMoleculeSelectionPart;
  targetKind: "object" | NativeMoleculeSelectionPart["kind"];
} {
  if (isWholeNativeMoleculeSelected(document, objectId, currentPart)) {
    return { targetKind: "object" };
  }

  const selectedPart = nativeContextMenuSelectionFromHit(
    objectId,
    hit,
    currentPart,
    nativeMoleculeById(document, objectId)
  );
  return {
    selectedPart,
    targetKind: selectedPart.kind
  };
}

function nativeSelectionAtomIds(part: NativeMoleculeSelectionPart | undefined): string[] {
  if (part?.kind === "atom") {
    return [part.atomId];
  }

  return part?.kind === "parts" ? [...part.atomIds] : [];
}

function nativeSelectionBondIds(part: NativeMoleculeSelectionPart | undefined): string[] {
  if (part?.kind === "bond") {
    return [part.bondId];
  }

  return part?.kind === "parts" ? [...part.bondIds] : [];
}

export function bondDepthRefsFromNativeSelection(part: NativeMoleculeSelectionPart | undefined): BondRef[] {
  return nativeSelectionBondIds(part).map((bondId) => ({
    objectId: part?.objectId ?? "",
    bondId
  })).filter((ref) => ref.objectId.length > 0);
}

export function bondDepthContextFromNativeSelection(
  part: NativeMoleculeSelectionPart | undefined,
  crossings: readonly ResolvedBondCrossing[]
): BondDepthContext | undefined {
  const targetBondRefs = uniqueBondRefs(bondDepthRefsFromNativeSelection(part));
  if (targetBondRefs.length === 0) {
    return undefined;
  }

  const relevantCrossings = crossings
    .filter((crossing) => crossing.bonds.some((ref) => bondRefInSet(ref, targetBondRefs)))
    .map(menuCrossingFromResolved);
  if (relevantCrossings.length === 0) {
    return undefined;
  }

  return {
    targetBondRefs,
    relevantCrossings,
    hasOverrides: relevantCrossings.some((crossing) => crossing.hasOverride)
  };
}

export function planBondDepthPatches(
  pageId: string,
  context: BondDepthContext | undefined,
  commandId: BondDepthCommandId
): DocumentPatch[] {
  if (!context) {
    return [];
  }

  if (commandId === "bondDepth.useDefault") {
    return context.relevantCrossings
      .filter((crossing) => crossing.hasOverride)
      .map((crossing) => ({
        op: "clearCrossingOverride",
        pageId,
        bonds: crossing.bonds
      }));
  }

  return context.relevantCrossings.flatMap((crossing) => {
    const crossingTargets = crossing.bonds.filter((ref) => bondRefInSet(ref, context.targetBondRefs));
    if (crossingTargets.length !== 1) {
      return [];
    }

    const target = crossingTargets[0];
    if (commandId === "bondDepth.bringInFront") {
      return sameBondRef(crossing.front, target)
        ? []
        : [{
            op: "setCrossingOverride",
            pageId,
            crossing: { bonds: crossing.bonds, front: target }
          }];
    }

    const other = crossing.bonds.find((ref) => !sameBondRef(ref, target));
    return other && sameBondRef(crossing.front, target)
      ? [{
          op: "setCrossingOverride",
          pageId,
          crossing: { bonds: crossing.bonds, front: other }
        }]
      : [];
  });
}

function isBondDepthCommandId(commandId: string): commandId is BondDepthCommandId {
  return commandId === "bondDepth.bringInFront" ||
    commandId === "bondDepth.sendBehind" ||
    commandId === "bondDepth.useDefault";
}

export function crossingClearPatchesForObjectLayerPlacement(
  page: ChemDraftDocument["pages"][number],
  objectId: string,
  placement: ObjectReorderPlacement
): DocumentPatch[] {
  const affectedObjectIds = objectLayerPlacementAffectedObjectIds(page.objects, objectId, placement);
  if (affectedObjectIds.length === 0) {
    return [];
  }

  const affected = new Set(affectedObjectIds);
  return page.crossings
    .filter((crossing) => crossingTouchesObjectAndAffectedObject(crossing.bonds, objectId, affected))
    .map((crossing) => ({
      op: "clearCrossingOverride",
      pageId: page.id,
      bonds: crossing.bonds
    }));
}

export function reorderSelectedDocumentObjectWithCrossingDefaults(
  document: ChemDraftDocument,
  placement: ObjectReorderPlacement
): ChemDraftDocument {
  const objectId = document.selection.objectIds[0];
  if (!objectId) {
    return document;
  }

  const page = document.pages.find((candidate) => candidate.objects.some((object) => object.id === objectId));
  if (!page) {
    return document;
  }

  const crossingPatches = crossingClearPatchesForObjectLayerPlacement(page, objectId, placement);
  const reordered = reorderSelectedDocumentObject(document, placement);
  return crossingPatches.length > 0 ? applyPatches(reordered, crossingPatches) : reordered;
}

function objectLayerPlacementAffectedObjectIds(
  objects: readonly DocumentObject[],
  objectId: string,
  placement: ObjectReorderPlacement
): string[] {
  const objectIndex = objects.findIndex((object) => object.id === objectId);
  if (objectIndex < 0) {
    return [];
  }

  if (placement === "front" || placement === "back") {
    return objects.filter((object) => object.id !== objectId).map((object) => object.id);
  }

  if (placement === "forward") {
    return objectIndex < objects.length - 1 ? [objects[objectIndex + 1].id] : [];
  }

  return objectIndex > 0 ? [objects[objectIndex - 1].id] : [];
}

function crossingTouchesObjectAndAffectedObject(
  bonds: readonly [BondRef, BondRef],
  objectId: string,
  affectedObjectIds: ReadonlySet<string>
): boolean {
  const selectedBond = bonds.find((bond) => bond.objectId === objectId);
  const otherBond = bonds.find((bond) => bond.objectId !== objectId);
  return selectedBond !== undefined && otherBond !== undefined && affectedObjectIds.has(otherBond.objectId);
}

function bondDepthStatusForCommand(commandId: BondDepthCommandId): string {
  if (commandId === "bondDepth.bringInFront") {
    return "Brought bond depth forward";
  }
  if (commandId === "bondDepth.sendBehind") {
    return "Sent bond depth behind";
  }
  return "Restored default bond depth";
}

function menuCrossingFromResolved(crossing: ResolvedBondCrossing): BondDepthMenuCrossing {
  return {
    key: crossing.key,
    bonds: crossing.bonds,
    front: crossing.front,
    back: crossing.back,
    hasOverride: crossing.hasOverride
  };
}

function uniqueBondRefs(refs: readonly BondRef[]): BondRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = bondRefKey(ref);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function bondRefInSet(ref: BondRef, refs: readonly BondRef[]): boolean {
  return refs.some((candidate) => sameBondRef(candidate, ref));
}

function sameBondRef(left: BondRef, right: BondRef): boolean {
  return left.objectId === right.objectId && left.bondId === right.bondId;
}

function toggledSelectionIds(ids: readonly string[], id: string): string[] {
  return ids.includes(id)
    ? ids.filter((candidate) => candidate !== id)
    : [...ids, id];
}

function nativeSelectionFromIds(
  objectId: string,
  atomIds: readonly string[],
  bondIds: readonly string[]
): NativeMoleculeSelectionPart | undefined {
  if (atomIds.length === 0 && bondIds.length === 0) {
    return undefined;
  }

  if (atomIds.length === 1 && bondIds.length === 0) {
    return { objectId, kind: "atom", atomId: atomIds[0] };
  }

  if (atomIds.length === 0 && bondIds.length === 1) {
    return { objectId, kind: "bond", bondId: bondIds[0] };
  }

  return { objectId, kind: "parts", atomIds: [...atomIds], bondIds: [...bondIds] };
}

export function nativeSelectionWithHitToggled(
  currentPart: NativeMoleculeSelectionPart | undefined,
  objectId: string,
  hit: NativeMoleculeDeleteHit
): NativeMoleculeSelectionPart | undefined {
  const compatibleCurrentPart = currentPart?.objectId === objectId ? currentPart : undefined;
  const atomIds = nativeSelectionAtomIds(compatibleCurrentPart);
  const bondIds = nativeSelectionBondIds(compatibleCurrentPart);

  return hit.kind === "atom"
    ? nativeSelectionFromIds(objectId, toggledSelectionIds(atomIds, hit.atomId), bondIds)
    : nativeSelectionFromIds(objectId, atomIds, toggledSelectionIds(bondIds, hit.bondId));
}

export function nativeMoleculeSelectionDragIntent(
  document: ChemDraftDocument,
  objectId: string,
  selectedPart: NativeMoleculeSelectionPart | undefined,
  hit: NativeMoleculeDeleteHit | undefined
): NativeMoleculeSelectionDragIntent {
  if (!hit) {
    return { kind: "none" };
  }

  if (isWholeNativeMoleculeSelected(document, objectId, selectedPart)) {
    return { kind: "whole-object" };
  }

  const currentPart = selectedPart?.objectId === objectId ? selectedPart : undefined;
  const molecule = nativeMoleculeById(document, objectId);
  // Dragging from an endpoint atom of a selected bond should move the whole selected fragment,
  // matching the visible selection — so use the same context-aware containment as right-click.
  const withinSelection = currentPart !== undefined && (
    molecule
      ? nativeSelectionContextContainsHit(molecule, currentPart, hit)
      : nativeSelectionContainsHit(currentPart, hit)
  );
  if (withinSelection && currentPart) {
    return { kind: "native-part", target: currentPart };
  }

  if (hit.kind === "atom") {
    return { kind: "native-part", target: nativeSelectionFromHit(objectId, hit) };
  }

  return { kind: "none" };
}

function nativeSelectionIncludesAtom(part: NativeMoleculeSelectionPart | undefined, atomId: string): boolean {
  if (part?.kind === "atom") {
    return part.atomId === atomId;
  }

  return part?.kind === "parts" && part.atomIds.includes(atomId);
}

function nativeSelectionIncludesBond(part: NativeMoleculeSelectionPart | undefined, bondId: string): boolean {
  if (part?.kind === "bond") {
    return part.bondId === bondId;
  }

  return part?.kind === "parts" && part.bondIds.includes(bondId);
}

function nativeSelectionRenderKey(part: NativeMoleculeSelectionPart | undefined): string {
  if (!part) {
    return "none";
  }

  if (part.kind === "atom") {
    return `atom:${part.atomId}`;
  }

  if (part.kind === "bond") {
    return `bond:${part.bondId}`;
  }

  return `parts:a=${part.atomIds.join(",")};b=${part.bondIds.join(",")}`;
}

export function nativeMoleculeSelectionHasVisibleTargets(
  object: MoleculeObject,
  selected: boolean,
  selectedPart: NativeMoleculeSelectionPart | undefined
): boolean {
  if (selected && selectedPart?.objectId !== object.id) {
    return object.atoms.length > 0 || object.bonds.length > 0;
  }

  if (!selectedPart || selectedPart.objectId !== object.id) {
    return false;
  }

  return (
    object.atoms.some((atom) => nativeSelectionIncludesAtom(selectedPart, atom.id)) ||
    object.bonds.some((bond) => nativeSelectionIncludesBond(selectedPart, bond.id))
  );
}

function nativeSelectionContainsHit(
  part: NativeMoleculeSelectionPart,
  hit: NativeMoleculeDeleteHit
): boolean {
  if (hit.kind === "atom") {
    return nativeSelectionIncludesAtom(part, hit.atomId);
  }

  return nativeSelectionIncludesBond(part, hit.bondId);
}

/**
 * Whether a hit belongs to the *visible* selected fragment, not just the raw primitive list.
 * The selection blob draws each selected bond's endpoint atoms as selected (see the
 * `selectedAtomIds.add(bond.fromAtomId/.toAtomId)` expansion in the molecule renderer), so a
 * right-click or drag that lands on such an endpoint atom should be treated as inside the
 * selection — even though the atom id is not explicitly stored in `part.atomIds`. The strict
 * `nativeSelectionContainsHit` stays for primitive-identity callers (e.g. delete).
 */
function nativeSelectionContextContainsHit(
  molecule: MoleculeObject,
  part: NativeMoleculeSelectionPart,
  hit: NativeMoleculeDeleteHit
): boolean {
  if (nativeSelectionContainsHit(part, hit)) {
    return true;
  }

  if (hit.kind === "atom") {
    return molecule.bonds.some(
      (bond) =>
        nativeSelectionIncludesBond(part, bond.id) &&
        (bond.fromAtomId === hit.atomId || bond.toAtomId === hit.atomId)
    );
  }

  return false;
}

/** The molecule object for `objectId`, or undefined when it is not an editable molecule. */
function nativeMoleculeById(document: ChemDraftDocument, objectId: string): MoleculeObject | undefined {
  const object = findDocumentObject(document, objectId);
  return object?.type === "molecule" ? object : undefined;
}

function isWholeNativeMoleculeSelected(
  document: ChemDraftDocument,
  objectId: string,
  selectedPart: NativeMoleculeSelectionPart | undefined
): boolean {
  return document.selection.objectIds.includes(objectId) && selectedPart?.objectId !== objectId;
}

function selectionStatusLabel(selection: {
  objectIds: readonly string[];
  nativeSelection?: NativeMoleculeSelectionPart;
}): string {
  if (selection.nativeSelection?.kind === "atom") {
    return "Selected atom";
  }

  if (selection.nativeSelection?.kind === "bond") {
    return "Selected bond";
  }

  if (selection.nativeSelection?.kind === "parts") {
    const count = selection.nativeSelection.atomIds.length + selection.nativeSelection.bondIds.length;
    return count === 1 ? "Selected molecule part" : `Selected ${count} molecule parts`;
  }

  if (selection.objectIds.length === 1) {
    return "Selected object";
  }

  if (selection.objectIds.length > 1) {
    return `Selected ${selection.objectIds.length} objects`;
  }

  return "No selection";
}

function PageSvgSurface({
  ariaLabel,
  pageHeight,
  pageWidth,
  plan,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu
}: {
  ariaLabel: string;
  pageHeight: number;
  pageWidth: number;
  plan: PageSvgRenderPlan;
  onPointerDown(objectId: string, event: ObjectPointerEvent): void;
  onPointerMove(objectId: string, event: ObjectPointerEvent): void;
  onPointerUp(objectId: string, event: ObjectPointerEvent): void;
  onPointerCancel(event: ObjectPointerEvent): void;
  onPointerLeave(objectId: string): void;
  onContextMenu(objectId: string, event: ObjectMouseEvent): void;
}) {
  return (
    <svg
      aria-label={`${ariaLabel} page drawing`}
      className="page-svg-surface"
      data-page-svg-surface="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
    >
      {plan.fragments.map((fragment) => renderPageSvgFragment(fragment, {
        onContextMenu,
        onPointerCancel,
        onPointerDown,
        onPointerLeave,
        onPointerMove,
        onPointerUp
      }))}
    </svg>
  );
}

function renderPageSvgFragment(
  fragment: PageSvgFragment,
  handlers: {
    onPointerDown(objectId: string, event: ObjectPointerEvent): void;
    onPointerMove(objectId: string, event: ObjectPointerEvent): void;
    onPointerUp(objectId: string, event: ObjectPointerEvent): void;
    onPointerCancel(event: ObjectPointerEvent): void;
    onPointerLeave(objectId: string): void;
    onContextMenu(objectId: string, event: ObjectMouseEvent): void;
  }
): ReturnType<typeof createElement> | string {
  if (fragment.kind === "text") {
    return fragment.text;
  }

  const objectId = typeof fragment.attrs["data-object-id"] === "string"
    ? fragment.attrs["data-object-id"]
    : undefined;
  const props = reactSvgProps(fragment.attrs);
  if (objectId) {
    Object.assign(props, {
      onContextMenu: (event: ObjectMouseEvent) => handlers.onContextMenu(objectId, event),
      onPointerCancel: (event: ObjectPointerEvent) => handlers.onPointerCancel(event),
      onPointerDown: (event: ObjectPointerEvent) => handlers.onPointerDown(objectId, event),
      onPointerLeave: () => handlers.onPointerLeave(objectId),
      onPointerMove: (event: ObjectPointerEvent) => handlers.onPointerMove(objectId, event),
      onPointerUp: (event: ObjectPointerEvent) => handlers.onPointerUp(objectId, event)
    });
  }

  return createElement(
    fragment.tag,
    { ...props, key: fragment.key },
    ...fragment.children.map((child) => renderPageSvgFragment(child, handlers))
  );
}

function reactSvgProps(attrs: Record<string, PageSvgAttributeValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([, value]) => value !== undefined && value !== false && value !== "")
      .map(([key, value]) => [reactSvgAttributeName(key), value])
  );
}

function reactSvgAttributeName(name: string): string {
  return {
    class: "className",
    "baseline-shift": "baselineShift",
    "dominant-baseline": "dominantBaseline",
    "font-family": "fontFamily",
    "font-size": "fontSize",
    "font-style": "fontStyle",
    "font-weight": "fontWeight",
    "letter-spacing": "letterSpacing",
    "stroke-dasharray": "strokeDasharray",
    "stroke-linecap": "strokeLinecap",
    "stroke-linejoin": "strokeLinejoin",
    "stroke-width": "strokeWidth",
    "text-anchor": "textAnchor",
    "text-decoration": "textDecoration"
  }[name] ?? name;
}

function DocumentObjectView({
  object,
  layerIndex,
  pageWidth,
  pageHeight,
  selected,
  inGroupSelection,
  graphicTransformActive,
  selectedPart,
  editingText,
  editingAtomLabel,
  chargeByAtomId,
  growthPreview,
  deleteTarget,
  hoverDestructive,
  freeformPreview,
  doubleBondSidePreview,
  rotateReadout,
  projectedPlaneTiltReadout,
  rotationInput,
  resizeReadout,
  resizeInput,
  graphicCornerRadiusReadout,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onRotatePointerDown,
  onRotateDoubleClick,
  onProjectedPlaneTiltPointerDown,
  onProjectedPlaneTiltDoubleClick,
  onGraphicCornerRadiusPointerDown,
  onGraphicCornerRadiusDoubleClick,
  onGraphicPathEditPointerDown,
  onGraphicMarkerPointerDown,
  onRotationInputChange,
  onRotationInputKeep,
  onRotationInputHome,
  onRotationInputCancel,
  onObjectResizePointerDown,
  onObjectResizeDoubleClick,
  onObjectResizeInputChange,
  onObjectResizeInputKeep,
  onObjectResizeInputHome,
  onObjectResizeInputCancel,
  onContextMenu,
  onTextChange,
  onTextEditStart,
  onTextEditFinish,
  onTextSelectionChange,
  onTextResizeStart,
  onAtomLabelChange,
  onAtomLabelCancel,
  onAtomLabelFinish
}: {
  object: DocumentObject;
  layerIndex: number;
  pageWidth: number;
  pageHeight: number;
  selected: boolean;
  inGroupSelection: boolean;
  graphicTransformActive: boolean;
  selectedPart?: NativeMoleculeSelectionPart;
  editingText: boolean;
  editingAtomLabel?: AtomLabelEditState;
  chargeByAtomId?: ReadonlyMap<string, number>;
  growthPreview?: HoveredNativeAtom;
  deleteTarget?: NativeMoleculeDeleteTarget;
  hoverDestructive: boolean;
  freeformPreview?: FreeformNativeBondPreview;
  doubleBondSidePreview?: NativeDoubleBondSidePreview;
  rotateReadout?: ObjectRotateReadoutState;
  projectedPlaneTiltReadout?: ProjectedPlaneTiltReadoutState;
  rotationInput?: RotationInputState;
  resizeReadout?: ObjectResizeReadoutState;
  resizeInput?: ObjectResizeInputState;
  graphicCornerRadiusReadout?: GraphicCornerRadiusReadoutState;
  onPointerDown(objectId: string, event: ObjectPointerEvent): void;
  onPointerMove(objectId: string, event: ObjectPointerEvent): void;
  onPointerUp(objectId: string, event: ObjectPointerEvent): void;
  onPointerCancel(event: ObjectPointerEvent): void;
  onPointerLeave(objectId: string): void;
  onRotatePointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onRotateDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltPointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onGraphicCornerRadiusPointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onGraphicCornerRadiusDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onGraphicPathEditPointerDown(objectId: string, handle: NativeGraphicPathEditHandle, event: PointerEvent<HTMLButtonElement>): void;
  onGraphicMarkerPointerDown(objectId: string, markerId: NativeGraphicMarkerHandleId, event: PointerEvent<HTMLButtonElement>): void;
  onRotationInputChange(nextInput: RotationInputState): void;
  onRotationInputKeep(input: RotationInputState): void;
  onRotationInputHome(input: RotationInputState): void;
  onRotationInputCancel(input: RotationInputState): void;
  onObjectResizePointerDown(objectId: string, corner: ObjectResizeCorner, event: PointerEvent<HTMLButtonElement>): void;
  onObjectResizeDoubleClick(objectId: string, corner: ObjectResizeCorner, event: ReactMouseEvent<HTMLButtonElement>): void;
  onObjectResizeInputChange(nextInput: ObjectResizeInputState): void;
  onObjectResizeInputKeep(input: ObjectResizeInputState): void;
  onObjectResizeInputHome(input: ObjectResizeInputState): void;
  onObjectResizeInputCancel(input: ObjectResizeInputState): void;
  onContextMenu(objectId: string, event: ObjectMouseEvent): void;
  onTextChange(objectId: string, text: string): void;
  onTextEditStart(objectId: string): void;
  onTextEditFinish(): void;
  onTextSelectionChange(objectId: string, range: NativeTextSelectionRange): void;
  onTextResizeStart(objectId: string, edge: TextResizeEdge, event: PointerEvent<HTMLButtonElement>): void;
  onAtomLabelChange(state: AtomLabelEditState, text: string): void;
  onAtomLabelCancel(state: AtomLabelEditState): void;
  onAtomLabelFinish(): void;
}) {
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editingText || object.type !== "text") {
      return;
    }

    const editor = textEditorRef.current;
    if (!editor) {
      return;
    }

    editor.focus();
    if (object.text === "Text") {
      editor.select();
    }
  }, [editingText, object]);

  const handleObjectPointerDown = (event: ObjectPointerEvent) => {
    onPointerDown(object.id, event);
  };
  const handleObjectPointerMove = (event: ObjectPointerEvent) => {
    onPointerMove(object.id, event);
  };
  const handleObjectPointerUp = (event: ObjectPointerEvent) => {
    onPointerUp(object.id, event);
  };
  const handleObjectPointerCancel = (event: ObjectPointerEvent) => {
    onPointerCancel(event);
  };
  const handleObjectPointerLeave = () => {
    onPointerLeave(object.id);
  };
  const handleObjectContextMenu = (event: ObjectMouseEvent) => {
    onContextMenu(object.id, event);
  };
  const handleRotatePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onRotatePointerDown(object.id, event);
  };
  const handleRotateDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onRotateDoubleClick(object.id, event);
  };
  const handleProjectedPlaneTiltPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onProjectedPlaneTiltPointerDown(object.id, event);
  };
  const handleProjectedPlaneTiltDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onProjectedPlaneTiltDoubleClick(object.id, event);
  };
  const handleGraphicCornerRadiusPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onGraphicCornerRadiusPointerDown(object.id, event);
  };
  const handleGraphicCornerRadiusDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onGraphicCornerRadiusDoubleClick(object.id, event);
  };
  const handleGraphicPathEditPointerDown = (handle: NativeGraphicPathEditHandle) => (event: PointerEvent<HTMLButtonElement>) => {
    onGraphicPathEditPointerDown(object.id, handle, event);
  };
  const handleGraphicMarkerPointerDown = (markerId: NativeGraphicMarkerHandleId) => (event: PointerEvent<HTMLButtonElement>) => {
    onGraphicMarkerPointerDown(object.id, markerId, event);
  };
  const handleObjectResizePointerDown = (corner: ObjectResizeCorner) => (event: PointerEvent<HTMLButtonElement>) => {
    onObjectResizePointerDown(object.id, corner, event);
  };
  const handleObjectResizeDoubleClick = (corner: ObjectResizeCorner) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    onObjectResizeDoubleClick(object.id, corner, event);
  };
  const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    recordTextEditorSelection(event.currentTarget);
    onTextChange(object.id, event.currentTarget.value);
  };
  const recordTextEditorSelection = (editor: HTMLTextAreaElement) => {
    onTextSelectionChange(object.id, {
      start: editor.selectionStart,
      end: editor.selectionEnd
    });
  };
  const insertTextAtEditorSelection = (editor: HTMLTextAreaElement, text: string) => {
    if (object.type !== "text" || text.length === 0) {
      return;
    }

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const currentValue = editor.value;
    const nextValue = `${currentValue.slice(0, start)}${text}${currentValue.slice(end)}`;
    const cursor = start + text.length;
    onTextChange(object.id, nextValue);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(cursor, cursor);
      recordTextEditorSelection(editor);
    });
  };
  const handleTextPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (text.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    insertTextAtEditorSelection(event.currentTarget, text);
  };
  const handleTextKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onTextEditFinish();
      return;
    }

    const commandKeyPressed = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (commandKeyPressed && key === "a") {
      event.preventDefault();
      event.currentTarget.select();
      recordTextEditorSelection(event.currentTarget);
      return;
    }

    if (commandKeyPressed && key === "v") {
      event.preventDefault();
      const editor = event.currentTarget;
      void readClipboardPayload().then((payload) => {
        const detectedPayload = inspectClipboardPayload(payload);
        if (detectedPayload.kind === "plain-text") {
          insertTextAtEditorSelection(editor, detectedPayload.text);
        }
      });
    }
  };
  const handleTextDoubleClick = (event: ObjectMouseEvent) => {
    if (object.type !== "text") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onTextEditStart(object.id);
  };
  const handleTextResizeStart = (edge: TextResizeEdge) => (event: PointerEvent<HTMLButtonElement>) => {
    onTextResizeStart(object.id, edge, event);
  };
  const handleAtomLabelKeyDown = (state: AtomLabelEditState, event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      onAtomLabelFinish();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onAtomLabelCancel(state);
    }
  };
  const style = {
    left: `${(object.x / pageWidth) * 100}%`,
    top: `${(object.y / pageHeight) * 100}%`,
    width: `${(object.width / pageWidth) * 100}%`,
    height: `${(object.height / pageHeight) * 100}%`,
    zIndex: layerIndex + 20,
    transform: documentObjectSupportsArtTransform(object) ? undefined : documentObjectCssTransform(object)
  } as CSSProperties;
  const artObjectProjection = documentObjectSupportsArtTransform(object)
    ? documentObjectProjectedPlaneProjection(object)
    : undefined;
  const artObjectTransformFrameStyle = artObjectProjection?.frameStyle;
  const graphicPathEditPoints = object.type === "graphic" ? nativeGraphicPathEditPoints(object) : undefined;
  const graphicCornerRadiusEditPoint = object.type === "graphic" ? nativeGraphicCornerRadiusEditPoint(object) : undefined;
  const pathGraphicInEditMode = selected &&
    object.type === "graphic" &&
    graphicPathEditPoints !== undefined &&
    !graphicTransformActive;
  const showGraphicCornerRadiusHandle = selected &&
    object.type === "graphic" &&
    graphicCornerRadiusEditPoint !== undefined &&
    !inGroupSelection &&
    !graphicTransformActive &&
    !pathGraphicInEditMode &&
    !editingText &&
    !editingAtomLabel &&
    !rotateReadout &&
    !projectedPlaneTiltReadout &&
    !rotationInput &&
    !resizeReadout &&
    !resizeInput;
  const showArtObjectTransformFrame = selected &&
    !inGroupSelection &&
    documentObjectSupportsArtTransform(object) &&
    !pathGraphicInEditMode;
  const artObjectTransformFrame = showArtObjectTransformFrame ? (
    <ArtObjectTransformFrame
      frameStyle={artObjectTransformFrameStyle}
      targetLabel="selected art object"
      rotateReadout={rotateReadout}
      projectedPlaneTiltReadout={projectedPlaneTiltReadout}
      rotationInput={rotationInput}
      resizeReadout={resizeReadout}
      resizeInput={resizeInput}
      onRotatePointerDown={handleRotatePointerDown}
      onRotateDoubleClick={handleRotateDoubleClick}
      onProjectedPlaneTiltPointerDown={handleProjectedPlaneTiltPointerDown}
      onProjectedPlaneTiltDoubleClick={handleProjectedPlaneTiltDoubleClick}
      onRotationInputChange={onRotationInputChange}
      onRotationInputKeep={onRotationInputKeep}
      onRotationInputHome={onRotationInputHome}
      onRotationInputCancel={onRotationInputCancel}
      onResizePointerDown={handleObjectResizePointerDown}
      onResizeDoubleClick={handleObjectResizeDoubleClick}
      onResizeInputChange={onObjectResizeInputChange}
      onResizeInputKeep={onObjectResizeInputKeep}
      onResizeInputHome={onObjectResizeInputHome}
      onResizeInputCancel={onObjectResizeInputCancel}
    />
  ) : null;

  if (object.type === "molecule") {
    if (isNativeMoleculeGraph(object)) {
      const drawingStyle = nativeDrawingStyleFromObjectStyle(object.style);
      const invalidAtomStates = nativeMoleculeInvalidAtomStates(object, chargeByAtomId);
      const invalidAtomIds = new Set(invalidAtomStates.map((state) => state.atomId));
      const resolvedChargeAtomIds = [...(chargeByAtomId?.entries() ?? [])]
        .filter(([, charge]) => charge !== 0)
        .map(([atomId]) => atomId);
      const wholeNativeMoleculeSelected = selected && selectedPart?.objectId !== object.id;
      const selectedBondIds = new Set(
        wholeNativeMoleculeSelected
          ? object.bonds.map((bond) => bond.id)
          : object.bonds
              .filter((bond) => nativeSelectionIncludesBond(selectedPart, bond.id))
              .map((bond) => bond.id)
      );
      const selectedAtomIds = new Set(
        wholeNativeMoleculeSelected
          ? object.atoms.map((atom) => atom.id)
          : object.atoms
              .filter((atom) => nativeSelectionIncludesAtom(selectedPart, atom.id))
              .map((atom) => atom.id)
      );
      object.bonds
        .filter((bond) => selectedBondIds.has(bond.id))
        .forEach((bond) => {
          selectedAtomIds.add(bond.fromAtomId);
          selectedAtomIds.add(bond.toAtomId);
        });
      const hasVisibleSelectionTargets = nativeMoleculeSelectionHasVisibleTargets(object, selected, selectedPart);
      const selectedFragmentBounds = selectedPart && hasVisibleSelectionTargets
        ? nativeMoleculePartBounds(object, selectedPart)
        : undefined;
      const transformFrame = hasVisibleSelectionTargets && !inGroupSelection && (selected || selectedFragmentBounds)
        ? moleculeTransformFrameForSelection(object, selectedFragmentBounds)
        : undefined;
      const transformTargetLabel = selectedFragmentBounds ? "selected molecule fragment" : "selected molecule";
      const canProjectedPlaneTilt = transformFrame !== undefined;
      const transformFrameStyle = transformFrame ? {
        left: `calc(${transformFrame.x}px * var(--page-scale))`,
        top: `calc(${transformFrame.y}px * var(--page-scale))`,
        width: `calc(${transformFrame.width}px * var(--page-scale))`,
        height: `calc(${transformFrame.height}px * var(--page-scale))`
      } as CSSProperties : undefined;
      const selectionBlob = selectedBondIds.size > 0 || selectedAtomIds.size > 0 ? (
        <g
          className={[
            "native-molecule-selection-blob",
            selectedBondIds.size > 0 ? "native-bond-selection-connectors" : "",
            wholeNativeMoleculeSelected ? "native-whole-selection" : ""
          ].filter(Boolean).join(" ")}
          data-selection-blob="true"
          data-bond-selection-connectors={selectedBondIds.size > 0 ? "true" : undefined}
          data-whole-molecule-selection={wholeNativeMoleculeSelected ? "true" : undefined}
        >
          {object.bonds.flatMap((bond) => {
            if (!selectedBondIds.has(bond.id)) {
              return [];
            }

            const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
            const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
            if (!fromAtom || !toAtom) {
              return [];
            }

            return [
              <line
                className={[
                  "native-selection-blob-bond",
                  "native-bond-selection-connector",
                  wholeNativeMoleculeSelected ? "native-whole-selection-bond" : ""
                ].filter(Boolean).join(" ")}
                data-selected-bond-id={bond.id}
                key={`selection-blob-bond-${bond.id}`}
                x1={fromAtom.x - object.x}
                y1={fromAtom.y - object.y}
                x2={toAtom.x - object.x}
                y2={toAtom.y - object.y}
              />
            ];
          })}
          {object.atoms
            .filter((atom) => selectedAtomIds.has(atom.id))
            .map((atom) => (
              <circle
                className={[
                  "native-selection-blob-atom",
                  wholeNativeMoleculeSelected ? "native-whole-selection-atom" : "native-atom-selected"
                ].filter(Boolean).join(" ")}
                data-selected-atom-id={atom.id}
                cx={atom.x - object.x}
                cy={atom.y - object.y}
                key={`selection-blob-atom-${atom.id}`}
                r="8.8"
              />
            ))}
        </g>
      ) : null;
      return (
        <div
          className={[
            "document-object",
            "document-object-overlay",
            "molecule-object",
            "native-molecule-object",
            moleculeDrawingPrimitive(object) === "single-bond" ? "native-single-bond" : "native-carbon-chain",
            selected ? "native-molecule-selected" : ""
          ].filter(Boolean).join(" ")}
          style={style}
          data-object-id={object.id}
          data-layer-index={layerIndex}
          data-structure={object.structure}
          data-atom-count={object.atoms.length}
          data-bond-count={object.bonds.length}
          data-bond-orders={object.bonds.map((bond) => `${bond.id}:${bond.order}`).join(",")}
          data-style-preset-id={drawingStyle.stylePresetId}
          data-invalid-atom-ids={invalidAtomStates.map((state) => state.atomId).join(",") || undefined}
          data-resolved-charge-atom-ids={resolvedChargeAtomIds.join(",") || undefined}
          data-hovered-atom-id={growthPreview?.atomId}
          data-growth-preview-atom-id={growthPreview?.atomId}
          data-delete-hover-kind={deleteTarget?.kind}
          data-delete-hover-atom-id={deleteTarget?.kind === "atom" ? deleteTarget.atomId : undefined}
          data-delete-hover-bond-id={deleteTarget?.kind === "bond" ? deleteTarget.bondId : undefined}
          data-selected-native-kind={selectedPart?.kind}
          data-selected-native-atom-id={selectedPart?.kind === "atom" ? selectedPart.atomId : undefined}
          data-selected-native-bond-id={selectedPart?.kind === "bond" ? selectedPart.bondId : undefined}
          data-freeform-preview-atom-id={freeformPreview?.atomId}
          data-freeform-preview-target-atom-id={freeformPreview?.targetAtomId}
          data-freeform-preview-custom-length={freeformPreview?.customLength}
          data-freeform-preview-length-angstrom={freeformPreview?.lengthAngstrom}
          data-double-bond-preview-bond-id={doubleBondSidePreview?.bondId}
          data-double-bond-preview-side={doubleBondSidePreview?.side}
          aria-label={moleculeAriaLabel(object)}
          onPointerDown={handleObjectPointerDown}
          onPointerMove={handleObjectPointerMove}
          onPointerUp={handleObjectPointerUp}
          onPointerCancel={handleObjectPointerCancel}
          onPointerLeave={handleObjectPointerLeave}
          onContextMenu={handleObjectContextMenu}
        >
          <svg className="native-molecule-overlay" viewBox={`0 0 ${object.width} ${object.height}`} aria-hidden="true">
            {selectionBlob}
            {object.atoms
              .filter((atom) => invalidAtomIds.has(atom.id))
              .map((atom) => (
                <g
                  className="native-atom-invalid-marker"
                  data-invalid-atom-id={atom.id}
                  key={`invalid-${atom.id}`}
                >
                  <circle
                    className="native-atom-invalid-ring"
                    cx={atom.x - object.x + 9}
                    cy={atom.y - object.y - 9}
                    r="6"
                  />
                  <text
                    className="native-atom-invalid-exclamation"
                    x={atom.x - object.x + 9}
                    y={atom.y - object.y - 9}
                  >
                    !
                  </text>
                </g>
              ))}
            {object.atoms
              .filter((atom) => deleteTarget?.kind === "atom" && atom.id === deleteTarget.atomId)
              .map((atom) => (
                <circle
                  className={hoverDestructive ? "native-atom-delete-hover" : "native-atom-hover"}
                  cx={atom.x - object.x}
                  cy={atom.y - object.y}
                  key={`hover-${atom.id}`}
                  r="8"
                />
              ))}
            {/* Bond hover, drawn from the resolver result so it matches the click target
                (invariant #2) instead of the old CSS :hover decorator. */}
            {deleteTarget?.kind === "bond"
              ? [deleteTarget].flatMap((target) => {
                  const from = object.atoms.find((atom) => atom.id === target.fromAtomId);
                  const to = object.atoms.find((atom) => atom.id === target.toAtomId);
                  return from && to
                    ? [
                        <line
                          className={hoverDestructive ? "native-bond-delete-hover" : "native-bond-hover"}
                          key={`hover-${target.bondId}`}
                          x1={from.x - object.x}
                          y1={from.y - object.y}
                          x2={to.x - object.x}
                          y2={to.y - object.y}
                        />
                      ]
                    : [];
                })
              : null}
            {object.atoms
              .filter((atom) => atom.id === growthPreview?.atomId && atom.id !== freeformPreview?.atomId)
              .map((atom) => (
                <NativeBondGrowthPreview
                  atom={atom}
                  candidateDirections={growthPreview?.candidateDirections ?? [growthPreview?.direction ?? { x: 1, y: 0 }]}
                  direction={growthPreview?.direction ?? { x: 1, y: 0 }}
                  key={atom.id}
                  object={object}
                />
              ))}
            {object.atoms
              .filter((atom) => atom.id === freeformPreview?.atomId)
              .map((atom) => (
                <NativeFreeformBondPreview
                  atom={atom}
                  key={atom.id}
                  newAtomPoint={freeformPreview?.newAtomPoint ?? atom}
                  object={object}
                  targetAtom={object.atoms.find((candidate) => candidate.id === freeformPreview?.targetAtomId)}
              />
            ))}
          </svg>
          {transformFrame ? (
            <div
              className="object-transform-frame"
              data-molecule-transform-frame={selectedFragmentBounds ? "fragment" : "whole"}
              data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}
              style={transformFrameStyle}
            >
              <ObjectResizeHandles
                targetLabel={transformTargetLabel}
                onResizeDoubleClick={handleObjectResizeDoubleClick}
                onResizeStart={handleObjectResizePointerDown}
              />
              {resizeReadout && !resizeInput ? (
                <ObjectResizeReadout
                  scaleXPercent={resizeReadout.scaleXPercent}
                  scaleYPercent={resizeReadout.scaleYPercent}
                />
              ) : null}
              <button
                type="button"
                className="object-rotate-handle"
                aria-label={`Rotate ${transformTargetLabel}`}
                data-selection-rotate-handle="true"
                title={`Rotate ${transformTargetLabel}`}
                onPointerDown={handleRotatePointerDown}
                onDoubleClick={handleRotateDoubleClick}
              >
                <RotateSelectionIcon />
                {rotateReadout ? (
                  <RotateSelectionReadout degrees={rotateReadout.degrees} />
                ) : null}
              </button>
              {canProjectedPlaneTilt ? (
                <button
                  type="button"
                  className="object-tilt3d-handle"
                  aria-label={`3D rotate ${transformTargetLabel}`}
                  data-selection-tilt3d-handle="true"
                  title={`3D rotate ${transformTargetLabel}`}
                  onPointerDown={handleProjectedPlaneTiltPointerDown}
                  onDoubleClick={handleProjectedPlaneTiltDoubleClick}
                >
                  <ProjectedPlaneTiltIcon />
                  {projectedPlaneTiltReadout ? (
                    <ProjectedPlaneTiltReadout
                      label={projectedPlaneTiltReadout.label}
                      limited={projectedPlaneTiltReadout.limited}
                    />
                  ) : null}
                </button>
              ) : null}
              {rotationInput ? (
                <RotationInputPopover
                  input={rotationInput}
                  onKeep={onRotationInputKeep}
                  onHome={onRotationInputHome}
                  onCancel={onRotationInputCancel}
                  onChange={onRotationInputChange}
                />
              ) : null}
              {resizeInput ? (
                <ObjectResizeInputPopover
                  input={resizeInput}
                  onKeep={onObjectResizeInputKeep}
                  onHome={onObjectResizeInputHome}
                  onCancel={onObjectResizeInputCancel}
                  onChange={onObjectResizeInputChange}
                />
              ) : null}
            </div>
          ) : null}
          {editingAtomLabel ? object.atoms
            .filter((atom) => atom.id === editingAtomLabel.atomId)
            .map((atom) => (
              <input
                aria-label="Atom label"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                autoFocus
                className="native-atom-label-editor"
                data-atom-label-editor="true"
                data-atom-label-draft-empty={editingAtomLabel.draft.length === 0 ? "true" : undefined}
                data-atom-id={atom.id}
                key={`atom-label-editor-${atom.id}`}
                spellCheck={false}
                style={{
                  left: `calc(${atom.x - object.x}px * var(--page-scale))`,
                  top: `calc(${atom.y - object.y}px * var(--page-scale))`,
                  width: `${Math.max(1, editingAtomLabel.draft.length + 0.6)}ch`,
                  fontFamily: drawingStyle.atomLabelFontFamily,
                  fontSize: `calc(${drawingStyle.atomLabelFontSizePx}px * var(--page-scale))`,
                  fontWeight: drawingStyle.atomLabelFontWeight
                }}
                value={editingAtomLabel.draft}
                onBlur={onAtomLabelFinish}
                onChange={(event) => onAtomLabelChange(editingAtomLabel, event.currentTarget.value)}
                onKeyDown={(event) => handleAtomLabelKeyDown(editingAtomLabel, event)}
                onPointerDown={(event) => event.stopPropagation()}
              />
            )) : null}
        </div>
      );
    }

    return (
      <div
        className={["document-object", "document-object-overlay", "molecule-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        aria-label={moleculeAriaLabel(object)}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onDoubleClick={handleTextDoubleClick}
      />
    );
  }

  if (object.type === "electron-mark" && object.markKind === "charge") {
    const charge = object.charge === -1 ? -1 : 1;
    return (
      <div
        className={["document-object", "document-object-overlay", "charge-mark-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-charge={charge}
        aria-label={charge > 0 ? "Positive charge" : "Negative charge"}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
      />
    );
  }

  if (object.type === "text") {
    const textStyle = nativeTextStyleFromObjectStyle(object.style);
    const objectTextScript = textScriptForTextObject(object);
    const textCss = {
      color: textStyle.color,
      fontFamily: textStyle.fontFamily,
      fontWeight: textStyle.fontWeight,
      fontSize: `calc(${textStyle.fontSizePx}px * var(--page-scale))`,
      lineHeight: textStyle.lineHeight,
      letterSpacing: `calc(${textStyle.letterSpacingPx}px * var(--page-scale))`,
      textAlign: textStyle.textAlign,
      fontStyle: textStyle.fontStyle,
      textDecoration: textStyle.textDecoration
    } as CSSProperties;
    const textEditorCss = {
      ...textCss,
      color: "transparent",
      caretColor: textStyle.color,
      ...(objectTextScript === "normal" ? {} : {
        fontSize: `calc(${textStyle.fontSizePx * 0.72}px * var(--page-scale))`,
        lineHeight: Math.max(1, textStyle.lineHeight),
        paddingTop: objectTextScript === "subscript" ? `calc(${textStyle.fontSizePx * 0.3}px * var(--page-scale))` : 0,
        paddingBottom: objectTextScript === "superscript" ? `calc(${textStyle.fontSizePx * 0.28}px * var(--page-scale))` : 0
      })
    } as CSSProperties;

    return (
      <div
        className={["document-object", "document-object-overlay", "text-object", editingText ? "editing" : "", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={{ ...style, ...textCss }}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-text-align={textStyle.textAlign}
        data-text-script={objectTextScript}
        data-text-sizing-mode={String(object.style.textBoxSizingMode ?? "auto")}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
      >
        {(selected && !inGroupSelection) || editingText ? (
          <>
            <button
              type="button"
              className="text-resize-handle text-resize-handle-left"
              aria-label="Resize text box left"
              data-text-resize-edge="left"
              onPointerDown={handleTextResizeStart("left")}
            />
            <button
              type="button"
              className="text-resize-handle text-resize-handle-right"
              aria-label="Resize text box right"
              data-text-resize-edge="right"
              onPointerDown={handleTextResizeStart("right")}
            />
            <button
              type="button"
              className="text-resize-handle text-resize-handle-top"
              aria-label="Resize text box top"
              data-text-resize-edge="top"
              onPointerDown={handleTextResizeStart("top")}
            />
            <button
              type="button"
              className="text-resize-handle text-resize-handle-bottom"
              aria-label="Resize text box bottom"
              data-text-resize-edge="bottom"
              onPointerDown={handleTextResizeStart("bottom")}
            />
          </>
        ) : null}
        {selected && !inGroupSelection && !editingText ? (
          <button
            type="button"
            className="object-rotate-handle text-rotate-handle"
            aria-label="Rotate selected text box"
            data-selection-rotate-handle="true"
            title="Rotate selected text box"
            onPointerDown={handleRotatePointerDown}
          >
            <RotateSelectionIcon />
            {rotateReadout ? (
              <RotateSelectionReadout degrees={rotateReadout.degrees} />
            ) : null}
          </button>
        ) : null}
        {editingText ? (
          <>
            <TextObjectContent object={object} editing />
            <textarea
              aria-label="Text object"
              autoFocus
              className="text-object-editor rich-text-object-editor"
              ref={textEditorRef}
              spellCheck={false}
              data-text-script={objectTextScript}
              style={textEditorCss}
              value={object.text}
              onChange={handleTextChange}
              onPaste={handleTextPaste}
              onFocus={(event) => {
                if (object.text === "Text") {
                  event.currentTarget.select();
                }
                recordTextEditorSelection(event.currentTarget);
              }}
              onKeyDown={handleTextKeyDown}
              onKeyUp={(event) => recordTextEditorSelection(event.currentTarget)}
              onSelect={(event) => recordTextEditorSelection(event.currentTarget)}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => {
                event.stopPropagation();
                recordTextEditorSelection(event.currentTarget);
              }}
            />
          </>
        ) : null}
      </div>
    );
  }

  if (object.type === "reaction-arrow") {
    const width = Math.max(object.width, 1);
    const height = Math.max(object.height, 1);
    const start = arrowAnchorPointRelativeToObject(object, object.start, { x: 0, y: height / 2 });
    const end = arrowAnchorPointRelativeToObject(object, object.end, { x: width, y: height / 2 });
    const markerId = `reaction-arrowhead-${object.id}`;
    return (
      <div
        className={["document-object", "document-object-overlay", "reaction-arrow-object"].join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-arrow-kind={object.arrowKind}
        aria-label={`${object.arrowKind === "forward" ? "Forward" : "Reaction"} arrow`}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onContextMenu={handleObjectContextMenu}
      >
        <svg
          className="reaction-arrow-glyph"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <marker
              id={markerId}
              markerHeight="7"
              markerUnits="strokeWidth"
              markerWidth="7"
              orient="auto"
              refX="6"
              refY="3.5"
            >
              <path d="M 0 0 L 7 3.5 L 0 7 z" />
            </marker>
          </defs>
          <line
            className="reaction-arrow-line"
            x1={formatSvgNumber(projectArtPoint(start, width, height, artObjectProjection?.matrix).x)}
            y1={formatSvgNumber(projectArtPoint(start, width, height, artObjectProjection?.matrix).y)}
            x2={formatSvgNumber(projectArtPoint(end, width, height, artObjectProjection?.matrix).x)}
            y2={formatSvgNumber(projectArtPoint(end, width, height, artObjectProjection?.matrix).y)}
            markerEnd={object.arrowKind === "forward" ? `url(#${markerId})` : undefined}
          />
        </svg>
        {artObjectTransformFrame}
      </div>
    );
  }

  if (object.type === "bracket") {
    return (
      <div
        className={["document-object", "document-object-overlay", "bracket-object"].join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-bracket-kind={object.bracketKind}
        data-contained-object-ids={object.containedObjectIds.join(",") || undefined}
        aria-label={`${object.bracketKind} bracket`}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onContextMenu={handleObjectContextMenu}
      >
        <BracketGlyph object={object} projection={artObjectProjection} />
        {artObjectTransformFrame}
      </div>
    );
  }

  if (object.type === "graphic") {
    const graphicPathEditHandles = pathGraphicInEditMode && !inGroupSelection ? (
      <GraphicPathEditHandles
        object={object}
        onMarkerPointerDown={handleGraphicMarkerPointerDown}
        onPointerDown={handleGraphicPathEditPointerDown}
      />
    ) : null;
    const graphicCornerRadiusHandle = showGraphicCornerRadiusHandle ? (
      <GraphicCornerRadiusHandle
        object={object}
        readout={graphicCornerRadiusReadout}
        onDoubleClick={handleGraphicCornerRadiusDoubleClick}
        onPointerDown={handleGraphicCornerRadiusPointerDown}
      />
    ) : null;
    return (
      <div
        className={["document-object", "document-object-overlay", "graphic-object"].join(" ")}
        style={style}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-graphic-kind={object.graphicKind}
        data-graphic-interaction-mode={selected && !inGroupSelection && graphicPathEditPoints
          ? pathGraphicInEditMode ? "path-edit" : "object-transform"
          : selected && !inGroupSelection && graphicCornerRadiusEditPoint ? "corner-radius-edit"
          : undefined}
        aria-label={`${object.graphicKind} graphic`}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
        onContextMenu={handleObjectContextMenu}
      >
        <GraphicGlyph object={object} />
        {graphicCornerRadiusHandle}
        {graphicPathEditHandles}
        {artObjectTransformFrame}
      </div>
    );
  }

  return (
    <div
      className={["document-object", "document-object-overlay", "generic-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
      style={style}
      data-object-id={object.id}
      data-layer-index={layerIndex}
      onPointerDown={handleObjectPointerDown}
      onPointerMove={handleObjectPointerMove}
      onPointerUp={handleObjectPointerUp}
      onPointerCancel={handleObjectPointerCancel}
      onPointerLeave={handleObjectPointerLeave}
    >
      {artObjectTransformFrame}
    </div>
  );
}

function ArtObjectTransformFrame({
  frameStyle,
  targetLabel,
  rotateReadout,
  projectedPlaneTiltReadout,
  rotationInput,
  resizeReadout,
  resizeInput,
  onRotatePointerDown,
  onRotateDoubleClick,
  onProjectedPlaneTiltPointerDown,
  onProjectedPlaneTiltDoubleClick,
  onRotationInputChange,
  onRotationInputKeep,
  onRotationInputHome,
  onRotationInputCancel,
  onResizePointerDown,
  onResizeDoubleClick,
  onResizeInputChange,
  onResizeInputKeep,
  onResizeInputHome,
  onResizeInputCancel
}: {
  frameStyle?: CSSProperties;
  targetLabel: string;
  rotateReadout?: ObjectRotateReadoutState;
  projectedPlaneTiltReadout?: ProjectedPlaneTiltReadoutState;
  rotationInput?: RotationInputState;
  resizeReadout?: ObjectResizeReadoutState;
  resizeInput?: ObjectResizeInputState;
  onRotatePointerDown(event: PointerEvent<HTMLButtonElement>): void;
  onRotateDoubleClick(event: ReactMouseEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltPointerDown(event: PointerEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltDoubleClick(event: ReactMouseEvent<HTMLButtonElement>): void;
  onRotationInputChange(nextInput: RotationInputState): void;
  onRotationInputKeep(input: RotationInputState): void;
  onRotationInputHome(input: RotationInputState): void;
  onRotationInputCancel(input: RotationInputState): void;
  onResizePointerDown(corner: ObjectResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeDoubleClick(corner: ObjectResizeCorner): (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onResizeInputChange(nextInput: ObjectResizeInputState): void;
  onResizeInputKeep(input: ObjectResizeInputState): void;
  onResizeInputHome(input: ObjectResizeInputState): void;
  onResizeInputCancel(input: ObjectResizeInputState): void;
}) {
  return (
    <div
      className="object-transform-frame"
      data-art-transform-frame="true"
      data-has-tilt3d="true"
      style={frameStyle ?? { inset: 0 }}
    >
      <ObjectResizeHandles
        targetLabel={targetLabel}
        onResizeDoubleClick={onResizeDoubleClick}
        onResizeStart={onResizePointerDown}
      />
      {resizeReadout && !resizeInput ? (
        <ObjectResizeReadout
          scaleXPercent={resizeReadout.scaleXPercent}
          scaleYPercent={resizeReadout.scaleYPercent}
        />
      ) : null}
      <button
        type="button"
        className="object-rotate-handle"
        aria-label={`Rotate ${targetLabel}`}
        data-selection-rotate-handle="true"
        title={`Rotate ${targetLabel}`}
        onPointerDown={onRotatePointerDown}
        onDoubleClick={onRotateDoubleClick}
      >
        <RotateSelectionIcon />
        {rotateReadout ? (
          <RotateSelectionReadout degrees={rotateReadout.degrees} />
        ) : null}
      </button>
      <button
        type="button"
        className="object-tilt3d-handle"
        aria-label={`X/Y rotate ${targetLabel}`}
        data-selection-tilt3d-handle="true"
        title={`X/Y rotate ${targetLabel}`}
        onPointerDown={onProjectedPlaneTiltPointerDown}
        onDoubleClick={onProjectedPlaneTiltDoubleClick}
      >
        <ProjectedPlaneTiltIcon />
        {projectedPlaneTiltReadout ? (
          <ProjectedPlaneTiltReadout
            label={projectedPlaneTiltReadout.label}
            limited={projectedPlaneTiltReadout.limited}
          />
        ) : null}
      </button>
      {rotationInput ? (
        <RotationInputPopover
          input={rotationInput}
          onKeep={onRotationInputKeep}
          onHome={onRotationInputHome}
          onCancel={onRotationInputCancel}
          onChange={onRotationInputChange}
        />
      ) : null}
      {resizeInput ? (
        <ObjectResizeInputPopover
          input={resizeInput}
          onKeep={onResizeInputKeep}
          onHome={onResizeInputHome}
          onCancel={onResizeInputCancel}
          onChange={onResizeInputChange}
        />
      ) : null}
    </div>
  );
}

function arrowAnchorPointRelativeToObject(
  object: ArrowObject,
  anchor: ArrowObject["start"] | ArrowObject["end"],
  fallback: { x: number; y: number }
): { x: number; y: number } {
  if (anchor.kind === "point" && anchor.point) {
    return {
      x: anchor.point.x - object.x,
      y: anchor.point.y - object.y
    };
  }

  return fallback;
}

function BracketGlyph({ object, projection }: { object: BracketObject; projection?: DocumentObjectProjection }) {
  const width = Math.max(object.width, 1);
  const height = Math.max(object.height, 1);
  const pathD = bracketPath(object.bracketKind, width, height);
  return (
    <svg
      className="bracket-glyph"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        className="bracket-glyph-path"
        d={pathD}
        transform={projection?.matrix ? artProjectionSvgTransform(width, height, projection.matrix) : undefined}
      />
    </svg>
  );
}

function bracketPath(kind: BracketObject["bracketKind"], width: number, height: number): string {
  const right = Math.max(width - 1, 0);
  const bottom = Math.max(height - 1, 0);
  if (kind === "round") {
    return `M ${right} 0 C ${width * 0.18} ${height * 0.16}, ${width * 0.18} ${height * 0.84}, ${right} ${bottom}`;
  }
  if (kind === "curly") {
    return [
      `M ${right} 0`,
      `C ${width * 0.15} ${height * 0.1}, ${width * 0.85} ${height * 0.38}, ${width * 0.2} ${height * 0.5}`,
      `C ${width * 0.85} ${height * 0.62}, ${width * 0.15} ${height * 0.9}, ${right} ${bottom}`
    ].join(" ");
  }
  return `M ${right} 0 L 0 0 L 0 ${bottom} L ${right} ${bottom}`;
}

function reactSvgPaintAttrs(
  attribute: "fill" | "stroke",
  paint: NativeArtPaintPlan,
  id: string
): Record<string, string | number | undefined> {
  const value = reactSvgPaintValue(paint, id);
  if (paint.kind === "solid") {
    return {
      [attribute]: value,
      [`${attribute}Opacity`]: paint.opacity === 1 ? undefined : paint.opacity
    };
  }
  return { [attribute]: value };
}

function reactSvgPaintValue(paint: NativeArtPaintPlan, id: string): string {
  if (paint.kind === "none") {
    return "none";
  }
  if (paint.kind === "solid") {
    return paint.color;
  }
  return `url(#${id})`;
}

function reactSvgPaintDefinitions(paint: NativeArtPaintPlan, id: string) {
  if (paint.kind === "linear-gradient") {
    return (
      <defs key={`${id}-defs`}>
        <linearGradient
          id={id}
          x1={paint.x1}
          y1={paint.y1}
          x2={paint.x2}
          y2={paint.y2}
          gradientTransform={paint.gradientTransform}
          gradientUnits="userSpaceOnUse"
        >
          {paint.stops.map((stop, index) => (
            <stop
              key={`${id}-stop-${index}`}
              offset={`${Number((stop.offset * 100).toFixed(4))}%`}
              stopColor={stop.color}
              stopOpacity={stop.opacity === 1 ? undefined : stop.opacity}
            />
          ))}
        </linearGradient>
      </defs>
    );
  }

  if (paint.kind === "radial-gradient") {
    return (
      <defs key={`${id}-defs`}>
        <radialGradient
          id={id}
          cx={paint.cx}
          cy={paint.cy}
          r={paint.r}
          fx={paint.fx}
          fy={paint.fy}
          gradientTransform={paint.gradientTransform}
          gradientUnits="userSpaceOnUse"
        >
          {paint.stops.map((stop, index) => (
            <stop
              key={`${id}-stop-${index}`}
              offset={`${Number((stop.offset * 100).toFixed(4))}%`}
              stopColor={stop.color}
              stopOpacity={stop.opacity === 1 ? undefined : stop.opacity}
            />
          ))}
        </radialGradient>
      </defs>
    );
  }

  return null;
}

function reactSvgFlattenedMarker(
  marker: NonNullable<NativeArtVisualPlan["markerEnd"]>,
  terminal: NonNullable<NativeArtVisualPlan["markerEndTerminal"]>,
  id: string,
  placement: "start" | "end",
  color: string,
  opacity: number
) {
  const size = Math.max(2, marker.sizePx);
  const half = size / 2;
  const direction = marker.angleDegrees === 0
    ? markerTerminalDirection(terminal)
    : { x: Math.cos(marker.angleDegrees * Math.PI / 180), y: Math.sin(marker.angleDegrees * Math.PI / 180) };
  const normal = { x: -direction.y, y: direction.x };
  const tip = terminal.point;
  const markerPoint = (back: number, offset: number) => ({
    x: tip.x - direction.x * back + normal.x * offset,
    y: tip.y - direction.y * back + normal.y * offset
  });
  const markerPath = (points: ReadonlyArray<{ x: number; y: number }>, closed = true) => [
    `M ${points[0]?.x ?? tip.x} ${points[0]?.y ?? tip.y}`,
    ...points.slice(1).map((point) => `L ${point.x} ${point.y}`),
    closed ? "Z" : ""
  ].filter(Boolean).join(" ");
  const sharedStroke = {
    stroke: color,
    strokeOpacity: opacity === 1 ? undefined : opacity,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
  const sharedProps = {
    id,
    "data-graphic-marker": placement
  };

  if (marker.kind === "filled-arrow") {
    return <path key={id} {...sharedProps} d={markerPath([tip, markerPoint(size, -half), markerPoint(size, half)])} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} stroke="none" />;
  }
  if (marker.kind === "open-arrow") {
    return <path key={id} {...sharedProps} d={[
      `M ${tip.x} ${tip.y}`,
      `L ${markerPoint(size, -half).x} ${markerPoint(size, -half).y}`,
      `M ${tip.x} ${tip.y}`,
      `L ${markerPoint(size, half).x} ${markerPoint(size, half).y}`
    ].join(" ")} fill="none" strokeWidth={Math.max(1.4, size * 0.16)} {...sharedStroke} />;
  }
  if (marker.kind === "chevron") {
    return <path key={id} {...sharedProps} d={markerPath([
      tip,
      markerPoint(size * 0.82, -half),
      markerPoint(size * 0.52, 0),
      markerPoint(size * 0.82, half)
    ])} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} stroke="none" />;
  }
  if (marker.kind === "diamond") {
    return <path key={id} {...sharedProps} d={markerPath([
      tip,
      markerPoint(size * 0.5, -half),
      markerPoint(size, 0),
      markerPoint(size * 0.5, half)
    ])} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} stroke="none" />;
  }
  if (marker.kind === "dot") {
    const center = markerPoint(half, 0);
    return <circle key={id} {...sharedProps} cx={center.x} cy={center.y} r={Math.max(1, size * 0.38)} fill={color} fillOpacity={opacity === 1 ? undefined : opacity} />;
  }

  const barStart = markerPoint(0, -half);
  const barEnd = markerPoint(0, half);
  return <path key={id} {...sharedProps} d={`M ${barStart.x} ${barStart.y} L ${barEnd.x} ${barEnd.y}`} fill="none" strokeWidth={Math.max(1.4, size * 0.16)} {...sharedStroke} />;
}

function markerTerminalDirection(terminal: NonNullable<NativeArtVisualPlan["markerEndTerminal"]>) {
  const length = Math.hypot(terminal.direction.x, terminal.direction.y);
  return Number.isFinite(length) && length > 0.001
    ? { x: terminal.direction.x / length, y: terminal.direction.y / length }
    : { x: 1, y: 0 };
}

function GraphicGlyph({ object }: { object: GraphicObject }) {
  const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
  const width = plan.width;
  const height = plan.height;
  const line = plan.line;
  const visibleLine = plan.visibleLine ?? plan.line;
  const strokeColor = plan.stroke.color;
  const fillColor = plan.fill.color;
  const strokeWidth = plan.stroke.width;
  const strokeDasharray = plan.stroke.dasharray;
  const cornerRadius = plan.cornerRadius;
  const fillMode = plan.fill.mode;
  const effect = plan.effect;
  const gradientId = `graphic-gloss-${object.id}`;
  const fillPaintId = `graphic-fill-${object.id}`;
  const strokePaintId = `graphic-stroke-${object.id}`;
  const markerStartId = `graphic-marker-start-${object.id}`;
  const markerEndId = `graphic-marker-end-${object.id}`;
  const pathD = plan.pathD;
  const visiblePathD = plan.visiblePathD ?? pathD;
  const projectionTransform = plan.projectionTransform;
  const glossGradient = plan.glossGradient;
  const fillPaintProps = fillMode === "gloss"
    ? { fill: `url(#${gradientId})` }
    : reactSvgPaintAttrs("fill", plan.fill.paint, fillPaintId);
  const sharedStrokeProps = {
    ...reactSvgPaintAttrs("stroke", plan.stroke.paint, strokePaintId),
    strokeWidth,
    strokeDasharray,
    strokeLinecap: plan.stroke.lineCap,
    strokeLinejoin: plan.stroke.lineJoin,
    strokeMiterlimit: plan.stroke.miterLimit,
    vectorEffect: "non-scaling-stroke" as const
  };
  const markerStart = plan.markerStart && plan.markerStartTerminal
    ? reactSvgFlattenedMarker(plan.markerStart, plan.markerStartTerminal, markerStartId, "start", strokeColor, plan.stroke.opacity)
    : null;
  const markerEnd = plan.markerEnd && plan.markerEndTerminal
    ? reactSvgFlattenedMarker(plan.markerEnd, plan.markerEndTerminal, markerEndId, "end", strokeColor, plan.stroke.opacity)
    : null;
  return (
    <svg
      className="graphic-glyph"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      opacity={plan.opacity === 1 ? undefined : plan.opacity}
      aria-hidden="true"
    >
      {reactSvgPaintDefinitions(plan.fill.paint, fillPaintId)}
      {reactSvgPaintDefinitions(plan.stroke.paint, strokePaintId)}
      {fillMode === "gloss" ? (
        <defs>
          <radialGradient
            id={gradientId}
            cx={glossGradient?.cx}
            cy={glossGradient?.cy}
            r={glossGradient?.r}
            gradientTransform={glossGradient?.gradientTransform}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
            <stop offset="28%" stopColor="#ffffff" stopOpacity="0.42" />
            <stop offset="72%" stopColor={fillColor === "none" ? strokeColor : fillColor} />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.78" />
          </radialGradient>
        </defs>
      ) : null}
      {plan.projectedShapePathD ? (
        <>
          {effect === "shadow" ? (
            <path
              className="graphic-glyph-shadow graphic-glyph-projected-shape"
              d={plan.projectionMatrix
                ? projectedArtShapePathD(
                    object.graphicKind,
                    width,
                    height,
                    object.graphicKind === "rect" ? cornerRadius : 0,
                    plan.projectionMatrix,
                    { x: 6, y: 6 }
                  )
                : ""}
              fill="#aeb8c2"
              stroke="none"
            />
          ) : null}
          <path
            className="graphic-glyph-stroke graphic-glyph-projected-shape"
            d={plan.projectedShapePathD}
            {...fillPaintProps}
            {...sharedStrokeProps}
          />
        </>
      ) : (
        <g className={projectionTransform ? "graphic-glyph-transform" : undefined} transform={projectionTransform}>
          {effect === "shadow" && object.graphicKind !== "path" ? (
            <ArtShapePrimitive
              kind={object.graphicKind}
              width={width}
              height={height}
              rx={cornerRadius}
              className="graphic-glyph-shadow"
              fill="#aeb8c2"
              stroke="none"
              transform="translate(6 6)"
            />
          ) : null}
          {object.graphicKind === "ellipse" ? (
          <ellipse
            className="graphic-glyph-stroke graphic-glyph-shape"
            cx={width / 2}
            cy={height / 2}
            rx={Math.max(width / 2 - strokeWidth / 2, 0.5)}
            ry={Math.max(height / 2 - strokeWidth / 2, 0.5)}
            {...fillPaintProps}
            {...sharedStrokeProps}
          />
        ) : object.graphicKind === "rect" ? (
          <rect
            className="graphic-glyph-stroke graphic-glyph-shape"
            x={strokeWidth / 2}
            y={strokeWidth / 2}
            width={Math.max(width - strokeWidth, 0.5)}
            height={Math.max(height - strokeWidth, 0.5)}
            rx={cornerRadius}
            ry={cornerRadius}
            {...fillPaintProps}
            {...sharedStrokeProps}
          />
        ) : object.graphicKind === "path" && pathD ? (
          <>
            <path
              className="graphic-glyph-hit-target"
              d={pathD}
              fill="none"
              stroke="transparent"
              strokeWidth={Math.max(strokeWidth + 10, 14)}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="stroke"
            />
            <path
              className="graphic-glyph-stroke graphic-glyph-path"
              d={visiblePathD}
              {...(plan.capabilities.supportsFill ? fillPaintProps : { fill: "none" })}
              {...sharedStrokeProps}
            />
            {markerStart}
            {markerEnd}
          </>
        ) : line && visibleLine ? (
          <>
            <line
              className="graphic-glyph-hit-target"
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="transparent"
              strokeWidth={Math.max(strokeWidth + 10, 14)}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="stroke"
            />
            <line
              className="graphic-glyph-stroke"
              x1={visibleLine.x1}
              y1={visibleLine.y1}
              x2={visibleLine.x2}
              y2={visibleLine.y2}
              {...sharedStrokeProps}
            />
            {markerStart}
            {markerEnd}
          </>
        ) : (
          <line className="graphic-glyph-stroke" x1="0" y1="0" x2={width} y2={height} {...sharedStrokeProps} />
        )}
        </g>
      )}
    </svg>
  );
}

function GraphicCornerRadiusHandle({
  object,
  readout,
  onPointerDown,
  onDoubleClick
}: {
  object: GraphicObject;
  readout?: GraphicCornerRadiusReadoutState;
  onPointerDown(event: PointerEvent<HTMLButtonElement>): void;
  onDoubleClick(event: ReactMouseEvent<HTMLButtonElement>): void;
}) {
  const point = nativeGraphicCornerRadiusEditPoint(object);
  if (!point) {
    return null;
  }

  const radius = readout?.radius ?? graphicCornerRadiusReadoutValue(object);
  const projectedPoint = projectGraphicObjectPoint(object, point, { coordinateSpace: "local" });
  const label = `Radius: ${Math.round(radius)} px`;

  return (
    <>
      <button
        type="button"
        className="graphic-corner-radius-handle"
        aria-label="Adjust corner radius"
        data-graphic-corner-radius-handle="true"
        data-graphic-corner-radius-value={String(Math.round(radius))}
        style={{
          left: pageScaledCssPx(projectedPoint.x),
          top: pageScaledCssPx(projectedPoint.y)
        }}
        title="Adjust corner radius"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
      <div
        className="graphic-corner-radius-readout"
        data-graphic-corner-radius-readout="true"
        style={{
          left: pageScaledCssPx(projectedPoint.x),
          top: pageScaledCssPx(projectedPoint.y)
        }}
      >
        {label}
      </div>
    </>
  );
}

function GraphicPathEditHandles({
  object,
  onMarkerPointerDown,
  onPointerDown
}: {
  object: GraphicObject;
  onMarkerPointerDown(markerId: NativeGraphicMarkerHandleId): (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerDown(handle: NativeGraphicPathEditHandle): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const points = nativeGraphicPathEditPoints(object);
  if (!points) {
    return null;
  }

  const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
  const markerHandles = plan.markerHandles.map((handle) => ({
    ...handle,
    point: projectGraphicObjectPoint(object, handle.point, { coordinateSpace: "local" })
  }));
  const circularArc = isSemanticCircularGraphicArc(object, points);
  const projectedPoints = {
    start: projectGraphicObjectPoint(object, points.start),
    middle: projectGraphicObjectPoint(object, points.middle),
    end: projectGraphicObjectPoint(object, points.end)
  };
  const arcRadianReadout = circularArc ? graphicArcSweepRadiansLabel(object) : undefined;
  const handles: Array<{ handle: NativeGraphicPathEditHandle; point: NativeArtPoint; label: string }> = circularArc
    ? [
        { handle: "start", point: projectedPoints.start, label: "Adjust arc start" },
        { handle: "middle", point: projectedPoints.middle, label: "Adjust arc radius" },
        { handle: "end", point: projectedPoints.end, label: "Adjust arc sweep" }
      ]
    : [
        { handle: "start", point: projectedPoints.start, label: "Adjust line start" },
        { handle: "middle", point: projectedPoints.middle, label: "Bend line into curve" },
        { handle: "end", point: projectedPoints.end, label: "Adjust line end" }
      ];

  return (
    <>
      {handles.map(({ handle, point, label }) => (
        <button
          type="button"
          className={[
            "graphic-path-edit-handle",
            `graphic-path-edit-handle-${handle}`,
            circularArc && handle === "middle" ? "graphic-path-edit-handle-arc-middle" : undefined
          ].filter(Boolean).join(" ")}
          aria-label={label}
          data-graphic-path-handle={handle}
          key={handle}
          style={{
            left: pageScaledCssPx(point.x - object.x),
            top: pageScaledCssPx(point.y - object.y)
          }}
          title={label}
          onPointerDown={onPointerDown(handle)}
        />
      ))}
      {markerHandles.map((handle) => (
        <button
          type="button"
          className={[
            "graphic-path-edit-handle",
            "graphic-marker-edit-handle",
            `graphic-marker-edit-handle-${handle.id === "markerStart" ? "start" : "end"}`
          ].join(" ")}
          aria-label={handle.id === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size"}
          data-graphic-marker-handle={handle.id}
          data-graphic-marker-size={String(Math.round(handle.marker.sizePx))}
          key={handle.id}
          style={{
            left: pageScaledCssPx(handle.point.x),
            top: pageScaledCssPx(handle.point.y)
          }}
          title={handle.id === "markerStart" ? "Adjust start arrowhead size" : "Adjust end arrowhead size"}
          onPointerDown={onMarkerPointerDown(handle.id)}
        />
      ))}
      {arcRadianReadout ? (
        <div
          className="graphic-path-radian-readout"
          data-graphic-path-readout="true"
          style={{
            left: pageScaledCssPx(projectedPoints.middle.x - object.x),
            top: pageScaledCssPx(projectedPoints.middle.y - object.y)
          }}
        >
          {arcRadianReadout}
        </div>
      ) : null}
    </>
  );
}

function ArtShapePrimitive({
  kind,
  width,
  height,
  rx,
  className,
  fill,
  stroke,
  transform
}: {
  kind: GraphicObject["graphicKind"];
  width: number;
  height: number;
  rx: number;
  className: string;
  fill: string;
  stroke: string;
  transform?: string;
}) {
  return kind === "ellipse" ? (
    <ellipse
      className={className}
      cx={width / 2}
      cy={height / 2}
      rx={Math.max(width / 2, 0.5)}
      ry={Math.max(height / 2, 0.5)}
      fill={fill}
      stroke={stroke}
      transform={transform}
    />
  ) : (
    <rect
      className={className}
      x="0"
      y="0"
      width={width}
      height={height}
      rx={rx}
      ry={rx}
      fill={fill}
      stroke={stroke}
      transform={transform}
    />
  );
}

type DocumentObjectProjectionMatrix = { a: number; b: number; c: number; d: number };

interface DocumentObjectProjection {
  frameStyle?: CSSProperties;
  matrix?: DocumentObjectProjectionMatrix;
}

function documentObjectSupportsArtTransform(object: DocumentObject): boolean {
  return object.type === "graphic" || object.type === "bracket" || object.type === "reaction-arrow";
}

function documentObjectCssTransform(object: DocumentObject): string {
  return `rotate(${object.rotation}deg)`;
}

function pageScaledCssPx(value: number): string {
  return `calc(${value}px * var(--page-scale))`;
}

function documentObjectProjectedPlaneProjection(object: DocumentObject): DocumentObjectProjection | undefined {
  const tilt = documentObjectProjectedPlaneTilt(object);
  if (
    Math.abs(tilt.tiltXDegrees) < 0.001 &&
    Math.abs(tilt.tiltYDegrees) < 0.001 &&
    Math.abs(object.rotation) < 0.001
  ) {
    return undefined;
  }

  if (object.type === "graphic") {
    const plan = planNativeArtVisual(object, { coordinateSpace: "local" });
    if (!plan.projectionMatrix) {
      return undefined;
    }

    return {
      frameStyle: {
        left: `${plan.frameBounds.x}px`,
        top: `${plan.frameBounds.y}px`,
        width: `${plan.frameBounds.width}px`,
        height: `${plan.frameBounds.height}px`
      },
      matrix: plan.projectionMatrix
    };
  }

  const matrix = documentObjectProjectedPlaneMatrix(tilt.tiltXDegrees, tilt.tiltYDegrees, object.rotation);
  const bounds = documentObjectProjectedPlaneBounds(object.width, object.height, matrix);
  return {
    frameStyle: {
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`
    },
    matrix
  };
}

function documentObjectProjectedPlaneMatrix(
  tiltXDegrees: number,
  tiltYDegrees: number,
  rotationDegrees: number
): DocumentObjectProjectionMatrix {
  const tiltXRad = degreesToRadians(tiltXDegrees);
  const tiltYRad = degreesToRadians(tiltYDegrees);
  const cx = Math.cos(tiltXRad);
  const sx = Math.sin(tiltXRad);
  const cy = Math.cos(tiltYRad);
  const sy = Math.sin(tiltYRad);
  const zRad = degreesToRadians(rotationDegrees);
  const cz = Math.cos(zRad);
  const sz = Math.sin(zRad);

  // Same screen-space projected-plane basis used by native molecule X/Y tilt
  // for local z=0 points, expressed as a 2D affine CSS matrix. The in-plane
  // Z rotation is applied first, then the screen-space Y and X tilts.
  return {
    a: cy * cz,
    b: cx * sz + sx * sy * cz,
    c: -cy * sz,
    d: cx * cz - sx * sy * sz
  };
}

function documentObjectProjectedPlaneBounds(
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix
): { x: number; y: number; width: number; height: number } {
  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const corners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight }
  ].map((point) => ({
    x: matrix.a * point.x + matrix.c * point.y,
    y: matrix.b * point.x + matrix.d * point.y
  }));
  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y));

  return {
    x: roundCssCoordinate(halfWidth + minX),
    y: roundCssCoordinate(halfHeight + minY),
    width: roundCssCoordinate(maxX - minX),
    height: roundCssCoordinate(maxY - minY)
  };
}

function roundCssCoordinate(value: number): number {
  return Number(value.toFixed(4));
}

function formatCssNumber(value: number): string {
  return `${roundCssCoordinate(value)}`;
}

function projectArtPoint(
  point: { x: number; y: number },
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix | undefined
): { x: number; y: number } {
  if (!matrix) {
    return point;
  }

  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const dx = point.x - halfWidth;
  const dy = point.y - halfHeight;
  return {
    x: halfWidth + matrix.a * dx + matrix.c * dy,
    y: halfHeight + matrix.b * dx + matrix.d * dy
  };
}

function artProjectionSvgTransform(
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix
): string {
  const halfWidth = Math.max(width, 1) / 2;
  const halfHeight = Math.max(height, 1) / 2;
  const e = halfWidth - matrix.a * halfWidth - matrix.c * halfHeight;
  const f = halfHeight - matrix.b * halfWidth - matrix.d * halfHeight;
  return [
    "matrix(",
    formatCssNumber(matrix.a),
    " ",
    formatCssNumber(matrix.b),
    " ",
    formatCssNumber(matrix.c),
    " ",
    formatCssNumber(matrix.d),
    " ",
    formatCssNumber(e),
    " ",
    formatCssNumber(f),
    ")"
  ].join("");
}

function projectedArtShapePathD(
  kind: GraphicObject["graphicKind"],
  width: number,
  height: number,
  rx: number,
  matrix: DocumentObjectProjectionMatrix,
  offset: { x: number; y: number } = { x: 0, y: 0 },
  strokeWidth = 0
): string {
  const points = kind === "ellipse"
    ? ellipsePathPoints(width, height, strokeWidth, offset)
    : roundedRectPathPoints(width, height, rx, strokeWidth, offset);
  return projectedPointsPathD(points, true, width, height, matrix);
}

function roundedRectPathPoints(
  width: number,
  height: number,
  rx: number,
  strokeWidth: number,
  offset: { x: number; y: number }
): Array<{ x: number; y: number }> {
  const inset = Math.max(strokeWidth / 2, 0);
  const x0 = inset + offset.x;
  const y0 = inset + offset.y;
  const x1 = Math.max(width - inset + offset.x, x0 + 0.5);
  const y1 = Math.max(height - inset + offset.y, y0 + 0.5);
  const radius = Math.max(0, Math.min(rx, (x1 - x0) / 2, (y1 - y0) / 2));
  if (radius <= 0.001) {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ];
  }

  return [
    ...arcSamplePoints({ x: x1 - radius, y: y0 + radius }, radius, radius, -90, 0, 8),
    ...arcSamplePoints({ x: x1 - radius, y: y1 - radius }, radius, radius, 0, 90, 8).slice(1),
    ...arcSamplePoints({ x: x0 + radius, y: y1 - radius }, radius, radius, 90, 180, 8).slice(1),
    ...arcSamplePoints({ x: x0 + radius, y: y0 + radius }, radius, radius, 180, 270, 8).slice(1)
  ];
}

function ellipsePathPoints(
  width: number,
  height: number,
  strokeWidth: number,
  offset: { x: number; y: number }
): Array<{ x: number; y: number }> {
  const inset = Math.max(strokeWidth / 2, 0);
  return arcSamplePoints(
    { x: width / 2 + offset.x, y: height / 2 + offset.y },
    Math.max(width / 2 - inset, 0.5),
    Math.max(height / 2 - inset, 0.5),
    0,
    360,
    72
  );
}

function arcSamplePoints(
  center: { x: number; y: number },
  rx: number,
  ry: number,
  startDegrees: number,
  endDegrees: number,
  steps: number
): Array<{ x: number; y: number }> {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = steps <= 0 ? 1 : index / steps;
    return ellipsePointAtDegrees(center, rx, ry, startDegrees + (endDegrees - startDegrees) * t);
  });
}

function ellipsePointAtDegrees(
  center: { x: number; y: number },
  rx: number,
  ry: number,
  degrees: number
): { x: number; y: number } {
  const radians = degreesToRadians(degrees);
  return {
    x: center.x + Math.cos(radians) * rx,
    y: center.y + Math.sin(radians) * ry
  };
}

function projectedPointsPathD(
  points: Array<{ x: number; y: number }>,
  closed: boolean,
  width: number,
  height: number,
  matrix: DocumentObjectProjectionMatrix
): string {
  const projected = points.map((point) => projectArtPoint(point, width, height, matrix));
  if (projected.length === 0) {
    return "";
  }

  return [
    `M ${formatSvgNumber(projected[0].x)} ${formatSvgNumber(projected[0].y)}`,
    ...projected.slice(1).map((point) => `L ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`),
    closed ? "Z" : ""
  ].filter(Boolean).join(" ");
}

function artTransformQaProjectedCorners(object: GraphicObject): Array<{ x: number; y: number }> {
  const projection = documentObjectProjectedPlaneProjection(object);
  const corners = [
    { x: 0, y: 0 },
    { x: object.width, y: 0 },
    { x: object.width, y: object.height },
    { x: 0, y: object.height }
  ];
  return corners.map((corner) => {
    const point = projectArtPoint(corner, object.width, object.height, projection?.matrix);
    return {
      x: object.x + point.x,
      y: object.y + point.y
    };
  });
}

function artTransformQaSceneDocument(document: ChemDraftDocument, draft: ArtTransformQaDraft): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) {
    return document;
  }

  const rotationDegrees = artTransformQaDegrees(draft.rotationDegrees, 28);
  const tiltXDegrees = artTransformQaDegrees(draft.tiltXDegrees, 35);
  const tiltYDegrees = artTransformQaDegrees(draft.tiltYDegrees, -20);
  const objects = [
    artTransformQaObject({
      id: ART_TRANSFORM_QA_OBJECT_IDS[0],
      kind: "rect",
      x: Math.min(page.width - 112, Math.max(page.margin.left + 238, 190)),
      y: Math.min(page.height - 120, Math.max(page.margin.top + 520, 430)),
      width: 96,
      height: 56,
      rotationDegrees,
      tiltXDegrees,
      tiltYDegrees
    }),
    artTransformQaObject({
      id: ART_TRANSFORM_QA_OBJECT_IDS[1],
      kind: "ellipse",
      x: Math.min(page.width - 92, Math.max(page.margin.left + 100, 120)),
      y: Math.min(page.height - 120, Math.max(page.margin.top + 515, 430)),
      width: 72,
      height: 72,
      rotationDegrees,
      tiltXDegrees,
      tiltYDegrees
    })
  ];
  const patches: DocumentPatch[] = objects.flatMap((object): DocumentPatch[] => {
    const existing = page.objects.find((candidate) => candidate.id === object.id);
    if (!existing) {
      return [{ op: "addObject", pageId: page.id, object }];
    }
    if (existing.type !== "graphic") {
      return [
        { op: "removeObject", objectId: object.id },
        { op: "addObject", pageId: page.id, object }
      ];
    }
    return [{ op: "updateObject", objectId: object.id, changes: object }];
  });

  return applyPatches(
    document,
    [
      ...patches,
      { op: "setSelection", pageId: page.id, objectIds: [ART_TRANSFORM_QA_OBJECT_IDS[0]] }
    ]
  );
}

function artTransformQaSelectionDocument(document: ChemDraftDocument, draft: ArtTransformQaDraft): ChemDraftDocument {
  const page = document.pages.find((candidate) => candidate.id === document.selection.pageId) ?? document.pages[0];
  if (!page) {
    return document;
  }

  const selectedGraphics = page.objects.filter((object): object is GraphicObject =>
    object.type === "graphic" && document.selection.objectIds.includes(object.id)
  );
  if (selectedGraphics.length === 0) {
    return document;
  }

  return applyPatches(
    document,
    selectedGraphics.map((object) => {
      const currentTiltX = typeof object.style.tiltXDegrees === "number" ? object.style.tiltXDegrees : 0;
      const currentTiltY = typeof object.style.tiltYDegrees === "number" ? object.style.tiltYDegrees : 0;
      return {
        op: "updateObject",
        objectId: object.id,
        changes: {
          rotation: artTransformQaDegrees(draft.rotationDegrees, object.rotation),
          style: {
            ...object.style,
            tiltXDegrees: artTransformQaDegrees(draft.tiltXDegrees, currentTiltX),
            tiltYDegrees: artTransformQaDegrees(draft.tiltYDegrees, currentTiltY)
          }
        }
      };
    })
  );
}

function artStyleQaSceneDocument(document: ChemDraftDocument): ChemDraftDocument {
  const page = document.pages[0];
  if (!page) {
    return document;
  }

  const baseX = Math.min(page.width - 360, Math.max(page.margin.left + 145, 135));
  const baseY = Math.min(page.height - 250, Math.max(page.margin.top + 820, 560));
  const objects = [
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[0],
      kind: "rect",
      x: baseX,
      y: baseY,
      width: 84,
      height: 48,
      fillColor: "#f8faf9",
      strokeColor: "#1d7f68",
      strokeWidth: 2,
      data: { cornerRadiusPx: 8, artToolId: "qa-style-rounded-rect" }
    }),
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[1],
      kind: "ellipse",
      x: baseX + 120,
      y: baseY - 6,
      width: 58,
      height: 58,
      fillColor: "#1648ff",
      strokeColor: "#111111",
      strokeWidth: 2,
      data: { artToolId: "qa-style-ellipse" }
    }),
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[2],
      kind: "line",
      x: baseX + 215,
      y: baseY + 12,
      width: 92,
      height: 30,
      fillColor: "none",
      strokeColor: "#b3261e",
      strokeWidth: 3,
      data: {
        lineStart: { x: baseX + 215, y: baseY + 42 },
        lineEnd: { x: baseX + 307, y: baseY + 12 },
        artToolId: "qa-style-line"
      }
    }),
    artStyleQaObject({
      id: ART_STYLE_QA_OBJECT_IDS[3],
      kind: "path",
      x: baseX + 90,
      y: baseY + 95,
      width: 64,
      height: 64,
      fillColor: "none",
      strokeColor: "#111111",
      strokeWidth: 3,
      data: {
        artPathKind: "arc",
        arcStartRadians: Math.PI * 0.15,
        arcSweepRadians: Math.PI * 1.45,
        artToolId: "qa-style-arc"
      }
    })
  ];
  const patches: DocumentPatch[] = objects.flatMap((object): DocumentPatch[] => {
    const existing = page.objects.find((candidate) => candidate.id === object.id);
    if (!existing) {
      return [{ op: "addObject", pageId: page.id, object }];
    }
    if (existing.type !== "graphic") {
      return [
        { op: "removeObject", objectId: object.id },
        { op: "addObject", pageId: page.id, object }
      ];
    }
    return [{ op: "updateObject", objectId: object.id, changes: object }];
  });

  return applyPatches(document, [
    ...patches,
    { op: "setSelection", pageId: page.id, objectIds: [ART_STYLE_QA_OBJECT_IDS[0]] }
  ]);
}

function artStyleQaStressDocument(document: ChemDraftDocument, runCount: number): ChemDraftDocument {
  const seededDocument = artStyleQaSceneDocument(document);
  const page = seededDocument.pages[0];
  if (!page) {
    return seededDocument;
  }

  const fillColors = ["#1d7f68", "#1648ff", "#b3261e", "#6cb155", "#f8faf9"];
  const strokeColors = ["#111111", "#1d7f68", "#b3261e", "#1648ff", "#4b5563"];
  const strokeWidths = [1, 1.5, 2, 3, 5];
  const strokeDasharrays: Array<string | undefined> = [undefined, "8 6", "14 7", "0 6", "8 5 0 5"];
  const strokeLineCaps: Array<NonNullable<GraphicObject["style"]["strokeLineCap"]>> = ["butt", "round", "square"];
  const strokeLineJoins: Array<NonNullable<GraphicObject["style"]["strokeLineJoin"]>> = ["miter", "round", "bevel"];
  const patches = ART_STYLE_QA_OBJECT_IDS.flatMap((objectId, index): DocumentPatch[] => {
    const object = page.objects.find((candidate): candidate is GraphicObject =>
      candidate.id === objectId && candidate.type === "graphic"
    );
    if (!object) {
      return [];
    }

    const step = runCount + index;
    const fillColor = object.graphicKind === "line" ||
      object.data.artPathKind === "arc" ||
      object.data.artPathKind === "quadratic" ||
      object.data.artPathKind === "wavy"
      ? "none"
      : fillColors[step % fillColors.length];
    const strokeColor = strokeColors[(step * 2) % strokeColors.length];
    const fillOpacity = Number((0.35 + (step % 5) * 0.13).toFixed(2));
    const strokeOpacity = Number((0.42 + (step % 4) * 0.15).toFixed(2));
    return [{
      op: "updateObject",
      objectId,
      changes: {
        style: {
          ...object.style,
          opacity: Number((0.68 + (step % 3) * 0.12).toFixed(2)),
          fillColor,
          strokeColor,
          fillOpacity,
          strokeOpacity,
          fillPaint: fillColor === "none"
            ? { kind: "none" }
            : { kind: "solid", color: fillColor, opacity: fillOpacity },
          strokePaint: { kind: "solid", color: strokeColor, opacity: strokeOpacity },
          strokeWidth: strokeWidths[step % strokeWidths.length],
          strokeDasharray: strokeDasharrays[step % strokeDasharrays.length],
          strokeLineCap: strokeLineCaps[step % strokeLineCaps.length],
          strokeLineJoin: strokeLineJoins[(step + 1) % strokeLineJoins.length],
          strokeMiterLimit: 4 + step % 5
        }
      }
    }];
  });

  return applyPatches(seededDocument, [
    ...patches,
    { op: "setSelection", pageId: page.id, objectIds: [ART_STYLE_QA_OBJECT_IDS[0]] }
  ]);
}

function artStyleQaObject({
  id,
  kind,
  x,
  y,
  width,
  height,
  fillColor,
  strokeColor,
  strokeWidth,
  data
}: {
  id: string;
  kind: GraphicObject["graphicKind"];
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  data: GraphicObject["data"];
}): GraphicObject {
  return {
    id,
    type: "graphic",
    x,
    y,
    width,
    height,
    rotation: 0,
    graphicKind: kind,
    style: {
      source: "chemdraft-art-style-qa",
      strokeColor,
      fillColor,
      strokeWidth,
      strokePaint: { kind: "solid", color: strokeColor, opacity: 1 },
      fillPaint: fillColor === "none" ? { kind: "none" } : { kind: "solid", color: fillColor, opacity: 1 }
    },
    data,
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    }
  };
}

function artTransformQaObject({
  id,
  kind,
  x,
  y,
  width,
  height,
  rotationDegrees,
  tiltXDegrees,
  tiltYDegrees
}: {
  id: string;
  kind: "ellipse" | "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
  tiltXDegrees: number;
  tiltYDegrees: number;
}): GraphicObject {
  return {
    id,
    type: "graphic",
    x,
    y,
    width,
    height,
    rotation: rotationDegrees,
    graphicKind: kind,
    style: {
      source: "chemdraft-art-transform-qa",
      strokeColor: "#111111",
      fillColor: "none",
      strokeWidth: 3,
      tiltXDegrees,
      tiltYDegrees
    },
    data: kind === "rect" ? { cornerRadiusPx: 9, artToolId: "qa-rounded-rect" } : { artToolId: "qa-ellipse" },
    compatibility: {
      sourceFormat: "chemdraft-native",
      warnings: [],
      unknown: {}
    }
  };
}

function artTransformQaDegrees(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function documentObjectToolbarColor(object: DocumentObject): string {
  if (object.type === "graphic") {
    const fillColor = metadataStringValue(object.style.fillColor);
    if (fillColor && fillColor.toLowerCase() !== "none") {
      return metadataColor(fillColor, object.style.strokeColor, object.style.color, "#111111");
    }
    return metadataColor(object.style.strokeColor, object.style.color, "#111111");
  }

  return metadataColor(object.style.color, object.style.strokeColor, object.style.fillColor, "#111111");
}

function documentObjectTransformLabel(object: DocumentObject | undefined): string {
  if (object?.type === "text") {
    return "text box";
  }
  if (object?.type === "molecule") {
    return "selected molecule";
  }
  if (object && documentObjectSupportsArtTransform(object)) {
    return "selected art object";
  }
  return "selected object";
}

function metadataColor(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0 && value.trim().toLowerCase() !== "none") {
      return value.trim();
    }
  }
  return "#111111";
}

function metadataStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataNumberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatSvgNumber(value: number): number {
  return Number(value.toFixed(3));
}

function TextObjectContent({ editing = false, object }: { editing?: boolean; object: TextObject }) {
  return (
    <span className={["text-object-content", editing ? "text-object-edit-preview" : ""].filter(Boolean).join(" ")}>
      {textObjectSpansForRendering(object).map((span, index) => (
        <span
          className="text-object-run"
          data-text-script={span.script}
          style={textSpanCss(span)}
          key={`${span.script}-${index}-${span.text}`}
        >
          {span.text}
        </span>
      ))}
    </span>
  );
}

function textObjectSpansForRendering(object: TextObject): TextSpan[] {
  const spans = object.spans.filter((span) => span.text.length > 0);
  if (spans.length > 0 && spans.map((span) => span.text).join("") === object.text) {
    return spans;
  }

  return [{ text: object.text, script: "normal", style: {} }];
}

function textScriptForTextObject(object: TextObject): TextSpan["script"] {
  const scripts = new Set(
    textObjectSpansForRendering(object)
      .filter((span) => span.text.length > 0)
      .map((span) => span.script)
  );

  return scripts.size === 1 ? [...scripts][0] ?? "normal" : "normal";
}

function textScriptForTextRange(object: TextObject, range: NativeTextSelectionRange): TextSpan["script"] {
  const start = Math.max(0, Math.min(range.start, range.end, object.text.length));
  const end = Math.max(0, Math.min(Math.max(range.start, range.end), object.text.length));
  if (start === end) {
    return textScriptForTextObject(object);
  }

  let offset = 0;
  const scripts = new Set<TextSpan["script"]>();
  textObjectSpansForRendering(object).forEach((span) => {
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    offset = spanEnd;
    if (spanEnd > start && spanStart < end) {
      scripts.add(span.script);
    }
  });

  return scripts.size === 1 ? [...scripts][0] ?? "normal" : "normal";
}

function textStyleForTextRange(object: TextObject, range: NativeTextSelectionRange): Record<string, unknown> {
  const start = Math.max(0, Math.min(range.start, range.end, object.text.length));
  const end = Math.max(0, Math.min(Math.max(range.start, range.end), object.text.length));
  if (start === end) {
    return {};
  }

  let offset = 0;
  const values = new Map<string, Set<unknown>>();
  textObjectSpansForRendering(object).forEach((span) => {
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    offset = spanEnd;
    if (spanEnd <= start || spanStart >= end) {
      return;
    }

    Object.entries(span.style).forEach(([key, value]) => {
      const set = values.get(key) ?? new Set<unknown>();
      set.add(value);
      values.set(key, set);
    });
  });

  return Object.fromEntries(
    [...values.entries()]
      .filter(([, valueSet]) => valueSet.size === 1)
      .map(([key, valueSet]) => [key, [...valueSet][0]])
  );
}

function textSpanCss(span: TextSpan): CSSProperties | undefined {
  const style = span.style;
  const css: CSSProperties = {};
  const color = textSpanString(style.color);
  const fontFamily = textSpanString(style.fontFamily);
  const fontSizePx = textSpanNumber(style.fontSizePx);
  const letterSpacingPx = textSpanNumber(style.letterSpacingPx);
  const fontWeight = textSpanNumber(style.fontWeight);
  const fontStyle = textSpanString(style.fontStyle);
  const textDecoration = textSpanString(style.textDecoration);

  if (color) {
    css.color = color;
  }
  if (fontFamily) {
    css.fontFamily = fontFamily;
  }
  if (fontSizePx !== undefined) {
    css.fontSize = `calc(${fontSizePx}px * var(--page-scale))`;
  }
  if (letterSpacingPx !== undefined) {
    css.letterSpacing = `calc(${letterSpacingPx}px * var(--page-scale))`;
  }
  if (fontWeight !== undefined) {
    css.fontWeight = fontWeight;
  }
  if (fontStyle === "italic" || fontStyle === "normal") {
    css.fontStyle = fontStyle;
  }
  if (textDecoration) {
    css.textDecoration = textDecoration;
  }

  return Object.keys(css).length > 0 ? css : undefined;
}

function textSpanString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textSpanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nativeMoleculeBondColor(
  object: MoleculeObject,
  bondId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.bondColors, bondId) ?? drawingStyle.bondColor;
}

function nativeMoleculeAtomLabelColor(
  object: MoleculeObject,
  atomId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.atomLabelColors, atomId) ?? drawingStyle.atomLabelColor;
}

function nativeMoleculeSelectionColor(
  object: MoleculeObject,
  part: NativeMoleculeSelectionPart,
  drawingStyle: NativeDrawingStyle
): string {
  if (part.kind === "atom") {
    return nativeMoleculeAtomLabelColor(object, part.atomId, drawingStyle);
  }

  if (part.kind === "bond") {
    return nativeMoleculeBondColor(object, part.bondId, drawingStyle);
  }

  const firstBondId = part.bondIds[0];
  if (firstBondId) {
    return nativeMoleculeBondColor(object, firstBondId, drawingStyle);
  }

  const firstAtomId = part.atomIds[0];
  return firstAtomId
    ? nativeMoleculeAtomLabelColor(object, firstAtomId, drawingStyle)
    : drawingStyle.bondColor;
}

function styleColorMapValue(value: unknown, id: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const color = (value as Record<string, unknown>)[id];
  return typeof color === "string" ? color : undefined;
}

function ObjectResizeHandles({
  targetLabel,
  onResizeDoubleClick,
  onResizeStart
}: {
  targetLabel: string;
  onResizeDoubleClick(corner: ObjectResizeCorner): (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onResizeStart(corner: ObjectResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const corners: ObjectResizeCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

  return (
    <>
      {corners.map((corner) => (
        <button
          aria-label={`Resize ${targetLabel} ${corner.replace("-", " ")}`}
          className={`object-resize-handle object-resize-${corner}`}
          data-object-resize-corner={corner}
          key={corner}
          title={`Resize ${targetLabel}`}
          type="button"
          onPointerDown={onResizeStart(corner)}
          onDoubleClick={onResizeDoubleClick(corner)}
        />
      ))}
    </>
  );
}

function RotationInputPopover({
  input,
  onKeep,
  onHome,
  onCancel,
  onChange
}: {
  input: RotationInputState;
  onKeep(input: RotationInputState): void;
  onHome(input: RotationInputState): void;
  onCancel(input: RotationInputState): void;
  onChange(input: RotationInputState): void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onKeep(input);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel(input);
    }
  };
  const stopPointerPropagation = (event: PointerEvent<HTMLFormElement>) => {
    event.stopPropagation();
  };

  return (
    <form
      aria-label={`${input.targetLabel} rotation entry`}
      className="object-rotation-input-popover"
      data-rotation-input-popover="true"
      data-rotation-input-kind={input.kind}
      onSubmit={handleSubmit}
      onPointerDown={stopPointerPropagation}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {input.kind === "z" ? (
        <label className="object-rotation-input-field">
          <span>Z</span>
          <input
            aria-label="Z rotation degrees"
            autoFocus
            inputMode="decimal"
            type="text"
            value={input.draftZDegrees}
            onChange={(event) => onChange({ ...input, draftZDegrees: event.currentTarget.value })}
          />
        </label>
      ) : (
        <>
          <label className="object-rotation-input-field">
            <span>X</span>
            <input
              aria-label="X rotation degrees"
              autoFocus
              inputMode="decimal"
              type="text"
              value={input.draftXDegrees}
              onChange={(event) => onChange({ ...input, draftXDegrees: event.currentTarget.value })}
            />
          </label>
          <label className="object-rotation-input-field">
            <span>Y</span>
            <input
              aria-label="Y rotation degrees"
              inputMode="decimal"
              type="text"
              value={input.draftYDegrees}
              onChange={(event) => onChange({ ...input, draftYDegrees: event.currentTarget.value })}
            />
          </label>
        </>
      )}
      <span aria-hidden="true" className="object-rotation-input-unit">°</span>
      <button
        aria-label="Restore rotation home"
        className="object-rotation-input-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onHome(input);
        }}
      >
        <HomeInputIcon />
      </button>
      <button
        aria-label="Cancel rotation entry"
        className="object-rotation-input-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onCancel(input);
        }}
      >
        <CancelRotationInputIcon />
      </button>
    </form>
  );
}

function ObjectResizeInputPopover({
  input,
  onKeep,
  onHome,
  onCancel,
  onChange
}: {
  input: ObjectResizeInputState;
  onKeep(input: ObjectResizeInputState): void;
  onHome(input: ObjectResizeInputState): void;
  onCancel(input: ObjectResizeInputState): void;
  onChange(input: ObjectResizeInputState): void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onKeep(input);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel(input);
    }
  };
  const stopPointerPropagation = (event: PointerEvent<HTMLFormElement>) => {
    event.stopPropagation();
  };

  return (
    <form
      aria-label={`${input.targetLabel} stretch entry`}
      className="object-scale-input-popover"
      data-scale-input-popover="true"
      data-scale-input-corner={input.corner}
      onSubmit={handleSubmit}
      onPointerDown={stopPointerPropagation}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <label className="object-scale-input-field">
        <span>X</span>
        <input
          aria-label="X stretch percent"
          autoFocus
          inputMode="decimal"
          type="text"
          value={input.draftXPercent}
          onChange={(event) => onChange({ ...input, draftXPercent: event.currentTarget.value })}
        />
      </label>
      <label className="object-scale-input-field">
        <span>Y</span>
        <input
          aria-label="Y stretch percent"
          inputMode="decimal"
          type="text"
          value={input.draftYPercent}
          onChange={(event) => onChange({ ...input, draftYPercent: event.currentTarget.value })}
        />
      </label>
      <span aria-hidden="true" className="object-scale-input-unit">%</span>
      <button
        aria-label="Restore stretch home"
        className="object-scale-input-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onHome(input);
        }}
      >
        <HomeInputIcon />
      </button>
      <button
        aria-label="Cancel stretch entry"
        className="object-scale-input-action"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onCancel(input);
        }}
      >
        <CancelRotationInputIcon />
      </button>
    </form>
  );
}

function HomeInputIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 7.3L8 2.9l5.5 4.4" />
      <path d="M4.2 7.1v6h3V9.7h1.6v3.4h3v-6" />
    </svg>
  );
}

function CancelRotationInputIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

function ObjectResizeReadout({
  scaleXPercent,
  scaleYPercent
}: {
  scaleXPercent: number;
  scaleYPercent: number;
}) {
  return (
    <span
      className="object-resize-readout"
      data-object-resize-readout="true"
      aria-label={`Object scale X ${scaleXPercent} percent Y ${scaleYPercent} percent`}
    >
      X {scaleXPercent}% Y {scaleYPercent}%
    </span>
  );
}

function RotateSelectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-rotate-icon="double-headed">
      <path
        className="object-rotate-arc"
        d="M7 8.9a6.9 6.9 0 0 1 10.2-1.3"
      />
      <path
        className="object-rotate-arrow"
        d="M17.4 4.6l0.4 4.1-4.1-0.3"
      />
      <path
        className="object-rotate-arc"
        d="M17 15.1a6.9 6.9 0 0 1-10.2 1.3"
      />
      <path
        className="object-rotate-arrow"
        d="M6.6 19.4l-0.4-4.1 4.1 0.3"
      />
    </svg>
  );
}

function RotateSelectionReadout({ degrees }: { degrees: number }) {
  return (
    <span
      className="object-rotate-readout"
      data-rotate-readout="true"
      aria-label={`Rotation ${degrees} degrees`}
    >
      {degrees}
      <span aria-hidden="true">°</span>
    </span>
  );
}

function ProjectedPlaneTiltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-tilt3d-icon="circular-arrow">
      <path
        className="object-tilt3d-loop"
        d="M4.2 12.4c0-4.1 4-7.2 9-7.2 4.7 0 8.4 2.8 8.6 6.7"
      />
      <path
        className="object-tilt3d-return"
        d="M4.7 14.1c1.4 2.9 4.7 4.7 8.7 4.7"
      />
      <path
        className="object-tilt3d-arrowhead"
        d="M11.2 10.6l7.2 5.5-7.2 5.5v-3.7H7.9v-3.6h3.3z"
      />
    </svg>
  );
}

function ProjectedPlaneTiltReadout({ label, limited }: { label: string; limited: boolean }) {
  return (
    <span
      className="object-tilt3d-readout"
      data-tilt3d-readout="true"
      data-tilt3d-limited={limited ? "true" : undefined}
      aria-label={limited ? `3D rotate limited ${label}` : `3D rotate ${label}`}
    >
      {label}
    </span>
  );
}

function NativeBondGrowthPreview({
  atom,
  candidateDirections,
  direction,
  object
}: {
  atom: MoleculeObject["atoms"][number];
  candidateDirections: ClientPoint[];
  direction: ClientPoint;
  object: MoleculeObject;
}) {
  const start = {
    x: atom.x - object.x,
    y: atom.y - object.y
  };
  const previewLength = 30;
  const headLength = 7;
  const headWidth = 4.5;
  const arrows = candidateDirections.length > 0 ? candidateDirections : [direction];

  return (
    <g className="native-bond-growth-preview" data-preview-atom-id={atom.id}>
      {arrows.map((candidateDirection, index) => {
        const selected = directionsNearlyEqual(candidateDirection, direction);
        const end = {
          x: start.x + candidateDirection.x * previewLength,
          y: start.y + candidateDirection.y * previewLength
        };
        const headBase = {
          x: end.x - candidateDirection.x * headLength,
          y: end.y - candidateDirection.y * headLength
        };
        const normal = {
          x: -candidateDirection.y,
          y: candidateDirection.x
        };
        const headPoints = [
          end,
          {
            x: headBase.x + normal.x * headWidth,
            y: headBase.y + normal.y * headWidth
          },
          {
            x: headBase.x - normal.x * headWidth,
            y: headBase.y - normal.y * headWidth
          }
        ].map((point) => `${point.x},${point.y}`).join(" ");
        const suffix = selected ? "selected" : "alternate";

        return (
          <g
            className={`native-bond-preview-option native-bond-preview-option-${suffix}`}
            data-preview-option={suffix}
            key={`${candidateDirection.x.toFixed(3)}-${candidateDirection.y.toFixed(3)}-${index}`}
          >
            <line
              className={`native-bond-preview-arrow native-bond-preview-arrow-${suffix}`}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
            />
            <polygon
              className={`native-bond-preview-arrow-head native-bond-preview-arrow-head-${suffix}`}
              points={headPoints}
            />
          </g>
        );
      })}
      <circle
        className="native-atom-hover"
        cx={start.x}
        cy={start.y}
        r="8"
      />
    </g>
  );
}

function directionsNearlyEqual(left: ClientPoint, right: ClientPoint): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y) < 0.01;
}

function NativeFreeformBondPreview({
  atom,
  newAtomPoint,
  object,
  targetAtom
}: {
  atom: MoleculeObject["atoms"][number];
  newAtomPoint: ClientPoint;
  object: MoleculeObject;
  targetAtom?: MoleculeObject["atoms"][number];
}) {
  const start = {
    x: atom.x - object.x,
    y: atom.y - object.y
  };
  const end = {
    x: newAtomPoint.x - object.x,
    y: newAtomPoint.y - object.y
  };

  return (
    <g className="native-freeform-bond-preview" data-freeform-preview-atom-id={atom.id}>
      <line
        className="native-bond-freeform-line"
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
      />
      <circle
        className="native-atom-hover"
        cx={start.x}
        cy={start.y}
        r="8"
      />
      <circle
        className="native-freeform-endpoint"
        cx={end.x}
        cy={end.y}
        r="3.5"
      />
      {targetAtom ? (
        <circle
          className="native-freeform-target-atom"
          cx={targetAtom.x - object.x}
          cy={targetAtom.y - object.y}
          r="9.5"
        />
      ) : null}
    </g>
  );
}

function resolveOpenResultDocument(result: ReturnType<typeof openNativeDocument>): ResolvedOpenDocument | undefined {
  if (result.document) {
    return { document: result.document, source: result.source };
  }
  if (!result.conflict) {
    return undefined;
  }

  if (result.conflict.visibleDocument) {
    const importVisible = window.confirm(
      "This file's visible CDXML was modified outside ChemDraft. Import the edited visible CDXML subset? Choose Cancel to restore the embedded ChemDraft document instead."
    );
    return importVisible
      ? {
          document: result.conflict.visibleDocument,
          source: "external-cdxml",
          statusSourceLabel: "edited visible CDXML subset"
        }
      : {
          document: result.conflict.embeddedDocument,
          source: "native-payload",
          statusSourceLabel: "embedded ChemDraft document"
        };
  }

  const restoreEmbedded = window.confirm(
    "This file's visible CDXML was modified outside ChemDraft, but ChemDraft could not import a visible subset. Restore the embedded ChemDraft document?"
  );
  return restoreEmbedded
    ? {
        document: result.conflict.embeddedDocument,
        source: "native-payload",
        statusSourceLabel: "embedded ChemDraft document"
      }
    : undefined;
}

function shouldEnableAgentBridge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("agentBridge") === "1" ||
      params.get("chemdraftAgentBridge") === "1" ||
      window.localStorage.getItem("chemdraft.agentBridge") === "enabled";
  } catch {
    return false;
  }
}

function shouldEnableArtTransformQaLayer(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("artQa") === "0" || params.get("chemdraftArtQa") === "0") {
      return false;
    }
    return params.get("artQa") === "1" ||
      params.get("chemdraftArtQa") === "1" ||
      params.get("agentBridge") === "1" ||
      params.get("chemdraftAgentBridge") === "1" ||
      window.localStorage.getItem("chemdraft.artTransformQa") === "enabled";
  } catch {
    return false;
  }
}

function shouldEnableArtStyleQaLayer(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("artStyleQa") === "0" || params.get("chemdraftArtStyleQa") === "0") {
      return false;
    }
    return params.get("artStyleQa") === "1" ||
      params.get("chemdraftArtStyleQa") === "1" ||
      window.localStorage.getItem("chemdraft.artStyleQa") === "enabled";
  } catch {
    return false;
  }
}

function agentBridgeDocumentPayloadFromHash(): { contents: string; displayName: string; path?: string } | undefined {
  if (typeof window === "undefined" || window.location.hash.length <= 1) {
    return undefined;
  }

  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const text = params.get("openDocumentText");
    if (text) {
      return {
        contents: text,
        displayName: params.get("displayName") ?? "Agent document",
        path: params.get("path") ?? undefined
      };
    }

    const encoded = params.get("openDocumentBase64");
    if (!encoded) {
      return undefined;
    }

    return {
      contents: window.atob(encoded),
      displayName: params.get("displayName") ?? "Agent document",
      path: params.get("path") ?? undefined
    };
  } catch {
    return undefined;
  }
}

function formatSaveStatus(filename: string, warnings: readonly { code: string; message: string }[]): string {
  return warnings.length > 0
    ? `Saved ${filename} with ${warnings.length} compatibility warning(s)`
    : `Saved ${filename}`;
}

function formatExportStatus(label: string, warningCount: number): string {
  return warningCount > 0
    ? `Exported ${label} with ${warningCount} warning(s)`
    : `Exported ${label}`;
}

async function createDialogExportResult(
  document: ChemDraftDocument,
  state: ExportDialogState
): Promise<ExportResult> {
  const descriptor = getExportFormatDescriptor(state.format);

  if (state.format === "svg") {
    const result = exportPhase4Svg(document, {
      includeWarnings: state.svg.includeWarnings,
      includePageGuides: state.svg.includePageGuides
    });
    return {
      format: descriptor.id,
      kind: "text",
      contents: result.contents,
      mimeType: descriptor.mimeType,
      extension: descriptor.extensions[0] ?? "svg",
      warnings: result.warnings
    };
  }

  if (state.format === "pdf") {
    return exportPhase4Pdf(document, {
      compress: state.pdf.compress,
      includePageGuides: state.pdf.includePageGuides
    });
  }

  if (state.format === "cdxml") {
    return exportPhase4Cdxml(document, {
      creationProgram: state.cdxml.creationProgram.trim() || "ChemDraft"
    });
  }

  const rasterFormat = rasterExportFormatForDialogFormat(state.format);
  if (rasterFormat) {
    if (!isDesktopRuntime()) {
      throw new Error(`${descriptor.menuLabel} export requires the ChemDraft desktop app.`);
    }
    const transparent = rasterFormat === "png" && state.raster.background === "transparent";
    // The SVG must omit its white page rect for a transparent request, otherwise resvg
    // paints it over the (intentionally unfilled) pixmap and the PNG comes out opaque white.
    const svgResult = exportPhase4Svg(document, {
      includeWarnings: true,
      background: transparent ? "transparent" : "#ffffff"
    });
    const rasterResult = await rasterizeSvgNative(svgResult.contents, rasterFormat, {
      scale: sanitizedDialogNumber(state.raster.scale, 1, 1, 4),
      background: transparent ? "transparent" : "#ffffff",
      jpegQuality: sanitizedDialogNumber(state.raster.jpegQuality, 90, 1, 100),
      maxDimensionPx: sanitizedDialogNumber(state.raster.maxDimensionPx, 8192, 1, 8192)
    });

    return {
      format: descriptor.id,
      kind: "binary",
      bytes: rasterResult.bytes,
      mimeType: descriptor.mimeType,
      extension: descriptor.extensions[0] ?? rasterFormat,
      warnings: [
        ...svgResult.warnings,
        ...rasterResult.warnings
      ]
    };
  }

  throw new Error(`${descriptor.menuLabel} export is not implemented.`);
}

function downloadExportResult(filename: string, result: ExportResult): void {
  if (result.kind === "text") {
    downloadText(filename, result.contents, result.mimeType);
    return;
  }

  downloadBlob(filename, new Blob([arrayBufferFromBytes(result.bytes)], { type: result.mimeType }));
}

async function writeNativeExportResult(path: string, result: ExportResult): Promise<void> {
  if (result.kind === "text") {
    await writeNativeTextFile(path, result.contents);
    return;
  }

  await writeNativeBinaryFile(path, result.bytes);
}

function sanitizedDialogNumber(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function formatOpenStatus(
  filename: string,
  source: ReturnType<typeof openNativeDocument>["source"],
  warnings: readonly { code: string; message: string }[],
  statusSourceLabel?: string
): string {
  const sourceLabel = statusSourceLabel ?? (
    source === "legacy-json"
      ? "legacy ChemDraft JSON"
      : source === "external-cdxml"
        ? "external CDXML subset"
        : "ChemDraft CDXML envelope"
  );
  return warnings.length > 0
    ? `Opened ${filename} as ${sourceLabel} with ${warnings.length} warning(s)`
    : `Opened ${filename} as ${sourceLabel}`;
}

function formatOpenFailure(warnings: readonly { code: string; message: string }[]): string {
  if (warnings.length === 0) {
    return "Open failed without a compatibility warning.";
  }
  return warnings.map((warning) => warning.message).join(" ");
}

async function pickNativeOpenPath(): Promise<string | undefined> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "Open ChemDraft or CDXML Document",
    multiple: false,
    fileAccessMode: "scoped"
  });
  return typeof selected === "string" ? selected : undefined;
}

async function pickNativeSavePath(defaultPath: string): Promise<string | undefined> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    title: "Save ChemDraft Document",
    defaultPath,
    filters: [{ name: "ChemDraft", extensions: ["chemdraft"] }]
  });
  return selected ?? undefined;
}

async function pickNativeExportPath(
  defaultPath: string,
  formatLabel: string,
  extensions: readonly string[]
): Promise<string | undefined> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    title: `Export ${formatLabel}`,
    defaultPath,
    filters: [{ name: formatLabel, extensions: [...extensions] }]
  });
  return selected ? ensureExportFileExtension(selected, extensions) : undefined;
}

async function readNativeTextFile(path: string): Promise<string> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  return readTextFile(path);
}

async function takePendingNativeOpenDocument(): Promise<NativeOpenDocumentPayload | undefined> {
  const { invoke } = await import("@tauri-apps/api/core");
  const payload = await invoke<NativeOpenDocumentPayload | null>("take_pending_open_document");
  return payload ?? undefined;
}

async function listenForNativeOpenDocuments(
  handler: (payload: NativeOpenDocumentPayload) => void
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<NativeOpenDocumentPayload>(nativeOpenDocumentEvent, (event) => {
    if (isNativeOpenDocumentPayload(event.payload)) {
      handler(event.payload);
    }
  });
}

function isNativeOpenDocumentPayload(value: unknown): value is NativeOpenDocumentPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NativeOpenDocumentPayload).path === "string" &&
    typeof (value as NativeOpenDocumentPayload).displayName === "string" &&
    typeof (value as NativeOpenDocumentPayload).contents === "string"
  );
}

async function writeNativeTextFile(path: string, contents: string): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(path, contents);
}

async function writeNativeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, bytes);
}

function ensureChemDraftFileExtension(path: string): string {
  return /\.(chemdraft|cdxml)$/i.test(path) ? path : `${path}.chemdraft`;
}

function ensureExportFileExtension(path: string, extensions: readonly string[]): string {
  if (extensions.length === 0) {
    return path;
  }
  const escapedExtensions = extensions.map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const extensionPattern = new RegExp(`\\.(${escapedExtensions.join("|")})$`, "i");
  return extensionPattern.test(path) ? path : `${path}.${extensions[0]}`;
}

function nativePathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function downloadText(filename: string, contents: string, mimeType: string): void {
  downloadBlob(filename, new Blob([contents], { type: mimeType }));
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createExportFilename(document: ChemDraftDocument, extension: string): string {
  const baseName = document.title.replace(/\.chemdraft$/i, "").trim().replace(/[^a-z0-9._-]+/gi, "-") || "Untitled";
  return `${baseName}.${extension}`;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function formatAnalysisStatus(analysis: StructureAnalysisResult): string {
  const formula = analysis.properties.formula ?? "formula unavailable";
  const mass = analysis.properties.averageMass ? `, avg mass ${analysis.properties.averageMass.toFixed(3)}` : "";
  const warningText = analysis.validation.warnings.length > 0 ? ` with ${analysis.validation.warnings.length} warning(s)` : "";
  return `Validated ${formula}${mass}${warningText}`;
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

function formatChemistrySummary(chemistry: NonNullable<MoleculeObject["chemistry"]>): string {
  const parts = [
    chemistry.averageMass !== undefined ? `avg ${chemistry.averageMass.toFixed(3)}` : undefined,
    chemistry.exactMass !== undefined ? `exact ${chemistry.exactMass.toFixed(4)}` : undefined,
    chemistry.totalCharge ? `charge ${chemistry.totalCharge}` : undefined,
    chemistry.stereochemistry.length > 0 ? chemistry.stereochemistry.join(", ") : undefined
  ].filter(Boolean);

  return parts.join(" | ");
}

function moleculeDrawingPrimitive(object: MoleculeObject): "single-bond" | undefined {
  return object.style.drawingPrimitive === "single-bond" && object.atoms.length === 2 ? "single-bond" : undefined;
}

function chargeValueForToolCommand(commandId: string): NativeChargeValue | undefined {
  if (commandId === "tool.plus") {
    return 1;
  }

  if (commandId === "tool.minus") {
    return -1;
  }

  return undefined;
}

function moleculeAriaLabel(object: MoleculeObject): string {
  if (object.chemistry?.formula) {
    return `Molecule ${object.chemistry.formula}`;
  }

  if (object.structure.length <= 40 && !object.structure.includes("\n")) {
    return `Molecule ${object.structure}`;
  }

  return `Molecule ${object.structureFormat}`;
}

function isNativeMoleculeGraph(object: MoleculeObject): boolean {
  return object.atoms.length > 0;
}

function formatValidationFailure(analysis: StructureAnalysisResult): string {
  const firstError = analysis.validation.errors[0] ?? analysis.validation.warnings[0];
  return firstError ? `Validation unavailable: ${firstError.message}` : "Validation unavailable";
}
