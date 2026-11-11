// @vitest-environment jsdom
import { saveExportPreviewEnabled } from "../exportPreviewSettings";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseDialogMessage, validateDialogDelivery, type DialogMessage } from "./dialogProtocol";
import { installSecondaryWindowEditHistory } from "../editHistoryRouting";
import { DOM_COMMAND_EVENT } from "../window-manager";
vi.mock("../window-manager", async original => ({ ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => true }));
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn(), trace: vi.fn(), stop: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return host.stop; }, sendDialogMessage: host.send, sendDialogFitTrace: host.trace }));
import { DialogWindow } from "./DialogWindow";
import { DialogCoordinator } from "./DialogCoordinator";
import type { DialogTransport } from "./dialogTransport";
import { exportFixture } from "./exportTestFixtures";
import { toolInstallFixture } from "./toolInstallTestFixtures";
const snapshot: Extract<DialogMessage, { type: "snapshot" }> = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "pageSize", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing A", width: 8.5, height: 11, unit: "inch" } };
let root: Root; let container: HTMLDivElement; let stopEditRouting: () => void;
beforeEach(async () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks(); host.send.mockResolvedValue(undefined); host.trace.mockResolvedValue(undefined);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => { throw new Error("hidden rAF must never be used"); }));
  stopEditRouting = installSecondaryWindowEditHistory({ forwardToMain: () => {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
  await act(async () => host.receive!(snapshot));
});
afterEach(() => { stopEditRouting(); act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(["pageSize", "export"] as const)("sends %s DOM diagnostics at native resize and 500 ms later without applying the original-layout height", async kind => {
  const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.style.height === "auto" ? (this.style.gridAutoRows === "max-content" ? 271 : 334) : 271;
    return { top: 0, height, bottom: height, width: 420 } as DOMRect;
  });
  vi.stubGlobal("innerHeight", 271);
  vi.stubGlobal("innerWidth", 420);
  vi.stubGlobal("devicePixelRatio", 2);
  try {
    act(() => root.unmount()); root = createRoot(container);
    host.send.mockClear(); host.trace.mockClear();
    // The native event can land while the ready invoke is still awaiting its result.
    let finishReady!: () => void;
    host.send.mockImplementationOnce(() => new Promise<void>(resolve => { finishReady = resolve; }));
    await act(async () => root.render(createElement(DialogWindow, { hostId: "trace-host" })));
    const message: Extract<DialogMessage, { type: "snapshot" }> = kind === "export"
      ? { ...snapshot, dialogKind: "export", data: { title: "Drawing A", options: exportFixture() } } : snapshot;
    await act(async () => { host.receive!(message); if (kind === "export") await import("./ExportForm"); });
    const form = container.querySelector<HTMLElement>(kind === "export" ? "form" : "section")!;
    const body = form.querySelector<HTMLElement>(".cd-dialog-fit-body")!;
    const savedStyle = form.getAttribute("style");
    const savedBodyStyle = body.getAttribute("style");
    expect(host.trace).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event("resize")));
    const expected = {
      innerWidth: 420, innerHeight: 271, devicePixelRatio: 2, documentElementClientHeight: 0,
      root: { top: 0, height: 271, bottom: 271, scrollHeight: 0, clientHeight: 0 },
      scrollingBodies: [{ scrollHeight: 0, clientHeight: 0 }],
      footer: { bottom: 271, innerHeight: 271, bottomMinusInnerHeight: 0 },
      gridProbeHeight: 271, originalLayoutHeight: 334, contentHeight: 271
    };
    expect(host.trace).toHaveBeenCalledExactlyOnceWith("trace-host", { ...expected, phase: "resize" });
    await act(async () => { finishReady(); await vi.advanceTimersByTimeAsync(499); });
    expect(host.trace).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.trace).toHaveBeenLastCalledWith("trace-host", { ...expected, phase: "settled" });
    expect(host.trace).toHaveBeenCalledTimes(2);
    expect(form.getAttribute("style")).toBe(savedStyle);
    expect(body.getAttribute("style")).toBe(savedBodyStyle);
    await act(async () => { window.dispatchEvent(new Event("resize")); await vi.advanceTimersByTimeAsync(1000); });
    expect(host.trace).toHaveBeenCalledTimes(2);
    const fits = host.send.mock.calls.map(([, message]) => message as DialogMessage).filter(message => message.type === "ready");
    expect(fits).toHaveLength(1);
    expect(fits[0]!.data).toEqual({ contentHeight: 271, contentWidth: 420, pixelRatio: 2 });
  } finally { layout.mockRestore(); }
});

it("cancels delayed DOM diagnostics when the dialog unmounts", async () => {
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(host.trace).toHaveBeenCalledTimes(1);
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(host.trace).toHaveBeenCalledTimes(1);
});

it.each(["macos", "windows"] as const)("re-measures an unchanged fit on explicit native retry on %s", async platform => {
  vi.stubGlobal("navigator", { platform: platform === "macos" ? "MacIntel" : "Win32" });
  vi.stubGlobal("devicePixelRatio", platform === "macos" ? 2 : 1.5);
  let resized: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
  });
  const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, height: 334, width: 420 } as DOMRect);
  try {
    act(() => root.unmount()); root = createRoot(container);
    host.send.mockClear();
    await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
    await act(async () => host.receive!(snapshot));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const fits = () => host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "ready");
    const fit = { contentHeight: 334, contentWidth: 420, pixelRatio: devicePixelRatio };
    expect(fits().map(message => message.data)).toEqual([fit]);
    await act(async () => { resized!(); await vi.advanceTimersByTimeAsync(0); });
    expect(fits()).toHaveLength(1); // Ordinary resize notifications still deduplicate.
    const retry = parseDialogMessage({ ...snapshot, type: "remeasure", data: {} })!;
    expect(retry).toBeDefined();
    expect(validateDialogDelivery(retry, "main", snapshot, "dialog-main-pageSize-1")).toEqual(retry);
    expect(validateDialogDelivery(retry, "dialog-main-pageSize-1", snapshot, "dialog-main-pageSize-1")).toBeUndefined();
    expect(parseDialogMessage({ ...retry, data: { contentHeight: 334 } })).toBeUndefined();
    await act(async () => host.receive!({ ...retry, sessionId: "stale-session" }));
    expect(fits()).toHaveLength(1);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await act(async () => host.receive!(retry));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fits().map(message => message.data)).toEqual(Array(attempt + 1).fill(fit));
      expect(new Set(fits().map(message => message.requestId)).size).toBe(attempt + 1);
    }
    await act(async () => { resized!(); await vi.advanceTimersByTimeAsync(0); });
    expect(fits()).toHaveLength(4);
  } finally { layout.mockRestore(); }
});
it("logs why a ready measurement is undefined and recovers on explicit retry", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    host.send.mockClear();
    const retry = { ...snapshot, type: "remeasure" as const, data: {} };
    await act(async () => host.receive!(retry));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("measureDialogContent returned undefined: contentHeight"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("kind=pageSize session=session ready without fit"));
    expect(host.send.mock.calls.at(-1)?.[1]).toMatchObject({ type: "ready", data: {} });
    const form = container.querySelector<HTMLElement>("section")!;
    form.getBoundingClientRect = () => ({ top: 0, height: 334, width: 420 } as DOMRect);
    await act(async () => host.receive!(retry));
    expect(host.send.mock.calls.at(-1)?.[1]).toMatchObject({ type: "ready", data: { contentHeight: 334, contentWidth: 420, pixelRatio: 1 } });
  } finally { warning.mockRestore(); }
});
it("bypasses install readiness guards and uses the latest snapshot revision on retry", async () => {
  act(() => root.unmount()); root = createRoot(container);
  host.send.mockClear();
  const layout = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, height: 480, width: 520 } as DOMRect);
  try {
    await act(async () => root.render(createElement(DialogWindow, { hostId: "tool-host" })));
    const tool: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "toolInstall", data: toolInstallFixture() };
    await act(async () => host.receive!(tool));
    const fits = () => host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "ready");
    expect(fits()).toHaveLength(1);
    const updated = { ...tool, snapshotRevision: 2 };
    await act(async () => host.receive!(updated));
    await act(async () => host.receive!({ ...updated, type: "remeasure", data: {} }));
    expect(fits()).toHaveLength(2);
    expect(fits()[1]).toMatchObject({ snapshotRevision: 2, data: fits()[0].data });
  } finally { layout.mockRestore(); }
});
it.each(["macos", "windows"] as const)("requests a new content fit after Choose → Cancel on %s, then disconnects on close", async platform => {
  vi.stubGlobal("navigator", { platform: platform === "macos" ? "MacIntel" : "Win32" });
  const disconnect = vi.fn();
  const observe = vi.fn();
  let resized: (() => void) | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe; unobserve = vi.fn(); disconnect = disconnect;
  });
  const layout = vi.spyOn(HTMLFormElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLFormElement) {
    return { top: 0, height: this.textContent?.includes("Export location unchanged") ? 644 : 620 } as DOMRect;
  });
  try {
    act(() => root.unmount()); root = createRoot(container);
    host.send.mockClear();
    await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
    const exportedSnapshot: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "export", data: { title: "Origin", options: exportFixture() } };
    await act(async () => { host.receive!(exportedSnapshot); await import("./ExportForm"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const fits = () => host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "ready");
    expect(fits().map(message => message.data)).toEqual([{ contentHeight: 620, pixelRatio: 1 }]);
    const choose = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.startsWith("Choose"))!;
    await act(async () => choose.click());
    const action = host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "action").at(-1)!;
    await act(async () => host.receive!({ ...exportedSnapshot, type: "result", requestId: action.requestId, data: { status: "cancelled", notice: "Export location unchanged" } }));
    // A child-list/text mutation must trigger this even if the viewport-sized root never resizes.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fits().map(message => message.data)).toEqual([{ contentHeight: 620, pixelRatio: 1 }, { contentHeight: 644, pixelRatio: 1 }]);
    expect(container.textContent).toContain("Compress PDF");
    expect(observe).toHaveBeenCalledWith(container.querySelector("form"));
    expect(observe).toHaveBeenCalledWith(container.querySelector("input"));
    await act(async () => { resized!(); resized!(); await vi.advanceTimersByTimeAsync(0); });
    expect(fits()).toHaveLength(2); // Native resize notifications cannot start a feedback loop.
    act(() => root.unmount()); root = createRoot(container);
    expect(disconnect).toHaveBeenCalledOnce();
    await act(async () => { resized!(); await vi.advanceTimersByTimeAsync(0); });
    expect(fits()).toHaveLength(2);
  } finally { layout.mockRestore(); }
});
it("suppresses browser context menus except on editable fields", () => {
  const menu = (target: Element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  expect(menu(container.querySelector("button")!).defaultPrevented).toBe(true);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  document.body.append(checkbox);
  expect(menu(checkbox).defaultPrevented).toBe(true);
  expect(menu(document.body).defaultPrevented).toBe(true);
  expect(menu(container.querySelector("input")!).defaultPrevented).toBe(false);
  act(() => root.unmount());
  root = createRoot(container);
  expect(menu(document.body).defaultPrevented).toBe(false);
  checkbox.remove();
});
it("re-enables tool installation after a failed attempt and sends a fresh retry action", async () => {
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "tool-host" })));
  const toolSnapshot: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "toolInstall", data: toolInstallFixture() };
  await act(async () => host.receive!(toolSnapshot));
  const install = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Install")!;
  await act(async () => install().click());
  const first = host.send.mock.calls.at(-1)![1] as DialogMessage;
  await act(async () => host.receive!({ ...toolSnapshot, type: "result", requestId: first.requestId, data: { status: "accepted" } }));
  expect(install().disabled).toBe(true);
  await act(async () => host.receive!({ ...toolSnapshot, data: { ...toolInstallFixture(), state: { status: "failed", message: "Download failed" } } }));
  expect(install().disabled).toBe(false);
  await act(async () => install().click());
  const actions = host.send.mock.calls.map(([, message]) => message as DialogMessage).filter(message => message.type === "action");
  expect(actions).toHaveLength(2);
  expect(actions[1].requestId).not.toBe(first.requestId);
  expect(actions[1].data).toEqual({ action: "install" });
});
it.each(["Export", "Choose..."])("keeps pending %s busy for 60 seconds after owner acceptance without progress", async control => {
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
  let finish!: () => void;
  const work = vi.fn(() => new Promise<{ status: "cancelled" }>(resolve => { finish = () => resolve({ status: "cancelled" }); }));
  const transport: DialogTransport = {
    subscribe: async () => () => {},
    open: async message => { host.receive!(message); return { hostId: "export-host", windowLabel: "dialog-main-export-1" }; },
    publish: async (_id, message) => { host.receive!(message); },
    close: async () => {}
  };
  const coordinator = new DialogCoordinator(transport, { applyPageSize: vi.fn(), onError: vi.fn(), export: work, chooseExportDestination: work });
  const pending: Promise<void>[] = [];
  host.send.mockImplementation((_id, message: DialogMessage) => {
    const receipt = coordinator.receive({ message, senderWindowId: "dialog-main-export-1", windowLabel: "dialog-main-export-1" });
    pending.push(receipt);
    return Promise.resolve();
  });
  try {
    await act(async () => { await coordinator.openExport("tab", { title: "Origin", options: exportFixture() }); await import("./ExportForm"); });
    const button = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === text)!;
    await act(async () => button(control).click());
    expect(work).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Exporting...").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(false);
    await act(async () => button("Cancel").click());
    expect(host.send).toHaveBeenLastCalledWith("export-host", expect.objectContaining({ data: { action: "cancel" } }));
    await act(async () => { finish(); await Promise.all(pending); });
    expect(work).toHaveBeenCalledTimes(1);
  } finally { await coordinator.dispose(); }
});
it.each(["Export", "Choose..."])("reports missing acceptance for %s after exactly ten seconds without retry", async control => {
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
  const exportSnapshot: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "export", sessionId: "export-session", data: { title: "Origin", options: exportFixture() } };
  await act(async () => { host.receive!(exportSnapshot); await import("./ExportForm"); });
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === control)!;
  await act(async () => button.click());
  const action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  await act(async () => host.receive!({ ...exportSnapshot, type: "result", requestId: "unrelated", data: { status: "accepted" } }));
  await act(async () => vi.advanceTimersByTimeAsync(9999));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  // Even phase progress is not acceptance.
  await act(async () => host.receive!({ ...exportSnapshot, type: "result", requestId: action.requestId, data: { status: "progress", notice: "Preparing export…" } }));
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("did not acknowledge");
  expect(host.send.mock.calls.filter(([, m]) => m.type === "action")).toHaveLength(1);
});
it("blocks same-turn repeated clicks before React commits the busy state", async () => {
  const apply = container.querySelectorAll<HTMLButtonElement>("button")[1]!;
  await act(async () => { apply.click(); apply.click(); });
  expect(host.send).toHaveBeenCalledTimes(2); // ready plus exactly one action
});
it("keeps Apply disabled after success until native destruction", async () => {
  const apply = container.querySelectorAll<HTMLButtonElement>("button")[1]!;
  await act(async () => apply.click());
  const action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  await act(async () => host.receive!({ ...snapshot, type: "result", requestId: action.requestId, data: { status: "applied" } }));
  expect(apply.disabled).toBe(true);
  await act(async () => { apply.click(); });
  expect(host.send).toHaveBeenCalledTimes(2);
});
it("keeps Select All in the focused field for the macOS shortcut and native Edit menu", async () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  const field = container.querySelector("input")!;
  const select = vi.spyOn(field, "select");
  const key = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
  await act(async () => field.dispatchEvent(key));
  expect(key.defaultPrevented).toBe(true); expect(select).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.selectAll" } })));
  expect(select).toHaveBeenCalledTimes(2); expect(host.send).toHaveBeenCalledTimes(1);
  field.blur();
  await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "edit.selectAll" } })));
  expect(select).toHaveBeenCalledTimes(2);
  vi.restoreAllMocks();
});
it("reports ready after form commit, ignores stale snapshots/results, and times out an unacknowledged action without retry", async () => {
  expect(host.send).toHaveBeenCalledWith("opaque", expect.objectContaining({ type: "ready", snapshotRevision: 1 }));
  expect(document.activeElement).toBe(container.querySelector("input"));
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  await act(async () => host.receive!({ ...snapshot, sessionId: "old", data: { ...snapshot.data, title: "Wrong drawing", width: 30 } }));
  expect(container.textContent).toContain("Drawing A"); expect(container.querySelector("input")!.value).toBe("8.5");
  await act(async () => container.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
  const action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  expect(action.type).toBe("action");
  await act(async () => host.receive!({ ...snapshot, type: "result", requestId: "wrong-id", data: { status: "error", error: "Wrong receipt" } }));
  expect(container.textContent).not.toContain("Wrong receipt");
  await act(async () => vi.advanceTimersByTimeAsync(10001));
  expect(container.textContent).toContain("action was not retried");
  expect(host.send).toHaveBeenCalledTimes(2); expect(container.querySelectorAll<HTMLButtonElement>("button")[1]!.disabled).toBe(true);
  await act(async () => host.receive!({ ...snapshot, type: "result", requestId: action.requestId, data: { status: "error", error: "Finish drawing" } }));
  expect(container.textContent).toContain("Finish drawing"); expect(container.querySelectorAll<HTMLButtonElement>("button")[1]!.disabled).toBe(false);
});
it("prevents reload with no field focused and ignores same-revision replay", async () => {
  (document.activeElement as HTMLElement).blur();
  const reload = new KeyboardEvent("keydown", { key: "F5", cancelable: true }); window.dispatchEvent(reload); expect(reload.defaultPrevented).toBe(true);
  await act(async () => host.receive!({ ...snapshot, data: { ...snapshot.data, width: 20 } }));
  expect(container.querySelector("input")!.value).toBe("8.5"); expect(host.send).toHaveBeenCalledTimes(1);
});
it("renders Export failures and picker results in its form; success stays reserved with warnings and Close", async () => {
  // New host mount, not a cross-session snapshot (which the host correctly rejects).
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
  const exportedSnapshot: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "export", sessionId: "export-session", data: { title: "Origin", options: exportFixture() } };
  await act(async () => { host.receive!(exportedSnapshot); await import("./ExportForm"); });
  const button = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === text)!;
  expect(host.send).toHaveBeenCalledWith("export-host", expect.objectContaining({ type: "ready", dialogKind: "export" }));
  expect(document.activeElement).toBe(container.querySelector("#chemdraft-export-filename"));
  await act(async () => { button("Export").click(); button("Export").click(); });
  let action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  await act(async () => host.receive!({ ...exportedSnapshot, type: "result", requestId: action.requestId, data: { status: "progress", notice: "Preparing export…" } }));
  expect(container.textContent).toContain("Preparing export…"); expect(button("Exporting...").disabled).toBe(true);
  await act(async () => host.receive!({ ...exportedSnapshot, type: "result", requestId: action.requestId, data: { status: "error", error: "Disk full" } }));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Disk full"); expect(button("Export").disabled).toBe(false);
  await act(async () => button("Choose...").click());
  action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  await act(async () => host.receive!({ ...exportedSnapshot, type: "result", requestId: action.requestId, data: { status: "picked", destinationPath: "C:\\Granted.pdf", filename: "Granted.pdf" } }));
  expect(container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!.value).toBe("Granted.pdf"); expect(button("Export").disabled).toBe(false);
  await act(async () => button("Export").click()); action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  expect(action.type === "action" && "options" in action.data && action.data.options.destinationPath).toBe("C:\\Granted.pdf");
  await act(async () => host.receive!({ ...exportedSnapshot, type: "result", requestId: action.requestId, data: { status: "exported", notice: "Exported PDF with 1 warning(s)\nUnsupported artwork preserved approximately" } }));
  expect(container.textContent).toContain("Unsupported artwork"); expect(button("Exported").disabled).toBe(true); expect(button("Close").disabled).toBe(false);
  await act(async () => button("Close").click());
  expect(host.send).toHaveBeenLastCalledWith("export-host", expect.objectContaining({ data: { action: "cancel" } }));
});

it.each(["Cancel", "Escape", "close", "Ctrl+W"])("sends %s during a pending export and ignores its late receipt", async control => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
  const exportSnapshot: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "export", sessionId: "export-session", data: { title: "Origin", options: exportFixture() } };
  await act(async () => { host.receive!(exportSnapshot); await import("./ExportForm"); });
  const button = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === text)!;
  await act(async () => { button("Export").click(); button("Export").click(); });
  const action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  await act(async () => {
    if (control === "Cancel") button("Cancel").click();
    else if (control === "close") container.querySelector<HTMLButtonElement>('[aria-label="Close export"]')!.click();
    else container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: control === "Escape" ? "Escape" : "w", ctrlKey: control === "Ctrl+W", bubbles: true, cancelable: true }));
  });
  expect(host.send).toHaveBeenLastCalledWith("export-host", expect.objectContaining({ data: { action: "cancel" } }));
  expect(host.send.mock.calls.filter(([, m]) => m.type === "action" && m.data.action === "export")).toHaveLength(1);
  await act(async () => host.receive!({ ...exportSnapshot, type: "result", requestId: action.requestId, data: { status: "exported", notice: "Late success" } }));
  expect(container.textContent).not.toContain("Late success");
  vi.restoreAllMocks();
});

it("refreshes preview on frame revision while preserving the user's export draft", async () => {
  saveExportPreviewEnabled(true);
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
  const frame = { page: { width: 100, height: 100 }, content: { width: 80, height: 80 }, revision: 1 };
  const exportedSnapshot: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "export", sessionId: "export-session", data: { title: "Origin", options: { ...exportFixture(), filename: "My custom name.pdf" }, frame } };
  await act(async () => { host.receive!(exportedSnapshot); await import("./ExportForm"); });
  await act(async () => vi.advanceTimersByTimeAsync(350));
  const first = host.send.mock.calls.filter(([, m]) => m.type === "action" && m.data.action === "preview").at(-1)![1] as DialogMessage;
  expect(first).toBeDefined();
  await act(async () => host.receive!({ ...exportedSnapshot, type: "result", data: { status: "frame", frame: { ...frame, revision: 2 } } }));
  await act(async () => vi.advanceTimersByTimeAsync(350));
  const previews = host.send.mock.calls.filter(([, m]) => m.type === "action" && m.data.action === "preview");
  expect(previews).toHaveLength(2);
  expect(previews[1]![1].requestId).not.toBe(first.requestId);
  expect(container.querySelector<HTMLInputElement>("#chemdraft-export-filename")!.value).toBe("My custom name.pdf");
  await act(async () => host.receive!({ ...exportedSnapshot, type: "result", requestId: first.requestId, data: { status: "preview", preview: { url: "data:image/png;base64,AAAA", kind: "image", width: 100, height: 100, warnings: [] } } }));
  expect(container.querySelector('img[alt="Export preview"]')).toBeNull();
});
