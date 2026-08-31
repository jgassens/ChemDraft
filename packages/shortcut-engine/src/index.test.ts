// @vitest-environment jsdom
// (jsdom: shouldIgnoreShortcutTarget tests need real Element/HTMLElement globals.)

import { describe, expect, it } from "vitest";
import {
  createShortcutRegistry,
  keyboardEventChord,
  normalizeShortcut,
  parseShortcutDisplay,
  shortcutChord,
  shortcutsFromCommands,
  shouldIgnoreShortcutTarget
} from "./index";

describe("shortcut-engine", () => {
  it("parses display shortcuts including plus and single-key tools", () => {
    expect(parseShortcutDisplay("Cmd+N")).toEqual(["Cmd", "N"]);
    expect(parseShortcutDisplay("Shift+Cmd+R")).toEqual(["Shift", "Cmd", "R"]);
    expect(parseShortcutDisplay("Cmd++")).toEqual(["Cmd", "+"]);
    expect(parseShortcutDisplay("+")).toEqual(["+"]);
    expect(parseShortcutDisplay("B")).toEqual(["B"]);
  });

  it("normalizes platform modifiers and keys", () => {
    expect(shortcutChord(normalizeShortcut({ commandId: "view.toggleRulers", keys: ["CmdOrCtrl", "R"] }, "macos"))).toBe("Meta+r");
    expect(shortcutChord(normalizeShortcut({ commandId: "view.toggleRulers", keys: ["CmdOrCtrl", "R"] }, "windows"))).toBe("Ctrl+r");
    expect(shortcutChord(normalizeShortcut({ commandId: "tool.bond", keys: ["B"] }, "macos"))).toBe("b");
  });

  it("builds shortcuts from enabled command definitions only", () => {
    const shortcuts = shortcutsFromCommands([
      { id: "tool.select", shortcut: "V" },
      { id: "tool.bond", shortcut: "B", enabled: false },
      { id: "document.save", shortcut: "Cmd+S" }
    ]);

    expect(shortcuts.map((shortcut) => shortcut.commandId)).toEqual(["tool.select", "document.save"]);
  });

  it("resolves keyboard events to command ids", () => {
    const registry = createShortcutRegistry([
      { commandId: "tool.select", keys: ["V"] },
      { commandId: "view.toggleCrosshairs", keys: ["Shift", "Cmd", "R"] }
    ], { platform: "macos" });

    expect(registry.resolve({ key: "v" })).toBe("tool.select");
    expect(registry.resolve({ key: "R", metaKey: true, shiftKey: true })).toBe("view.toggleCrosshairs");
    expect(registry.resolve({ key: "R", metaKey: true })).toBeUndefined();
  });

  it("reports conflicts and avoids ambiguous resolution", () => {
    const registry = createShortcutRegistry([
      { commandId: "tool.select", keys: ["V"] },
      { commandId: "tool.altSelect", keys: ["V"] }
    ], { platform: "macos" });

    expect(registry.conflicts()).toEqual([{ chord: "v", commandIds: ["tool.select", "tool.altSelect"] }]);
    expect(registry.resolve({ key: "v" })).toBeUndefined();
  });

  it("formats keyboard event chords deterministically", () => {
    expect(keyboardEventChord({ key: "R", shiftKey: true, metaKey: true })).toBe("Shift+Meta+r");
    // "+" and "=" are one physical key, so they share one canonical chord (see "the zoom-in key").
    expect(keyboardEventChord({ key: "+", metaKey: true })).toBe("Meta+=");
    expect(keyboardEventChord({ key: "=", metaKey: true })).toBe("Meta+=");
  });
});

describe("the zoom-in key", () => {
  const registry = () =>
    createShortcutRegistry(
      shortcutsFromCommands([
        { id: "view.zoomIn", shortcut: "Cmd++" },
        { id: "view.zoomOut", shortcut: "Cmd+-" }
      ]),
      { platform: "macos" }
    );

  it("resolves from the key presses a real keyboard actually produces", () => {
    // "Cmd++" stored the chord "Meta++", but no keyboard produces a bare "+" with Meta: pressing
    // Cmd and the +/= key reports key "=", and adding Shift reports "+" WITH shiftKey. resolve()
    // is an exact chord match, so zoom-in was dead from the keyboard while zoom-out worked — an
    // asymmetric dead shortcut on the only keyboard route to zooming in.
    const zoom = registry();

    // Cmd+= — the unshifted press.
    expect(zoom.resolve({ key: "=", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }))
      .toBe("view.zoomIn");

    // Cmd+Shift+= — how most people press "Cmd plus". Shift is what turns "=" into "+" on this key,
    // so it carries no meaning of its own here.
    expect(zoom.resolve({ key: "+", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }))
      .toBe("view.zoomIn");

    // A layout with a dedicated unshifted "+" key.
    expect(zoom.resolve({ key: "+", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }))
      .toBe("view.zoomIn");

    // Zoom out is unaffected.
    expect(zoom.resolve({ key: "-", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }))
      .toBe("view.zoomOut");
  });

  it("does not report the equivalence as a conflict", () => {
    expect(registry().conflicts()).toEqual([]);
  });
});

describe("the space key", () => {
  it("resolves a Space binding from a real spacebar press", () => {
    // A KeyboardEvent reports the spacebar as key " ", and normalizeKey trimmed first — so the
    // event normalized to "" while the binding normalized to " ", and the two could never meet.
    // No command binds Space today, which is the only reason this has not bitten anyone.
    const registry = createShortcutRegistry(
      shortcutsFromCommands([{ id: "tool.pan", shortcut: "Space" }]),
      { platform: "macos" }
    );

    expect(registry.resolve({ key: " ", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }))
      .toBe("tool.pan");
    expect(keyboardEventChord({ key: " " })).toBe(" ");
  });
});

describe("shouldIgnoreShortcutTarget", () => {
  it("ignores a focused button so Space activates it without also firing a bound tool", () => {
    // ChemDraw scheme binds Space → select tool. Without `button` in the ignore list, pressing
    // Space on a focused palette button both activated the button AND switched tools — one press,
    // two actions. (The palette button's own keydown handler invokes its command; it does not
    // depend on the global handler.)
    const button = window.document.createElement("button");
    window.document.body.append(button);
    expect(shouldIgnoreShortcutTarget(button)).toBe(true);

    // A child node of the button resolves through closest().
    const label = window.document.createElement("span");
    button.append(label);
    expect(shouldIgnoreShortcutTarget(label)).toBe(true);
  });

  it("still ignores form fields and contenteditable, and still allows plain canvas chrome", () => {
    const input = window.document.createElement("input");
    const textarea = window.document.createElement("textarea");
    const editable = window.document.createElement("div");
    // The attribute, not the property: jsdom does not compute `isContentEditable`, and the
    // attribute is what the ignore list's selector matches.
    editable.setAttribute("contenteditable", "true");
    const plain = window.document.createElement("div");
    window.document.body.append(input, textarea, editable, plain);

    expect(shouldIgnoreShortcutTarget(input)).toBe(true);
    expect(shouldIgnoreShortcutTarget(textarea)).toBe(true);
    expect(shouldIgnoreShortcutTarget(editable)).toBe(true);
    expect(shouldIgnoreShortcutTarget(plain)).toBe(false);
    expect(shouldIgnoreShortcutTarget(null)).toBe(false);
  });
});
