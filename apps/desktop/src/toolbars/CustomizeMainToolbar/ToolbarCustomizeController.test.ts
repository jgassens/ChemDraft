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
});
