// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import type { ToolsetPopoverContentPayload } from "./window-manager";

const native = vi.hoisted(() => ({
  content: undefined as undefined | ((payload: ToolsetPopoverContentPayload) => void),
  release: undefined as undefined | ((payload: { toolsetId: string; releasedAt: number }) => void),
  resized: undefined as undefined | (() => void),
  show: vi.fn(async () => {}), size: vi.fn(async () => {}), invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => {})
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ hide: async () => {}, setFocus: async () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: async () => {} }) }));
vi.mock("./plugins/pluginPanelInputFocus", () => ({ installPaletteInputFocus: () => () => {} }));
vi.mock("./window-manager", async importOriginal => ({
  ...await importOriginal<typeof import("./window-manager")>(),
  listenForToolsetPopoverContent: vi.fn(async handler => { native.content = handler; return () => {}; }),
  listenForToolsetPopoverRelease: vi.fn(async handler => { native.release = handler; return () => {}; }),
  listenForToolsetPopoverDismiss: vi.fn(async () => () => {}),
  listenForBondStereoPopoverActions: vi.fn(async () => () => {}),
  listenForToolsetTextStyle: vi.fn(async () => () => {}),
  requestToolsetPopoverContent: vi.fn(async () => {}), requestToolsetTextStyle: vi.fn(async () => {}),
  setCurrentWindowLogicalSize: native.size, setCurrentWindowLogicalPosition: vi.fn(async () => {}),
  showCurrentToolsetPopoverWindow: native.show
}));

let root: Root, container: HTMLDivElement;
const host = window as typeof window & { __TAURI__?: unknown };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.useFakeTimers();
  host.__TAURI__ = {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { native.resized = callback; }
    observe() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0, left: 0, width: 90, height: 90, bottom: 90, right: 90, x: 0, y: 0, toJSON() {}
  });
  Object.defineProperty(document, "scrollingElement", { configurable: true, value: document.documentElement });
  container = document.createElement("div"); container.id = "root";
  document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); delete host.__TAURI__;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const rings: ToolsetPopoverContentPayload = { toolsetId: "core.main", kind: "flyout", openedAt: 1,
  flyout: { flyoutId: "rings", title: "Rings", columns: 3, commands: Array.from({ length: 9 }, (_, i) => ({
    id: `ring-${i}`, title: `Ring ${i}`, enabled: true, active: false
  })) } };
function elements() {
  return [document.documentElement, document.body, container,
    container.querySelector<HTMLElement>(".palette-popover-shell")!,
    container.querySelector<HTMLElement>('[role="menu"]')!].filter(Boolean);
}
function offset() { for (const element of elements()) { element.scrollTop = 28; element.scrollLeft = 8; } }
function expectReset() { for (const element of elements()) { expect(element.scrollTop).toBe(0); expect(element.scrollLeft).toBe(0); } }
function records() {
  return native.invoke.mock.calls.filter(([command]) => command === "perf_log_append")
    .map(call => JSON.parse((call as unknown as [string, { line: string }])[1].line));
}

it("clears retained document/root/shell scrolling on content update, fit and reveal", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
  offset();
  let finishReveal!: () => void;
  native.show.mockImplementationOnce(() => new Promise<void>(resolve => { finishReveal = resolve; }));
  await act(async () => native.content?.(rings));
  expectReset();
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(9);
  offset();
  await act(async () => finishReveal());
  expectReset();
  expect(records()).toEqual([expect.objectContaining({ event: "toolset-popover-geometry",
    geometry: expect.objectContaining({ phase: "reveal", scrollTop: 0, shellTop: 0, shellHeight: 90, innerHeight: window.innerHeight, scrollY: 0 }) })]);
  offset();
  await act(async () => native.resized?.());
  expectReset();
  offset();
  await act(async () => native.content?.({ ...rings, flyout: { ...rings.flyout, title: "Updated rings" } }));
  expectReset();
});

it("samples the owner's release offset before resetting it, and ignores another palette's release", async () => {
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
  await act(async () => native.content?.(rings));
  offset();
  await act(async () => { native.release?.({ toolsetId: "core.art", releasedAt: 2 }); await vi.advanceTimersByTimeAsync(0); });
  expect(records()).toHaveLength(1);
  await act(async () => { native.release?.({ toolsetId: "core.main", releasedAt: 2 }); await vi.advanceTimersByTimeAsync(0); });
  expect(records()[1].geometry).toMatchObject({ phase: "release", scrollTop: 28, shellScrollTop: 28 });
  expectReset();
  offset();
  document.documentElement.dispatchEvent(new Event("scroll"));
  expectReset();
});

it("focuses keyboard flyout choices and traverses Tab without scrolling", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.bondStereo", kind: "flyout", prewarm: true })));
  await act(async () => native.content?.({ ...rings, toolsetId: "core.bondStereo",
    flyout: { ...rings.flyout, id: "stereo", variant: "bondStereo", keyboardOpen: true } }));
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  expect(focus).toHaveBeenCalledTimes(2);
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
});

it("disables overflow and scroll anchoring only in the popover document and shell", () => {
  const css = readFileSync("apps/desktop/src/App.css", "utf8");
  for (const selector of ["body.palette-popover-window-body #root", ".palette-popover-shell"]) {
    const rule = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    expect(rule).toContain("overflow: hidden");
    expect(rule).toContain("overflow-anchor: none");
  }
});
