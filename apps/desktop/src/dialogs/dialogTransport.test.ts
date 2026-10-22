import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogDelivery } from "./dialogTransport";
const native = vi.hoisted(() => ({
  events: new Map<string, (e: { payload: DialogDelivery }) => void>(),
  invoke: vi.fn(),
  channels: [] as { onmessage: (delivery: DialogDelivery) => void }[]
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({label:"main"}) }));
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
import { nativeDialogTransport, subscribeDialogHost } from "./dialogTransport";
import { DialogCoordinator } from "./DialogCoordinator";
import type { DialogMessage } from "./dialogProtocol";
const snapshot: DialogMessage = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "pageSize", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "snapshot", data: { title: "Drawing", width: 8, height: 11, unit: "inch" } };
const delivery = (message: DialogMessage, senderWindowId = "main"): DialogDelivery =>
  ({ senderWindowId, windowLabel: "dialog-main-pageSize-1", message });
afterEach(() => { vi.clearAllMocks(); native.channels.length = 0; native.events.clear(); });
describe("authenticated native dialog channels", () => {
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
