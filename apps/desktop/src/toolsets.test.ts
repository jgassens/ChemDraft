import { describe, expect, it } from "vitest";
import { ToolsetRegistry, type ToolsetDefinition } from "@chemdraft/toolset-registry";
import type { CommandSpec } from "./commands";
import {
  computePaletteGridSize,
  createDesktopToolsetRegistry,
  desktopToolsets,
  getToolsetCommandGroups,
  getToolsetItemGroups,
  migrateLegacyMainToolbarLayoutState,
  type DesktopToolsetRegistry
} from "./toolsets";

const legacyToolset: ToolsetDefinition = {
  id: "core.legacy",
  title: "Legacy",
  source: "core",
  defaultVisible: true,
  defaultMode: "floating",
  groups: [
    {
      id: "legacy.tools",
      items: [{ commandId: "tool.bond", title: "Single Bond", icon: "bond", shortcutDisplay: "M" }]
    }
  ]
};

function registry(toolsets: ToolsetDefinition[]): DesktopToolsetRegistry {
  return new ToolsetRegistry(toolsets);
}

describe("desktop toolset mapping", () => {
  it("maps legacy command items to schema-backed palette items", () => {
    const item = getToolsetItemGroups("core.legacy", registry([legacyToolset]))[0][0];

    expect(item).toMatchObject({
      id: "tool.bond",
      kind: "button",
      label: "Single Bond",
      primary: { type: "command", command: { id: "tool.bond", title: "Single Bond" } },
      submenu: null,
      tooltip: { title: "Single Bond", shortcut: "M", shortcutLabel: "M" },
      layout: { colSpan: 1, rowSpan: 1 }
    });
    if (item.primary.type !== "command") {
      throw new Error("Expected legacy item to map to a command primary.");
    }
    expect(item.primary.command.description).toBeUndefined();
  });

  it("preserves explicit tooltip descriptions without inventing fallback descriptions", () => {
    const describedToolset: ToolsetDefinition = {
      id: "core.described",
      title: "Described",
      source: "core",
      defaultVisible: true,
      defaultMode: "floating",
      groups: [
        {
          id: "described.tools",
          items: [
            {
              commandId: "tool.bond",
              title: "Single Bond",
              icon: "bond",
              primary: { type: "command", commandId: "tool.bond" },
              tooltip: { title: "Single Bond", description: "Draw a single bond.", shortcut: "M" },
              submenu: {
                type: "command-grid",
                title: "Bond tools",
                items: [
                  {
                    commandId: "tool.wedgeBond",
                    label: "Solid Wedge Bond",
                    tooltip: { description: "Draw a wedge bond." }
                  },
                  { commandId: "tool.boldBond", label: "Bold Bond" }
                ]
              }
            }
          ]
        }
      ]
    };
    const item = getToolsetItemGroups("core.described", registry([describedToolset]))[0][0];
    if (item.primary.type !== "command") {
      throw new Error("Expected described item to map to a command primary.");
    }

    expect(item.primary.command.description).toBe("Draw a single bond.");
    expect(item.submenu?.items.find((command) => command.id === "tool.wedgeBond")?.description).toBe("Draw a wedge bond.");
    expect(item.submenu?.items.find((command) => command.id === "tool.boldBond")?.description).toBeUndefined();
    expect(getToolsetCommandGroups("core.legacy", registry([legacyToolset]))[0][0].description).toBeUndefined();
    expect(
      [item.primary.command, ...(item.submenu?.items ?? [])].some((command) =>
        command.description?.includes("toolset action")
      )
    ).toBe(false);
  });

  it("maps schema submenus to command specs while preserving command override state", () => {
    const overrides = new Map<string, CommandSpec>([
      [
        "tool.wedgeBond",
        {
          id: "tool.wedgeBond",
          title: "Live Wedge",
          icon: "bond",
          source: "core",
          enabled: false,
          disabledReason: "Selection cannot accept wedge bonds"
        }
      ]
    ]);
    const item = getToolsetItemGroups("core.main", undefined, overrides)
      .flat()
      .find((candidate) => candidate.id === "tool.bond");

    expect(item?.submenu?.items.map((command) => command.id)).toEqual([
      "tool.bond",
      "tool.wedgeBond",
      "tool.hashedBond",
      "tool.dashedBond",
      "tool.boldBond"
    ]);
    const wedge = item?.submenu?.items.find((command) => command.id === "tool.wedgeBond");
    expect(wedge).toMatchObject({
      title: "Solid Wedge Bond",
      assetName: "Custom_Bond_Wedge",
      enabled: false,
      disabledReason: "Selection cannot accept wedge bonds"
    });
  });

  it("keeps command-group callers compatible by exposing primary command specs", () => {
    expect(getToolsetCommandGroups("core.legacy", registry([legacyToolset]))).toEqual([
      [expect.objectContaining({ id: "tool.bond", title: "Single Bond" })]
    ]);
  });

  it("keeps every core desktop manifest item explicit about primary, submenu, tooltip, and layout", () => {
    for (const toolset of desktopToolsets) {
      for (const group of toolset.groups) {
        for (const item of group.items) {
          if (item.primary?.type === "control") {
            // Phase 5: section widgets (and any inline controls) declare a controlId instead of a command.
            expect(item.kind, `${toolset.id}/${group.id}/${item.id} kind`).toBe("control");
            expect(item.label, `${toolset.id}/${group.id}/${item.id} label`).toBeTruthy();
            expect(item.primary.controlId, `${toolset.id}/${group.id}/${item.id} controlId`).toBeTruthy();
            expect("submenu" in item, `${toolset.id}/${group.id}/${item.id} submenu key`).toBe(true);
            continue;
          }
          if (item.kind === "separator" || item.kind === "spacer") {
            // Flattened toolbars carry structural items (dividers/spaces) with explicit stable ids so
            // customize mode can address them (hide/reorder); they are commandless by definition.
            expect(item.id, `${toolset.id}/${group.id} structural item id`).toBeTruthy();
            expect(item.commandId, `${toolset.id}/${group.id}/${item.id} commandId`).toBeUndefined();
            expect(item.primary?.type, `${toolset.id}/${group.id}/${item.id} primary`).toBe("none");
            continue;
          }
          expect(item.id, `${toolset.id}/${group.id}/${item.commandId} id`).toBe(item.commandId);
          expect(item.kind, `${toolset.id}/${group.id}/${item.commandId} kind`).toBe("button");
          expect(item.label, `${toolset.id}/${group.id}/${item.commandId} label`).toBeTruthy();
          expect(item.primary, `${toolset.id}/${group.id}/${item.commandId} primary`).toEqual({
            type: "command",
            commandId: item.commandId
          });
          expect("submenu" in item, `${toolset.id}/${group.id}/${item.commandId} submenu key`).toBe(true);
          expect(item.tooltip?.title, `${toolset.id}/${group.id}/${item.commandId} tooltip`).toBeTruthy();
          expect(item.layout?.colSpan, `${toolset.id}/${group.id}/${item.commandId} colSpan`).toBeGreaterThanOrEqual(1);
          expect(item.layout?.rowSpan, `${toolset.id}/${group.id}/${item.commandId} rowSpan`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("computes grid size from cell metrics and item spans when no preferred size is present", () => {
    const size = computePaletteGridSize(
      { columns: 4, cellWidth: 24, cellHeight: 24, gap: 2, padding: 4 },
      [[
        {
          id: "control.width",
          kind: "control",
          label: "Width",
          primary: { type: "control", controlId: "width" },
          submenu: null,
          tooltip: { title: "Width" },
          layout: { colSpan: 4, rowSpan: 1 }
        }
      ]]
    );

    expect(size).toEqual({ width: 110, height: 32 });
  });

  it("maps a spacer item to a spacer palette model (primary none, no button)", () => {
    const spacerToolset: ToolsetDefinition = {
      id: "core.spaced",
      title: "Spaced",
      source: "core",
      defaultVisible: true,
      defaultMode: "floating",
      groups: [
        {
          id: "g",
          items: [
            { commandId: "tool.bond", title: "Bond" },
            { id: "user.spacer.1", kind: "spacer", label: "Spacer", primary: { type: "none" } }
          ]
        }
      ]
    };
    const items = getToolsetItemGroups("core.spaced", registry([spacerToolset]))[0];
    expect(items.map((item) => item.kind)).toEqual(["button", "spacer"]);
    expect(items[1].id).toBe("user.spacer.1");
    expect(items[1].primary.type).toBe("none");
  });

  it("counts a spacer's cells in the auto-flow grid size (spacers are not excluded like widgets)", () => {
    const size = computePaletteGridSize(
      { rows: 2, cellWidth: 24, cellHeight: 24, gap: 2, padding: 4 },
      [[
        {
          id: "user.spacer.1",
          kind: "spacer",
          label: "Spacer",
          primary: { type: "none" },
          submenu: null,
          tooltip: { title: "Spacer" },
          layout: { colSpan: 1, rowSpan: 2 }
        }
      ]]
    );

    expect(size).toEqual({ width: 32, height: 58 });
  });
});

describe("flattened Main toolbar manifest", () => {
  it("has a single group whose section boundaries are explicit removable dividers", () => {
    const main = desktopToolsets.find((toolset) => toolset.id === "core.main");
    expect(main?.groups).toHaveLength(1);
    expect(main?.groups[0]?.id).toBe("core.main.items");
    const dividerIds = main?.groups[0]?.items
      .filter((item) => item.kind === "separator")
      .map((item) => item.id);
    expect(dividerIds).toEqual([
      "core.main.divider.1",
      "core.main.divider.2",
      "core.main.divider.3",
      "core.main.divider.4",
      "core.main.divider.5",
      "core.main.divider.6",
      // divider.7 caps the trailing end of the bar (after the style-controls widget).
      "core.main.divider.7"
    ]);
  });

  it("hides a manifest divider via a persisted override (the drag-out remove path)", () => {
    const registry = createDesktopToolsetRegistry({
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", hiddenCommandIds: ["core.main.divider.1"] }]
    });
    const [items] = getToolsetItemGroups("core.main", registry);
    expect(items.some((item) => item.id === "core.main.divider.1")).toBe(false);
    expect(items.some((item) => item.id === "core.main.divider.2")).toBe(true);
  });
});

describe("migrateLegacyMainToolbarLayoutState", () => {
  it("re-homes legacy per-group additions and folds per-group orders onto core.main.items", () => {
    const migrated = migrateLegacyMainToolbarLayoutState({
      version: 1,
      toolsetOverrides: [
        {
          toolsetId: "core.main",
          groupOrder: ["core.main.layout", "core.main.selection"],
          hiddenCommandIds: ["tool.lasso"],
          itemAdditions: [
            {
              groupId: "core.main.arrows",
              index: 3,
              item: {
                id: "art.boolean.union",
                kind: "button",
                label: "Union",
                primary: { type: "command", commandId: "art.boolean.union" },
                submenu: null
              }
            }
          ],
          itemOrder: {
            "core.main.selection": ["tool.text", "tool.select"],
            "core.main.layout": ["layout.group"]
          }
        }
      ]
    }) as { toolsetOverrides: Array<Record<string, unknown>> };
    const override = migrated.toolsetOverrides[0];
    expect((override.itemAdditions as Array<{ groupId: string }>)[0].groupId).toBe("core.main.items");
    expect(override.itemOrder).toEqual({ "core.main.items": ["tool.text", "tool.select", "layout.group"] });
    expect(override.groupOrder).toBeUndefined();
    expect(override.hiddenCommandIds).toEqual(["tool.lasso"]);
  });

  it("passes through non-main overrides and already-migrated state unchanged", () => {
    const state = {
      version: 1,
      toolsetOverrides: [
        { toolsetId: "core.art", itemOrder: { "core.art.tools": ["tool.art.pen"] } },
        { toolsetId: "core.main", itemOrder: { "core.main.items": ["tool.select"] } }
      ]
    };
    expect(migrateLegacyMainToolbarLayoutState(state)).toBe(state);
    expect(migrateLegacyMainToolbarLayoutState(undefined)).toBeUndefined();
    expect(migrateLegacyMainToolbarLayoutState("garbage")).toBe("garbage");
  });

  it("applies end-to-end: a legacy-keyed order reorders the flattened Main toolbar", () => {
    const registry = createDesktopToolsetRegistry({
      version: 1,
      toolsetOverrides: [
        { toolsetId: "core.main", itemOrder: { "core.main.selection": ["tool.text", "tool.select"] } }
      ]
    });
    const [items] = getToolsetItemGroups("core.main", registry);
    expect(items.slice(0, 2).map((item) => item.id)).toEqual(["tool.text", "tool.select"]);
  });
});
