import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYBINDING_SETTINGS,
  hasUnsavedShortcuts,
  isKeybindingScheme,
  isKeybindingSettings,
  isSchemeOverrides,
  isStoredKeybindingScheme,
  KEYBINDING_SCHEME,
  LEGACY_KEYBINDING_SCHEME,
  loadKeybindingSettings,
  saveKeybindingSettings,
  setUnsavedShortcuts,
  UNSAVED_SHORTCUTS_STORAGE_KEY,
  validSchemeOverrides
} from "./keybindingSettings";
// jsdom in this project doesn't expose localStorage, and the module reads
// globalThis.localStorage — so stub a minimal in-memory store for these tests.
import { MemoryStorage } from "./testSupport/memoryStorage";

const STORAGE_KEY = "chemdraft.keybindings.v1";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keybindingSettings", () => {
  it("has one built-in shortcut set and names the retired preset only for migration", () => {
    expect(KEYBINDING_SCHEME).toBe("chemdraw");
    expect(DEFAULT_KEYBINDING_SETTINGS).toEqual({ scheme: "chemdraw" });
    expect(LEGACY_KEYBINDING_SCHEME).toBe("chemdraft");
    expect(loadKeybindingSettings()).toEqual(DEFAULT_KEYBINDING_SETTINGS);
  });

  it("persists and reloads custom keys for the set", () => {
    const overrides = { chemdraw: { commands: { "document.save": ["Mod+F9"] } } };
    saveKeybindingSettings({ scheme: "chemdraw", overrides });
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw", overrides });
  });

  // Whatever an older version stored, every window resolves the one set.
  it.each([
    ["the retired preset", JSON.stringify({ scheme: "chemdraft" })],
    ["an unknown scheme", JSON.stringify({ scheme: "vim" })],
    ["no scheme", JSON.stringify({})],
    ["corrupt JSON", "{not json"],
    ["a JSON array", "[1,2]"],
    ["JSON null", "null"],
    ["malformed overrides", JSON.stringify({ scheme: "chemdraft", overrides: { chemdraft: { commands: { "document.save": "Mod+S" } } } })]
  ])("falls back to the one set for %s, never throwing", (_label, raw) => {
    storage.setItem(STORAGE_KEY, raw);
    expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
  });

  it("keeps the retired preset's stored custom keys as data, unapplied", () => {
    const overrides = { chemdraft: { atom: { "atom.setHoveredElement.F": ["q"] } } };
    storage.setItem(STORAGE_KEY, JSON.stringify({ scheme: "chemdraft", overrides }));
    const settings = loadKeybindingSettings();
    expect(settings.scheme).toBe("chemdraw");
    // Readers use overrides.chemdraw only; the old entry waits for shortcutDefaultMigration.ts.
    expect(settings.overrides?.chemdraw).toBeUndefined();
  });

  // Palettes, popovers, Preferences and other ?window= webviews load on their own; with one set
  // there is nothing for them to pick, so they resolve exactly as the document window does.
  describe.each([
    ["a palette", "?window=toolset&toolsetId=core.main&resizable=false"],
    ["the Preferences window", "?window=preferences"],
    ["the document window", ""]
  ])("in %s", (_label, search) => {
    beforeEach(() => {
      vi.stubGlobal("location", { search });
    });

    it("uses the one set when storage is unavailable or its write failed", () => {
      vi.stubGlobal("localStorage", undefined);
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); } });
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
      const failing = new MemoryStorage();
      failing.setItem = () => { throw new Error("QuotaExceededError"); };
      vi.stubGlobal("localStorage", failing);
      expect(() => saveKeybindingSettings({ scheme: "chemdraw" })).not.toThrow();
      expect(loadKeybindingSettings()).toEqual({ scheme: "chemdraw" });
    });
  });

  it("type-guards the set, stored ids and settings payloads", () => {
    expect(isKeybindingScheme("chemdraw")).toBe(true);
    expect(isKeybindingScheme("chemdraft")).toBe(false);
    expect(isKeybindingScheme("vim")).toBe(false);
    expect(isStoredKeybindingScheme("chemdraw")).toBe(true);
    expect(isStoredKeybindingScheme("chemdraft")).toBe(true);
    expect(isStoredKeybindingScheme("vim")).toBe(false);
    expect(isKeybindingSettings({ scheme: "chemdraw" })).toBe(true);
    expect(isKeybindingSettings({ scheme: "chemdraft" })).toBe(false);
    expect(isKeybindingSettings({ scheme: "vim" })).toBe(false);
    expect(isKeybindingSettings(undefined)).toBe(false);
    expect(isKeybindingSettings(null)).toBe(false);
    expect(isSchemeOverrides({ chemdraft: { atom: { "atom.setHoveredElement.F": ["q"] } }, chemdraw: {} })).toBe(true);
    expect(isSchemeOverrides({ vim: {} })).toBe(false);
    expect(isSchemeOverrides({ chemdraw: { menus: {} } })).toBe(false);
    expect(isSchemeOverrides({ chemdraw: { commands: { "document.save": [""] } } })).toBe(false);
    expect(isSchemeOverrides([])).toBe(false);
  });
});

describe("validSchemeOverrides", () => {
  it("keeps every valid entry and drops only the invalid ones", () => {
    const valid = { chemdraw: { commands: { "document.save": ["Mod+F9"], "tool.lasso": [] }, atom: { "atom.setHoveredElement.Br": ["D"] } } };
    expect(validSchemeOverrides(valid)).toEqual(valid);
    expect(validSchemeOverrides({
      chemdraw: { commands: { "document.save": ["Mod+F9"], "tool.eraser": "F6", "no dot": ["F7"] }, menus: { "a.b": ["F8"] } },
      chemdraft: { bond: { "bond.setHoveredType.single": [""] } },
      vim: { commands: { "document.open": ["F2"] } }
    })).toEqual({ chemdraw: { commands: { "document.save": ["Mod+F9"] } }, chemdraft: {} });
  });

  it("returns undefined for anything that is not a map", () => {
    for (const value of [undefined, null, "nonsense", 3, [], [{ chemdraw: {} }]]) {
      expect(validSchemeOverrides(value)).toBeUndefined();
    }
  });
});

describe("the mark for custom keys the native file has not saved", () => {
  it("is set and cleared in the webview cache, or in a store passed in", () => {
    expect(hasUnsavedShortcuts()).toBe(false);
    setUnsavedShortcuts(true);
    expect(storage.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY)).not.toBeNull();
    expect(hasUnsavedShortcuts()).toBe(true);
    setUnsavedShortcuts(false);
    expect(hasUnsavedShortcuts()).toBe(false);

    const other = new MemoryStorage();
    setUnsavedShortcuts(true, other);
    expect(hasUnsavedShortcuts(other)).toBe(true);
    expect(hasUnsavedShortcuts()).toBe(false);
  });

  it("never throws on blocked storage, and reads as nothing unsaved", () => {
    const blocked = new MemoryStorage();
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(blocked, method).mockImplementation(() => { throw new Error("SecurityError"); });
    }
    expect(() => setUnsavedShortcuts(true, blocked)).not.toThrow();
    expect(() => setUnsavedShortcuts(false, blocked)).not.toThrow();
    expect(hasUnsavedShortcuts(blocked)).toBe(false);
  });
});
