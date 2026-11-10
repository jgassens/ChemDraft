// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileWarningsWindow } from "./FileWarningsWindow";
import type { FileWarningsChunk, FileWarningsSnapshot } from "./fileWarningsProtocol";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => {}), channels: [] as { onmessage: (value: FileWarningsChunk) => void }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage = (_value: FileWarningsChunk) => {};
    constructor() { ipc.channels.push(this); }
  }
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); ipc.channels.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const snapshot: FileWarningsSnapshot = { sessionId: "opening-1", revision: 1, reports: [{ heading: "Opened file: 2 warnings", rows: [
  { message: "Original message", code: "preserved", target: "Molecule", missing: false, canShow: true },
  { message: "Deleted target", code: "missing", target: "An object no longer in the document", missing: true, canShow: false }
] }] };
function receive(value: FileWarningsSnapshot) {
  act(() => ipc.channels[0]!.onmessage({ sessionId: value.sessionId, revision: value.revision, index: 0, total: 1, json: JSON.stringify(value) }));
}

it("requests before reveal, renders original rows, routes Show and handles Escape", async () => {
  await act(async () => root.render(<FileWarningsWindow />));
  expect(ipc.invoke).toHaveBeenCalledWith("file_warnings_request", { onSnapshot: ipc.channels[0] });
  expect(ipc.invoke).not.toHaveBeenCalledWith("file_warnings_ready", expect.anything());
  receive(snapshot);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close the warnings list");
  expect(container.querySelectorAll("[data-open-warning-row]")).toHaveLength(2);
  expect(container.textContent).toContain("Original message");
  expect(ipc.invoke).toHaveBeenCalledWith("file_warnings_ready", { sessionId: "opening-1", revision: 1 });
  const show = container.querySelector<HTMLButtonElement>("[data-open-warning-show]")!;
  act(() => show.click());
  expect(ipc.invoke).toHaveBeenCalledWith("file_warnings_action", { action: { kind: "show", sessionId: "opening-1", revision: 1, reportIndex: 0, warningIndex: 0 } });
  act(() => show.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(ipc.invoke).toHaveBeenLastCalledWith("file_warnings_action", { action: { kind: "close", sessionId: "opening-1", revision: 1 } });
  ipc.invoke.mockClear();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("file_warnings_action", { action: { kind: "close", sessionId: "opening-1", revision: 1 } });
});

it("retains keyboard focus when live targets refresh and makes Close operable", async () => {
  await act(async () => root.render(<FileWarningsWindow />));
  receive(snapshot);
  const show = container.querySelector<HTMLButtonElement>("[data-open-warning-show]")!;
  show.focus();
  receive({ ...snapshot, revision: 2 });
  expect(document.activeElement).toBe(show);
  act(() => container.querySelector<HTMLButtonElement>("[aria-label='Close the warnings list']")!.click());
  expect(ipc.invoke).toHaveBeenLastCalledWith("file_warnings_action", { action: { kind: "close", sessionId: "opening-1", revision: 2 } });
});

it.each(["macos", "windows"] as const)("blocks webview reload chords on %s", async platform => {
  await act(async () => root.render(<FileWarningsWindow platform={platform} />));
  for (const init of [{ key: "F5" }, { key: "r", metaKey: platform === "macos", ctrlKey: platform === "windows" }]) {
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
});
