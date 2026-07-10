import { describe, expect, it } from "vitest";
import type { ToolbarPaletteGroupModel, ToolbarPaletteItemModel } from "../../toolsets";
import { customizeDragEndEdit } from "./ToolbarCustomizeController";

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
});
