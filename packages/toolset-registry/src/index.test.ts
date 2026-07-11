import { describe, expect, it } from "vitest";
import {
  ToolsetDefinitionSchema,
  ToolsetItemAdditionSchema,
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

  it("prunes only the unknown submenu command and keeps the parent button", () => {
    const warnings: string[] = [];
    const result = applyToolsetLayoutState(
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
                    submenu: {
                      type: "command-grid",
                      items: [{ commandId: "tool.bond" }, { commandId: "tool.stale" }]
                    }
                  }
                ]
              }
            ]
          }
        ]
      },
      { registeredCommandIds: ["tool.bond"], onUnknownCommand: "prune", onWarning: (message) => warnings.push(message) }
    );

    const item = result.find((toolset) => toolset.id === "user.submenu")?.groups[0]?.items[0];
    // The button survives because its own command is registered…
    expect(item?.commandId).toBe("tool.bond");
    // …with only the unknown submenu entry pruned, not the whole button.
    expect(item?.submenu?.items.map((sub) => sub.commandId)).toEqual(["tool.bond"]);
    expect(warnings.join("\n")).toMatch(/tool\.stale/);
  });

  it("normalizes a separator with no group id instead of throwing", () => {
    const separator = normalizeToolsetItem({ kind: "separator" }, { toolsetId: "core.sep", itemIndex: 2 });
    expect(separator).toMatchObject({ kind: "separator", primary: { type: "none" } });
    expect(separator.id).toBe("core.sep.group.separator.2");
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

describe("core toolset item additions (spacers + gallery adds)", () => {
  const spacerItem = (id: string) => ({
    id,
    kind: "spacer" as const,
    label: "Spacer",
    primary: { type: "none" as const }
  });
  const commandItem = (commandId: string, label = commandId) => ({
    id: commandId,
    kind: "button" as const,
    label,
    primary: { type: "command" as const, commandId },
    submenu: null
  });
  const itemIds = (toolset: ToolsetDefinition, groupId: string): (string | undefined)[] =>
    toolset.groups.find((group) => group.id === groupId)?.items.map((item) => item.commandId ?? item.id) ?? [];

  const twoGroupToolset: ToolsetDefinition = {
    id: "core.two",
    title: "Two Groups",
    source: "core",
    defaultVisible: true,
    defaultMode: "floating",
    groups: [
      { id: "g1", items: [{ commandId: "tool.select", title: "Sel" }] },
      { id: "g2", items: [{ commandId: "tool.bond", title: "Bond" }] }
    ]
  };

  it("inserts a spacer addition at its index", () => {
    const customized = applyToolsetLayoutState([fixtureToolset], {
      version: 1,
      toolsetOverrides: [
        { toolsetId: "core.fixture", itemAdditions: [{ groupId: "fixture.tools", index: 1, item: spacerItem("user.spacer.1") }] }
      ]
    });
    expect(itemIds(customized[0], "fixture.tools")).toEqual(["tool.select", "user.spacer.1", "tool.bond", "tool.text"]);
  });

  it("applies additions before itemOrder, so itemOrder can address an added command", () => {
    const customized = applyToolsetLayoutState(
      [fixtureToolset],
      {
        version: 1,
        toolsetOverrides: [
          {
            toolsetId: "core.fixture",
            itemAdditions: [{ groupId: "fixture.tools", item: commandItem("tool.extra", "Extra") }],
            itemOrder: { "fixture.tools": ["tool.extra", "tool.select"] }
          }
        ]
      },
      { registeredCommandIds: ["tool.select", "tool.bond", "tool.text", "tool.extra"] }
    );
    expect(itemIds(customized[0], "fixture.tools")).toEqual(["tool.extra", "tool.select", "tool.bond", "tool.text"]);
  });

  it("prunes an addition whose command is unknown, and scrubs its itemOrder reference", () => {
    const warnings: string[] = [];
    const customized = applyToolsetLayoutState(
      [fixtureToolset],
      {
        version: 1,
        toolsetOverrides: [
          {
            toolsetId: "core.fixture",
            itemAdditions: [{ groupId: "fixture.tools", item: commandItem("plugin.gone", "Gone") }],
            itemOrder: { "fixture.tools": ["plugin.gone", "tool.select"] }
          }
        ]
      },
      { onUnknownCommand: "prune", onWarning: (warning) => warnings.push(warning) }
    );
    expect(itemIds(customized[0], "fixture.tools")).toEqual(["tool.select", "tool.bond", "tool.text"]);
    expect(warnings.some((warning) => warning.includes("plugin.gone"))).toBe(true);
  });

  it("keeps an addition whose command is a registered additional command (the shell catalog)", () => {
    const warnings: string[] = [];
    const customized = applyToolsetLayoutState(
      [fixtureToolset],
      {
        version: 1,
        toolsetOverrides: [
          {
            toolsetId: "core.fixture",
            // edit.undo is a real shell command but NOT in any toolset manifest — the in-place gallery
            // can still add it, so it must survive pruning when passed via additionalCommandIds.
            itemAdditions: [{ groupId: "fixture.tools", index: 1, item: commandItem("edit.undo", "Undo") }],
            itemOrder: { "fixture.tools": ["tool.select", "edit.undo"] }
          }
        ]
      },
      { onUnknownCommand: "prune", additionalCommandIds: ["edit.undo"], onWarning: (warning) => warnings.push(warning) }
    );
    expect(itemIds(customized[0], "fixture.tools")).toContain("edit.undo");
    expect(warnings.some((warning) => warning.includes("edit.undo"))).toBe(false);
  });

  it("keeps a spacer addition through pruning (it references no command)", () => {
    const customized = applyToolsetLayoutState(
      [fixtureToolset],
      {
        version: 1,
        toolsetOverrides: [{ toolsetId: "core.fixture", itemAdditions: [{ groupId: "fixture.tools", index: 0, item: spacerItem("user.spacer.1") }] }]
      },
      { onUnknownCommand: "prune" }
    );
    expect(itemIds(customized[0], "fixture.tools")).toEqual(["user.spacer.1", "tool.select", "tool.bond", "tool.text"]);
  });

  it("skips duplicate additions (against base items and earlier additions across groups)", () => {
    const customized = applyToolsetLayoutState([twoGroupToolset], {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.two",
          itemAdditions: [
            { groupId: "g2", item: commandItem("tool.select", "Dup") },
            { groupId: "g1", item: spacerItem("user.spacer.1") },
            { groupId: "g2", item: spacerItem("user.spacer.1") }
          ]
        }
      ]
    });
    expect(itemIds(customized[0], "g1")).toEqual(["tool.select", "user.spacer.1"]);
    expect(itemIds(customized[0], "g2")).toEqual(["tool.bond"]);
  });

  it("keeps a group alive when all its base items are hidden but it holds an addition", () => {
    const customized = applyToolsetLayoutState([twoGroupToolset], {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.two",
          hiddenCommandIds: ["tool.bond"],
          itemAdditions: [{ groupId: "g2", item: spacerItem("user.spacer.9") }]
        }
      ]
    });
    expect(itemIds(customized[0], "g2")).toEqual(["user.spacer.9"]);
  });

  it("reorders and hides a spacer addition by its explicit id", () => {
    const reordered = applyToolsetLayoutState([fixtureToolset], {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.fixture",
          itemAdditions: [{ groupId: "fixture.tools", item: spacerItem("user.spacer.1") }],
          itemOrder: { "fixture.tools": ["user.spacer.1", "tool.select", "tool.bond", "tool.text"] }
        }
      ]
    });
    expect(itemIds(reordered[0], "fixture.tools")).toEqual(["user.spacer.1", "tool.select", "tool.bond", "tool.text"]);

    const hidden = applyToolsetLayoutState([fixtureToolset], {
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.fixture",
          itemAdditions: [{ groupId: "fixture.tools", item: spacerItem("user.spacer.1") }],
          hiddenCommandIds: ["user.spacer.1"]
        }
      ]
    });
    expect(itemIds(hidden[0], "fixture.tools")).toEqual(["tool.select", "tool.bond", "tool.text"]);
  });

  it("rejects an item addition whose item has no customization id", () => {
    expect(() => ToolsetItemAdditionSchema.parse({ groupId: "g", item: { kind: "spacer", primary: { type: "none" } } })).toThrow();
    // With an explicit id it validates.
    expect(() => ToolsetItemAdditionSchema.parse({ groupId: "g", item: spacerItem("user.spacer.1") })).not.toThrow();
  });

  it("drops an addition that targets a nonexistent group", () => {
    const customized = applyToolsetLayoutState([fixtureToolset], {
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.fixture", itemAdditions: [{ groupId: "no.such.group", item: spacerItem("user.spacer.1") }] }]
    });
    expect(customized[0].groups.flatMap((group) => group.items.map((item) => item.commandId ?? item.id))).toEqual([
      "tool.select",
      "tool.bond",
      "tool.text"
    ]);
  });

  const dividerToolset: ToolsetDefinition = {
    ...fixtureToolset,
    groups: [
      {
        id: "fixture.tools",
        items: [
          { commandId: "tool.select", title: "Selection Tool", icon: "select" },
          { id: "fixture.divider.1", kind: "separator", primary: { type: "none" } },
          { commandId: "tool.bond", title: "Single Bond", icon: "bond" }
        ]
      }
    ]
  };

  it("lets an override hide a manifest separator by its explicit id (not pruned as unknown)", () => {
    const hidden = applyToolsetLayoutState(
      [dividerToolset],
      {
        version: 1,
        toolsetOverrides: [{ toolsetId: "core.fixture", hiddenCommandIds: ["fixture.divider.1"] }]
      },
      { onUnknownCommand: "prune" }
    );
    expect(itemIds(hidden[0], "fixture.tools")).toEqual(["tool.select", "tool.bond"]);
  });

  it("lets an override reorder a manifest separator by its explicit id (assert mode accepts it)", () => {
    const reordered = applyToolsetLayoutState([dividerToolset], {
      version: 1,
      toolsetOverrides: [
        { toolsetId: "core.fixture", itemOrder: { "fixture.tools": ["fixture.divider.1", "tool.bond", "tool.select"] } }
      ]
    });
    expect(itemIds(reordered[0], "fixture.tools")).toEqual(["fixture.divider.1", "tool.bond", "tool.select"]);
  });

  it("still prunes a genuinely unknown id from hiddenCommandIds", () => {
    const warnings: string[] = [];
    const pruned = applyToolsetLayoutState(
      [fixtureToolset],
      {
        version: 1,
        toolsetOverrides: [{ toolsetId: "core.fixture", hiddenCommandIds: ["no.such.id", "tool.bond"] }]
      },
      { onUnknownCommand: "prune", onWarning: (warning) => warnings.push(warning) }
    );
    expect(itemIds(pruned[0], "fixture.tools")).toEqual(["tool.select", "tool.text"]);
    expect(warnings.some((warning) => warning.includes("no.such.id"))).toBe(true);
  });
});
