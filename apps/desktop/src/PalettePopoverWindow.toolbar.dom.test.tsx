// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PalettePopoverWindow } from "./PalettePopoverWindow";
import { openToolsetToolbarItemsPopover, setToolsetPopoverContent,
  type ToolsetToolbarPopoverHandle, type ToolsetToolbarItemSnapshot, type ToolsetToolbarSnapshot } from "./window-manager";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(async (_name: string, _args?: unknown): Promise<unknown> => undefined),
  hide: vi.fn(async () => {}), size: vi.fn(async () => {}),
  focus: vi.fn(async () => {}), webviewFocus: vi.fn(async () => {}),
  innerSize: vi.fn(async () => ({ width: 90, height: 90 })), scale: vi.fn(async () => 1),
  emit: vi.fn(async (_event: string, _payload?: unknown) => {})
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: native.emit,
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = native.listeners.get(event) ?? new Set();
    handlers.add(handler); native.listeners.set(event, handlers);
    return () => { handlers.delete(handler); };
  }
}));
// Keep subscriptions inside this in-memory two-webview transport. The safe native-listener
// adapter itself is covered by tauriEvents and window-manager suites.
vi.mock("./window-manager/tauriEvents", () => ({
  listenTauriEvent: async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = native.listeners.get(event) ?? new Set();
    handlers.add(handler); native.listeners.set(event, handlers);
    return () => { handlers.delete(handler); };
  },
  listenCurrentWindowEvent: async () => () => {}
}));
vi.mock("@tauri-apps/api/window", () => ({
  availableMonitors: async () => [{ scaleFactor: 1.5, position: { x: 0, y: 0 }, size: { width: 1500, height: 1200 },
    workArea: { position: { x: 0, y: 30 }, size: { width: 1500, height: 1140 } } }],
  getCurrentWindow: () => ({ hide: native.hide, setSize: native.size, setFocus: native.focus,
    innerSize: native.innerSize, scaleFactor: native.scale }),
  LogicalSize: class { constructor(public width: number, public height: number) {} }
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setFocus: native.webviewFocus }) }));
vi.mock("./plugins/pluginPanelInputFocus", () => ({
  installPaletteInputFocus: () => () => {},
  PALETTE_INPUT_FOCUS_CANCEL_EVENT: "chemdraft:palette-input-focus-cancel",
  PALETTE_INPUT_FOCUS_COMMIT_EVENT: "chemdraft:palette-input-focus-commit"
}));

let root: Root, host: HTMLDivElement, opener: HTMLButtonElement, handle: ToolsetToolbarPopoverHandle | undefined;
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); native.listeners.clear();
  native.innerSize.mockResolvedValue({ width: 90, height: 90 }); native.scale.mockResolvedValue(1);
  vi.stubGlobal("__TAURI__", {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  native.invoke.mockImplementation(async name => name === "window_logical_position" ? { x: 100, y: 100 } : undefined);
  native.emit.mockImplementation(async (event, payload) => {
    for (const handler of [...(native.listeners.get(event) ?? [])]) handler({ payload });
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 90, bottom: 90, width: 90, height: 90, toJSON() {}
  });
  host = document.createElement("div"); document.body.append(host);
  opener = document.createElement("button"); opener.textContent = "Open group"; document.body.append(opener);
  root = createRoot(host);
  await act(async () => root.render(createElement(PalettePopoverWindow, { toolsetId: "core.main", kind: "toolbarItems", prewarm: true })));
});
afterEach(async () => {
  await act(async () => { await handle?.close(); root.unmount(); });
  handle = undefined; host.remove(); opener.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function item(id: string, enabled = true): ToolsetToolbarItemSnapshot {
  return { id, kind: "button", label: id, icon: "bond", tooltip: { title: id },
    primary: { type: "command", command: { id, title: id, icon: "bond", enabled, disabledReason: enabled ? undefined : "Select an object" } },
    submenu: null, layout: { colSpan: 1, rowSpan: 1 } };
}
const submenuItem = (): ToolsetToolbarItemSnapshot => ({ ...item("primary", false), submenu: {
  id: "choices", title: "Choices", type: "command-grid", items: [
    { id: "disabled-choice", title: "Disabled choice", icon: "bond", enabled: false, disabledReason: "No selection" },
    { id: "choice", title: "Choice", icon: "bond", enabled: true }
  ]
} });
const button = (id: string) => host.querySelector<HTMLButtonElement>(`button[data-command-id="${id}"]`)!;
const calls = () => native.invoke.mock.calls.filter(([name]) => name === "route_toolset_command");
async function open(toolbar: ToolsetToolbarSnapshot) {
  await act(async () => { handle = openToolsetToolbarItemsPopover({ toolsetId: "core.main", opener, toolbar }); await handle.ready; });
}
async function key(key: string, target = document.activeElement!, altKey = false) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key, altKey, bubbles: true, cancelable: true })));
}
async function click(target: HTMLElement) { await act(async () => target.click()); }
async function pointer(target: HTMLElement, type: string) {
  await act(async () => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })));
}

it("renders real cells, focuses the first enabled tool, and invokes once for pointerup plus click", async () => {
  await open({ title: "Drawing", items: [item("disabled", false), item("draw")] });
  expect(host.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("Drawing");
  expect(document.activeElement).toBe(button("draw"));
  expect(button("draw").querySelector("svg")).not.toBeNull();
  expect(button("disabled").disabled).toBe(true);
  await pointer(button("disabled"), "pointerup"); await click(button("disabled"));
  expect(calls()).toHaveLength(0);
  await pointer(button("draw"), "pointerdown"); await pointer(button("draw"), "pointerup"); await click(button("draw"));
  expect(calls()).toEqual([["route_toolset_command", { commandId: "draw" }]]);
  expect(native.hide).toHaveBeenCalledTimes(1);
  const reveals = native.invoke.mock.calls.filter(([name]) => name === "show_toolset_popover_window").length;
  await act(async () => handle?.update({ items: [item("late")] }));
  expect(native.invoke.mock.calls.filter(([name]) => name === "show_toolset_popover_window")).toHaveLength(reveals);
});

it("opens a disabled primary's enabled submenu in the same window and navigates Back", async () => {
  await open({ items: [submenuItem()] });
  const primary = button("primary");
  expect(primary.disabled).toBe(false);
  expect(primary.getAttribute("aria-haspopup")).toBe("menu");
  expect(primary.hasAttribute("aria-controls")).toBe(false);
  await click(primary);
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
  const back = host.querySelector<HTMLButtonElement>(".toolbar-popover-back")!;
  expect(document.activeElement).toBe(back);
  expect(host.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Choices");
  await click(button("disabled-choice")); expect(calls()).toHaveLength(0);
  await click(back);
  expect(document.activeElement).toBe(button("primary"));
  await key("Enter");
  expect(host.querySelector('[role="menu"]')).not.toBeNull();
  await key("End"); expect(document.activeElement).toBe(button("choice"));
  await key(" "); await click(button("choice"));
  expect(calls()).toEqual([["route_toolset_command", { commandId: "choice" }]]);
  expect(native.hide).toHaveBeenCalledTimes(1);
});

it("keeps items with no enabled action disabled, including keyboard and submenu attempts", async () => {
  const cell = submenuItem(); cell.submenu!.items = [cell.submenu!.items[0]];
  await open({ items: [cell] });
  expect(button("primary").disabled).toBe(true);
  await click(button("primary")); await key("Enter", button("primary"));
  expect(calls()).toHaveLength(0);
  expect(host.querySelector('[role="menu"]:not([hidden])')).toBeNull();
});

it("invokes the shared distribute cell once per click and opens its own submenu here", async () => {
  await open({ items: [{ ...item("layout.distributeHorizontal"), keepOpen: true }] });
  const distribute = button("layout.distributeHorizontal");
  await click(distribute);
  await pointer(distribute, "pointerdown"); await pointer(distribute, "pointerup"); await click(distribute);
  expect(calls()).toEqual([
    ["route_toolset_command", { commandId: "layout.distributeHorizontal", preserveInputFocus: true }],
    ["route_toolset_command", { commandId: "layout.distributeHorizontal", preserveInputFocus: true }]
  ]);
  await key("ArrowDown", distribute, true);
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
  expect(host.querySelector(".toolbar-popover-back")).not.toBeNull();
  await key("Escape"); expect(document.activeElement).toBe(opener);
});

it("supports hold and Alt+Down submenus without spawning another popover", async () => {
  vi.useFakeTimers();
  const cell = submenuItem(); cell.primary = item("primary").primary;
  await open({ items: [cell] });
  const primary = button("primary");
  await pointer(primary, "pointerdown");
  await act(async () => vi.advanceTimersByTimeAsync(400));
  await pointer(primary, "pointerup"); await click(primary);
  expect(calls()).toHaveLength(0);
  await click(host.querySelector<HTMLButtonElement>(".toolbar-popover-back")!);
  await key("ArrowDown", document.activeElement!, true);
  expect(button("choice")).not.toBeNull();
  expect(native.invoke.mock.calls.filter(([name]) => name === "open_toolset_popover")).toHaveLength(1);
});

it("navigates enabled cells in both axes, Home/End, activates toggles once, and restores the opener on Escape", async () => {
  const toggle = { ...item("toggle"), kind: "toggle" as const, checked: false };
  await open({ items: [item("disabled", false), toggle, item("last")] });
  expect(host.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("More tools");
  expect(button("toggle").getAttribute("aria-pressed")).toBe("false");
  for (const keyName of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "End"]) {
    await key(keyName);
    expect(document.activeElement).toBe(button(keyName === "End" ? "last" : keyName === "ArrowRight" || keyName === "ArrowLeft" ? "last" : "toggle"));
  }
  await key("Home"); expect(document.activeElement).toBe(button("toggle"));
  await key("Enter"); await click(button("toggle"));
  await key(" "); await click(button("toggle"));
  expect(calls()).toHaveLength(2);
  expect(native.hide).not.toHaveBeenCalled();
  await act(async () => handle?.update({ items: [item("disabled", false), { ...toggle, checked: true }, item("last")] }));
  expect(button("toggle").getAttribute("aria-pressed")).toBe("true");
  await key("Escape");
  expect(native.hide).toHaveBeenCalledTimes(1);
  expect(native.emit).toHaveBeenCalledWith("chemdraft://toolbar-popover-closed", expect.objectContaining({ restoreFocus: true }));
  expect(document.activeElement).toBe(opener);
});

it("refreshes availability, submenu choices and the list without resetting a live submenu", async () => {
  const cell = submenuItem();
  await open({ items: [cell, item("other")] });
  await click(button("primary"));
  const changed = { ...cell, submenu: { ...cell.submenu!, items: [{ id: "updated", title: "Updated", icon: "bond" as const }] } };
  await act(async () => handle?.update({ title: "Changed", items: [changed] }));
  expect(button("choice")).toBeNull(); expect(button("updated")).not.toBeNull();
  await click(host.querySelector<HTMLButtonElement>(".toolbar-popover-back")!);
  expect(button("other")).toBeNull();
  await act(async () => handle?.update({ items: [item("first", false), item("new")] }));
  expect(button("first").disabled).toBe(true); expect(document.activeElement).toBe(button("new"));
});

it("reuses embedded controls and spans, and keeps their command invocations open", async () => {
  const control: ToolsetToolbarItemSnapshot = { ...item("style"), kind: "control",
    primary: { type: "control", controlId: "widget.core.mainStyleControls" }, layout: { colSpan: 12, rowSpan: 2 } };
  await open({ items: [control] });
  const slot = host.querySelector<HTMLElement>('[data-toolbar-item-id="style"]')!;
  expect(slot.dataset.toolbarLayoutColSpan).toBe("12"); expect(slot.dataset.toolbarLayoutRowSpan).toBe("2");
  const select = slot.querySelector<HTMLSelectElement>("select")!;
  expect(select).not.toBeNull();
  await act(async () => { select.value = select.options[1].value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(calls()).toHaveLength(1); expect(native.hide).not.toHaveBeenCalled();
});

it("wraps to available work-area width and flips the fitted window above a bottom-edge opener", async () => {
  await act(async () => setToolsetPopoverContent("core.main", { kind: "toolbarItems", openedAt: 10,
    toolbar: { items: [item("one"), item("two"), item("three"), item("four")] }
  }, { x: 80, y: 200, opener: { left: 80, right: 100, top: 180, bottom: 200 },
    workArea: { left: 0, right: 100, top: 20, bottom: 210 } }));
  expect((host.querySelector('[role="toolbar"]') as HTMLElement).style.gridTemplateColumns).toBe("repeat(3, 24px)");
  expect(native.invoke).toHaveBeenCalledWith("set_current_window_global_position", { x: 10, y: 86 });
});

it("does not resurrect a dismissed toolbar on a late refresh or cold-start replay", async () => {
  await open({ items: [item("draw")] });
  const payload = native.emit.mock.calls.find(([event]) => event === "chemdraft://toolset-popover-content")![1] as Parameters<typeof setToolsetPopoverContent>[1];
  await key("Escape"); native.hide.mockClear();
  const reveals = native.invoke.mock.calls.filter(([name]) => name === "show_toolset_popover_window").length;
  await act(async () => setToolsetPopoverContent("core.main", payload));
  expect(native.invoke.mock.calls.filter(([name]) => name === "show_toolset_popover_window")).toHaveLength(reveals);
});

it("clamps using the actual scaled native size when the window minimum exceeds the content", async () => {
  native.innerSize.mockResolvedValue({ width: 144, height: 84 }); native.scale.mockResolvedValue(1.5);
  await act(async () => setToolsetPopoverContent("core.main", { kind: "toolbarItems", openedAt: 10,
    toolbar: { items: [item("one")] }
  }, { x: 80, y: 200, opener: { left: 80, right: 100, top: 180, bottom: 200 },
    workArea: { left: 0, right: 100, top: 20, bottom: 210 } }));
  expect(native.invoke).toHaveBeenCalledWith("set_current_window_global_position", { x: 4, y: 120 });
});
