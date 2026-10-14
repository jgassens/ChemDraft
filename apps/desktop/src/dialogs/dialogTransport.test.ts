import { afterEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ calls: [] as string[], handler: undefined as ((e: { payload: unknown }) => void) | undefined, invoke: vi.fn(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("../window-manager/tauriEvents", () => ({ listenCurrentWindowEvent: async (_name: string, handler: typeof native.handler) => {
  native.calls.push("subscribe"); native.handler = handler; return native.stop;
} }));
import { subscribeDialogHost } from "./dialogTransport";
import type { DialogMessage } from "./dialogProtocol";
const snapshot: DialogMessage = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "pageSize", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing", width: 8, height: 11, unit: "inch" } };
afterEach(() => { vi.clearAllMocks(); native.calls.length = 0; });
describe("native dialog bootstrap", () => {
  it("subscribes before requesting and receives the snapshot replay synchronously during the request", async () => {
    const receive = vi.fn();
    native.invoke.mockImplementation(async (command: string) => { native.calls.push(command); native.handler!({ payload: { senderWindowId: "main", windowLabel: "dialog-main-pageSize-1", message: snapshot } }); });
    const stop = await subscribeDialogHost("opaque", receive);
    expect(native.calls).toEqual(["subscribe", "dialog_request"]); expect(receive).toHaveBeenCalledExactlyOnceWith(snapshot);
    native.handler!({ payload: { senderWindowId: "preferences", message: snapshot } });
    native.handler!({ payload: { senderWindowId: "main", message: { ...snapshot, dialogKind: "unknown" } } });
    expect(receive).toHaveBeenCalledTimes(1); stop(); expect(native.stop).toHaveBeenCalledTimes(1);
  });
  it("removes the listener if bootstrap fails, without retry", async () => {
    native.invoke.mockRejectedValue(new Error("Unknown host"));
    await expect(subscribeDialogHost("wrong", vi.fn())).rejects.toThrow("Unknown host");
    expect(native.stop).toHaveBeenCalledTimes(1); expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
