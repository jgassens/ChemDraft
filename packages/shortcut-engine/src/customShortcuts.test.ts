import { describe, expect, it } from "vitest";
import { actionShortcutKeys, editShortcut, type ShortcutAction } from "./index";

const save: ShortcutAction = { id: "document.save", scope: "commands", title: "Save", defaults: ["Mod+S"] };
const tool: ShortcutAction = { id: "tool.bond", scope: "commands", title: "Bond", defaults: ["M"] };
const bromine: ShortcutAction = { id: "atom.bromine", scope: "atom", title: "Bromine", defaults: ["b"] };
const boron: ShortcutAction = { id: "atom.boron", scope: "atom", title: "Boron", defaults: ["B"] };
const actions = [save, tool, bromine, boron];

describe.each(["macos", "windows"] as const)("shortcut edits on %s", platform => {
  it("checks a chord once, and moves it only after replacement", () => {
    const edit = { kind: "assign", key: "Mod+S" } as const;
    expect(editShortcut(actions, {}, tool, edit, platform)).toEqual({ kind: "conflict", actions: [save] });
    const reassigned = editShortcut(actions, {}, tool, edit, platform, true);
    expect(reassigned).toEqual({ kind: "updated", overrides: { commands: { [save.id]: [], [tool.id]: ["Mod+S"] } } });
    if (reassigned.kind !== "updated") throw new Error("Expected updated shortcuts");
    expect(editShortcut(actions, reassigned.overrides, save, { kind: "reset" }, platform)).toEqual({
      kind: "conflict", actions: [tool]
    });
    const cleared = editShortcut(actions, reassigned.overrides, tool, { kind: "clear" }, platform);
    if (cleared.kind !== "updated") throw new Error("Expected cleared shortcut");
    const reset = editShortcut(actions, cleared.overrides, save, { kind: "reset" }, platform);
    if (reset.kind !== "updated") throw new Error("Expected reset shortcut");
    expect(actionShortcutKeys(save, reset.overrides)).toEqual(["Mod+S"]);
    expect(actionShortcutKeys(tool, reset.overrides)).toEqual([]);
  });

  it("reports uppercase and lowercase hover conflicts independently", () => {
    expect(editShortcut(actions, {}, tool, { kind: "assign", key: "B" }, platform)).toEqual({ kind: "conflict", actions: [bromine] });
    expect(editShortcut(actions, {}, tool, { kind: "assign", key: "Shift+B" }, platform)).toEqual({ kind: "conflict", actions: [boron] });
  });

  it.each(["F5", "Mod+R", "Ctrl+R", "Mod+Q", "Mod+W"])("refuses %s", key => {
    expect(editShortcut(actions, {}, save, { kind: "assign", key }, platform)).toMatchObject({ kind: "refused" });
  });

  it("reserves system shortcuts for the active platform", () => {
    const key = platform === "macos" ? "Mod+Space" : "Alt+F4";
    expect(editShortcut(actions, {}, save, { kind: "assign", key }, platform)).toEqual({
      kind: "refused", reason: "Reserved by the operating system."
    });
  });
});
