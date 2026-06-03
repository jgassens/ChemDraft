import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyPatch,
  ChemDraftSyntheticStylePreset,
  stylePresetToObjectStyle,
  type DocumentObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import {
  allShellCommands,
  atomElementActions,
  createQuickActions,
  editActions,
  pageOrientationActions,
  pageSizeActions,
  paletteGroups,
  textToolbarActions,
  toolbarCustomizationActions,
  viewActions
} from "./commands";
import {
  applyAnalysisToSelectedMolecule,
  applyFreeformSingleBondToolAtPoint,
  applyNativeAtomElementTarget,
  applyNativeMoleculeBondOrderTarget,
  applyNativeMoleculeDeleteTarget,
  applySingleBondToolAtPoint,
  createPhase4Document,
  insertAdapterFallbackMolecule,
  insertNativeSingleBondMolecule,
  insertNativeTextObject,
  nativeAtomHitRadiusPx,
  nativeBondLengthPx,
  reorderSelectedDocumentObject,
  setDocumentPageOrientation,
  setDocumentPageSize
} from "./documentWorkflow";
import {
  MainWindow,
  ObjectLayerContextMenu,
  SelectionMarqueeOverlay,
  nativeDeleteTargetFromSelectionPart,
  resolvePngCanvasSize,
  shouldActivateDocumentObject,
  shouldDragDocumentObject,
  shouldOpenMoleculeEditorFromObjectClick
} from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
import { createDesktopShortcutRegistry } from "./keyboardShortcuts";
import {
  DEFAULT_TOOLSET_ID,
  TOOLSET_WINDOW_STATE_EVENT,
  createPaletteCommandPayload,
  createToolsetCommandPayload,
  createToolsetWindowStatePayload
} from "./window-manager";
import {
  createDesktopToolsetRegistry,
  desktopToolsetRegistry,
  getToolbarsMenuModel,
  getToolsetCommandGroups,
  getToolsetCommandSpecs,
  getToolsetToggleActions
} from "./toolsets";

function svgLineNumberAttribute(lineMarkup: string, attribute: "x1" | "y1" | "x2" | "y2"): number {
  const match = lineMarkup.match(new RegExp(`${attribute}="([^"]+)"`));
  return Number(match?.[1]);
}

function svgLineLength(lineMarkup: string): number {
  return Math.hypot(
    svgLineNumberAttribute(lineMarkup, "x2") - svgLineNumberAttribute(lineMarkup, "x1"),
    svgLineNumberAttribute(lineMarkup, "y2") - svgLineNumberAttribute(lineMarkup, "y1")
  );
}

describe("ChemDraft desktop shell", () => {
  it("renders compact web-preview workspace regions with a floating fallback palette", () => {
    const markup = renderToStaticMarkup(createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: false }));

    expect(markup).toContain("app-shell");
    expect(markup).toContain("web-floating-palette");
    expect(markup).toContain("data-floating-palette");
    expect(markup).toContain("tool-palette");
    expect(markup).toContain("canvas-region");
    expect(markup).toContain("rulers-visible");
    expect(markup).toContain("document-rulers-overlay");
    expect(markup).toContain("ruler-top");
    expect(markup).toContain("crosshair-axis-vertical");
    expect(markup).toContain("crosshair-tick-quarter");
    expect(markup).toContain("document-board without-rulers");
    expect(markup).not.toContain("menu-bar");
    expect(markup).not.toContain("command-bar");
    expect(markup).not.toContain("statusbar");
    expect(markup).not.toContain("EditorAdapter not connected");
    expect(markup).not.toContain("tool-palette docked");
    expect(markup.indexOf("web-floating-palette")).toBeLessThan(markup.indexOf('class="workspace"'));
  });

  it("renders the main desktop document window without an in-window palette by default", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).toContain("app-shell");
    expect(markup).toContain("native-shell");
    expect(markup).toContain("canvas-region");
    expect(markup).toContain("rulers-visible");
    expect(markup).toContain("document-rulers-overlay");
    expect(markup).toContain("ruler-top");
    expect(markup).toContain('data-zoom-surface="document"');
    expect(markup).toContain('data-can-undo="false"');
    expect(markup).toContain('data-can-redo="false"');
    expect(markup).toContain("crosshair-axis-horizontal");
    expect(markup).toContain("crosshair-tick-half");
    expect(markup).toContain("document-board without-rulers");
    expect(markup).not.toContain("menu-bar");
    expect(markup).not.toContain("command-bar");
    expect(markup).not.toContain("tool-palette");
    expect(markup).not.toContain("drawer-rail");
    expect(markup).not.toContain("statusbar");
  });

  it("renders the native palette route as an independent palette-only surface", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow));

    expect(markup).toContain("palette-window-shell");
    expect(markup).toContain("data-palette-drag-surface");
    expect(markup).toContain("palette-close-button");
    expect(markup).toContain('aria-label="Hide Main Toolbar"');
    expect(markup).toContain("Main");
    expect(markup).toContain("tool-palette");
    expect(markup).toContain(`data-toolset-id="${DEFAULT_TOOLSET_ID}"`);
    expect(markup).not.toContain("app-shell");
    expect(markup).not.toContain("canvas-region");
    expect(markup).not.toContain("utility-drawer");
  });

  it("keeps every non-canvas panel out of the document window by default", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).not.toContain("utility-drawer");
    expect(markup).not.toContain("drawer-title");
    expect(markup).not.toContain("adapter-state");
    expect(markup).not.toContain("margin-guide");
  });

  it("hides the crosshair overlay and page grid together", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialCrosshairsVisible: false,
        initialPaletteMode: "floating",
        nativePalette: true
      })
    );

    expect(markup).toContain("crosshairs-hidden");
    expect(markup).not.toContain("crosshairs-visible");
    expect(markup).not.toContain("crosshair-overlay");
    expect(markup).not.toContain("crosshair-tick");
  });

  it("can render the document workspace with rulers hidden", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialPaletteMode: "floating",
        initialRulersVisible: false,
        nativePalette: true
      })
    );

    expect(markup).toContain("canvas-region");
    expect(markup).not.toContain("rulers-visible");
    expect(markup).not.toContain("document-rulers-overlay");
    expect(markup).not.toContain("ruler-top");
  });

  it("renders the selection marquee in scaled page coordinates", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionMarqueeOverlay, {
        startPoint: { x: 20, y: 30 },
        latestPoint: { x: 70, y: 90 }
      })
    );

    expect(markup).toContain("selection-marquee");
    expect(markup).toContain("left:calc(20px * var(--page-scale))");
    expect(markup).toContain("top:calc(30px * var(--page-scale))");
    expect(markup).toContain("width:calc(50px * var(--page-scale))");
    expect(markup).toContain("height:calc(60px * var(--page-scale))");
  });

  it("keeps command definitions available without embedding actions in the canvas", () => {
    const document = createPhase4Document();
    const commands = allShellCommands(document);
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: false })
    );

    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
    expect(commands.some((command) => command.id === "document.open")).toBe(true);
    expect(commands.some((command) => command.id === "view.toggleRulers")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.legal")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.a4")).toBe(true);
    expect(commands.some((command) => command.id === "page.setSize.a0")).toBe(true);
    expect(commands.some((command) => command.id === "page.setOrientation.landscape")).toBe(true);
    expect(commands.some((command) => command.id === "layout.bringForward")).toBe(true);
    expect(commands.some((command) => command.id === "layout.sendBackward")).toBe(true);
    expect(commands.some((command) => command.id === "layout.bringToFront")).toBe(true);
    expect(commands.some((command) => command.id === "layout.sendToBack")).toBe(true);
    expect(commands.some((command) => command.id === "view.toolset.toggle.core.main")).toBe(true);
    expect(commands.some((command) => command.id === "tool.atom")).toBe(true);
    expect(commands.some((command) => command.id === "atom.setHoveredElement.O")).toBe(true);
    expect(markup).not.toContain("Open Native Document");
    expect(markup).not.toContain("Validate Selected Structure");
  });

  it("builds keyboard shortcuts from command definitions", () => {
    const registry = createDesktopShortcutRegistry(allShellCommands(createPhase4Document()), "macos");

    expect(registry.resolve({ key: "v" })).toBe("tool.select");
    expect(registry.resolve({ key: "r", metaKey: true })).toBe("view.toggleRulers");
    expect(registry.resolve({ key: "r", metaKey: true, shiftKey: true })).toBe("view.toggleCrosshairs");
    expect(registry.resolve({ key: "v", metaKey: true })).toBe("clipboard.paste");
    expect(registry.resolve({ key: "b" })).toBe("tool.bond");
    expect(registry.resolve({ key: "1" })).toBe("atom.addSingleBondToHoveredAtom");
    expect(registry.resolve({ key: "+" })).toBe("tool.plus");
    expect(registry.resolve({ key: "-" })).toBe("tool.minus");
    expect(registry.resolve({ key: "o" })).toBeUndefined();
    expect(registry.resolve({ key: "Backspace" })).toBe("edit.deleteHoveredNativeTarget");
    expect(registry.resolve({ key: "Delete" })).toBe("edit.forwardDeleteHoveredNativeTarget");
    expect(registry.conflicts()).toEqual([]);
  });

  it("only exposes undo and redo shortcuts when document history can move", () => {
    const document = createPhase4Document();
    const disabledRegistry = createDesktopShortcutRegistry(createQuickActions(document, undefined), "macos");
    const enabledRegistry = createDesktopShortcutRegistry(
      createQuickActions(document, undefined, { canUndo: true, canRedo: true }),
      "macos"
    );

    expect(disabledRegistry.resolve({ key: "z", metaKey: true })).toBeUndefined();
    expect(disabledRegistry.resolve({ key: "z", metaKey: true, shiftKey: true })).toBeUndefined();
    expect(enabledRegistry.resolve({ key: "z", metaKey: true })).toBe("edit.undo");
    expect(enabledRegistry.resolve({ key: "z", metaKey: true, shiftKey: true })).toBe("edit.redo");
    expect(enabledRegistry.conflicts()).toEqual([]);
  });

  it("defines View menu commands for optional canvas scaffolding", () => {
    expect(viewActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "view.toggleRulers", title: "Toggle Rulers" }),
        expect.objectContaining({ id: "view.toggleCrosshairs", title: "Toggle Crosshairs" })
      ])
    );
  });

  it("defines command-backed hovered atom element actions without global shortcut conflicts", () => {
    expect(atomElementActions.map((command) => command.id)).toEqual([
      "atom.setHoveredElement.H",
      "atom.setHoveredElement.B",
      "atom.setHoveredElement.C",
      "atom.setHoveredElement.N",
      "atom.setHoveredElement.O",
      "atom.setHoveredElement.F",
      "atom.setHoveredElement.P",
      "atom.setHoveredElement.S",
      "atom.setHoveredElement.I"
    ]);
    expect(atomElementActions.every((command) => command.shortcut === undefined)).toBe(true);
  });

  it("defines command-backed hovered atom growth and charge actions", () => {
    expect(editActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "atom.addSingleBondToHoveredAtom", shortcut: "1" }),
      expect.objectContaining({ id: "atom.addPositiveChargeToHoveredAtom" }),
      expect.objectContaining({ id: "atom.addNegativeChargeToHoveredAtom" })
    ]));
    expect(editActions.find((command) => command.id === "atom.addPositiveChargeToHoveredAtom")?.shortcut).toBeUndefined();
    expect(editActions.find((command) => command.id === "atom.addNegativeChargeToHoveredAtom")?.shortcut).toBeUndefined();
  });

  it("defines minimal command-backed page-size and orientation controls", () => {
    expect(pageSizeActions.map((command) => command.id)).toEqual([
      "page.setSize.letter",
      "page.setSize.legal",
      "page.setSize.a4",
      "page.setSize.a3",
      "page.setSize.a2",
      "page.setSize.a1",
      "page.setSize.a0",
      "page.setSize.a5"
    ]);
    expect(pageOrientationActions.map((command) => command.id)).toEqual([
      "page.setOrientation.portrait",
      "page.setOrientation.landscape"
    ]);
  });

  it("defines disabled toolbar customization command placeholders", () => {
    expect(toolbarCustomizationActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "view.customizeToolbars",
          enabled: false,
          disabledReason: "Toolbar customization UI is not implemented yet"
        }),
        expect.objectContaining({ id: "view.toolset.resetLayout", enabled: false }),
        expect.objectContaining({ id: "view.toolset.resetAllLayouts", enabled: false }),
        expect.objectContaining({ id: "view.toolset.createUserToolset", enabled: false }),
        expect.objectContaining({ id: "view.toolset.cloneToolset", enabled: false })
      ])
    );
  });

  it("defines command-backed text toolbar actions", () => {
    expect(textToolbarActions.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "text.font.system",
        "text.size.12",
        "text.color.black",
        "text.spacing.normal",
        "text.lineHeight.normal",
        "text.align.left",
        "text.paragraph.none",
        "text.bold",
        "text.italic",
        "text.underline"
      ])
    );
    expect(getToolsetCommandGroups("core.text").flat().map((command) => command.id)).toEqual(
      expect.arrayContaining(["tool.text", "text.font.system", "text.align.justify", "text.paragraph.medium"])
    );
  });

  it("keeps unsupported chemistry tools disabled while native single bond is enabled", () => {
    const enabledToolIds = new Set([
      "tool.select",
      "tool.text",
      "tool.bond",
      "tool.plus",
      "tool.minus",
      "layout.bringToFront",
      "layout.bringForward",
      "layout.sendBackward",
      "layout.sendToBack"
    ]);
    const disabledTools = paletteGroups.flat().filter((command) => !enabledToolIds.has(command.id));

    expect(paletteGroups.flat().find((command) => command.id === "tool.bond")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.text")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.plus")).toMatchObject({ enabled: true });
    expect(paletteGroups.flat().find((command) => command.id === "tool.minus")).toMatchObject({ enabled: true });
    expect(disabledTools.length).toBeGreaterThan(30);
    expect(disabledTools.every((command) => command.enabled === false)).toBe(true);
  });

  it("keeps palette buttons backed by command ids", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow));

    for (const command of paletteGroups.flat()) {
      expect(markup).toContain(`data-command-id="${command.id}"`);
      expect(markup).toContain(command.title);
    }
  });

  it("registers built-in and plugin fixture toolsets", () => {
    const toolsets = desktopToolsetRegistry.listToolsets();
    const ids = toolsets.map((toolset) => toolset.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "core.main",
        "core.structure",
        "core.arrows",
        "core.annotations",
        "core.orbitals",
        "core.layout",
        "core.style",
        "core.text",
        "plugin.fixture"
      ])
    );
    expect(desktopToolsetRegistry.require("core.main").defaultVisible).toBe(true);
    expect(desktopToolsetRegistry.require("plugin.fixture").source).toBe("plugin");
  });

  it("builds View > Toolbars menu items from registered toolsets", () => {
    const menu = getToolbarsMenuModel(new Set(["core.main"]));

    expect(menu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Main Toolbar",
          commandId: "view.toolset.toggle.core.main",
          checked: true
        }),
        expect.objectContaining({
          title: "Text Toolbar",
          commandId: "view.toolset.toggle.core.text",
          checked: false
        }),
        expect.objectContaining({
          title: "Fixture Plugin Toolbar",
          commandId: "view.toolset.toggle.plugin.fixture",
          checked: false,
          source: "plugin"
        })
      ])
    );
  });

  it("applies persisted toolbar layout state to startup registry and menu models", () => {
    const registry = createDesktopToolsetRegistry({
      version: 1,
      toolsetOrder: ["user.quick", "plugin.fixture", "core.main"],
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          title: "My Main Toolbar",
          visible: false,
          hiddenCommandIds: ["tool.lasso"],
          itemOrder: {
            "core.main.selection": ["tool.text", "tool.select", "tool.eraser"]
          }
        }
      ],
      userToolsets: [
        {
          id: "user.quick",
          title: "My Quick Tools",
          source: "user",
          defaultVisible: true,
          defaultMode: "floating",
          groups: [
            {
              id: "user.quick.tools",
              items: [
                { commandId: "tool.select", title: "Selection Tool" },
                { commandId: "plugin.fixture.toolset.ping", title: "Fixture Toolset Command" }
              ]
            }
          ]
        }
      ]
    });
    const menu = getToolbarsMenuModel(new Set(["user.quick"]), registry);

    expect(registry.listToolsets().map((toolset) => toolset.id).slice(0, 3)).toEqual([
      "user.quick",
      "plugin.fixture",
      "core.main"
    ]);
    expect(registry.require("core.main").title).toBe("My Main Toolbar");
    expect(registry.require("core.main").defaultVisible).toBe(false);
    expect(menu[0]).toMatchObject({
      title: "My Quick Tools",
      commandId: "view.toolset.toggle.user.quick",
      checked: true,
      source: "user"
    });
    expect(getToolsetCommandGroups("core.main", registry)[0].map((command) => command.id)).toEqual([
      "tool.text",
      "tool.select",
      "tool.eraser"
    ]);
  });

  it("creates toggle commands for every registered toolset", () => {
    const toggles = getToolsetToggleActions();

    expect(toggles.map((command) => command.id)).toEqual(
      expect.arrayContaining(["view.toolset.toggle.core.structure", "view.toolset.toggle.plugin.fixture"])
    );
    expect(toggles.every((command) => command.category === "view")).toBe(true);
  });

  it("renders an independent plugin fixture toolset surface", () => {
    const markup = renderToStaticMarkup(createElement(PaletteWindow, { toolsetId: "plugin.fixture" }));

    expect(markup).toContain('data-toolset-id="plugin.fixture"');
    expect(markup).toContain('data-command-id="plugin.fixture.toolset.ping"');
    expect(markup).toContain("Fixture");
    expect(markup).not.toContain("canvas-region");
  });

  it("keeps disabled placeholder tools from pretending to perform chemistry", () => {
    const disabledTools = getToolsetCommandSpecs().filter((command) => command.enabled === false);

    expect(disabledTools.length).toBeGreaterThan(30);
    expect(disabledTools.every((command) => command.disabledReason)).toBe(true);
    expect(disabledTools.some((command) => command.id === "tool.wedgeBond")).toBe(true);
    expect(disabledTools.some((command) => command.id === "tool.bond")).toBe(false);
  });

  it("exposes active tool state without rendering fake chemistry", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).toContain('data-active-tool="tool.select"');
    expect(markup).toContain('data-active-tool-kind="selection"');
    expect(markup).not.toContain("Atom Label Tool");
    expect(markup).not.toContain("Single Bond active");
  });

  it("uses custom toolbar assets for the expanded palette", () => {
    const toolCommands = paletteGroups.flat();

    expect(toolCommands.length).toBeGreaterThanOrEqual(48);
    expect(toolCommands.some((command) => command.assetName === "Custom_Bond_Wedge")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Arrow_Equilibrium")).toBe(true);
    expect(toolCommands.some((command) => command.assetName === "Custom_Flip_Horizontal")).toBe(true);
  });

  it("keeps functional metadata on asset-backed palette commands", () => {
    const assetCommands = paletteGroups.flat().filter((command) => command.assetName);

    expect(assetCommands.length).toBeGreaterThanOrEqual(48);
    expect(assetCommands.every((command) => command.category)).toBe(true);
    expect(assetCommands.every((command) => command.description)).toBe(true);
    expect(assetCommands.find((command) => command.assetName === "Custom_Bond_Wedge")).toMatchObject({
      id: "tool.wedgeBond",
      title: "Solid Wedge Bond",
      category: "structure"
    });
  });

  it("routes palette events as command ids only", () => {
    expect(createPaletteCommandPayload("tool.select")).toEqual({ commandId: "tool.select" });
    expect(Object.keys(createPaletteCommandPayload("tool.select"))).toEqual(["commandId"]);
    expect(createToolsetCommandPayload("plugin.fixture.toolset.ping")).toEqual({
      commandId: "plugin.fixture.toolset.ping"
    });
  });

  it("keeps native toolset window state events narrow and serializable", () => {
    expect(TOOLSET_WINDOW_STATE_EVENT).toBe("chemdraft://toolset-window-state");
    expect(createToolsetWindowStatePayload("core.structure", true, false, { x: 120, y: 180 })).toEqual({
      toolsetId: "core.structure",
      open: true,
      focused: false,
      position: { x: 120, y: 180 }
    });
  });

  it("does not show fake chemistry objects on a blank document", () => {
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: true })
    );

    expect(markup).not.toContain("molecule-object");
    expect(markup).not.toContain("reaction");
    expect(markup).not.toContain("product");
    expect(markup).not.toContain("CCO");
  });

  it("renders Phase 5 chemistry properties only for real selected molecule objects", () => {
    const document = applyAnalysisToSelectedMolecule(
      insertAdapterFallbackMolecule(createPhase4Document("Chemistry Fixture")),
      {
        input: { format: "smiles", value: "CCO" },
        validation: { valid: true, errors: [], warnings: [] },
        properties: {
          formula: "C2H6O",
          averageMass: 46.069,
          exactMass: 46.0419,
          totalCharge: 0,
          atomCount: 3,
          bondCount: 2,
          stereochemistry: []
        },
        warnings: []
      }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("molecule-object");
    expect(markup).toContain("C2H6O");
    expect(markup).toContain("avg 46.069");
    expect(markup).toContain("exact 46.0419");
  });

  it("renders native single-bond molecules as document-backed bond geometry", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Bond Render"), { x: 200, y: 220 });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("native-single-bond");
    expect(markup).toContain('data-structure="CC"');
    expect(markup).toContain('data-style-preset-id="chemdraft.synthetic"');
    expect(markup).toContain('stroke-width="2"');
    expect(markup).toContain('stroke-linecap="butt"');
    expect(markup).toContain("native-molecule-selected");
    expect(markup).toContain("native-bond-hit-target");
    expect(markup).toContain("native-atom-hit-target");
    expect(markup).toContain("Molecule C2H6");
    expect(markup).not.toContain("adapter-backed");
  });

  it("renders selected text objects with side resize handles", () => {
    const document = insertNativeTextObject(
      createPhase4Document("Text Box Render"),
      { x: 160, y: 180 },
      "reaction note"
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("text-object");
    expect(markup).toContain('data-text-sizing-mode="auto"');
    expect(markup).toContain('data-text-resize-edge="left"');
    expect(markup).toContain('data-text-resize-edge="right"');
    expect(markup).toContain("reaction note");
  });

  it("renders invalid-valence markers for over-coordinated native atoms", () => {
    const growFromAtom = (document: ReturnType<typeof insertNativeSingleBondMolecule>, atomId: string, angleDegrees: number) => {
      const molecule = document.pages[0].objects[0];
      if (molecule.type !== "molecule") {
        throw new Error("Expected molecule fixture.");
      }
      const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
      if (!atom) {
        throw new Error(`Expected atom "${atomId}".`);
      }

      const steerDistance = nativeAtomHitRadiusPx * 0.65;
      return applySingleBondToolAtPoint(document, {
        x: atom.x + Math.cos(angleDegrees * Math.PI / 180) * steerDistance,
        y: atom.y + Math.sin(angleDegrees * Math.PI / 180) * steerDistance
      });
    };
    const overValent = [-109.5, 109.5, 180, 0].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Invalid Carbon Render"), { x: 300, y: 300 })
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: overValent,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-invalid-atom-ids="atom_001"');
    expect(markup).toContain("native-atom-invalid-marker");
    expect(markup).toContain('data-invalid-atom-id="atom_001"');
  });

  it("renders bonded non-carbon atom labels from native molecule state", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Oxygen Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    const updated = applyNativeAtomElementTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    }, "O");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: updated,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-structure="CO"');
    expect(markup).toContain("native-atom-label-background");
    expect(markup).toContain('font-family="Arial, Helvetica, sans-serif"');
    expect(markup).toContain('data-atom-label="OH"');
    expect(markup).toContain('data-atom-label-run="normal"');
    expect(markup).toContain(">OH</text>");
    expect(markup).not.toContain(">C</text>");
  });

  it("renders explicit quaternary ammonium charge as a compact affix without an invalid marker", () => {
    const ammoniumMolecule = {
      id: "mol_ammonium",
      type: "molecule",
      x: 120,
      y: 120,
      width: 180,
      height: 180,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "C[N+](C)(C)C",
      atoms: [
        { id: "atom_n", element: "N", x: 200, y: 200, formalCharge: 1 },
        { id: "atom_left", element: "C", x: 140, y: 200, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 205, y: 140, formalCharge: 0 },
        { id: "atom_down", element: "C", x: 170, y: 250, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 260, y: 230, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_n", order: "single" },
        { id: "bond_up", fromAtomId: "atom_n", toAtomId: "atom_up", order: "single" },
        { id: "bond_down", fromAtomId: "atom_n", toAtomId: "atom_down", order: "single" },
        { id: "bond_right", fromAtomId: "atom_n", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H12N",
        atomCount: 5,
        bondCount: 4,
        totalCharge: 1,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Ammonium Render"),
      { op: "addObject", pageId: "page_001", object: ammoniumMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const nLabelMarkup = markup.match(/<g class="native-atom-label"[^>]*data-atom-label="N\+"[\s\S]*?<\/g>/)?.[0] ?? "";
    const leftBondMarkup = markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_left"[^>]*>/)?.[0] ?? "";
    const rightBondMarkup = markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_right"[^>]*>/)?.[0] ?? "";

    expect(markup).toContain('data-atom-label="N+"');
    expect(nLabelMarkup).toContain('data-atom-label-run="normal"');
    expect(nLabelMarkup).toContain('text-anchor="middle" x="0" y="0">N</text>');
    expect(nLabelMarkup).toContain('data-atom-label-run="charge"');
    expect(nLabelMarkup).toContain('font-size="13.2"');
    expect(nLabelMarkup).toContain(">+</text>");
    expect(markup).not.toContain("native-atom-invalid-marker");
    expect(markup).not.toContain("native-atom-invalid-ring");
    expect(leftBondMarkup).not.toContain('x2="80"');
    expect(rightBondMarkup).not.toContain('x1="80"');
  });

  it("marks neutral hypervalent nitrogen invalid instead of auto-placing a charge", () => {
    const neutralNitrogenMolecule = {
      id: "mol_neutral_hypervalent_n",
      type: "molecule",
      x: 120,
      y: 120,
      width: 180,
      height: 180,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CN(C)(C)C",
      atoms: [
        { id: "atom_n", element: "N", x: 200, y: 200, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 200, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 205, y: 140, formalCharge: 0 },
        { id: "atom_down", element: "C", x: 170, y: 250, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 260, y: 230, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_n", order: "single" },
        { id: "bond_up", fromAtomId: "atom_n", toAtomId: "atom_up", order: "single" },
        { id: "bond_down", fromAtomId: "atom_n", toAtomId: "atom_down", order: "single" },
        { id: "bond_right", fromAtomId: "atom_n", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H12N",
        atomCount: 5,
        bondCount: 4,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Neutral Hypervalent Nitrogen Render"),
      { op: "addObject", pageId: "page_001", object: neutralNitrogenMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-atom-label="N"');
    expect(markup).not.toContain('data-atom-label="N+"');
    expect(markup).toContain('data-invalid-atom-ids="atom_n"');
    expect(markup).toContain('data-invalid-atom-id="atom_n"');
  });

  it("renders movable charge marks as valence-resolution objects only while close to the atom", () => {
    const neutralNitrogenMolecule = {
      id: "mol_charge_resolution",
      type: "molecule",
      x: 120,
      y: 120,
      width: 180,
      height: 180,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CN(C)(C)C",
      atoms: [
        { id: "atom_n", element: "N", x: 200, y: 200, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 200, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 205, y: 140, formalCharge: 0 },
        { id: "atom_down", element: "C", x: 170, y: 250, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 260, y: 230, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_n", order: "single" },
        { id: "bond_up", fromAtomId: "atom_n", toAtomId: "atom_up", order: "single" },
        { id: "bond_down", fromAtomId: "atom_n", toAtomId: "atom_down", order: "single" },
        { id: "bond_right", fromAtomId: "atom_n", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H12N",
        atomCount: 5,
        bondCount: 4,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const chargeMark = {
      id: "charge_001",
      type: "electron-mark",
      x: 202,
      y: 180,
      width: 18,
      height: 18,
      rotation: 0,
      style: { source: "test-charge" },
      markKind: "charge",
      anchor: { kind: "point", point: { x: 211, y: 189 } },
      charge: 1
    } satisfies DocumentObject;
    const document = applyPatch(
      createPhase4Document("Charge Resolution Render"),
      { op: "addObject", pageId: "page_001", object: neutralNitrogenMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const withCharge = applyPatch(
      document,
      { op: "addObject", pageId: "page_001", object: chargeMark },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const resolvedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: withCharge,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const movedAway = applyPatch(
      withCharge,
      { op: "moveObject", objectId: "charge_001", x: 420, y: 360 },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const unresolvedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: movedAway,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(resolvedMarkup).toContain('class="document-object charge-mark-object"');
    expect(resolvedMarkup).toContain('data-charge="1"');
    expect(resolvedMarkup).toContain('data-resolved-charge-atom-ids="atom_n"');
    expect(resolvedMarkup).not.toContain("native-atom-invalid-marker");
    expect(unresolvedMarkup).not.toContain('data-resolved-charge-atom-ids="atom_n"');
    expect(unresolvedMarkup).toContain('data-invalid-atom-id="atom_n"');
  });

  it("stress-renders charged and hydrogen-count atom labels without recentering the element glyph", () => {
    const labelStressMolecule = {
      id: "mol_label_stress",
      type: "molecule",
      x: 100,
      y: 100,
      width: 520,
      height: 360,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "[B-]([C])([C])([C])[C].[N+]([C])([C])([C])[C].[O+]([C])([C])[C].C.O",
      atoms: [
        { id: "atom_b", element: "B", x: 180, y: 180, formalCharge: -1 },
        { id: "atom_b1", element: "C", x: 130, y: 180, formalCharge: 0 },
        { id: "atom_b2", element: "C", x: 185, y: 130, formalCharge: 0 },
        { id: "atom_b3", element: "C", x: 150, y: 220, formalCharge: 0 },
        { id: "atom_b4", element: "C", x: 235, y: 205, formalCharge: 0 },
        { id: "atom_n", element: "N", x: 330, y: 180, formalCharge: 1 },
        { id: "atom_n1", element: "C", x: 280, y: 180, formalCharge: 0 },
        { id: "atom_n2", element: "C", x: 335, y: 130, formalCharge: 0 },
        { id: "atom_n3", element: "C", x: 300, y: 220, formalCharge: 0 },
        { id: "atom_n4", element: "C", x: 385, y: 205, formalCharge: 0 },
        { id: "atom_o", element: "O", x: 470, y: 180, formalCharge: 1 },
        { id: "atom_o1", element: "C", x: 430, y: 180, formalCharge: 0 },
        { id: "atom_o2", element: "C", x: 485, y: 135, formalCharge: 0 },
        { id: "atom_o3", element: "C", x: 500, y: 220, formalCharge: 0 },
        { id: "atom_ch4", element: "C", x: 230, y: 300, formalCharge: 0 },
        { id: "atom_oh2", element: "O", x: 360, y: 300, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_b1", fromAtomId: "atom_b", toAtomId: "atom_b1", order: "single" },
        { id: "bond_b2", fromAtomId: "atom_b", toAtomId: "atom_b2", order: "single" },
        { id: "bond_b3", fromAtomId: "atom_b", toAtomId: "atom_b3", order: "single" },
        { id: "bond_b4", fromAtomId: "atom_b", toAtomId: "atom_b4", order: "single" },
        { id: "bond_n1", fromAtomId: "atom_n", toAtomId: "atom_n1", order: "single" },
        { id: "bond_n2", fromAtomId: "atom_n", toAtomId: "atom_n2", order: "single" },
        { id: "bond_n3", fromAtomId: "atom_n", toAtomId: "atom_n3", order: "single" },
        { id: "bond_n4", fromAtomId: "atom_n", toAtomId: "atom_n4", order: "single" },
        { id: "bond_o1", fromAtomId: "atom_o", toAtomId: "atom_o1", order: "single" },
        { id: "bond_o2", fromAtomId: "atom_o", toAtomId: "atom_o2", order: "single" },
        { id: "bond_o3", fromAtomId: "atom_o", toAtomId: "atom_o3", order: "single" }
      ],
      chemistry: {
        formula: "BNO",
        atomCount: 16,
        bondCount: 11,
        totalCharge: 1,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Label Stress Render"),
      { op: "addObject", pageId: "page_001", object: labelStressMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    for (const label of ["B-", "N+", "O+", "CH4", "OH2"]) {
      expect(markup).toContain(`data-atom-label="${label}"`);
    }
    expect(markup.match(/data-atom-label-run="charge"/g) ?? []).toHaveLength(3);
    expect(markup.match(/data-atom-label-run="subscript"/g) ?? []).toHaveLength(2);
    expect(markup.match(/text-anchor="middle" x="0" y="0">[BNO]<\/text>/g) ?? []).toHaveLength(3);
    expect(markup).not.toContain("native-atom-invalid-marker");
  });

  it("renders disconnected methane labels after deleting a central native carbon", () => {
    const growFromAtom = (document: ReturnType<typeof insertNativeSingleBondMolecule>, atomId: string, angleDegrees: number) => {
      const molecule = document.pages[0].objects[0];
      if (molecule.type !== "molecule") {
        throw new Error("Expected molecule fixture.");
      }
      const atom = molecule.atoms.find((candidate) => candidate.id === atomId);
      if (!atom) {
        throw new Error(`Expected atom "${atomId}".`);
      }

      const steerDistance = nativeAtomHitRadiusPx * 0.65;
      return applySingleBondToolAtPoint(document, {
        x: atom.x + Math.cos(angleDegrees * Math.PI / 180) * steerDistance,
        y: atom.y + Math.sin(angleDegrees * Math.PI / 180) * steerDistance
      });
    };
    const neopentane = [-109.5, 109.5, 180].reduce(
      (current, angle) => growFromAtom(current, "atom_001", angle),
      insertNativeSingleBondMolecule(createPhase4Document("Methane Labels"), { x: 300, y: 300 })
    );
    const molecule = neopentane.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected neopentane molecule fixture.");
    }
    const deleted = applyNativeMoleculeDeleteTarget(neopentane, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_001",
      distanceToPointer: 0
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: deleted,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup.match(/data-atom-label="CH4"/g) ?? []).toHaveLength(4);
    expect(markup.match(/data-atom-label-run="subscript"[^>]*>4<\/text>/g) ?? []).toHaveLength(4);
    expect(markup).toContain('data-structure="C.C.C.C"');
    expect(markup).toContain("Molecule C4H16");
    expect(markup).not.toContain("native-bond-line");
  });

  it("renders explicit hydrogen atom labels from native molecule state", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Hydrogen Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }
    const sourceAtom = molecule.atoms.find((atom) => atom.id === "atom_001");
    if (!sourceAtom) {
      throw new Error("Expected source atom.");
    }
    const withHydrogenBond = applyFreeformSingleBondToolAtPoint(
      document,
      molecule.id,
      "atom_001",
      { x: sourceAtom.x - nativeBondLengthPx * 0.7, y: sourceAtom.y },
      { forceCustomLength: true }
    );
    const hydrogenMolecule = withHydrogenBond.pages[0].objects[0];
    if (hydrogenMolecule.type !== "molecule") {
      throw new Error("Expected hydrogen molecule fixture.");
    }
    const hydrogenAtomId = hydrogenMolecule.atoms.at(-1)?.id;
    if (!hydrogenAtomId) {
      throw new Error("Expected explicit hydrogen atom.");
    }
    const updated = applyNativeAtomElementTarget(withHydrogenBond, {
      objectId: hydrogenMolecule.id,
      kind: "atom",
      atomId: hydrogenAtomId,
      distanceToPointer: 0
    }, "H");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: updated,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain('data-atom-label="H"');
    expect(markup).toContain('data-atom-label-run="normal"');
    expect(markup).toContain(">H</text>");
    expect(markup).toContain('data-atom-count="3"');
  });

  it("keeps the narrow Ketcher host closed for document selection alone", () => {
    const blankMarkup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "hidden", nativePalette: true })
    );
    const document = insertNativeSingleBondMolecule(createPhase4Document("Ketcher Host"), { x: 200, y: 220 });
    const selectedMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(blankMarkup).not.toContain("ketcher-editor-host");
    expect(selectedMarkup).not.toContain("ketcher-editor-host");
    expect(selectedMarkup).not.toContain("Loading Ketcher molecule editor");
  });

  it("keeps molecule-editor activation out of selection clicks", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Active Molecule"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    const label = {
      id: "label_001",
      type: "text",
      x: 120,
      y: 120,
      width: 80,
      height: 24,
      rotation: 0,
      style: {},
      text: "Label",
      spans: []
    } satisfies DocumentObject;

    expect(shouldActivateDocumentObject(molecule, "bond")).toBe(false);
    expect(shouldActivateDocumentObject(molecule, "selection")).toBe(true);
    expect(shouldActivateDocumentObject(label, "bond")).toBe(false);
    expect(shouldActivateDocumentObject(label, "selection")).toBe(true);
    expect(shouldOpenMoleculeEditorFromObjectClick(molecule, "selection", 1)).toBe(false);
    expect(shouldOpenMoleculeEditorFromObjectClick(molecule, "selection", 2)).toBe(false);
    expect(shouldOpenMoleculeEditorFromObjectClick(molecule, "bond", 2)).toBe(false);
    expect(shouldOpenMoleculeEditorFromObjectClick(label, "selection", 2)).toBe(false);
  });

  it("resolves selected native atom and bond parts into command targets", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Selected Part Target"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }

    expect(nativeDeleteTargetFromSelectionPart(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002"
    })).toEqual({
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    });
    expect(nativeDeleteTargetFromSelectionPart(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001"
    })).toEqual({
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    });
    expect(nativeDeleteTargetFromSelectionPart(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "missing_atom"
    })).toBeUndefined();
  });

  it("lets existing charge marks move while charge tools stay active", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Charge Drag"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    const chargeMark = {
      id: "charge_001",
      type: "electron-mark",
      x: 240,
      y: 180,
      width: 18,
      height: 18,
      rotation: 0,
      style: {},
      markKind: "charge",
      anchor: { kind: "point", point: { x: 249, y: 189 } },
      charge: 1
    } satisfies DocumentObject;

    expect(shouldDragDocumentObject(chargeMark, "charge")).toBe(true);
    expect(shouldDragDocumentObject(chargeMark, "selection")).toBe(true);
    expect(shouldDragDocumentObject(molecule, "charge")).toBe(false);
    expect(shouldDragDocumentObject(chargeMark, "bond")).toBe(false);
  });

  it("renders connected native molecule graphs from one document object", () => {
    const initial = insertNativeSingleBondMolecule(createPhase4Document("Connected Render"), { x: 200, y: 220 });
    const initialMolecule = initial.pages[0].objects[0];
    if (initialMolecule.type !== "molecule") {
      throw new Error("Expected native molecule fixture.");
    }
    const terminalAtom = initialMolecule.atoms.find((atom) => atom.id === "atom_002");
    if (!terminalAtom) {
      throw new Error("Expected terminal atom.");
    }
    const document = applySingleBondToolAtPoint(initial, {
      x: terminalAtom.x + nativeAtomHitRadiusPx * 0.65,
      y: terminalAtom.y
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain("native-carbon-chain");
    expect(markup).toContain('data-structure="CCC"');
    expect(markup).toContain('data-atom-count="3"');
    expect(markup).toContain('data-bond-count="2"');
    expect((markup.match(/native-bond-line/g) ?? []).length).toBe(2);
    expect(document.pages[0].objects).toHaveLength(1);
  });

  it("renders asymmetric double bonds with overlap clearance strokes", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Double Bond Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }
    const doubleBond = applyNativeMoleculeBondOrderTarget(document, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: doubleBond,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect((markup.match(/native-bond-line/g) ?? []).length).toBe(2);
    expect((markup.match(/native-bond-knockout/g) ?? []).length).toBe(2);
    expect(markup).toContain('data-bond-segment="primary"');
    expect(markup).toContain('data-bond-segment="secondary"');
    expect(markup).toContain('data-double-bond-side="left"');
  });

  it("keeps heteroatom double-bond secondary strokes visibly long after label clearance", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document("Carbonyl Render"), { x: 200, y: 220 });
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected molecule fixture.");
    }
    const withOxygen = applyNativeAtomElementTarget(document, {
      objectId: molecule.id,
      kind: "atom",
      atomId: "atom_002",
      distanceToPointer: 0
    }, "O");
    const carbonyl = applyNativeMoleculeBondOrderTarget(withOxygen, {
      objectId: molecule.id,
      kind: "bond",
      bondId: "bond_001",
      fromAtomId: "atom_001",
      toAtomId: "atom_002",
      distanceToPointer: 0
    });
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: carbonyl,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const secondaryLineMarkup = markup.match(
      /<line class="native-bond-line native-bond-double" data-bond-id="bond_001" data-bond-order="double" data-bond-segment="secondary"[^>]*>/
    )?.[0] ?? "";

    expect(markup).toContain('data-structure="C=O"');
    expect(markup).toContain('data-atom-label="O"');
    expect(secondaryLineMarkup).not.toBe("");
    expect(svgLineLength(secondaryLineMarkup)).toBeGreaterThanOrEqual(13);
  });

  it("renders document object order as explicit visual layers for molecule over-under crossings", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Layer Render"), { x: 200, y: 220 });
    const second = insertNativeSingleBondMolecule(first, { x: 200, y: 220 });
    const sentBackward = reorderSelectedDocumentObject(second, "backward");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: sentBackward,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const backObjectIndex = markup.indexOf('data-object-id="mol_bond_002"');
    const frontObjectIndex = markup.indexOf('data-object-id="mol_bond_001"');

    expect(sentBackward.pages[0].objects.map((object) => object.id)).toEqual(["mol_bond_002", "mol_bond_001"]);
    expect(backObjectIndex).toBeGreaterThan(-1);
    expect(frontObjectIndex).toBeGreaterThan(-1);
    expect(backObjectIndex).toBeLessThan(frontObjectIndex);
    expect(markup).toContain('data-object-id="mol_bond_002" data-layer-index="0"');
    expect(markup).toContain('data-object-id="mol_bond_001" data-layer-index="1"');
    expect(markup).toContain("z-index:1");
    expect(markup).toContain("z-index:2");

    const frontObjectMarkup = markup.slice(frontObjectIndex);
    expect(frontObjectMarkup.indexOf("native-bond-knockout")).toBeLessThan(
      frontObjectMarkup.indexOf("native-bond-line")
    );
  });

  it("renders selected atom depth controls in the object context menu", () => {
    const markup = renderToStaticMarkup(
      createElement(ObjectLayerContextMenu, {
        objectId: "mol_depth",
        objectIndex: 0,
        objectCount: 2,
        targetKind: "atom",
        position: { x: 20, y: 30 },
        onInvoke: () => undefined
      })
    );

    expect(markup).toContain('data-context-object-id="mol_depth"');
    expect(markup).toContain('data-context-target-kind="atom"');
    expect(markup).toContain("Selected atom depth");
    expect(markup).toContain('data-command-id="layout.bringForward"');
    expect(markup).toContain("Move Forward");
    expect(markup).toContain('data-command-id="layout.bringToFront"');
    expect(markup).toContain("Move to Front");
    expect(markup).toContain('data-command-id="layout.sendBackward"');
    expect(markup).toContain("Move Backward");
    expect(markup).toContain('data-command-id="layout.sendToBack"');
    expect(markup).toContain("Move to Back");
  });

  it("renders later bonds over earlier crossing bonds inside one molecule", () => {
    const crossingMolecule = {
      id: "mol_crossing",
      type: "molecule",
      x: 120,
      y: 120,
      width: 120,
      height: 120,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CC.CC",
      atoms: [
        { id: "atom_back_001", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_back_002", element: "C", x: 220, y: 180, formalCharge: 0 },
        { id: "atom_front_001", element: "C", x: 180, y: 140, formalCharge: 0 },
        { id: "atom_front_002", element: "C", x: 180, y: 220, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_back", fromAtomId: "atom_back_001", toAtomId: "atom_back_002", order: "single" },
        { id: "bond_front", fromAtomId: "atom_front_001", toAtomId: "atom_front_002", order: "single" }
      ],
      chemistry: {
        formula: "C4H12",
        atomCount: 4,
        bondCount: 2,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Crossing Bond Render"),
      { op: "addObject", pageId: "page_001", object: crossingMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const backLayerIndex = markup.indexOf('data-bond-layer-id="bond_back"');
    const frontLayerIndex = markup.indexOf('data-bond-layer-id="bond_front"');
    const backLayerMarkup = markup.slice(backLayerIndex, frontLayerIndex);
    const frontLayerMarkup = markup.slice(frontLayerIndex);

    expect(backLayerIndex).toBeGreaterThan(-1);
    expect(frontLayerIndex).toBeGreaterThan(-1);
    expect(backLayerIndex).toBeLessThan(frontLayerIndex);
    expect(backLayerMarkup.indexOf("native-bond-knockout")).toBeLessThan(
      backLayerMarkup.indexOf("native-bond-line")
    );
    expect(frontLayerMarkup.indexOf("native-bond-knockout")).toBeLessThan(
      frontLayerMarkup.indexOf("native-bond-line")
    );
  });

  it("does not render over-under gaps for bonds sharing one atom", () => {
    const geminalMolecule = {
      id: "mol_geminal",
      type: "molecule",
      x: 120,
      y: 120,
      width: 130,
      height: 130,
      rotation: 0,
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing"
      },
      structureFormat: "smiles",
      structure: "CC(C)C",
      atoms: [
        { id: "atom_center", element: "C", x: 180, y: 180, formalCharge: 0 },
        { id: "atom_left", element: "C", x: 140, y: 180, formalCharge: 0 },
        { id: "atom_up", element: "C", x: 200, y: 140, formalCharge: 0 },
        { id: "atom_right", element: "C", x: 220, y: 165, formalCharge: 0 }
      ],
      bonds: [
        { id: "bond_left", fromAtomId: "atom_left", toAtomId: "atom_center", order: "single" },
        { id: "bond_up", fromAtomId: "atom_center", toAtomId: "atom_up", order: "single" },
        { id: "bond_right", fromAtomId: "atom_center", toAtomId: "atom_right", order: "single" }
      ],
      chemistry: {
        formula: "C4H10",
        atomCount: 4,
        bondCount: 3,
        totalCharge: 0,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: [],
        warnings: []
      },
      superatoms: [],
      rGroups: []
    } satisfies MoleculeObject;
    const document = applyPatch(
      createPhase4Document("Geminal Render"),
      { op: "addObject", pageId: "page_001", object: geminalMolecule },
      { now: "2026-05-29T00:00:00.000Z" }
    );
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const upKnockout = markup.match(/<line class="native-bond-knockout" data-bond-id="bond_up"[^>]*>/)?.[0] ?? "";
    const upLine = markup.match(/<line class="native-bond-line native-bond-single" data-bond-id="bond_up"[^>]*>/)?.[0] ?? "";

    expect(upLine).toContain('x1="60"');
    expect(upLine).toContain('y1="60"');
    expect(upKnockout).not.toContain('x1="60"');
    expect(upKnockout).not.toContain('y1="60"');
  });


  it("renders canvas geometry from the active document page layout", () => {
    const document = setDocumentPageSize(createPhase4Document("A4 Canvas"), "a4");
    const markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(markup).toContain(`--page-layout-width:${document.pages[0].width}px`);
    expect(markup).toContain(`--page-layout-height:${document.pages[0].height}px`);
  });

  it("sets ruler units from the active document page family", () => {
    const a4Document = setDocumentPageSize(createPhase4Document("Metric Canvas"), "a4");
    const legalDocument = setDocumentPageSize(createPhase4Document("US Legal Canvas"), "legal");
    const a4Markup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: a4Document,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );
    const legalMarkup = renderToStaticMarkup(
      createElement(MainWindow, {
        initialDocument: legalDocument,
        initialPaletteMode: "hidden",
        nativePalette: true
      })
    );

    expect(a4Markup).toContain(">cm</span>");
    expect(a4Markup).toContain("crosshair-tick-half");
    expect(legalMarkup).toContain(">in</span>");
    expect(legalMarkup).toContain("crosshair-tick-quarter");
  });

  it("updates page size and orientation without mutating molecule payloads", () => {
    const document = applyAnalysisToSelectedMolecule(
      insertAdapterFallbackMolecule(createPhase4Document("Payload Fixture")),
      {
        input: { format: "smiles", value: "CCO" },
        validation: { valid: true, errors: [], warnings: [] },
        properties: {
          formula: "C2H6O",
          averageMass: 46.069,
          exactMass: 46.0419,
          totalCharge: 0,
          atomCount: 3,
          bondCount: 2,
          stereochemistry: []
        },
        warnings: []
      }
    );
    const moleculeBefore = document.pages[0].objects[0];
    const resized = setDocumentPageOrientation(setDocumentPageSize(document, "a1"), "landscape");

    expect(resized.pages[0].layout).toMatchObject({ presetId: "a1", orientation: "landscape" });
    expect(resized.pages[0].objects[0]).toEqual(moleculeBefore);
    expect(resized.selection).toEqual(document.selection);
  });

  it("uses active page dimensions as the PNG fallback instead of hard-coded Letter", () => {
    expect(resolvePngCanvasSize(0, 0, { width: 1122.5, height: 793.7 })).toEqual({
      width: 1123,
      height: 794
    });
    expect(resolvePngCanvasSize(640, 480, { width: 1122.5, height: 793.7 })).toEqual({
      width: 640,
      height: 480
    });
  });
});
