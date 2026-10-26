// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
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
vi.mock("./runtime", async original => ({ ...await original<typeof import("./runtime")>(), get perfProbe() { return state.probe; } }));
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

function probe(role: PerfRecord["window"], forwardInput?: ProbeEnvironment["forwardInput"]) {
  let now = 1000, id = 0;
  const rows: PerfRecord[] = [], frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Map<string, EventListener>();
  const tasks: (() => void)[] = [];
  const env: ProbeEnvironment = {
    target: {
      addEventListener: (name: string, handler: EventListenerOrEventListenerObject, capture?: boolean | AddEventListenerOptions) => { listeners.set(name + (capture ? "-capture" : ""), handler as EventListener); },
      removeEventListener: (name: string) => { listeners.delete(name); }
    },
    now: () => now, eventTime: () => 1000, frame: callback => { frames.set(++id, callback); return id; },
    afterPaint: callback => callback(), cancelFrame: key => { frames.delete(key); }, defer: callback => { tasks.push(callback); },
    timeout: (callback, delay = 120_000) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: key => { timers.delete(key); }, write: row => { rows.push(row); },
    window: role, platform: "macos", buildStamp: "test", processStart: 500, clockErrorMs: 0, forwardInput
  };
  const instance = new PerfProbe(env);
  return { instance, rows, timers, setTime: (value: number) => { now = value; },
    paint() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
    input(type: string, target: Element) {
      // jsdom cannot manufacture trusted events. Exercise the installed capture listener directly.
      const event = { type, target, isTrusted: true, timeStamp: 0, pointerId: 1 } as unknown as Event;
      listeners.get(type + "-capture")?.(event);
      listeners.get(type)?.(event);
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

it("carries a toolbar press ID/t0 through main to Settings paint without completing either local row", () => {
  const forward = vi.fn(); const toolbar = probe("toolset", forward);
  const button = document.createElement("button"); button.dataset.commandId = "tool.settings";
  toolbar.input("pointerdown", button); toolbar.paint(); expect(toolbar.rows).toEqual([]);
  toolbar.setTime(1080); toolbar.input("pointerup", button);
  // Capture must register before React's pointerup action, which suppresses the later click.
  expect(forward).toHaveBeenCalledTimes(1);
  toolbar.input("click", button); toolbar.paint();
  expect(forward).toHaveBeenCalledTimes(1);
  const origin = forward.mock.calls[0][0];
  expect(origin).toMatchObject({ t0: 1000, commandId: "tool.settings" });
  expect(toolbar.rows).toHaveLength(2);
  for (const row of toolbar.rows) {
    expect(row).toMatchObject({ doneSignal: "forwarded", extra: { inputId: origin.inputId, nonCompleting: true } });
    expect(row.firstFrameMs).toBeUndefined();
    expect(row.doneMs).toBeUndefined();
  }
  // Forwarding is a separate perf event; the app command carries only its command ID.
  const listeners = new Map<string, EventListener>(); const rows: PerfRecord[] = [];
  const env: ProbeEnvironment = {
    target: { addEventListener: (name: string, fn: EventListenerOrEventListenerObject) => { listeners.set(name, fn as EventListener); }, removeEventListener: () => {} },
    now: () => 1100, eventTime: value => value, frame: () => 1, cancelFrame: () => {}, afterPaint: callback => callback(),
    defer: () => {}, timeout: () => 1, clearTimeout: () => {}, write: row => { rows.push(row); },
    window: "main", platform: "windows", buildStamp: "test", processStart: 500, clockErrorMs: 0
  };
  const main = new PerfProbe(env);
  main.forwardedInput({ ...origin, window: "toolset-core-main" });
  listeners.get("chemdraft:native-command")!({ detail: { commandId: "tool.settings" } } as unknown as Event);
  const open = main.nativeWindowStarted("unused-main-id", "tool.settings")!;
  expect(open).toEqual({ inputId: "unused-main-id", t0: 1100, commandId: "tool.settings" });
  main.remoteCompletion(open.inputId, "window-painted", 1500, 1520, "settings", 1510);
  expect(rows[0]).toMatchObject({ t0: 1000, doneMs: 500, firstFrameMs: 520, extra: { originInputId: origin.inputId, forwarded: true } });
  main.stop(); toolbar.instance.stop();
});

it("frame-measures ordinary flyout clicks with the primary command on both input rows", () => {
  const h = probe("palette"); state.probe = h.instance;
  const button = document.createElement("button"); button.dataset.commandFlyoutButton = "arrows";
  button.dataset.commandId = "tool.bond";
  h.input("pointerdown", button); h.paint(); expect(h.rows).toEqual([]);
  h.setTime(1100); h.input("pointerup", button); h.paint();
  h.input("click", button); h.paint();
  expect(h.rows).toHaveLength(2);
  for (const row of h.rows) expect(row).toMatchObject({ commandId: "tool.bond", doneSignal: "frame", firstFrameMs: 100 });
  expect(h.timers.size).toBe(0);
});

it.each([false, true])("suppresses the long-press release click (revealed before release: %s)", revealed => {
  const h = probe("palette"); state.probe = h.instance;
  const button = document.createElement("button"); button.dataset.commandFlyoutButton = "arrows";
  h.input("pointerdown", button); h.paint(); h.instance.popoverRequested("arrows");
  const show = () => h.instance.popoverShown("arrows", 1500, 1520, "toolset-popover-core-main");
  if (revealed) show();
  h.input("pointerup", button); h.input("click", button); h.paint();
  if (!revealed) show();
  expect(h.rows).toHaveLength(1);
  expect(h.rows[0]).toMatchObject({ kind: "pointerdown", doneSignal: "popover-shown" });
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

it.each(["plugins.manage", "plugin.example.openManager", undefined])("records one committed Plugin Manager row with its actual trigger %s under StrictMode", async commandId => {
  const h = probe("main"); state.probe = h.instance;
  if (commandId) {
    const button = document.createElement("button"); h.input("click", button); h.instance.command(commandId);
  }
  const shown = h.instance.surfaceStarted("dialog", commandId, "plugin-manager");
  const onShown = vi.fn(() => h.instance.surfaceShown(shown, "dialog-open"));
  const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
  const render = () => createElement(StrictMode, null, createElement(PluginManagerDialog, { runtime, bundledPlugins: [], onClose: () => {}, onShown }));
  await act(async () => root.render(render()));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  h.paint();
  await act(async () => root.render(render())); h.paint();
  expect(onShown).toHaveBeenCalledTimes(1);
  // A retained open timing also remains idempotent across a full component remount.
  await act(async () => root.render(null));
  h.setTime(1200);
  await act(async () => root.render(render())); h.paint();
  const rows = h.rows.filter(row => row.kind === "dialog-open");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ window: "dialog", doneSignal: "dialog-open", extra: { frameWindow: "main", surface: "plugin-manager" } });
  expect(rows[0].commandId).toBe(commandId);
});
