import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolsetRegistry, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import {
  createDefaultVisibleToolsetIds,
  createDesktopToolsetRegistry,
  defaultDesktopToolsets,
  desktopToolbarProfile,
  desktopToolsets,
  getToolsetPaletteGroups,
  type DesktopToolsetDefinition
} from "../toolsets";
import { MAIN_TOOLBAR_DEFAULTS_REVISION } from "./toolbarLayoutState";
import { applyToolbarProfile, MOLECULE_DRAWING_MAIN_ITEM_IDS } from "./toolbarProfile";
import { parseToolbarProfileName, TOOLBAR_PROFILE_NAMES } from "./toolbarProfileName";

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
  beforeAll(async () => {
    vi.stubEnv("CHEMDRAFT_TOOLBAR_PROFILE", "molecule-drawing");
    Object.assign(import.meta.env, { CHEMDRAFT_TOOLBAR_PROFILE: "molecule-drawing" });
    vi.resetModules();
    game = await import("../toolsets");
    gameCommands = await import("../commands");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    Reflect.deleteProperty(import.meta.env, "CHEMDRAFT_TOOLBAR_PROFILE");
    vi.resetModules();
  });
  const gameRegistry = (layoutState?: unknown, plugins: readonly DesktopToolsetDefinition[] = []) =>
    game.createDesktopToolsetRegistry(layoutState, undefined, plugins, () => undefined);
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

  it("keeps every shipped command available to menus, shortcuts and the Customize gallery", () => {
    const commandIds = new Set(game.getToolsetCommandSpecs().map(command => command.id));
    const paletteIds = new Set(gameCommands.allPaletteCommands().map(command => command.id));
    for (const id of ["tool.text", "tool.art.reactionArrow", "layout.alignLeft", "structure.spin3d"]) {
      expect(commandIds).toContain(id);
      expect(paletteIds).toContain(id);
    }
  });
});
