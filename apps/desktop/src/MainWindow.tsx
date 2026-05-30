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
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  createQuickActions,
  paletteGroups,
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
import { isDesktopRuntime, listenForPaletteCommands, openToolPalette, toggleToolPalette } from "./window-manager";

type PaletteMode = "floating" | "hidden";
type PalettePosition = { x: number; y: number };
type PaletteDragState = {
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
  const [paletteMode, setPaletteMode] = useState<PaletteMode>(initialPaletteMode);
  const [webPalettePosition, setWebPalettePosition] = useState<PalettePosition>({ x: 34, y: 116 });
  const [rulersVisible, setRulersVisible] = useState(false);
  const [crosshairsVisible, setCrosshairsVisible] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [, setStatus] = useState("Blank native document");
  const [, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);
  const invokeCommandRef = useRef<(commandId: string) => void>(() => undefined);

  const selectedMolecule = getSelectedMolecule(document);
  const quickActions = useMemo(() => createQuickActions(document, selectedMolecule), [document, selectedMolecule]);

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
          setZoom((value) => Math.max(50, value - 10));
        }
        if (action.id === "view.zoomIn") {
          setZoom((value) => Math.min(200, value + 10));
        }
        if (action.id === "view.toggleToolPalette") {
          if (nativePalette) {
            const nextState = await toggleToolPalette();
            setStatus(nextState.open ? "Tool palette open" : "Tool palette closed");
            return;
          }

          setPaletteMode((current) => (current === "floating" ? "hidden" : "floating"));
          setStatus("Toggled floating tool palette");
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

    paletteGroups.flat().forEach((tool) => {
      register(tool, () => {
        if (tool.enabled === false) {
          setStatus("EditorAdapter not connected");
          return;
        }
        setActiveTool(tool.id);
        setStatus(`${tool.title} tool`);
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
  }, [chemistryAdapter, document, nativePalette, quickActions]);

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

    void openToolPalette()
      .then(() => {
        setPaletteMode("floating");
      })
      .catch(() => {
        setPaletteMode("hidden");
        setStatus("Native tool palette unavailable");
      });
  }, [nativePalette]);

  useEffect(() => {
    if (!nativePalette) {
      return undefined;
    }

    let unlisten: (() => void) | undefined;
    void listenForPaletteCommands((commandId) => invokeCommandRef.current(commandId))
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        setStatus("Tool palette command bridge unavailable");
      });

    return () => {
      unlisten?.();
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

  const startWebPaletteDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }

    webPaletteDragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: webPalettePosition.x,
      startY: webPalettePosition.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [webPalettePosition]);

  const moveWebPalette = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = webPaletteDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const maxX = Math.max(8, globalThis.innerWidth - 112);
    const maxY = Math.max(8, globalThis.innerHeight - 120);
    setWebPalettePosition({
      x: clamp(drag.startX + event.clientX - drag.originX, 8, maxX),
      y: clamp(drag.startY + event.clientY - drag.originY, 44, maxY)
    });
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

      {!nativePalette && paletteMode === "floating" ? (
        <section
          className="web-floating-palette"
          aria-label="Floating drawing tool palette"
          data-floating-palette="web-preview"
          style={{ "--palette-x": `${webPalettePosition.x}px`, "--palette-y": `${webPalettePosition.y}px` } as CSSProperties}
          onPointerDown={startWebPaletteDrag}
          onPointerMove={moveWebPalette}
          onPointerUp={stopWebPaletteDrag}
          onPointerCancel={stopWebPaletteDrag}
        >
          <div className="palette-title">Tools</div>
          <ToolPalette groups={paletteGroups} activeTool={activeTool} mode="floating" onInvoke={invoke} />
        </section>
      ) : null}

      <section className="workspace">
        <section className="canvas-region" aria-label="Document workspace">
          <div className="page-stage" style={{ "--page-scale": zoom / 100 } as CSSProperties}>
            <div className={["document-board", rulersVisible ? "with-rulers" : "without-rulers"].join(" ")}>
              {rulersVisible ? <DocumentRulers /> : null}
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

function DocumentRulers() {
  return (
    <>
      <div className="ruler-corner" aria-hidden="true" />
      <div className="ruler ruler-top" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => (
          <span key={index}>
            <strong>{index}</strong>
          </span>
        ))}
      </div>
      <div className="ruler ruler-left" aria-hidden="true">
        {Array.from({ length: 11 }, (_, index) => (
          <span key={index}>
            <strong>{index}</strong>
          </span>
        ))}
      </div>
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
