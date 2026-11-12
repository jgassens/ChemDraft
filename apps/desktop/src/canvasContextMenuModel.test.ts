import { describe, expect, it, vi } from "vitest";
import { buildObjectCanvasMenu, pageCanvasMenu, toNativeCanvasMenu, type CanvasMenuItem } from "./canvasContextMenuModel";
import type { CommandSpec } from "./commands";

const action = (id: string, title: string, extra: Partial<CommandSpec> = {}): CommandSpec =>
  ({ id, title, icon: "select", ...extra });

describe("canvas context-menu presentation model", () => {
  it("converts titles, separators, disabled reasons, checks and submenus without adding shortcuts", () => {
    const items = buildObjectCanvasMenu({ objectIndex: 1, objectCount: 4, targetKind: "bond",
      tableActions: [action("table.row.insertAbove", "Insert Row Above"), action("table.column.align.center", "Align Center")],
      layoutActions: [action("layout.arrange.row", "Arrange in a Row", { enabled: false, disabledReason: "Select two objects", shortcut: "CmdOrCtrl+R" }),
        action("layout.adjustArrangementSpacing", "Adjust spacing", { enabled: true })],
      bondStereoActions: [action("stereo.either", "Mark E/Z as unspecified", { enabled: false, disabledReason: "No double bond" })] });
    const native = toNativeCanvasMenu(items, "test");
    expect(native.items[0]).toMatchObject({ kind: "item", label: "Insert Row Above", enabled: true });
    expect(native.items[1]).toMatchObject({ kind: "submenu", label: "Align Column", items: [
      { kind: "item", label: "Center", enabled: true }
    ] });
    expect(native.items[2]).toEqual({ kind: "separator" });
    expect(native.items[3]).toMatchObject({ kind: "submenu", label: "Arrange", items: [
      { kind: "item", label: "Row", enabled: false, disabledReason: "Select two objects" },
      { kind: "separator" }, { kind: "item", label: "Adjust spacing…", enabled: true }
    ] });
    expect(JSON.stringify(native.items)).not.toMatch(/shortcut|accelerator|CmdOrCtrl/);
    expect(native.items).toContainEqual(expect.objectContaining({ kind: "item", label: "Molecule layer", enabled: false }));
    expect(toNativeCanvasMenu([{ kind: "command", commandId: "example.checked", label: "Checked", enabled: true, checked: true }], "check").items)
      .toContainEqual(expect.objectContaining({ kind: "item", label: "Checked", checked: true }));
  });

  it("keeps target-specific warning, arrow, bond-depth and layer commands in order", () => {
    const items = buildObjectCanvasMenu({ objectIndex: 0, objectCount: 3, targetKind: "object",
      atomWarning: { suppressed: true, count: 2, problemCommandId: "atom.problem.open.object.atom" },
      arrowStyleSource: { title: "Arrow style" },
      bondDepthContext: { targetBondRefs: [1, 2], relevantCrossings: [1], hasOverrides: true } });
    const labels = items.flatMap(item => item.kind === "command" || item.kind === "title" ? [item.label] : []);
    expect(labels).toEqual(["Cut", "Copy", "Paste", "Atom problem…", "Restore Warnings", "Arrow style",
      "Set as Default Arrow Style", "Bond depth", "Bring Selected Bonds In Front", "Send Selected Bonds Behind",
      "Use Default Bond Depth", "Layer 1 of 3", "Move Object Forward", "Move Object to Front", "Move Object Backward", "Move Object to Back"]);
  });

  it("routes one selected popup ID to the same command exactly once", () => {
    const menu = toNativeCanvasMenu(pageCanvasMenu, "page");
    const invoke = vi.fn();
    expect(menu.select("canvas-context:page:1", invoke)).toBe(true);
    expect(menu.select("canvas-context:page:1", invoke)).toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("edit.selectAll");
  });

  it.each([null, "canvas-context:old:0", "canvas-context:blocked:0", "clipboard.copy"])("dismisses %s without invoking", id => {
    const menu = toNativeCanvasMenu([{ kind: "command", commandId: "clipboard.copy", label: "Copy", enabled: false }], "blocked");
    const invoke = vi.fn();
    expect(menu.select(id, invoke)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not route a title or a child of a disabled submenu", () => {
    const items: CanvasMenuItem[] = [{ kind: "title", label: "Title" }, { kind: "submenu", id: "disabled", label: "Disabled",
      enabled: false, ariaLabel: "Disabled", items: [{ kind: "command", commandId: "clipboard.copy", label: "Copy", enabled: true }] }];
    for (const id of ["canvas-context:blocked:0", "canvas-context:blocked:1"]) {
      const invoke = vi.fn();
      expect(toNativeCanvasMenu(items, "blocked").select(id, invoke)).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    }
  });
});
