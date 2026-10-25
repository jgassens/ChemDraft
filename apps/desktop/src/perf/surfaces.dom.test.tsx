// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PerfProbe, type PerfRecord, type ProbeEnvironment } from "./probe";
import { PalettePopoverWindow } from "../PalettePopoverWindow";
import { PluginManagerDialog } from "../plugins/PluginManagerDialog";
import { createPluginRuntime } from "../plugins/createPluginRuntime";
import type { ToolsetPopoverContentPayload } from "../window-manager";
import { MemoryStorage } from "../testSupport/memoryStorage";

const state = vi.hoisted(() => ({ probe: undefined as PerfProbe | undefined,
  content: undefined as ((payload: ToolsetPopoverContentPayload) => void) | undefined,
  show: vi.fn() }));
vi.mock("./runtime", () => ({ get perfProbe() { return state.probe; } }));
vi.mock("../ToolPalette", () => ({ ColorPickerPopoverBody: () => null, symbolToolGlyph: () => undefined, toolbarCommandFlyoutGridStyle: () => ({}) }));
vi.mock("../window-manager", async original => ({
  ...await original<typeof import("../window-manager")>(),
  listenForToolsetPopoverContent: async (handler: typeof state.content) => { state.content = handler; return () => {}; },
  listenForToolsetTextStyle: async () => () => {}, listenForToolsetPopoverDismiss: async () => () => {},
  requestToolsetPopoverContent: async () => {}, requestToolsetTextStyle: async () => {},
  setCurrentWindowLogicalPosition: async () => {}, setCurrentWindowLogicalSize: async () => {},
  showCurrentToolsetPopoverWindow: state.show
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", new MemoryStorage());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state.show.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount()); state.probe?.stop(); state.probe = undefined;
  container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function probe(role: PerfRecord["window"]) {
  let now = 1000, id = 0;
  const rows: PerfRecord[] = [], frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Map<string, EventListener>();
  const tasks: (() => void)[] = [];
  const env: ProbeEnvironment = {
    target: {
      addEventListener: (name: string, handler: EventListenerOrEventListenerObject) => { listeners.set(name, handler as EventListener); },
      removeEventListener: (name: string) => { listeners.delete(name); }
    },
    now: () => now, eventTime: () => 1000, frame: callback => { frames.set(++id, callback); return id; },
    cancelFrame: key => { frames.delete(key); }, defer: callback => { tasks.push(callback); },
    timeout: (callback, delay = 120_000) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: key => { timers.delete(key); }, write: row => { rows.push(row); },
    window: role, platform: "macos", buildStamp: "test", processStart: 500, clockErrorMs: 0
  };
  const instance = new PerfProbe(env);
  return { instance, rows, timers, setTime: (value: number) => { now = value; },
    paint() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    input(type: string, target: Element) {
      // jsdom cannot manufacture trusted events. Exercise the installed capture listener directly.
      listeners.get(type)!({ type, target, isTrusted: true, timeStamp: 0 } as unknown as Event);
      tasks.splice(0).forEach(task => task());
    }
  };
}
const content: ToolsetPopoverContentPayload = { toolsetId: "core.main", kind: "flyout",
  flyout: { flyoutId: "arrows", title: "Arrows", commands: [{ id: "tool.bond", title: "Bond", enabled: true, active: false }] } };

it("waits for the popover reveal, records its destination frame and settles the palette hold", async () => {
  const palette = probe("palette");
  const button = document.createElement("button"); button.dataset.commandFlyoutButton = "arrows";
  palette.input("pointerdown", button); palette.paint(); expect(palette.rows).toEqual([]);
  palette.instance.popoverRequested("arrows");
  expect([...palette.timers.values()].some(timer => timer.delay === 1500)).toBe(false);
  const popover = probe("palette-popover"); state.probe = popover.instance;
  let reveal!: () => void;
  state.show.mockImplementation(() => new Promise<void>(resolve => { reveal = resolve; }));
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "flyout", prewarm: true })));
  expect(state.show).not.toHaveBeenCalled();
  await act(async () => state.content!(content));
  popover.instance.rendered(); popover.paint(); expect(popover.rows).toEqual([]);
  popover.setTime(1500); await act(async () => reveal()); popover.setTime(1520); popover.paint();
  expect(popover.rows[0]).toMatchObject({ kind: "window-shown", window: "palette-popover", doneSignal: "popover-shown", doneMs: 500, firstFrameMs: 520 });
  palette.instance.popoverShown("wrong-flyout", 1500, 1520, "toolset-popover-core-main");
  expect(palette.rows).toEqual([]);
  palette.instance.popoverShown("arrows", 1500, 1520, "toolset-popover-core-main");
  expect(palette.rows[0]).toMatchObject({ kind: "pointerdown", doneSignal: "popover-shown", doneMs: 500, firstFrameMs: 520,
    extra: { frameSource: "destination-window", approximateCompletion: true } });
  expect(palette.timers.size).toBe(0); palette.instance.stop();
});

it.each(["pointerdown", "click"])("bounds a flyout %s that opens nothing to 1.5 seconds", type => {
  const h = probe("palette"); state.probe = h.instance;
  const button = document.createElement("button"); button.dataset.commandFlyoutButton = "arrows";
  h.input(type, button); h.paint(); expect(h.rows).toEqual([]);
  h.setTime(2500);
  [...h.timers.values()].filter(timer => timer.delay === 1500).forEach(timer => timer.callback());
  expect(h.rows[0]).toMatchObject({ doneSignal: "no-op", doneMs: 1500, extra: { approximateCompletion: true } });
  expect(h.timers.size).toBe(0);
});

it.each(["no-op", "failed"] as const)("settles a requested but %s popover without waiting for a hidden-window frame", signal => {
  const h = probe("palette"); state.probe = h.instance;
  const button = document.createElement("button"); button.dataset.commandFlyoutButton = "arrows";
  h.input("pointerdown", button); h.instance.popoverRequested("arrows");
  h.instance.popoverShown("arrows", 1100, undefined, "toolset-popover-core-main", signal);
  expect(h.rows[0]).toMatchObject({ doneSignal: signal, doneMs: 100 });
  expect(h.timers.size).toBe(0);
});

it("records the Plugin Manager's committed dialog in the main webview", async () => {
  const h = probe("main"); state.probe = h.instance;
  const button = document.createElement("button"); h.input("click", button); h.instance.command("plugins.manage");
  const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
  await act(async () => root.render(createElement(PluginManagerDialog, { runtime, bundledPlugins: [], onClose: () => {} })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  h.paint();
  expect(h.rows.find(row => row.kind === "dialog-open")).toMatchObject({ window: "dialog", commandId: "plugins.manage", doneSignal: "dialog-open", extra: { frameWindow: "main", surface: "plugin-manager" } });
});
