import { describe, expect, it, vi } from "vitest";
const snapshot = () => ({ protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab-1", dialogKind: "pageSize", sessionId: "session-1", requestId: "request-1", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing", width: 8.5, height: 11, unit: "inch" } });
const ipc = vi.hoisted(() => ({ channels: [] as { onmessage(value: unknown): void }[], invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke, Channel: class { onmessage = (_value: unknown) => {}; constructor() { ipc.channels.push(this); } } }));
import { subscribeDialogHost } from "./dialogTransport";
const previewDelivery = () => ({ senderWindowId: "main", windowLabel: "dialog-main-export-1", message: { ...snapshot(), dialogKind: "export", type: "result", data: { status: "preview", preview: { url: "data:image/png;base64," + "A".repeat(20000), kind: "image", width: 500, height: 300, warnings: [] } } } });
function chunks(value: unknown) {
  const text = JSON.stringify(value), parts = text.match(/.{1,256}/gu)!;
  return parts.map((text, index) => ({ previewChunk: { requestId: "request-1", index, total: parts.length, text } }));
}
describe("private preview chunks", () => {
  it("reassembles only complete ordered preview deliveries and clears on unsubscribe", async () => {
    const handler = vi.fn(), stop = await subscribeDialogHost("host", handler);
    const channel = ipc.channels.at(-1)!;
    const parts = chunks(previewDelivery());
    channel.onmessage(parts[1]);
    expect(handler).not.toHaveBeenCalled();
    for (const part of parts) channel.onmessage(part);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toEqual(previewDelivery().message);
    channel.onmessage(parts[0]); stop();
    for (const part of parts.slice(1)) channel.onmessage(part);
    expect(handler).toHaveBeenCalledOnce();
  });
  it("rejects malformed chunks, sender spoofing, non-preview payloads and mismatched IDs", async () => {
    const handler = vi.fn(), stop = await subscribeDialogHost("host", handler);
    const channel = ipc.channels.at(-1)!;
    channel.onmessage(null);
    channel.onmessage({ previewChunk: { requestId: "request-1", index: 0, total: 10000000, text: "x" } });
    for (const value of [null, { ...previewDelivery(), senderWindowId: "other" }, { ...previewDelivery(), message: { ...previewDelivery().message, requestId: "wrong" } }, { ...previewDelivery(), message: { ...snapshot(), type: "result", data: { status: "applied" } } }]) {
      for (const part of chunks(value)) channel.onmessage(part);
    }
    expect(handler).not.toHaveBeenCalled(); stop();
  });
});
