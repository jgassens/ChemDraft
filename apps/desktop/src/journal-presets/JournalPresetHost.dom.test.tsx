// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DialogMessage, DialogSnapshot } from "../dialogs/dialogProtocol";
import { dialogEnvelope } from "../dialogs/dialogProtocol";
const host = vi.hoisted(() => ({ receive: undefined as ((message: DialogMessage) => void) | undefined, send: vi.fn(async (_host: string, _message: DialogMessage) => {}) }));
vi.mock("../dialogs/dialogTransport", () => ({ subscribeDialogHost: async (_id: string, receive: typeof host.receive) => { host.receive = receive; return () => {}; }, sendDialogMessage: host.send }));
vi.mock("../dialogs/useExportPreviewEnabled", () => ({ useExportPreviewEnabled: () => false }));
import { DialogWindow } from "../dialogs/DialogWindow";

it("opens a native journal form, previews independently of export preferences and deduplicates Apply", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const snapshot: DialogSnapshot = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "origin", dialogKind: "journalPresets", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Native origin", selectionCount: 1 } };
  try {
    await act(async () => root.render(createElement(DialogWindow, { hostId: "host" })));
    await act(async () => { host.receive!(snapshot); await vi.dynamicImportSettled(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    const messages = () => host.send.mock.calls.map(call => (call as unknown[])[1] as DialogMessage);
    expect(messages().some(message => message.type === "ready")).toBe(true);
    const preview = messages().filter(message => message.type === "action" && message.data.action === "preview").at(-1)!;
    expect(preview, JSON.stringify(messages()) + "\n" + container.textContent).toBeDefined();
    await act(async () => host.receive!({ ...dialogEnvelope(preview), type: "result", data: { status: "preview", preview: { url: "data:image/svg+xml;base64,PHN2Zy8+", kind: "image", width: 100, height: 100, warnings: [] } } }));
    const apply = [...container.querySelectorAll("button")].find(button => button.textContent === "Apply")!;
    expect(apply.disabled).toBe(false);
    await act(async () => { apply.click(); apply.click(); });
    expect(messages().filter(message => message.type === "action" && message.data.action === "apply")).toHaveLength(1);
    expect(container.textContent).toContain("Native origin");
  } finally { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
