// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dialogEnvelope, parseDialogMessage, type DialogMessage, type DialogSnapshot } from "./dialogProtocol";
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return () => {}; }, sendDialogMessage: host.send }));
import { DialogWindow } from "./DialogWindow";
let root: Root, container: HTMLDivElement;
const snapshot: DialogSnapshot = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab-2", dialogKind: "reactionConditions",
  sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing B", arrowId: "arrow-2",
    draft: { side: "below", spans: [{ text: "80 °C", script: "normal" }] } } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.clearAllMocks(); host.send.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(["macos", "windows"] as const)("sends the natural height and refits when an error appears or clears on %s", async platform => {
  vi.stubGlobal("navigator", { platform: platform === "macos" ? "MacIntel" : "Win32" });
  const layout = vi.spyOn(HTMLFormElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLFormElement) {
    const status = this.querySelector('[role="status"]');
    return { top: 0, height: this.style.height === "auto" ? (status?.textContent ? 580 : 540) : 620 } as DOMRect;
  });
  try {
    await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
    await act(async () => host.receive!(snapshot));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const heights = () => host.send.mock.calls.map(([, message]) => message as DialogMessage)
      .filter(message => message.type === "ready").map(message => message.data.contentHeight);
    expect(heights()).toEqual([540]);
    const save = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => save.click());
    const action = host.send.mock.calls.map(([, message]) => message as DialogMessage).filter(message => message.type === "action").at(-1)!;
    await act(async () => host.receive!({ ...dialogEnvelope(action), type: "result", data: { status: "error", error: "The arrow changed. Try again." } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(heights()).toEqual([540, 580]);
    await act(async () => save.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(heights()).toEqual([540, 580, 540]);
  } finally { layout.mockRestore(); }
});
it("renders its native snapshot, preserves a local draft on replay and sends only one Save", async () => {
  await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
  await act(async () => host.receive!(snapshot));
  expect(container.textContent).toContain("Drawing B");
  const field = container.querySelector("textarea")!;
  expect(document.activeElement).toBe(field);
  expect(host.send.mock.calls.filter(([, message]) => message.type === "ready")).toHaveLength(1);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "80 °C, 2 h");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.receive!(snapshot));
  expect(field.value).toBe("80 °C, 2 h");
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save")!;
  await act(async () => { save.click(); save.click(); });
  const actions = host.send.mock.calls.map(([, message]) => message as DialogMessage).filter(message => message.type === "action");
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ documentTabId: "tab-2", dialogKind: "reactionConditions", data: { action: "apply", draft: { side: "below", spans: [{ text: "80 °C, 2 h", script: "normal" }] } } });
  await act(async () => host.receive!({ ...dialogEnvelope(actions[0]), type: "result", data: { status: "accepted" } }));
  await act(async () => vi.advanceTimersByTimeAsync(10001));
  expect(save.disabled).toBe(true); expect(container.textContent).not.toContain("did not acknowledge");
});
it("validates the new kind without accepting page-size, export, injected fields or oversized drafts", () => {
  expect(parseDialogMessage(snapshot)).toEqual(snapshot);
  for (const data of [{ action: "apply", width: 1, height: 1, unit: "inch" }, { action: "export", options: {} },
    { action: "apply", draft: { ...snapshot.data.draft, script: "<script>" } },
    { action: "apply", draft: { side: "above", spans: [{ text: "x".repeat(2001), script: "normal" }] } }])
    expect(parseDialogMessage({ ...dialogEnvelope(snapshot), type: "action", data })).toBeUndefined();
});
