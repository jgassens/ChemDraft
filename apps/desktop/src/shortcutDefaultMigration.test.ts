import type { ShortcutOverrides, ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeLegacyShortcutOverrides, mergeStoredShortcutOverrides } from "./customKeyboardShortcuts";
import type { DesktopPreferences } from "./desktopPreferences";
import {
  KEYBINDING_STORAGE_KEY,
  loadKeybindingSettings,
  UNSAVED_SHORTCUTS_STORAGE_KEY,
  type StoredShortcutOverrides
} from "./keybindingSettings";
import {
  migrateShortcutDefault,
  PENDING_FRESH_INSTALL_KEY,
  resetShortcutDefaultMigrationForTests,
  SHORTCUT_SET_NOTICE_PENDING_KEY,
  SHORTCUT_SET_NOTICE_SHOWN_KEY,
  SHORTCUT_SET_NOTICE,
  takeShortcutSetNotice,
  type ShortcutDefaultMigrationHost
} from "./shortcutDefaultMigration";
import { MemoryStorage } from "./testSupport/memoryStorage";

/**
 * A fake install: the webview's localStorage plus, on the desktop runtime, the native
 * preferences.json (patched the way lib.rs `apply_patch` does: the scheme is replaced, custom keys
 * are merged per set id) and the toolbar layout file every desktop launch writes.
 */
function install(options: {
  desktop?: boolean;
  preferences?: DesktopPreferences | (() => never);
  /**
   * A native read that returns this value exactly as given, whatever it is (a string, null, an
   * array), until the first successful write. `preferences` is copied into a patchable object, so
   * a malformed value given there never reaches the code under test unchanged.
   */
  rawPreferences?: unknown;
  toolbarLayout?: boolean;
  local?: Record<string, string>;
  failNativeWrite?: boolean;
  platform?: ShortcutPlatform;
} = {}) {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(options.local ?? {})) storage.setItem(key, value);
  let preferences: DesktopPreferences = typeof options.preferences === "function" ? {} : { ...options.preferences };
  let raw = Object.hasOwn(options, "rawPreferences") ? { value: options.rawPreferences } : undefined;
  let failRead = typeof options.preferences === "function";
  let failWrite = options.failNativeWrite === true;
  const writePreferences = vi.fn(async (patch: DesktopPreferences) => {
    if (failWrite) throw new Error("disk full");
    raw = undefined;
    preferences = {
      ...preferences,
      ...(patch.shortcutScheme ? { shortcutScheme: patch.shortcutScheme } : {}),
      ...(patch.shortcutOverrides ? { shortcutOverrides: { ...preferences.shortcutOverrides, ...patch.shortcutOverrides } } : {})
    };
    return { ...preferences };
  });
  const host: ShortcutDefaultMigrationHost = {
    storage,
    platform: options.platform ?? "macos",
    native: options.desktop === false ? undefined : {
      readPreferences: async () => {
        if (failRead) throw new Error("expected value at line 1 column 1");
        return raw ? raw.value as DesktopPreferences : { ...preferences };
      },
      writePreferences,
      hasToolbarLayout: async () => options.toolbarLayout === true
    }
  };
  return {
    host,
    storage,
    writePreferences,
    preferences: () => preferences,
    cache: () => JSON.parse(storage.getItem(KEYBINDING_STORAGE_KEY) ?? "null") as { scheme: string; overrides?: StoredShortcutOverrides } | null,
    heal: () => { failRead = false; failWrite = false; }
  };
}

afterEach(() => {
  resetShortcutDefaultMigrationForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("moving to the single shortcut set", () => {
  it("records the set for a fresh install, with no message", async () => {
    const fake = install();
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "fresh-install" });
    expect(fake.preferences().shortcutScheme).toBe("chemdraw");
    expect(fake.cache()).toEqual({ scheme: "chemdraw" });
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it("leaves an install already on the set alone and mirrors its custom keys", async () => {
    const overrides = { chemdraw: { commands: { "document.save": ["Mod+F9"] } } };
    const fake = install({ preferences: { shortcutScheme: "chemdraw", shortcutOverrides: overrides } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
    expect(fake.writePreferences).not.toHaveBeenCalled();
    expect(fake.cache()).toEqual({ scheme: "chemdraw", overrides });
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it("moves a retired-preset install, keeps its non-conflicting custom keys, and says so once", async () => {
    const legacy: ShortcutOverrides = {
      commands: { "tool.eraser": ["F6"], "view.toggleCrosshairs": ["Mod+F8"] },
      atom: { "atom.setHoveredElement.Br": ["D"] }
    };
    const fake = install({ preferences: { shortcutScheme: "chemdraft", shortcutOverrides: { chemdraft: legacy } } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "migrated", kept: 3, dropped: 0 });
    expect(fake.preferences().shortcutScheme).toBe("chemdraw");
    expect(fake.preferences().shortcutOverrides?.chemdraw).toEqual(legacy);
    // The retired preset's entry is left in place, unread.
    expect(fake.preferences().shortcutOverrides?.chemdraft).toEqual(legacy);
    expect(fake.cache()?.scheme).toBe("chemdraw");
    expect(fake.cache()?.overrides?.chemdraw).toEqual(legacy);

    const message = "Keyboard shortcuts now use one standard set. You can change any key in Preferences ▸ Keyboard.";
    expect(takeShortcutSetNotice(fake.storage)).toBe(message);
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
    expect(fake.storage.getItem(SHORTCUT_SET_NOTICE_SHOWN_KEY)).not.toBeNull();

    // The next launch finds the set recorded: nothing moves and nothing is said.
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it("drops custom keys another command in the set already uses, and keeps the rest", async () => {
    const legacy: ShortcutOverrides = {
      commands: {
        // E is the arrow tool in the set: dropped. F6 is free: kept.
        "tool.eraser": ["E", "F6"],
        // Mod+O is Open in the set: dropped, so Save keeps its own key.
        "document.save": ["Mod+O"],
        // F5 is reserved so it can never reload the webview: dropped.
        "view.toggleRulers": ["F5"],
        // A cleared key removed one of the retired preset's own keys; the set has no such key.
        "tool.lasso": []
      },
      // Over an atom, q is oxygen in the set: dropped.
      atom: { "atom.setHoveredElement.F": ["q"] }
    };
    const fake = install({ preferences: { shortcutScheme: "chemdraft", shortcutOverrides: { chemdraft: legacy } } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "migrated", kept: 1, dropped: 4 });
    expect(fake.preferences().shortcutOverrides?.chemdraw).toEqual({ commands: { "tool.eraser": ["F6"] } });
    const settings = loadKeybindingSettingsFrom(fake.storage);
    expect(settings.overrides?.chemdraw).toEqual({ commands: { "tool.eraser": ["F6"] } });
    expect(takeShortcutSetNotice(fake.storage)).toBe(SHORTCUT_SET_NOTICE);
  });

  it("decides conflicts for the platform it runs on", () => {
    // Ctrl+E is Export off macOS (the set's Ctrl+Cmd+E collapses to one Ctrl); on macOS it is free.
    const legacy: ShortcutOverrides = { commands: { "tool.eraser": ["Ctrl+E"] } };
    expect(mergeLegacyShortcutOverrides(legacy, undefined, "macos")).toEqual({
      overrides: { commands: { "tool.eraser": ["Ctrl+E"] } }, kept: 1, dropped: 0
    });
    expect(mergeLegacyShortcutOverrides(legacy, undefined, "windows")).toEqual({ overrides: {}, kept: 0, dropped: 1 });
  });

  it("keeps a customization the user already made in the set over the retired preset's", () => {
    const merged = mergeLegacyShortcutOverrides(
      { commands: { "tool.eraser": ["F6"], "document.save": ["Mod+F9"] }, atom: { "atom.setHoveredElement.Br": ["D"] } },
      { commands: { "tool.eraser": ["F10"] } },
      "windows"
    );
    expect(merged.overrides).toEqual({
      commands: { "tool.eraser": ["F10"], "document.save": ["Mod+F9"] },
      atom: { "atom.setHoveredElement.Br": ["D"] }
    });
    // Save's and Br's keys carried over; the eraser's was not counted, as the user had already set it.
    expect(merged.kept).toBe(2);
  });

  it("drops keys for hover actions the set has no table entry for", () => {
    // The retired preset had element keys for every one-letter element; the set has no K.
    const merged = mergeLegacyShortcutOverrides({ atom: { "atom.setHoveredElement.K": ["F"] } }, undefined, "macos");
    expect(merged).toEqual({ overrides: {}, kept: 0, dropped: 1 });
  });

  it("moves an install from before 1.2.3 that never named a preset, since the retired one was its default", async () => {
    const fake = install({ preferences: { guidedTourSeen: true }, toolbarLayout: true });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "migrated", kept: 0, dropped: 0 });
    expect(fake.preferences().shortcutScheme).toBe("chemdraw");
    expect(takeShortcutSetNotice(fake.storage)).toBe(SHORTCUT_SET_NOTICE);
  });

  it("moves the browser build from its cache alone", async () => {
    const legacy: ShortcutOverrides = { commands: { "tool.eraser": ["F6"] } };
    const fake = install({ desktop: false, local: { [KEYBINDING_STORAGE_KEY]: JSON.stringify({ scheme: "chemdraft", overrides: { chemdraft: legacy } }) } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "migrated", kept: 1, dropped: 0 });
    expect(fake.cache()).toEqual({ scheme: "chemdraw", overrides: { chemdraft: legacy, chemdraw: legacy } });
    expect(takeShortcutSetNotice(fake.storage)).toBeDefined();
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
  });

  it("writes nothing while the native preferences cannot be read, then moves on the next launch", async () => {
    const fake = install({ preferences: () => { throw new Error("unreachable"); }, local: { [KEYBINDING_STORAGE_KEY]: JSON.stringify({ scheme: "chemdraft" }) } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "preferences-unreadable" });
    expect(fake.writePreferences).not.toHaveBeenCalled();
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
    // Every window still runs on the one set meanwhile.
    expect(loadKeybindingSettingsFrom(fake.storage).scheme).toBe("chemdraw");
    fake.heal();
    expect((await migrateShortcutDefault(fake.host)).kind).toBe("migrated");
    expect(takeShortcutSetNotice(fake.storage)).toBeDefined();
  });

  it("shows the message once even when the native write failed and the move repeats", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = install({ preferences: { shortcutScheme: "chemdraft" }, failNativeWrite: true });
    expect((await migrateShortcutDefault(fake.host)).kind).toBe("migrated");
    expect(takeShortcutSetNotice(fake.storage)).toBeDefined();
    // The cache records the set; the next launch copies it to the native file without a message.
    expect(fake.cache()?.scheme).toBe("chemdraw");
    fake.heal();
    resetShortcutDefaultMigrationForTests();
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "migrated", kept: 0, dropped: 0 });
    expect(fake.preferences().shortcutScheme).toBe("chemdraw");
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it("still shows the message after a launch that exited before the status line showed it", async () => {
    const fake = install({ preferences: { shortcutScheme: "chemdraft" } });
    expect((await migrateShortcutDefault(fake.host)).kind).toBe("migrated");
    // The app quits here: the set is saved, but no window ever showed the message.
    resetShortcutDefaultMigrationForTests();
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
    expect(takeShortcutSetNotice(fake.storage)).toBe(SHORTCUT_SET_NOTICE);
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
    // Shown once, it never comes back, on this launch or any later one.
    resetShortcutDefaultMigrationForTests();
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it("keeps the pending message out of the existing-install evidence", async () => {
    // Only the message's own markers in the cache: nothing else says an install existed.
    const fake = install({ local: { [SHORTCUT_SET_NOTICE_PENDING_KEY]: "1" } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "fresh-install" });
  });

  it("shows the message this launch even when the cache cannot record it", async () => {
    const fake = install({ preferences: { shortcutScheme: "chemdraft" } });
    vi.spyOn(fake.storage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    expect((await migrateShortcutDefault(fake.host)).kind).toBe("migrated");
    expect(takeShortcutSetNotice(fake.storage)).toBe(SHORTCUT_SET_NOTICE);
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it("never shows the message twice, even if the pending marker cannot be cleared", async () => {
    const fake = install({ preferences: { shortcutScheme: "chemdraft" } });
    expect((await migrateShortcutDefault(fake.host)).kind).toBe("migrated");
    vi.spyOn(fake.storage, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(takeShortcutSetNotice(fake.storage)).toBe(SHORTCUT_SET_NOTICE);
    resetShortcutDefaultMigrationForTests();
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it.each([
    ["an unknown scheme and malformed keys", { shortcutScheme: "vim", shortcutOverrides: { chemdraft: { commands: { "tool.eraser": "F6" } } } }],
    ["non-object preferences", "nonsense"],
    ["null preferences", null],
    ["array preferences", ["chemdraw"]]
  ])("never throws on %s", async (_label, preferences) => {
    const fake = install({ rawPreferences: preferences, local: { [KEYBINDING_STORAGE_KEY]: "{not json" } });
    // The read hands the value over exactly as stored, not a copy the harness reshaped.
    expect(await fake.host.native?.readPreferences()).toBe(preferences);
    const outcome = await migrateShortcutDefault(fake.host);
    // The unreadable cache is still evidence of an earlier install.
    expect(outcome.kind).toBe("migrated");
    expect(fake.preferences().shortcutScheme).toBe("chemdraw");
    expect(loadKeybindingSettingsFrom(fake.storage)).toEqual({ scheme: "chemdraw" });
  });

  it.each([
    ["a string", "nonsense"],
    ["null", null],
    ["an empty array", []],
    ["an array", ["chemdraw", { shortcutScheme: "chemdraft" }]],
    ["a number", 7]
  ])("treats native preferences that are %s as holding nothing", async (_label, preferences) => {
    const fake = install({ rawPreferences: preferences });
    expect(await fake.host.native?.readPreferences()).toBe(preferences);
    // No key of a string or an array is a stored preference, so with nothing else stored this is a fresh install.
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "fresh-install" });
    expect(fake.writePreferences).toHaveBeenCalledWith({ shortcutScheme: "chemdraw" });
    expect(fake.cache()).toEqual({ scheme: "chemdraw" });
    expect(takeShortcutSetNotice(fake.storage)).toBeUndefined();
  });

  it("removes the 1.2.3 release candidates' leftover marker", async () => {
    const fake = install({ local: { [PENDING_FRESH_INSTALL_KEY]: "1" } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "fresh-install" });
    expect(fake.storage.getItem(PENDING_FRESH_INSTALL_KEY)).toBeNull();
  });

  it("words the message exactly as the owner asked, the same on every platform", () => {
    expect(SHORTCUT_SET_NOTICE).toBe("Keyboard shortcuts now use one standard set. You can change any key in Preferences ▸ Keyboard.");
    expect(SHORTCUT_SET_NOTICE).not.toMatch(/chemdraw|classic|preset/i);
  });
});

describe("keeping every valid custom key when the two stores disagree", () => {
  const custom: ShortcutOverrides = { commands: { "document.save": ["Mod+F9"] } };
  const cacheOf = (overrides: unknown, scheme = "chemdraw") => JSON.stringify({ scheme, overrides });
  const cases: {
    name: string;
    native: unknown;
    cache: string;
    current: ShortcutOverrides;
    retired?: ShortcutOverrides;
  }[] = [
    { name: "the native map is empty and the cache has a custom key", native: {}, cache: cacheOf({ chemdraw: custom }), current: custom },
    {
      name: "the native map holds only retired-preset keys and the cache has a custom key",
      native: { chemdraft: { commands: { "tool.eraser": ["F6"] } } },
      cache: cacheOf({ chemdraw: custom }),
      current: custom,
      // Moving from the retired preset also carries its free key into the set.
      retired: { commands: { "document.save": ["Mod+F9"], "tool.eraser": ["F6"] } }
    },
    {
      name: "both stores have custom keys and one cached entry collides",
      native: { chemdraw: custom },
      // Save is the native file's (Mod+F9) and stays; Rulers' Mod+F9 would collide with it; F6 is free.
      cache: cacheOf({ chemdraw: { commands: { "document.save": ["Mod+F10"], "view.toggleRulers": ["Mod+F9"], "tool.eraser": ["F6"] } } }),
      current: { commands: { "document.save": ["Mod+F9"], "tool.eraser": ["F6"] } }
    },
    {
      name: "the native map has corrupt entries",
      native: { chemdraw: { commands: { "document.save": "F6", "not a command": ["F8"], "tool.eraser": ["F7"] }, other: {} } },
      cache: cacheOf({ chemdraw: custom }),
      current: { commands: { "document.save": ["Mod+F9"], "tool.eraser": ["F7"] } }
    },
    { name: "the native map is not a map", native: "nonsense", cache: cacheOf({ chemdraw: custom }), current: custom },
    { name: "the cache is not JSON", native: { chemdraw: custom }, cache: "{not json", current: custom },
    {
      name: "the cache has corrupt entries",
      native: {},
      cache: cacheOf({ chemdraw: { commands: { "document.save": ["Mod+F9"], "tool.eraser": "F6" }, atom: [] }, vim: {} }),
      current: custom
    }
  ];

  describe.each([
    ["already on the set", "chemdraw", "current"],
    ["moving from the retired preset", "chemdraft", "migrated"]
  ] as const)("%s", (_path, shortcutScheme, kind) => {
    it.each(cases)("$name", async ({ native, cache, current, retired }) => {
      const expected = kind === "migrated" ? retired ?? current : current;
      const fake = install({
        preferences: { shortcutScheme, shortcutOverrides: native } as unknown as DesktopPreferences,
        local: { [KEYBINDING_STORAGE_KEY]: cache }
      });
      expect((await migrateShortcutDefault(fake.host)).kind).toBe(kind);
      // Both stores end with every valid customization, and the webview applies it.
      expect(fake.preferences().shortcutScheme).toBe("chemdraw");
      expect(fake.preferences().shortcutOverrides?.chemdraw).toEqual(expected);
      expect(fake.cache()?.overrides?.chemdraw).toEqual(expected);
      expect(loadKeybindingSettingsFrom(fake.storage).overrides?.chemdraw).toEqual(expected);
      // A second launch finds both stores agreeing and writes nothing.
      fake.writePreferences.mockClear();
      expect((await migrateShortcutDefault(fake.host)).kind).toBe("current");
      expect(fake.writePreferences).not.toHaveBeenCalled();
      expect(fake.cache()?.overrides?.chemdraw).toEqual(expected);
    });
  });

  it("keeps the retired preset's stored keys in both stores, unread", async () => {
    const legacy = { commands: { "tool.eraser": ["F6"] } };
    const fake = install({
      preferences: { shortcutScheme: "chemdraw", shortcutOverrides: { chemdraft: legacy } },
      local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: custom }) }
    });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
    expect(fake.preferences().shortcutOverrides).toEqual({ chemdraft: legacy, chemdraw: custom });
    expect(fake.cache()).toEqual({ scheme: "chemdraw", overrides: { chemdraft: legacy, chemdraw: custom } });
  });

  it("copies the cache's custom keys with the set when only the cache names it", async () => {
    const fake = install({ preferences: { shortcutOverrides: {} }, local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: custom }) } });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
    expect(fake.preferences()).toEqual({ shortcutScheme: "chemdraw", shortcutOverrides: { chemdraw: custom } });
    expect(fake.cache()).toEqual({ scheme: "chemdraw", overrides: { chemdraw: custom } });
  });

  describe("marking custom keys the native file could not save", () => {
    const cacheOnly: ShortcutOverrides = { commands: { "document.save": ["Mod+F9"], "tool.eraser": ["F6"] } };

    it.each([
      ["already on the set", { shortcutScheme: "chemdraw", shortcutOverrides: { chemdraw: custom } }],
      ["named in the cache only", { shortcutOverrides: { chemdraw: custom } }],
      ["moving from the retired preset", { shortcutScheme: "chemdraft", shortcutOverrides: { chemdraw: custom } }]
    ] as const)("marks them when %s and the write fails, and clears the mark once a launch saves them", async (_label, preferences) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fake = install({
        preferences: preferences as DesktopPreferences,
        local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: cacheOnly }) },
        failNativeWrite: true
      });
      await migrateShortcutDefault(fake.host);
      expect(fake.cache()?.overrides?.chemdraw).toEqual(cacheOnly);
      expect(fake.storage.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY)).not.toBeNull();
      fake.heal();
      // (Moving from the retired preset repeats, since the native file still names it.)
      await migrateShortcutDefault(fake.host);
      expect(fake.preferences().shortcutScheme).toBe("chemdraw");
      expect(fake.preferences().shortcutOverrides?.chemdraw).toEqual(cacheOnly);
      expect(fake.storage.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY)).toBeNull();
    });

    it("clears a mark left behind once the stores agree", async () => {
      const fake = install({
        preferences: { shortcutScheme: "chemdraw", shortcutOverrides: { chemdraw: custom } },
        local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: custom }), [UNSAVED_SHORTCUTS_STORAGE_KEY]: "1" }
      });
      expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
      expect(fake.writePreferences).not.toHaveBeenCalled();
      expect(fake.storage.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY)).toBeNull();
    });

    it("does not mark when only the set's id failed to save, since the native file has every key", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fake = install({
        preferences: { shortcutScheme: "chemdraft", shortcutOverrides: { chemdraw: custom } },
        local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: custom }, "chemdraft") },
        failNativeWrite: true
      });
      expect((await migrateShortcutDefault(fake.host)).kind).toBe("migrated");
      expect(fake.writePreferences).toHaveBeenCalledWith({ shortcutScheme: "chemdraw" });
      expect(fake.storage.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY)).toBeNull();
    });

    it("does not mark when the cache could not take the keys either", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fake = install({
        preferences: { shortcutScheme: "chemdraw", shortcutOverrides: { chemdraw: custom } },
        local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: cacheOnly }, "chemdraft") },
        failNativeWrite: true
      });
      // The combined keys reach neither store, so the cache's older copy must not be taken for the user's.
      const setItem = fake.storage.setItem.bind(fake.storage);
      vi.spyOn(fake.storage, "setItem").mockImplementation((key, value) => {
        if (key === KEYBINDING_STORAGE_KEY) throw new Error("QuotaExceededError");
        setItem(key, value);
      });
      await migrateShortcutDefault(fake.host);
      expect(fake.storage.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY)).toBeNull();
    });

    it("leaves the browser build, which has no native file, unmarked", async () => {
      const fake = install({ desktop: false, local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: cacheOnly }) } });
      expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
      expect(fake.storage.getItem(UNSAVED_SHORTCUTS_STORAGE_KEY)).toBeNull();
    });
  });

  it("does not rewrite a native map whose only difference is an empty scope", async () => {
    const fake = install({
      preferences: { shortcutScheme: "chemdraw", shortcutOverrides: { chemdraw: { ...custom, atom: {} } } },
      local: { [KEYBINDING_STORAGE_KEY]: cacheOf({ chemdraw: custom }) }
    });
    expect(await migrateShortcutDefault(fake.host)).toEqual({ kind: "current" });
    expect(fake.writePreferences).not.toHaveBeenCalled();
  });

  it("combines entries without depending on their order, and drops only colliding ones", () => {
    const merged = mergeStoredShortcutOverrides(
      { commands: { "tool.eraser": ["F6"] } },
      {
        commands: {
          // Save takes Open's key because Open moved off it: both are kept.
          "document.save": ["Mod+O"],
          "document.open": ["Mod+Shift+F9"],
          // A cleared key never collides.
          "tool.lasso": [],
          // F6 is the native file's eraser key: dropped.
          "view.toggleRulers": ["F6"],
          // A locked system action: dropped.
          "app.quit": ["Mod+F11"],
          // A command this platform does not list: kept as stored.
          "plugin.example.run": ["Mod+F12"]
        }
      },
      "macos"
    );
    expect(merged.overrides).toEqual({
      commands: {
        "tool.eraser": ["F6"],
        "document.save": ["Mod+O"],
        "document.open": ["Mod+Shift+F9"],
        "tool.lasso": [],
        "plugin.example.run": ["Mod+F12"]
      }
    });
    expect(merged.dropped).toBe(2);
  });

  it("drops a kept entry whose key a dropped entry gives back to its command", () => {
    // Open's cached Mod+F9 collides with the native Save; dropping it gives Open its Mod+O back, so the
    // cached Rulers entry that took Mod+O can no longer stay either.
    const merged = mergeStoredShortcutOverrides(
      { commands: { "document.save": ["Mod+F9"] } },
      { commands: { "view.toggleRulers": ["Mod+O"], "document.open": ["Mod+F9"] } },
      "macos"
    );
    expect(merged).toEqual({ overrides: { commands: { "document.save": ["Mod+F9"] } }, dropped: 2 });
  });
});

/** loadKeybindingSettings reads globalThis.localStorage; point it at a fake install's storage. */
function loadKeybindingSettingsFrom(storage: Storage) {
  vi.stubGlobal("localStorage", storage);
  return loadKeybindingSettings();
}
