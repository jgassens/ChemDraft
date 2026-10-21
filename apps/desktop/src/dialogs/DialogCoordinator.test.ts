import { exportFixture } from "./exportTestFixtures";
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

it("rejects stale previews and allows export while a preview is pending", async () => {
  let snap!: DialogMessage;
  const published: DialogMessage[] = [];
  const transport: DialogTransport = { subscribe: async () => () => {}, open: async message => { snap = message; return { hostId: "host", windowLabel: "dialog-main-export-1" }; }, publish: async (_id, message) => { published.push(message); }, close: async () => {} };
  const pending: { resolve(value: { url: string; kind: "image"; width: number; height: number; warnings: string[] }): void; live(): boolean }[] = [];
  const exporter = vi.fn(async () => ({ status: "exported" as const }));
  const coordinator = new DialogCoordinator(transport, { applyPageSize: () => {}, onError: vi.fn(), export: exporter,
    previewExport: async (_tab, _options, live) => new Promise(resolve => { pending.push({ resolve, live }); }) });
  await coordinator.openExport("tab-1", { title: "Drawing", options: exportFixture() });
  const send = (id: string, data: unknown, type = "action") => coordinator.receive({ senderWindowId: "dialog-main-export-1", windowLabel: "dialog-main-export-1", message: { ...dialogEnvelope(snap), requestId: id, type, data } });
  await coordinator.updateExportFrame("tab-1", { page: { width: 100, height: 100 }, content: { width: 80, height: 80 }, revision: 2 });
  coordinator.cancelExportPreviews();
  await send("ready", {}, "ready");
  expect(published).toHaveLength(0); // Disable discards a queued frame, without preview IPC.
  await coordinator.updateExportFrame("tab-1", { page: { width: 100, height: 100 }, content: { width: 80, height: 80 }, revision: 2 });
  expect(published.at(-1)).toMatchObject({ type: "result", data: { status: "frame", frame: { revision: 2 } } });
  published.length = 0;
  const first = send("preview-1", { action: "preview", options: exportFixture() });
  const second = send("preview-2", { action: "preview", options: exportFixture() });
  expect(pending[0]!.live()).toBe(false);
  await coordinator.updateExportFrame("tab-1", { page: { width: 100, height: 100 }, content: { width: 80, height: 80 }, revision: 3 });
  expect(pending[1]!.live()).toBe(false);
  published.length = 0;
  const preview = { url: "data:image/png;base64,AAAA", kind: "image" as const, width: 100, height: 100, warnings: [] };
  pending[0]!.resolve(preview); await first;
  expect(published).toHaveLength(0);
  const disabled = send("preview-disabled", { action: "preview", options: exportFixture() });
  coordinator.cancelExportPreviews();
  expect(pending[2]!.live()).toBe(false);
  pending[2]!.resolve(preview); await disabled;
  expect(published).toHaveLength(0);
  const oversized = send("preview-large", { action: "preview", options: exportFixture() });
  pending[3]!.resolve({ ...preview, url: "data:image/png;base64," + "A".repeat(5 * 1024 * 1024) });
  await oversized;
  expect(published.at(-1)).toMatchObject({ type: "result", data: { status: "error", error: expect.stringContaining("Reduce the content or export size") } });
  await send("export", { action: "export", options: exportFixture() });
  expect(exporter).toHaveBeenCalledOnce();
  expect(pending[1]!.live()).toBe(false);
  pending[1]!.resolve(preview); await second;
  expect(published.some(message => message.type === "result" && message.data.status === "preview")).toBe(false);
  await coordinator.dispose();
});

it("retains an engine install window, streams progress, allows cancellation, and dismisses on tab close", async () => {
  const { engineInstallFixture } = await import("./engineInstallTestFixtures");
  const h = host();
  const presenter = { action: vi.fn(), closed: vi.fn() };
  await h.coordinator.openEngineInstall("tab-1", engineInstallFixture(), presenter);
  await h.deliver(h.message("ready", {}));
  await h.coordinator.openEngineInstall("tab-1", engineInstallFixture(), presenter);
  expect(h.transport.open).toHaveBeenCalledTimes(2);
  const retained = vi.mocked(h.transport.open).mock.calls[0]![0];
  expect(vi.mocked(h.transport.open).mock.calls[1]![0]).toEqual(retained);
  let finish!: () => void;
  presenter.action.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
  const install = h.deliver(h.message("action", { action: "install" }));
  await Promise.resolve();
  await h.deliver(h.message("action", { action: "install" }, "double-click"));
  expect(presenter.action).toHaveBeenCalledExactlyOnceWith("install");
  await h.coordinator.openEngineInstall("tab-1", engineInstallFixture(), presenter);
  expect(h.transport.open).toHaveBeenCalledTimes(3);
  await h.coordinator.updateEngineInstall("tab-1", { ...engineInstallFixture(),
    state: { status: "installing", phase: "Installing Python", step: 2, steps: 5, bytesDone: 10, bytesTotal: 100, estimated: true },
    buttons: ["cancelInstall", "close"] });
  await h.deliver(h.message("action", { action: "cancelInstall" }, "cancel"));
  expect(presenter.action).toHaveBeenLastCalledWith("cancelInstall");
  await h.coordinator.closeTab("tab-1");
  expect(presenter.closed).toHaveBeenCalledOnce();
  expect(h.transport.close).toHaveBeenCalledWith("opaque", "ownerTabClose");
  finish(); await install;
  await h.coordinator.dispose();
});

it("cancels an engine opening while the previous failure window is closing", async () => {
  const { engineInstallFixture } = await import("./engineInstallTestFixtures");
  const h = host();
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  const presenter = { action: vi.fn(), closed: vi.fn() };
  const opening = h.coordinator.openEngineInstall("tab-1", engineInstallFixture(), presenter, closing);
  await h.coordinator.closeTab("tab-1");
  finishClose(); await opening;
  expect(h.transport.open).not.toHaveBeenCalled();
  expect(presenter.closed).toHaveBeenCalledOnce();
  await h.coordinator.dispose();
});
