import { describe, expect, it } from "vitest";
import {
  ToolsetRegistry,
  applyToolsetLayoutState,
  type ToolsetDefinition,
  type ToolsetLayoutState
} from "@chemdraft/toolset-registry";
import {
  cloneToolset,
  createUserToolset,
  deleteUserToolset,
  emptyLayoutState,
  renameToolset,
  reorderGroups,
  reorderItems,
  reorderToolsets,
  resetAllLayouts,
  resetToolsetLayout,
  setItemHidden,
  setToolsetVisible,
  setUserToolsetGroups,
  userToolsetId
} from "./layoutStateEdits";

// A tiny fixture toolset with two command items and one widget (control) item.
const baseToolset: ToolsetDefinition = {
  id: "core.demo",
  title: "Demo",
  source: "core",
  defaultVisible: true,
  defaultMode: "floating",
  groups: [
    {
      id: "core.demo.main",
      items: [
        { id: "tool.a", kind: "button", label: "A", primary: { type: "command", commandId: "tool.a" }, submenu: null },
        { id: "tool.b", kind: "button", label: "B", primary: { type: "command", commandId: "tool.b" }, submenu: null },
        {
          id: "widget.core.demo",
          kind: "control",
          label: "Demo widget",
          primary: { type: "control", controlId: "widget.core.demo" },
          submenu: null
        }
      ]
    }
  ]
};

function apply(state: ToolsetLayoutState, extra: readonly ToolsetDefinition[] = []) {
  const warnings: string[] = [];
  const toolsets = applyToolsetLayoutState([baseToolset, ...extra], state, {
    onUnknownCommand: "prune",
    onWarning: (warning) => warnings.push(warning)
  });
  return { toolsets, warnings };
}

function itemIds(toolset: ToolsetDefinition | undefined): string[] {
  return toolset?.groups.flatMap((group) => group.items.flatMap((item) => (item.id ? [item.id] : []))) ?? [];
}

describe("layoutStateEdits — override edits", () => {
  it("does not mutate the input state", () => {
    const state = emptyLayoutState();
    const snapshot = structuredClone(state);
    setToolsetVisible(state, "core.demo", false);
    renameToolset(state, "core.demo", "Renamed");
    setItemHidden(state, "core.demo", "tool.b", true);
    expect(state).toEqual(snapshot);
  });

  it("upserts visibility + title onto a single override", () => {
    const hidden = setToolsetVisible(emptyLayoutState(), "core.demo", false);
    expect(hidden.toolsetOverrides).toEqual([{ toolsetId: "core.demo", visible: false }]);
    const named = renameToolset(hidden, "core.demo", "Renamed");
    expect(named.toolsetOverrides[0]).toEqual({ toolsetId: "core.demo", visible: false, title: "Renamed" });
    // Toggling visibility again reuses the same override and preserves the title.
    const shown = setToolsetVisible(named, "core.demo", true);
    expect(shown.toolsetOverrides).toEqual([{ toolsetId: "core.demo", visible: true, title: "Renamed" }]);
    // A blank rename clears just the title.
    expect(renameToolset(shown, "core.demo", "  ").toolsetOverrides[0]).toEqual({ toolsetId: "core.demo", visible: true });
  });

  it("reorders toolsets and clears the order when empty", () => {
    const ordered = reorderToolsets(emptyLayoutState(), ["core.demo", "core.other"]);
    expect(ordered.toolsetOrder).toEqual(["core.demo", "core.other"]);
    expect(reorderToolsets(ordered, []).toolsetOrder).toBeUndefined();
  });

  it("reorders groups and items, pruning empty order maps", () => {
    const groups = reorderGroups(emptyLayoutState(), "core.demo", ["g2", "g1"]);
    expect(groups.toolsetOverrides[0].groupOrder).toEqual(["g2", "g1"]);
    const items = reorderItems(groups, "core.demo", "core.demo.main", ["tool.b", "tool.a"]);
    expect(items.toolsetOverrides[0].itemOrder).toEqual({ "core.demo.main": ["tool.b", "tool.a"] });
    const clearedItems = reorderItems(items, "core.demo", "core.demo.main", []);
    expect(clearedItems.toolsetOverrides[0].itemOrder).toBeUndefined();
  });

  it("hides and shows items, cleaning up the last one", () => {
    const oneHidden = setItemHidden(emptyLayoutState(), "core.demo", "tool.b", true);
    expect(oneHidden.toolsetOverrides[0].hiddenCommandIds).toEqual(["tool.b"]);
    const shown = setItemHidden(oneHidden, "core.demo", "tool.b", false);
    expect(shown.toolsetOverrides).toEqual([]);
  });

  it("resets one toolset's layout while leaving others and user toolsets intact", () => {
    let state = setToolsetVisible(emptyLayoutState(), "core.demo", false);
    state = setToolsetVisible(state, "core.other", false);
    const created = createUserToolset(state, { title: "Mine" });
    const reset = resetToolsetLayout(created.state, "core.demo");
    expect(reset.toolsetOverrides.map((override) => override.toolsetId)).toEqual(["core.other"]);
    expect(reset.userToolsets).toHaveLength(1);
  });

  it("resets everything", () => {
    const state = createUserToolset(setToolsetVisible(emptyLayoutState(), "core.demo", false), { title: "Mine" }).state;
    expect(resetAllLayouts()).toEqual({ version: 1, toolsetOverrides: [], userToolsets: [] });
    expect(state.userToolsets).toHaveLength(1); // original untouched
  });
});

describe("layoutStateEdits — user toolsets", () => {
  it("derives unique user.* ids from a title", () => {
    expect(userToolsetId("My Tools!", new Set())).toBe("user.my-tools");
    expect(userToolsetId("My Tools!", new Set(["user.my-tools"]))).toBe("user.my-tools-2");
    expect(userToolsetId("My Tools!", new Set(["user.my-tools", "user.my-tools-2"]))).toBe("user.my-tools-3");
    expect(userToolsetId("   ", new Set())).toBe("user.toolbar");
  });

  it("creates an empty user toolset", () => {
    const { state, toolsetId } = createUserToolset(emptyLayoutState(), { title: "My Tools" });
    expect(toolsetId).toBe("user.my-tools");
    expect(state.userToolsets[0]).toMatchObject({ id: "user.my-tools", title: "My Tools", source: "user" });
    expect(state.userToolsets[0].groups[0].items).toEqual([]);
  });

  it("clones a built-in toolset into an editable user copy", () => {
    const { state, toolsetId } = cloneToolset(emptyLayoutState(), baseToolset);
    expect(toolsetId).toBe("user.demo-copy");
    const clone = state.userToolsets[0];
    expect(clone.source).toBe("user");
    expect(clone.clonedFromToolsetId).toBe("core.demo");
    expect(itemIds(clone)).toEqual(["tool.a", "tool.b", "widget.core.demo"]);
  });

  it("deletes a user toolset and scrubs order + overrides; no-op for core", () => {
    let { state } = cloneToolset(emptyLayoutState(), baseToolset);
    const cloneId = state.userToolsets[0].id;
    state = setToolsetVisible(state, cloneId, false);
    state = reorderToolsets(state, ["core.demo", cloneId]);
    const deleted = deleteUserToolset(state, cloneId);
    expect(deleted.userToolsets).toEqual([]);
    expect(deleted.toolsetOverrides).toEqual([]);
    expect(deleted.toolsetOrder).toEqual(["core.demo"]);
    // Deleting a non-user toolset is a no-op.
    expect(deleteUserToolset(deleted, "core.demo")).toEqual(deleted);
  });

  it("edits a user toolset's groups but refuses structural edits on core toolsets", () => {
    const { state, toolsetId } = createUserToolset(emptyLayoutState(), { title: "Mine" });
    const withItems = setUserToolsetGroups(state, toolsetId, [
      { id: "user.mine.group", items: [{ id: "tool.a", kind: "button", label: "A", primary: { type: "command", commandId: "tool.a" }, submenu: null }] }
    ]);
    expect(itemIds(withItems.userToolsets[0])).toEqual(["tool.a"]);
    // Structural edit on a core toolset is rejected (returns the state unchanged).
    expect(setUserToolsetGroups(withItems, "core.demo", [])).toBe(withItems);
  });
});

describe("layoutStateEdits — round-trips through applyToolsetLayoutState", () => {
  it("hides a command item", () => {
    const state = setItemHidden(emptyLayoutState(), "core.demo", "tool.b", true);
    const { toolsets, warnings } = apply(state);
    expect(itemIds(toolsets.find((toolset) => toolset.id === "core.demo"))).toEqual(["tool.a", "widget.core.demo"]);
    expect(warnings).toEqual([]);
  });

  it("hides a WIDGET item by its controlId (exercises the widget-customization fixes)", () => {
    const state = setItemHidden(emptyLayoutState(), "core.demo", "widget.core.demo", true);
    const { toolsets, warnings } = apply(state);
    expect(itemIds(toolsets.find((toolset) => toolset.id === "core.demo"))).toEqual(["tool.a", "tool.b"]);
    // The widget id validates (no "unknown command" prune warning), proving it's a registered
    // override target and that applyUserToolsetOverride can key on the controlId.
    expect(warnings).toEqual([]);
  });

  it("reorders items within a group", () => {
    const state = reorderItems(emptyLayoutState(), "core.demo", "core.demo.main", ["widget.core.demo", "tool.b", "tool.a"]);
    const { toolsets } = apply(state);
    expect(itemIds(toolsets.find((toolset) => toolset.id === "core.demo"))).toEqual(["widget.core.demo", "tool.b", "tool.a"]);
  });

  it("renames + reorders a cloned user toolset that survives startup", () => {
    let state = cloneToolset(emptyLayoutState(), baseToolset).state;
    const cloneId = state.userToolsets[0].id;
    state = renameToolset(state, cloneId, "Custom");
    state = reorderToolsets(state, [cloneId, "core.demo"]);
    const { toolsets } = apply(state);
    expect(toolsets.map((toolset) => toolset.id)).toEqual([cloneId, "core.demo"]);
    expect(toolsets.find((toolset) => toolset.id === cloneId)?.title).toBe("Custom");
  });

  it("prunes a customization that targets a genuinely unknown command", () => {
    const state = setItemHidden(emptyLayoutState(), "core.demo", "tool.removedPlugin", true);
    const { toolsets, warnings } = apply(state);
    // The unknown id is dropped (not applied) and reported, without crashing startup.
    expect(itemIds(toolsets.find((toolset) => toolset.id === "core.demo"))).toEqual(["tool.a", "tool.b", "widget.core.demo"]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// The Customize dialog previews via applyToolsetLayoutState, but the app commits by feeding that
// result into `new ToolsetRegistry(...)`. These guard the case where customization empties a group
// or a whole toolset — which used to crash register()'s strict re-validation.
describe("layoutStateEdits — derived empties register without crashing", () => {
  function register(state: ToolsetLayoutState) {
    const applied = applyToolsetLayoutState([baseToolset], state, { onUnknownCommand: "prune" });
    return () => new ToolsetRegistry(applied);
  }

  it("registers a freshly-created empty user toolset", () => {
    const { state } = createUserToolset(emptyLayoutState(), { title: "My Tools" });
    expect(register(state)).not.toThrow();
    expect(new ToolsetRegistry(applyToolsetLayoutState([baseToolset], state, { onUnknownCommand: "prune" })).get("user.my-tools")).toBeDefined();
  });

  it("registers a toolset whose items were all hidden (empty group)", () => {
    let state = setItemHidden(emptyLayoutState(), "core.demo", "tool.a", true);
    state = setItemHidden(state, "core.demo", "tool.b", true);
    state = setItemHidden(state, "core.demo", "widget.core.demo", true);
    expect(register(state)).not.toThrow();
  });
});
