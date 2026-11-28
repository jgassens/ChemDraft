import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolsetRegistry, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import {
  createDefaultVisibleToolsetIds,
  createDesktopToolsetRegistry,
  defaultDesktopToolsets,
  desktopToolbarProfile,
  desktopToolsets,
  getToolsetPaletteGroups,
  placePaletteGridItems,
  type DesktopToolsetDefinition
} from "../toolsets";
import { MAIN_TOOLBAR_DEFAULTS_REVISION } from "./toolbarLayoutState";
import { applyToolbarProfile, MOLECULE_DRAWING_MAIN_ITEM_IDS } from "./toolbarProfile";
import { parseToolbarProfileName, TOOLBAR_PROFILE_NAMES, toolbarProfileForBuild } from "./toolbarProfileName";

const OTHER_CORE_TOOLSETS = [
  "core.structure", "core.arrows", "core.annotations", "core.art", "core.orbitals", "core.layout",
  "core.style", "core.text", "core.ringInspector", "core.drawnStructureSettings", "core.molecularInspector"
];

const pluginToolset: DesktopToolsetDefinition = {
  id: "plugin.example.game",
  title: "Game",
  source: "plugin",
  defaultVisible: true,
  defaultMode: "floating",
  groups: [{ id: "plugin.example.game.tools", items: [{ kind: "button", commandId: "plugin.example.game.start", title: "Start" }] }]
};

function mainItemIds(registry: ReturnType<typeof createDesktopToolsetRegistry>, groups = getToolsetPaletteGroups): string[] {
  return groups("core.main", registry, new Map(), false).flatMap(group => group.items.map(item => item.id));
}

describe("toolbar profile name", () => {
  it("is unset for empty values and accepts every known profile", () => {
    expect(parseToolbarProfileName(undefined)).toBeUndefined();
    expect(parseToolbarProfileName("")).toBeUndefined();
    expect(parseToolbarProfileName("  ")).toBeUndefined();
    for (const name of TOOLBAR_PROFILE_NAMES) expect(parseToolbarProfileName(name)).toBe(name);
  });

  it("rejects an unknown profile with a specific message", () => {
    expect(() => parseToolbarProfileName("molecule-draw")).toThrow(
      'Unknown CHEMDRAFT_TOOLBAR_PROFILE "molecule-draw". Known profiles: molecule-drawing; leave it unset for the standard toolbars.'
    );
  });
});

describe("toolbar profile in a desktop (Tauri) build", () => {
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is refused for any non-empty value inside a Tauri build, and allowed unset or empty", () => {
    expect(() => toolbarProfileForBuild("molecule-drawing", true)).toThrow(
      /CHEMDRAFT_TOOLBAR_PROFILE="molecule-drawing" is set inside a Tauri build.*browser build only/
    );
    // Even a name no profile has is refused as a desktop profile first, not as a typo.
    expect(() => toolbarProfileForBuild("molecule-draw", true)).toThrow(/inside a Tauri build/);
    expect(toolbarProfileForBuild(undefined, true)).toBeUndefined();
    expect(toolbarProfileForBuild("", true)).toBeUndefined();
    expect(toolbarProfileForBuild("  ", true)).toBeUndefined();
    expect(toolbarProfileForBuild("molecule-drawing", false)).toBe("molecule-drawing");
  });

  it("fails vite.config.ts itself when tauri runs Vite with a profile inherited", async () => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "darwin");
    vi.stubEnv("CHEMDRAFT_TOOLBAR_PROFILE", "molecule-drawing");
    vi.resetModules();
    await expect(import("../../vite.config")).rejects.toThrow(/inside a Tauri build/);
    vi.stubEnv("CHEMDRAFT_TOOLBAR_PROFILE", "");
    vi.resetModules();
    await expect(import("../../vite.config")).resolves.toBeDefined();
  }, 30_000);
});

describe("no toolbar profile (every desktop build and the normal web build)", () => {
  it("starts from the shipped manifest itself", () => {
    expect(desktopToolbarProfile).toBeUndefined();
    expect(applyToolbarProfile(desktopToolsets, undefined)).toBe(desktopToolsets);
    expect(defaultDesktopToolsets).toBe(desktopToolsets);
  });

  it("builds palette models identical to the manifest's", () => {
    const today = new ToolsetRegistry(desktopToolsets);
    const registry = createDesktopToolsetRegistry();
    expect(registry.listToolsets().map(toolset => toolset.id)).toEqual(desktopToolsets.map(toolset => toolset.id));
    for (const toolset of desktopToolsets) {
      expect(getToolsetPaletteGroups(toolset.id, registry)).toEqual(getToolsetPaletteGroups(toolset.id, today));
    }
    expect(createDefaultVisibleToolsetIds(registry)).toEqual(createDefaultVisibleToolsetIds(today));
    expect(mainItemIds(registry)).toEqual(mainItemIds(today));
    expect(mainItemIds(registry)).toContain("tool.text");
    expect(mainItemIds(registry)).not.toContain("tool.chain");
  });
});

describe("molecule-drawing toolbar profile", () => {
  // The game build: the app modules evaluated with CHEMDRAFT_TOOLBAR_PROFILE set, as vite.config.ts defines it.
  let game: typeof import("../toolsets");
  let gameCommands: typeof import("../commands");
  let gameShell: typeof import("../shellCommandIds");
  let gameLayout: typeof import("./toolbarLayoutState");
  let gameDrawingTools: typeof import("../drawingTools");
  let gameShortcuts: typeof import("../keyboardShortcuts");
  beforeAll(async () => {
    vi.stubEnv("CHEMDRAFT_TOOLBAR_PROFILE", "molecule-drawing");
    Object.assign(import.meta.env, { CHEMDRAFT_TOOLBAR_PROFILE: "molecule-drawing" });
    vi.resetModules();
    game = await import("../toolsets");
    gameCommands = await import("../commands");
    gameShell = await import("../shellCommandIds");
    gameLayout = await import("./toolbarLayoutState");
    gameDrawingTools = await import("../drawingTools");
    gameShortcuts = await import("../keyboardShortcuts");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    Reflect.deleteProperty(import.meta.env, "CHEMDRAFT_TOOLBAR_PROFILE");
    vi.resetModules();
  });
  // As toolbarCatalog.ts builds the live registry: the production shell command ids, so a saved layout
  // naming a shell command is pruned (or kept) exactly as the app does.
  const gameRegistry = (layoutState?: unknown, plugins: readonly DesktopToolsetDefinition[] = []) =>
    game.createDesktopToolsetRegistry(layoutState, gameShell.SHELL_COMMAND_IDS, plugins, () => undefined);
  const gameMainItemIds = (registry: ReturnType<typeof gameRegistry>) => mainItemIds(registry, game.getToolsetPaletteGroups);

  it("is read from the build-time variable and applied to the default toolsets", () => {
    expect(game.desktopToolbarProfile).toBe("molecule-drawing");
    expect(game.defaultDesktopToolsets).toEqual(applyToolbarProfile(desktopToolsets, "molecule-drawing"));
    expect(gameMainItemIds(game.desktopToolsetRegistry)).toEqual([...MOLECULE_DRAWING_MAIN_ITEM_IDS]);
    expect(game.defaultVisibleToolsetIds).toEqual(new Set(["core.main"]));
  });

  it("keeps exactly the drawing tools on Main, in order", () => {
    expect(gameMainItemIds(gameRegistry())).toEqual([...MOLECULE_DRAWING_MAIN_ITEM_IDS]);
  });

  it("lays Main out with no empty grid cell: four cells under the zoom widget, then full columns", () => {
    const main = game.desktopToolsetRegistry.require("core.main");
    const rows = main.gridLayout?.rows ?? 2;
    expect(main.gridLayout?.orientation).toBe("horizontal");
    expect(rows).toBe(2);
    const items = game.getToolsetPaletteGroups("core.main", gameRegistry(), new Map(), false).flatMap(group => group.items);
    // Main is one group, so one grid; placed as the browser places it (column flow over two rows).
    expect(game.getToolsetPaletteGroups("core.main", gameRegistry(), new Map(), false)).toHaveLength(1);
    const placements = placePaletteGridItems("column", rows, items);
    const at = (id: string) => placements[items.findIndex(item => item.id === id)];

    // RC6's four-cell zoom widget on the first row, and the four cells under it all taken.
    expect(at("widget.core.documentZoom")).toEqual({ column: 0, row: 0, colSpan: 4, rowSpan: 1 });
    expect(["tool.select", "tool.lasso", "tool.eraser", "tool.charge"].map(id => at(id))).toEqual(
      [0, 1, 2, 3].map(column => ({ column, row: 1, colSpan: 1, rowSpan: 1 }))
    );
    // Then the divider, the full height of the toolbar, right after the zoom group.
    expect(at("core.main.divider.1")).toMatchObject({ column: 4, row: 0, rowSpan: 2 });

    // No empty cell anywhere before the last column.
    const columns = Math.max(...placements.map(placement => placement.column + placement.colSpan));
    const occupied = new Set<string>();
    for (const placement of placements) {
      for (let column = placement.column; column < placement.column + placement.colSpan; column += 1) {
        for (let row = placement.row; row < placement.row + placement.rowSpan; row += 1) {
          const cell = `${column},${row}`;
          expect(occupied.has(cell)).toBe(false);
          occupied.add(cell);
        }
      }
    }
    const empty: string[] = [];
    for (let column = 0; column < columns - 1; column += 1) {
      for (let row = 0; row < rows; row += 1) if (!occupied.has(`${column},${row}`)) empty.push(`${column},${row}`);
    }
    expect(empty).toEqual([]);
    expect(columns).toBe(10);
  });

  it("keeps the flyouts of Bond, Double Bond, Chain, Rings and Charge", () => {
    const items = game.getToolsetPaletteGroups("core.main", gameRegistry(), new Map(), false).flatMap(group => group.items);
    const submenu = (id: string) => items.find(item => item.id === id)?.submenu?.items.map(command => command.id) ?? [];
    expect(submenu("tool.bond")).toContain("tool.wavyBond");
    expect(submenu("tool.doubleBond")).toEqual(expect.arrayContaining(["tool.doubleBond", "tool.tripleBond"]));
    expect(submenu("tool.chain").length).toBeGreaterThan(1);
    expect(submenu("tool.chain")).toContain("tool.chain");
    expect(submenu("tool.benzene")).toContain("tool.cyclohexane");
    expect(submenu("tool.charge")).toEqual(expect.arrayContaining(["tool.plus", "tool.minus"]));
    // Chain is a profile default, not a user's toolbar addition.
    expect(items.find(item => item.id === "tool.chain")?.customAddition).toBeUndefined();
    // Toolbar contract: nothing on the profile's Main is permanently disabled.
    for (const item of items) {
      if (item.primary.type === "command") expect(item.primary.command.enabled ?? true).toBe(true);
    }
  });

  it("starts every other core toolset hidden and leaves plugin toolsets alone", () => {
    const registry = gameRegistry(undefined, [pluginToolset]);
    expect(game.createDefaultVisibleToolsetIds(registry)).toEqual(new Set(["core.main", pluginToolset.id]));
    const ids = registry.listToolsets().map(toolset => toolset.id);
    for (const id of OTHER_CORE_TOOLSETS) expect(ids).toContain(id);
    // Hidden toolsets keep their tools, so the View menu can still open them.
    expect(game.getToolsetPaletteGroups("core.structure", registry).flatMap(group => group.items).length).toBeGreaterThan(0);
  });

  it("applies a user's saved customisation on top of the profile", () => {
    const text = desktopToolsets.find(toolset => toolset.id === "core.main")!.groups[0].items
      .find(item => item.commandId === "tool.text")!;
    const userLayout: ToolsetLayoutState = {
      version: 1,
      mainToolbarDefaultsRevision: MAIN_TOOLBAR_DEFAULTS_REVISION,
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          hiddenCommandIds: ["tool.lasso"],
          itemAdditions: [{ groupId: "core.main.items", index: 0, item: text }]
        },
        { toolsetId: "core.structure", visible: true }
      ],
      userToolsets: []
    };
    const registry = gameRegistry(userLayout);
    const ids = gameMainItemIds(registry);
    expect(ids).not.toContain("tool.lasso");
    expect(ids[0]).toBe("tool.text");
    expect(ids.slice(1)).toEqual(MOLECULE_DRAWING_MAIN_ITEM_IDS.filter(id => id !== "tool.lasso"));
    expect(game.createDefaultVisibleToolsetIds(registry)).toEqual(new Set(["core.main", "core.structure"]));
    // The re-added Text tool is the user's own addition.
    const textItem = game.getToolsetPaletteGroups("core.main", registry, new Map(), false)[0].items[0];
    expect(textItem.customAddition).toBe(true);
  });

  it("keeps every shipped command available to menus and the Customize gallery", () => {
    const commandIds = new Set(game.getToolsetCommandSpecs().map(command => command.id));
    const paletteIds = new Set(gameCommands.allPaletteCommands().map(command => command.id));
    for (const id of ["tool.text", "tool.art.reactionArrow", "layout.alignLeft", "structure.spin3d"]) {
      expect(commandIds).toContain(id);
      expect(paletteIds).toContain(id);
    }
  });

  it("keeps the shortcut of an item the profile hides, through the path MainWindow binds keys with", () => {
    // MainWindow: toolCommandSpecs from the LIVE registry -> createMainWindowShortcutCommands ->
    // createDesktopShortcutRegistry, whose resolve() handles every key press.
    const liveShortcuts = (registry: ReturnType<typeof gameRegistry> | ReturnType<typeof createDesktopToolsetRegistry>) => {
      const toolCommandSpecs = gameDrawingTools.withStandaloneDrawingToolCommands(game.getToolsetCommandSpecs(registry));
      const commands = gameShortcuts.createMainWindowShortcutCommands(
        { quickActions: [], layerActions: [], toolCommandSpecs }, undefined, "macos"
      );
      return gameShortcuts.createDesktopShortcutRegistry(commands, { platform: "macos" });
    };
    const registry = gameRegistry();
    expect(gameMainItemIds(registry)).not.toContain("tool.text");
    const shortcuts = liveShortcuts(registry);
    expect(shortcuts.resolve({ key: "t" })).toBe("tool.text");
    // Every key the standard toolbars bind is still bound with the profile.
    const standard = liveShortcuts(createDesktopToolsetRegistry(undefined, gameShell.SHELL_COMMAND_IDS, [], () => undefined, desktopToolsets));
    const bound = (list: ReturnType<typeof liveShortcuts>) => new Set(list.list().map(shortcut => shortcut.commandId));
    expect([...bound(standard)].filter(id => !bound(shortcuts).has(id))).toEqual([]);
  });

  describe("saved layout", () => {
    const allIds = (registry: ReturnType<typeof gameRegistry>) => registry.listToolsets().map(toolset => toolset.id);
    // What MainWindow's visibility effect writes (`mergeVisibilityIntoLayoutState` with the build's profile).
    const save = (existing: ToolsetLayoutState | undefined, registry: ReturnType<typeof gameRegistry>, visible: ReadonlySet<string>) =>
      gameLayout.mergeVisibilityIntoLayoutState(existing, allIds(registry), visible, game.desktopToolbarProfileVisibility);

    it("never records the profile's defaults", () => {
      expect(game.desktopToolbarProfileVisibility).toEqual(new Map(OTHER_CORE_TOOLSETS.map(id => [id, false])));
      const registry = gameRegistry();
      const saved = save(undefined, registry, game.createDefaultVisibleToolsetIds(registry));
      // Nothing about the toolsets the profile hides, and no Main customization (that lives in the profile).
      expect(saved.toolsetOverrides).toEqual([{ toolsetId: "core.main", visible: true }]);
      // A later build without the profile, on the same saved layout, gets the standard toolbars.
      const standard = createDesktopToolsetRegistry(saved, gameShell.SHELL_COMMAND_IDS, [], () => undefined, desktopToolsets);
      expect(createDefaultVisibleToolsetIds(standard)).toEqual(createDefaultVisibleToolsetIds(new ToolsetRegistry(desktopToolsets)));
      expect(mainItemIds(standard)).toContain("tool.text");
    });

    it("records only the toolbar the user shows, and re-applies the profile underneath on load", () => {
      const registry = gameRegistry();
      const first = save(undefined, registry, game.createDefaultVisibleToolsetIds(registry));
      const shown = save(first, registry, new Set([...game.createDefaultVisibleToolsetIds(registry), "core.structure"]));
      expect(shown.toolsetOverrides).toEqual([
        { toolsetId: "core.main", visible: true },
        { toolsetId: "core.structure", visible: true }
      ]);
      const reloaded = gameRegistry(shown);
      expect(game.createDefaultVisibleToolsetIds(reloaded)).toEqual(new Set(["core.main", "core.structure"]));
      expect(gameMainItemIds(reloaded)).toEqual([...MOLECULE_DRAWING_MAIN_ITEM_IDS]);
      // Hiding it again is the user's own choice too, so it stays recorded.
      const hidden = save(shown, reloaded, new Set(["core.main"]));
      expect(hidden.toolsetOverrides).toContainEqual({ toolsetId: "core.structure", visible: false });
    });

    it("keeps the user's other customization of a toolset the profile hides", () => {
      const registry = gameRegistry();
      const existing: ToolsetLayoutState = {
        version: 1,
        toolsetOverrides: [{ toolsetId: "core.art", title: "My Art" }],
        userToolsets: []
      };
      const saved = save(existing, registry, game.createDefaultVisibleToolsetIds(registry));
      expect(saved.toolsetOverrides).toContainEqual({ toolsetId: "core.art", title: "My Art" });
      expect(saved.toolsetOverrides.filter(override => override.toolsetId !== "core.main" && override.visible !== undefined)).toEqual([]);
    });
  });
});
