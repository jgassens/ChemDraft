import { describe, expect, it } from "vitest";
import {
  actionShortcutKeys, createHoverShortcutRegistry, editShortcut, hoverKeyFromEvent, recordedHoverKeyFromEvent, resolveHoverKey,
  shiftedHoverKeyAlternate, type ShortcutAction
} from "./index";

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

// Some macOS input paths (and automation) report Shift+= as key "=" with Shift held. The window chord
// engine folds +/= and drops Shift, but hover tables keep literal characters, so the hover lookup and
// the hover recorder must read that press as "+".
describe("shifted +/= on the hover path", () => {
  const shiftedEqual = { key: "=", code: "Equal", shiftKey: true };
  const charges = createHoverShortcutRegistry({ "+": "atom.plus", "-": "atom.minus" });

  it("reads Shift+= reported as \"=\" as +, and nothing else", () => {
    expect(shiftedHoverKeyAlternate(shiftedEqual)).toBe("+");
    expect(shiftedHoverKeyAlternate({ key: "=", code: "Equal" })).toBeUndefined();
    expect(shiftedHoverKeyAlternate({ key: "+", code: "Equal", shiftKey: true })).toBeUndefined();
    expect(shiftedHoverKeyAlternate({ key: "+", code: "NumpadAdd" })).toBeUndefined();
    expect(shiftedHoverKeyAlternate({ key: "=", code: "Digit0", shiftKey: true })).toBeUndefined();
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
      expect(shiftedHoverKeyAlternate({ ...shiftedEqual, [modifier]: true })).toBeUndefined();
    }
  });

  it("reads Shift+= from NumpadEqual (as automation injects it) the same as from Equal", () => {
    expect(shiftedHoverKeyAlternate({ key: "=", code: "NumpadEqual", shiftKey: true })).toBe("+");
    expect(shiftedHoverKeyAlternate({ key: "=", code: "NumpadEqual" })).toBeUndefined();
    expect(shiftedHoverKeyAlternate({ key: "=", code: "NumpadEqual", shiftKey: true, metaKey: true })).toBeUndefined();
  });

  it.each([
    ["Shift+= reported as = on NumpadEqual", { key: "=", code: "NumpadEqual", shiftKey: true }, "+"],
    ["Shift+= reported as = on Equal", { key: "=", code: "Equal", shiftKey: true }, "+"],
    ["physical + on Equal with Shift", { key: "+", code: "Equal", shiftKey: true }, "+"],
    ["numpad +", { key: "+", code: "NumpadAdd" }, "+"],
    ["typed + with placeholder code KeyA", { key: "+", code: "KeyA" }, "+"],
    ["typed + with placeholder code KeyA and Shift", { key: "+", code: "KeyA", shiftKey: true }, "+"],
    ["typed - with placeholder code KeyA", { key: "-", code: "KeyA" }, "-"],
    ["typed . with placeholder code KeyA", { key: ".", code: "KeyA" }, "a"],
    ["typed 3 with placeholder code KeyA", { key: "3", code: "KeyA" }, "a"],
    ["German + on BracketRight", { key: "+", code: "BracketRight" }, "+"],
    ["Swiss Shift+1 + on Digit1", { key: "+", code: "Digit1", shiftKey: true }, "+"],
    ["bare = on Equal", { key: "=", code: "Equal" }, "="],
    ["bare = on NumpadEqual", { key: "=", code: "NumpadEqual" }, "="],
    ["German Shift+0 = on Digit0", { key: "=", code: "Digit0", shiftKey: true }, "="],
    ["Cyrillic ф on KeyA", { key: "ф", code: "KeyA" }, "a"],
    ["Caps Lock A on KeyA", { key: "A", code: "KeyA" }, "a"]
  ])("recordedHoverKeyFromEvent reads %s as the intended key", (_name, event, expected) => {
    expect(recordedHoverKeyFromEvent(event)).toBe(expected);
  });

  it.each([
    ["typed + with placeholder code KeyA", { key: "+", code: "KeyA" }, "+"],
    ["typed - with placeholder code KeyA", { key: "-", code: "KeyA" }, "-"],
    // Only + and - bypass the physical-letter mapping; other punctuation on a letter code maps as in RC2.
    ["typed . with placeholder code KeyA", { key: ".", code: "KeyA" }, "a"],
    ["typed 3 with placeholder code KeyA", { key: "3", code: "KeyA" }, "a"],
    ["Cyrillic ф on KeyA", { key: "ф", code: "KeyA" }, "a"],
    ["Shift+Cyrillic Ф on KeyA", { key: "Ф", code: "KeyA", shiftKey: true }, "A"],
    ["Caps Lock A on KeyA", { key: "A", code: "KeyA" }, "a"],
    // Real layouts that put punctuation on a letter position keep RC2's physical-letter reading.
    ["Dvorak , on KeyW", { key: ",", code: "KeyW" }, "w"],
    ["Dvorak . on KeyE", { key: ".", code: "KeyE" }, "e"],
    ["Dvorak ; on KeyZ", { key: ";", code: "KeyZ" }, "z"],
    ["Dvorak ' on KeyQ", { key: "'", code: "KeyQ" }, "q"],
    ["AZERTY , on KeyM", { key: ",", code: "KeyM" }, "m"],
    ["AZERTY ; on Comma (not a letter code)", { key: ";", code: "Comma" }, ";"],
    ["+ on KeyA", { key: "+", code: "KeyA" }, "+"],
    ["- on Minus", { key: "-", code: "Minus" }, "-"],
    ["- on NumpadSubtract", { key: "-", code: "NumpadSubtract" }, "-"],
    ["+ on NumpadAdd", { key: "+", code: "NumpadAdd" }, "+"],
    // Letters from other scripts still map by physical position, so a binding on "a" works there.
    ["Greek α on KeyA", { key: "α", code: "KeyA" }, "a"],
    ["Shift+Greek Α on KeyA", { key: "Α", code: "KeyA", shiftKey: true }, "A"],
    ["Cyrillic ф on KeyA (again, as the base behavior)", { key: "ф", code: "KeyA" }, "a"],
    // Option+letter on macOS types letters such as π and å; they are \p{L}, so still mapped by code.
    ["Option π on KeyP", { key: "π", code: "KeyP", altKey: true }, "p"],
    ["Option å on KeyA", { key: "å", code: "KeyA", altKey: true }, "a"],
    // Dead keys report a multi-character key, so the base code mapping applies, as before.
    ["dead key on KeyE", { key: "Dead", code: "KeyE" }, "e"],
    ["Shift+dead key on KeyE", { key: "Dead", code: "KeyE", shiftKey: true }, "E"],
    // Keys with no letter code are returned as typed, as before.
    ["Escape", { key: "Escape", code: "Escape" }, "Escape"],
    ["digit 3 on Digit3", { key: "3", code: "Digit3" }, "3"]
  ])("hoverKeyFromEvent reads %s", (_name, event, expected) => {
    expect(hoverKeyFromEvent(event)).toBe(expected);
  });

  it("recordedHoverKeyFromEvent and resolveHoverKey keep Dvorak punctuation on its letter and read typed +", () => {
    const table = createHoverShortcutRegistry({ w: "atom.nitrogen", "+": "atom.plus", a: "atom.a" });
    const lookup = (key: string) => table.get(key);
    expect(recordedHoverKeyFromEvent({ key: ",", code: "KeyW" })).toBe("w");
    expect(resolveHoverKey({ key: ",", code: "KeyW" }, lookup)).toEqual({ key: "w", match: "atom.nitrogen" });
    expect(resolveHoverKey({ key: "+", code: "KeyA" }, lookup)).toEqual({ key: "+", match: "atom.plus" });
    expect(resolveHoverKey({ key: "a", code: "KeyA" }, lookup)).toEqual({ key: "a", match: "atom.a" });
    expect(resolveHoverKey({ key: "ф", code: "KeyA" }, lookup)).toEqual({ key: "a", match: "atom.a" });
  });

  it("a persisted RC2-style hover binding recorded as a letter still fires from a Dvorak punctuation key", () => {
    // RC2 recorded Dvorak "." on KeyE as "e"; an override on the letter must keep matching that press.
    const hoverBromine: ShortcutAction = { id: "atom.setHoveredElement.Br", scope: "atom", title: "Bromine", defaults: ["b"] };
    const overrides = { atom: { [hoverBromine.id]: ["e"] } };
    const table = createHoverShortcutRegistry({ b: hoverBromine.id }, overrides.atom);
    const lookup = (key: string) => table.get(key);
    expect(actionShortcutKeys(hoverBromine, overrides)).toEqual(["e"]);
    expect(table.get("b")).toBeUndefined();
    expect(resolveHoverKey({ key: ".", code: "KeyE" }, lookup)).toEqual({ key: "e", match: hoverBromine.id });
    expect(recordedHoverKeyFromEvent({ key: ".", code: "KeyE" })).toBe("e");
  });

  it("tries the literal binding first, then + in the same table", () => {
    const lookup = (table: ReadonlyMap<string, string>) => (key: string) => table.get(key);
    expect(resolveHoverKey(shiftedEqual, lookup(charges))).toEqual({ key: "+", match: "atom.plus" });
    expect(resolveHoverKey({ key: "+", code: "Equal", shiftKey: true }, lookup(charges))).toEqual({ key: "+", match: "atom.plus" });
    expect(resolveHoverKey({ key: "+", code: "NumpadAdd" }, lookup(charges))).toEqual({ key: "+", match: "atom.plus" });
    // A bare = is not +, and a literal = binding wins over the alternate.
    expect(resolveHoverKey({ key: "=", code: "Equal" }, lookup(charges))).toEqual({ key: "=", match: undefined });
    const both = createHoverShortcutRegistry({ "+": "atom.plus", "=": "atom.equals" });
    expect(resolveHoverKey(shiftedEqual, lookup(both))).toEqual({ key: "=", match: "atom.equals" });
    // Remapped or cleared bindings are respected: no hidden + fallback survives them.
    const cleared = createHoverShortcutRegistry({ "+": "atom.plus" }, { "atom.plus": [] });
    expect(resolveHoverKey(shiftedEqual, lookup(cleared))).toEqual({ key: "=", match: undefined });
    const remapped = createHoverShortcutRegistry({ "+": "atom.plus" }, { "atom.plus": ["p"] });
    expect(resolveHoverKey(shiftedEqual, lookup(remapped))).toEqual({ key: "=", match: undefined });
    expect(resolveHoverKey({ key: "p", code: "KeyP" }, lookup(remapped))).toEqual({ key: "p", match: "atom.plus" });
  });

  it("records Shift+= as +", () => {
    expect(recordedHoverKeyFromEvent(shiftedEqual)).toBe("+");
    expect(recordedHoverKeyFromEvent({ key: "+", code: "Equal", shiftKey: true })).toBe("+");
    expect(recordedHoverKeyFromEvent({ key: "=", code: "Equal" })).toBe("=");
    expect(recordedHoverKeyFromEvent({ key: "a", code: "KeyA", shiftKey: true })).toBe("A");
  });
});
