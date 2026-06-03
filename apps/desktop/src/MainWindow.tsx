import {
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
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent
} from "react";
import {
  DefaultNativeTextStyle,
  createDocumentHistory,
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  redo as redoDocumentHistory,
  undo as undoDocumentHistory,
  type ChemDraftDocument,
  type DocumentHistory,
  type DocumentObject,
  type MoleculeObject,
  type NativeDrawingStyle,
  type NativeTextStyle
} from "@chemdraft/chem-core";
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
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  atomElementActions,
  atomElementCommandId,
  createLayerActions,
  createQuickActions,
  editActions,
  pageOrientationActions,
  pageSizeActions,
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
  withStandaloneDrawingToolCommands
} from "./drawingTools";
import { clipboardPayloadFromDataTransfer, readClipboardPayload } from "./clipboard";
import {
  applyClipboardPastePayload,
  applyNativeAtomElementTarget,
  applyChargeToolAtPoint,
  applyChargeToolAtNativeAtom,
  applyNativeDoubleBondSideTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeDeleteTarget,
  applyEditorSaveResultToSelectedMolecule,
  applyAnalysisToSelectedMolecule,
  applyFreeformSingleBondToolAtPoint,
  applySingleBondToolAtPoint,
  applySingleBondToolAtNativeAtom,
  createNativeSavePayload,
  createPhase4Document,
  deleteSelectedDocumentObjects,
  exportPhase4Svg,
  findNativeMoleculeDeleteHit,
  getSelectedMolecule,
  getSelectedTextObject,
  insertNativeTextObject,
  nativeAtomDisplayLabel,
  nativeChargeAssociationsForMolecule,
  nativeChargeByAtomIdFromAssociations,
  nativeElementFromKeyboardKey,
  nativeMoleculeInvalidAtomStates,
  moveDocumentObject,
  moveNativeMoleculeParts,
  openNativeDocument,
  previewNativeMoleculeBondGrowth,
  previewNativeMoleculeFreeformBondGrowth,
  reorderNativeMoleculeParts,
  reorderSelectedDocumentObject,
  resizeNativeTextObjectBox,
  rotateDocumentObject,
  selectDocumentObject,
  selectDocumentObjects,
  setDocumentPageOrientation,
  setDocumentPageSize,
  updateNativeTextObjectStyle,
  updateNativeTextObjectText,
  type NativeMoleculeDeleteHit,
  type NativeDoubleBondSide,
  type NativeMoleculeDeleteTarget,
  type NativeBondOrderTarget,
  type NativeChargeValue,
  type NativeSingleLetterElement
} from "./documentWorkflow";
import { KetcherEditorHost } from "./KetcherEditorHost";
import { ToolPalette } from "./ToolPalette";
import {
  DEFAULT_TOOLSET_ID,
  isDesktopRuntime,
  listToolsetWindowStates,
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

type PaletteMode = "floating" | "hidden";
type PalettePosition = { x: number; y: number };
type ClientPoint = { x: number; y: number };
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
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
  freeformUnlocked: boolean;
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
  dragging: boolean;
};
type ObjectRotateDragState = {
  pointerId: number;
  objectId: string;
  startDocument: ChemDraftDocument;
  centerPoint: ClientPoint;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
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
export type NativeMoleculeSelectionPart =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "parts"; atomIds: readonly string[]; bondIds: readonly string[] };
type NativePartDragState = {
  pointerId: number;
  objectId: string;
  target: NativeMoleculeSelectionPart;
  startDocument: ChemDraftDocument;
  startPoint: ClientPoint;
  latestPoint: ClientPoint;
  dragging: boolean;
};
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
  x: number;
  y: number;
};
type LayerContextMenuItem = {
  commandId: string;
  label: string;
};

const RULER_THICKNESS = 32;
const FREEFORM_BOND_DRAG_THRESHOLD = 6;
const DOUBLE_BOND_SIDE_DRAG_THRESHOLD = 4;
const DOUBLE_BOND_MIN_VISIBLE_SEGMENT_PX = 13;
const OBJECT_DRAG_THRESHOLD = 4;
const DOCUMENT_HISTORY_LIMIT = 100;
const layerContextMenuItems: readonly LayerContextMenuItem[] = [
  { commandId: "layout.bringForward", label: "Move Forward" },
  { commandId: "layout.bringToFront", label: "Move to Front" },
  { commandId: "layout.sendBackward", label: "Move Backward" },
  { commandId: "layout.sendToBack", label: "Move to Back" }
];

export interface MainWindowProps {
  initialPaletteMode?: PaletteMode;
  initialRulersVisible?: boolean;
  initialCrosshairsVisible?: boolean;
  initialDocument?: ChemDraftDocument;
  nativePalette?: boolean;
}

export function MainWindow({
  initialPaletteMode = "floating",
  initialRulersVisible = true,
  initialCrosshairsVisible = true,
  initialDocument,
  nativePalette = isDesktopRuntime()
}: MainWindowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRegionRef = useRef<HTMLElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const webPaletteDragRef = useRef<PaletteDragState | null>(null);
  const nativeBondDragRef = useRef<NativeBondDragState | null>(null);
  const nativeBondEditDragRef = useRef<NativeBondEditDragState | null>(null);
  const nativePartDragRef = useRef<NativePartDragState | null>(null);
  const objectDragRef = useRef<ObjectDragState | null>(null);
  const objectRotateDragRef = useRef<ObjectRotateDragState | null>(null);
  const textResizeRef = useRef<TextResizeState | null>(null);
  const selectionMarqueeRef = useRef<SelectionMarqueeState | null>(null);
  const hoveredNativeAtomPointRef = useRef<{ objectId: string; point: ClientPoint } | undefined>(undefined);
  const gestureStartScaleRef = useRef(1);
  const chemistryAdapter = useMemo(() => createRdkitPlaceholderAdapter(), []);
  const [documentHistory, setDocumentHistory] = useState(() =>
    createDocumentHistory(initialDocument ?? createPhase4Document())
  );
  const document = documentHistory.present;
  const [activeEditorObjectId, setActiveEditorObjectId] = useState<string | undefined>();
  const [activeTextEditObjectId, setActiveTextEditObjectId] = useState<string | undefined>();
  const [activeAtomLabelEdit, setActiveAtomLabelEdit] = useState<AtomLabelEditState | undefined>();
  const [textStyleDefaults, setTextStyleDefaults] = useState<NativeTextStyle>(DefaultNativeTextStyle);
  const [activeToolState, setActiveToolState] = useState(() => createActiveToolState());
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
  const [selectedNativeMoleculePart, setSelectedNativeMoleculePart] = useState<NativeMoleculeSelectionPart | undefined>();
  const [selectionMarquee, setSelectionMarquee] = useState<SelectionMarqueeState | undefined>();
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenuState | undefined>();
  const [freeformNativeBond, setFreeformNativeBond] = useState<FreeformNativeBondPreview | undefined>();
  const [nativeDoubleBondSidePreview, setNativeDoubleBondSidePreview] = useState<NativeDoubleBondSidePreview | undefined>();
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
  const hoveredNativeDeleteTargetRef = useRef<NativeMoleculeDeleteTarget | undefined>(undefined);
  const viewportRef = useRef(viewport);

  documentRef.current = document;
  documentHistoryRef.current = documentHistory;
  hoveredNativeDeleteTargetRef.current = hoveredNativeDeleteTarget;

  const selectedMolecule = getSelectedMolecule(document);
  const selectedTextObject = getSelectedTextObject(document);
  const activeEditorMolecule =
    selectedMolecule && selectedMolecule.id === activeEditorObjectId ? selectedMolecule : undefined;
  const bondToolActive = activeToolState.activeCommandId === "tool.bond";
  const activeChargeToolValue = chargeValueForToolCommand(activeToolState.activeCommandId);
  const activePage = document.pages[0];
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
        "--page-layout-height": `${activePage.height}px`
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
  const installDocumentHistory = useCallback((history: DocumentHistory) => {
    documentHistoryRef.current = history;
    documentRef.current = history.present;
    setDocumentHistory(history);
  }, []);
  const resetDocumentHistory = useCallback((nextDocument: ChemDraftDocument) => {
    installDocumentHistory(createDocumentHistory(nextDocument));
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
    const focalPagePoint = {
      x: (clientPoint.x - pageRect.left) / currentScale,
      y: (clientPoint.y - pageRect.top) / currentScale
    };

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
      const nextClientPoint = {
        x: nextPageRect.left + focalPagePoint.x * viewportRef.current.scale,
        y: nextPageRect.top + focalPagePoint.y * viewportRef.current.scale
      };

      nextCanvas.scrollLeft += nextClientPoint.x - clientPoint.x;
      nextCanvas.scrollTop += nextClientPoint.y - clientPoint.y;
    });
  }, []);

  const handleCanvasWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    zoomCanvasAtClientPoint(viewportRef.current.scale * wheelDeltaToZoomFactor(event.deltaY), {
      x: event.clientX,
      y: event.clientY
    });
  }, [zoomCanvasAtClientPoint]);

  useEffect(() => {
    const canvas = canvasRegionRef.current;
    if (!canvas) {
      return undefined;
    }

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartScaleRef.current = viewportRef.current.scale;
    };
    const handleGestureChange = (event: Event) => {
      const gesture = event as WebKitGestureEvent;
      event.preventDefault();
      zoomCanvasAtClientPoint(
        gestureStartScaleRef.current * (gesture.scale ?? 1),
        clientPointFromGesture(gesture, canvas)
      );
    };

    canvas.addEventListener("gesturestart", handleGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", handleGestureChange, { passive: false });

    return () => {
      canvas.removeEventListener("gesturestart", handleGestureStart);
      canvas.removeEventListener("gesturechange", handleGestureChange);
    };
  }, [zoomCanvasAtClientPoint]);

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

  const startHoveredAtomLabelEdit = useCallback((): boolean => {
    const target = hoveredNativeDeleteTargetRef.current
      ?? nativeDeleteTargetFromSelectionPart(documentRef.current, selectedNativeMoleculePart);
    return target?.kind === "atom" ? startAtomLabelEdit(target, { clearDraft: true }) : false;
  }, [selectedNativeMoleculePart, startAtomLabelEdit]);

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

  const applyTextDocumentAtPoint = useCallback((point: ClientPoint) => {
    const currentDocument = documentRef.current;
    const nextDocument = insertNativeTextObject(currentDocument, point, "Text", textStyleDefaults);
    const inserted = getSelectedTextObject(nextDocument);
    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(inserted?.id);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setSelectedNativeMoleculePart(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setStatus("Inserted text");
  }, [assignHoveredNativeDeleteTarget, commitDocumentChange, textStyleDefaults]);

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
    setStatus("Editing text");
  }, [assignHoveredNativeDeleteTarget, replacePresentDocument]);

  const applyTextStyleCommand = useCallback((commandId: string): boolean => {
    const currentDocument = documentRef.current;
    const selected = getSelectedTextObject(currentDocument);
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

    if (selected) {
      const changed = commitDocumentChange(updateNativeTextObjectStyle(currentDocument, selected.id, stylePatch));
      setActiveTextEditObjectId((current) => current === selected.id ? current : undefined);
      setActiveEditorObjectId(undefined);
      setStatus(changed ? "Updated selected text style" : "Selected text style unchanged");
      return true;
    }

    setStatus("Updated text defaults");
    return true;
  }, [commitDocumentChange, textStyleDefaults]);

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
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    setFreeformNativeBond(undefined);
    setLastAnalysis(null);
    setStatus(direction === "undo" ? "Undid last document change" : "Redid document change");
  }, [assignHoveredNativeDeleteTarget, installDocumentHistory]);

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
        if (action.id === "document.open") {
          fileInputRef.current?.click();
        }
        if (action.id === "document.save") {
          const payload = createNativeSavePayload(document);
          downloadText(payload.filename, payload.contents, payload.mimeType);
          setStatus(`Saved ${payload.filename}`);
        }
        if (action.id === "clipboard.paste") {
          await pasteClipboard();
        }
        if (action.id === "view.zoomOut") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale - 0.1, pageCenterPoint(current, activePage)));
        }
        if (action.id === "view.zoomIn") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale + 0.1, pageCenterPoint(current, activePage)));
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
          selectedNativeMoleculePart
            ? reorderNativeMoleculeParts(current, selectedNativeMoleculePart, placement)
            : reorderSelectedDocumentObject(current, placement)
        );
        const partSelected = selectedNativeMoleculePart !== undefined;
        setStatus(changed
          ? partSelected ? `${action.title} selected molecule part` : action.title
          : partSelected ? "Selected molecule part cannot move layers" : "No selected object");
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

        if (tool.id === "tool.text" && startHoveredAtomLabelEdit()) {
          return;
        }

        if (applyTextStyleCommand(tool.id)) {
          return;
        }

        if (!isDrawingToolCommand(tool.id)) {
          setStatus(`${tool.title} command routed`);
          return;
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
    addSingleBondToHoveredNativeAtom,
    applyTextStyleCommand,
    assignHoveredNativeDeleteTarget,
    chemistryAdapter,
    commitDocumentChange,
    deleteHoveredNativeTarget,
    document,
    layerActions,
    nativePalette,
    pasteClipboard,
    quickActions,
    resetDocumentHistory,
    restoreDocumentHistory,
    selectedNativeMoleculePart,
    startHoveredAtomLabelEdit,
    setHoveredNativeAtomElement,
    toggleToolset,
    toolCommandSpecs,
    toolsetRegistry
  ]);

  const invoke = useCallback((commandId: string) => {
    void registry.invoke(commandId).catch(() => {
      setStatus("Command unavailable");
    });
  }, [registry]);

  invokeCommandRef.current = invoke;

  useEffect(() => {
    if (!activeTextEditObjectId) {
      return;
    }

    const focusHandle = window.setTimeout(() => {
      const editor = pageRef.current?.querySelector<HTMLTextAreaElement>(
        `[data-object-id="${activeTextEditObjectId}"] .text-object-editor`
      );
      if (!editor) {
        return;
      }

      editor.focus();
      if (editor.value === "Text") {
        editor.select();
      }
    });

    return () => {
      window.clearTimeout(focusHandle);
    };
  }, [activeTextEditObjectId, document]);

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
        const target = hoveredNativeDeleteTargetRef.current;
        if (target?.kind === "atom") {
          if (event.key === "1") {
            event.preventDefault();
            invokeCommandRef.current("atom.addSingleBondToHoveredAtom");
            return;
          }

          if (event.key === "+") {
            event.preventDefault();
            invokeCommandRef.current("atom.addPositiveChargeToHoveredAtom");
            return;
          }

          if (event.key === "-") {
            event.preventDefault();
            invokeCommandRef.current("atom.addNegativeChargeToHoveredAtom");
            return;
          }
        }

        const element = nativeElementFromKeyboardKey(event.key);
        if (element && target?.kind === "atom") {
          event.preventDefault();
          invokeCommandRef.current(atomElementCommandId(element));
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
  }, [shortcutRegistry]);

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
    void listenForToolsetCommands((commandId) => invokeCommandRef.current(commandId))
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

    return () => {
      unlisten?.();
      unlistenState?.();
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
        const opened = openNativeDocument(contents);
        resetDocumentHistory(opened);
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        assignHoveredNativeDeleteTarget(undefined);
        setFreeformNativeBond(undefined);
        setLastAnalysis(null);
        setStatus(`Opened ${file.name}`);
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

  const pagePointFromPointerEvent = useCallback((event: { clientX: number; clientY: number }): ClientPoint | undefined => {
    const page = pageRef.current;
    if (!page) {
      return undefined;
    }

    const rect = page.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / viewportRef.current.scale,
      y: (event.clientY - rect.top) / viewportRef.current.scale
    };
  }, []);

  const applySingleBondDocumentAtPoint = useCallback((sourceDocument: ChemDraftDocument, point: ClientPoint) => {
    const nextDocument = applySingleBondToolAtPoint(sourceDocument, point);
    const selected = getSelectedMolecule(nextDocument);
    const atomCount = selected?.atoms.length ?? 0;
    commitDocumentChange(nextDocument);
    setActiveEditorObjectId(undefined);
    setActiveTextEditObjectId(undefined);
    setActiveAtomLabelEdit(undefined);
    setHoveredNativeAtom(undefined);
    setFreeformNativeBond(undefined);
    setStatus(atomCount > 2 ? `Extended carbon chain to ${atomCount} atoms` : "Inserted single bond molecule");
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
    forceCustomLength: boolean
  ) => {
    const previousMolecule = findDocumentObject(sourceDocument, objectId);
    const nextDocument = applyFreeformSingleBondToolAtPoint(sourceDocument, objectId, atomId, point, {
      forceCustomLength
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

  const updateNativeDeleteTarget = useCallback((
    sourceDocument: ChemDraftDocument,
    objectId: string,
    point: ClientPoint | undefined,
    eventTarget?: EventTarget | null
  ) => {
    if (!point) {
      assignHoveredNativeDeleteTarget(undefined);
      return;
    }

    const object = findDocumentObject(sourceDocument, objectId);
    if (object?.type !== "molecule") {
      assignHoveredNativeDeleteTarget(undefined);
      return;
    }

    const hit = nativeMoleculeHitFromPointerTarget(object, point, eventTarget);
    assignHoveredNativeDeleteTarget(hit ? { objectId, ...hit } : undefined);
    hoveredNativeAtomPointRef.current = hit?.kind === "atom" ? { objectId, point } : undefined;
  }, [assignHoveredNativeDeleteTarget]);

  const updateNativeDoubleBondSidePreview = useCallback((
    sourceDocument: ChemDraftDocument,
    objectId: string,
    point: ClientPoint | undefined,
    eventTarget?: EventTarget | null
  ) => {
    if (!bondToolActive || !point) {
      setNativeDoubleBondSidePreview(undefined);
      return;
    }

    const object = findDocumentObject(sourceDocument, objectId);
    if (object?.type !== "molecule") {
      setNativeDoubleBondSidePreview(undefined);
      return;
    }

    const hit = nativeMoleculeHitFromPointerTarget(object, point, eventTarget);
    setNativeDoubleBondSidePreview(hit
      ? nativeDoubleBondSidePreviewFromHit(objectId, object, hit, point)
      : undefined);
  }, [bondToolActive]);

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

  const clearNativeBondDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = nativeBondDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativeBondDragRef.current = null;
      setFreeformNativeBond(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearNativeBondEditDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = nativeBondEditDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      nativeBondEditDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const previewObjectDrag = useCallback((drag: ObjectDragState, point: ClientPoint) => {
    const nextDocument = moveDocumentObject(drag.startDocument, drag.objectId, {
      x: drag.startObjectX + point.x - drag.startPoint.x,
      y: drag.startObjectY + point.y - drag.startPoint.y
    });
    replacePresentDocument(nextDocument);
  }, [replacePresentDocument]);

  const objectRotateDocumentFromDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint): ChemDraftDocument =>
    rotateDocumentObject(drag.startDocument, drag.objectId, rotationDeltaDegrees(drag.centerPoint, drag.startPoint, point)),
  []);

  const previewObjectRotateDrag = useCallback((drag: ObjectRotateDragState, point: ClientPoint) => {
    drag.latestPoint = point;
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
    const moved = moveDocumentObject(drag.startDocument, drag.objectId, {
      x: drag.startObjectX + point.x - drag.startPoint.x,
      y: drag.startObjectY + point.y - drag.startPoint.y
    });
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
  }, [installDocumentHistory, replacePresentDocument]);

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

  const clearObjectDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = objectDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      objectDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  const clearObjectRotateDrag = useCallback((event: PointerEvent<HTMLElement>) => {
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

  const clearNativePartDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
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

  const clearTextResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
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

  const handlePagePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    setObjectContextMenu(undefined);
    const point = pagePointFromPointerEvent(event);
    if (!point) {
      return;
    }

    if (activeToolState.activeKind === "selection") {
      selectionMarqueeRef.current = {
        pointerId: event.pointerId,
        startPoint: point,
        latestPoint: point,
        dragging: false
      };
      setSelectedNativeMoleculePart(undefined);
      setActiveEditorObjectId(undefined);
      setActiveTextEditObjectId(undefined);
      setActiveAtomLabelEdit(undefined);
      setHoveredNativeAtom(undefined);
      setFreeformNativeBond(undefined);
      setNativeDoubleBondSidePreview(undefined);
      assignHoveredNativeDeleteTarget(undefined);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (activeChargeToolValue) {
      applyChargeDocumentAtPoint(activeChargeToolValue, point);
      return;
    }

    if (activeToolState.activeCommandId === "tool.text") {
      event.preventDefault();
      event.stopPropagation();
      applyTextDocumentAtPoint(point);
      return;
    }

    if (activeToolState.activeCommandId === "tool.bond") {
      applySingleBondDocumentAtPoint(document, point);
    }
  }, [
    activeChargeToolValue,
    activeToolState.activeCommandId,
    applyChargeDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    applyTextDocumentAtPoint,
    document,
    pagePointFromPointerEvent
  ]);

  const handlePageContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setObjectContextMenu(undefined);
  }, []);

  const handlePagePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
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
      if (!objectRotateDrag.dragging && clientPointDistance(objectRotateDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
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

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId) {
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

    const nativePartDrag = nativePartDragRef.current;
    if (nativePartDrag?.pointerId === event.pointerId) {
      const point = pagePointFromPointerEvent(event);
      if (!point) {
        return;
      }

      nativePartDrag.latestPoint = point;
      if (!nativePartDrag.dragging && clientPointDistance(nativePartDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        nativePartDrag.dragging = true;
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
      }

      if (nativePartDrag.dragging) {
        previewNativePartDrag(nativePartDrag, point);
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
      if (!marquee.dragging && clientPointDistance(marquee.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
        marquee.dragging = true;
      }
      setSelectionMarquee(marquee.dragging ? { ...marquee } : undefined);
      return;
    }

    assignHoveredNativeDeleteTarget(undefined);

    if (!bondToolActive) {
      setNativeDoubleBondSidePreview(undefined);
      return;
    }

    setNativeDoubleBondSidePreview(undefined);
    updateBondGrowthPreview(document, pagePointFromPointerEvent(event));
  }, [
    assignHoveredNativeDeleteTarget,
    bondToolActive,
    document,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
    previewNativePartDrag,
    previewTextResize,
    updateBondGrowthPreview
  ]);

  const handlePagePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
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
        const label = object?.type === "text" ? "text box" : "selected molecule";
        setStatus(changed ? `Rotated ${label}` : `${capitalizeLabel(label)} rotation unchanged`);
      }
      clearObjectRotateDrag(event);
      return;
    }

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = pagePointFromPointerEvent(event) ?? objectDrag.latestPoint;
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

    const marquee = selectionMarqueeRef.current;
    if (!marquee || marquee.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    const point = pagePointFromPointerEvent(event) ?? marquee.latestPoint;
    marquee.latestPoint = point;
    const selection = marquee.dragging
      ? selectionInSelectionRect(document.pages[0].objects, marquee.startPoint, point)
      : { objectIds: [], nativeSelection: undefined };
    replacePresentDocument((current) => selectDocumentObjects(current, current.pages[0].id, selection.objectIds));
    setSelectedNativeMoleculePart(selection.nativeSelection);
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
    clearTextResize,
    commitNativePartDrag,
    commitTextResize,
    commitObjectDrag,
    commitObjectRotateDrag,
    cycleNativeBondOrder,
    document.pages,
    pagePointFromPointerEvent,
    replacePresentDocument
  ]);

  const handlePagePointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const textResize = textResizeRef.current;
    if (textResize?.pointerId === event.pointerId) {
      replacePresentDocument(textResize.startDocument);
      clearTextResize(event);
    }

    const objectRotateDrag = objectRotateDragRef.current;
    if (objectRotateDrag?.pointerId === event.pointerId) {
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

    const marquee = selectionMarqueeRef.current;
    if (marquee?.pointerId === event.pointerId) {
      selectionMarqueeRef.current = null;
      setSelectionMarquee(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, [clearNativePartDrag, clearObjectRotateDrag, clearTextResize, replacePresentDocument]);

  const handlePagePointerLeave = useCallback(() => {
    if (nativeBondDragRef.current) {
      return;
    }

    if (selectionMarqueeRef.current) {
      return;
    }

    setHoveredNativeAtom(undefined);
    assignHoveredNativeDeleteTarget(undefined);
  }, []);

  const handleObjectPointerDown = useCallback((objectId: string, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    const object = findDocumentObject(document, objectId);
    const point = pagePointFromPointerEvent(event);
    const chargeMarkActive = object?.type === "electron-mark" && object.markKind === "charge";
    const nativeMoleculeHit = object?.type === "molecule" && point
      ? nativeMoleculeHitFromPointerTarget(object, point, event.target)
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

    if (activeToolState.activeKind === "selection" && object?.type === "molecule" && point) {
      if (event.detail >= 2 && nativeMoleculeHit) {
        event.stopPropagation();
        replacePresentDocument((current) => selectDocumentObject(current, objectId));
        setActiveEditorObjectId(undefined);
          setActiveTextEditObjectId(undefined);
          setActiveAtomLabelEdit(undefined);
          setHoveredNativeAtom(undefined);
          setFreeformNativeBond(undefined);
          setNativeDoubleBondSidePreview(undefined);
          assignHoveredNativeDeleteTarget(undefined);
          hoveredNativeAtomPointRef.current = undefined;
          setSelectedNativeMoleculePart(undefined);
        setStatus("Selected molecule");
        return;
      }

      const currentNativePart = selectedNativeMoleculePart?.objectId === objectId
        ? selectedNativeMoleculePart
        : undefined;
      if (nativeMoleculeHit && currentNativePart && nativeSelectionContainsHit(currentNativePart, nativeMoleculeHit)) {
        event.stopPropagation();
        const selectedDocument = document.selection.objectIds.includes(objectId)
          ? document
          : selectDocumentObject(document, objectId);
        replacePresentDocument(selectedDocument);
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
        hoveredNativeAtomPointRef.current = undefined;
        nativePartDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          target: currentNativePart,
          startDocument: selectedDocument,
          startPoint: point,
          latestPoint: point,
          dragging: false
        };
        (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
        return;
      }

      if (nativeMoleculeHit && isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart)) {
        event.stopPropagation();
        objectDragRef.current = {
          pointerId: event.pointerId,
          objectId,
          startDocument: document,
          startPoint: point,
          latestPoint: point,
          startObjectX: object.x,
          startObjectY: object.y,
          dragging: false
        };
        event.currentTarget.setPointerCapture(event.pointerId);
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
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }

    if (activeToolState.activeKind !== "selection" && object?.type === "molecule" && point) {
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
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    if (activeToolState.activeCommandId === "tool.bond" && object?.type === "molecule") {
      event.stopPropagation();
      if (!point) {
        return;
      }

      const page = document.pages[0];
      const preview = previewNativeMoleculeBondGrowth(object, point, page.width, page.height);
      if (!preview) {
        applySingleBondDocumentAtPoint(selectDocumentObject(document, objectId), point);
        return;
      }

      nativeBondDragRef.current = {
        pointerId: event.pointerId,
        objectId,
        atomId: preview.atomId,
        startPoint: point,
        latestPoint: point,
        dragging: false,
        freeformUnlocked: false
      };
      event.currentTarget.setPointerCapture(event.pointerId);
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
    addChargeToHoveredNativeAtom,
    assignHoveredNativeDeleteTarget,
    applyChargeDocumentAtPoint,
    applySingleBondDocumentAtPoint,
    cycleNativeBondOrder,
    document,
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart,
    startAtomLabelEdit
  ]);

  const handleObjectRotatePointerDown = useCallback((objectId: string, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || activeToolState.activeKind !== "selection") {
      return;
    }

    const object = findDocumentObject(document, objectId);
    const point = pagePointFromPointerEvent(event);
    const canRotateObject =
      object?.type === "text" ||
      (object?.type === "molecule" && isWholeNativeMoleculeSelected(document, objectId, selectedNativeMoleculePart));
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
    setSelectedNativeMoleculePart(undefined);
    setFreeformNativeBond(undefined);
    setNativeDoubleBondSidePreview(undefined);
    assignHoveredNativeDeleteTarget(undefined);
    objectRotateDragRef.current = {
      pointerId: event.pointerId,
      objectId,
      startDocument: selectedDocument,
      centerPoint: documentObjectCenter(object),
      startPoint: point,
      latestPoint: point,
      dragging: false
    };
    (pageRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    setStatus(object.type === "text" ? "Rotate selected text box" : "Rotate selected molecule");
  }, [
    activeToolState.activeKind,
    assignHoveredNativeDeleteTarget,
    document,
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart
  ]);

  const handleObjectContextMenu = useCallback((objectId: string, event: ReactMouseEvent<HTMLDivElement>) => {
    const currentDocument = documentRef.current;
    const object = findDocumentObject(currentDocument, objectId);
    const point = pagePointFromPointerEvent(event);
    const nativeMoleculeHit = object?.type === "molecule" && point
      ? nativeMoleculeHitFromPointerTarget(object, point, event.target)
      : undefined;
    let nextSelectedNativePart: NativeMoleculeSelectionPart | undefined;
    let targetKind: ObjectContextMenuState["targetKind"] = "object";

    if (object?.type === "molecule" && !nativeMoleculeHit) {
      return;
    }

    if (!object || !shouldActivateDocumentObject(object, "selection")) {
      return;
    }

    if (object.type === "molecule" && nativeMoleculeHit) {
      const currentPart = selectedNativeMoleculePart?.objectId === objectId ? selectedNativeMoleculePart : undefined;
      if (currentPart && nativeSelectionContainsHit(currentPart, nativeMoleculeHit)) {
        nextSelectedNativePart = currentPart;
        targetKind = currentPart.kind;
      } else if (isWholeNativeMoleculeSelected(currentDocument, objectId, selectedNativeMoleculePart)) {
        nextSelectedNativePart = undefined;
        targetKind = "object";
      } else {
        nextSelectedNativePart = nativeSelectionFromHit(objectId, nativeMoleculeHit);
        targetKind = nextSelectedNativePart.kind;
      }
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
      x: event.clientX,
      y: event.clientY
    });
    setStatus(targetKind === "object" ? "Layer options for selected object" : "Layer options for selected molecule part");
  }, [
    assignHoveredNativeDeleteTarget,
    pagePointFromPointerEvent,
    replacePresentDocument,
    selectedNativeMoleculePart
  ]);

  const handleObjectPointerMove = useCallback((objectId: string, event: PointerEvent<HTMLDivElement>) => {
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
        setActiveEditorObjectId(undefined);
        setActiveTextEditObjectId(undefined);
        setActiveAtomLabelEdit(undefined);
        setHoveredNativeAtom(undefined);
        setFreeformNativeBond(undefined);
        setNativeDoubleBondSidePreview(undefined);
        assignHoveredNativeDeleteTarget(undefined);
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
      if (!objectRotateDrag.dragging && clientPointDistance(objectRotateDrag.startPoint, point) >= OBJECT_DRAG_THRESHOLD) {
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

    const point = pagePointFromPointerEvent(event);
    updateNativeDeleteTarget(document, objectId, point, event.target);
    updateNativeDoubleBondSidePreview(document, objectId, point, event.target);

    if (!bondToolActive) {
      return;
    }

    const object = findDocumentObject(document, objectId);
    if (object?.type !== "molecule") {
      setHoveredNativeAtom(undefined);
      return;
    }

    updateBondGrowthPreview(document, point);
  }, [
    assignHoveredNativeDeleteTarget,
    bondToolActive,
    document,
    pagePointFromPointerEvent,
    previewObjectDrag,
    previewObjectRotateDrag,
    previewNativeDoubleBondSideDrag,
    previewNativePartDrag,
    previewTextResize,
    updateBondGrowthPreview,
    updateFreeformBondPreview,
    updateNativeDoubleBondSidePreview,
    updateNativeDeleteTarget
  ]);

  const handleObjectPointerUp = useCallback((objectId: string, event: PointerEvent<HTMLDivElement>) => {
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
          setActiveEditorObjectId(undefined);
          setActiveTextEditObjectId(undefined);
          setActiveAtomLabelEdit(undefined);
          setHoveredNativeAtom(undefined);
          assignHoveredNativeDeleteTarget(undefined);
          setFreeformNativeBond(undefined);
          setNativeDoubleBondSidePreview(undefined);
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
      applyFreeformBondDocumentAtPoint(selectedDocument, objectId, drag.atomId, point, drag.freeformUnlocked);
    } else {
      applySingleBondDocumentAtPoint(selectedDocument, point);
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
    clearTextResize,
    commitNativeDoubleBondSideDrag,
    commitNativePartDrag,
    commitTextResize,
    commitObjectDrag,
    commitObjectRotateDrag,
    cycleNativeBondOrder,
    document,
    pagePointFromPointerEvent
  ]);

  const handleObjectPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
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

    const objectDrag = objectDragRef.current;
    if (objectDrag?.pointerId === event.pointerId && objectDrag.dragging) {
      replacePresentDocument(objectDrag.startDocument);
    }
    clearNativePartDrag(event);
    clearObjectRotateDrag(event);
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
      objectRotateDragRef.current?.objectId === objectId
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
        accept=".chemdraft,application/json,application/vnd.chemdraft+json"
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
                  currentTextStyle={selectedTextObject ? nativeTextStyleFromObjectStyle(selectedTextObject.style) : textStyleDefaults}
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
          onWheel={handleCanvasWheel}
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
                {selectionMarquee ? (
                  <SelectionMarqueeOverlay
                    startPoint={selectionMarquee.startPoint}
                    latestPoint={selectionMarquee.latestPoint}
                  />
                ) : null}
                {document.pages[0].objects.map((object, layerIndex) => (
                  <DocumentObjectView
                    key={object.id}
                    object={object}
                    layerIndex={layerIndex}
                    pageHeight={activePage.height}
                    pageWidth={activePage.width}
                    selected={
                      !bondToolActive &&
                      document.selection.objectIds.includes(object.id) &&
                      selectedNativeMoleculePart?.objectId !== object.id
                    }
                    selectedPart={
                      selectedNativeMoleculePart?.objectId === object.id ? selectedNativeMoleculePart : undefined
                    }
                    editingText={activeTextEditObjectId === object.id}
                    editingAtomLabel={activeAtomLabelEdit?.objectId === object.id ? activeAtomLabelEdit : undefined}
                    chargeByAtomId={object.type === "molecule" ? chargeResolutionByMoleculeId.get(object.id) : undefined}
                    growthPreview={hoveredNativeAtom?.objectId === object.id ? hoveredNativeAtom : undefined}
                    deleteTarget={hoveredNativeDeleteTarget?.objectId === object.id ? hoveredNativeDeleteTarget : undefined}
                    freeformPreview={freeformNativeBond?.objectId === object.id ? freeformNativeBond : undefined}
                    doubleBondSidePreview={
                      nativeDoubleBondSidePreview?.objectId === object.id ? nativeDoubleBondSidePreview : undefined
                    }
                    onPointerDown={handleObjectPointerDown}
                    onPointerMove={handleObjectPointerMove}
                    onPointerUp={handleObjectPointerUp}
                    onPointerCancel={handleObjectPointerCancel}
                    onPointerLeave={handleObjectPointerLeave}
                    onRotatePointerDown={handleObjectRotatePointerDown}
                    onContextMenu={handleObjectContextMenu}
                    onTextChange={updateTextObjectContent}
                    onTextEditStart={startTextObjectEdit}
                    onTextEditFinish={() => setActiveTextEditObjectId(undefined)}
                    onTextResizeStart={startTextResize}
                    onAtomLabelChange={updateAtomLabelDraft}
                    onAtomLabelCancel={cancelAtomLabelEdit}
                    onAtomLabelFinish={() => setActiveAtomLabelEdit(undefined)}
                  />
                ))}
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
      </section>
      {objectContextMenu ? (
        <ObjectLayerContextMenu
          objectId={objectContextMenu.objectId}
          objectIndex={activePage.objects.findIndex((object) => object.id === objectContextMenu.objectId)}
          objectCount={activePage.objects.length}
          targetKind={objectContextMenu.targetKind}
          position={{ x: objectContextMenu.x, y: objectContextMenu.y }}
          onInvoke={(commandId) => {
            setObjectContextMenu(undefined);
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

function documentObjectCenter(object: Pick<DocumentObject, "x" | "y" | "width" | "height">): ClientPoint {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function rotationDeltaDegrees(center: ClientPoint, start: ClientPoint, latest: ClientPoint): number {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const latestAngle = Math.atan2(latest.y - center.y, latest.x - center.x);
  let delta = (latestAngle - startAngle) * 180 / Math.PI;
  if (delta > 180) {
    delta -= 360;
  }
  if (delta < -180) {
    delta += 360;
  }
  return Number(delta.toFixed(3));
}

function capitalizeLabel(label: string): string {
  return label.length > 0 ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function nativeMoleculeHitFromPointerTarget(
  molecule: MoleculeObject,
  point: ClientPoint,
  eventTarget?: EventTarget | null
): NativeMoleculeDeleteHit | undefined {
  const atomId = pointerHitTargetAttribute(eventTarget, "atom", "data-atom-id");
  if (atomId) {
    const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
    if (atom) {
      return {
        kind: "atom",
        atomId: atom.id,
        distanceToPointer: clientPointDistance(atom, point)
      };
    }
  }

  const bondId = pointerHitTargetAttribute(eventTarget, "bond", "data-bond-id");
  if (bondId) {
    const bond = molecule.bonds.find((candidate) => candidate.id === bondId);
    const fromAtom = bond ? molecule.atoms.find((atom) => atom.id === bond.fromAtomId) : undefined;
    const toAtom = bond ? molecule.atoms.find((atom) => atom.id === bond.toAtomId) : undefined;
    if (bond && fromAtom && toAtom) {
      const modelHit = findNativeMoleculeDeleteHit(molecule, point);
      if (modelHit?.kind === "bond" && modelHit.bondId === bond.id) {
        return modelHit;
      }

      const fromDegree = nativeAtomBondCount(molecule, fromAtom.id);
      const toDegree = nativeAtomBondCount(molecule, toAtom.id);
      return {
        kind: "bond",
        bondId: bond.id,
        fromAtomId: fromAtom.id,
        toAtomId: toAtom.id,
        terminalAtomId: fromDegree === 1 ? fromAtom.id : toDegree === 1 ? toAtom.id : undefined,
        distanceToPointer: 0
      };
    }
  }

  return findNativeMoleculeDeleteHit(molecule, point);
}

function pointerHitTargetAttribute(
  eventTarget: EventTarget | null | undefined,
  hitTarget: "atom" | "bond",
  attribute: string
): string | undefined {
  if (typeof Element === "undefined" || !(eventTarget instanceof Element)) {
    return undefined;
  }

  const target = eventTarget.closest(`[data-hit-target="${hitTarget}"]`);
  return target?.getAttribute(attribute) ?? undefined;
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

function bondKnockoutLineSegment(
  segment: Pick<NativeBondLineSegment, "x1" | "y1" | "x2" | "y2">,
  drawingStyle: NativeDrawingStyle
): Pick<NativeBondLineSegment, "x1" | "y1" | "x2" | "y2"> | undefined {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  const endpointInset = Math.min(
    drawingStyle.bondStrokeWidthPx + drawingStyle.bondOverlapClearancePx,
    Math.max(0, length / 2 - 0.5)
  );
  if (endpointInset <= 0) {
    return undefined;
  }

  const unit = { x: dx / length, y: dy / length };
  return {
    x1: segment.x1 + unit.x * endpointInset,
    y1: segment.y1 + unit.y * endpointInset,
    x2: segment.x2 - unit.x * endpointInset,
    y2: segment.y2 - unit.y * endpointInset
  };
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

function clientPointFromGesture(event: WebKitGestureEvent, element: HTMLElement): ClientPoint {
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    return { x: event.clientX, y: event.clientY };
  }

  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
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

export function ObjectLayerContextMenu({
  objectId,
  objectIndex,
  objectCount,
  targetKind,
  position,
  onInvoke
}: {
  objectId: string;
  objectIndex: number;
  objectCount: number;
  targetKind: ObjectContextMenuState["targetKind"];
  position: ClientPoint;
  onInvoke(commandId: string): void;
}) {
  const layerLabel = contextMenuLayerLabel(targetKind, objectIndex, objectCount);

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
  if (targetKind === "atom") {
    return "Selected atom depth";
  }
  if (targetKind === "bond") {
    return "Selected bond depth";
  }
  if (targetKind === "parts") {
    return "Selected parts depth";
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

    if (rectanglesOverlap(rect, objectBounds(object))) {
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

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
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

function nativeSelectionFromHit(
  objectId: string,
  hit: NativeMoleculeDeleteHit
): NativeMoleculeSelectionPart {
  return hit.kind === "atom"
    ? { objectId, kind: "atom", atomId: hit.atomId }
    : { objectId, kind: "bond", bondId: hit.bondId };
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

function nativeSelectionContainsHit(
  part: NativeMoleculeSelectionPart,
  hit: NativeMoleculeDeleteHit
): boolean {
  if (hit.kind === "atom") {
    return nativeSelectionIncludesAtom(part, hit.atomId);
  }

  return nativeSelectionIncludesBond(part, hit.bondId);
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

function DocumentObjectView({
  object,
  layerIndex,
  pageWidth,
  pageHeight,
  selected,
  selectedPart,
  editingText,
  editingAtomLabel,
  chargeByAtomId,
  growthPreview,
  deleteTarget,
  freeformPreview,
  doubleBondSidePreview,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onRotatePointerDown,
  onContextMenu,
  onTextChange,
  onTextEditStart,
  onTextEditFinish,
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
  selectedPart?: NativeMoleculeSelectionPart;
  editingText: boolean;
  editingAtomLabel?: AtomLabelEditState;
  chargeByAtomId?: ReadonlyMap<string, number>;
  growthPreview?: HoveredNativeAtom;
  deleteTarget?: NativeMoleculeDeleteTarget;
  freeformPreview?: FreeformNativeBondPreview;
  doubleBondSidePreview?: NativeDoubleBondSidePreview;
  onPointerDown(objectId: string, event: PointerEvent<HTMLDivElement>): void;
  onPointerMove(objectId: string, event: PointerEvent<HTMLDivElement>): void;
  onPointerUp(objectId: string, event: PointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: PointerEvent<HTMLDivElement>): void;
  onPointerLeave(objectId: string): void;
  onRotatePointerDown(objectId: string, event: PointerEvent<HTMLButtonElement>): void;
  onContextMenu(objectId: string, event: ReactMouseEvent<HTMLDivElement>): void;
  onTextChange(objectId: string, text: string): void;
  onTextEditStart(objectId: string): void;
  onTextEditFinish(): void;
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

  const handleObjectPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    onPointerDown(object.id, event);
  };
  const handleObjectPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    onPointerMove(object.id, event);
  };
  const handleObjectPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    onPointerUp(object.id, event);
  };
  const handleObjectPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    onPointerCancel(event);
  };
  const handleObjectPointerLeave = () => {
    onPointerLeave(object.id);
  };
  const handleObjectContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    onContextMenu(object.id, event);
  };
  const handleRotatePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onRotatePointerDown(object.id, event);
  };
  const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onTextChange(object.id, event.currentTarget.value);
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
  const handleTextDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
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
    zIndex: layerIndex + 1,
    transform: `rotate(${object.rotation}deg)`
  } as CSSProperties;

  if (object.type === "molecule") {
    if (isNativeMoleculeGraph(object)) {
      const drawingStyle = nativeDrawingStyleFromObjectStyle(object.style);
      const atomLabels = object.atoms
        .filter((atom) => atom.id !== editingAtomLabel?.atomId)
        .map((atom) => ({ atom, label: nativeAtomDisplayLabel(atom, object.bonds) }))
        .filter((entry): entry is { atom: MoleculeObject["atoms"][number]; label: string } =>
          entry.label !== undefined
        );
      const labelByAtomId = new Map(atomLabels.map(({ atom, label }) => [atom.id, label]));
      const invalidAtomStates = nativeMoleculeInvalidAtomStates(object, chargeByAtomId);
      const invalidAtomIds = new Set(invalidAtomStates.map((state) => state.atomId));
      const resolvedChargeAtomIds = [...(chargeByAtomId?.entries() ?? [])]
        .filter(([, charge]) => charge !== 0)
        .map(([atomId]) => atomId);
      const bondSegmentGroups = object.bonds.flatMap((bond) => {
        const fromAtom = object.atoms.find((atom) => atom.id === bond.fromAtomId);
        const toAtom = object.atoms.find((atom) => atom.id === bond.toAtomId);
        if (!fromAtom || !toAtom) {
          return [];
        }
        const displayedBond = doubleBondSidePreview?.bondId === bond.id && bond.order === "double"
          ? { ...bond, display: { ...(bond.display ?? {}), doubleBondSide: doubleBondSidePreview.side } }
          : bond;

        const segments = bondLineSegments(
          fromAtom,
          toAtom,
          object,
          displayedBond,
          drawingStyle,
          labelByAtomId.get(fromAtom.id),
          labelByAtomId.get(toAtom.id)
        ).map((segment, segmentIndex) => ({
          ...segment,
          bond: displayedBond,
          key: `${bond.id}-${segmentIndex}`
        }));
        return [{ bond: displayedBond, segments }];
      });
      return (
        <div
          className={[
            "document-object",
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
          <svg className="molecule-glyph" viewBox={`0 0 ${object.width} ${object.height}`} aria-hidden="true">
            {selected ? (
              <g className="native-whole-selection" data-whole-molecule-selection="true">
                {bondSegmentGroups.flatMap(({ bond, segments }) =>
                  segments.map((segment) => (
                    <line
                      className="native-whole-selection-bond"
                      data-selected-bond-id={bond.id}
                      key={`whole-selection-bond-${segment.key}`}
                      x1={segment.x1}
                      y1={segment.y1}
                      x2={segment.x2}
                      y2={segment.y2}
                    />
                  ))
                )}
              </g>
            ) : null}
            {bondSegmentGroups.map(({ bond, segments }) => (
              <g className="native-bond-layer" data-bond-layer-id={bond.id} key={`bond-layer-${bond.id}`}>
                {segments.map((segment) => (
                  <line
                    className="native-bond-hit-target"
                    data-hit-target="bond"
                    data-bond-id={segment.bond.id}
                    key={`bond-hit-${segment.key}`}
                    x1={segment.x1}
                    y1={segment.y1}
                    x2={segment.x2}
                    y2={segment.y2}
                  />
                ))}
                {segments.flatMap((segment) => {
                  const knockout = bondKnockoutLineSegment(segment, drawingStyle);
                  return knockout
                    ? [
                        <line
                          className="native-bond-knockout"
                          data-bond-id={segment.bond.id}
                          data-bond-order={segment.bond.order}
                          data-bond-segment={segment.segment}
                          data-double-bond-side={segment.doubleBondSide}
                          key={`knockout-${segment.key}`}
                          x1={knockout.x1}
                          y1={knockout.y1}
                          x2={knockout.x2}
                          y2={knockout.y2}
                          stroke={drawingStyle.atomLabelBackgroundColor}
                          strokeWidth={drawingStyle.bondStrokeWidthPx + drawingStyle.bondOverlapClearancePx}
                          strokeLinecap={drawingStyle.bondLineCap}
                        />
                      ]
                    : [];
                })}
                {segments.map((segment) => (
                  <line
                    className={[
                      "native-bond-line",
                      `native-bond-${segment.bond.order}`,
                      deleteTarget?.kind === "bond" && deleteTarget.bondId === segment.bond.id ? "native-bond-delete-hover" : "",
                      nativeSelectionIncludesBond(selectedPart, segment.bond.id) ? "native-bond-selected" : ""
                    ].filter(Boolean).join(" ")}
                    data-bond-id={segment.bond.id}
                    data-bond-order={segment.bond.order}
                    data-bond-segment={segment.segment}
                    data-double-bond-side={segment.doubleBondSide}
                    key={`bond-${segment.key}`}
                    x1={segment.x1}
                    y1={segment.y1}
                    x2={segment.x2}
                    y2={segment.y2}
                    stroke={drawingStyle.bondColor}
                    strokeWidth={drawingStyle.bondStrokeWidthPx}
                    strokeLinecap={drawingStyle.bondLineCap}
                  />
                ))}
                {segments
                  .filter((segment) => nativeSelectionIncludesBond(selectedPart, segment.bond.id))
                  .map((segment) => {
                    const x = Math.min(segment.x1, segment.x2) - 9;
                    const y = Math.min(segment.y1, segment.y2) - 9;
                    const width = Math.abs(segment.x2 - segment.x1) + 18;
                    const height = Math.abs(segment.y2 - segment.y1) + 18;
                    return (
                      <rect
                        className="native-bond-selected-hit-target"
                        data-hit-target="bond"
                        data-bond-id={segment.bond.id}
                        key={`selected-hit-${segment.key}`}
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        onPointerDown={(event) => handleObjectPointerDown(event as unknown as PointerEvent<HTMLDivElement>)}
                        onPointerMove={(event) => handleObjectPointerMove(event as unknown as PointerEvent<HTMLDivElement>)}
                        onPointerUp={(event) => handleObjectPointerUp(event as unknown as PointerEvent<HTMLDivElement>)}
                        onPointerCancel={(event) => handleObjectPointerCancel(event as unknown as PointerEvent<HTMLDivElement>)}
                      />
                    );
                  })}
              </g>
            ))}
            {atomLabels
              .map(({ atom, label }) => {
                const box = atomLabelBox(atom, object, label, drawingStyle);
                return (
                  <rect
                    className="native-atom-label-background"
                    key={`label-background-${atom.id}`}
                    x={box.x}
                    y={box.y}
                    width={box.width}
                    height={box.height}
                    fill={drawingStyle.atomLabelBackgroundColor}
                  />
                );
              })}
            {atomLabels
              .map(({ atom, label }) => (
                <g
                  className="native-atom-label"
                  key={`label-${atom.id}`}
                  data-atom-label={label}
                  transform={`translate(${atom.x - object.x} ${atom.y - object.y})`}
                  fill={drawingStyle.atomLabelColor}
                  fontFamily={drawingStyle.atomLabelFontFamily}
                  fontSize={drawingStyle.atomLabelFontSizePx}
                  fontWeight={drawingStyle.atomLabelFontWeight}
                >
                  {atomLabelLayout(label, drawingStyle).runs.map((run, index) => (
                    <text
                      className="native-atom-label-run"
                      data-atom-label-run={run.script === "superscript" ? "charge" : run.script}
                      dominantBaseline="central"
                      fontSize={atomLabelRunFontSize(run.script, drawingStyle)}
                      key={`${run.script}-${index}-${run.text}`}
                      textAnchor={run.textAnchor}
                      x={run.x}
                      y={run.y}
                    >
                      {run.text}
                    </text>
                  ))}
                </g>
              ))}
            {object.atoms.map((atom) => (
              <circle
                className="native-atom-hit-target"
                data-hit-target="atom"
                data-atom-id={atom.id}
                cx={atom.x - object.x}
                cy={atom.y - object.y}
                key={`atom-hit-${atom.id}`}
                r="8"
              />
            ))}
            {selected ? (
              <g className="native-whole-selection-atoms" data-whole-molecule-selected-atoms="true">
                {object.atoms.map((atom) => (
                  <circle
                    className="native-whole-selection-atom"
                    data-selected-atom-id={atom.id}
                    cx={atom.x - object.x}
                    cy={atom.y - object.y}
                    key={`whole-selection-atom-${atom.id}`}
                    r="8.5"
                  />
                ))}
              </g>
            ) : null}
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
              .filter((atom) => nativeSelectionIncludesAtom(selectedPart, atom.id))
              .map((atom) => (
                <circle
                  className="native-atom-selected"
                  cx={atom.x - object.x}
                  cy={atom.y - object.y}
                  key={`selected-${atom.id}`}
                  r="8"
                />
              ))}
            {object.atoms
              .filter((atom) => deleteTarget?.kind === "atom" && atom.id === deleteTarget.atomId)
              .map((atom) => (
                <circle
                  className="native-atom-delete-hover"
                  cx={atom.x - object.x}
                  cy={atom.y - object.y}
                  key={`delete-${atom.id}`}
                  r="8"
                />
              ))}
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
          {selected ? (
            <button
              type="button"
              className="native-molecule-rotate-handle"
              aria-label="Rotate selected molecule"
              data-selection-rotate-handle="true"
              title="Rotate selected molecule"
              onPointerDown={handleRotatePointerDown}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  className="native-molecule-rotate-arc"
                  d="M7.4 13.1a5.7 5.7 0 0 1 9.2-4.5"
                />
                <path
                  className="native-molecule-rotate-arrow"
                  d="M16.9 4.8v4.8h-4.8"
                />
                <circle className="native-molecule-rotate-center" cx="12" cy="12" r="1.6" />
              </svg>
            </button>
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
                  left: `${atom.x - object.x}px`,
                  top: `${atom.y - object.y}px`,
                  width: `${Math.max(1, editingAtomLabel.draft.length + 0.6)}ch`,
                  fontFamily: drawingStyle.atomLabelFontFamily,
                  fontSize: `${drawingStyle.atomLabelFontSizePx}px`,
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
        className={["document-object", "molecule-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
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
      >
        <span className="object-primary">{object.structure}</span>
        <span className="object-secondary">{object.chemistry?.formula ?? object.structureFormat}</span>
        {object.chemistry ? <span className="object-tertiary">{formatChemistrySummary(object.chemistry)}</span> : null}
      </div>
    );
  }

  if (object.type === "electron-mark" && object.markKind === "charge") {
    const charge = object.charge === -1 ? -1 : 1;
    return (
      <div
        className={["document-object", "charge-mark-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
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
      >
        {charge > 0 ? "+" : "-"}
      </div>
    );
  }

  if (object.type === "text") {
    const textStyle = nativeTextStyleFromObjectStyle(object.style);
    const textCss = {
      fontFamily: textStyle.fontFamily,
      fontSize: `${textStyle.fontSizePx}px`,
      color: textStyle.color,
      letterSpacing: `${textStyle.letterSpacingPx}px`,
      lineHeight: textStyle.lineHeight,
      textAlign: textStyle.textAlign,
      fontWeight: textStyle.fontWeight,
      fontStyle: textStyle.fontStyle,
      textDecoration: textStyle.textDecoration
    } as CSSProperties;

    return (
      <div
        className={["document-object", "text-object", editingText ? "editing" : "", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={{ ...style, ...textCss }}
        data-object-id={object.id}
        data-layer-index={layerIndex}
        data-text-align={textStyle.textAlign}
        data-text-sizing-mode={String(object.style.textBoxSizingMode ?? "auto")}
        onPointerDown={handleObjectPointerDown}
        onPointerMove={handleObjectPointerMove}
        onPointerUp={handleObjectPointerUp}
        onPointerCancel={handleObjectPointerCancel}
        onPointerLeave={handleObjectPointerLeave}
      >
        {selected || editingText ? (
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
        {selected && !editingText ? (
          <button
            type="button"
            className="native-molecule-rotate-handle text-rotate-handle"
            aria-label="Rotate selected text box"
            data-selection-rotate-handle="true"
            title="Rotate selected text box"
            onPointerDown={handleRotatePointerDown}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                className="native-molecule-rotate-arc"
                d="M7.4 13.1a5.7 5.7 0 0 1 9.2-4.5"
              />
              <path
                className="native-molecule-rotate-arrow"
                d="M16.9 4.8v4.8h-4.8"
              />
              <circle className="native-molecule-rotate-center" cx="12" cy="12" r="1.6" />
            </svg>
          </button>
        ) : null}
        {editingText ? (
          <textarea
            aria-label="Text object"
            autoFocus
            className="text-object-editor"
            ref={textEditorRef}
            spellCheck={false}
            style={textCss}
            value={object.text}
            onChange={handleTextChange}
            onPaste={handleTextPaste}
            onFocus={(event) => {
              if (object.text === "Text") {
                event.currentTarget.select();
              }
            }}
            onKeyDown={handleTextKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="text-object-content">{object.text}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className={["document-object", "generic-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
      style={style}
      data-object-id={object.id}
      data-layer-index={layerIndex}
      onPointerDown={handleObjectPointerDown}
      onPointerMove={handleObjectPointerMove}
      onPointerUp={handleObjectPointerUp}
      onPointerCancel={handleObjectPointerCancel}
      onPointerLeave={handleObjectPointerLeave}
    >
      {object.type}
    </div>
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
