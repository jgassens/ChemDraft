import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent,
  type WheelEvent
} from "react";
import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "@chemdraft/chem-core";
import { parseToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import {
  buildCrosshairTicks,
  createRulerRenderState,
  createViewportState,
  setViewportScale,
  viewportCssVars,
  wheelDeltaToZoomFactor,
  zoomViewportAtPoint,
  type ViewportState
} from "@chemdraft/viewport-engine";
import ScenaRuler from "@scena/react-ruler";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  createQuickActions,
  toolbarCustomizationActions,
  viewActions,
  type CommandSpec
} from "./commands";
import {
  applyAnalysisToSelectedMolecule,
  createNativeSavePayload,
  createPhase4Document,
  exportPhase4Svg,
  getSelectedMolecule,
  openNativeDocument
} from "./documentWorkflow";
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

const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;
const RULER_THICKNESS = 32;
const HORIZONTAL_CROSSHAIR_TICKS = buildCrosshairTicks(PAGE_WIDTH);
const VERTICAL_CROSSHAIR_TICKS = buildCrosshairTicks(PAGE_HEIGHT);

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
  const gestureStartScaleRef = useRef(1);
  const chemistryAdapter = useMemo(() => createRdkitPlaceholderAdapter(), []);
  const [document, setDocument] = useState(() => initialDocument ?? createPhase4Document());
  const [activeTool, setActiveTool] = useState("tool.select");
  const [toolsetRegistry, setToolsetRegistry] = useState<DesktopToolsetRegistry>(() => desktopToolsetRegistry);
  const [visibleToolsetIds, setVisibleToolsetIds] = useState(() =>
    initialPaletteMode === "hidden" ? new Set<string>() : new Set(defaultVisibleToolsetIds)
  );
  const [webPalettePositions, setWebPalettePositions] = useState<Record<string, PalettePosition>>(() =>
    createDefaultToolsetPositions(desktopToolsetRegistry)
  );
  const [rulersVisible, setRulersVisible] = useState(initialRulersVisible);
  const [crosshairsVisible, setCrosshairsVisible] = useState(initialCrosshairsVisible);
  const [viewport, setViewport] = useState(() => createViewportState());
  const [rulerFrame, setRulerFrame] = useState<RulerFrame>(() => ({
    horizontalScrollPx: 0,
    verticalScrollPx: 0,
    width: 0,
    height: 0
  }));
  const [, setStatus] = useState("Blank native document");
  const [, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);
  const invokeCommandRef = useRef<(commandId: string) => void>(() => undefined);
  const viewportRef = useRef(viewport);

  const selectedMolecule = getSelectedMolecule(document);
  const quickActions = useMemo(() => createQuickActions(document, selectedMolecule), [document, selectedMolecule]);
  const visibleFloatingToolsets = useMemo(
    () => toolsetRegistry.listToolsets().filter((toolset) => visibleToolsetIds.has(toolset.id)),
    [toolsetRegistry, visibleToolsetIds]
  );

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
          setDocument(createPhase4Document());
          setLastAnalysis(null);
          setStatus("Blank native document");
        }
        if (action.id === "document.open") {
          fileInputRef.current?.click();
        }
        if (action.id === "document.save") {
          const payload = createNativeSavePayload(document);
          downloadText(payload.filename, payload.contents, payload.mimeType);
          setStatus(`Saved ${payload.filename}`);
        }
        if (action.id === "view.zoomOut") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale - 0.1, pageCenterPoint(current)));
        }
        if (action.id === "view.zoomIn") {
          setViewport((current) => zoomViewportAtPoint(current, current.scale + 0.1, pageCenterPoint(current)));
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
          const blob = await svgToPngBlob(result.contents);
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
            setDocument(analyzed);
            setStatus(formatAnalysisStatus(analysis));
            return;
          }

          setStatus(formatValidationFailure(analysis));
        }
      });
    });

    getToolsetCommandSpecs(toolsetRegistry).forEach((tool) => {
      register(tool, () => {
        if (isDisabledPlaceholderCommand(tool)) {
          setStatus(tool.disabledReason ?? "Tool unavailable");
          return;
        }
        if (tool.id === "plugin.fixture.toolset.ping") {
          setStatus("Fixture plugin toolset command routed");
          return;
        }

        setActiveTool(tool.id);
        setStatus(`${tool.title} tool`);
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

    toolbarCustomizationActions.forEach((action) => {
      register(action, () => {
        setStatus(action.disabledReason ?? "Toolbar customization UI is not implemented yet");
      });
    });

    return commandRegistry;
  }, [chemistryAdapter, document, nativePalette, quickActions, toggleToolset, toolsetRegistry]);

  const invoke = useCallback((commandId: string) => {
    void registry.invoke(commandId).catch(() => {
      setStatus("Command unavailable");
    });
  }, [registry]);

  invokeCommandRef.current = invoke;

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
    if (!nativePalette) {
      return undefined;
    }

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
  }, [nativePalette]);

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
        setDocument(opened);
        setLastAnalysis(null);
        setStatus(`Opened ${file.name}`);
      })
      .catch((error: unknown) => {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const startWebPaletteDrag = useCallback((toolsetId: string, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
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

  return (
    <main className={["app-shell", nativePalette ? "native-shell" : "web-shell"].join(" ")} aria-label="ChemDraft desktop workspace">
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
                  title={toolset.title}
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
          {rulersVisible ? <DocumentRulers viewport={viewport} frame={rulerFrame} /> : null}
          <div className="page-stage" style={viewportCssVars(viewport) as CSSProperties}>
            <div className="document-board without-rulers">
              <div
                ref={pageRef}
                className={["page", crosshairsVisible ? "crosshairs-visible" : "crosshairs-hidden"].join(" ")}
                aria-label={document.title}
              >
                {crosshairsVisible ? <CrosshairOverlay /> : null}
                {document.pages[0].objects.map((object) => (
                  <DocumentObjectView key={object.id} object={object} selected={document.selection.objectIds.includes(object.id)} />
                ))}
              </div>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function pageCenterPoint(viewport: ViewportState): { x: number; y: number } {
  return {
    x: viewport.pageOriginX + viewport.translateX + (PAGE_WIDTH / 2) * viewport.scale,
    y: viewport.pageOriginY + viewport.translateY + (PAGE_HEIGHT / 2) * viewport.scale
  };
}

function DocumentRulers({ viewport, frame }: { viewport: ViewportState; frame: RulerFrame }) {
  const horizontalRuler = createRulerRenderState(viewport, PAGE_WIDTH, frame.horizontalScrollPx);
  const verticalRuler = createRulerRenderState(viewport, PAGE_HEIGHT, frame.verticalScrollPx);

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

function CrosshairOverlay() {
  return (
    <div className="crosshair-overlay" aria-hidden="true">
      <div className="crosshair-axis crosshair-axis-vertical" />
      <div className="crosshair-axis crosshair-axis-horizontal" />
      {VERTICAL_CROSSHAIR_TICKS.map((tick) => (
        <span
          className={["crosshair-tick", "crosshair-tick-on-vertical", `crosshair-tick-${tick.kind}`].join(" ")}
          key={`vertical-${tick.index}`}
          style={{ top: `calc(${tick.position}px * var(--page-scale))` }}
        />
      ))}
      {HORIZONTAL_CROSSHAIR_TICKS.map((tick) => (
        <span
          className={["crosshair-tick", "crosshair-tick-on-horizontal", `crosshair-tick-${tick.kind}`].join(" ")}
          key={`horizontal-${tick.index}`}
          style={{ left: `calc(${tick.position}px * var(--page-scale))` }}
        />
      ))}
    </div>
  );
}

function DocumentObjectView({ object, selected }: { object: DocumentObject; selected: boolean }) {
  const style = {
    left: `${(object.x / 816) * 100}%`,
    top: `${(object.y / 1056) * 100}%`,
    width: `${(object.width / 816) * 100}%`,
    height: `${(object.height / 1056) * 100}%`,
    transform: `rotate(${object.rotation}deg)`
  } as CSSProperties;

  if (object.type === "molecule") {
    return (
      <div
        className={["document-object", "molecule-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={style}
        data-object-id={object.id}
        aria-label={`Molecule ${object.structure}`}
      >
        <span className="object-primary">{object.structure}</span>
        <span className="object-secondary">{object.chemistry?.formula ?? object.structureFormat}</span>
        {object.chemistry ? <span className="object-tertiary">{formatChemistrySummary(object.chemistry)}</span> : null}
      </div>
    );
  }

  if (object.type === "text") {
    return (
      <div
        className={["document-object", "text-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
        style={style}
        data-object-id={object.id}
      >
        {object.text}
      </div>
    );
  }

  return (
    <div
      className={["document-object", "generic-object", selected ? "selected" : ""].filter(Boolean).join(" ")}
      style={style}
      data-object-id={object.id}
    >
      {object.type}
    </div>
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

async function svgToPngBlob(svg: string): Promise<Blob> {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not render SVG for PNG export."));
      image.src = url;
    });

    const canvas = globalThis.document.createElement("canvas");
    canvas.width = image.naturalWidth || 816;
    canvas.height = image.naturalHeight || 1056;
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

function formatChemistrySummary(chemistry: NonNullable<MoleculeObject["chemistry"]>): string {
  const parts = [
    chemistry.averageMass !== undefined ? `avg ${chemistry.averageMass.toFixed(3)}` : undefined,
    chemistry.exactMass !== undefined ? `exact ${chemistry.exactMass.toFixed(4)}` : undefined,
    chemistry.totalCharge ? `charge ${chemistry.totalCharge}` : undefined,
    chemistry.stereochemistry.length > 0 ? chemistry.stereochemistry.join(", ") : undefined
  ].filter(Boolean);

  return parts.join(" | ");
}

function formatValidationFailure(analysis: StructureAnalysisResult): string {
  const firstError = analysis.validation.errors[0] ?? analysis.validation.warnings[0];
  return firstError ? `Validation unavailable: ${firstError.message}` : "Validation unavailable";
}
