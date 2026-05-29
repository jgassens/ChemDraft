import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "@chemdraft/chem-core";
import { disconnectedEditorCapabilities } from "@chemdraft/editor-adapter";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
import {
  createQuickActions,
  drawerActions,
  menuItems,
  paletteGroups,
  styleActions,
  type CommandSpec
} from "./commands";
import {
  applyAnalysisToSelectedMolecule,
  createNativeSavePayload,
  createPhase4Document,
  exportPhase4Svg,
  getSelectedMolecule,
  getSelectedObject,
  insertAdapterFallbackMolecule,
  openNativeDocument
} from "./documentWorkflow";
import { CommandIconButton, ToolPalette } from "./ToolPalette";
import { isDesktopRuntime, listenForPaletteCommands, openToolPalette, toggleToolPalette } from "./window-manager";

type Drawer = "inspector" | "plugins" | null;
type PaletteMode = "floating" | "docked";

export interface MainWindowProps {
  initialPaletteMode?: PaletteMode;
  nativePalette?: boolean;
}

export function MainWindow({
  initialPaletteMode = isDesktopRuntime() ? "floating" : "docked",
  nativePalette = isDesktopRuntime()
}: MainWindowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chemistryAdapter = useMemo(() => createRdkitPlaceholderAdapter(), []);
  const [document, setDocument] = useState(() => createPhase4Document());
  const [activeTool, setActiveTool] = useState("tool.select");
  const [paletteMode, setPaletteMode] = useState<PaletteMode>(initialPaletteMode);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [zoom, setZoom] = useState(100);
  const [status, setStatus] = useState("Blank native document");
  const [lastAnalysis, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);
  const invokeCommandRef = useRef<(commandId: string) => void>(() => undefined);

  const selectedObject = getSelectedObject(document);
  const selectedMolecule = getSelectedMolecule(document);
  const quickActions = useMemo(() => createQuickActions(document, selectedMolecule), [document, selectedMolecule]);
  const objectCount = document.pages.reduce((count, page) => count + page.objects.length, 0);

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

          setPaletteMode((current) => (current === "docked" ? "floating" : "docked"));
          setStatus("Toggled web preview tool palette");
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
        if (tool.id === "tool.adapterFallback") {
          const inserted = insertAdapterFallbackMolecule(document);
          setDocument(inserted);
          setLastAnalysis(null);
          setActiveTool("tool.select");
          setStatus("Inserted adapter-backed fallback molecule");
          return;
        }

        if (tool.enabled === false) {
          setStatus("EditorAdapter not connected");
          return;
        }
        setActiveTool(tool.id);
        setStatus(`${tool.title} tool`);
      });
    });

    drawerActions.forEach((action) => {
      register(action, () => {
        setDrawer((current) => {
          if (action.id === "view.toggleInspector") {
            return current === "inspector" ? null : "inspector";
          }
          return current === "plugins" ? null : "plugins";
        });
      });
    });

    styleActions.forEach((action) => {
      register(action);
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
        setPaletteMode("docked");
        setStatus("Native tool palette unavailable; using docked fallback");
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
      {!nativePalette ? (
        <header className="menu-bar">
          <div className="brand">ChemDraft</div>
          <nav className="menu" aria-label="Application menu">
            {menuItems.map((item) => (
              <button type="button" key={item}>
                {item}
              </button>
            ))}
          </nav>
        </header>
      ) : null}

      <section className="command-bar" aria-label="Quick actions">
        <div className="document-tabs" aria-label="Document tabs">
          <button type="button" className="active-tab" title={document.title}>
            {document.title}
          </button>
        </div>
        <Toolbar commands={quickActions} onInvoke={invoke} />
        <StyleStrip commands={styleActions} onInvoke={invoke} />
      </section>

      <section className="workspace">
        {paletteMode === "docked" ? (
          <ToolPalette groups={paletteGroups} activeTool={activeTool} mode="docked" onInvoke={invoke} />
        ) : null}

        <section className="canvas-region" aria-label="Document workspace">
          <div className="ruler ruler-top" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
          <div className="ruler ruler-left" aria-hidden="true">
            {Array.from({ length: 15 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
          <div className="page-stage" style={{ "--page-scale": zoom / 100 } as CSSProperties}>
            <div className="page" aria-label={document.title}>
              <div className="margin-guide" aria-hidden="true" />
              {document.pages[0].objects.map((object) => (
                <DocumentObjectView key={object.id} object={object} selected={document.selection.objectIds.includes(object.id)} />
              ))}
              <div className="adapter-state" role="status">
                {objectCount === 0 ? "EditorAdapter not connected" : "Adapter-backed chem-core page"}
              </div>
            </div>
          </div>
        </section>

        <aside className="drawer-rail" aria-label="Optional panels">
          {drawerActions.map((action) => (
            <CommandIconButton
              key={action.id}
              command={action}
              active={
                (action.id === "view.toggleInspector" && drawer === "inspector") ||
                (action.id === "view.togglePlugins" && drawer === "plugins")
              }
              onInvoke={invoke}
            />
          ))}
        </aside>

        {drawer ? (
          <UtilityDrawer
            drawer={drawer}
            document={document}
            selectedObject={selectedObject}
            selectedMolecule={selectedMolecule}
            lastAnalysis={lastAnalysis}
          />
        ) : null}
      </section>

      <footer className="statusbar">
        <span>{status}</span>
        <span>{disconnectedEditorCapabilities.implementationName}</span>
        <span>{objectCount} object(s)</span>
        <span>{selectedObject ? `Selected ${selectedObject.id}` : "No selection"}</span>
        <span>Page Letter</span>
        <span>{zoom}%</span>
        <span>{document.schema}</span>
      </footer>
    </main>
  );
}

function Toolbar({
  commands,
  onInvoke
}: {
  commands: CommandSpec[];
  onInvoke: (commandId: string) => void;
}) {
  return (
    <div className="quick-toolbar">
      {commands.map((command, index) => (
        <CommandIconButton
          key={command.id}
          command={command}
          onInvoke={onInvoke}
          separated={index === 3 || index === 7}
        />
      ))}
    </div>
  );
}

function StyleStrip({
  commands,
  onInvoke
}: {
  commands: CommandSpec[];
  onInvoke: (commandId: string) => void;
}) {
  return (
    <div className="style-strip" aria-label="Style controls">
      {commands.map((command) => (
        <button
          type="button"
          key={command.id}
          title={`${command.title}: unavailable until style presets are connected`}
          aria-label={`${command.title}: unavailable until style presets are connected`}
          disabled={command.enabled === false}
          data-command-id={command.id}
          onClick={() => onInvoke(command.id)}
        >
          {styleControlLabel(command.id)}
        </button>
      ))}
    </div>
  );
}

function styleControlLabel(commandId: string): string {
  if (commandId === "style.bondStroke") {
    return "1.2 px";
  }

  if (commandId === "style.textSize") {
    return "10 pt";
  }

  return "ACS";
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

function UtilityDrawer({
  drawer,
  document,
  selectedObject,
  selectedMolecule,
  lastAnalysis
}: {
  drawer: Exclude<Drawer, null>;
  document: ChemDraftDocument;
  selectedObject: DocumentObject | undefined;
  selectedMolecule: MoleculeObject | undefined;
  lastAnalysis: StructureAnalysisResult | null;
}) {
  const objectCount = document.pages.reduce((count, page) => count + page.objects.length, 0);

  if (drawer === "plugins") {
    return (
      <aside className="utility-drawer" aria-label="Plugin panel">
        <div className="drawer-title">Plugins</div>
        <dl>
          <div>
            <dt>Loaded</dt>
            <dd>None</dd>
          </div>
          <div>
            <dt>Pending patches</dt>
            <dd>0</dd>
          </div>
        </dl>
      </aside>
    );
  }

  return (
    <aside className="utility-drawer" aria-label="Inspector">
      <div className="drawer-title">Inspector</div>
      <dl>
        <div>
          <dt>Document</dt>
          <dd>{document.title}</dd>
        </div>
        <div>
          <dt>Objects</dt>
          <dd>{objectCount}</dd>
        </div>
        <div>
          <dt>Selection</dt>
          <dd>{selectedObject?.id ?? "None"}</dd>
        </div>
        <div>
          <dt>Formula</dt>
          <dd>{selectedMolecule?.chemistry ? (lastAnalysis?.properties.formula ?? "Calculated") : "Not calculated"}</dd>
        </div>
        <div>
          <dt>Mass</dt>
          <dd>{formatMass(lastAnalysis)}</dd>
        </div>
        <div>
          <dt>Warnings</dt>
          <dd>{lastAnalysis?.warnings.length ?? document.compatibility.warnings.length}</dd>
        </div>
      </dl>
    </aside>
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

function formatMass(analysis: StructureAnalysisResult | null): string {
  if (!analysis?.properties.averageMass) {
    return "Not calculated";
  }

  return analysis.properties.exactMass
    ? `${analysis.properties.averageMass.toFixed(3)} avg / ${analysis.properties.exactMass.toFixed(4)} exact`
    : `${analysis.properties.averageMass.toFixed(3)} avg`;
}
