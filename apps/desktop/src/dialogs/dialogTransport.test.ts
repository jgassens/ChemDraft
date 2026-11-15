import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogDelivery } from "./dialogTransport";
const native = vi.hoisted(() => ({
  events: new Map<string, (e: { payload: DialogDelivery }) => void>(),
  invoke: vi.fn(),
  channels: [] as { onmessage: (delivery: DialogDelivery) => void }[]
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage = (_delivery: DialogDelivery) => {};
    constructor() { native.channels.push(this); }
  }
}));
vi.mock("../window-manager/tauriEvents", () => ({ listenCurrentWindowEvent: async (name: string, handler: (e: { payload: DialogDelivery }) => void) => {
  native.events.set(name, handler); return () => native.events.delete(name);
} }));
import { nativeDialogTransport, sendDialogMessage, subscribeDialogHost } from "./dialogTransport";
import { DialogCoordinator } from "./DialogCoordinator";
import type { DialogMessage } from "./dialogProtocol";
const snapshot: DialogMessage = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "pageSize", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing", width: 8, height: 11, unit: "inch" } };
const delivery = (message: DialogMessage, senderWindowId = "main"): DialogDelivery =>
  ({ senderWindowId, windowLabel: "dialog-main-pageSize-1", message });
afterEach(() => { vi.clearAllMocks(); native.channels.length = 0; native.events.clear(); });
describe("authenticated native dialog channels", () => {
  it("receives and sends either real owner and refuses mismatched labels or senders", async () => {
    for (const ownerWindowId of ["main", "doc-a", "doc-b"]) {
      const message = { ...snapshot, ownerWindowId };
      const windowLabel = `dialog-${ownerWindowId}-pageSize-1`;
      const receive = vi.fn();
      native.invoke.mockResolvedValue(undefined);
      const stop = await subscribeDialogHost(`host-${ownerWindowId}`, receive);
      const channel = native.channels.at(-1)!;
      channel.onmessage({ message, windowLabel, senderWindowId: ownerWindowId });
      expect(receive).toHaveBeenCalledExactlyOnceWith(message);
      for (const forged of [
        { message, windowLabel, senderWindowId: "toolset-core-main" },
        { message, windowLabel: "dialog-doc-foreign-pageSize-1", senderWindowId: ownerWindowId },
        { message: { ...message, ownerWindowId: "doc-foreign" }, windowLabel: "dialog-doc-foreign-pageSize-1", senderWindowId: "doc-foreign" },
        { message, windowLabel: `dialog-${ownerWindowId}-export-1`, senderWindowId: ownerWindowId },
        { message, windowLabel: "dialog-main-pageSize-../main", senderWindowId: ownerWindowId }
      ]) channel.onmessage(forged);
      expect(receive).toHaveBeenCalledTimes(1);
      const ready: DialogMessage = { ...message, type: "ready", data: {} };
      await sendDialogMessage(`host-${ownerWindowId}`, ready);
      expect(native.invoke).toHaveBeenLastCalledWith("dialog_send", { hostId: `host-${ownerWindowId}`, message: ready });
      const calls = native.invoke.mock.calls.length;
      await expect(sendDialogMessage(`host-${ownerWindowId}`, { ...ready, ownerWindowId: "doc-foreign" })).rejects.toThrow("Invalid dialog message");
      expect(native.invoke).toHaveBeenCalledTimes(calls);
      stop();
      await expect(sendDialogMessage(`host-${ownerWindowId}`, ready)).rejects.toThrow("Invalid dialog message");
    }
  });
  it("ignores forged owner actions and closed events even with the observed session and exact sender fields", async () => {
    const applyPageSize = vi.fn(); const onSettled = vi.fn();
    let opened!: DialogMessage;
    native.invoke.mockImplementation(async (command: string, args: { message?: DialogMessage }) => {
      if (command === "dialog_open") { opened = args.message!; return { hostId: "opaque", windowLabel: "dialog-main-pageSize-1" }; }
    });
    const coordinator = new DialogCoordinator(nativeDialogTransport, { applyPageSize, onSettled, onError: vi.fn() });
    await coordinator.openPageSize("tab", { title: "Drawing", width: 8, height: 11, unit: "inch" });
    // Legitimate Rust channel establishes ready. The observed envelope is now known to an attacker.
    const ready = delivery({ ...opened, type: "ready", data: {} }, "dialog-main-pageSize-1");
    // The fallback also lets this regression reproduce the original event-bus vulnerability.
    if (native.channels[0]) native.channels[0].onmessage(ready);
    else native.events.get("chemdraft://dialog-owner")?.({ payload: ready });
    await Promise.resolve();
    const action: DialogMessage = { ...opened, requestId: "apply", type: "action", data: { action: "apply", width: 20, height: 30, unit: "mm" } };
    const bus = native.events.get("chemdraft://dialog-owner");
    bus?.({ payload: delivery(action, "dialog-main-pageSize-1") });
    bus?.({ payload: delivery({ ...opened, type: "closed", data: { reason: "destroy" } }) });
    await Promise.resolve(); await Promise.resolve();
    expect(applyPageSize).not.toHaveBeenCalled(); expect(onSettled).not.toHaveBeenCalled();
    expect(native.events.size).toBe(0);
    // Only Rust's private channel reaches the document-changing callback.
    native.channels[0]!.onmessage(delivery(action, "dialog-main-pageSize-1"));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(applyPageSize).toHaveBeenCalledExactlyOnceWith("tab", action.data);
    await coordinator.dispose();
  });
  it("registers the host channel before bootstrap and ignores event-bus snapshot/result forgeries", async () => {
    const receive = vi.fn();
    native.invoke.mockImplementation(async (_command: string, args: { channel: typeof native.channels[number] }) => {
      if (args.channel) args.channel.onmessage(delivery(snapshot));
      else native.events.get("chemdraft://dialog-host")?.({ payload: delivery(snapshot) });
    });
    const stop = await subscribeDialogHost("opaque", receive);
    expect(receive).toHaveBeenCalledExactlyOnceWith(snapshot);
    const forged = { ...snapshot, data: { ...snapshot.data, title: "Attacker" } } as DialogMessage;
    native.events.get("chemdraft://dialog-host")?.({ payload: delivery(forged) });
    native.events.get("chemdraft://dialog-host")?.({ payload: delivery({ ...snapshot, type: "result", data: { status: "applied" } }) });
    expect(receive).toHaveBeenCalledTimes(1); expect(native.events.size).toBe(0);
    expect(native.invoke).toHaveBeenCalledWith("dialog_request", expect.objectContaining({ channel: native.channels[0] }));
    native.channels[0]!.onmessage(delivery({ ...snapshot, dialogKind: "unknown" } as unknown as DialogMessage));
    expect(receive).toHaveBeenCalledTimes(1);
    stop(); native.channels[0]!.onmessage(delivery(snapshot)); expect(receive).toHaveBeenCalledTimes(1);
  });
  it("deactivates the channel if bootstrap fails, without retry", async () => {
    const receive = vi.fn();
    native.invoke.mockRejectedValue(new Error("Unknown host"));
    await expect(subscribeDialogHost("wrong", receive)).rejects.toThrow("Unknown host");
    native.channels[0]!.onmessage(delivery(snapshot));
    expect(receive).not.toHaveBeenCalled(); expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
