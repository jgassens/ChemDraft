import { describe, expect, it } from "vitest";
import {
  ToolsetDefinitionSchema,
  ToolsetLayoutStateSchema,
  ToolsetRegistry,
  applyToolsetLayoutState,
  createToolbarsMenuModel,
  createToolsetToggleCommandDefinitions,
  createToolsetToggleCommandId,
  parseToolsetLayoutState,
  parseToolsetManifest,
  type ToolsetDefinition,
  parseToolsetToggleCommandId
} from "./index";

const fixtureToolset: ToolsetDefinition = {
  id: "core.fixture",
  title: "Fixture Toolbar",
  source: "core",
  defaultVisible: true,
  defaultMode: "floating",
  preferredWindowSize: { width: 96, height: 320 },
  groups: [
    {
      id: "fixture.tools",
      items: [
        { commandId: "tool.select", title: "Selection Tool", icon: "select", shortcutDisplay: "V" },
        { commandId: "tool.bond", title: "Single Bond", icon: "bond" },
        { commandId: "tool.text", title: "Text Tool", icon: "text" }
      ]
    }
  ]
};

const pluginToolset: ToolsetDefinition = {
  id: "plugin.fixture",
  title: "Fixture Plugin Toolbar",
  source: "plugin",
  defaultVisible: false,
  defaultMode: "floating",
  groups: [
    {
      id: "plugin.fixture.tools",
      items: [{ commandId: "plugin.fixture.ping", title: "Plugin Ping", icon: "plugin" }]
    }
  ]
};

describe("toolset registry", () => {
  it("validates typed toolset definitions", () => {
    expect(ToolsetDefinitionSchema.parse(fixtureToolset).id).toBe("core.fixture");
  });

  it("registers toolsets and rejects duplicate ids", () => {
    const registry = new ToolsetRegistry([fixtureToolset]);

    expect(registry.require("core.fixture").title).toBe("Fixture Toolbar");
    expect(registry.listCommandIds()).toEqual(["tool.select", "tool.bond", "tool.text"]);
    expect(() => registry.register(fixtureToolset)).toThrow(/already registered/);
  });

  it("parses manifest-style toolset contributions", () => {
    const toolsets = parseToolsetManifest({ toolsets: [fixtureToolset] });

    expect(toolsets).toHaveLength(1);
    expect(toolsets[0].groups[0].items[0].commandId).toBe("tool.select");
  });

  it("creates menu and toggle command models from registered toolsets", () => {
    const menu = createToolbarsMenuModel([fixtureToolset], new Set());
    const toggles = createToolsetToggleCommandDefinitions([fixtureToolset]);

    expect(menu).toEqual([
      expect.objectContaining({
        title: "Fixture Toolbar",
        commandId: "view.toolset.toggle.core.fixture",
        checked: false
      })
    ]);
    expect(toggles).toEqual([
      expect.objectContaining({
        id: "view.toolset.toggle.core.fixture",
        toolsetId: "core.fixture",
        category: "view"
      })
    ]);
  });

  it("round-trips toolset toggle command ids", () => {
    expect(createToolsetToggleCommandId("plugin.fixture")).toBe("view.toolset.toggle.plugin.fixture");
    expect(parseToolsetToggleCommandId("view.toolset.toggle.plugin.fixture")).toBe("plugin.fixture");
    expect(parseToolsetToggleCommandId("view.toggleRulers")).toBeUndefined();
  });

  it("parses versioned toolbar customization state", () => {
    const state = parseToolsetLayoutState({
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.fixture",
          visible: false,
          mode: "hidden",
          gridLayout: { orientation: "vertical", columns: 2, cellWidth: 24, cellHeight: 24 }
        }
      ]
    });

    expect(ToolsetLayoutStateSchema.parse(state).version).toBe(1);
    expect(state.toolsetOverrides[0]).toMatchObject({
      toolsetId: "core.fixture",
      visible: false,
      mode: "hidden"
    });
  });

  it("applies visibility, mode, and item overrides without mutating source toolsets", () => {
    const before = JSON.stringify(fixtureToolset);
    const customized = applyToolsetLayoutState([fixtureToolset], {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.fixture",
          visible: false,
          mode: "docked",
          itemOverrides: [{ commandId: "tool.bond", placement: { row: 1, column: 0, order: 2 } }]
        }
      ]
    });

    expect(customized[0]).toMatchObject({ defaultVisible: false, defaultMode: "docked" });
    expect(customized[0].groups[0].items.find((item) => item.commandId === "tool.bond")?.placement).toEqual({
      row: 1,
      column: 0,
      order: 2
    });
    expect(JSON.stringify(fixtureToolset)).toBe(before);
    expect(customized[0].groups[0].items[1]).not.toBe(fixtureToolset.groups[0].items[1]);
  });

  it("hides and reorders command ids through user overrides", () => {
    const customized = applyToolsetLayoutState([fixtureToolset], {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.fixture",
          hiddenCommandIds: ["tool.text"],
          itemOrder: {
            "fixture.tools": ["tool.bond", "tool.select"]
          }
        }
      ]
    });

    expect(customized[0].groups[0].items.map((item) => item.commandId)).toEqual(["tool.bond", "tool.select"]);
  });

  it("creates user toolsets that reference existing command ids", () => {
    const customized = applyToolsetLayoutState(
      [fixtureToolset, pluginToolset],
      {
        version: 1,
        userToolsets: [
          {
            id: "user.quick",
            title: "My Quick Tools",
            source: "user",
            defaultVisible: true,
            defaultMode: "floating",
            clonedFromToolsetId: "core.fixture",
            groups: [
              {
                id: "user.quick.tools",
                items: [
                  { commandId: "tool.select", title: "Selection Tool" },
                  { commandId: "plugin.fixture.ping", title: "Plugin Ping" }
                ]
              }
            ]
          }
        ]
      }
    );

    expect(customized.find((toolset) => toolset.id === "user.quick")).toMatchObject({
      source: "user",
      clonedFromToolsetId: "core.fixture"
    });
  });

  it("rejects duplicate user toolset ids and invalid command ids", () => {
    expect(() =>
      applyToolsetLayoutState([fixtureToolset], {
        version: 1,
        userToolsets: [
          {
            id: "core.fixture",
            title: "Duplicate",
            source: "user",
            defaultVisible: false,
            defaultMode: "floating",
            groups: [{ id: "duplicate.tools", items: [{ commandId: "tool.select" }] }]
          }
        ]
      })
    ).toThrow(/duplicates/);

    expect(() =>
      parseToolsetLayoutState({
        version: 1,
        userToolsets: [
          {
            id: "user.invalid",
            title: "Invalid",
            source: "user",
            defaultVisible: false,
            defaultMode: "floating",
            groups: [{ id: "invalid.tools", items: [{ commandId: "tool select" }] }]
          }
        ]
      })
    ).toThrow();

    expect(() =>
      parseToolsetLayoutState({
        version: 1,
        toolsetOverrides: [{ toolsetId: "core.fixture", hiddenCommandIds: [""] }]
      })
    ).toThrow();
  });

  it("rejects user toolsets that reference unregistered commands", () => {
    expect(() =>
      applyToolsetLayoutState([fixtureToolset], {
        version: 1,
        userToolsets: [
          {
            id: "user.unknown",
            title: "Unknown",
            source: "user",
            defaultVisible: false,
            defaultMode: "floating",
            groups: [{ id: "unknown.tools", items: [{ commandId: "tool.unknown" }] }]
          }
        ]
      })
    ).toThrow(/unregistered command/);
  });

  it("generates toolbar menu models from built-in, plugin, and user toolsets", () => {
    const customized = applyToolsetLayoutState([fixtureToolset, pluginToolset], {
      version: 1,
      toolsetOrder: ["user.quick", "plugin.fixture", "core.fixture"],
      userToolsets: [
        {
          id: "user.quick",
          title: "My Quick Tools",
          source: "user",
          defaultVisible: true,
          defaultMode: "floating",
          groups: [{ id: "user.quick.tools", items: [{ commandId: "tool.select" }] }]
        }
      ]
    });
    const menu = createToolbarsMenuModel(customized);

    expect(menu.map((item) => item.toolsetId)).toEqual(["user.quick", "plugin.fixture", "core.fixture"]);
    expect(menu.find((item) => item.toolsetId === "user.quick")).toMatchObject({
      title: "My Quick Tools",
      checked: true,
      source: "user"
    });
    expect(menu.find((item) => item.toolsetId === "plugin.fixture")?.source).toBe("plugin");
  });
});
