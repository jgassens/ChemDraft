// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenForToolsetPopoverContent, monitorLogicalWorkAreaAt, openToolsetToolbarItemsPopover,
  placeToolbarPopover, requestToolsetPopoverContent, sendToolbarPopoverClosed, setToolsetPopoverContent,
  type ToolsetToolbarPopoverHandle, type ToolsetToolbarSnapshot } from "./index";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  emit: vi.fn(async (_event: string, _payload?: unknown) => {}),
  invoke: vi.fn(async (_name: string, _args?: unknown): Promise<unknown> => undefined),
  monitors: vi.fn(), focus: vi.fn(async () => {}), webviewFocus: vi.fn(async () => {})
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: native.emit,
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = native.listeners.get(event) ?? new Set();
    handlers.add(handler); native.listeners.set(event, handlers);
    return () => { handlers.delete(handler); };
  }
}));
vi.mock("@tauri-apps/api/window", () => ({ availableMonitors: native.monitors,
  getCurrentWindow: () => ({ setFocus: native.focus }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: native.webviewFocus }) }));

const snapshot: ToolsetToolbarSnapshot = { title: "Bonds", activeTool: "bond", items: [{
  id: "bond", kind: "toggle", label: "Bond", icon: "bond", iconDataUri: "data:image/svg+xml,example",
  tooltip: { title: "Bond", description: "Draw a bond", shortcutLabel: "B" },
  primary: { type: "command", command: { id: "bond", title: "Bond", icon: "bond", enabled: false, disabledReason: "Select a molecule" } },
  submenu: { id: "bonds", type: "command-grid", columns: 2, items: [{ id: "wedge", title: "Wedge", icon: "bond", enabled: true }] },
  layout: { colSpan: 2, rowSpan: 1 }, checked: true, active: true, keepOpen: true
}, { id: "style", kind: "control", label: "Style", primary: { type: "control", controlId: "widget.core.mainStyleControls" },
  tooltip: { title: "Style" }, submenu: null, layout: { colSpan: 12, rowSpan: 2 }
}] };
let opener: HTMLButtonElement;
let handles: ToolsetToolbarPopoverHandle[];
const pushes = () => native.emit.mock.calls.filter(([event]) => event === "chemdraft://toolset-popover-content");
beforeEach(() => {
  vi.clearAllMocks(); native.listeners.clear(); handles = [];
  vi.stubGlobal("__TAURI__", {});
  native.invoke.mockImplementation(async command => command === "window_logical_position" ? { x: -500, y: 100 } : undefined);
  native.monitors.mockResolvedValue([{ scaleFactor: 1.5, position: { x: -1440, y: 0 }, size: { width: 1440, height: 1200 },
    workArea: { position: { x: -1440, y: 30 }, size: { width: 1440, height: 1140 } } }]);
  native.emit.mockImplementation(async (event, payload) => {
    for (const handler of [...(native.listeners.get(event) ?? [])]) handler({ payload });
  });
  opener = document.createElement("button"); document.body.append(opener);
  vi.spyOn(opener, "getBoundingClientRect").mockReturnValue({ left: 10, right: 34, top: 20, bottom: 44,
    width: 24, height: 24, x: 10, y: 20, toJSON() {} });
});
afterEach(async () => {
  for (const handle of handles) await handle.close();
  // Release the opening press observer's 30s timeout as a real owner would.
  window.dispatchEvent(new Event("pointercancel"));
  opener.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function open() {
  const handle = openToolsetToolbarItemsPopover({ toolsetId: "core.main", opener, toolbar: snapshot });
  handles.push(handle); return handle;
}

it("transports the full toolbar kind (commands, submenu, enabled reason, checked state, controls, spans)", async () => {
  const received = vi.fn(); const stop = await listenForToolsetPopoverContent(received);
  const content = { kind: "toolbarItems" as const, openedAt: 42, toolbar: snapshot };
  const anchor = { x: -500, y: 100 };
  await setToolsetPopoverContent("core.main", content, anchor);
  const payload = JSON.parse(JSON.stringify({ ...content, toolsetId: "core.main", anchor }));
  expect(received).toHaveBeenCalledExactlyOnceWith(payload);
  expect(pushes()[0][1]).toEqual(payload); stop();
});

it("opens through the native request/snapshot path, anchors below, refreshes, and replays the latest snapshot", async () => {
  const handle = open(); await handle.ready;
  expect(native.invoke).toHaveBeenCalledWith("open_toolset_popover", { toolsetId: "core.main", kind: "toolbarItems", x: -490, y: 148, focusMode: "focus" });
  const first = pushes()[0][1] as { openedAt: number };
  const updated = { ...snapshot, title: "Updated", items: [snapshot.items[1]] };
  await handle.update(updated);
  await requestToolsetPopoverContent("core.main");
  await vi.waitFor(() => expect(pushes()).toHaveLength(3));
  for (const [, payload] of pushes().slice(1)) expect(payload).toMatchObject({ openedAt: first.openedAt, toolbar: updated });
  expect(pushes()[0][1]).toMatchObject({ anchor: { opener: { left: -490, top: 120, right: -466, bottom: 144 },
    workArea: { left: -960, top: 20, right: 0, bottom: 780 } } });
});

it.each(["remove", "hidden", "display"])("closes and stops replay when the opener disappears (%s)", async mode => {
  const handle = open(); await handle.ready;
  if (mode === "remove") opener.remove();
  else if (mode === "hidden") opener.hidden = true;
  else opener.style.display = "none";
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("close_toolset_popover", { toolsetId: "core.main" }));
  await handle.update(snapshot); await requestToolsetPopoverContent("core.main");
  expect(pushes()).toHaveLength(1);
});

it("closes an empty refresh and ignores subsequent updates", async () => {
  const handle = open(); await handle.ready;
  await handle.update({ items: [] }); await handle.update(snapshot);
  expect(native.invoke).toHaveBeenCalledWith("close_toolset_popover", { toolsetId: "core.main" });
  expect(pushes()).toHaveLength(1);
});

it("restores the real opener after Escape and stops command-close replays without taking focus", async () => {
  let handle = open(); await handle.ready;
  const openedAt = (pushes()[0][1] as { openedAt: number }).openedAt;
  await sendToolbarPopoverClosed({ toolsetId: "core.main", openedAt, restoreFocus: true });
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(native.focus).toHaveBeenCalledOnce(); expect(native.webviewFocus).toHaveBeenCalledOnce();
  await handle.update(snapshot); expect(pushes()).toHaveLength(1);
  handle = open(); await handle.ready;
  const secondOpen = (pushes()[1][1] as { openedAt: number }).openedAt;
  await sendToolbarPopoverClosed({ toolsetId: "core.main", openedAt, restoreFocus: true });
  await handle.update(snapshot); expect(pushes()).toHaveLength(3);
  await sendToolbarPopoverClosed({ toolsetId: "core.main", openedAt: secondOpen, restoreFocus: false });
  await requestToolsetPopoverContent("core.main"); expect(pushes()).toHaveLength(3);
  expect(native.focus).toHaveBeenCalledOnce();
});

it("does not send content after an opener is removed during a pending native open", async () => {
  let finish!: () => void;
  native.invoke.mockImplementation(async command => {
    if (command === "window_logical_position") return { x: -500, y: 100 };
    if (command === "open_toolset_popover") await new Promise<void>(resolve => { finish = resolve; });
  });
  const handle = open();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  opener.remove(); await handle.close(); finish(); await handle.ready;
  expect(pushes()).toHaveLength(0);
});

describe("destination monitor and placement maths (shared macOS/Windows logical coordinates)", () => {
  it.each([1, 1.5, 2])("uses the destination monitor work area at scale %s", async scaleFactor => {
    native.monitors.mockResolvedValue([{ scaleFactor, position: { x: -960 * scaleFactor, y: 0 },
      size: { width: 960 * scaleFactor, height: 800 * scaleFactor },
      workArea: { position: { x: -960 * scaleFactor, y: 20 * scaleFactor }, size: { width: 960 * scaleFactor, height: 760 * scaleFactor } } }]);
    expect(await monitorLogicalWorkAreaAt(-500, 100)).toEqual({ left: -960, top: 20, right: 0, bottom: 780 });
  });
  const area = { left: -960, top: 20, right: 0, bottom: 780 };
  it.each([
    { opener: { left: -500, top: 100, right: -476, bottom: 124 }, orientation: "horizontal" as const, expected: { x: -500, y: 128 } },
    { opener: { left: -50, top: 740, right: -26, bottom: 764 }, orientation: "horizontal" as const, expected: { x: -200, y: 636 } },
    { opener: { left: -500, top: 100, right: -476, bottom: 124 }, orientation: "vertical" as const, expected: { x: -472, y: 100 } },
    { opener: { left: -50, top: 740, right: -26, bottom: 764 }, orientation: "vertical" as const, expected: { x: -254, y: 680 } }
  ])("places and flips $orientation near $opener.left,$opener.top", ({ opener, orientation, expected }) => {
    expect(placeToolbarPopover(opener, { width: 200, height: 100 }, area, orientation)).toEqual(expected);
  });
  it("clamps every edge, including content larger than the work area", () => {
    expect(placeToolbarPopover({ left: -1000, right: -980, top: 0, bottom: 10 }, { width: 2000, height: 1000 }, area)).toEqual({ x: -960, y: 20 });
  });
});
