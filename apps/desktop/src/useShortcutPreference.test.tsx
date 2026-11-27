// @vitest-environment jsdom
// A window's shortcut settings start from the webview cache and then take the native preferences
// file's custom keys. When the move to the single set could not save a cache-only custom key to the
// native file, that key must stay pending (and be saved later), not be dropped by the window's first
// read of the native file; explicit edits and removals in Preferences still take effect.
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
  listeners: new Set<(settings: KeybindingSettings) => void>()
}));
vi.mock("./desktopPreferences", () => ({
  desktopPreferences: async (patch?: DesktopPreferences) => {
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
}));
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
/** A custom key only the webview cache holds. */
const cacheOnly: ShortcutOverrides = { commands: { "document.save": ["Mod+F9"], "tool.eraser": ["F6"] } };

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
  native.listeners.clear();
  latest = undefined;
  storage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraw", overrides: { chemdraw: cacheOnly } }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  resetShortcutDefaultMigrationForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a custom key the native file has not saved yet", () => {
  it("is saved to the native file by the first window once it can write, and never dropped", async () => {
    native.failWrite = true;
    expect(await launch()).toEqual({ kind: "current" });
    expect(nativeSetKeys()).toEqual(nativeKeys);
    expect(cachedSetKeys()).toEqual(cacheOnly);

    native.failWrite = false;
    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(cacheOnly);
    expect(cachedSetKeys()).toEqual(cacheOnly);
    expect(nativeSetKeys()).toEqual(cacheOnly);

    // Saved once: the next window reads the native file and writes nothing.
    native.writes = [];
    await openWindow();
    expect(native.writes).toEqual([]);
    expect(latest?.overrides?.chemdraw).toEqual(cacheOnly);
  });

  it("stays in the cache and in use while the native file still cannot be written", async () => {
    native.failWrite = true;
    await launch();
    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(cacheOnly);
    expect(cachedSetKeys()).toEqual(cacheOnly);
    await openWindow();
    expect(cachedSetKeys()).toEqual(cacheOnly);

    // The next launch that can write saves it, and windows then read it back from the native file.
    native.failWrite = false;
    expect(await launch()).toEqual({ kind: "current" });
    expect(nativeSetKeys()).toEqual(cacheOnly);
    native.writes = [];
    await openWindow();
    expect(native.writes).toEqual([]);
    expect(latest?.overrides?.chemdraw).toEqual(cacheOnly);
  });

  it("can still be removed in Preferences, and does not come back", async () => {
    native.failWrite = true;
    await launch();
    await openWindow();
    native.failWrite = false;

    // The user removes the cache-only key: the edit carries the set's whole map without it.
    await act(async () => { await updateShortcutPreference(nativeKeys); });
    expect(nativeSetKeys()).toEqual(nativeKeys);
    expect(cachedSetKeys()).toEqual(nativeKeys);
    expect(latest?.overrides?.chemdraw).toEqual(nativeKeys);

    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(nativeKeys);
    expect(cachedSetKeys()).toEqual(nativeKeys);
    expect(await launch()).toEqual({ kind: "current" });
    expect(nativeSetKeys()).toEqual(nativeKeys);
    expect(cachedSetKeys()).toEqual(nativeKeys);
  });

  it("lets an edit in Preferences win over the pending keys", async () => {
    native.failWrite = true;
    await launch();
    native.failWrite = false;
    const edited: ShortcutOverrides = { commands: { "document.save": ["Mod+F10"], "tool.eraser": ["F6"] } };
    await updateShortcutPreference(edited);
    expect(nativeSetKeys()).toEqual(edited);
    await openWindow();
    expect(latest?.overrides?.chemdraw).toEqual(edited);
    expect(nativeSetKeys()).toEqual(edited);
  });
});

describe("a window's first read of the native file", () => {
  it("takes the native file's custom keys when nothing is pending", async () => {
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
});
