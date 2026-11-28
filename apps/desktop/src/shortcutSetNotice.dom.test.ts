// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import { KEYBINDING_STORAGE_KEY } from "./keybindingSettings";
import {
  migrateShortcutDefault,
  resetShortcutDefaultMigrationForTests,
  SHORTCUT_SET_NOTICE,
  SHORTCUT_SET_NOTICE_PENDING_KEY,
  SHORTCUT_SET_NOTICE_SHOWN_KEY
} from "./shortcutDefaultMigration";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The one-time move to the single shortcut set (shortcutDefaultMigration.ts) runs before the document
// window mounts (App.tsx). This pins the last step: the window shows the move's message in the status
// line once, and a later window never repeats it.
describe("the single shortcut set's upgrade message", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let localStorage: Storage;

  beforeEach(() => {
    localStorage = new MemoryStorage();
    vi.stubGlobal("localStorage", localStorage);
    resetShortcutDefaultMigrationForTests();
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
    resetShortcutDefaultMigrationForTests();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

  /** Mount and commit the window synchronously, then return before any later task runs. */
  function mountWithoutWaiting(): string | null | undefined {
    if (root) act(() => root!.unmount());
    root = createRoot(container);
    act(() => {
      root!.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: false
      }));
    });
    return container.querySelector("[data-status-message]")?.textContent;
  }

  async function mount(): Promise<string | null | undefined> {
    if (root) act(() => root!.unmount());
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(MainWindow, {
        initialActiveToolCommandId: "tool.bond",
        initialCrosshairsVisible: false,
        initialPaletteMode: "hidden",
        initialRulersVisible: false,
        nativePalette: false
      }));
    });
    // The window posts the message on the next task, after its own startup status.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    return container.querySelector("[data-status-message]")?.textContent;
  }

  it("shows the message once after an install on the retired preset moves", async () => {
    localStorage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraft" }));
    expect((await migrateShortcutDefault({ storage: localStorage })).kind).toBe("migrated");
    expect(await mount()).toBe(SHORTCUT_SET_NOTICE);

    // The next launch finds the set recorded: nothing moves and the message is not repeated.
    resetShortcutDefaultMigrationForTests();
    expect((await migrateShortcutDefault({ storage: localStorage })).kind).toBe("current");
    expect(await mount()).not.toBe(SHORTCUT_SET_NOTICE);
  });

  it("still shows the message once after a launch that quit before the status line showed it", async () => {
    localStorage.setItem(KEYBINDING_STORAGE_KEY, JSON.stringify({ scheme: "chemdraft" }));
    expect((await migrateShortcutDefault({ storage: localStorage })).kind).toBe("migrated");
    // The window has mounted, but the app quits before its status line shows the message.
    expect(mountWithoutWaiting()).not.toBe(SHORTCUT_SET_NOTICE);
    expect(localStorage.getItem(SHORTCUT_SET_NOTICE_SHOWN_KEY)).toBeNull();
    act(() => root!.unmount());
    root = undefined;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(localStorage.getItem(SHORTCUT_SET_NOTICE_SHOWN_KEY)).toBeNull();
    expect(localStorage.getItem(SHORTCUT_SET_NOTICE_PENDING_KEY)).not.toBeNull();

    // The next launch shows it, and records it as shown only then.
    resetShortcutDefaultMigrationForTests();
    expect((await migrateShortcutDefault({ storage: localStorage })).kind).toBe("current");
    expect(await mount()).toBe(SHORTCUT_SET_NOTICE);
    expect(localStorage.getItem(SHORTCUT_SET_NOTICE_SHOWN_KEY)).not.toBeNull();
    expect(localStorage.getItem(SHORTCUT_SET_NOTICE_PENDING_KEY)).toBeNull();

    // Never again: not in another window this launch, nor on a later launch.
    expect(await mount()).not.toBe(SHORTCUT_SET_NOTICE);
    resetShortcutDefaultMigrationForTests();
    expect((await migrateShortcutDefault({ storage: localStorage })).kind).toBe("current");
    expect(await mount()).not.toBe(SHORTCUT_SET_NOTICE);
  });

  it("says nothing to a fresh install", async () => {
    expect((await migrateShortcutDefault({ storage: localStorage })).kind).toBe("fresh-install");
    expect(await mount()).not.toBe(SHORTCUT_SET_NOTICE);
  });
});
