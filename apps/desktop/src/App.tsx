import { useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "@chemdraft/chem-core";
import { disconnectedEditorCapabilities } from "@chemdraft/editor-adapter";
import { CommandRegistry, type CommandDefinition } from "@chemdraft/plugin-host";
import { createRdkitPlaceholderAdapter } from "@chemdraft/rdkit-adapter";
import type { StructureAnalysisResult } from "@chemdraft/chemistry-adapter";
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
import { Icon, type IconName } from "./icons";

type Drawer = "inspector" | "plugins" | null;

interface CommandSpec extends CommandDefinition {
  icon: IconName;
  shortcut?: string;
}

const menuItems = ["File", "Edit", "Structure", "Object", "View", "Tools", "Analyze", "Window", "Help"];

function createQuickActions(document: ChemDraftDocument, selectedMolecule: MoleculeObject | undefined): CommandSpec[] {
  const hasObjects = document.pages.some((page) => page.objects.length > 0);

  return [
    { id: "document.new", title: "New Document", icon: "new", shortcut: "⌘N", source: "core" },
    { id: "document.open", title: "Open Native Document", icon: "open", shortcut: "⌘O", source: "core" },
    { id: "document.save", title: "Save Native Document", icon: "save", shortcut: "⌘S", source: "core" },
    { id: "edit.undo", title: "Undo", icon: "undo", shortcut: "⌘Z", source: "core", enabled: false },
    { id: "edit.redo", title: "Redo", icon: "redo", shortcut: "⇧⌘Z", source: "core", enabled: false },
    { id: "clipboard.copy", title: "Copy", icon: "copy", shortcut: "⌘C", source: "core", enabled: false },
    { id: "clipboard.paste", title: "Paste", icon: "paste", shortcut: "⌘V", source: "core", enabled: false },
    { id: "view.zoomOut", title: "Zoom Out", icon: "zoomOut", shortcut: "⌘-", source: "core" },
    { id: "view.zoomIn", title: "Zoom In", icon: "zoomIn", shortcut: "⌘+", source: "core" },
    { id: "export.svg", title: "Export SVG", icon: "export", source: "core" },
    { id: "export.png", title: "Export PNG", icon: "export", source: "core", enabled: hasObjects },
    {
      id: "chemistry.validateSelection",
      title: "Validate Selected Structure",
      icon: "atom",
      source: "core",
      enabled: selectedMolecule !== undefined
    }
  ];
}

const paletteGroups: CommandSpec[][] = [
  [
    { id: "tool.select", title: "Select", icon: "select", shortcut: "V", source: "core" },
    { id: "tool.adapterFallback", title: "Insert Adapter Fallback Molecule", icon: "atom", source: "core" },
    { id: "tool.lasso", title: "Lasso", icon: "lasso", shortcut: "L", source: "core", enabled: false }
  ],
  [
    { id: "tool.bond", title: "Bond", icon: "bond", shortcut: "B", source: "core", enabled: false },
    { id: "tool.atom", title: "Atom", icon: "atom", shortcut: "A", source: "core", enabled: false },
    { id: "tool.ring", title: "Ring", icon: "ring", shortcut: "R", source: "core", enabled: false },
    { id: "tool.chain", title: "Chain", icon: "chain", shortcut: "C", source: "core", enabled: false }
  ],
  [
    { id: "tool.mechanismArrow", title: "Mechanism Arrow", icon: "mechanism", shortcut: "M", source: "core", enabled: false },
    { id: "tool.charge", title: "Charge", icon: "charge", shortcut: "+", source: "core", enabled: false },
    { id: "tool.text", title: "Text", icon: "text", shortcut: "T", source: "core", enabled: false },
    { id: "tool.bracket", title: "Bracket", icon: "bracket", source: "core", enabled: false }
  ],
  [
    { id: "layout.group", title: "Group", icon: "group", source: "core", enabled: false },
    { id: "layout.align", title: "Align", icon: "align", source: "core", enabled: false },
    { id: "style.applyPreset", title: "Style Preset", icon: "style", source: "core", enabled: false }
  ]
];

const drawerActions: CommandSpec[] = [
  { id: "view.toggleInspector", title: "Toggle Inspector", icon: "inspector", source: "core" },
  { id: "view.togglePlugins", title: "Toggle Plugins", icon: "plugin", source: "core" }
];

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chemistryAdapter = useMemo(() => createRdkitPlaceholderAdapter(), []);
  const [document, setDocument] = useState(() => createPhase4Document());
  const [activeTool, setActiveTool] = useState("tool.select");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [zoom, setZoom] = useState(100);
  const [status, setStatus] = useState("Blank native document");
  const [lastAnalysis, setLastAnalysis] = useState<StructureAnalysisResult | null>(null);

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

    return commandRegistry;
  }, [chemistryAdapter, document, quickActions]);

  const invoke = (commandId: string) => {
    void registry.invoke(commandId).catch(() => {
      setStatus("Command unavailable");
    });
  };

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
    <main className="app-shell" aria-label="ChemDraft desktop workspace">
      <input
        ref={fileInputRef}
        type="file"
        accept=".chemdraft,application/json,application/vnd.chemdraft+json"
        className="native-file-input"
        aria-label="Open native ChemDraft document"
        onChange={handleOpenFile}
      />
      <header className="menu-bar">
        <div className="traffic-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="brand">ChemDraft</div>
        <nav className="menu" aria-label="Application menu">
          {menuItems.map((item) => (
            <button type="button" key={item}>
              {item}
            </button>
          ))}
        </nav>
      </header>

      <section className="command-bar" aria-label="Quick actions">
        <div className="document-tabs" aria-label="Document tabs">
          <button type="button" className="active-tab" title={document.title}>
            {document.title}
          </button>
        </div>
        <Toolbar commands={quickActions} registry={registry} onInvoke={invoke} />
        <div className="style-strip" aria-label="Style controls">
          <button type="button" disabled>
            1.2 px
          </button>
          <button type="button" disabled>
            10 pt
          </button>
          <button type="button" disabled>
            ACS
          </button>
        </div>
      </section>

      <section className="workspace">
        <ToolPalette groups={paletteGroups} activeTool={activeTool} registry={registry} onInvoke={invoke} />

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
            <IconButton
              key={action.id}
              command={action}
              active={
                (action.id === "view.toggleInspector" && drawer === "inspector") ||
                (action.id === "view.togglePlugins" && drawer === "plugins")
              }
              registry={registry}
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
  registry,
  onInvoke
}: {
  commands: CommandSpec[];
  registry: CommandRegistry;
  onInvoke: (commandId: string) => void;
}) {
  return (
    <div className="quick-toolbar">
      {commands.map((command, index) => (
        <IconButton
          key={command.id}
          command={command}
          registry={registry}
          onInvoke={onInvoke}
          separated={index === 3 || index === 7}
        />
      ))}
    </div>
  );
}

function ToolPalette({
  groups,
  activeTool,
  registry,
  onInvoke
}: {
  groups: CommandSpec[][];
  activeTool: string;
  registry: CommandRegistry;
  onInvoke: (commandId: string) => void;
}) {
  return (
    <aside className="tool-palette" aria-label="Drawing tools">
      {groups.map((group) => (
        <div className="tool-group" key={group.map((tool) => tool.id).join("-")}>
          {group.map((tool) => (
            <IconButton
              key={tool.id}
              command={tool}
              active={activeTool === tool.id}
              registry={registry}
              onInvoke={onInvoke}
              showShortcut
            />
          ))}
        </div>
      ))}
    </aside>
  );
}

function IconButton({
  command,
  active = false,
  separated = false,
  showShortcut = false,
  registry,
  onInvoke
}: {
  command: CommandSpec;
  active?: boolean;
  separated?: boolean;
  showShortcut?: boolean;
  registry: CommandRegistry;
  onInvoke: (commandId: string) => void;
}) {
  const definition = registry.get(command.id);
  const disabled = definition?.enabled === false;
  const shortcutText = command.shortcut ? ` (${command.shortcut})` : "";
  const stateText = disabled ? ": unavailable until an EditorAdapter or file workflow is connected" : "";

  return (
    <button
      type="button"
      className={["icon-button", active ? "active" : "", separated ? "separated" : ""].filter(Boolean).join(" ")}
      title={`${command.title}${shortcutText}${stateText}`}
      aria-label={`${command.title}${shortcutText}${stateText}`}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={() => onInvoke(command.id)}
    >
      <Icon name={command.icon} />
      {showShortcut && command.shortcut ? <span className="shortcut">{command.shortcut}</span> : null}
    </button>
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
