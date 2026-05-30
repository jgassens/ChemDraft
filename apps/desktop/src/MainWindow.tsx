import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type PointerEvent
} from "react";
import type { ChemDraftDocument, DocumentObject } from "@chemdraft/chem-core";
import { parseToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import {
  createViewportState,
  viewportCssVars,
  zoomViewportAtPoint,
  type ViewportState
} from "@chemdraft/viewport-engine";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  createQuickActions,
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
  listenForToolsetCommands,
  listenForToolsetWindowStates,
  toggleToolsetWindow
} from "./window-manager";
import {
  defaultVisibleToolsetIds,
  desktopToolsetRegistry,
  getToolsetCommandGroups,
  getToolsetCommandSpecs,
  getToolsetToggleActions,
  isDisabledPlaceholderCommand
} from "./toolsets";

type PaletteMode = "floating" | "hidden";
type PalettePosition = { x: number; y: number };
type PaletteDragState = {
  toolsetId: string;
  pointerId: number;
  originX: number;
  originY: number;
  startX: number;
  startY: number;
};

export interface MainWindowProps {
  initialPaletteMode?: PaletteMode;
  nativePalette?: boolean;
}

export function MainWindow({
  initialPaletteMode = "floating",
  nativePalette = isDesktopRuntime()
}: MainWindowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const webPaletteDragRef = useRef<PaletteDragState | null>(null);
  const chemistryAdapter = useMemo(() => createRdkitPlaceholderAdapter(), []);
  const [document, setDocument] = useState(() => createPhase4Document());
  const [activeTool, setActiveTool] = useState("tool.select");
  const [visibleToolsetIds, setVisibleToolsetIds] = useState(() =>
    initialPaletteMode === "hidden" ? new Set<string>() : new Set(defaultVisibleToolsetIds)
  );
  const [webPalettePositions, setWebPalettePositions] = useState<Record<string, PalettePosition>>(() =>
    createDefaultToolsetPositions()
  );
  const [rulersVisible, setRulersVisible] = useState(false);
  const [crosshairsVisible, setCrosshairsVisible] = useState(true);
  const [viewport, setViewport] = useState(() => createViewportState());
  const [, setStatus] = useState("Blank native document");
  const [, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);
  const invokeCommandRef = useRef<(commandId: string) => void>(() => undefined);

  const selectedMolecule = getSelectedMolecule(document);
  const quickActions = useMemo(() => createQuickActions(document, selectedMolecule), [document, selectedMolecule]);
  const visibleFloatingToolsets = useMemo(
    () => desktopToolsetRegistry.listToolsets().filter((toolset) => visibleToolsetIds.has(toolset.id)),
    [visibleToolsetIds]
  );

  const toggleToolset = useCallback(async (toolsetId: string) => {
    if (!desktopToolsetRegistry.get(toolsetId)) {
      setStatus(`Unknown toolbar ${toolsetId}`);
      return;
    }

    if (nativePalette) {
      const nextState = await toggleToolsetWindow(toolsetId);
      setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, nextState.open));
      setStatus(nextState.open ? `${desktopToolsetRegistry.require(toolsetId).title} open` : `${desktopToolsetRegistry.require(toolsetId).title} closed`);
      return;
    }

    setVisibleToolsetIds((current) => updateVisibleToolsets(current, toolsetId, !current.has(toolsetId)));
    setStatus(`Toggled ${desktopToolsetRegistry.require(toolsetId).title}`);
  }, [nativePalette]);

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

    getToolsetCommandSpecs().forEach((tool) => {
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

    getToolsetToggleActions().forEach((action) => {
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

    return commandRegistry;
  }, [chemistryAdapter, document, nativePalette, quickActions, toggleToolset]);

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
        setVisibleToolsetIds(new Set(states.filter((state) => state.open).map((state) => state.toolsetId)));
      })
      .catch(() => {
        setVisibleToolsetIds(new Set());
        setStatus("Native toolset windows unavailable");
      });
  }, [nativePalette]);

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

    const position = webPalettePositions[toolsetId] ?? defaultToolsetPosition(toolsetId);
    webPaletteDragRef.current = {
      toolsetId,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: position.x,
      startY: position.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [webPalettePositions]);

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
            const position = webPalettePositions[toolset.id] ?? defaultToolsetPosition(toolset.id);
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
                  groups={getToolsetCommandGroups(toolset.id)}
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
        <section className="canvas-region" aria-label="Document workspace">
          <div className="page-stage" style={viewportCssVars(viewport) as CSSProperties}>
            <div className={["document-board", rulersVisible ? "with-rulers" : "without-rulers"].join(" ")}>
              {rulersVisible ? <DocumentRulers viewport={viewport} /> : null}
              <div className="page" aria-label={document.title}>
                {crosshairsVisible ? (
                  <>
                    <div className="crosshair crosshair-vertical" aria-hidden="true" />
                    <div className="crosshair crosshair-horizontal" aria-hidden="true" />
                  </>
                ) : null}
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

function createDefaultToolsetPositions(): Record<string, PalettePosition> {
  return Object.fromEntries(
    desktopToolsetRegistry.listToolsets().map((toolset, index) => [
      toolset.id,
      { x: 34 + index * 18, y: 116 + index * 18 }
    ])
  );
}

function defaultToolsetPosition(toolsetId: string): PalettePosition {
  const index = Math.max(0, desktopToolsetRegistry.listToolsets().findIndex((toolset) => toolset.id === toolsetId));
  return { x: 34 + index * 18, y: 116 + index * 18 };
}

function pageCenterPoint(viewport: ViewportState): { x: number; y: number } {
  return {
    x: viewport.pageOriginX + viewport.translateX + 408 * viewport.scale,
    y: viewport.pageOriginY + viewport.translateY + 528 * viewport.scale
  };
}

function DocumentRulers({ viewport }: { viewport: ViewportState }) {
  const horizontalMarks = Array.from({ length: 9 }, (_, index) => index);
  const verticalMarks = Array.from({ length: 11 }, (_, index) => index);

  return (
    <>
      <div className="ruler-corner" aria-hidden="true" />
      <div className="ruler ruler-top" aria-hidden="true">
        {horizontalMarks.map((index) => (
          <span key={index}>
            <strong>{index}</strong>
          </span>
        ))}
      </div>
      <div className="ruler ruler-left" aria-hidden="true">
        {verticalMarks.map((index) => (
          <span key={index}>
            <strong>{index}</strong>
          </span>
        ))}
      </div>
      <span className="ruler-unit-label" aria-hidden="true">
        {viewport.rulerUnit.label}
      </span>
    </>
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
        <span className="object-secondary">
          {object.chemistry?.totalCharge ? `charge ${object.chemistry.totalCharge}` : object.structureFormat}
        </span>
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

function formatValidationFailure(analysis: StructureAnalysisResult): string {
  const firstError = analysis.validation.errors[0] ?? analysis.validation.warnings[0];
  return firstError ? `Validation unavailable: ${firstError.message}` : "Validation unavailable";
}
