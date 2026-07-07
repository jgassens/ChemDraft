import { describe, expect, it } from "vitest";
import {
  ToolsetDefinitionSchema,
  ToolsetItemSchema,
  ToolsetLayoutStateSchema,
  ToolsetRegistry,
  applyToolsetLayoutState,
  createToolbarsMenuModel,
  createToolsetToggleCommandDefinitions,
  createToolsetToggleCommandId,
  normalizeToolsetItem,
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

  it("enumerates command ids from legacy fields, primary actions, and submenu items", () => {
    const registry = new ToolsetRegistry([
      {
        ...fixtureToolset,
        groups: [
          {
            id: "fixture.tools",
            items: [
              {
                commandId: "tool.bond",
                primary: { type: "command", commandId: "tool.bond" },
                submenu: {
                  type: "command-grid",
                  items: [
                    { commandId: "tool.bond", label: "Single Bond" },
                    { commandId: "tool.wedgeBond", label: "Wedge" }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]);

    expect(registry.listCommandIds()).toEqual(["tool.bond", "tool.wedgeBond"]);
  });

  it("parses manifest-style toolset contributions", () => {
    const toolsets = parseToolsetManifest({ toolsets: [fixtureToolset] });

    expect(toolsets).toHaveLength(1);
    expect(toolsets[0].groups[0].items[0].commandId).toBe("tool.select");
  });

  it("normalizes legacy command items to the explicit toolbar item contract", () => {
    const normalized = normalizeToolsetItem({
      commandId: "tool.bond",
      title: "Single Bond",
      shortcutDisplay: "M",
      placement: { row: 0, column: 1, order: 2 }
    });

    expect(normalized).toMatchObject({
      id: "tool.bond",
      kind: "button",
      label: "Single Bond",
      primary: { type: "command", commandId: "tool.bond" },
      submenu: null,
      tooltip: { title: "Single Bond", description: null, shortcut: "M" },
      layout: { row: 0, column: 1, order: 2, colSpan: 1, rowSpan: 1 }
    });
  });

  it("normalizes explicit schema-backed command items without dropping submenu or layout fields", () => {
    const normalized = normalizeToolsetItem({
      commandId: "tool.bond",
      id: "bond-main",
      kind: "toggle",
      label: "Bond",
      title: "Single Bond",
      icon: "bond",
      assetName: "Custom_Bond",
      primary: { type: "command", commandId: "tool.bond" },
      submenu: {
        type: "command-grid",
        id: "bond-tools",
        title: "Bond tools",
        columns: 3,
        items: [
          {
            commandId: "tool.bond",
            label: "Single Bond",
            icon: "bond",
            tooltip: { title: "Single Bond", description: "Draw a bond.", shortcut: "M" }
          },
          { commandId: "tool.wedgeBond", title: "Solid Wedge Bond", assetName: "Custom_Bond_Wedge" }
        ]
      },
      tooltip: { title: "Bond", description: "Long-press for variants.", shortcut: "M" },
      layout: { colSpan: 2, rowSpan: 1 },
      placement: { groupId: "structure", row: 1, column: 0, order: 4 },
      category: "structure"
    });

    expect(normalized).toMatchObject({
      id: "bond-main",
      kind: "toggle",
      label: "Bond",
      icon: "bond",
      assetName: "Custom_Bond",
      primary: { type: "command", commandId: "tool.bond" },
      submenu: {
        type: "command-grid",
        id: "bond-tools",
        title: "Bond tools",
        columns: 3,
        items: [
          {
            commandId: "tool.bond",
            label: "Single Bond",
            icon: "bond",
            tooltip: { title: "Single Bond", description: "Draw a bond.", shortcut: "M" }
          },
          { commandId: "tool.wedgeBond", label: "Solid Wedge Bond", assetName: "Custom_Bond_Wedge" }
        ]
      },
      tooltip: { title: "Bond", description: "Long-press for variants.", shortcut: "M" },
      layout: { groupId: "structure", row: 1, column: 0, order: 4, colSpan: 2, rowSpan: 1 }
    });
  });

  it("normalizes control and separator items without requiring fake command ids", () => {
    const control = normalizeToolsetItem({
      id: "style.color.control",
      kind: "control",
      label: "Color",
      primary: { type: "control", controlId: "style.color" },
      layout: { colSpan: 2 }
    });
    const separator = normalizeToolsetItem(
      { kind: "separator" },
      { toolsetId: "core.fixture", groupId: "fixture.tools", itemIndex: 1 }
    );

    expect(control).toMatchObject({
      id: "style.color.control",
      kind: "control",
      label: "Color",
      primary: { type: "control", controlId: "style.color" },
      commandId: undefined,
      layout: { colSpan: 2, rowSpan: 1 }
    });
    expect(separator).toMatchObject({
      id: "core.fixture.fixture.tools.separator.1",
      kind: "separator",
      primary: { type: "none" },
      commandId: undefined
    });
    expect(ToolsetItemSchema.parse({
      primary: { type: "control", controlId: "style.color" },
      label: "Color"
    }).commandId).toBeUndefined();
    expect(ToolsetItemSchema.parse({ kind: "separator" }).commandId).toBeUndefined();
    expect(() => ToolsetItemSchema.parse({ label: "No action" })).toThrow(/commandId, primary, or separator/);
  });

  it("rejects empty submenu objects but accepts null or missing submenus", () => {
    expect(() => ToolsetItemSchema.parse({ commandId: "tool.bond", submenu: { type: "command-grid", items: [] } })).toThrow();
    expect(ToolsetItemSchema.parse({ commandId: "tool.bond", submenu: null }).submenu).toBeNull();
    expect(normalizeToolsetItem(ToolsetItemSchema.parse({ commandId: "tool.bond" })).submenu).toBeNull();
  });

  it("rejects conflicting legacy and primary command ids during normalization", () => {
    expect(() =>
      normalizeToolsetItem({
        commandId: "tool.bond",
        primary: { type: "command", commandId: "tool.wedgeBond" }
      })
    ).toThrow(/primary command/);
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

  it("preserves schema-backed item fields when applying layout state", () => {
    const schemaToolset: ToolsetDefinition = {
      ...fixtureToolset,
      groups: [
        {
          id: "fixture.tools",
          items: [
            {
              commandId: "tool.bond",
              id: "tool.bond",
              kind: "button",
              label: "Single Bond",
              title: "Single Bond",
              primary: { type: "command", commandId: "tool.bond" },
              submenu: {
                type: "command-grid",
                items: [{ commandId: "tool.wedgeBond", label: "Wedge Bond" }]
              },
              tooltip: { title: "Single Bond", shortcut: "M" },
              layout: { colSpan: 2, rowSpan: 1 }
            }
          ]
        }
      ]
    };
    const customized = applyToolsetLayoutState([schemaToolset], {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.fixture",
          itemOverrides: [
            {
              commandId: "tool.bond",
              placement: { row: 1, column: 2 },
              layout: { rowSpan: 2 }
            }
          ]
        }
      ]
    }, { registeredCommandIds: ["tool.bond", "tool.wedgeBond"] });
    const item = customized[0].groups[0].items[0];

    expect(item.primary).toEqual({ type: "command", commandId: "tool.bond" });
    expect(item.submenu).toEqual({ type: "command-grid", items: [{ commandId: "tool.wedgeBond", label: "Wedge Bond" }] });
    expect(item.tooltip).toEqual({ title: "Single Bond", shortcut: "M" });
    expect(item.layout).toEqual({ colSpan: 2, rowSpan: 2 });
    expect(item.placement).toEqual({ row: 1, column: 2 });
    expect(schemaToolset.groups[0].items[0].layout).toEqual({ colSpan: 2, rowSpan: 1 });
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

  it("keeps non-command user toolset items while validating real command ids", () => {
    const customized = applyToolsetLayoutState(
      [],
      {
        version: 1,
        userToolsets: [
          {
            id: "user.controls",
            title: "Controls",
            source: "user",
            defaultVisible: true,
            defaultMode: "floating",
            groups: [
              {
                id: "user.controls.tools",
                items: [
                  { commandId: "tool.select", title: "Selection Tool" },
                  { id: "style.color.control", label: "Color", primary: { type: "control", controlId: "style.color" } },
                  { id: "divider", kind: "separator", primary: { type: "none" } }
                ]
              }
            ]
          }
        ]
      },
      { registeredCommandIds: ["tool.select"] }
    );

    expect(customized[0].groups[0].items.map((item) => item.id ?? item.commandId)).toEqual([
      "tool.select",
      "style.color.control",
      "divider"
    ]);
    expect(new ToolsetRegistry(customized).listCommandIds()).toEqual(["tool.select"]);
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

  it("rejects submenu commands that are not registered", () => {
    expect(() =>
      applyToolsetLayoutState(
        [fixtureToolset],
        {
          version: 1,
          userToolsets: [
            {
              id: "user.submenu",
              title: "Submenu",
              source: "user",
              defaultVisible: false,
              defaultMode: "floating",
              groups: [
                {
                  id: "user.submenu.tools",
                  items: [
                    {
                      commandId: "tool.bond",
                      submenu: { type: "command-grid", items: [{ commandId: "tool.unknown" }] }
                    }
                  ]
                }
              ]
            }
          ]
        },
        { registeredCommandIds: ["tool.bond"] }
      )
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
