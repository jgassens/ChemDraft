import { afterEach, describe, expect, it } from "vitest";
import { applyToolsetLayoutState, parseToolsetLayoutState, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import { mergeVisibilityIntoLayoutState, migrateMainToolbarGroups, mainToolbarMigrationNoticePending,
  dismissMainToolbarMigrationNotice, resetMainToolbarGroups, reconcileMainToolbarPluginHomes } from "./toolbarLayoutState";
import { mainToolbarDefinition, mainToolbarHomeGroupId } from "./mainToolbarGroups";
import { createToolbarCatalog } from "./toolbarCatalog";
import { createDesktopToolsetRegistry, type DesktopToolsetDefinition } from "../toolsets";
import { reorderItems } from "./CustomizeToolbars/layoutStateEdits";

describe("mergeVisibilityIntoLayoutState", () => {
  it("records visibility for every known toolset and stays schema-valid", () => {
    const state = mergeVisibilityIntoLayoutState(undefined, ["core.main", "core.art"], new Set(["core.main"]));
    expect(state.toolsetOverrides).toEqual([
      { toolsetId: "core.main", visible: true },
      { toolsetId: "core.art", visible: false }
    ]);
    // Round-trips through the loader's schema (what Rust reads back).
    expect(() => parseToolsetLayoutState(state)).not.toThrow();
  });

  it("updates visibility without clobbering other customization on the same override", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", visible: false, title: "Renamed", hiddenCommandIds: ["tool.bond"] }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set(["core.main"]));
    expect(merged.toolsetOverrides[0]).toEqual({
      toolsetId: "core.main",
      visible: true,
      title: "Renamed",
      hiddenCommandIds: ["tool.bond"]
    });
  });

  it("preserves the top-level toolset order while saving visibility", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOrder: ["core.art", "core.main"],
      toolsetOverrides: [],
      userToolsets: []
    };

    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main", "core.art"], new Set(["core.main"]));

    expect(merged.toolsetOrder).toEqual(["core.art", "core.main"]);
    expect(merged.toolsetOrder).not.toBe(existing.toolsetOrder);
  });

  it("hides a customized toolset while preserving its other customization", () => {
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", visible: true, title: "Renamed", hiddenCommandIds: ["tool.bond"] }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set());
    expect(merged.toolsetOverrides[0]).toEqual({
      toolsetId: "core.main",
      visible: false,
      title: "Renamed",
      hiddenCommandIds: ["tool.bond"]
    });
  });

  it("preserves overrides for toolsets that aren't in the passed id list (unloaded or unresolved plugins)", () => {
    // This is the mechanism the MainWindow visibility save relies on to avoid clobbering a
    // just-appeared plugin toolset's saved visible:true: exclude it from the id list and its
    // override is carried through untouched.
    const existing: ToolsetLayoutState = {
      version: 1,
      toolsetOverrides: [{ toolsetId: "plugin.absent", visible: true }],
      userToolsets: []
    };
    const merged = mergeVisibilityIntoLayoutState(existing, ["core.main"], new Set());
    expect(merged.toolsetOverrides).toContainEqual({ toolsetId: "plugin.absent", visible: true });
    expect(merged.toolsetOverrides).toContainEqual({ toolsetId: "core.main", visible: false });
  });
});

describe("saved plugin button homes", () => {
  const pluginId = "plugin.saved.run";
  const fragment = (groupId: string): DesktopToolsetDefinition => ({
    id: "core.main", title: "Main", source: "plugin", defaultVisible: false, defaultMode: "floating",
    groups: [{ id: groupId, items: [{ commandId: pluginId, title: "Saved tool" }] }]
  });
  const saved = (): ToolsetLayoutState => ({
    version: 1, userToolsets: [], mainToolbarGroupsMigration: { version: 1, noticePending: false },
    toolsetOverrides: [{ toolsetId: "core.main", itemOrder: { "select-text": ["tool.text", pluginId, "tool.select"] },
      itemAdditions: [{ groupId: "select-text", index: 1, item: { commandId: pluginId, icon: "palette" } }] }]
  });
  const visible = (catalog: ReturnType<typeof createToolbarCatalog>, groupId: string) =>
    catalog.registry().require("core.main").groups.find(group => group.id === groupId)?.items.map(item => item.commandId);
  afterEach(() => { createToolbarCatalog(); });

  it("retains an absent plugin's saved entry without rendering it, then restores its position", () => {
    const state = saved();
    const original = JSON.stringify(state);
    const catalog = createToolbarCatalog();
    catalog.setLayoutState(state);
    expect(visible(catalog, "select-text")?.slice(0, 2)).toEqual(["tool.text", "tool.select"]);
    expect(catalog.registry().require("core.main").groups.flatMap(group => group.items)
      .some(item => item.commandId === pluginId)).toBe(false);
    expect(JSON.stringify(state)).toBe(original);
    catalog.setPluginToolsets([fragment("select-text")]);
    expect(visible(catalog, "select-text")?.slice(0, 3)).toEqual(["tool.text", pluginId, "tool.select"]);
    catalog.setPluginToolsets([]);
    expect(visible(catalog, "select-text")).not.toContain(pluginId);
    catalog.setPluginToolsets([fragment("select-text")]);
    expect(visible(catalog, "select-text")?.slice(0, 3)).toEqual(["tool.text", pluginId, "tool.select"]);
    expect(JSON.stringify(state)).toBe(original);
  });

  it("keeps absent slots when the user reorders other buttons and round-trips the save", () => {
    createToolbarCatalog();
    const next = reorderItems(saved(), "core.main", "select-text", ["tool.select", "tool.text"]);
    expect(next.toolsetOverrides[0].itemOrder?.["select-text"]).toEqual(["tool.select", pluginId, "tool.text"]);
    const catalog = createToolbarCatalog();
    catalog.setLayoutState(JSON.parse(JSON.stringify(next)));
    expect(visible(catalog, "select-text")?.slice(0, 2)).toEqual(["tool.select", "tool.text"]);
    catalog.setPluginToolsets([fragment("select-text")]);
    expect(visible(catalog, "select-text")?.slice(0, 3)).toEqual(["tool.select", pluginId, "tool.text"]);
    createToolbarCatalog();
    expect(reorderItems(saved(), "core.main", "select-text", []).toolsetOverrides[0].itemOrder?.["select-text"]).toEqual([pluginId]);
  });

  it("reconciles changed homes once, preserving hides, additions, and unrelated absent entries", () => {
    const state = saved();
    state.toolsetOverrides[0].itemOrder!.arrows = ["plugin.absent.run"];
    state.toolsetOverrides[0].hiddenCommandIds = [pluginId];
    state.toolsetOverrides[0].itemOverrides = [{ commandId: pluginId, hidden: true, placement: { groupId: "select-text", order: 3 } }];
    const catalog = createToolbarCatalog();
    catalog.setPluginToolsets([fragment("arrows")]);
    const definition = catalog.baseToolsets().find(toolset => toolset.id === "core.main")!;
    const once = reconcileMainToolbarPluginHomes(state, definition) as ToolsetLayoutState;
    expect(once.toolsetOverrides[0]).toMatchObject({
      itemOrder: { "select-text": ["tool.text", "tool.select"], arrows: ["plugin.absent.run", pluginId] },
      itemAdditions: [{ groupId: "arrows", item: { commandId: pluginId, icon: "palette" } }],
      hiddenCommandIds: [pluginId],
      itemOverrides: [{ commandId: pluginId, hidden: true, placement: { groupId: "arrows", order: 3 } }]
    });
    expect(reconcileMainToolbarPluginHomes(once, definition)).toBe(once);
    const roundTrip = JSON.parse(JSON.stringify(once));
    expect(reconcileMainToolbarPluginHomes(roundTrip, definition)).toBe(roundTrip);
    expect(saved().toolsetOverrides[0].itemOrder?.["select-text"]).toContain(pluginId);
    catalog.setLayoutState(once);
    expect(visible(catalog, "arrows")).not.toContain(pluginId);
    const reordered = reorderItems(once, "core.main", "arrows", [pluginId, "tool.art.reactionArrow"]);
    expect(reconcileMainToolbarPluginHomes(reordered, definition)).toBe(reordered);
    expect(reordered.toolsetOverrides[0].itemOrder?.arrows).toContain("plugin.absent.run");
  });

  it("moves a saved legacy Undeclared button to its newly declared home in both registry paths", () => {
    const state = saved();
    state.toolsetOverrides[0].itemOrder = { undeclared: [pluginId] };
    state.toolsetOverrides[0].itemAdditions![0].groupId = "undeclared";
    const catalog = createToolbarCatalog();
    catalog.setLayoutState(state);
    catalog.setPluginToolsets([fragment("arrows")]);
    expect(visible(catalog, "arrows")).toContain(pluginId);
    expect(catalog.registry().require("core.main").groups.some(group => group.id === "undeclared")).toBe(false);
    const detached = createDesktopToolsetRegistry(state, undefined, [fragment("arrows")]);
    expect(detached.require("core.main")).toEqual(catalog.registry().require("core.main"));
  });
});

describe("main toolbar group migration", () => {
  const migrate = (state: unknown) => parseToolsetLayoutState(migrateMainToolbarGroups(state));
  const legacy: ToolsetLayoutState = {
    version: 1, userToolsets: [], toolsetOverrides: [{ toolsetId: "core.main",
      itemOrder: { "core.main.items": ["tool.text", "tool.lasso", "tool.bond", "tool.select", "plugin.missing.run", "user.spacer.9"] },
      hiddenCommandIds: ["tool.lasso", "layout.alignRight", "plugin.missing.run", "core.main.divider.1"],
      itemAdditions: [{ groupId: "core.main.items", index: 2,
        item: { id: "user.spacer.9", kind: "spacer", primary: { type: "none" } } }]
    }, { toolsetId: "core.art", title: "Art custom" }]
  };
  it("maps every saved button to its home, drops spacing, and preserves relative order and hidden state", () => {
    const next = migrate(legacy);
    const main = next.toolsetOverrides[0];
    expect(main.itemOrder?.["select-text"]).toEqual(["tool.text", "tool.lasso", "tool.select", "tool.eraser"]);
    for (const [groupId, ids] of Object.entries(main.itemOrder!)) {
      for (const id of ids) expect(mainToolbarHomeGroupId(id)).toBe(groupId);
    }
    const savedIds = Object.values(main.itemOrder!).flat();
    for (const item of mainToolbarDefinition.groups.flatMap(group => group.items)) expect(savedIds).toContain(item.id);
    expect(savedIds).not.toContain("user.spacer.9");
    expect(savedIds).not.toContain("core.main.divider.1");
    expect(main.hiddenCommandIds).toEqual(["tool.lasso", "layout.alignRight", "plugin.missing.run"]);
    expect(main.itemAdditions).toEqual([{ groupId: "undeclared", index: 0, item: { commandId: "plugin.missing.run" } }]);
    expect(next.toolsetOverrides[1]).toEqual(legacy.toolsetOverrides[1]);
    expect(mainToolbarMigrationNoticePending(next)).toBe(true);
    const [applied] = applyToolsetLayoutState([mainToolbarDefinition], next, { additionalCommandIds: ["plugin.missing.run"] });
    expect(applied.groups.find(group => group.id === "arrange")?.items).toHaveLength(18);
    expect(applied.groups.find(group => group.id === "select-text")?.items.map(item => item.id)).toEqual(["tool.text", "tool.select", "tool.eraser"]);
    expect(applied.groups.some(group => group.id === "undeclared")).toBe(false);
  });
  it("replays historical group order and group-relative additions before mapping homes", () => {
    const next = migrate({ version: 1, toolsetOverrides: [{ toolsetId: "core.main",
      groupOrder: ["core.main.layout", "core.main.selection"],
      itemOrder: { "core.main.selection": ["tool.text", "tool.select"], "core.main.layout": ["layout.group"] },
      itemAdditions: [{ groupId: "core.main.structure", index: 1, item: { commandId: "tool.chainFlexible" } }]
    }] });
    const main = next.toolsetOverrides[0];
    expect(main.groupOrder?.slice(0, 2)).toEqual(["arrange", "select-text"]);
    expect(main.itemOrder?.["select-text"]).toEqual(["tool.text", "tool.select", "tool.lasso", "tool.eraser"]);
    expect(main.itemOrder?.["bonds-rings"]?.slice(0, 3)).toEqual(["tool.bond", "tool.chainFlexible", "tool.wedgeBond"]);
    expect(main.itemOrder?.["arrange"]?.[0]).toBe("layout.group");
    expect(main.itemOrder?.["style-3d"]).toContain("style.formulaText");
  });
  it("migrates saved unknown additions to Undeclared without losing their order or icons", () => {
    const next = migrate({ version: 1, toolsetOverrides: [{ toolsetId: "core.main",
      itemOrder: { "core.main.items": ["plugin.two.run", "plugin.one.run"] },
      itemAdditions: ["one", "two"].map(name => ({ groupId: "core.main.items", item: {
        commandId: `plugin.${name}.run`, icon: "palette"
      } }))
    }] });
    expect(next.toolsetOverrides[0].itemOrder?.undeclared).toEqual(["plugin.two.run", "plugin.one.run"]);
    expect(next.toolsetOverrides[0].itemAdditions?.map(addition => [addition.groupId, addition.item.icon])).toEqual([
      ["undeclared", "palette"], ["undeclared", "palette"]
    ]);
  });
  it("records a durable marker, runs exactly once, and persists notice dismissal", () => {
    const once = migrate(legacy);
    expect(migrateMainToolbarGroups(once)).toBe(once);
    const saved = parseToolsetLayoutState(JSON.parse(JSON.stringify(once)));
    expect(migrateMainToolbarGroups(saved)).toBe(saved);
    const dismissed = dismissMainToolbarMigrationNotice(saved);
    expect(mainToolbarMigrationNoticePending(dismissed)).toBe(false);
    expect(migrateMainToolbarGroups(dismissed)).toBe(dismissed);
  });
  it("reset restores the grouped defaults while retaining other toolbars and the migration marker", () => {
    const reset = resetMainToolbarGroups(migrate(legacy));
    expect(reset.toolsetOverrides).toEqual([legacy.toolsetOverrides[1]]);
    expect(reset.mainToolbarGroupsMigration).toEqual({ version: 1, noticePending: false });
    const [applied] = applyToolsetLayoutState([mainToolbarDefinition], reset);
    expect(applied.groups.find(group => group.id === "arrange")?.items).toHaveLength(9);
    expect(applied.groups[0].items.map(item => item.id)).toEqual(["tool.select", "tool.lasso", "tool.eraser", "tool.text"]);
    expect(migrateMainToolbarGroups(reset)).toBe(reset);
  });
  it("does not notify for fresh, visibility-only, or already grouped layouts", () => {
    for (const overrides of [[], [{ toolsetId: "core.main", visible: false }],
      [{ toolsetId: "core.main", itemOrder: { "select-text": ["tool.text"] } }]]) {
      expect(mainToolbarMigrationNoticePending(migrate({ version: 1, toolsetOverrides: overrides }))).toBe(false);
    }
    expect(migrateMainToolbarGroups(undefined)).toBeUndefined();
    expect(migrateMainToolbarGroups("invalid")).toBe("invalid");
  });
});
