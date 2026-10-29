// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dialogEnvelope, type DialogMessage, type DialogSnapshot } from "./dialogProtocol";
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn() }));
vi.mock("./dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return () => {}; }, sendDialogMessage: host.send }));
import { DialogWindow } from "./DialogWindow";
const snapshot: DialogSnapshot = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "source-tab", dialogKind: "structureTemplates", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing A", templateIds: ["beta-cyclodextrin"] } };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks(); host.send.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("uses the generic host route and permits another insert only after the completed receipt", async () => {
  await act(async () => root.render(createElement(DialogWindow, { hostId: "opaque" })));
  await act(async () => { host.receive!(snapshot); await import("./StructureTemplatePicker"); });
  const tile = () => container.querySelector<HTMLButtonElement>("[data-template-id]")!;
  expect(tile()).not.toBeNull();
  expect(document.activeElement).toBe(container.querySelector("input"));
  expect(host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "ready")).toHaveLength(1);
  // The owner may reveal the interactive picker while all thumbnail work is still deferred.
  expect(container.querySelectorAll("img[src]")).toHaveLength(0);
  const inserts = () => host.send.mock.calls.map(call => call[1] as DialogMessage).filter(message => message.type === "action" && message.data.action === "insert");
  await act(async () => { tile().click(); tile().click(); });
  expect(inserts()).toHaveLength(1);
  const action = inserts()[0]!;
  expect(action.documentTabId).toBe("source-tab");
  expect(action.data).toEqual({ action: "insert", templateId: "beta-cyclodextrin" });
  await act(async () => host.receive!({ ...dialogEnvelope(action), type: "result", data: { status: "accepted" } }));
  await act(async () => tile().click()); expect(inserts()).toHaveLength(1);
  await act(async () => host.receive!({ ...dialogEnvelope(action), type: "result", data: { status: "inserted" } }));
  await act(async () => tile().click()); expect(inserts()).toHaveLength(2);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});
