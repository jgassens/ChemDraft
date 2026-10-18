// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DialogMessage } from "./dialogProtocol";
import { installSecondaryWindowEditHistory } from "../editHistoryRouting";
import { DOM_COMMAND_EVENT } from "../window-manager";
vi.mock("../window-manager", async original => ({ ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => true }));
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn(), stop: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return host.stop; }, sendDialogMessage: host.send }));
import { DialogWindow } from "./DialogWindow";
import { exportFixture } from "./exportTestFixtures";
const snapshot: Extract<DialogMessage, { type: "snapshot" }> = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "pageSize", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing A", width: 8.5, height: 11, unit: "inch" } };
let root: Root; let container: HTMLDivElement; let stopEditRouting: () => void;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks(); host.send.mockResolvedValue(undefined);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => { throw new Error("hidden rAF must never be used"); }));
  stopEditRouting = installSecondaryWindowEditHistory({ forwardToMain: () => {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
  await act(async () => host.receive!(snapshot));
});
afterEach(() => { stopEditRouting(); act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(["Export", "Choose..."])("refreshes the pending %s deadline on matching progress, then reports ten seconds of silence", async control => {
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "export-host" })));
  const exportSnapshot: Extract<DialogMessage, { type: "snapshot" }> = { ...snapshot, dialogKind: "export", sessionId: "export-session", data: { title: "Origin", options: exportFixture() } };
  await act(async () => { host.receive!(exportSnapshot); await import("./ExportForm"); });
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === control)!;
  await act(async () => button.click());
  const action = host.send.mock.calls.at(-1)![1] as DialogMessage;
  for (const notice of ["Preparing export…", "Choose an export location…", "Writing export…"]) {
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => host.receive!({ ...exportSnapshot, type: "result", requestId: action.requestId, data: { status: "progress", notice } }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(notice);
  }
  await act(async () => vi.advanceTimersByTimeAsync(9999));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => host.receive!({ ...exportSnapshot, type: "result", requestId: "unrelated", data: { status: "progress", notice: "Unrelated" } }));
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
