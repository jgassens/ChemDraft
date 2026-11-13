// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";

const host = vi.hoisted(() => ({ desktop: true, invoke: vi.fn(), measure: vi.fn(), observe: vi.fn(), stopObserving: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("./dialogs/dialogContentFit", () => ({ measureDialogContentWhenFontsReady: host.measure, observeDialogContent: host.observe }));
vi.mock("./window-manager", () => ({
  isDesktopRuntime: () => host.desktop,
  listenForDrawingSettings: async () => () => {},
  broadcastCompoundLayoutSettings: vi.fn(), broadcastKeybindingSettings: vi.fn(),
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
