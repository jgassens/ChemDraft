// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installBrowserReloadGuard, wasBrowserReloadPrevented } from "./browserReloadGuard";
import { App } from "./App";

vi.mock("./dialogs/DialogWindow", () => ({ DialogWindow: () => <input onKeyDown={event => event.stopPropagation()} /> }));
vi.mock("./plugins/PluginPanelWindow", () => ({ PluginPanelWindow: () => <input onKeyDown={event => event.stopPropagation()} /> }));
vi.mock("./PaletteWindow", () => ({ PaletteWindow: () => <input onKeyDown={event => event.stopPropagation()} /> }));
vi.mock("./editHistoryRouting", () => ({ installSecondaryWindowEditHistory: () => () => {} }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe.each(["windows", "linux", "macos"] as const)("shared capture guard (%s)", platform => {
  it.each([
    { key: "F5" }, { key: "F5", ctrlKey: true }, { key: "r", ctrlKey: true },
    { key: "R", ctrlKey: true, shiftKey: true }, { key: "BrowserRefresh" }
  ])("prevents reload for $key while controls keep ownership of propagation", chord => {
    const cleanup = installBrowserReloadGuard(platform);
    const capture = vi.fn();
    const command = vi.fn();
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", command);
    const control = document.createElement("input");
    control.addEventListener("keydown", event => event.stopPropagation());
    document.body.append(control);
    try {
      const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true, isComposing: true });
      control.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(platform !== "macos");
      expect(capture).toHaveBeenCalledExactlyOnceWith(event);
      expect(command).not.toHaveBeenCalled();
    } finally {
      cleanup(); window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", command); control.remove();
    }
  });
  it.each([
    { key: "r", metaKey: true }, { key: "r", ctrlKey: true, altKey: true },
    { key: "r" }, { key: "s", ctrlKey: true }
  ])("leaves ordinary typing, AltGr, Save and Cmd+R alone: %j", chord => {
    const cleanup = installBrowserReloadGuard(platform);
    const command = vi.fn();
    window.addEventListener("keydown", command);
    try {
      const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(command).toHaveBeenCalledExactlyOnceWith(event);
    } finally { cleanup(); window.removeEventListener("keydown", command); }
  });
});

it("removes the capture listener on cleanup", () => {
  installBrowserReloadGuard("windows")();
  const event = new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it("marks only reload events that the guard itself prevented", () => {
  const cleanup = installBrowserReloadGuard("windows");
  try {
    const reload = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    const handled = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    const ordinary = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    for (const event of [reload, handled, ordinary]) document.body.dispatchEvent(event);
    expect(wasBrowserReloadPrevented(reload)).toBe(true);
    expect(wasBrowserReloadPrevented(handled)).toBe(false);
    expect(wasBrowserReloadPrevented(ordinary)).toBe(false);
  } finally { cleanup(); }
});

it.each(["?window=dialog&hostId=test", "?window=pluginPanel&panelId=test", "?window=toolset&toolsetId=main"])(
  "installs the same guard in a secondary webview: %s", async route => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    window.history.replaceState(null, "", `/${route}`);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<App />));
      const control = container.querySelector("input")!;
      expect(control).not.toBeNull();
      const event = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => { control.focus(); control.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    } finally { await act(async () => root.unmount()); container.remove(); }
  }
);
