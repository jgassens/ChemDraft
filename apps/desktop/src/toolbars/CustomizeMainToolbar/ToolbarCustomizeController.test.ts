// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { ToolbarPaletteGroupModel, ToolbarPaletteItemModel } from "../../toolsets";
import {
  customizeDragEndEdit,
  dispatchCustomizeEdit,
  dragGeometryPoint,
  galleryOverlayIconItem,
  optimisticGroupsForEdit,
  rollbackOptimisticPreview
} from "./ToolbarCustomizeController";

const item = (id: string): ToolbarPaletteItemModel => ({ id }) as unknown as ToolbarPaletteItemModel;
const groups: ToolbarPaletteGroupModel[] = [
  { id: "g1", items: [item("a"), item("b"), item("user.spacer.1")] },
  { id: "g2", items: [item("c")] }
];

describe("customizeDragEndEdit", () => {
  it("reorders within the same group", () => {
    expect(customizeDragEndEdit("a", { groupId: "g1" }, "b", groups)).toEqual({
      kind: "reorderItems",
      groupId: "g1",
      orderedItemIds: ["b", "a", "user.spacer.1"]
    });
  });

  it("removes an item dropped outside any slot (over === null)", () => {
    expect(customizeDragEndEdit("a", { groupId: "g1" }, null, groups)).toEqual({ kind: "removeItem", itemId: "a" });
  });

  it("snaps back a cross-group drag (base items can't be re-homed)", () => {
    expect(customizeDragEndEdit("a", { groupId: "g1" }, "c", groups)).toBeUndefined();
  });

  it("is a no-op when dropped on itself", () => {
    expect(customizeDragEndEdit("a", { groupId: "g1" }, "a", groups)).toBeUndefined();
  });

  it("reorders a spacer by its explicit id", () => {
    expect(customizeDragEndEdit("user.spacer.1", { groupId: "g1", kind: "spacer" }, "a", groups)).toEqual({
      kind: "reorderItems",
      groupId: "g1",
      orderedItemIds: ["user.spacer.1", "a", "b"]
    });
  });

  it("removes an in-toolbar item dropped onto the gallery tray", () => {
    expect(customizeDragEndEdit("b", { groupId: "g1" }, "gallery-tray", groups)).toEqual({
      kind: "removeItem",
      itemId: "b"
    });
  });

  it("adds a gallery command at the over-item's index", () => {
    expect(
      customizeDragEndEdit(
        "gallery:command:tool.text",
        { gallery: true, galleryKind: "command", commandId: "tool.text" },
        "b",
        groups
      )
    ).toEqual({ kind: "addCommand", groupId: "g1", index: 1, commandId: "tool.text" });
  });

  it("adds a spacer from the gallery over a slot", () => {
    expect(
      customizeDragEndEdit("gallery:spacer", { gallery: true, galleryKind: "spacer" }, "c", groups)
    ).toEqual({ kind: "addSpacer", groupId: "g2", index: 0 });
  });

  it("adds a divider from the gallery over a slot", () => {
    expect(
      customizeDragEndEdit("gallery:separator", { gallery: true, galleryKind: "separator" }, "a", groups)
    ).toEqual({ kind: "addSeparator", groupId: "g1", index: 0 });
  });

  it("is a no-op when a gallery tile is released on the tray or off the bar", () => {
    expect(
      customizeDragEndEdit("gallery:spacer", { gallery: true, galleryKind: "spacer" }, "gallery-tray", groups)
    ).toBeUndefined();
    expect(
      customizeDragEndEdit("gallery:spacer", { gallery: true, galleryKind: "spacer" }, null, groups)
    ).toBeUndefined();
  });

  it("is a no-op for a gallery command tile carrying no command id", () => {
    expect(
      customizeDragEndEdit("gallery:command:", { gallery: true, galleryKind: "command" }, "a", groups)
    ).toBeUndefined();
  });

  it("adds a widget from the gallery over a slot", () => {
    expect(
      customizeDragEndEdit(
        "gallery:widget:widget.core.mainStyleControls",
        { gallery: true, galleryKind: "widget", widgetId: "widget.core.mainStyleControls" },
        "b",
        groups
      )
    ).toEqual({ kind: "addWidget", groupId: "g1", index: 1, widgetId: "widget.core.mainStyleControls" });
  });

  it("removes an in-toolbar widget dragged off the bar", () => {
    expect(
      customizeDragEndEdit("widget.core.mainStyleControls", { widget: true, groupId: "g1", kind: "control" }, null, groups)
    ).toEqual({ kind: "removeItem", itemId: "widget.core.mainStyleControls" });
  });

  it("does not reorder a widget dropped back inside the palette (append panel, not a grid slot)", () => {
    expect(
      customizeDragEndEdit("widget.core.mainStyleControls", { widget: true, groupId: "g1", kind: "control" }, "a", groups)
    ).toBeUndefined();
  });
});

describe("optimisticGroupsForEdit", () => {
  it("previews a reorder within the group", () => {
    const next = optimisticGroupsForEdit(groups, {
      kind: "reorderItems",
      groupId: "g1",
      orderedItemIds: ["b", "a", "user.spacer.1"]
    });
    expect(next?.[0]?.items.map((item) => item.id)).toEqual(["b", "a", "user.spacer.1"]);
    // Other groups untouched (same reference).
    expect(next?.[1]).toBe(groups[1]);
  });

  it("previews a remove by dropping the item from whichever group holds it", () => {
    const next = optimisticGroupsForEdit(groups, { kind: "removeItem", itemId: "b" });
    expect(next?.[0]?.items.map((item) => item.id)).toEqual(["a", "user.spacer.1"]);
  });

  it("does not preview adds (returns null so the round-trip inserts)", () => {
    expect(optimisticGroupsForEdit(groups, { kind: "addSpacer", groupId: "g1", index: 0 })).toBeNull();
    expect(
      optimisticGroupsForEdit(groups, { kind: "addCommand", groupId: "g1", index: 0, commandId: "tool.x" })
    ).toBeNull();
    expect(optimisticGroupsForEdit(groups, { kind: "resetToolset" })).toBeNull();
  });
});

describe("drag geometry and transport", () => {
  it("ignores stale pointer history for a keyboard drag", () => {
    const keyboardEvent = {
      activatorEvent: new KeyboardEvent("keydown", { key: " " }),
      delta: { x: 24, y: 0 }
    } as unknown as Parameters<typeof dragGeometryPoint>[0];

    expect(dragGeometryPoint(keyboardEvent, { x: 999, y: 999 })).toBeNull();
  });

  it("uses the tracked pointer for a pointer drag and falls back to activator plus delta", () => {
    const pointerEvent = {
      activatorEvent: new MouseEvent("pointerdown", { clientX: 10, clientY: 12 }),
      delta: { x: 5, y: -2 }
    } as unknown as Parameters<typeof dragGeometryPoint>[0];

    expect(dragGeometryPoint(pointerEvent, { x: 40, y: 50 })).toEqual({ x: 40, y: 50 });
    expect(dragGeometryPoint(pointerEvent, null)).toEqual({ x: 15, y: 10 });
  });

  it("reports synchronous and asynchronous edit-send failures", async () => {
    const edit = { kind: "removeItem", itemId: "a" } as const;
    const syncFailure = vi.fn();
    const asyncFailure = vi.fn();

    dispatchCustomizeEdit(edit, () => {
      throw new Error("sync failed");
    }, syncFailure);
    dispatchCustomizeEdit(edit, () => Promise.reject(new Error("async failed")), asyncFailure);
    await Promise.resolve();

    expect(syncFailure).toHaveBeenCalledTimes(1);
    expect(asyncFailure).toHaveBeenCalledTimes(1);
  });

  it("rolls back the failed optimistic preview without erasing a newer preview", () => {
    const failedPreview = optimisticGroupsForEdit(groups, { kind: "removeItem", itemId: "a" });
    const newerPreview = optimisticGroupsForEdit(groups, { kind: "removeItem", itemId: "b" });
    expect(failedPreview).not.toBeNull();
    expect(newerPreview).not.toBeNull();

    expect(rollbackOptimisticPreview(failedPreview, failedPreview!)).toBeNull();
    expect(rollbackOptimisticPreview(newerPreview, failedPreview!)).toBe(newerPreview);
  });

  it("uses an icon ghost for gallery widgets but not structural entries", () => {
    const iconItem = item("widget.core.mainStyleControls");
    expect(galleryOverlayIconItem({ gallery: true, galleryKind: "widget", iconItem })).toBe(iconItem);
    expect(galleryOverlayIconItem({ gallery: true, galleryKind: "spacer", iconItem })).toBeUndefined();
  });
});
