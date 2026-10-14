// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DialogMessage } from "./dialogProtocol";
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn(), stop: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return host.stop; }, sendDialogMessage: host.send }));
import { DialogWindow } from "./DialogWindow";
const snapshot: Extract<DialogMessage, { type: "snapshot" }> = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "pageSize", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing A", width: 8.5, height: 11, unit: "inch" } };
let root: Root; let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks(); host.send.mockResolvedValue(undefined);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => { throw new Error("hidden rAF must never be used"); }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
  await act(async () => host.receive!(snapshot));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
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
