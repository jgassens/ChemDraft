import { describe, expect, it } from "vitest";
import type { ToolsetLayoutEditPayload } from "../../window-manager";
import { emptyLayoutState } from "../CustomizeToolbars/layoutStateEdits";
import { applyToolsetLayoutEdit } from "./applyLayoutEdit";

const TOOLSET = "core.main";
const context = {
  presentItemIds: new Set(["tool.select", "tool.bond"]),
  commandTitle: (id: string) => (id === "tool.extra" ? "Extra" : id === "tool.select" ? "Select" : undefined),
  commandIcon: (id: string) => (id === "tool.extra" ? "atom" : undefined),
  gridRows: 2
};

function payload(edit: ToolsetLayoutEditPayload["edit"]): ToolsetLayoutEditPayload {
  return { toolsetId: TOOLSET, edit };
}

describe("applyToolsetLayoutEdit", () => {
  it("reorderItems writes itemOrder for the group", () => {
    const next = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "reorderItems", groupId: "core.main.selection", orderedItemIds: ["tool.bond", "tool.select"] }),
      context
    );
    expect(next.toolsetOverrides[0]?.itemOrder).toEqual({ "core.main.selection": ["tool.bond", "tool.select"] });
  });

  it("addCommand adds the dialog's button item shape at the index", () => {
    const next = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "addCommand", groupId: "core.main.selection", index: 1, commandId: "tool.extra" }),
      context
    );
    expect(next.toolsetOverrides[0]?.itemAdditions).toEqual([
      {
        groupId: "core.main.selection",
        index: 1,
        item: {
          id: "tool.extra",
          kind: "button",
          label: "Extra",
          icon: "atom",
          primary: { type: "command", commandId: "tool.extra" },
          submenu: null
        }
      }
    ]);
  });

  it("addCommand for an unknown (title-less) command is a no-op", () => {
    const state = emptyLayoutState();
    const next = applyToolsetLayoutEdit(
      state,
      payload({ kind: "addCommand", groupId: "core.main.selection", index: 0, commandId: "plugin.unknown" }),
      context
    );
    expect(next).toBe(state);
  });

  it("addCommand for an already-present command is a no-op", () => {
    const state = emptyLayoutState();
    const next = applyToolsetLayoutEdit(
      state,
      payload({ kind: "addCommand", groupId: "core.main.selection", index: 0, commandId: "tool.select" }),
      context
    );
    expect(next).toBe(state);
  });

  it("addSpacer adds a spacer whose rowSpan comes from gridRows", () => {
    const next = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "addSpacer", groupId: "core.main.selection", index: 0 }),
      context
    );
    const addition = next.toolsetOverrides[0]?.itemAdditions?.[0];
    expect(addition?.item.kind).toBe("spacer");
    expect(addition?.item.id).toBe("user.spacer.1");
    expect(addition?.item.layout?.rowSpan).toBe(2);
    expect(addition?.item.primary).toEqual({ type: "none" });
  });

  it("addSpacer without gridRows defaults rowSpan to 1", () => {
    const next = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "addSpacer", groupId: "core.main.selection", index: 0 }),
      { ...context, gridRows: undefined }
    );
    expect(next.toolsetOverrides[0]?.itemAdditions?.[0]?.item.layout?.rowSpan).toBe(1);
  });

  it("addSeparator adds a divider whose rowSpan comes from gridRows", () => {
    const next = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "addSeparator", groupId: "core.main.selection", index: 2 }),
      context
    );
    const addition = next.toolsetOverrides[0]?.itemAdditions?.[0];
    expect(addition?.item.kind).toBe("separator");
    expect(addition?.item.id).toBe("user.separator.1");
    expect(addition?.item.layout?.rowSpan).toBe(2);
    expect(addition?.item.primary).toEqual({ type: "none" });
  });

  it("spacer and divider ids increment independently", () => {
    let state = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "addSpacer", groupId: "core.main.selection", index: 0 }),
      context
    );
    state = applyToolsetLayoutEdit(state, payload({ kind: "addSeparator", groupId: "core.main.selection", index: 0 }), context);
    state = applyToolsetLayoutEdit(state, payload({ kind: "addSpacer", groupId: "core.main.selection", index: 0 }), context);
    const ids = state.toolsetOverrides[0]?.itemAdditions?.map((addition) => addition.item.id);
    expect(ids).toEqual(["user.spacer.1", "user.separator.1", "user.spacer.2"]);
  });

  it("removeItem deletes an addition but hides a base item", () => {
    const added = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "addSpacer", groupId: "core.main.selection", index: 0 }),
      context
    );
    const removedSpacer = applyToolsetLayoutEdit(added, payload({ kind: "removeItem", itemId: "user.spacer.1" }), context);
    expect(removedSpacer.toolsetOverrides).toEqual([]);

    const hiddenBase = applyToolsetLayoutEdit(emptyLayoutState(), payload({ kind: "removeItem", itemId: "tool.bond" }), context);
    expect(hiddenBase.toolsetOverrides[0]?.hiddenCommandIds).toEqual(["tool.bond"]);
  });

  it("resetToolset clears the override", () => {
    const added = applyToolsetLayoutEdit(
      emptyLayoutState(),
      payload({ kind: "addSpacer", groupId: "core.main.selection", index: 0 }),
      context
    );
    expect(applyToolsetLayoutEdit(added, payload({ kind: "resetToolset" }), context).toolsetOverrides).toEqual([]);
  });

  it("exitCustomize leaves state unchanged (same reference)", () => {
    const state = emptyLayoutState();
    expect(applyToolsetLayoutEdit(state, payload({ kind: "exitCustomize" }), context)).toBe(state);
  });

  it("ignores edits for a different toolset only at the caller level (applier trusts the payload)", () => {
    // The applier itself applies whatever toolsetId the payload carries; MainWindow filters to
    // core.main before calling. This documents that contract.
    const next = applyToolsetLayoutEdit(
      emptyLayoutState(),
      { toolsetId: "core.other", edit: { kind: "addSpacer", groupId: "g", index: 0 } },
      context
    );
    expect(next.toolsetOverrides[0]?.toolsetId).toBe("core.other");
  });
});
