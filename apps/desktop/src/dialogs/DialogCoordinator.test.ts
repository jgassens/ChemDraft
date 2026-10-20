import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogCoordinator } from "./DialogCoordinator";
import { dialogEnvelope, type DialogCloseReason, type DialogMessage } from "./dialogProtocol";
import type { DialogDelivery, DialogTransport } from "./dialogTransport";

function host(options: { timeout?: number } = {}) {
  const calls: string[] = [];
  let handler: (delivery: DialogDelivery) => void = () => {};
  let snapshot!: Extract<DialogMessage, { type: "snapshot" }>;
  const registration = { hostId: "opaque", windowLabel: "dialog-main-pageSize-1" };
  const transport: DialogTransport = {
    subscribe: vi.fn(async h => { calls.push("subscribe"); handler = h; return vi.fn(); }),
    open: vi.fn(async s => { calls.push("open"); snapshot = s as typeof snapshot; return registration; }),
    publish: vi.fn(async () => {}), close: vi.fn(async () => {})
  };
  const owner = { applyPageSize: vi.fn<(tabId: string, size: unknown) => void | Promise<void>>(), onError: vi.fn(), onSettled: vi.fn() };
  const coordinator = new DialogCoordinator(transport, owner, { readyTimeoutMs: options.timeout ?? 100 });
  const open = () => coordinator.openPageSize("tab-1", { title: "Drawing", width: 8.5, height: 11, unit: "inch" });
  const message = (type: DialogMessage["type"], data: unknown, requestId = "action-1") => ({ ...dialogEnvelope(snapshot), type, data, requestId }) as DialogMessage;
  const deliver = (m: DialogMessage, sender = registration.windowLabel) => coordinator.receive({ message: m, senderWindowId: sender, windowLabel: registration.windowLabel });
  return { calls, transport, owner, coordinator, open, message, deliver, replay: () => handler({ message: snapshot, senderWindowId: "main", windowLabel: registration.windowLabel }) };
}
afterEach(() => vi.useRealTimers());
describe("DialogCoordinator", () => {
  it("cancels an opening while subscription is still pending", async () => {
    const h = host();
    let subscribed!: (stop: () => void) => void;
    vi.mocked(h.transport.subscribe).mockImplementation(() => new Promise(resolve => { subscribed = resolve; }));
    const opening = h.open();
    await h.coordinator.closeTab("tab-1");
    subscribed(vi.fn()); await opening;
    expect(h.transport.open).not.toHaveBeenCalled();
    expect(h.owner.onSettled).toHaveBeenCalledExactlyOnceWith("tab-1", "ownerTabClose");
    await h.coordinator.dispose();
  });
  it("reopens the retained native session to focus it without replacing its snapshot", async () => {
    const h = host(); await h.open();
    const retained = vi.mocked(h.transport.open).mock.calls[0]![0];
    await h.coordinator.openPageSize("tab-1", { title: "Changed", width: 1, height: 2, unit: "mm" });
    expect(h.transport.open).toHaveBeenNthCalledWith(2, retained);
    await h.coordinator.dispose();
  });
  it("reserves a session across distinct Apply IDs and the pending success receipt", async () => {
    const h = host(); await h.open(); await h.deliver(h.message("ready", {}));
    let finish!: () => void;
    h.owner.applyPageSize.mockImplementation(() => new Promise<void>(r => { finish = r; }));
    let published!: () => void;
    vi.mocked(h.transport.publish).mockImplementation(async (_id, message) => { if (message.type === "result" && message.data.status !== "accepted") await new Promise<void>(r => { published = r; }); });
    const action = h.message("action", { action: "apply", width: 10, height: 15, unit: "mm" });
    const first = h.deliver(action);
    await h.deliver({ ...action, requestId: "action-2" });
    expect(h.owner.applyPageSize).toHaveBeenCalledTimes(1);
    finish(); await Promise.resolve(); await Promise.resolve();
    await h.deliver({ ...action, requestId: "action-3" });
    expect(h.owner.applyPageSize).toHaveBeenCalledTimes(1);
    published(); await first;
    expect(h.owner.onSettled).toHaveBeenCalledExactlyOnceWith("tab-1", "apply");
    await h.coordinator.dispose();
  });
  it("allows a new terminal request only after the operation fails", async () => {
    const h = host(); await h.open(); await h.deliver(h.message("ready", {}));
    h.owner.applyPageSize.mockRejectedValueOnce(new Error("Finish gesture"));
    const action = h.message("action", { action: "apply", width: 10, height: 15, unit: "mm" });
    await h.deliver(action);
    await h.deliver({ ...action, requestId: "retry" });
    expect(h.owner.applyPageSize).toHaveBeenCalledTimes(2);
    expect(h.owner.onSettled).toHaveBeenCalledExactlyOnceWith("tab-1", "apply");
    await h.coordinator.dispose();
  });
  it("subscribes before opening, replays a request and does not replace a live draft", async () => {
    const h = host(); await h.open();
    expect(h.calls).toEqual(["subscribe", "open"]);
    await h.deliver(h.message("request", {}));
    expect(h.transport.publish).toHaveBeenCalledWith("opaque", expect.objectContaining({ type: "snapshot" }));
    await h.open(); expect(h.transport.open).toHaveBeenCalledTimes(2);
    await h.coordinator.dispose();
  });
  it("deduplicates concurrent action IDs and settles apply once", async () => {
    const h = host(); await h.open(); await h.deliver(h.message("ready", {}));
    let finish!: () => void;
    h.owner.applyPageSize.mockImplementation(() => new Promise<void>(r => { finish = r; }));
    const m = h.message("action", { action: "apply", width: 10, height: 15, unit: "mm" });
    const first = h.deliver(m); const duplicate = h.deliver(m);
    await Promise.resolve();
    expect(h.owner.applyPageSize).toHaveBeenCalledTimes(1); finish(); await Promise.all([first, duplicate]);
    expect(h.owner.applyPageSize).toHaveBeenCalledWith("tab-1", m.data);
    expect(h.owner.onSettled).toHaveBeenCalledTimes(1);
    expect(h.transport.close).toHaveBeenCalledWith("opaque", "apply");
    await h.deliver(h.message("closed", { reason: "destroy" }), "main");
    expect(h.owner.onSettled).toHaveBeenCalledTimes(1); await h.coordinator.dispose();
  });
  it("returns the earlier failed receipt without repeating an operation", async () => {
    const h = host(); await h.open(); await h.deliver(h.message("ready", {}));
    h.owner.applyPageSize.mockImplementation(() => { throw new Error("Finish the gesture"); });
    const m = h.message("action", { action: "apply", width: 10, height: 15, unit: "inch" });
    await h.deliver(m); await h.deliver(m);
    expect(h.owner.applyPageSize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.transport.publish).mock.calls[1]![1]).toEqual(vi.mocked(h.transport.publish).mock.calls[2]![1]);
    await h.coordinator.dispose();
  });
  it.each<DialogCloseReason>(["cancel", "close", "destroy", "ownerTabClose", "ownerClose", "quit", "error"])("settles %s exactly once", async reason => {
    const h = host(); await h.open(); await h.deliver(h.message("ready", {}));
    if (reason === "cancel") await h.deliver(h.message("action", { action: "cancel" }));
    else if (reason === "ownerTabClose") await h.coordinator.closeTab("tab-1");
    else if (reason === "quit" || reason === "ownerClose") await h.coordinator.dispose(reason);
    else await h.deliver(h.message("closed", { reason }), "main");
    await h.deliver(h.message("closed", { reason: "destroy" }), "main");
    await h.coordinator.dispose(); expect(h.owner.onSettled).toHaveBeenCalledExactlyOnceWith("tab-1", reason);
    expect(h.owner.applyPageSize).not.toHaveBeenCalled();
    if (reason === "error") expect(h.owner.onError).toHaveBeenCalledTimes(1);
  });
  it("rejects a wrong caller, stale session/revision and nonready action", async () => {
    const h = host(); await h.open();
    const m = h.message("action", { action: "apply", width: 10, height: 15, unit: "inch" });
    await h.deliver(m); await h.deliver(h.message("ready", {}));
    await h.deliver(m, "preferences"); await h.deliver({ ...m, sessionId: "old" }); await h.deliver({ ...m, snapshotRevision: 2 });
    expect(h.owner.applyPageSize).not.toHaveBeenCalled(); await h.coordinator.dispose();
  });
  it("times out missing ready with an error and no automatic retry", async () => {
    vi.useFakeTimers(); const h = host(); await h.open();
    await vi.advanceTimersByTimeAsync(101);
    expect(h.owner.onError).toHaveBeenCalledWith(expect.stringContaining("did not become ready"));
    expect(h.transport.open).toHaveBeenCalledTimes(1); expect(h.transport.close).toHaveBeenCalledWith("opaque", "error");
    await h.deliver(h.message("ready", {})); expect(h.owner.onSettled).toHaveBeenCalledTimes(1); await h.coordinator.dispose();
  });
  it("closes a late creation after originating tab close", async () => {
    const h = host(); let finish!: (r: { hostId: string; windowLabel: string }) => void;
    vi.mocked(h.transport.open).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const opening = h.open(); await Promise.resolve(); await Promise.resolve();
    await h.coordinator.closeTab("tab-1"); finish({ hostId: "late", windowLabel: "dialog-main-pageSize-1" }); await opening;
    expect(h.transport.close).toHaveBeenCalledWith("late", "ownerTabClose"); expect(h.owner.onSettled).toHaveBeenCalledTimes(1); await h.coordinator.dispose();
  });
});
