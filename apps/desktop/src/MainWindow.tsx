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
  DefaultNativeTextStyle,
  applyPatches,
  createDocumentHistory,
  moleculeToMolfileV2000,
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  redo as redoDocumentHistory,
  undo as undoDocumentHistory,
  type BondRef,
  type ChemDraftDocument,
  type DocumentHistory,
  type DocumentObject,
  type DocumentPatch,
  type MoleculeAtom,
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
  atomDisplayLabel,
  atomLabelLayout,
  atomLabelRunFontSize,
  bondRefKey,
  depthCuedBondColor,
  depthCuedBondStrokeWidth,
  isTerminalHeteroatomDoubleBond,
  labelEndpointClearance,
  planPageSvgRender,
  sameBondRef,
  styleColorMapValue,
  textObjectSpansForRendering,
  type PageSvgAttributeValue,
  type PageSvgElementFragment,
  type PageSvgFragment,
  type PageSvgRenderPlan,
  type ResolvedBondCrossing
} from "@chemdraft/layout-engine";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import { inspectClipboardPayload, looksLikeSmiles, type ClipboardDetectedPayload } from "@chemdraft/clipboard-adapter";
import type { Generate3DConformerResult, StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
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
  pageOrientationActions,
  pageSizeActions,
  structureCleanup3dCommandId,
  structureCleanupCommandId,
  structureSpin3dCommandId,
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
  createNativeSavePayload,
  createPhase4Document,
  cleanUpNativeMolecules2d,
  flattenSpunMolecule,
  deleteSelectedDocumentObjects,
  exportPhase4Cdxml,
  exportPhase4Pdf,
  exportPhase4Svg,
  getSelectedMolecule,
  getSelectedTextObject,
  insertNativeTextObject,
  insertSmilesMolecule,
  nativeAtomDisplayLabel,
  nativeChargeAssociationsForMolecule,
  nativeChargeByAtomIdFromAssociations,
  nativeBondStyleForToolCommand,
  nativeElementFromKeyboardKey,
  nativeMoleculeInvalidAtomStates,
  nativeMoleculePartBounds,
  nativeMoleculeCenter,
  nativeMoleculeTransformState,
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
  recommendImportedPageFit,
  reorderSelectedDocumentObject,
  resizeNativeMoleculeParts,
  resizeNativeMoleculeObject,
  resizeNativeTextObjectBox,
  resolveToolbarColorSelection,
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
  toggleSpin3dDebuggerWindow,
  toggleToolsetWindow
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
import { applyTrackballDrag, quatToViewMatrix, type Quaternion } from "./interaction/rotation3d";
import { bondDepthWeights, initialViewQuaternion, projectSpin, overlayScale, type ScreenPlacement } from "./interaction/spinOverlay";
import { getConformerWorkerClient } from "./conformerClient";
import {
  SPIN3D_DEBUGGER_COMMAND_ID,
  broadcastSpin3dTraceEvent,
  createSpin3dTraceEvent,
  createSpin3dTraceEventFromOcl,
  startSpin3dTraceSpan,
  type Spin3dTraceEvent,
  type Spin3dTracePath
} from "./conformerDebug";
import {
  BOND_HIT_CATCHER_STROKE_PX,
  currentTemplateTargetFromHoverOrHit,
  hitToleranceForScale,
  nativeMoleculeCanvasHoverTarget,
  nativeMoleculeHitFromPointerTarget,
  nativeMoleculeTemplateHoverTarget,
  type TemplateHoverSample
} from "./interaction/hitTest";
import {
  AGENT_BRIDGE_GLOBAL_NAME,
  createChemDraftAgentBridge,
  dispatchAgentPointerEvent,
  resolveAgentBridgePermission,
  waitForAnimationFrames,
  type AgentHitResult,
  type AgentObjectAnchor,
  type AgentPoint,
  type AgentPointerEventType,
  type AgentPointerOptions,
  type AgentPointTarget,
  type AgentResolvedPoint,
  type AgentSnapshot
} from "./agentBridge";

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
type MoleculeResizeInputState = {
  objectId: string;
  target?: NativeMoleculeSelectionPart;
  targetLabel: string;
  corner: MoleculeResizeCorner;
  startDocument: ChemDraftDocument;
  draftXPercent: string;
  draftYPercent: string;
  homeXPercent: string;
  homeYPercent: string;
};
type MoleculeResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type MoleculeResizeDragState = {
  pointerId: number;
  objectId: string;
  target?: NativeMoleculeSelectionPart;
  corner: MoleculeResizeCorner;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  startPoint: ClientPoint;
  startCumulativeScale: MoleculeResizeScale;
  latestPoint: ClientPoint;
  latestScale: MoleculeResizeScale;
  latestCumulativeScale: MoleculeResizeScale;
  stretching: boolean;
  dragging: boolean;
};
type MoleculeResizeReadoutState = {
  objectId: string;
  scaleXPercent: number;
  scaleYPercent: number;
};
type MoleculeResizeScale = {
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
type SelectionLassoState = {
  pointerId: number;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  points: ClientPoint[];
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
const LASSO_POINT_SPACING = 3;
const MOLECULE_RESIZE_MIN_SCALE = 0.12;
// Spin 3D speculative-work caps. Prefetch is a surprise cost: above this size the
// conformer is only computed when the user actually clicks Spin 3D.
const SPIN_PREFETCH_MAX_ATOMS = 40;
// The in-page (main-thread) engine fallback FREEZES the UI for its full duration —
// fine for small structures, catastrophic for a 60-atom branched chain.
const SPIN_IN_PAGE_MAX_ATOMS = 30;

// Identity of the 3D conformer a molecule would embed to — connectivity, elements,
// charges, and bond orders, in atom-array order (coords3d is indexed by that order).
// Deliberately position-independent: dragging or flattening a molecule (which only
// moves its 2D x/y) keeps the signature stable, so the spin model memo survives those.
// Editing the graph (add/remove atom, change element/charge/bond order) changes it,
// invalidating a stale memo.
function conformerGraphSignature(molecule: MoleculeObject): string {
  const atoms = molecule.atoms.map((atom) => `${atom.id}:${atom.element}:${atom.formalCharge}`).join(",");
  const bonds = molecule.bonds.map((bond) => `${bond.fromAtomId}>${bond.toAtomId}:${bond.order}`).join(",");
  return `${atoms}|${bonds}`;
}
const DOCUMENT_HISTORY_LIMIT = 100;
const CURRENT_BUILD_STAMP = "6.14.22.26-opus";
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
  /** The molecule resolved under the press, if any. */
  objectId?: string;
}

type TransformHandlePressKind =
  | "rotate-z"
  | "rotate-xy"
  | `resize-${MoleculeResizeCorner}`;

interface TransformHandlePressSample extends SelectionPressSample {
  objectId: string;
  handleKind: TransformHandlePressKind;
}

/**
 * True when `current` is the second press of a double-click. Two presses that resolve to the
 * SAME molecule within the time window count, even when they land on different visible parts —
 * a small low-zoom molecule spans more than the screen-distance fallback, and the first press
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
  // When both presses resolve to a molecule, the double-click is defined by the same molecule
  // (regardless of screen distance — a small low-zoom molecule exceeds the fallback radius).
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
  nativePalette = isDesktopRuntime()
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
  const objectRotateDragRef = useRef<ObjectRotateDragState | null>(null);
  const objectRotateReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const projectedPlaneTiltDragRef = useRef<ProjectedPlaneTiltDragState | null>(null);
  const projectedPlaneTiltReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const moleculeResizeDragRef = useRef<MoleculeResizeDragState | null>(null);
  const moleculeResizeReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const groupTransformDragRef = useRef<GroupTransformDragState | null>(null);
  const textResizeRef = useRef<TextResizeState | null>(null);
  const lastNativeOpenPayloadKeyRef = useRef<{ key: string; at: number } | undefined>(undefined);
  const textEditorFocusTimeoutsRef = useRef<number[]>([]);
  const selectionMarqueeRef = useRef<SelectionMarqueeState | null>(null);
  const selectionLassoRef = useRef<SelectionLassoState | null>(null);
  const marqueeMachineRef = useRef<InteractionState>(initialInteractionState());
  const lassoMachineRef = useRef<InteractionState>(initialInteractionState());
  const placementMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectRotateMachineRef = useRef<InteractionState>(initialInteractionState());
  const projectedPlaneTiltMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectDragMachineRef = useRef<InteractionState>(initialInteractionState());
  // 3D spin (Phase 4): authoritative state in a ref (read by pointer handlers,
  // immune to stale closures) mirrored into React state so the overlay re-renders.
  const spin3dStateRef = useRef<Spin3dState | undefined>(undefined);
  const [spin3dState, setSpin3dStateRender] = useState<Spin3dState | undefined>(undefined);
  // Dirty-flag rAF: drag events write to the ref and set the flag; the scheduled
  // rAF renders once and stops. Zero frames fired when the scene isn't changing.
  const spinDirtyRef = useRef(false);
  const spinRafRef = useRef<number | null>(null);
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
  const [activeAtomLabelEdit, setActiveAtomLabelEdit] = useState<AtomLabelEditState | undefined>();
  const [textStyleDefaults, setTextStyleDefaults] = useState<NativeTextStyle>(DefaultNativeTextStyle);
  const [activeToolState, setActiveToolState] = useState(() => createActiveToolState(initialActiveToolCommandId));
  const [toolsetRegistry, setToolsetRegistry] = useState<DesktopToolsetRegistry>(() => desktopToolsetRegistry);
  const [visibleToolsetIds, setVisibleToolsetIds] = useState(() =>
    initialPaletteMode === "hidden" ? new Set<string>() : new Set(defaultVisibleToolsetIds)
  );
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
  const [selectionLasso, setSelectionLasso] = useState<SelectionLassoState | undefined>();
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuState | undefined>();
  const [freeformNativeBond, setFreeformNativeBond] = useState<FreeformNativeBondPreview | undefined>();
  const [nativeDoubleBondSidePreview, setNativeDoubleBondSidePreview] = useState<NativeDoubleBondSidePreview | undefined>();
  const [objectRotateReadout, setObjectRotateReadout] = useState<ObjectRotateReadoutState | undefined>();
  const [projectedPlaneTiltReadout, setProjectedPlaneTiltReadout] = useState<ProjectedPlaneTiltReadoutState | undefined>();
  const [rotationInput, setRotationInput] = useState<RotationInputState | undefined>();
  const [moleculeResizeInput, setMoleculeResizeInput] = useState<MoleculeResizeInputState | undefined>();
  const [moleculeResizeReadout, setMoleculeResizeReadout] = useState<MoleculeResizeReadoutState | undefined>();
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
  const invokeCommandRef = useRef<(commandId: string) => void | Promise<void>>(() => undefined);
  const documentRef = useRef(document);
  const documentHistoryRef = useRef<DocumentHistory>(documentHistory);
  const fileStateRef = useRef<NativeFileState>(fileState);
  const rotationInputRef = useRef<RotationInputState | undefined>(undefined);
  const moleculeResizeInputRef = useRef<MoleculeResizeInputState | undefined>(undefined);
  const activeToolCommandIdRef = useRef(activeToolState.activeCommandId);
  const nativePaletteRef = useRef(nativePalette);
  const toolBeforeTextPlacementRef = useRef<ActiveToolState | undefined>(undefined);
  const hoveredNativeDeleteTargetRef = useRef<NativeMoleculeDeleteTarget | undefined>(undefined);
  const selectedNativeMoleculePartRef = useRef<NativeMoleculeSelectionPart | undefined>(undefined);
  const agentPointerTargetsRef = useRef<Map<number, EventTarget>>(new Map());
  const agentRuntimeSourceRef = useRef("disabled");
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
  rotationInputRef.current = rotationInput;
  moleculeResizeInputRef.current = moleculeResizeInput;
  activeToolCommandIdRef.current = activeToolState.activeCommandId;
  nativePaletteRef.current = nativePalette;
  hoveredNativeDeleteTargetRef.current = hoveredNativeDeleteTarget;
  selectedNativeMoleculePartRef.current = selectedNativeMoleculePart;

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

    return textStyleDefaults;
  }, [selectedMoleculeForStyle, selectedNativeMoleculePart, selectedTextObject, selectedTextRange, textStyleDefaults]);
  const currentToolbarTextScript = selectedTextObject ? selectedTextScript : "normal";
  const currentToolbarTextStateRef = useRef(
    createToolsetTextStylePayload(currentToolbarTextStyle, currentToolbarTextScript)
  );
  currentToolbarTextStateRef.current = createToolsetTextStylePayload(
    currentToolbarTextStyle,
    currentToolbarTextScript
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
  const pageSvgRenderPlan = useMemo(() => planPageSvgRender(plannedDisplayPage), [plannedDisplayPage]);
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
  const updateRotationInput = useCallback((nextInput: RotationInputState | undefined) => {
    rotationInputRef.current = nextInput;
    setRotationInput(nextInput);
  }, []);
  const updateMoleculeResizeInput = useCallback((nextInput: MoleculeResizeInputState | undefined) => {
    moleculeResizeInputRef.current = nextInput;
    setMoleculeResizeInput(nextInput);
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
        setStatus(`Toolbar layout unavailable: ${error instanceof Error ? error.message : String(error)}`);
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
    if (moleculeResizeReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(moleculeResizeReadoutTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    void broadcastToolsetActiveTool(activeToolState.activeCommandId).catch(() => undefined);
  }, [activeToolState.activeCommandId]);

  useEffect(() => {
    void broadcastToolsetTextStyle(
      createToolsetTextStylePayload(currentToolbarTextStyle, currentToolbarTextScript)
    ).catch(() => undefined);
  }, [currentToolbarTextScript, currentToolbarTextStyle]);

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

    if (nativePalette) {
      const nextState = await toggleToolsetWindow(toolsetId);
      setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, nextState.open));
      setStatus(nextState.open ? `${toolsetRegistry.require(toolsetId).title} open` : `${toolsetRegistry.require(toolsetId).title} closed`);
      return;
    }

    setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, !current.has(toolsetId)));
    setStatus(`Toggled ${toolsetRegistry.require(toolsetId).title}`);
  }, [nativePalette, toolsetRegistry]);

  const deleteHoveredNativeTarget = useCallback(() => {
    const currentDocument = documentRef.current;
    // A lasso fragment selection ("parts") takes precedence over a hovered atom/bond:
    // delete every selected atom and bond in one step. A non-fragment selected part
    // (single atom/bond) still routes through the same part-delete path.
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

  const eraseDocumentObjectTarget = useCallback((
    object: DocumentObject | undefined,
    nativeTarget?: NativeMoleculeDeleteTarget
  ): boolean => {
    if (!object) {
      setStatus("Nothing to erase");
      return false;
    }

    const currentDocument = documentRef.current;
    const nextDocument = nativeTarget
      ? applyNativeMoleculeDeleteTarget(currentDocument, nativeTarget)
      : deleteSelectedDocumentObjects(selectDocumentObject(currentDocument, object.id));
    if (nextDocument === currentDocument) {
      setStatus(nativeTarget ? "No atom or bond to erase" : "Object could not be erased");
      return false;
    }

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
    setStatus(nativeTarget
      ? nativeTarget.kind === "atom" ? "Erased atom" : "Erased bond"
      : "Erased object");
    return true;
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange]);

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

  // ── 3D spin (Phase 4) ──────────────────────────────────────────────────────
  const applySpin = useCallback((next: Spin3dState | undefined) => {
    spin3dStateRef.current = next;
    setSpin3dStateRender(next);
    if (!next) {
      // Cancel any pending dirty-flag rAF so it doesn't fire after spin ends.
      if (spinRafRef.current !== null) {
        cancelAnimationFrame(spinRafRef.current);
        spinRafRef.current = null;
      }
      spinDirtyRef.current = false;
    }
  }, []);

  const endSpin3d = useCallback((message?: string) => {
    if (!spin3dStateRef.current) return;
    applySpin(undefined);
    if (message) setStatus(message);
  }, [applySpin]);

  // Flatten the current spin orientation into the document as ONE undo step. On
  // refusal the document is untouched and the overlay stays so the user can re-spin.
  const commitSpinFlatten = useCallback(() => {
    const state = spin3dStateRef.current;
    if (!state) return;
    const viewMatrix = quatToViewMatrix(state.quat);
    const outcome = flattenSpunMolecule(documentRef.current, state.objectId, state.coords3d, viewMatrix);
    if (outcome.status !== "committed") {
      setStatus(`Cannot flatten this view: ${outcome.refusalReasons[0] ?? "stereochemistry would change"}`);
      // Keep the overlay alive (end the drag) so the user can re-orient and retry.
      applySpin({ ...state, dragging: false, lastClient: undefined });
      return;
    }
    commitDocumentChange(outcome.document);
    // Remember this conformer + orientation so a later re-spin of the same (unedited)
    // structure reopens here instead of re-snapping to a fresh embed. The graph is
    // unchanged by the flatten, so signing the just-committed molecule is equivalent.
    const flattened = outcome.document.pages
      .flatMap((page) => page.objects)
      .find((object): object is MoleculeObject => object.id === state.objectId && object.type === "molecule");
    if (flattened) {
      spin3dModelCacheRef.current.set(state.objectId, {
        signature: conformerGraphSignature(flattened),
        coords3d: state.coords3d,
        quat: state.quat
      });
    }
    applySpin(undefined);
    const meaningful = outcome.warnings.filter((warning) => warning.code !== "perspective-cleanup");
    setStatus(
      meaningful.length > 0
        ? `Flattened perspective with ${meaningful.length} warning(s): ${meaningful.map((w) => w.code).join(", ")}`
        : "Flattened to a 2D perspective"
    );
  }, [applySpin, commitDocumentChange]);

  // Monotonic token: stale conformer results (from a superseded spin click) are ignored.
  const spin3dRequestRef = useRef(0);
  // Session-scoped 3D model memo, keyed by molecule objectId. The FIRST spin+flatten of a
  // structure cleans it up (the projected geometry differs from the hand-drawn layout — a
  // desired one-time reposition). After that we remember the exact conformer + committed
  // orientation, so re-spinning reopens the overlay landing on the current drawing instead
  // of re-snapping to a fresh embed's readable angle — letting the user fine-tune position.
  // Self-invalidating: the stored signature keys on graph identity, so editing the molecule
  // forces a fresh embed (treated as first-time again). Not persisted across reload.
  const spin3dModelCacheRef = useRef<Map<string, { signature: string; coords3d: Float64Array; quat: Quaternion }>>(
    new Map()
  );
  // The generation currently awaited (no overlay yet): repeated Spin 3D clicks for
  // the same structure are absorbed instead of stacking engine jobs in the worker.
  const spin3dPendingRef = useRef<{ molfile: string; objectId: string; cancel: () => void } | undefined>(undefined);

  /** Compute the overlay placement for a conformer against the molecule's drawn 2D geometry. */
  const spinPlacementFor = useCallback((molecule: MoleculeObject, coords3d: Float64Array): {
    bondPairs: [number, number][];
    bondRender: SpinBondRenderInfo[];
    atomLabels: (string | undefined)[];
    atoms: readonly MoleculeAtom[];
    placement: ScreenPlacement;
  } => {
    const atomIndex = new Map(molecule.atoms.map((atom, index) => [atom.id, index] as const));
    const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom] as const));
    // Adjacency (atom index → neighbor indices) for the double-bond side heuristic.
    const adjacency = new Map<number, number[]>();
    for (const bond of molecule.bonds) {
      const from = atomIndex.get(bond.fromAtomId);
      const to = atomIndex.get(bond.toAtomId);
      if (from === undefined || to === undefined) continue;
      (adjacency.get(from) ?? adjacency.set(from, []).get(from)!).push(to);
      (adjacency.get(to) ?? adjacency.set(to, []).get(to)!).push(from);
    }
    const bondPairs: [number, number][] = [];
    const bondRender: SpinBondRenderInfo[] = [];
    for (const bond of molecule.bonds) {
      const from = atomIndex.get(bond.fromAtomId);
      const to = atomIndex.get(bond.toAtomId);
      if (from === undefined || to === undefined) continue;
      bondPairs.push([from, to]);
      const fromAtom = atomById.get(bond.fromAtomId);
      const toAtom = atomById.get(bond.toAtomId);
      const neighborIndices = [...(adjacency.get(from) ?? []), ...(adjacency.get(to) ?? [])]
        .filter((index) => index !== from && index !== to);
      bondRender.push({
        // aromatic/unknown render as a single line ON PURPOSE: the 2D layout engine
        // (bondLineSegments) only draws inner lines for double/triple, so matching it here
        // keeps the spin overlay identical to the drawing it replaces (and to the flatten).
        order: bond.order === "double" ? 2 : bond.order === "triple" ? 3 : 1,
        symmetric: fromAtom !== undefined && toAtom !== undefined &&
          isTerminalHeteroatomDoubleBond(fromAtom, toAtom, molecule, bond),
        neighborIndices
      });
    }
    // The exact labels the 2D drawing shows (element + implicit H + charge; plain
    // bonded carbons stay unlabeled) so the spinning structure reads as the SAME one.
    const atomLabels = molecule.atoms.map((atom) => atomDisplayLabel(atom, molecule.bonds));
    const points2d = molecule.atoms.map((atom) => ({ x: atom.x, y: atom.y }));
    const centerX = points2d.reduce((sum, p) => sum + p.x, 0) / points2d.length;
    const centerY = points2d.reduce((sum, p) => sum + p.y, 0) / points2d.length;
    const scale = overlayScale(points2d, coords3d, bondPairs);
    return { bondPairs, bondRender, atomLabels, atoms: molecule.atoms, placement: { centerX, centerY, scale } };
  }, []);

  const startSpin3d = useCallback(async () => {
    const plannedRequestId = spin3dRequestRef.current + 1;
    const sessionId = `spin3d:${plannedRequestId}:${Date.now()}`;
    const emitTrace = (event: Spin3dTraceEvent): void => {
      broadcastSpin3dTraceEvent(event);
    };
    const traceInfo = (
      stage: string,
      details: Partial<Parameters<typeof createSpin3dTraceEvent>[0]> = {}
    ): void => {
      emitTrace(createSpin3dTraceEvent({
        ...details,
        sessionId,
        requestId: plannedRequestId,
        kind: details.kind ?? "spin",
        stage,
        status: details.status ?? "info"
      }));
    };
    const commandSpan = startSpin3dTraceSpan({
      sessionId,
      requestId: plannedRequestId,
      kind: "spin",
      stage: "spin.command",
    }, emitTrace);
    const currentDocument = documentRef.current;
    const selectedIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];
    if (selectedIds.length !== 1) {
      traceInfo("spin.selection", { message: `selected ${selectedIds.length}` });
      commandSpan.complete({ message: "selection rejected" });
      setStatus("Select a single molecule to spin in 3D");
      return;
    }
    const objectId = selectedIds[0];
    const molecule = currentDocument.pages[0]?.objects.find(
      (object): object is MoleculeObject => object.id === objectId && object.type === "molecule"
    );
    if (!molecule || !isNativeMoleculeGraph(molecule) || molecule.atoms.length < 2) {
      traceInfo("spin.selection", { message: "not an editable molecule" });
      commandSpan.complete({ message: "molecule rejected" });
      setStatus("Spin 3D needs an editable molecule");
      return;
    }
    if (spin3dStateRef.current?.objectId === objectId) {
      // Button mashed while the overlay is already up — keep the live session.
      traceInfo("spin.duplicate", { message: "overlay already active" });
      commandSpan.complete({ message: "already spinning" });
      setStatus("Spin 3D already active: drag the molecule to rotate · Esc to cancel");
      return;
    }

    // Already-modeled structure: reopen the stored conformer at its committed orientation
    // so the overlay lands exactly on the current drawing (no re-snap), letting the user
    // fine-tune. Only when the graph is unchanged since the flatten (signature match).
    const memo = spin3dModelCacheRef.current.get(objectId);
    if (memo && memo.signature === conformerGraphSignature(molecule)) {
      // Supersede any in-flight generation and invalidate stale async callbacks.
      spin3dPendingRef.current?.cancel();
      spin3dPendingRef.current = undefined;
      spin3dRequestRef.current += 1;
      const { bondPairs, bondRender, atomLabels, atoms, placement } = spinPlacementFor(molecule, memo.coords3d);
      applySpin({
        objectId,
        quat: memo.quat,
        coords3d: memo.coords3d,
        bondPairs,
        bondRender,
        atomLabels,
        atoms,
        placement,
        selectionBox: { x: molecule.x, y: molecule.y, width: molecule.width, height: molecule.height },
        dragging: false
      });
      traceInfo("spin.reused", {
        atomCount: molecule.atoms.length,
        message: "cached model — reopened at committed orientation (no re-snap)"
      });
      commandSpan.complete({ message: "reused cached model" });
      setStatus("Spin 3D: drag the molecule to rotate · click outside to flatten · Esc to cancel");
      return;
    }

    setStatus("Generating 3D conformer…");
    // Document is y-down; the molfile/engine frame is y-up → fromDocFrame negates y.
    const molfileSpan = startSpin3dTraceSpan({
      sessionId,
      requestId: plannedRequestId,
      kind: "spin",
      stage: "spin.molfile",
      atomCount: molecule.atoms.length
    }, emitTrace);
    let molfile: string;
    try {
      molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true });
      molfileSpan.complete({ atomCount: molecule.atoms.length });
    } catch (error) {
      molfileSpan.fail(error, { atomCount: molecule.atoms.length });
      commandSpan.fail(error);
      setStatus(`3D spin unavailable: ${(error as Error).message}`);
      return;
    }
    const pendingSpin = spin3dPendingRef.current;
    if (pendingSpin?.molfile === molfile) {
      // Same structure is already being generated — absorb the repeat click
      // instead of stacking another multi-second engine job in the worker.
      traceInfo("spin.duplicate", { message: "generation already pending" });
      commandSpan.complete({ message: "duplicate absorbed" });
      setStatus(`Generating 3D conformer… still working (${molecule.atoms.length} atoms)`);
      return;
    }
    // A different structure supersedes any pending generation: detach its handlers
    // and drop the queued worker job (a running engine call finishes + caches).
    pendingSpin?.cancel();
    spin3dPendingRef.current = undefined;
    const requestToken = ++spin3dRequestRef.current;
    commandSpan.complete({ atomCount: molecule.atoms.length });

    // Slow-path feedback: if no overlay after ~2s, tell the user the engine is
    // genuinely working (large/branched structures can take several seconds).
    const slowTimer = window.setTimeout(() => {
      if (spin3dRequestRef.current === requestToken && !spin3dStateRef.current) {
        setStatus(`Generating 3D conformer… still working (${molecule.atoms.length} atoms — large structures can take a few seconds)`);
      }
    }, 2000);
    const clearSlowTimer = (): void => window.clearTimeout(slowTimer);

    // Stage 1 — the embedded conformer is fully manipulable; the overlay goes up NOW.
    const handleEmbedded = (conformer: Generate3DConformerResult): void => {
      clearSlowTimer();
      spin3dPendingRef.current = undefined;
      traceInfo("spin.embedded-callback", {
        atomCount: conformer.originalAtomCount,
        warningCount: conformer.warnings.length,
        message: conformer.embed.status
      });
      if (conformer.embed.status !== "ok") {
        setStatus(`Could not generate a 3D conformer: ${conformer.embed.failureReason ?? "unknown"}`);
        return;
      }
      // Spin may only begin if the molecule is still selected and unchanged.
      if (documentRef.current.pages[0]?.objects.find((object) => object.id === objectId) !== molecule) {
        traceInfo("spin.cancelled", { message: "selection changed" });
        setStatus("Selection changed; spin cancelled");
        return;
      }
      const coords3d = conformer.mapping.coords3dByOriginalAtom;
      const { bondPairs, bondRender, atomLabels, atoms, placement } = spinPlacementFor(molecule, coords3d);
      applySpin({
        objectId,
        // Open at a readable angle (principal plane toward the viewer + gentle tilt),
        // not the engine's arbitrary — often edge-on — embedding orientation.
        quat: initialViewQuaternion(coords3d),
        coords3d,
        bondPairs,
        bondRender,
        atomLabels,
        atoms,
        placement,
        selectionBox: { x: molecule.x, y: molecule.y, width: molecule.width, height: molecule.height },
        dragging: false
      });
      setStatus("Spin 3D: drag the molecule to rotate · click outside to flatten · Esc to cancel");
    };

    // Stage 2 — force-field-refined coordinates hot-swap under the live overlay,
    // preserving the user's current rotation. Ignored once the spin session ended.
    const handleRefined = (conformer: Generate3DConformerResult): void => {
      if (spin3dRequestRef.current !== requestToken) return;
      const state = spin3dStateRef.current;
      if (!state || state.objectId !== objectId) return;
      traceInfo("spin.refined-callback", {
        atomCount: conformer.originalAtomCount,
        warningCount: conformer.warnings.length,
        message: conformer.forceField?.status
      });
      const coords3d = conformer.mapping.coords3dByOriginalAtom;
      const { bondPairs, bondRender, atomLabels, placement } = spinPlacementFor(molecule, coords3d);
      applySpin({ ...state, coords3d, bondPairs, bondRender, atomLabels, placement });
    };

    const runInPage = async (): Promise<void> => {
      const path: Spin3dTracePath = "in-page";
      try {
        const importSpan = startSpin3dTraceSpan({
          sessionId,
          requestId: requestToken,
          kind: "spin",
          stage: "fallback.import",
          path
        }, emitTrace);
        const ocl = await import("@chemdraft/ocl-adapter");
        const { oclResourcesUrl } = await import("./oclResources");
        ocl.setOclResourcesUrl(oclResourcesUrl);
        importSpan.complete();
        const generateSpan = startSpin3dTraceSpan({
          sessionId,
          requestId: requestToken,
          kind: "spin",
          stage: "fallback.generate",
          path,
          atomCount: molecule.atoms.length
        }, emitTrace);
        const { embedded, refine } = await ocl.withOclConformerTrace(
          (event) => emitTrace(createSpin3dTraceEventFromOcl(event, { sessionId, requestId: requestToken, path })),
          () => ocl.generate3DConformerProgressive(
            { molfile, originalAtomCount: molecule.atoms.length },
            { optimize: "auto", maxMinimiseIterations: 800 }
          )
        );
        generateSpan.complete({ warningCount: embedded.warnings.length });
        if (spin3dRequestRef.current !== requestToken) return;
        handleEmbedded(embedded);
        if (embedded.embed.status !== "ok" || !refine) return;
        // Let the overlay paint before the synchronous minimise blocks this thread.
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (spin3dRequestRef.current !== requestToken) return;
        const refineSpan = startSpin3dTraceSpan({
          sessionId,
          requestId: requestToken,
          kind: "spin",
          stage: "fallback.refine",
          path,
          atomCount: molecule.atoms.length
        }, emitTrace);
        const refined = await ocl.withOclConformerTrace(
          (event) => emitTrace(createSpin3dTraceEventFromOcl(event, { sessionId, requestId: requestToken, path })),
          async () => refine()
        );
        refineSpan.complete({ warningCount: refined.warnings.length });
        handleRefined(refined);
      } catch (error) {
        clearSlowTimer();
        traceInfo("fallback.error", {
          status: "failed",
          path,
          error: (error as Error).message
        });
        setStatus(`3D spin unavailable: ${(error as Error).message}`);
      }
    };

    const client = getConformerWorkerClient();
    if (client) {
      traceInfo("worker.client", { path: "worker", message: "available" });
      let retriedAfterCrash = false;
      const dispatch = (): void => {
        const cancel = client.generate(molfile, molecule.atoms.length, {
          onEmbedded: (result) => {
            if (spin3dRequestRef.current === requestToken) handleEmbedded(result);
          },
          onRefined: handleRefined,
          onError: (message, info) => {
            if (spin3dRequestRef.current !== requestToken) return;
            clearSlowTimer();
            spin3dPendingRef.current = undefined;
            if (info?.workerCrashed && !retriedAfterCrash) {
              // The client recreated the worker — retry once, transparently.
              retriedAfterCrash = true;
              traceInfo("worker.retry", { path: "worker", message });
              dispatch();
              return;
            }
            traceInfo("worker.error", { path: "worker", status: "failed", error: message });
            if (info?.workerCrashed && molecule.atoms.length <= SPIN_IN_PAGE_MAX_ATOMS) {
              // Worker is gone for good — small structures may fall back to the
              // in-page engine; large ones must NOT (it freezes the whole UI).
              void runInPage();
              return;
            }
            setStatus(`Could not generate a 3D conformer: ${message}`);
          }
        }, { sessionId });
        spin3dPendingRef.current = { molfile, objectId, cancel };
      };
      dispatch();
      return;
    }
    traceInfo("worker.client", { message: "unavailable" });
    if (molecule.atoms.length > SPIN_IN_PAGE_MAX_ATOMS) {
      clearSlowTimer();
      setStatus("Spin 3D is unavailable for structures this large without background worker support");
      return;
    }
    await runInPage();
  }, [applySpin, selectedNativeMoleculePart, spinPlacementFor]);

  // Warm the conformer worker (OCL module + torsion resources + JIT) at app idle so
  // the first spin click never pays the ~2s cold-start.
  useEffect(() => {
    const timer = setTimeout(() => getConformerWorkerClient()?.warmup({ sessionId: `warmup:${Date.now()}` }), 1500);
    return () => clearTimeout(timer);
  }, []);

  // Speculatively generate the conformer when a single eligible molecule is selected:
  // by the time the user reaches the Spin 3D button the result is usually cached.
  const lastSpinPrefetchRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (spin3dState) return;
    const selectedIds = [
      ...new Set([
        ...document.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];
    if (selectedIds.length !== 1) return;
    const molecule = document.pages[0]?.objects.find(
      (object): object is MoleculeObject => object.id === selectedIds[0] && object.type === "molecule"
    );
    if (!molecule || !isNativeMoleculeGraph(molecule) || molecule.atoms.length < 2) return;
    if (molecule.atoms.length > SPIN_PREFETCH_MAX_ATOMS) {
      // Speculative embeds on large structures occupy the worker for seconds and
      // make an actual click feel hung behind them. Compute these on demand only.
      broadcastSpin3dTraceEvent(createSpin3dTraceEvent({
        sessionId: `prefetch:${molecule.id}`,
        kind: "spin",
        stage: "prefetch.skip-large",
        status: "info",
        atomCount: molecule.atoms.length
      }));
      return;
    }
    const timer = setTimeout(() => {
      const client = getConformerWorkerClient();
      if (!client) return;
      const molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true });
      if (lastSpinPrefetchRef.current === molfile) return;
      lastSpinPrefetchRef.current = molfile;
      client.warmup({ sessionId: `warmup:${Date.now()}` });
      client.prefetch(molfile, molecule.atoms.length, { sessionId: `prefetch:${molecule.id}:${Date.now()}` });
    }, 250);
    return () => clearTimeout(timer);
  }, [document, selectedNativeMoleculePart, spin3dState]);

  const handleSpinOverlayPointerDown = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const state = spin3dStateRef.current;
    if (!state) return;
    event.preventDefault();
    event.stopPropagation();
    // Map the click to page coordinates (the overlay's viewBox spans the page).
    const rect = event.currentTarget.getBoundingClientRect();
    const page = documentRef.current.pages[0];
    const pageX = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * page.width : 0;
    const pageY = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * page.height : 0;
    const box = state.selectionBox;
    const pad = 14;
    const insideBox =
      pageX >= box.x - pad &&
      pageX <= box.x + box.width + pad &&
      pageY >= box.y - pad &&
      pageY <= box.y + box.height + pad;
    if (!insideBox) {
      // Click outside the selection box commits the current orientation.
      commitSpinFlatten();
      return;
    }
    // Inside the box: grab to rotate. Capture is best-effort.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore — pointer capture is an enhancement, not a requirement */
    }
    applySpin({ ...state, dragging: true, lastClient: { x: event.clientX, y: event.clientY } });
  }, [applySpin, commitSpinFlatten]);

  const handleSpinOverlayPointerMove = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const state = spin3dStateRef.current;
    if (!state || !state.dragging || !state.lastClient) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    // The overlay SVG fills the page area with viewBox "0 0 pageWidth pageHeight", so a
    // document-space point maps to client pixels by the page zoom (rect size / page size).
    // Pivot the trackball at the molecule's screen centroid (placement.center) — NOT the
    // page-spanning overlay's geometric center. A molecule drawn away from page center
    // would otherwise rotate about the wrong point and the grabbed atom slides off-cursor.
    const page = documentRef.current.pages[0];
    const scaleX = page && page.width > 0 ? rect.width / page.width : 1;
    const scaleY = page && page.height > 0 ? rect.height / page.height : 1;
    const trackball = {
      center: {
        x: rect.left + state.placement.centerX * scaleX,
        y: rect.top + state.placement.centerY * scaleY
      },
      radius: Math.max(120, Math.min(rect.width, rect.height) * 0.4)
    };
    const current = { x: event.clientX, y: event.clientY };
    const quat = applyTrackballDrag(state.quat, state.lastClient, current, trackball);
    // Update ref synchronously so the next event has fresh state; schedule a single
    // rAF to push to React. If one is already pending it will pick up this latest
    // state — no need to schedule another.
    spin3dStateRef.current = { ...state, quat, lastClient: current };
    spinDirtyRef.current = true;
    if (spinRafRef.current === null) {
      spinRafRef.current = requestAnimationFrame(() => {
        spinRafRef.current = null;
        if (spinDirtyRef.current) {
          spinDirtyRef.current = false;
          const s = spin3dStateRef.current;
          if (s) setSpin3dStateRender({ ...s });
        }
      });
    }
  }, []);

  const handleSpinOverlayPointerUp = useCallback((event: PointerEvent<SVGSVGElement>) => {
    const state = spin3dStateRef.current;
    if (!state) return;
    event.preventDefault();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* ignore */
    }
    // Releasing ends the rotation but STAYS in spin mode — grab inside the box again
    // to keep rotating, or click outside to flatten (handled in pointer-down). Esc cancels.
    if (state.dragging) {
      applySpin({ ...state, dragging: false, lastClient: undefined });
    }
  }, [applySpin]);

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

  const resetPasteUiState = useCallback((editTextObjectId?: string) => {
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(editTextObjectId);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
  }, [assignHoveredNativeDeleteTarget]);

  const applySyncClipboardPayload = useCallback((detectedPayload: ClipboardDetectedPayload) => {
    const result = applyClipboardPastePayload(
      documentRef.current,
      detectedPayload,
      pastePointForViewport(),
      textStyleDefaults
    );
    if (result.document !== documentRef.current) {
      commitDocumentChange(result.document);
    }
    resetPasteUiState(result.editTextObjectId);
    setStatus(result.status);
  }, [commitDocumentChange, pastePointForViewport, resetPasteUiState, textStyleDefaults]);

  // SMILES → editable 2D structure with stereochemistry. Async because the OCL engine
  // is dynamically imported (kept out of the static/test graph). Returns false when the
  // text isn't a parseable SMILES, so callers can fall back to pasting it as plain text.
  const renderPastedSmiles = useCallback(async (smilesText: string): Promise<boolean> => {
    try {
      const ocl = await import("@chemdraft/ocl-adapter");
      const depiction = ocl.depictSmiles2D(smilesText);
      if (depiction.atoms.length === 0) {
        return false;
      }
      const nextDocument = insertSmilesMolecule(
        documentRef.current,
        pastePointForViewport(),
        {
          atoms: depiction.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, charge: atom.charge })),
          bonds: depiction.bonds.map((bond) => ({
            from: bond.from,
            to: bond.to,
            order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
            wedge: bond.wedge
          }))
        },
        smilesText
      );
      commitDocumentChange(nextDocument);
      resetPasteUiState();
      const stereoCount = depiction.bonds.filter((bond) => bond.wedge).length;
      setStatus(
        `Pasted SMILES structure — ${depiction.atoms.length} atoms${stereoCount ? `, ${stereoCount} stereo bond${stereoCount === 1 ? "" : "s"}` : ""}`
      );
      return true;
    } catch {
      return false;
    }
  }, [commitDocumentChange, pastePointForViewport, resetPasteUiState]);

  const applyDetectedClipboardPayload = useCallback((detectedPayload: ClipboardDetectedPayload) => {
    if (detectedPayload.kind === "smiles") {
      void renderPastedSmiles(detectedPayload.text).then((rendered) => {
        if (!rendered) {
          applySyncClipboardPayload({ kind: "plain-text", text: detectedPayload.text, sourceType: detectedPayload.sourceType, warnings: [] });
          setStatus("Clipboard SMILES could not be parsed; pasted as text");
        }
      });
      return;
    }
    if (detectedPayload.kind === "inchi") {
      applySyncClipboardPayload({ kind: "plain-text", text: detectedPayload.text, sourceType: detectedPayload.sourceType, warnings: [] });
      setStatus("InChI detected — structure import from InChI isn't supported yet; pasted as text");
      return;
    }
    // Plain text that looks like a SMILES: confirm with the engine, else paste as text.
    if (detectedPayload.kind === "plain-text" && looksLikeSmiles(detectedPayload.text)) {
      void renderPastedSmiles(detectedPayload.text).then((rendered) => {
        if (!rendered) {
          applySyncClipboardPayload(detectedPayload);
        }
      });
      return;
    }
    applySyncClipboardPayload(detectedPayload);
  }, [applySyncClipboardPayload, renderPastedSmiles]);

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

        if (tool.id === structureSpin3dCommandId) {
          void startSpin3d();
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
        if (action.id === SPIN3D_DEBUGGER_COMMAND_ID) {
          void toggleSpin3dDebuggerWindow().catch(() => {
            setStatus("3D debugger unavailable");
          });
          return;
        }

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
    applyTextStyleCommand,
    assignHoveredNativeDeleteTarget,
    chemistryAdapter,
    cleanUpSelectedStructure3d,
    cleanUpSelectedStructure,
    startSpin3d,
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

  const invoke = useCallback(async (commandId: string) => {
    if (applyTextStyleCommand(commandId)) {
      return;
    }

    void registry.invoke(commandId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Command failed: ${message}`);
    });
  }, [applyTextStyleCommand, registry]);

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
    if (!moleculeResizeInput) {
      return;
    }

    const stillSelected =
      document.selection.objectIds.includes(moleculeResizeInput.objectId) ||
      selectedNativeMoleculePart?.objectId === moleculeResizeInput.objectId;
    if (!stillSelected) {
      updateMoleculeResizeInput(undefined);
    }
  }, [document.selection.objectIds, moleculeResizeInput, selectedNativeMoleculePart, updateMoleculeResizeInput]);

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

      // In the browser, let Cmd/Ctrl+V fall through to the native `paste` event
      // (handlePaste reads event.clipboardData synchronously — the reliable,
      // permission-free path). Intercepting it here and reading the async
      // navigator.clipboard.readText() instead is fragile: it needs document
      // focus + a clipboard-read permission and is blocked outright in Safari.
      // The desktop (Tauri) runtime has no browser paste event, so it keeps
      // routing Cmd+V through the command (→ Tauri clipboard invoke).
      if (commandId === "clipboard.paste" && !isDesktopRuntime()) {
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

  // Esc cancels an active 3D spin (transient; never touched the document) — or,
  // before the overlay is up, abandons the in-flight conformer generation.
  useEffect(() => {
    const handleSpinEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (spin3dStateRef.current) {
        event.preventDefault();
        event.stopPropagation();
        endSpin3d("Spin cancelled");
        return;
      }
      const pendingSpin = spin3dPendingRef.current;
      if (pendingSpin) {
        event.preventDefault();
        event.stopPropagation();
        pendingSpin.cancel();
        spin3dPendingRef.current = undefined;
        spin3dRequestRef.current += 1; // invalidate late results from the dropped job
        setStatus("3D generation cancelled");
      }
    };
    window.addEventListener("keydown", handleSpinEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleSpinEscape, { capture: true });
  }, [endSpin3d]);

  useEffect(() => {
    if (!nativePalette) {
      return;
    }

    void listToolsetWindowStates()
      .then((states) => {
        setVisibleToolsetIds(new Set(
          states
            .filter((state) => state.open && toolsetRegistry.get(state.toolsetId))
            .map((state) => state.toolsetId)
        ));
      })
      .catch(() => {
        setVisibleToolsetIds(new Set());
        setStatus("Native toolset windows unavailable");
      });
  }, [nativePalette, toolsetRegistry]);

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
    const tiltDelta = projectedPlaneTiltVectorFromDrag(drag.startPoint, point);
    const tiltXRad = drag.startTiltXRad + tiltDelta.xRad;
    const tiltYRad = drag.startTiltYRad + tiltDelta.yRad;
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
    if (object?.type !== "molecule" || !isNativeMoleculeGraph(object)) {
      return undefined;
    }

    if (input.kind === "z") {
      const zDegrees = parseRotationInputDegrees(input.draftZDegrees);
      if (zDegrees === undefined) {
        return undefined;
      }

      const nextDocument = input.target
        ? rotateNativeMoleculeParts(input.startDocument, input.target, zDegrees)
        : rotateDocumentObject(
            input.startDocument,
            input.objectId,
            manualRotationDeltaDegrees(nativeMoleculeTransformState(object).rotationDegrees, zDegrees)
          );
      return { kind: "z", document: nextDocument, zDegrees };
    }

    const xDegrees = parseRotationInputDegrees(input.draftXDegrees);
    const yDegrees = parseRotationInputDegrees(input.draftYDegrees);
    if (xDegrees === undefined || yDegrees === undefined) {
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
      ? { ...input, draftZDegrees: input.homeZDegrees }
      : { ...input, draftXDegrees: "0", draftYDegrees: "0" };
    if (nextInput.kind === "xy") {
      handleRotationInputChange(nextInput);
      setStatus("X/Y rotation set to 0");
      return;
    }

    replacePresentDocument(input.startDocument);
    updateRotationInput(nextInput);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    setStatus("Rotation restored home");
  }, [handleRotationInputChange, replacePresentDocument, updateRotationInput]);

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

  const showMoleculeResizeReadout = useCallback((objectId: string, scale: MoleculeResizeScale, hold = false) => {
    if (moleculeResizeReadoutTimeoutRef.current !== undefined) {
      window.clearTimeout(moleculeResizeReadoutTimeoutRef.current);
      moleculeResizeReadoutTimeoutRef.current = undefined;
    }

    setMoleculeResizeReadout({
      objectId,
      scaleXPercent: moleculeResizeReadoutPercent(scale.x),
      scaleYPercent: moleculeResizeReadoutPercent(scale.y)
    });

    if (hold) {
      moleculeResizeReadoutTimeoutRef.current = window.setTimeout(() => {
        moleculeResizeReadoutTimeoutRef.current = undefined;
        setMoleculeResizeReadout(undefined);
      }, 1200);
    }
  }, []);

  const moleculeResizeInputDocumentFromDraft = useCallback((input: MoleculeResizeInputState) => {
    const object = findDocumentObject(input.startDocument, input.objectId);
    if (object?.type !== "molecule" || !isNativeMoleculeGraph(object)) {
      return undefined;
    }

    const xPercent = parseMoleculeResizeInputPercent(input.draftXPercent);
    const yPercent = parseMoleculeResizeInputPercent(input.draftYPercent);
    if (xPercent === undefined || yPercent === undefined) {
      return undefined;
    }

    const targetScale = {
      x: xPercent / 100,
      y: yPercent / 100
    };
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

  const handleMoleculeResizeInputChange = useCallback((nextInput: MoleculeResizeInputState) => {
    updateMoleculeResizeInput(nextInput);
    const result = moleculeResizeInputDocumentFromDraft(nextInput);
    if (!result) {
      setStatus("Enter valid X and Y stretch percentages");
      return;
    }

    replacePresentDocument(result.document);
    showMoleculeResizeReadout(nextInput.objectId, result.targetScale, false);
  }, [moleculeResizeInputDocumentFromDraft, replacePresentDocument, showMoleculeResizeReadout, updateMoleculeResizeInput]);

  const handleMoleculeResizeInputHome = useCallback((input: MoleculeResizeInputState) => {
    replacePresentDocument(input.startDocument);
    updateMoleculeResizeInput({
      ...input,
      draftXPercent: input.homeXPercent,
      draftYPercent: input.homeYPercent
    });
    setMoleculeResizeReadout(undefined);
    setStatus("Stretch restored home");
  }, [replacePresentDocument, updateMoleculeResizeInput]);

  const handleMoleculeResizeInputCancel = useCallback((input?: MoleculeResizeInputState) => {
    const session = input ?? moleculeResizeInputRef.current;
    if (session) {
      replacePresentDocument(session.startDocument);
    }
    updateMoleculeResizeInput(undefined);
    setMoleculeResizeReadout(undefined);
    setStatus("Stretch entry canceled");
  }, [replacePresentDocument, updateMoleculeResizeInput]);

  const handleMoleculeResizeInputKeep = useCallback((input?: MoleculeResizeInputState) => {
    const session = input ?? moleculeResizeInputRef.current;
    if (!session) {
      return false;
    }

    const changed = commitLiveInputPreview(session.startDocument);
    updateMoleculeResizeInput(undefined);
    setMoleculeResizeReadout(undefined);
    setStatus(changed ? "Stretch applied" : "Stretch unchanged");
    return changed;
  }, [commitLiveInputPreview, updateMoleculeResizeInput]);

  // Clears the transient interaction "chrome" — open editors, hover highlights, and in-flight
  // previews — without touching the selection. Numeric transform sessions are first kept as
  // one undoable change so clicking elsewhere on the viewport preserves the live-preview values.
  const clearTransientInteractionChrome = useCallback(() => {
    handleRotationInputKeep();
    handleMoleculeResizeInputKeep();
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, [
    assignHoveredNativeDeleteTarget,
    handleMoleculeResizeInputKeep,
    handleRotationInputKeep
  ]);

  const moleculeResizeDocumentFromDrag = useCallback((
    drag: MoleculeResizeDragState,
    point: ClientPoint,
    stretching: boolean
  ): ChemDraftDocument => {
    const scale = moleculeResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, stretching);
    return drag.target
      ? resizeNativeMoleculeParts(drag.startDocument, drag.target, scale)
      : resizeNativeMoleculeObject(drag.startDocument, drag.objectId, scale);
  }, []);

  const previewMoleculeResize = useCallback((drag: MoleculeResizeDragState, point: ClientPoint, stretching: boolean) => {
    drag.latestPoint = point;
    drag.stretching = stretching;
    drag.latestScale = moleculeResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, stretching);
    drag.latestCumulativeScale = cumulativeMoleculeResizeScale(drag.startCumulativeScale, drag.latestScale);
    showMoleculeResizeReadout(drag.objectId, drag.latestCumulativeScale);
    replacePresentDocument(moleculeResizeDocumentFromDrag(drag, point, stretching));
  }, [moleculeResizeDocumentFromDrag, replacePresentDocument, showMoleculeResizeReadout]);

  const commitMoleculeResize = useCallback((drag: MoleculeResizeDragState, point: ClientPoint): boolean => {
    drag.latestScale = moleculeResizeScaleFromDrag(drag.centerPoint, drag.startPoint, point, drag.stretching);
    drag.latestCumulativeScale = cumulativeMoleculeResizeScale(drag.startCumulativeScale, drag.latestScale);
    const resized = moleculeResizeDocumentFromDrag(drag, point, drag.stretching);
    showMoleculeResizeReadout(drag.objectId, drag.latestCumulativeScale, true);
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
  }, [installDocumentHistory, moleculeResizeDocumentFromDrag, replacePresentDocument, showMoleculeResizeReadout]);

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

  const clearMoleculeResizeDrag = useCallback((event: ObjectPointerEvent) => {
    const drag = moleculeResizeDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      moleculeResizeDragRef.current = null;
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
    const scale = moleculeResizeScaleFromDrag(drag.center, drag.startPoint, point, stretch);
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
  const handleGroupResizePointerDown = useCallback((_corner: MoleculeResizeCorner) =>
    (event: PointerEvent<HTMLButtonElement>) => handleGroupTransformPointerDown("resize", event),
  [handleGroupTransformPointerDown]);

  const startLassoSelection = useCallback((event: ObjectPointerEvent, point: ClientPoint) => {
    event.preventDefault();
    event.stopPropagation();
    selectionLassoRef.current = {
      pointerId: event.pointerId,
      startPoint: point,
      latestPoint: point,
      points: [point],
      dragging: false
    };
    lassoMachineRef.current = interactionReducer(initialInteractionState(), {
      type: "pointerDown",
      pointerId: event.pointerId,
      world: point,
      target: { kind: "empty" },
      dragKind: "marquee"
    });
    setSelectedNativeMoleculePart(undefined);
    clearTransientInteractionChrome();
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus("Lasso selection");
  }, [clearTransientInteractionChrome]);

  const handlePagePointerDown = useCallback((event: ObjectPointerEvent) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    setObjectContextMenu(undefined);
    const point = pagePointFromPointerEvent(event);
    if (!point) {
      return;
    }

    if (activeToolState.activeCommandId === "tool.lasso") {
      startLassoSelection(event, point);
      return;
    }

    if (activeToolState.activeCommandId === "tool.eraser") {
      event.preventDefault();
      event.stopPropagation();
      setStatus("Nothing to erase");
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
    activeToolState.activeCommandId,
    applyChargeDocumentAtPoint,
    applyNativeTemplateDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    applyTextDocumentAtPoint,
    document,
    pagePointFromPointerEvent,
    startLassoSelection,
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

    const moleculeResizeDrag = moleculeResizeDragRef.current;
    if (moleculeResizeDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      moleculeResizeDrag.latestPoint = point;
      if (!moleculeResizeDrag.dragging && clientPointDistance(moleculeResizeDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        moleculeResizeDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        if (!moleculeResizeDrag.target) {
          setSelectedNativeMoleculePart(undefined);
        }
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (moleculeResizeDrag.dragging) {
        previewMoleculeResize(moleculeResizeDrag, point, event.shiftKey);
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

    const lasso = selectionLassoRef.current;
    if (lasso?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      lasso.latestPoint = point;
      lassoMachineRef.current = interactionReducer(lassoMachineRef.current, {
        type: "pointerMove",
        pointerId: event.pointerId,
        world: point,
        target: { kind: "empty" }
      });
      lasso.dragging = lassoMachineRef.current.phase === "dragging";
      const lastPoint = lasso.points.at(-1) ?? lasso.startPoint;
      if (lasso.dragging && clientPointDistance(lastPoint, point) >= LASSO_POINT_SPACING) {
        lasso.points = [...lasso.points, point];
      }
      setSelectionLasso(lasso.dragging ? { ...lasso, points: [...lasso.points] } : undefined);
      return;
    }

    updateNativeCanvasHover(document, pagePointFromPointerEvent(event), event.target);
  }, [
    document,
    groupProjectedPlaneTiltFromDrag,
    groupTransformDocument,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
    previewProjectedPlaneTilt,
    previewMoleculeResize,
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
        const label = object?.type === "text"
          ? "text box"
          : objectRotateDrag.target ? "selected molecule fragment" : "selected molecule";
        setStatus(changed ? `Rotated ${label}` : `${capitalizeLabel(label)} rotation unchanged`);
      }
      clearObjectRotateDrag(event);
      return;
    }

    const moleculeResizeDrag = moleculeResizeDragRef.current;
    if (moleculeResizeDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? moleculeResizeDrag.latestPoint;
      if (moleculeResizeDrag.dragging) {
        moleculeResizeDrag.latestScale = moleculeResizeScaleFromDrag(
          moleculeResizeDrag.centerPoint,
          moleculeResizeDrag.startPoint,
          point,
          moleculeResizeDrag.stretching
        );
        const changed = commitMoleculeResize(moleculeResizeDrag, point);
        const targetLabel = moleculeResizeDrag.target ? "selected molecule fragment" : "selected molecule";
        setStatus(changed
          ? moleculeResizeDrag.stretching ? `Stretched ${targetLabel}` : `Resized ${targetLabel}`
          : `${capitalizeLabel(targetLabel)} size unchanged`);
      }
      clearMoleculeResizeDrag(event);
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
    if (marquee?.pointerId === event.pointerId) {
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
      return;
    }

    const lasso = selectionLassoRef.current;
    if (!lasso || lasso.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    const lassoPoint = pagePointFromPointerEvent(event) ?? lasso.latestPoint;
    lasso.latestPoint = lassoPoint;
    const wasLassoDragging = lassoMachineRef.current.phase === "dragging";
    const points = [...lasso.points, lassoPoint];
    const lassoSelection = wasLassoDragging && points.length >= 3
      ? selectionInSelectionPolygon(document.pages[0].objects, points)
      : { objectIds: [], nativeSelection: undefined };
    replacePresentDocument((current) => selectDocumentObjects(current, current.pages[0].id, lassoSelection.objectIds));
    setSelectedNativeMoleculePart(lassoSelection.nativeSelection);
    if (lassoSelection.objectIds.length === 0 && !lassoSelection.nativeSelection) {
      toolbarStyleTargetRef.current = undefined;
    }
    setSelectionLasso(undefined);
    selectionLassoRef.current = null;
    lassoMachineRef.current = initialInteractionState();
    // A lasso is a one-shot selection gesture. The resize/rotate transform box only
    // renders under the select tool, so once the lasso has caught something, hand off
    // to the select tool — otherwise the selection sits there with no way to manipulate
    // it (the bug: "no bounding box in lasso mode"). Empty lassos stay in lasso mode.
    if (lassoSelection.objectIds.length > 0 || lassoSelection.nativeSelection) {
      const selectToolState = createActiveToolState("tool.select");
      activeToolCommandIdRef.current = selectToolState.activeCommandId;
      setActiveToolState(selectToolState);
      void broadcastToolsetActiveTool(selectToolState.activeCommandId).catch(() => undefined);
    }
    setStatus(selectionStatusLabel(lassoSelection));
    const captureTarget = pageRef.current ?? event.currentTarget;
    if (captureTarget.hasPointerCapture(event.pointerId)) {
      captureTarget.releasePointerCapture(event.pointerId);
    }
  }, [
    activeToolState.activeKind,
    clearNativePartDrag,
    clearObjectDrag,
    clearObjectRotateDrag,
    clearProjectedPlaneTiltDrag,
    clearNativePlacementDrag,
    clearTextResize,
    commitNativePlacementDrag,
    commitNativePartDrag,
    commitTextResize,
    commitObjectDrag,
    commitObjectRotateDrag,
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

    const lasso = selectionLassoRef.current;
    if (lasso?.pointerId === event.pointerId) {
      lassoMachineRef.current = initialInteractionState();
      selectionLassoRef.current = null;
      setSelectionLasso(undefined);
      const captureTarget = pageRef.current ?? event.currentTarget;
      if (captureTarget.hasPointerCapture(event.pointerId)) {
        captureTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, [clearNativePartDrag, clearNativePlacementDrag, clearObjectRotateDrag, clearProjectedPlaneTiltDrag, clearTextResize, replacePresentDocument]);

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

    if (selectionLassoRef.current) {
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

    const object = findDocumentObject(document, objectId);
    const chargeMarkActive = object?.type === "electron-mark" && object.markKind === "charge";
    const nativeMoleculeHit = object?.type === "molecule" && point
      ? nativeMoleculeHitFromPointerTarget(
          object,
          point,
          event.target,
          hitToleranceForScale(viewportRef.current.scale)
        )
      : undefined;

    if (activeToolState.activeCommandId === "tool.lasso" && point) {
      startLassoSelection(event, point);
      return;
    }

    if (activeToolState.activeCommandId === "tool.eraser") {
      event.preventDefault();
      event.stopPropagation();
      const nativeTarget = object?.type === "molecule" && nativeMoleculeHit
        ? { objectId, ...nativeMoleculeHit }
        : undefined;
      if (object?.type === "molecule" && !nativeTarget) {
        setStatus("No atom or bond to erase");
        return;
      }
      eraseDocumentObjectTarget(object, nativeTarget);
      return;
    }

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
    eraseDocumentObjectTarget,
    pagePointFromPointerEvent,
    replacePresentDocument,
    restoreToolAfterTextPlacement,
    selectedNativeMoleculePart,
    startAtomLabelEdit,
    startLassoSelection
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

    const object = findDocumentObject(document, objectId);
    const selectedFragmentTarget = object?.type === "molecule" && selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    if (
      object?.type !== "molecule" ||
      !isNativeMoleculeGraph(object) ||
      (
        !isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart) &&
        selectedFragmentBounds === undefined
      )
    ) {
      setStatus("Select a molecule or molecule fragment for rotation entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const transform = nativeMoleculeTransformState(object);
    const targetLabel = selectedFragmentTarget ? "selected molecule fragment" : "selected molecule";
    const homeZDegrees = rotationInputDraftDegrees(transform.rotationDegrees);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    updateMoleculeResizeInput(undefined);
    updateRotationInput({
      kind: "z",
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      startDocument: document,
      draftZDegrees: homeZDegrees,
      homeZDegrees
    });
    setStatus("Z rotation entry");
    return true;
  }, [activeToolState.activeKind, document, selectedNativeMoleculePart, updateMoleculeResizeInput, updateRotationInput]);

  const handleObjectRotatePointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const object = findDocumentObject(document, objectId);
    if (object?.type === "molecule" && isTransformHandleSecondPress(objectId, "rotate-z", event)) {
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
      (object?.type === "molecule" && (
        isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart) ||
        selectedFragmentBounds !== undefined
      ));
    if (!object || !point || !canRotateObject) {
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? document
      : document.selection.objectIds.includes(objectId)
        ? document
        : selectDocumentObject(document, objectId);
    handleRotationInputKeep();
    handleMoleculeResizeInputKeep();
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
        : selectedFragmentTarget ? "Rotate selected molecule fragment" : "Rotate selected molecule"
    );
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    document,
    handleMoleculeResizeInputKeep,
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

    const object = findDocumentObject(document, objectId);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    if (
      object?.type !== "molecule" ||
      !isNativeMoleculeGraph(object) ||
      (
        !isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart) &&
        selectedFragmentBounds === undefined
      )
    ) {
      setStatus("Select a molecule or molecule fragment for 3D rotation entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const transform = nativeMoleculeTransformState(object);
    const targetLabel = selectedFragmentTarget ? "selected molecule fragment" : "selected molecule";
    const homeXDegrees = rotationInputDraftDegrees(selectedFragmentTarget ? 0 : transform.tiltXDegrees ?? 0);
    const homeYDegrees = rotationInputDraftDegrees(selectedFragmentTarget ? 0 : transform.tiltYDegrees ?? 0);
    setObjectRotateReadout(undefined);
    setProjectedPlaneTiltReadout(undefined);
    updateMoleculeResizeInput(undefined);
    updateRotationInput({
      kind: "xy",
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      startDocument: document,
      draftXDegrees: homeXDegrees,
      draftYDegrees: homeYDegrees,
      homeXDegrees,
      homeYDegrees
    });
    setStatus("3D rotation entry");
    return true;
  }, [activeToolState.activeKind, document, selectedNativeMoleculePart, updateMoleculeResizeInput, updateRotationInput]);

  const handleProjectedPlaneTiltPointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const object = findDocumentObject(document, objectId);
    if (object?.type === "molecule" && isTransformHandleSecondPress(objectId, "rotate-xy", event)) {
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
    if (
      object?.type !== "molecule" ||
      !isNativeMoleculeGraph(object) ||
      object.atoms.length === 0 ||
      !point ||
      (
        !isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart) &&
        selectedFragmentBounds === undefined
      )
    ) {
      setStatus("Select a molecule or molecule fragment for 3D rotate");
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? document
      : document.selection.objectIds.includes(objectId)
        ? document
        : selectDocumentObject(document, objectId);
    handleRotationInputKeep();
    handleMoleculeResizeInputKeep();
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
    const transform = nativeMoleculeTransformState(object);
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
      centerPoint: selectedFragmentBounds ? documentObjectCenter(selectedFragmentBounds) : nativeMoleculeCenter(object),
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
    setStatus(selectedFragmentTarget ? "3D rotate: drag to tilt/twist selected fragment" : "3D rotate: drag to tilt/twist");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    document,
    handleMoleculeResizeInputKeep,
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

  const openMoleculeResizeInput = useCallback((objectId: string, corner: MoleculeResizeCorner): boolean => {
    if (activeToolState.activeKind !== "selection") {
      return false;
    }

    const object = findDocumentObject(document, objectId);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    if (
      object?.type !== "molecule" ||
      !isNativeMoleculeGraph(object) ||
      (
        !isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart) &&
        selectedFragmentBounds === undefined
      )
    ) {
      setStatus("Select a molecule or molecule fragment for stretch entry");
      return false;
    }
    if (selectedFragmentTarget) {
      setStatus("Double-click entry is available for whole molecules only");
      return false;
    }

    const transform = nativeMoleculeTransformState(object);
    const targetLabel = selectedFragmentTarget ? "selected molecule fragment" : "selected molecule";
    const homeXPercent = moleculeResizeInputDraftPercent(selectedFragmentTarget ? 1 : transform.scaleX);
    const homeYPercent = moleculeResizeInputDraftPercent(selectedFragmentTarget ? 1 : transform.scaleY);
    updateRotationInput(undefined);
    setMoleculeResizeReadout(undefined);
    updateMoleculeResizeInput({
      objectId,
      target: selectedFragmentTarget,
      targetLabel,
      corner,
      startDocument: document,
      draftXPercent: homeXPercent,
      draftYPercent: homeYPercent,
      homeXPercent,
      homeYPercent
    });
    setStatus("Stretch entry");
    return true;
  }, [activeToolState.activeKind, document, selectedNativeMoleculePart, updateMoleculeResizeInput, updateRotationInput]);

  const handleMoleculeResizePointerDown = useCallback((
    objectId: string,
    corner: MoleculeResizeCorner,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const object = findDocumentObject(document, objectId);
    if (object?.type === "molecule" && isTransformHandleSecondPress(objectId, `resize-${corner}`, event)) {
      openMoleculeResizeInput(objectId, corner);
      return;
    }
    const point = pagePointFromPointerEvent(event);
    const selectedFragmentTarget = selectedNativeMoleculePart?.objectId === objectId
      ? selectedNativeMoleculePart
      : undefined;
    const selectedFragmentBounds = object?.type === "molecule" && selectedFragmentTarget
      ? nativeMoleculePartBounds(object, selectedFragmentTarget)
      : undefined;
    if (
      object?.type !== "molecule" ||
      object.atoms.length === 0 ||
      !point ||
      (
        !isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart) &&
        selectedFragmentBounds === undefined
      )
    ) {
      return;
    }

    const selectedDocument = selectedFragmentTarget
      ? document
      : document.selection.objectIds.includes(objectId)
        ? document
        : selectDocumentObject(document, objectId);
    handleRotationInputKeep();
    handleMoleculeResizeInputKeep();
    replacePresentDocument(selectedDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(selectedFragmentTarget);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    const transform = nativeMoleculeTransformState(object);
    const startCumulativeScale = selectedFragmentTarget
      ? { x: 1, y: 1 }
      : {
          x: transform.scaleX,
          y: transform.scaleY
        };
    moleculeResizeDragRef.current = {
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
    setStatus(selectedFragmentTarget ? "Resize selected molecule fragment" : "Resize selected molecule");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    document,
    handleMoleculeResizeInputKeep,
    handleRotationInputKeep,
    openMoleculeResizeInput,
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart,
  ]);

  const handleMoleculeResizeDoubleClick = useCallback((
    objectId: string,
    corner: MoleculeResizeCorner,
    event: ReactMouseEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openMoleculeResizeInput(objectId, corner);
  }, [openMoleculeResizeInput]);

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

    const moleculeResizeDrag = moleculeResizeDragRef.current;
    if (moleculeResizeDrag?.pointerId === event.pointerId && moleculeResizeDrag.objectId === objectId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      moleculeResizeDrag.latestPoint = point;
      if (!moleculeResizeDrag.dragging && clientPointDistance(moleculeResizeDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        moleculeResizeDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setSelectedNativeMoleculePart(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (moleculeResizeDrag.dragging) {
        previewMoleculeResize(moleculeResizeDrag, point, event.shiftKey);
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
    previewMoleculeResize,
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
        const label = object?.type === "text" ? "text box" : "selected molecule";
        setStatus(changed ? `Rotated ${label}` : `${capitalizeLabel(label)} rotation unchanged`);
      }
      clearObjectRotateDrag(event);
      return;
    }

    const moleculeResizeDrag = moleculeResizeDragRef.current;
    if (moleculeResizeDrag?.pointerId === event.pointerId && moleculeResizeDrag.objectId === objectId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? moleculeResizeDrag.latestPoint;
      if (moleculeResizeDrag.dragging) {
        moleculeResizeDrag.latestScale = moleculeResizeScaleFromDrag(
          moleculeResizeDrag.centerPoint,
          moleculeResizeDrag.startPoint,
          point,
          moleculeResizeDrag.stretching
        );
        const changed = commitMoleculeResize(moleculeResizeDrag, point);
        setStatus(changed
          ? moleculeResizeDrag.stretching ? "Stretched selected molecule" : "Resized selected molecule"
          : "Molecule size unchanged");
      }
      clearMoleculeResizeDrag(event);
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
    clearMoleculeResizeDrag,
    clearTextResize,
    commitNativeDoubleBondSideDrag,
    commitNativePartDrag,
    commitMoleculeResize,
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

    const moleculeResizeDrag = moleculeResizeDragRef.current;
    if (moleculeResizeDrag?.pointerId === event.pointerId && moleculeResizeDrag.dragging) {
      replacePresentDocument(moleculeResizeDrag.startDocument);
      setMoleculeResizeReadout(undefined);
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.dragging) {
      replacePresentDocument(objectDrag.startDocument);
    }
    clearNativePartDrag(event);
    clearObjectRotateDrag(event);
    clearMoleculeResizeDrag(event);
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
    clearMoleculeResizeDrag,
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
      objectRotateDragRef.current?.objectId === objectId ||
      moleculeResizeDragRef.current?.objectId === objectId
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

  const createAgentSnapshot = useCallback((): AgentSnapshot => {
    const currentDocument = documentRef.current;
    const page = currentDocument.pages[0];
    return {
      bridgeVersion: 1,
      build: `${CURRENT_BUILD_STAMP} · ${__BUILD_STAMP__}`,
      runtime: {
        desktop: nativePaletteRef.current,
        source: agentRuntimeSourceRef.current
      },
      document: currentDocument,
      activeToolCommandId: activeToolCommandIdRef.current,
      selection: currentDocument.selection,
      selectedNativeMoleculePart: selectedNativeMoleculePartRef.current,
      hoveredNativeTarget: hoveredNativeDeleteTargetRef.current,
      viewport: viewportRef.current,
      page: {
        id: page.id,
        width: page.width,
        height: page.height,
        objectCount: page.objects.length
      },
      file: {
        dirty: fileStateRef.current.dirty,
        path: fileStateRef.current.path
      },
      objects: page.objects.map(agentObjectSummary)
    };
  }, []);

  const resolveAgentPoint = useCallback((target: AgentPointTarget): AgentResolvedPoint => {
    const page = pageRef.current;
    if (!page) {
      throw new Error("ChemDraft page is not mounted.");
    }

    return resolveAgentPointInDocument(target, documentRef.current, page.getBoundingClientRect(), viewportRef.current.scale);
  }, []);

  const hitTestAgentPoint = useCallback((target: AgentPointTarget): AgentHitResult => {
    const point = resolveAgentPoint(target);
    return {
      point,
      target: nativeMoleculeCanvasHoverTarget(
        documentRef.current,
        point.page,
        undefined,
        hitToleranceForScale(viewportRef.current.scale)
      )
    };
  }, [resolveAgentPoint]);

  const dispatchAgentPointer = useCallback((
    type: AgentPointerEventType,
    target: AgentPointTarget,
    options?: AgentPointerOptions
  ) => {
    const page = pageRef.current;
    if (!page) {
      throw new Error("ChemDraft page is not mounted.");
    }

    return dispatchAgentPointerEvent({
      activePointerTargets: agentPointerTargetsRef.current,
      ownerDocument: page.ownerDocument,
      pageElement: page,
      resolvedPoint: resolveAgentPoint(target),
      type,
      options
    });
  }, [resolveAgentPoint]);

  const waitForAgentIdle = useCallback(async () => {
    await waitForAnimationFrames(2);
    return createAgentSnapshot();
  }, [createAgentSnapshot]);

  useEffect(() => {
    let disposed = false;
    let installedBridge: Window[typeof AGENT_BRIDGE_GLOBAL_NAME] | undefined;

    void resolveAgentBridgePermission().then((permission) => {
      agentRuntimeSourceRef.current = permission.source;
      if (disposed || !permission.enabled) {
        return;
      }

      installedBridge = createChemDraftAgentBridge({
        snapshot: createAgentSnapshot,
        command(commandId) {
          return invokeCommandRef.current(commandId);
        },
        resolvePoint: resolveAgentPoint,
        hitTest: hitTestAgentPoint,
        pointer: dispatchAgentPointer,
        waitForIdle: waitForAgentIdle
      });
      window[AGENT_BRIDGE_GLOBAL_NAME] = installedBridge;
      setStatus(`Agent bridge enabled (${permission.source})`);
    });

    return () => {
      disposed = true;
      agentPointerTargetsRef.current.clear();
      if (installedBridge && window[AGENT_BRIDGE_GLOBAL_NAME] === installedBridge) {
        delete window[AGENT_BRIDGE_GLOBAL_NAME];
      }
    };
  }, [
    createAgentSnapshot,
    dispatchAgentPointer,
    hitTestAgentPoint,
    resolveAgentPoint,
    waitForAgentIdle
  ]);

  return (
    <main
      className={["app-shell", nativePalette ? "native-shell" : "web-shell"].join(" ")}
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

      {!nativePalette
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
                <div className="palette-title">{toolset.title.replace(/ Toolbar$/, "")}</div>
                <ToolPalette
                  groups={getToolsetCommandGroups(toolset.id, toolsetRegistry)}
                  activeTool={activeTool}
                  mode="floating"
                  orientation={toolset.gridLayout?.orientation ?? "vertical"}
                  title={toolset.title}
                  showMainStyleControls={toolset.id === "core.main"}
                  currentTextStyle={currentToolbarTextStyle}
                  currentTextScript={currentToolbarTextScript}
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
                  spinningObjectId={spin3dState?.objectId}
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
                {selectionLasso ? (
                  <SelectionLassoOverlay
                    points={selectionLasso.points}
                    latestPoint={selectionLasso.latestPoint}
                    pageWidth={activePage.width}
                    pageHeight={activePage.height}
                  />
                ) : null}
                {(() => {
                  const transformChromeActive = activeToolState.activeCommandId === "tool.select";
                  const groupSelectionActive = transformChromeActive &&
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
                  // While this molecule is being spun in 3D, its real 2D drawing is faded
                  // to a faint ghost (the live overlay paints on top). The selection box
                  // and rotate handle are separate chrome and stay fully visible.
                  const spinning = spin3dState?.objectId === object.id;
                  const objectRenderKey = object.type === "molecule"
                    ? `${object.id}:${selected ? "selected" : "idle"}:${inGroupSelection ? "grouped" : "solo"}:${nativeSelectionRenderKey(selectedPart)}:${spinning ? "spinning" : "static"}`
                    : object.id;

                  return (
                    <DocumentObjectView
                      key={objectRenderKey}
                      object={object}
                      layerIndex={layerIndex}
                      pageHeight={activePage.height}
                      pageWidth={activePage.width}
                      spinning={spinning}
                      selected={selected}
                      inGroupSelection={inGroupSelection}
                      selectedPart={selectedPart}
                      transformHandlesEnabled={transformChromeActive}
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
                      resizeReadout={moleculeResizeReadout?.objectId === object.id ? moleculeResizeReadout : undefined}
                      resizeInput={moleculeResizeInput?.objectId === object.id ? moleculeResizeInput : undefined}
                      onPointerDown={handleObjectPointerDown}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onPointerCancel={handleObjectPointerCancel}
                      onPointerLeave={handleObjectPointerLeave}
                      onRotatePointerDown={handleObjectRotatePointerDown}
                      onRotateDoubleClick={handleObjectRotateDoubleClick}
                      onProjectedPlaneTiltPointerDown={handleProjectedPlaneTiltPointerDown}
                      onProjectedPlaneTiltDoubleClick={handleProjectedPlaneTiltDoubleClick}
                      onRotationInputChange={handleRotationInputChange}
                      onRotationInputKeep={handleRotationInputKeep}
                      onRotationInputHome={handleRotationInputHome}
                      onRotationInputCancel={handleRotationInputCancel}
                      onMoleculeResizePointerDown={handleMoleculeResizePointerDown}
                      onMoleculeResizeDoubleClick={handleMoleculeResizeDoubleClick}
                      onMoleculeResizeInputChange={handleMoleculeResizeInputChange}
                      onMoleculeResizeInputKeep={handleMoleculeResizeInputKeep}
                      onMoleculeResizeInputHome={handleMoleculeResizeInputHome}
                      onMoleculeResizeInputCancel={handleMoleculeResizeInputCancel}
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
                {spin3dState ? (() => {
                  const spinObject = activePage.objects.find((object) => object.id === spin3dState.objectId);
                  // The overlay renders with the molecule's OWN drawing style so the
                  // spinning structure is visually the same structure as the drawing.
                  const spinStyle = nativeDrawingStyleFromObjectStyle(
                    spinObject?.type === "molecule" ? spinObject.style : {}
                  );
                  return (
                    <SpinOverlay
                      state={spin3dState}
                      pageWidth={activePage.width}
                      pageHeight={activePage.height}
                      drawingStyle={spinStyle}
                      onPointerDown={handleSpinOverlayPointerDown}
                      onPointerMove={handleSpinOverlayPointerMove}
                      onPointerUp={handleSpinOverlayPointerUp}
                      onPointerCancel={handleSpinOverlayPointerUp}
                    />
                  );
                })() : null}
                  </>
                  );
                })()}
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
          Build {CURRENT_BUILD_STAMP} · {__BUILD_STAMP__}
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

export function parseMoleculeResizeInputPercent(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function moleculeResizeInputDraftPercent(scale: number): string {
  return `${moleculeResizeReadoutPercent(scale)}`;
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

export function moleculeResizeScaleFromDrag(
  center: ClientPoint,
  start: ClientPoint,
  latest: ClientPoint,
  stretch: boolean
): MoleculeResizeScale {
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
    const uniformScale = clampMoleculeResizeScale(projectedScale);
    return { x: uniformScale, y: uniformScale };
  }

  return {
    x: clampMoleculeResizeScale(Math.abs(startVector.x) <= 0.001 ? 1 : latestVector.x / startVector.x),
    y: clampMoleculeResizeScale(Math.abs(startVector.y) <= 0.001 ? 1 : latestVector.y / startVector.y)
  };
}

export function moleculeResizeReadoutPercent(scale: number): number {
  return Math.round(scale * 100);
}

export function cumulativeMoleculeResizeScale(
  startScale: MoleculeResizeScale,
  deltaScale: MoleculeResizeScale
): MoleculeResizeScale {
  return {
    x: Number((startScale.x * deltaScale.x).toFixed(4)),
    y: Number((startScale.y * deltaScale.y).toFixed(4))
  };
}

function clampMoleculeResizeScale(scale: number): number {
  return Number(Math.max(MOLECULE_RESIZE_MIN_SCALE, scale).toFixed(4));
}

function capitalizeLabel(label: string): string {
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
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
/** How one bond draws in the spin overlay — mirrors the 2D renderer's conventions. */
interface SpinBondRenderInfo {
  order: 1 | 2 | 3;
  /** Terminal-heteroatom doubles (C=O etc.) straddle the bond axis symmetrically,
   *  exactly like the 2D drawing; all other doubles draw axis + inset inner line. */
  symmetric: boolean;
  /** Atom indices bonded to either endpoint (excluding the endpoints): the secondary
   *  line goes on the substituent-rich side — ring-interior for ring bonds — which is
   *  the same neighbor-mass rule the 2D `defaultDoubleBondSide` uses. */
  neighborIndices: number[];
}

interface Spin3dState {
  objectId: string;
  quat: Quaternion;
  coords3d: Float64Array;
  bondPairs: [number, number][];
  /** Per bondPairs entry: how the bond renders, mirroring the 2D drawing conventions. */
  bondRender: SpinBondRenderInfo[];
  /** Per atom: the exact label the 2D drawing shows (undefined = unlabeled carbon). */
  atomLabels: (string | undefined)[];
  /** The source 2D atoms (same order as atomLabels/projection) — used for label-offset
   *  aware bond-end trimming, matching the committed 2D drawing. */
  atoms: readonly MoleculeAtom[];
  placement: ScreenPlacement;
  /** The molecule's selection box (page coords): drag inside to rotate, click outside to flatten. */
  selectionBox: { x: number; y: number; width: number; height: number };
  dragging: boolean;
  lastClient?: { x: number; y: number };
}

/**
 * Transient 3D spin overlay (Phase 4). A full-page SVG that dims the canvas, paints
 * the spun conformer in painter's order (far → near), and owns its own pointer
 * drag — so it needs no changes to the existing page/object pointer handlers. It
 * never mutates the document; the flatten-on-release commit is Phase 5.
 */
function SpinOverlay({
  state,
  pageWidth,
  pageHeight,
  drawingStyle,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel
}: {
  state: Spin3dState;
  pageWidth: number;
  pageHeight: number;
  /** The molecule's own 2D drawing style — the overlay renders with the SAME colors,
   *  stroke widths, label fonts and multi-bond geometry as the drawing it replaces,
   *  so spinning never reads as a different engine taking over. */
  drawingStyle: NativeDrawingStyle;
  onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerCancel: (event: PointerEvent<SVGSVGElement>) => void;
}) {
  const projection = projectSpin(state.coords3d, state.bondPairs, state.quat, state.placement);
  // Depth-cue weights computed with the EXACT recipe flattenSpunMolecule commits, so the
  // live overlay's stroke weighting is identical to the flattened result (no snap on
  // release). `undefined` = near-planar view ⇒ no depth cue, same as the commit.
  const depthWeights = bondDepthWeights(state.coords3d, state.bondPairs, quatToViewMatrix(state.quat));
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 50, cursor: "grab", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {projection.bonds.map((bond, index) => {
        const a = projection.atoms[bond.from];
        const b = projection.atoms[bond.to];
        // The SAME depth-cue helpers AND the SAME weight the committed 2D drawing uses
        // (flatten bakes the identical weight into display.depthWeight) — releasing changes
        // nothing visually. undefined ⇒ no cue, exactly as the commit leaves a planar view.
        const weight = depthWeights[bond.index];
        const stroke = depthCuedBondColor(drawingStyle.bondColor, weight);
        const width = depthCuedBondStrokeWidth(drawingStyle.bondStrokeWidthPx, weight);
        const render = state.bondRender[bond.index] ?? { order: 1, symmetric: false, neighborIndices: [] };
        const rawDx = b.sx - a.sx;
        const rawDy = b.sy - a.sy;
        const rawLength = Math.hypot(rawDx, rawDy) || 1;
        const ux = rawDx / rawLength, uy = rawDy / rawLength;
        const nx = -uy, ny = ux; // screen-space normal
        // Trim bond ends back from atom labels exactly like the 2D renderer does, so
        // lines never strike through an O / NH2 / charge label while spinning.
        const clearance = labelEndpointClearance(
          state.atoms[bond.from],
          state.atoms[bond.to],
          state.atomLabels[bond.from],
          state.atomLabels[bond.to],
          drawingStyle,
          rawLength,
          { x: ux, y: uy }
        );
        const ax = a.sx + ux * clearance.from, ay = a.sy + uy * clearance.from;
        const bx = b.sx - ux * clearance.to, by = b.sy - uy * clearance.to;
        const length = Math.hypot(bx - ax, by - ay) || 1;
        const gap = drawingStyle.multipleBondGapPx;
        const key = (suffix: string) => `${bond.from}-${bond.to}-${index}-${suffix}`;
        const line = (sx1: number, sy1: number, sx2: number, sy2: number, suffix: string) => (
          <line key={key(suffix)} x1={sx1} y1={sy1} x2={sx2} y2={sy2}
            stroke={stroke} strokeWidth={width} strokeLinecap={drawingStyle.bondLineCap} />
        );
        if (render.order === 2 && render.symmetric) {
          // Terminal heteroatom double (C=O …): two full lines straddling the axis — same as 2D.
          const o = gap / 2;
          return [
            line(ax + nx * o, ay + ny * o, bx + nx * o, by + ny * o, "p"),
            line(ax - nx * o, ay - ny * o, bx - nx * o, by - ny * o, "s")
          ];
        }
        if (render.order === 2) {
          // 2D convention: primary line on the bond axis, shorter secondary line a full
          // gap toward the substituent-rich side (ring interior for ring bonds). The side
          // is chosen per frame from the PROJECTED neighbor positions, so it tracks the
          // molecule as it rotates — matching what the drawing will look like flattened.
          // MAGNITUDE-weighted projection onto the bond normal (NOT a sign-sum) so this is
          // the identical heuristic defaultDoubleBondSide uses on commit — otherwise the
          // inner line could resolve to the opposite side and visibly jump on release.
          // (The reference point along the bond axis is irrelevant: the axis is ⊥ to the
          // normal, so the midpoint gives the same dot as each neighbor's own endpoint.)
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          let score = 0;
          for (const neighborIndex of render.neighborIndices) {
            const p = projection.atoms[neighborIndex];
            if (p) score += (p.sx - mx) * nx + (p.sy - my) * ny;
          }
          const dir = score >= 0 ? 1 : -1;
          const minimumVisible = Math.min(DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX, length);
          const inset = Math.min(drawingStyle.doubleBondInsetPx, Math.max(0, (length - minimumVisible) / 2));
          return [
            line(ax, ay, bx, by, "p"),
            line(
              ax + ux * inset + nx * gap * dir, ay + uy * inset + ny * gap * dir,
              bx - ux * inset + nx * gap * dir, by - uy * inset + ny * gap * dir,
              "s"
            )
          ];
        }
        if (render.order === 3) {
          // Triple: three full-length lines at -gap / 0 / +gap — same as 2D.
          return [-1, 0, 1].map((step) =>
            line(ax + nx * gap * step, ay + ny * gap * step, bx + nx * gap * step, by + ny * gap * step, `t${step}`)
          );
        }
        return line(ax, ay, bx, by, "p");
      })}
      {projection.atoms.map((atom) => {
        // Labeled atoms render their 2D label (same layout engine: runs, scripts,
        // charge superscript, background box). Plain carbons draw nothing — exactly
        // like the drawing. The label sits over the trimmed bond ends.
        const label = state.atomLabels[atom.index];
        if (!label) return null;
        const layout = atomLabelLayout(label, drawingStyle);
        return (
          <g key={`label-${atom.index}`}>
            <rect
              x={atom.sx + layout.bounds.x}
              y={atom.sy + layout.bounds.y}
              width={layout.bounds.width}
              height={layout.bounds.height}
              fill={drawingStyle.atomLabelBackgroundColor}
            />
            <text
              x={atom.sx}
              y={atom.sy}
              fill={drawingStyle.atomLabelColor}
              fontFamily={drawingStyle.atomLabelFontFamily}
              fontSize={drawingStyle.atomLabelFontSizePx}
              fontWeight={drawingStyle.atomLabelFontWeight}
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {layout.runs.map((run, runIndex) => (
                <tspan
                  key={runIndex}
                  x={atom.sx + run.x}
                  y={atom.sy + run.y}
                  textAnchor={run.textAnchor}
                  dominantBaseline="central"
                  fontSize={atomLabelRunFontSize(run.script, drawingStyle) ?? drawingStyle.atomLabelFontSizePx}
                >
                  {run.text}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
      <text
        x={pageWidth / 2}
        y={24}
        textAnchor="middle"
        fontSize={13}
        fill="var(--cd-text-secondary, #555)"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        Drag the molecule to rotate · click outside to flatten · Esc to cancel
      </text>
    </svg>
  );
}

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

export function SelectionLassoOverlay({
  points,
  latestPoint,
  pageWidth,
  pageHeight
}: {
  points: readonly ClientPoint[];
  latestPoint: ClientPoint;
  pageWidth: number;
  pageHeight: number;
}) {
  const pathPoints = points.length > 0 ? [...points, latestPoint] : [latestPoint];
  const pathData = pathPoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  return (
    <svg
      className="selection-lasso-surface"
      aria-hidden="true"
      viewBox={`0 0 ${pageWidth} ${pageHeight}`}
    >
      <path className="selection-lasso-fill" d={`${pathData} Z`} />
      <path className="selection-lasso-path" d={pathData} />
    </svg>
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
  onResizeStart(corner: MoleculeResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      className="native-molecule-transform-frame group-selection-frame"
      data-group-selection="true"
      data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}
      style={{
        left: `calc(${bounds.x}px * var(--page-scale))`,
        top: `calc(${bounds.y}px * var(--page-scale))`,
        width: `calc(${bounds.width}px * var(--page-scale))`,
        height: `calc(${bounds.height}px * var(--page-scale))`
      }}
    >
      <MoleculeResizeHandles
        targetLabel="selected group"
        onResizeDoubleClick={() => (event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onResizeStart={onResizeStart}
      />
      <button
        type="button"
        className="native-molecule-rotate-handle"
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
          className="native-molecule-tilt3d-handle"
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

    if (rectangleContainsRect(rect, objectBounds(object))) {
      objectIds.push(object.id);
    }
  }

  return { objectIds, nativeSelection };
}

export function selectionInSelectionPolygon(
  objects: readonly DocumentObject[],
  polygon: readonly ClientPoint[]
): { objectIds: string[]; nativeSelection?: NativeMoleculeSelectionPart } {
  if (polygon.length < 3) {
    return { objectIds: [] };
  }

  const objectIds: string[] = [];
  let nativeSelection: NativeMoleculeSelectionPart | undefined;

  for (const object of objects) {
    if (object.type === "molecule" && isNativeMoleculeGraph(object)) {
      const moleculeSelection = nativeMoleculeSelectionInPolygon(object, polygon);
      if (!moleculeSelection) {
        continue;
      }

      // If the lasso caught every atom and bond, it enclosed the whole molecule —
      // select it as an object (resize/rotate as a unit). Testing atom/bond coverage
      // is what the user actually drew around; gating on the padded bounding rect on
      // top of that just made "lasso around everything" unpredictably fall to a
      // fragment selection instead.
      if (nativeMoleculeSelectionCoversWholeObject(object, moleculeSelection)) {
        objectIds.push(object.id);
        continue;
      }

      nativeSelection ??= moleculeSelection;
      continue;
    }

    if (polygonContainsRect(polygon, objectBounds(object))) {
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

function nativeMoleculeSelectionInPolygon(
  object: MoleculeObject,
  polygon: readonly ClientPoint[]
): NativeMoleculeSelectionPart | undefined {
  const atomIds = object.atoms
    .filter((atom) => pointInPolygon(atom, polygon))
    .map((atom) => atom.id);
  const bondIds = object.bonds
    .filter((bond) => nativeBondIntersectsPolygon(object, bond, polygon))
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

function nativeBondIntersectsPolygon(
  object: MoleculeObject,
  bond: MoleculeObject["bonds"][number],
  polygon: readonly ClientPoint[]
): boolean {
  const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return false;
  }

  return (
    pointInPolygon(fromAtom, polygon) ||
    pointInPolygon(toAtom, polygon) ||
    lineIntersectsPolygon(fromAtom, toAtom, polygon)
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

function pointInPolygon(point: ClientPoint, polygon: readonly ClientPoint[]): boolean {
  if (polygon.length < 3) {
    return false;
  }

  if (polygonEdges(polygon).some(([start, end]) => pointOnSegment(point, start, end))) {
    return true;
  }

  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crossesY = (currentPoint.y > point.y) !== (previousPoint.y > point.y);
    if (!crossesY) {
      continue;
    }

    const xAtY = ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
      (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (point.x <= xAtY) {
      inside = !inside;
    }
  }
  return inside;
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

function lineIntersectsPolygon(start: ClientPoint, end: ClientPoint, polygon: readonly ClientPoint[]): boolean {
  return polygonEdges(polygon).some(([edgeStart, edgeEnd]) => segmentsIntersect(start, end, edgeStart, edgeEnd));
}

function polygonEdges(polygon: readonly ClientPoint[]): Array<[ClientPoint, ClientPoint]> {
  return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]]);
}

function polygonContainsRect(
  polygon: readonly ClientPoint[],
  rect: { x: number; y: number; width: number; height: number },
  marginPx = 0
): boolean {
  const expanded = {
    x: rect.x - marginPx,
    y: rect.y - marginPx,
    width: rect.width + marginPx * 2,
    height: rect.height + marginPx * 2
  };
  return rectangleContainsRect(polygonBounds(polygon), expanded) &&
    rectCorners(expanded).every((point) => pointInPolygon(point, polygon));
}

function polygonBounds(polygon: readonly ClientPoint[]): { x: number; y: number; width: number; height: number } {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY
  };
}

function rectCorners(rect: { x: number; y: number; width: number; height: number }): ClientPoint[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height }
  ];
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

function pointOnSegment(point: ClientPoint, start: ClientPoint, end: ClientPoint): boolean {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  if (lengthSquared === 0) {
    // Degenerate (zero-length) segment — lasso paths routinely contain consecutive
    // duplicate points (release without moving). Without this guard the cross/dot
    // math below degenerates to 0 <= 0 and EVERY point tests "on segment", which
    // made pointInPolygon swallow the whole page and the lasso grab whole molecules.
    return point.x === start.x && point.y === start.y;
  }

  const cross = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
  if (Math.abs(cross) > 0.0001) {
    return false;
  }

  const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  if (dot < 0) {
    return false;
  }

  return dot <= lengthSquared;
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
  spinningObjectId,
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
  /** The id of the molecule being spun in 3D; its drawn structure fades to a faint ghost. */
  spinningObjectId?: string;
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
      {plan.fragments.map((fragment) => {
        const rendered = renderPageSvgFragment(fragment, {
          onContextMenu,
          onPointerCancel,
          onPointerDown,
          onPointerLeave,
          onPointerMove,
          onPointerUp
        });
        // The spun molecule's drawn structure fades to a faint ghost (the live 3D overlay
        // paints on top); pointer events off so the overlay owns the drag.
        const isSpinning = spinningObjectId !== undefined &&
          fragment.attrs["data-object-id"] === spinningObjectId;
        return isSpinning
          ? <g key={`spin-${fragment.key}`} opacity={0.1} style={{ pointerEvents: "none" }}>{rendered}</g>
          : rendered;
      })}
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
  spinning = false,
  selected,
  inGroupSelection,
  selectedPart,
  transformHandlesEnabled,
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
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onRotatePointerDown,
  onRotateDoubleClick,
  onProjectedPlaneTiltPointerDown,
  onProjectedPlaneTiltDoubleClick,
  onRotationInputChange,
  onRotationInputKeep,
  onRotationInputHome,
  onRotationInputCancel,
  onMoleculeResizePointerDown,
  onMoleculeResizeDoubleClick,
  onMoleculeResizeInputChange,
  onMoleculeResizeInputKeep,
  onMoleculeResizeInputHome,
  onMoleculeResizeInputCancel,
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
  spinning?: boolean;
  selected: boolean;
  inGroupSelection: boolean;
  selectedPart?: NativeMoleculeSelectionPart;
  transformHandlesEnabled: boolean;
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
  resizeReadout?: MoleculeResizeReadoutState;
  resizeInput?: MoleculeResizeInputState;
  onPointerDown(objectId: string, event: ObjectPointerEvent): void;
  onPointerMove(objectId: string, event: ObjectPointerEvent): void;
  onPointerUp(objectId: string, event: ObjectPointerEvent): void;
  onPointerCancel(event: ObjectPointerEvent): void;
  onPointerLeave(objectId: string): void;
  onRotatePointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onRotateDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltPointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onProjectedPlaneTiltDoubleClick(objectId: string, event: ReactMouseEvent<HTMLButtonElement>): void;
  onRotationInputChange(nextInput: RotationInputState): void;
  onRotationInputKeep(input: RotationInputState): void;
  onRotationInputHome(input: RotationInputState): void;
  onRotationInputCancel(input: RotationInputState): void;
  onMoleculeResizePointerDown(objectId: string, corner: MoleculeResizeCorner, event: PointerEvent<HTMLButtonElement>): void;
  onMoleculeResizeDoubleClick(objectId: string, corner: MoleculeResizeCorner, event: ReactMouseEvent<HTMLButtonElement>): void;
  onMoleculeResizeInputChange(nextInput: MoleculeResizeInputState): void;
  onMoleculeResizeInputKeep(input: MoleculeResizeInputState): void;
  onMoleculeResizeInputHome(input: MoleculeResizeInputState): void;
  onMoleculeResizeInputCancel(input: MoleculeResizeInputState): void;
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
  const handleMoleculeResizePointerDown = (corner: MoleculeResizeCorner) => (event: PointerEvent<HTMLButtonElement>) => {
    onMoleculeResizePointerDown(object.id, corner, event);
  };
  const handleMoleculeResizeDoubleClick = (corner: MoleculeResizeCorner) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    onMoleculeResizeDoubleClick(object.id, corner, event);
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
    transform: `rotate(${object.rotation}deg)`
  } as CSSProperties;

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
      const transformFrame = transformHandlesEnabled && hasVisibleSelectionTargets && !inGroupSelection && (selected || selectedFragmentBounds)
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
          <svg
            className="native-molecule-overlay"
            viewBox={`0 0 ${object.width} ${object.height}`}
            aria-hidden="true"
            // While spinning, fade the selection blob/overlays so only the faint structure
            // and the live 3D overlay read; the transform frame (sibling) stays full opacity.
            style={spinning ? { opacity: 0.1 } : undefined}
          >
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
              className="native-molecule-transform-frame"
              data-molecule-transform-frame={selectedFragmentBounds ? "fragment" : "whole"}
              data-has-tilt3d={canProjectedPlaneTilt ? "true" : undefined}
              style={transformFrameStyle}
            >
              <MoleculeResizeHandles
                targetLabel={transformTargetLabel}
                onResizeDoubleClick={handleMoleculeResizeDoubleClick}
                onResizeStart={handleMoleculeResizePointerDown}
              />
              {resizeReadout && !resizeInput ? (
                <MoleculeResizeReadout
                  scaleXPercent={resizeReadout.scaleXPercent}
                  scaleYPercent={resizeReadout.scaleYPercent}
                />
              ) : null}
              <button
                type="button"
                className="native-molecule-rotate-handle"
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
                  className="native-molecule-tilt3d-handle"
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
                <MoleculeResizeInputPopover
                  input={resizeInput}
                  onKeep={onMoleculeResizeInputKeep}
                  onHome={onMoleculeResizeInputHome}
                  onCancel={onMoleculeResizeInputCancel}
                  onChange={onMoleculeResizeInputChange}
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
            className="native-molecule-rotate-handle text-rotate-handle"
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
    />
  );
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

// BASE colors (the user's chosen per-part color, NO perspective depth tint) — used by
// the toolbar color reflection. The depth-cued renderer colors live in layout-engine
// (`nativeMoleculeBondColor` there) and intentionally do NOT share these names.
function nativeMoleculeBaseBondColor(
  object: MoleculeObject,
  bondId: string,
  drawingStyle: NativeDrawingStyle
): string {
  return styleColorMapValue(object.style.bondColors, bondId) ?? drawingStyle.bondColor;
}

function nativeMoleculeBaseAtomLabelColor(
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
    return nativeMoleculeBaseAtomLabelColor(object, part.atomId, drawingStyle);
  }

  if (part.kind === "bond") {
    return nativeMoleculeBaseBondColor(object, part.bondId, drawingStyle);
  }

  const firstBondId = part.bondIds[0];
  if (firstBondId) {
    return nativeMoleculeBaseBondColor(object, firstBondId, drawingStyle);
  }

  const firstAtomId = part.atomIds[0];
  return firstAtomId
    ? nativeMoleculeBaseAtomLabelColor(object, firstAtomId, drawingStyle)
    : drawingStyle.bondColor;
}

function MoleculeResizeHandles({
  targetLabel,
  onResizeDoubleClick,
  onResizeStart
}: {
  targetLabel: string;
  onResizeDoubleClick(corner: MoleculeResizeCorner): (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onResizeStart(corner: MoleculeResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const corners: MoleculeResizeCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

  return (
    <>
      {corners.map((corner) => (
        <button
          aria-label={`Resize ${targetLabel} ${corner.replace("-", " ")}`}
          className={`native-molecule-resize-handle native-molecule-resize-${corner}`}
          data-molecule-resize-corner={corner}
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
      className="native-molecule-rotation-input-popover"
      data-rotation-input-popover="true"
      data-rotation-input-kind={input.kind}
      onSubmit={handleSubmit}
      onPointerDown={stopPointerPropagation}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {input.kind === "z" ? (
        <label className="native-molecule-rotation-input-field">
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
          <label className="native-molecule-rotation-input-field">
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
          <label className="native-molecule-rotation-input-field">
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
      <span aria-hidden="true" className="native-molecule-rotation-input-unit">°</span>
      <button
        aria-label="Restore rotation home"
        className="native-molecule-rotation-input-action"
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
        className="native-molecule-rotation-input-action"
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

function MoleculeResizeInputPopover({
  input,
  onKeep,
  onHome,
  onCancel,
  onChange
}: {
  input: MoleculeResizeInputState;
  onKeep(input: MoleculeResizeInputState): void;
  onHome(input: MoleculeResizeInputState): void;
  onCancel(input: MoleculeResizeInputState): void;
  onChange(input: MoleculeResizeInputState): void;
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
      className="native-molecule-scale-input-popover"
      data-scale-input-popover="true"
      data-scale-input-corner={input.corner}
      onSubmit={handleSubmit}
      onPointerDown={stopPointerPropagation}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <label className="native-molecule-scale-input-field">
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
      <label className="native-molecule-scale-input-field">
        <span>Y</span>
        <input
          aria-label="Y stretch percent"
          inputMode="decimal"
          type="text"
          value={input.draftYPercent}
          onChange={(event) => onChange({ ...input, draftYPercent: event.currentTarget.value })}
        />
      </label>
      <span aria-hidden="true" className="native-molecule-scale-input-unit">%</span>
      <button
        aria-label="Restore stretch home"
        className="native-molecule-scale-input-action"
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
        className="native-molecule-scale-input-action"
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

function MoleculeResizeReadout({
  scaleXPercent,
  scaleYPercent
}: {
  scaleXPercent: number;
  scaleYPercent: number;
}) {
  return (
    <span
      className="native-molecule-resize-readout"
      data-molecule-resize-readout="true"
      aria-label={`Molecule scale X ${scaleXPercent} percent Y ${scaleYPercent} percent`}
    >
      X {scaleXPercent}% Y {scaleYPercent}%
    </span>
  );
}

function RotateSelectionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-rotate-icon="double-headed">
      <path
        className="native-molecule-rotate-arc"
        d="M7 8.9a6.9 6.9 0 0 1 10.2-1.3"
      />
      <path
        className="native-molecule-rotate-arrow"
        d="M17.4 4.6l0.4 4.1-4.1-0.3"
      />
      <path
        className="native-molecule-rotate-arc"
        d="M17 15.1a6.9 6.9 0 0 1-10.2 1.3"
      />
      <path
        className="native-molecule-rotate-arrow"
        d="M6.6 19.4l-0.4-4.1 4.1 0.3"
      />
    </svg>
  );
}

function RotateSelectionReadout({ degrees }: { degrees: number }) {
  return (
    <span
      className="native-molecule-rotate-readout"
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
        className="native-molecule-tilt3d-loop"
        d="M4.2 12.4c0-4.1 4-7.2 9-7.2 4.7 0 8.4 2.8 8.6 6.7"
      />
      <path
        className="native-molecule-tilt3d-return"
        d="M4.7 14.1c1.4 2.9 4.7 4.7 8.7 4.7"
      />
      <path
        className="native-molecule-tilt3d-arrowhead"
        d="M11.2 10.6l7.2 5.5-7.2 5.5v-3.7H7.9v-3.6h3.3z"
      />
    </svg>
  );
}

function ProjectedPlaneTiltReadout({ label, limited }: { label: string; limited: boolean }) {
  return (
    <span
      className="native-molecule-tilt3d-readout"
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

function agentObjectSummary(object: DocumentObject): AgentSnapshot["objects"][number] {
  return {
    id: object.id,
    type: object.type,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    atomCount: object.type === "molecule" ? object.atoms.length : undefined,
    bondCount: object.type === "molecule" ? object.bonds.length : undefined
  };
}

function resolveAgentPointInDocument(
  target: AgentPointTarget,
  document: ChemDraftDocument,
  pageRect: Pick<DOMRect, "left" | "top">,
  scale: number
): AgentResolvedPoint {
  if ("page" in target) {
    return {
      page: target.page,
      client: pageToClient(target.page, { pageRect, scale }),
      target,
      source: "page"
    };
  }

  if ("client" in target) {
    return {
      page: clientToPage(target.client, { pageRect, scale }),
      client: target.client,
      target,
      source: "client"
    };
  }

  if ("objectId" in target) {
    const object = findDocumentObject(document, target.objectId);
    if (!object) {
      throw new Error(`Agent bridge could not resolve object "${target.objectId}".`);
    }
    const pagePoint = agentObjectAnchorPoint(object, target.anchor ?? "center");
    return {
      page: pagePoint,
      client: pageToClient(pagePoint, { pageRect, scale }),
      target,
      source: "object"
    };
  }

  if ("atom" in target) {
    const object = findDocumentObject(document, target.atom.objectId);
    if (object?.type !== "molecule") {
      throw new Error(`Agent bridge could not resolve molecule "${target.atom.objectId}".`);
    }
    const atom = object.atoms.find((candidate) => candidate.id === target.atom.atomId);
    if (!atom) {
      throw new Error(`Agent bridge could not resolve atom "${target.atom.atomId}".`);
    }
    const pagePoint = { x: atom.x, y: atom.y };
    return {
      page: pagePoint,
      client: pageToClient(pagePoint, { pageRect, scale }),
      target,
      source: "atom"
    };
  }

  const object = findDocumentObject(document, target.bond.objectId);
  if (object?.type !== "molecule") {
    throw new Error(`Agent bridge could not resolve molecule "${target.bond.objectId}".`);
  }
  const bond = object.bonds.find((candidate) => candidate.id === target.bond.bondId);
  if (!bond) {
    throw new Error(`Agent bridge could not resolve bond "${target.bond.bondId}".`);
  }
  const fromAtom = object.atoms.find((candidate) => candidate.id === bond.fromAtomId);
  const toAtom = object.atoms.find((candidate) => candidate.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    throw new Error(`Agent bridge could not resolve atoms for bond "${target.bond.bondId}".`);
  }
  const pagePoint = target.bond.anchor === "from"
    ? { x: fromAtom.x, y: fromAtom.y }
    : target.bond.anchor === "to"
      ? { x: toAtom.x, y: toAtom.y }
      : { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };
  return {
    page: pagePoint,
    client: pageToClient(pagePoint, { pageRect, scale }),
    target,
    source: "bond"
  };
}

function agentObjectAnchorPoint(object: DocumentObject, anchor: AgentObjectAnchor): AgentPoint {
  if (anchor === "topLeft") {
    return { x: object.x, y: object.y };
  }
  if (anchor === "topRight") {
    return { x: object.x + object.width, y: object.y };
  }
  if (anchor === "bottomLeft") {
    return { x: object.x, y: object.y + object.height };
  }
  if (anchor === "bottomRight") {
    return { x: object.x + object.width, y: object.y + object.height };
  }

  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
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
