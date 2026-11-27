// @vitest-environment jsdom
// A window's shortcut settings start from the webview cache and then take the native preferences
// file's custom keys, once that file names the single set. When the move to the single set could not
// write the native file, both stores stay as they were: no window writes the native file in the
// background, a cache-only custom key is neither dropped nor saved behind the user's back, and the
// next launch makes the move again. Explicit edits and removals in Preferences always take effect.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutOverrides } from "@chemdraft/shortcut-engine";
import type { DesktopPreferences } from "./desktopPreferences";
import type { KeybindingSettings } from "./keybindingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

/** The native preferences.json, patched the way lib.rs `apply_patch` does. */
const native = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
  failWrite: false,
  failRead: false,
  writes: [] as unknown[],
  /** When set, the next call waits for `release()`; a read answers with the file as it was when called. */
  holdNext: false,
  held: [] as (() => void)[],
  listeners: new Set<(settings: KeybindingSettings) => void>()
}));
vi.mock("./desktopPreferences", () => ({
  desktopPreferences: async (patch?: DesktopPreferences) => {
    if (native.holdNext) {
      native.holdNext = false;
      const asCalled = JSON.parse(JSON.stringify(native.preferences)) as DesktopPreferences;
      return new Promise<DesktopPreferences>((resolve, reject) => {
        native.held.push(() => {
          try {
            resolve(patch ? apply(patch) : asCalled);
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    return apply(patch);
  }
}));
/** One call to the native file, as lib.rs answers it. */
function apply(patch?: DesktopPreferences): DesktopPreferences {
  if (native.failRead) throw new Error("expected value at line 1 column 1");
  if (patch) {
    native.writes.push(JSON.parse(JSON.stringify(patch)));
    if (native.failWrite) throw new Error("disk full");
    native.preferences = {
      ...native.preferences,
      ...(patch.shortcutScheme ? { shortcutScheme: patch.shortcutScheme } : {}),
      ...(patch.shortcutOverrides ? {
        shortcutOverrides: { ...(native.preferences.shortcutOverrides as object | undefined), ...patch.shortcutOverrides }
      } : {})
    };
  }
  return JSON.parse(JSON.stringify(native.preferences)) as DesktopPreferences;
}
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  // Tauri's emit reaches every window, the sender included.
  listenForKeybindingSettings: async (handler: (settings: KeybindingSettings) => void) => {
    native.listeners.add(handler);
    return () => { native.listeners.delete(handler); };
  },
  broadcastKeybindingSettings: async (settings: KeybindingSettings) => {
    native.listeners.forEach(listener => listener(JSON.parse(JSON.stringify(settings)) as KeybindingSettings));
  }
}));

// The move loads the command table on demand; load it with the file so no test pays for it.
import "./customKeyboardShortcuts";
import { desktopPreferences } from "./desktopPreferences";
import { KEYBINDING_STORAGE_KEY, loadKeybindingSettings } from "./keybindingSettings";
import { migrateShortcutDefault, resetShortcutDefaultMigrationForTests } from "./shortcutDefaultMigration";
import { updateShortcutPreference, useShortcutPreference } from "./useShortcutPreference";

const nativeKeys: ShortcutOverrides = { commands: { "document.save": ["Mod+F9"] } };
/** The cache's custom keys: the native file's, and one only the cache holds. */
const cacheOnly: ShortcutOverrides = { commands: { "document.save": ["Mod+F9"], "tool.eraser": ["F6"] } };
/** The retired preset's custom key, carried into the set when the install moves. */
const legacy: ShortcutOverrides = { commands: { "view.toggleCrosshairs": ["Mod+F8"] } };
/** Everything the move combines from both stores. */
const combined: ShortcutOverrides = { commands: { ...cacheOnly.commands, ...legacy.commands } };

let storage: MemoryStorage;
let roots: Root[] = [];
let latest: KeybindingSettings | undefined;

function Probe() {
  latest = useShortcutPreference();
  return null;
}

/** Mount one window and let its first read of the native file finish. */
async function openWindow(): Promise<void> {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => { root.render(createElement(Probe)); });
  await settle();
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

/** A launch: the real move to the single set, against the fake native file and this cache. */
async function launch() {
  resetShortcutDefaultMigrationForTests();
  return migrateShortcutDefault({
    storage,
    platform: "macos",
    native: {
      readPreferences: () => desktopPreferences(),
      writePreferences: patch => desktopPreferences(patch),
      hasToolbarLayout: async () => true
    }
  });
}

/** Let every held native call answer, in the order they were made. */
async function release(): Promise<void> {
  const held = native.held.splice(0);
  await act(async () => { held.forEach(answer => answer()); });
  await settle();
}

/** An install still on the retired preset, whose cache holds a custom key the native file lacks. */
function retiredInstall(): void {
  native.preferences = { shortcutScheme: "chemdraft", shortcutOverrides: { chemdraft: legacy, chemdraw: nativeKeys } };
  storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraft", overrides: { chemdraw: cacheOnly } }));
}

const nativeSetKeys = () => (native.preferences.shortcutOverrides as Record<string, unknown> | undefined)?.chemdraw;
const cachedSetKeys = () => loadKeybindingSettings().overrides?.chemdraw;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  native.preferences = { shortcutScheme: "chemdraw", shortcutOverrides: { chemdraw: nativeKeys } };
  native.failWrite = false;
  native.failRead = false;
  native.writes = [];
  native.holdNext = false;
  native.held = [];
  native.listeners.clear();
  latest = undefined;
  storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraw", overrides: { chemdraw: cacheOnly } }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  native.held.splice(0).forEach(answer => answer());
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  resetShortcutDefaultMigrationForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a launch whose native write fails", () => {
  it("leaves both stores as they were, lets no window write, and the next launch saves the combined keys", async () => {
    retiredInstall();
    const before = { preferences: JSON.parse(JSON.stringify(native.preferences)) as unknown, cache: storage.getItem(KEYBINDING_STORAGE_KEY) };
    native.failWrite = true;
    expect((await launch()).kind).toBe("migrated");
    expect(native.preferences).toEqual(before.preferences);
    expect(storage.getItem(KEYBINDING_STORAGE_KEY)).toBe(before.cache);

    // Windows run on the cache's keys, the cache-only one included, and never write the native file.
    const writes = native.writes.length;
    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(cacheOnly);
    native.failWrite = false;
    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(cacheOnly);
    expect(native.writes.length).toBe(writes);
    expect(native.preferences).toEqual(before.preferences);
    expect(storage.getItem(KEYBINDING_STORAGE_KEY)).toBe(before.cache);

    // The next launch can write: it makes the same move from the same stores, and nothing is lost.
    expect((await launch()).kind).toBe("migrated");
    expect(native.preferences.shortcutScheme).toBe("chemdraw");
    expect(nativeSetKeys()).toEqual(combined);
    expect(cachedSetKeys()).toEqual(combined);
    native.writes = [];
    await openWindow();
    expect(native.writes).toEqual([]);
    expect(latest?.overrides?.chemdraw).toEqual(combined);
  });

  it("never brings back a key the user removed in Preferences meanwhile", async () => {
    retiredInstall();
    native.failWrite = true;
    await launch();
    await openWindow();
    native.failWrite = false;
    // The user clears every custom key the window shows: the edit is the set's whole map, now empty.
    const seen = Object.keys(latest?.overrides?.chemdraw?.commands ?? {});
    expect(seen.length).toBeGreaterThan(0);
    await act(async () => { await updateShortcutPreference({}); });
    expect(nativeSetKeys()).toEqual({});
    expect(latest?.overrides?.chemdraw).toEqual({});

    // The next launch makes the move; none of the keys the user removed comes back.
    expect((await launch()).kind).toBe("migrated");
    for (const id of seen) {
      expect((nativeSetKeys() as ShortcutOverrides | undefined)?.commands?.[id]).toBeUndefined();
      expect(cachedSetKeys()?.commands?.[id]).toBeUndefined();
    }
    await openWindow();
    for (const id of seen) expect(latest?.overrides?.chemdraw?.commands?.[id]).toBeUndefined();
  });

  it("keeps an edit in Preferences when a window's earlier call to the native file answers after it", async () => {
    retiredInstall();
    native.failWrite = true;
    await launch();
    native.failWrite = false;

    // A window starts its first call to the native file, which answers only after the edit below.
    native.holdNext = true;
    await openWindow();
    expect(native.held).toHaveLength(1);
    const edited: ShortcutOverrides = { commands: { "document.save": ["Mod+F10"] } };
    await act(async () => { await updateShortcutPreference(edited); });
    expect(nativeSetKeys()).toEqual(edited);
    await release();

    expect(nativeSetKeys()).toEqual(edited);
    expect(cachedSetKeys()).toEqual(edited);
    expect(latest?.overrides?.chemdraw).toEqual(edited);
    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(edited);
  });
});

describe("a window's first read of the native file", () => {
  it("takes the native file's custom keys once it names the set", async () => {
    // Both stores agreed at launch; another build later changed the native file.
    storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraw", overrides: { chemdraw: nativeKeys } }));
    await launch();
    const changed: ShortcutOverrides = { commands: { "document.save": ["Mod+F11"] } };
    native.preferences = { shortcutScheme: "chemdraw", shortcutOverrides: { chemdraw: changed } };
    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(changed);
    expect(cachedSetKeys()).toEqual(changed);
    expect(native.writes).toEqual([]);
  });

  it("never replaces an edit that reached the window first, even with the older map", async () => {
    storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraw", overrides: { chemdraw: nativeKeys } }));
    await launch();
    native.holdNext = true;
    await openWindow();
    const edited: ShortcutOverrides = { commands: { "document.save": ["Mod+F10"] } };
    await act(async () => { await updateShortcutPreference(edited); });
    // The read answers with the native file as it was before the edit.
    await release();
    expect(latest?.overrides?.chemdraw).toEqual(edited);
    expect(cachedSetKeys()).toEqual(edited);
    expect(nativeSetKeys()).toEqual(edited);
  });
});
