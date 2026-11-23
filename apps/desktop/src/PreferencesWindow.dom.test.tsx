// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadKeybindingSettings, saveKeybindingSettings, type KeybindingSettings } from "./keybindingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

const host = vi.hoisted(() => ({ desktop: true, invoke: vi.fn(), measure: vi.fn(), observe: vi.fn(), stopObserving: vi.fn(), settingsListeners: new Set<(settings: KeybindingSettings) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke, isTauri: () => false }));
vi.mock("./dialogs/dialogContentFit", () => ({ measureDialogContentWhenFontsReady: host.measure, observeDialogContent: host.observe }));
vi.mock("./window-manager", () => ({
  isDesktopRuntime: () => host.desktop,
  listenForDrawingSettings: async () => () => {},
  broadcastCompoundLayoutSettings: vi.fn(),
  listenForKeybindingSettings: async (handler: (settings: KeybindingSettings) => void) => {
    host.settingsListeners.add(handler);
    return () => { host.settingsListeners.delete(handler); };
  },
  broadcastKeybindingSettings: async (settings: KeybindingSettings) => {
    host.settingsListeners.forEach(listener => listener(settings));
  },
  broadcastSpin3dSettings: vi.fn(), broadcastQuitSettings: vi.fn(), broadcastExportPreviewSettings: vi.fn()
}));
import { PreferencesWindow } from "./PreferencesWindow";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  host.desktop = true;
  host.invoke.mockReset().mockResolvedValue(undefined);
  host.measure.mockReset().mockResolvedValue({ contentHeight: 1655, pixelRatio: 1.5 });
  host.observe.mockReset().mockReturnValue(host.stopObserving);
  host.stopObserving.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("reports the shared content measurement once after StrictMode commits", async () => {
  await act(async () => root.render(createElement(StrictMode, null, createElement(PreferencesWindow))));
  expect(host.measure).toHaveBeenCalledWith(container.querySelector(".preferences-shell"));
  expect(host.invoke).toHaveBeenCalledExactlyOnceWith("preferences_ready", {
    data: { contentHeight: 1655, pixelRatio: 1.5 }
  });
  expect(container.querySelector(".preferences-shell > .cd-dialog-fit-body")).not.toBeNull();
});

it("uses the native fallback size when content cannot be measured", async () => {
  host.measure.mockResolvedValue(undefined);
  await act(async () => root.render(createElement(PreferencesWindow)));
  expect(host.invoke).toHaveBeenCalledExactlyOnceWith("preferences_ready", { data: {} });
});

it("shares live content fitting without revealing again and tears down its observer", async () => {
  await act(async () => root.render(createElement(PreferencesWindow)));
  expect(host.observe).toHaveBeenCalledWith(container.querySelector(".preferences-shell"),
    { contentHeight: 1655, pixelRatio: 1.5 }, expect.any(Function));
  await act(async () => host.observe.mock.calls[0][2]({ contentHeight: 1680, pixelRatio: 1.5 }));
  expect(host.invoke).toHaveBeenLastCalledWith("preferences_ready", { data: { contentHeight: 1680, pixelRatio: 1.5 } });
  act(() => root.unmount());
  expect(host.stopObserving).toHaveBeenCalledOnce();
});

it("keeps browser Preferences free of native sizing calls", async () => {
  host.desktop = false;
  await act(async () => root.render(createElement(PreferencesWindow)));
  expect(host.measure).not.toHaveBeenCalled();
  expect(host.invoke).not.toHaveBeenCalled();
});

it("does not reveal a closed Preferences window after fonts settle", async () => {
  let finish!: (value: { contentHeight: number; pixelRatio: number }) => void;
  host.measure.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(createElement(PreferencesWindow)));
  act(() => root.unmount());
  await act(async () => finish({ contentHeight: 1655, pixelRatio: 2 }));
  expect(host.invoke).not.toHaveBeenCalled();
});

describe.each(["macos", "windows"] as const)("Keyboard Preferences (%s)", platform => {
  let originalPlatform: PropertyDescriptor;
  beforeEach(() => {
    host.desktop = false;
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform")!;
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
  });
  afterEach(() => {
    Object.defineProperty(navigator, "platform", originalPlatform);
    history.replaceState(null, "", "/");
  });

  async function mountKeyboard() {
    history.replaceState(null, "", "/?window=preferences#keyboard");
    await act(async () => root.render(createElement(PreferencesWindow)));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search shortcuts");
  }

  const row = (title: string) => [...container.querySelectorAll(".preferences-shortcut-list li")].find(el =>
    el.querySelector("strong")?.textContent === title)!;
  const keyButton = (title: string) => row(title).querySelector("button")!;
  const click = async (button: HTMLButtonElement | HTMLInputElement) => {
    await act(async () => { button.focus(); button.click(); });
  };
  const button = (title: string) => [...container.querySelectorAll("button")].find(el => el.textContent?.trim() === title)!;
  const press = async (init: KeyboardEventInit, capsLock = false) => {
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    vi.spyOn(event, "getModifierState").mockImplementation(modifier => modifier === "CapsLock" && capsLock);
    await act(async () => { document.activeElement?.dispatchEvent(event); });
  };

  it("searches, assigns, cancels and replaces conflicts, clears, resets and keeps separate schemes", async () => {
    await mountKeyboard();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search shortcuts"]')!;
    const searchFor = async (query: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, query);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await searchFor("save");
    expect(row("Save")).toBeDefined();
    expect(row("Open…")).toBeUndefined();
    await searchFor("");
    const mod = platform === "macos" ? { metaKey: true } : { ctrlKey: true };
    const display = (key: string) => (platform === "macos" ? "⌘" : "Ctrl+") + key;
    await click(keyButton("Save"));
    await press({ key: "F5", code: "F5" });
    expect(container.textContent).toContain("Reserved to prevent the webview from reloading");
    await press({ key: "q", code: "KeyQ", ...mod });
    expect(container.textContent).toContain("Reserved for Quit and Close Window");
    await press({ key: "o", code: "KeyO", ...mod });
    expect(container.querySelector('[aria-label="Shortcut conflict"]')?.textContent).toContain("Open…");
    await click(button("Cancel"));
    expect(keyButton("Save").textContent).toBe(display("S"));
    await click(keyButton("Save"));
    await press({ key: "o", code: "KeyO", ...mod });
    await click(button("Replace"));
    expect(keyButton("Save").textContent).toBe(display("O"));
    expect(keyButton("Open…").textContent).toBe("Unassigned");
    await click(row("Save").querySelector<HTMLButtonElement>('[aria-label="Clear Save"]')!);
    expect(keyButton("Save").textContent).toBe("Unassigned");
    await click(row("Save").querySelector<HTMLButtonElement>('[aria-label="Reset Save"]')!);
    expect(keyButton("Save").textContent).toBe(display("S"));
    await click(container.querySelector<HTMLInputElement>('input[name="keybinding-scheme"][value="chemdraw"]')!);
    expect(keyButton("Open…").textContent).toBe(display("O"));
    await click(container.querySelector<HTMLInputElement>('input[name="keybinding-scheme"][value="chemdraft"]')!);
    expect(keyButton("Open…").textContent).toBe("Unassigned");
    expect(loadKeybindingSettings().overrides?.chemdraft?.commands?.["document.open"]).toEqual([]);
    await click(keyButton("Save"));
    await press({ key: "Backspace", code: "Backspace" });
    expect(container.querySelector('[aria-label="Shortcut conflict"]')?.textContent).toContain("Delete Selection");
    await click(button("Cancel"));
    await click(button("Reset all to scheme defaults"));
    expect(keyButton("Open…").textContent).toBe(display("O"));
    expect(loadKeybindingSettings().overrides?.chemdraft).toEqual({});
  });

  it.each([
    ["b", false, false, "b", "Br"], ["B", true, false, "B", "B"],
    ["B", false, true, "b", "Br"], ["b", true, true, "B", "B"]
  ] as const)("records physical B (%s, Shift=%s, Caps Lock=%s) as %s", async (key, shiftKey, capsLock, stored, conflict) => {
    saveKeybindingSettings({ scheme: "chemdraw" });
    await mountKeyboard();
    await click(keyButton("Set Hovered Atom: F"));
    await press({ key, code: "KeyB", shiftKey }, capsLock);
    expect(container.querySelector('[aria-label="Shortcut conflict"]')?.textContent).toContain("Set Hovered Atom: " + conflict + ".");
    await click(button("Replace"));
    expect(keyButton("Set Hovered Atom: F").textContent).toBe(stored);
    expect(loadKeybindingSettings().overrides?.chemdraw?.atom?.["atom.setHoveredElement.F"]).toEqual([stored]);
  });
});
