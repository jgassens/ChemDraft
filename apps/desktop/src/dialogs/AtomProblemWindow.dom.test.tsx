// @vitest-environment jsdom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialogWindow } from "./DialogWindow";
import { dialogEnvelope, type DialogMessage, type DialogSnapshot } from "./dialogProtocol";
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return () => {}; }, sendDialogMessage: host.send }));
let root: Root, container: HTMLDivElement;
const snapshot: DialogSnapshot = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "atomProblem", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot",
  data: { title: "Drawing", explanation: "N: 3 bonds, valence 4, formal charge 0. N has charge 0, expected 1 for valence 4.", targetVersion: 1,
    fixes: [{ action: "charge", label: "Set formal charge to +1" }, { action: "ignore", label: "Ignore warning" }] } };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host.send.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("scrolls long problem details while keeping all three fixes and Close in a pinned footer", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
  document.head.append(style);
  try {
    await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
    await act(async () => host.receive!({ ...snapshot, data: { ...snapshot.data, explanation: "Long explanation. ".repeat(50),
      fixes: [{ action: "hydrogens", label: "Set explicit hydrogens to 1" }, { action: "charge", label: "Set formal charge to +1" }, { action: "ignore", label: "Ignore warning" }] } }));
    const form = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const body = form.querySelector<HTMLElement>(".cd-dialog-fit-body")!;
    const footer = form.querySelector<HTMLElement>(".cd-dialog-fit-footer")!;
    expect(getComputedStyle(form).height).toBe("100vh");
    expect(getComputedStyle(form).minHeight).toBe("0px");
    expect(getComputedStyle(body).overflow).toBe("auto");
    expect(getComputedStyle(body).minHeight).toBe("0px");
    expect(getComputedStyle(footer).flexShrink).toBe("0");
    expect(body.parentElement).toBe(form);
    expect(footer.parentElement).toBe(form);
    expect(body.querySelector("button")).toBeNull();
    expect(footer.querySelectorAll("button")).toHaveLength(4);
    expect(getComputedStyle(footer).flexWrap).toBe("wrap");
  } finally { style.remove(); }
});
it("renders modeless, data-only fixes in the shared host, guards duplicate clicks, and receives retarget/no-problem snapshots", async () => {
  await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
  await act(async () => host.receive!(snapshot));
  expect(container.querySelector('[role="dialog"]')!.getAttribute("aria-modal")).toBe("false");
  const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
  expect([...container.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Set formal charge to +1", "Ignore warning", "Close"]);
  await act(async () => { button("Set formal charge to +1").click(); button("Set formal charge to +1").click(); });
  const actions = () => host.send.mock.calls.map(c => c[1] as DialogMessage).filter(m => m.type === "action");
  expect(actions()).toHaveLength(1);
  expect(actions()[0]!.data).toEqual({ action: "charge", targetVersion: 1 });
  await act(async () => host.receive!({ ...dialogEnvelope(actions()[0]!), type: "result", data: { status: "accepted" } }));
  expect(button("Ignore warning").disabled).toBe(true);
  await act(async () => host.receive!({ ...dialogEnvelope(actions()[0]!), type: "result", data: { status: "applied" } }));
  expect(button("Ignore warning").disabled).toBe(false);
  await act(async () => host.receive!({ ...snapshot, data: { ...snapshot.data, targetVersion: 2, explanation: "C has unsupported valence 5.", fixes: [{ action: "restore", label: "Restore warning" }] } }));
  expect(container.textContent).toContain("C has unsupported valence 5.");
  await act(async () => button("Restore warning").click());
  expect(actions()[1]!.data).toEqual({ action: "restore", targetVersion: 2 });
  await act(async () => host.receive!({ ...dialogEnvelope(actions()[1]!), type: "result", data: { status: "applied" } }));
  await act(async () => host.receive!({ ...snapshot, data: { ...snapshot.data, targetVersion: 3, explanation: "No problem. This atom is valid or has been deleted.", fixes: [] } }));
  expect([...container.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Close"]);
  expect(container.textContent).toContain("No problem");
  expect(host.send.mock.calls.map(c => c[1] as DialogMessage).filter(m => m.type === "ready")).toHaveLength(1);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(actions()[2]!.data).toEqual({ action: "cancel" });
});
