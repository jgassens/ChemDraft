import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { allShellCommands, paletteGroups, toolbarCustomizationActions, viewActions } from "./commands";
import {
  applyAnalysisToSelectedMolecule,
  createPhase4Document,
  insertAdapterFallbackMolecule
} from "./documentWorkflow";
import { MainWindow } from "./MainWindow";
import { PaletteWindow } from "./PaletteWindow";
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

  it("keeps command definitions available without embedding actions in the canvas", () => {
    const document = createPhase4Document();
    const commands = allShellCommands(document);
    const markup = renderToStaticMarkup(
      createElement(MainWindow, { initialPaletteMode: "floating", nativePalette: false })
    );

    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
    expect(commands.some((command) => command.id === "document.open")).toBe(true);
    expect(commands.some((command) => command.id === "view.toggleRulers")).toBe(true);
    expect(commands.some((command) => command.id === "view.toolset.toggle.core.main")).toBe(true);
    expect(markup).not.toContain("Open Native Document");
    expect(markup).not.toContain("Validate Selected Structure");
  });

  it("defines View menu commands for optional canvas scaffolding", () => {
    expect(viewActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "view.toggleRulers", title: "Toggle Rulers" }),
        expect.objectContaining({ id: "view.toggleCrosshairs", title: "Toggle Crosshairs" })
      ])
    );
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

  it("keeps chemistry tools disabled until an EditorAdapter exists", () => {
    const enabledToolIds = new Set(["tool.select"]);
    const disabledTools = paletteGroups.flat().filter((command) => !enabledToolIds.has(command.id));

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
    expect(disabledTools.some((command) => command.id === "tool.bond")).toBe(true);
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
});
