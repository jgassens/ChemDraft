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
  type PageSvgAttributeValue,
  type PageSvgElementFragment,
  type PageSvgFragment,
  type PageSvgRenderPlan,
  type ResolvedBondCrossing
} from "@chemdraft/layout-engine";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import type { Generate3DConformerResult, StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  atomElementActions,
  atomElementCommandId,
  createLayerActions,
  createQuickActions,
  editActions,
  pageOrientationActions,
  pageSizeActions,
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
  applyNativeCarbonylAtAtomTarget,
  applyNativeAtomElementTarget,
  applyChargeToolAtPoint,
  applyChargeToolAtNativeAtom,
  applyNativeBondDisplayStyleTarget,
  applyNativeDoubleBondSideTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeBondOrderValueTarget,
  applyNativeMoleculeDeleteTarget,
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
  exportPhase4Svg,
  getSelectedMolecule,
  getSelectedTextObject,
  insertNativeTextObject,
  nativeAtomDisplayLabel,
  nativeChargeAssociationsForMolecule,
  nativeChargeByAtomIdFromAssociations,
  nativeBondStyleForToolCommand,
  nativeElementFromKeyboardKey,
  nativeMoleculeInvalidAtomStates,
  nativeMoleculePartBounds,
  nativeMoleculeTransformState,
  nativeTemplateForToolCommand,
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
  reorderSelectedDocumentObject,
  resizeNativeMoleculeParts,
  resizeNativeMoleculeObject,
  resizeNativeTextObjectBox,
  resolveToolbarColorSelection,
  rotateNativeMoleculeParts,
  rotateDocumentObject,
  rotateNativeMoleculeObjectAroundPoint,
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
  type NativeSingleLetterElement
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
import { clientToPage, pageToClient } from "./interaction/camera";
import { applyTrackballDrag, quatToViewMatrix, type Quaternion } from "./interaction/rotation3d";
import { initialViewQuaternion, projectSpin, overlayScale, type ScreenPlacement } from "./interaction/spinOverlay";
import { getConformerWorkerClient } from "./conformerClient";
import {
  BOND_HIT_CATCHER_STROKE_PX,
  currentTemplateTargetFromHoverOrHit,
  hitToleranceForScale,
  nativeMoleculeCanvasHoverTarget,
  nativeMoleculeHitFromPointerTarget,
  nativeMoleculeTemplateHoverTarget,
  type TemplateHoverSample
} from "./interaction/hitTest";

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
  mode: "rotate" | "resize";
  objectIds: readonly string[];
  startDocument: ChemDraftDocument;
  center: ClientPoint;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
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

const RULER_THICKNESS = 32;
const FREEFORM_BOND_DRAG_THRESHOLD = 6;
const DOUBLE_BOND_SIDE_DRAG_THRESHOLD = 4;
const DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX = 13;
const VIEW_ZOOM_COMMAND_FACTOR = 1.25;
const OBJECT_ROTATE_TANGENTIAL_DEGREES_PER_PIXEL = 45;
const OBJECT_DRAG_THRESHOLD = 4;
const MOLECULE_RESIZE_MIN_SCALE = 0.12;
const DOCUMENT_HISTORY_LIMIT = 100;
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
const layerContextMenuItems: readonly LayerContextMenuItem[] = [
  { commandId: "layout.bringForward", label: "Move Object Forward" },
  { commandId: "layout.bringToFront", label: "Move Object to Front" },
  { commandId: "layout.sendBackward", label: "Move Object Backward" },
  { commandId: "layout.sendToBack", label: "Move Object to Back" }
];

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
  const moleculeResizeDragRef = useRef<MoleculeResizeDragState | null>(null);
  const moleculeResizeReadoutTimeoutRef = useRef<number | undefined>(undefined);
  const groupTransformDragRef = useRef<GroupTransformDragState | null>(null);
  const textResizeRef = useRef<TextResizeState | null>(null);
  const textEditorFocusTimeoutsRef = useRef<number[]>([]);
  const selectionMarqueeRef = useRef<SelectionMarqueeState | null>(null);
  const marqueeMachineRef = useRef<InteractionState>(initialInteractionState());
  const placementMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectRotateMachineRef = useRef<InteractionState>(initialInteractionState());
  const objectDragMachineRef = useRef<InteractionState>(initialInteractionState());
  // 3D spin (Phase 4): authoritative state in a ref (read by pointer handlers,
  // immune to stale closures) mirrored into React state so the overlay re-renders.
  const spin3dStateRef = useRef<Spin3dState | undefined>(undefined);
  const [spin3dState, setSpin3dStateRender] = useState<Spin3dState | undefined>(undefined);
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
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuState | undefined>();
  const [freeformNativeBond, setFreeformNativeBond] = useState<FreeformNativeBondPreview | undefined>();
  const [nativeDoubleBondSidePreview, setNativeDoubleBondSidePreview] = useState<NativeDoubleBondSidePreview | undefined>();
  const [objectRotateReadout, setObjectRotateReadout] = useState<ObjectRotateReadoutState | undefined>();
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
  const [, setStatus] = useState("Blank native document");
  const [, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);
  const invokeCommandRef = useRef<(commandId: string) => void>(() => undefined);
  const documentRef = useRef(document);
  const documentHistoryRef = useRef<DocumentHistory>(documentHistory);
  const fileStateRef = useRef<NativeFileState>(fileState);
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

  documentRef.current = document;
  documentHistoryRef.current = documentHistory;
  fileStateRef.current = fileState;
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
  // Clears the transient interaction "chrome" — open editors, hover highlights, and in-flight
  // previews — without touching the selection or document. Many interaction entry points reset
  // exactly this set before starting a new gesture; collapsing it here removes the copy-pasted
  // block where a missed setter would otherwise strand a stale editor/highlight. Every setter
  // is an idempotent clear, so calling it is always safe.
  const clearTransientInteractionChrome = useCallback(() => {
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, [assignHoveredNativeDeleteTarget]);
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
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(currentDocument, selectedNativeMoleculePart);
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

  // ── 3D spin (Phase 4) ──────────────────────────────────────────────────────
  const applySpin = useCallback((next: Spin3dState | undefined) => {
    spin3dStateRef.current = next;
    setSpin3dStateRender(next);
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

  /** Compute the overlay placement for a conformer against the molecule's drawn 2D geometry. */
  const spinPlacementFor = useCallback((molecule: MoleculeObject, coords3d: Float64Array): {
    bondPairs: [number, number][];
    placement: ScreenPlacement;
  } => {
    const atomIndex = new Map(molecule.atoms.map((atom, index) => [atom.id, index] as const));
    const bondPairs: [number, number][] = [];
    for (const bond of molecule.bonds) {
      const from = atomIndex.get(bond.fromAtomId);
      const to = atomIndex.get(bond.toAtomId);
      if (from !== undefined && to !== undefined) bondPairs.push([from, to]);
    }
    const points2d = molecule.atoms.map((atom) => ({ x: atom.x, y: atom.y }));
    const centerX = points2d.reduce((sum, p) => sum + p.x, 0) / points2d.length;
    const centerY = points2d.reduce((sum, p) => sum + p.y, 0) / points2d.length;
    const scale = overlayScale(points2d, coords3d, bondPairs);
    return { bondPairs, placement: { centerX, centerY, scale } };
  }, []);

  const startSpin3d = useCallback(async () => {
    const currentDocument = documentRef.current;
    const selectedIds = [
      ...new Set([
        ...currentDocument.selection.objectIds,
        ...(selectedNativeMoleculePart ? [selectedNativeMoleculePart.objectId] : [])
      ])
    ];
    if (selectedIds.length !== 1) {
      setStatus("Select a single molecule to spin in 3D");
      return;
    }
    const objectId = selectedIds[0];
    const molecule = currentDocument.pages[0]?.objects.find(
      (object): object is MoleculeObject => object.id === objectId && object.type === "molecule"
    );
    if (!molecule || !isNativeMoleculeGraph(molecule) || molecule.atoms.length < 2) {
      setStatus("Spin 3D needs an editable molecule");
      return;
    }

    setStatus("Generating 3D conformer…");
    // Document is y-down; the molfile/engine frame is y-up → fromDocFrame negates y.
    const molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true });
    const requestToken = ++spin3dRequestRef.current;

    // Stage 1 — the embedded conformer is fully manipulable; the overlay goes up NOW.
    const handleEmbedded = (conformer: Generate3DConformerResult): void => {
      if (conformer.embed.status !== "ok") {
        setStatus(`Could not generate a 3D conformer: ${conformer.embed.failureReason ?? "unknown"}`);
        return;
      }
      // Spin may only begin if the molecule is still selected and unchanged.
      if (documentRef.current.pages[0]?.objects.find((object) => object.id === objectId) !== molecule) {
        setStatus("Selection changed; spin cancelled");
        return;
      }
      const coords3d = conformer.mapping.coords3dByOriginalAtom;
      const { bondPairs, placement } = spinPlacementFor(molecule, coords3d);
      applySpin({
        objectId,
        // Open at a readable angle (principal plane toward the viewer + gentle tilt),
        // not the engine's arbitrary — often edge-on — embedding orientation.
        quat: initialViewQuaternion(coords3d),
        coords3d,
        bondPairs,
        atomElements: molecule.atoms.map((atom) => atom.element),
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
      const coords3d = conformer.mapping.coords3dByOriginalAtom;
      const { bondPairs, placement } = spinPlacementFor(molecule, coords3d);
      applySpin({ ...state, coords3d, bondPairs, placement });
    };

    const runInPage = async (): Promise<void> => {
      try {
        const ocl = await import("@chemdraft/ocl-adapter");
        const { oclResourcesUrl } = await import("./oclResources");
        ocl.setOclResourcesUrl(oclResourcesUrl);
        const { embedded, refine } = await ocl.generate3DConformerProgressive(
          { molfile, originalAtomCount: molecule.atoms.length },
          { optimize: "auto", maxMinimiseIterations: 800 }
        );
        if (spin3dRequestRef.current !== requestToken) return;
        handleEmbedded(embedded);
        if (embedded.embed.status !== "ok" || !refine) return;
        // Let the overlay paint before the synchronous minimise blocks this thread.
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (spin3dRequestRef.current !== requestToken) return;
        handleRefined(refine());
      } catch (error) {
        setStatus(`3D spin unavailable: ${(error as Error).message}`);
      }
    };

    const client = getConformerWorkerClient();
    if (client) {
      client.generate(molfile, molecule.atoms.length, {
        onEmbedded: (result) => {
          if (spin3dRequestRef.current === requestToken) handleEmbedded(result);
        },
        onRefined: handleRefined,
        onError: () => {
          // Worker died or misbehaved — recover via the in-page path.
          if (spin3dRequestRef.current === requestToken) void runInPage();
        }
      });
      return;
    }
    await runInPage();
  }, [applySpin, selectedNativeMoleculePart, spinPlacementFor]);

  // Warm the conformer worker (OCL module + torsion resources + JIT) at app idle so
  // the first spin click never pays the ~2s cold-start.
  useEffect(() => {
    const timer = setTimeout(() => getConformerWorkerClient()?.warmup(), 1500);
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
    const timer = setTimeout(() => {
      const client = getConformerWorkerClient();
      if (!client) return;
      const molfile = moleculeToMolfileV2000(molecule, { fromDocFrame: true });
      if (lastSpinPrefetchRef.current === molfile) return;
      lastSpinPrefetchRef.current = molfile;
      client.warmup();
      client.prefetch(molfile, molecule.atoms.length);
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
    const trackball = {
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      radius: Math.max(120, Math.min(rect.width, rect.height) * 0.4)
    };
    const current = { x: event.clientX, y: event.clientY };
    const quat = applyTrackballDrag(state.quat, state.lastClient, current, trackball);
    applySpin({ ...state, quat, lastClient: current });
  }, [applySpin]);

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
    resetDocumentHistory(resolvedOpen.document, {
      path,
      dirty: false,
      lastSavedPayloadHash: sha256Utf8Hex(contents)
    });
    clearDocumentInteractionState();
    setStatus(formatOpenStatus(displayName, resolvedOpen.source, opened.warnings, resolvedOpen.statusSourceLabel));
  }, [clearDocumentInteractionState, resetDocumentHistory]);

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
        if (action.id === "export.svg") {
          const result = exportPhase4Svg(document);
          downloadText(createExportFilename(document, "svg"), result.contents, "image/svg+xml");
          setStatus(result.warnings.length > 0 ? `Exported SVG with ${result.warnings.length} warning(s)` : "Exported SVG");
        }
        if (action.id === "export.png") {
          const result = exportPhase4Svg(document);
          const blob = await svgToPngBlob(result.contents, { width: activePage.width, height: activePage.height });
          downloadBlob(createExportFilename(document, "png"), blob);
          setStatus(result.warnings.length > 0 ? `Exported PNG with ${result.warnings.length} warning(s)` : "Exported PNG");
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
    cleanUpSelectedStructure,
    startSpin3d,
    commitDocumentChange,
    deleteHoveredNativeTarget,
    document,
    layerActions,
    nativePalette,
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

    void registry.invoke(commandId).catch(() => {
      setStatus("Command unavailable");
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcutTarget(event.target) || event.defaultPrevented) {
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
  }, [selectedNativeMoleculePart, shortcutRegistry]);

  // Esc cancels an active 3D spin (transient; never touched the document).
  useEffect(() => {
    const handleSpinEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && spin3dStateRef.current) {
        event.preventDefault();
        event.stopPropagation();
        endSpin3d("Spin cancelled");
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

  // Rotate or scale the whole selected group about its shared center, reusing the same
  // angle/scale math as the single-object transforms but fanning out to every member.
  const groupTransformDocument = useCallback((
    drag: GroupTransformDragState,
    point: ClientPoint,
    stretch = false
  ): ChemDraftDocument => {
    if (drag.mode === "rotate") {
      const degrees = rotationDeltaDegrees(drag.center, drag.startPoint, point);
      return rotateDocumentObjectsAroundPoint(drag.startDocument, drag.objectIds, drag.center, degrees);
    }
    const scale = moleculeResizeScaleFromDrag(drag.center, drag.startPoint, point, stretch);
    return scaleDocumentObjectsAroundPoint(drag.startDocument, drag.objectIds, drag.center, scale.x, scale.y);
  }, []);

  const handleGroupTransformPointerDown = useCallback((
    mode: "rotate" | "resize",
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }
    const ids = document.selection.objectIds;
    const point = pagePointFromPointerEvent(event);
    const bounds = ids.length > 1 ? selectionBounds(document.pages[0].objects, ids) : undefined;
    if (!point || !bounds) {
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
      dragKind: mode === "rotate" ? "group-rotate" : "group-resize"
    });
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(mode === "rotate" ? "Rotate selected group" : "Resize selected group");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    document,
    pagePointFromPointerEvent
  ]);

  const handleGroupRotatePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) =>
    handleGroupTransformPointerDown("rotate", event), [handleGroupTransformPointerDown]);
  const handleGroupResizePointerDown = useCallback((_corner: MoleculeResizeCorner) =>
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
        replacePresentDocument(groupTransformDocument(groupTransform, point, event.shiftKey));
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

    updateNativeCanvasHover(document, pagePointFromPointerEvent(event), event.target);
  }, [
    document,
    groupTransformDocument,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
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
        const next = groupTransformDocument(groupTransform, point, event.shiftKey);
        if (next !== groupTransform.startDocument) {
          const currentHistory = documentHistoryRef.current;
          installDocumentHistory({
            past: [...currentHistory.past, groupTransform.startDocument].slice(-DOCUMENT_HISTORY_LIMIT),
            present: next,
            future: []
          });
        }
        setStatus(groupTransform.mode === "rotate" ? "Rotated selection" : "Resized selection");
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
    clearNativePlacementDrag,
    clearTextResize,
    commitNativePlacementDrag,
    commitNativePartDrag,
    commitTextResize,
    commitObjectDrag,
    commitObjectRotateDrag,
    cycleNativeBondOrder,
    document.pages,
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
  }, [clearNativePartDrag, clearNativePlacementDrag, clearObjectRotateDrag, clearTextResize, replacePresentDocument]);

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
    pagePointFromPointerEvent,
    replacePresentDocument,
    restoreToolAfterTextPlacement,
    selectedNativeMoleculePart,
    startAtomLabelEdit
  ]);

  // Whole-molecule double-click, callable from any selection-tool pointer-down entry point.
  // At low zoom the first press selects a part and the molecule is small enough that the
  // transform/resize/rotate handles blanket it, so the SECOND press of the double-click can
  // land on a handle instead of the canvas. Sharing this through every entry point (object,
  // page, resize handle, rotate handle) makes the gesture work regardless of where press 2
  // lands. Returns true when it consumed the press as a whole-molecule selection.
  const tryWholeMoleculeDoublePress = useCallback((
    objectId: string,
    event: { clientX: number; clientY: number; detail?: number }
  ): boolean => {
    const press = { time: Date.now(), x: event.clientX, y: event.clientY, objectId };
    const isDouble = (event.detail ?? 0) >= 2 || isSelectionDoublePress(lastSelectionPressRef.current, press);
    lastSelectionPressRef.current = press;
    if (!isDouble) {
      return false;
    }
    replacePresentDocument((current) => selectDocumentObject(current, objectId));
    setSelectedNativeMoleculePart(undefined);
    clearTransientInteractionChrome();
    setStatus("Selected molecule");
    return true;
  }, [assignHoveredNativeDeleteTarget, replacePresentDocument]);

  const handleObjectRotatePointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const object = findDocumentObject(document, objectId);
    if (object?.type === "molecule" && tryWholeMoleculeDoublePress(objectId, event)) {
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

    const selectedDocument = document.selection.objectIds.includes(objectId)
      ? document
      : selectDocumentObject(document, objectId);
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
      centerPoint: selectedFragmentBounds ? documentObjectCenter(selectedFragmentBounds) : documentObjectCenter(object),
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
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart,
    tryWholeMoleculeDoublePress
  ]);

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
    if (object?.type === "molecule" && tryWholeMoleculeDoublePress(objectId, event)) {
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

    const selectedDocument = document.selection.objectIds.includes(objectId)
      ? document
      : selectDocumentObject(document, objectId);
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
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart,
    tryWholeMoleculeDoublePress
  ]);

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
                {(() => {
                  const groupSelectionActive = activeToolState.activeKind === "selection" &&
                    document.selection.objectIds.length > 1 &&
                    !selectedNativeMoleculePart;
                  const groupSelectionBounds = groupSelectionActive
                    ? selectionBounds(document.pages[0].objects, document.selection.objectIds)
                    : undefined;
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
                      resizeReadout={moleculeResizeReadout?.objectId === object.id ? moleculeResizeReadout : undefined}
                      onPointerDown={handleObjectPointerDown}
                      onPointerMove={handleObjectPointerMove}
                      onPointerUp={handleObjectPointerUp}
                      onPointerCancel={handleObjectPointerCancel}
                      onPointerLeave={handleObjectPointerLeave}
                      onRotatePointerDown={handleObjectRotatePointerDown}
                      onMoleculeResizePointerDown={handleMoleculeResizePointerDown}
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
                    onRotateStart={handleGroupRotatePointerDown}
                    onResizeStart={handleGroupResizePointerDown}
                  />
                ) : null}
                {spin3dState ? (
                  <SpinOverlay
                    state={spin3dState}
                    pageWidth={activePage.width}
                    pageHeight={activePage.height}
                    onPointerDown={handleSpinOverlayPointerDown}
                    onPointerMove={handleSpinOverlayPointerMove}
                    onPointerUp={handleSpinOverlayPointerUp}
                    onPointerCancel={handleSpinOverlayPointerUp}
                  />
                ) : null}
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
        <div style={{ position: "absolute", bottom: 8, right: 8, color: "var(--cd-text-secondary)", opacity: 0.5, pointerEvents: "none", fontSize: 10, zIndex: 1000 }}>
          Build {__BUILD_STAMP__}
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
  const tangentialDelta =
    (dragVector.x * tangent.x + dragVector.y * tangent.y) * OBJECT_ROTATE_TANGENTIAL_DEGREES_PER_PIXEL;
  const delta = Math.abs(tangentialDelta) > Math.abs(angularDelta) ? tangentialDelta : angularDelta;

  return Number(delta.toFixed(3));
}

export function nativePlacementRotationDegrees(start: ClientPoint, latest: ClientPoint): number {
  const dx = latest.x - start.x;
  const dy = latest.y - start.y;
  if (Math.hypot(dx, dy) <= 0.001) {
    return 0;
  }

  return Number((Math.atan2(dy, dx) * 180 / Math.PI).toFixed(3));
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
interface Spin3dState {
  objectId: string;
  quat: Quaternion;
  coords3d: Float64Array;
  bondPairs: [number, number][];
  atomElements: string[];
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
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel
}: {
  state: Spin3dState;
  pageWidth: number;
  pageHeight: number;
  onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerUp: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerCancel: (event: PointerEvent<SVGSVGElement>) => void;
}) {
  const projection = projectSpin(state.coords3d, state.bondPairs, state.quat, state.placement);
  const depths = projection.atoms.map((atom) => atom.depth);
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  const depthSpan = maxDepth - minDepth || 1;
  // Nearer bonds render heavier and darker so occlusion reads while spinning.
  const nearness = (depth: number) => (depth - minDepth) / depthSpan; // 0 far … 1 near
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
        const t = nearness(bond.depth);
        const shade = Math.round(150 - t * 120); // far=lighter grey, near=darker
        return (
          <line
            key={`${bond.from}-${bond.to}-${index}`}
            x1={a.sx}
            y1={a.sy}
            x2={b.sx}
            y2={b.sy}
            stroke={`rgb(${shade}, ${shade}, ${shade})`}
            strokeWidth={1.2 + t * 1.6}
            strokeLinecap="round"
          />
        );
      })}
      {projection.atoms.map((atom) => (
        <circle key={atom.index} cx={atom.sx} cy={atom.sy} r={1.6 + nearness(atom.depth) * 1.8} fill="var(--cd-accent, #2d6cdf)" />
      ))}
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

// One bounding box + rotate/resize handles around a multi-object selection, so the
// whole group can be rotated or scaled as one. Reuses the per-molecule handle classes.
function GroupSelectionOverlay({
  bounds,
  onRotateStart,
  onResizeStart
}: {
  bounds: SelectionBounds;
  onRotateStart(event: PointerEvent<HTMLButtonElement>): void;
  onResizeStart(corner: MoleculeResizeCorner): (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      className="native-molecule-transform-frame group-selection-frame"
      data-group-selection="true"
      style={{
        left: `calc(${bounds.x}px * var(--page-scale))`,
        top: `calc(${bounds.y}px * var(--page-scale))`,
        width: `calc(${bounds.width}px * var(--page-scale))`,
        height: `calc(${bounds.height}px * var(--page-scale))`
      }}
    >
      <MoleculeResizeHandles targetLabel="selected group" onResizeStart={onResizeStart} />
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
  editingText,
  editingAtomLabel,
  chargeByAtomId,
  growthPreview,
  deleteTarget,
  hoverDestructive,
  freeformPreview,
  doubleBondSidePreview,
  rotateReadout,
  resizeReadout,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onRotatePointerDown,
  onMoleculeResizePointerDown,
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
  editingText: boolean;
  editingAtomLabel?: AtomLabelEditState;
  chargeByAtomId?: ReadonlyMap<string, number>;
  growthPreview?: HoveredNativeAtom;
  deleteTarget?: NativeMoleculeDeleteTarget;
  hoverDestructive: boolean;
  freeformPreview?: FreeformNativeBondPreview;
  doubleBondSidePreview?: NativeDoubleBondSidePreview;
  rotateReadout?: ObjectRotateReadoutState;
  resizeReadout?: MoleculeResizeReadoutState;
  onPointerDown(objectId: string, event: ObjectPointerEvent): void;
  onPointerMove(objectId: string, event: ObjectPointerEvent): void;
  onPointerUp(objectId: string, event: ObjectPointerEvent): void;
  onPointerCancel(event: ObjectPointerEvent): void;
  onPointerLeave(objectId: string): void;
  onRotatePointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onMoleculeResizePointerDown(objectId: string, corner: MoleculeResizeCorner, event: PointerEvent<HTMLButtonElement>): void;
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
  const handleMoleculeResizePointerDown = (corner: MoleculeResizeCorner) => (event: PointerEvent<HTMLButtonElement>) => {
    onMoleculeResizePointerDown(object.id, corner, event);
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
      const transformFrame = hasVisibleSelectionTargets && !inGroupSelection && (selected || selectedFragmentBounds)
        ? moleculeTransformFrameForSelection(object, selectedFragmentBounds)
        : undefined;
      const transformTargetLabel = selectedFragmentBounds ? "selected molecule fragment" : "selected molecule";
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
              style={transformFrameStyle}
            >
              <MoleculeResizeHandles
                targetLabel={transformTargetLabel}
                onResizeStart={handleMoleculeResizePointerDown}
              />
              {resizeReadout ? (
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
              >
                <RotateSelectionIcon />
                {rotateReadout ? (
                  <RotateSelectionReadout degrees={rotateReadout.degrees} />
                ) : null}
              </button>
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

function MoleculeResizeHandles({
  targetLabel,
  onResizeStart
}: {
  targetLabel: string;
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
        />
      ))}
    </>
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

async function readNativeTextFile(path: string): Promise<string> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  return readTextFile(path);
}

async function writeNativeTextFile(path: string, contents: string): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(path, contents);
}

function ensureChemDraftFileExtension(path: string): string {
  return /\.(chemdraft|cdxml)$/i.test(path) ? path : `${path}.chemdraft`;
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

async function svgToPngBlob(svg: string, fallbackSize: { width: number; height: number }): Promise<Blob> {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not render SVG for PNG export."));
      image.src = url;
    });

    const canvas = globalThis.document.createElement("canvas");
    const size = resolvePngCanvasSize(image.naturalWidth, image.naturalHeight, fallbackSize);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create canvas context for PNG export.");
    }

    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Could not encode PNG export."));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function resolvePngCanvasSize(
  naturalWidth: number,
  naturalHeight: number,
  fallbackSize: { width: number; height: number }
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(naturalWidth || fallbackSize.width)),
    height: Math.max(1, Math.round(naturalHeight || fallbackSize.height))
  };
}

function createExportFilename(document: ChemDraftDocument, extension: "svg" | "png"): string {
  const baseName = document.title.replace(/\.chemdraft$/i, "").trim().replace(/[^a-z0-9._-]+/gi, "-") || "Untitled";
  return `${baseName}.${extension}`;
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
