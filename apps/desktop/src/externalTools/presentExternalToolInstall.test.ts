import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { dialogEnvelope, type DialogMessage, type ToolInstallAction } from "../dialogs/dialogProtocol";
import type { DialogTransport } from "../dialogs/dialogTransport";
import { ExternalToolsController } from "./ExternalToolsController";
import { UnsupportedExternalToolsEngine, type ExternalToolStatus } from "./externalToolsEngine";
import { presentExternalToolInstall } from "./presentExternalToolInstall";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const plugin = { id: "plugin", name: "Plugin" };
const other = { id: "other", name: "Other" };
const request = { tool: "claude" as const, conversationId: "conversation", prompt: "p", systemPrompt: "s", mcpSessionId: "" };
const status = (consented = false): ExternalToolStatus => ({ tool: "claude", publisher: "Anthropic", state: "missing", pinnedVersion: "2", pinnedDownloadBytes: 100, freeDiskBytes: null, canInstall: true, consented, probedAt: "now" });
const coordinators: DialogCoordinator[] = [];
afterEach(async () => { for (const coordinator of coordinators.splice(0)) await coordinator.dispose(); });

function host(consented = false) {
  const engine = new UnsupportedExternalToolsEngine();
  vi.spyOn(engine, "status").mockImplementation(async () => status(consented));
  vi.spyOn(engine, "consentSet").mockResolvedValue();
  vi.spyOn(engine, "install").mockResolvedValue({});
  vi.spyOn(engine, "cancelInstall").mockResolvedValue();
  vi.spyOn(engine, "runStart").mockResolvedValue({ runId: "run", pid: 1, cwd: "/tmp", startedAt: "now" });
  vi.spyOn(engine, "runCancel").mockResolvedValue();
  const snapshots: DialogMessage[] = [];
  const registration = { hostId: "host", windowLabel: "dialog-main-toolInstall-1" };
  const transport: DialogTransport = {
    subscribe: vi.fn(async () => vi.fn()),
    open: vi.fn(async snapshot => { snapshots.push(snapshot); return registration; }),
    publish: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  };
  const coordinator = new DialogCoordinator(transport, { applyPageSize: vi.fn(), onError: vi.fn() });
  coordinators.push(coordinator);
  const controller = new ExternalToolsController(engine);
  presentExternalToolInstall(controller, { coordinator: () => coordinator, documentTabId: () => "tab" });
  const send = (type: "ready" | "action", data: object) => coordinator.receive({
    senderWindowId: registration.windowLabel, windowLabel: registration.windowLabel,
    message: { ...dialogEnvelope(snapshots.at(-1)!), requestId: crypto.randomUUID(), type, data }
  });
  const ready = () => send("ready", {});
  const action = (action: ToolInstallAction) => send("action", { action });
  const opened = (count = 1) => vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(count));
  const install = (who = plugin) => controller.install(who, { tool: "claude" }, new AbortController().signal);
  return { engine, transport, coordinator, controller, snapshots, ready, action, opened, install };
}

describe("external tool native dialog flow", () => {
  it.each([false, true])("rejects tools.install with the original open error (consented=%s)", async consented => {
    const h = host(consented); const error = new Error("Native dialog open rejected");
    vi.mocked(h.transport.open).mockRejectedValueOnce(error);
    await expect(h.install()).rejects.toBe(error);
    expect(h.engine.install).not.toHaveBeenCalled();
  });

  it("rejects tools.install when a snapshot update is rejected", async () => {
    const h = host(true); const pending = h.install();
    await h.opened(); await h.ready();
    const error = new Error("Native update rejected");
    vi.mocked(h.transport.publish).mockImplementation(async (_host, message) => { if (message.type === "snapshot") throw error; });
    const rejection = expect(pending).rejects.toBe(error);
    await h.action("install"); await rejection;
    expect(h.engine.install).not.toHaveBeenCalled();
  });

  it("unloading during consent closes the dialog, rejects the run, and never starts a process", async () => {
    const h = host(); const run = h.controller.run(plugin, request);
    await h.opened(); await h.ready();
    const rejection = expect(run).rejects.toThrow("plugin was unloaded");
    h.controller.cancelAllForPlugin(plugin.id);
    await rejection;
    expect(h.transport.close).toHaveBeenCalledOnce();
    expect(h.engine.runStart).not.toHaveBeenCalled();
    await h.action("allow");
    expect(h.engine.consentSet).not.toHaveBeenCalled();
  });

  it("waits for a cancelled pending native open before opening the next queued consent", async () => {
    const h = host(); const opening = deferred<{ hostId: string; windowLabel: string }>();
    vi.mocked(h.transport.open).mockImplementationOnce(snapshot => { h.snapshots.push(snapshot); return opening.promise; });
    const first = h.controller.run(plugin, request);
    const second = h.controller.run(other, request);
    await h.opened();
    const rejection = expect(first).rejects.toThrow("plugin was unloaded");
    h.controller.cancelAllForPlugin(plugin.id); await rejection;
    expect(h.transport.open).toHaveBeenCalledOnce();
    opening.resolve({ hostId: "host", windowLabel: "dialog-main-toolInstall-1" });
    await h.opened(2); await h.ready(); await h.action("allow"); await second;
    expect(h.transport.close).toHaveBeenCalledTimes(2);
    expect(h.engine.runStart).toHaveBeenCalledExactlyOnceWith({ ...request, pluginId: other.id });
  });

  it("shares consent for concurrent requests by the same plugin and tool", async () => {
    const h = host();
    const saving = deferred<void>(); vi.mocked(h.engine.consentSet).mockReturnValue(saving.promise);
    const first = h.controller.run(plugin, request);
    const second = h.controller.run(plugin, request);
    let secondSettled = false; void second.then(() => { secondSettled = true; });
    await h.opened(); await h.ready();
    expect(secondSettled).toBe(false);
    await h.action("allow");
    expect(secondSettled).toBe(false);
    saving.resolve();
    await expect(first).resolves.toMatchObject({ runId: "run" });
    await expect(second).resolves.toMatchObject({ runId: "run" });
    expect(h.transport.open).toHaveBeenCalledOnce();
    expect(h.engine.consentSet).toHaveBeenCalledOnce();
    expect(h.engine.runStart).toHaveBeenCalledTimes(2);
  });

  it("queues different plugins until the first consent window has finished closing", async () => {
    const h = host(); const closing = deferred<void>();
    vi.mocked(h.transport.close).mockReturnValueOnce(closing.promise);
    const first = h.controller.run(plugin, request);
    const second = h.controller.run(other, request);
    let secondSettled = false; void second.then(() => { secondSettled = true; });
    await h.opened(); await h.ready(); await h.action("allow");
    await expect(first).resolves.toMatchObject({ runId: "run" });
    expect(secondSettled).toBe(false);
    expect(h.transport.open).toHaveBeenCalledOnce();
    closing.resolve();
    await h.opened(2); await h.ready(); await h.action("allow");
    await expect(second).resolves.toMatchObject({ runId: "run" });
  });

  it("rejects a queued consent request immediately when its plugin unloads", async () => {
    const h = host(); const first = h.controller.run(plugin, request);
    const second = h.controller.run(other, request);
    await h.opened(); await h.ready();
    const rejection = expect(second).rejects.toThrow("plugin was unloaded");
    h.controller.cancelAllForPlugin(other.id); await rejection;
    expect(h.transport.close).not.toHaveBeenCalled();
    await h.action("allow"); await first;
    await vi.waitFor(() => expect(h.engine.runStart).toHaveBeenCalledOnce());
    expect(h.transport.open).toHaveBeenCalledOnce();
  });

  it("settles both shared consent requests when consent is declined", async () => {
    const h = host();
    const first = h.controller.run(plugin, request);
    const second = h.controller.run(plugin, request);
    const rejections = [expect(first).rejects.toThrow("declined"), expect(second).rejects.toThrow("declined")];
    await h.opened(); await h.ready(); await h.action("close");
    await Promise.all(rejections);
    expect(h.transport.open).toHaveBeenCalledOnce();
    expect(h.engine.runStart).not.toHaveBeenCalled();
  });

  it("rejects a queued installation on unload without closing another plugin's window", async () => {
    const h = host(true); const first = h.install(); const second = h.install(other);
    await h.opened(); await h.ready();
    const rejection = expect(second).rejects.toThrow("plugin was unloaded");
    h.controller.cancelAllForPlugin(other.id); await rejection;
    expect(h.transport.close).not.toHaveBeenCalled();
    await h.action("install"); await first; await h.action("close");
    expect(h.transport.open).toHaveBeenCalledOnce();
    expect(h.engine.install).toHaveBeenCalledOnce();
  });

  it("queues install requests until the first installed dialog is closed", async () => {
    const h = host(true); const first = h.install(); const second = h.install(other);
    let secondSettled = false; void second.then(() => { secondSettled = true; });
    await h.opened(); await h.ready(); await h.action("install"); await first;
    expect(h.transport.open).toHaveBeenCalledOnce(); expect(secondSettled).toBe(false);
    await h.action("close");
    await h.opened(2); await h.ready(); await h.action("install"); await second;
    expect(h.engine.install).toHaveBeenCalledTimes(2);
  });

  it("offers a working retry after a broken install and a download failure", async () => {
    const h = host(true);
    vi.mocked(h.engine.status).mockResolvedValueOnce({ ...status(true), state: "broken", detail: "Missing receipt" });
    vi.mocked(h.engine.install).mockRejectedValueOnce(new Error("Download failed"));
    const pending = h.install(); await h.opened(); await h.ready();
    await h.action("install");
    expect(vi.mocked(h.transport.publish).mock.calls.at(-1)?.[1]).toMatchObject({ data: { state: { status: "failed" }, buttons: ["install", "close"] } });
    await h.action("install");
    await expect(pending).resolves.toMatchObject({ consented: true });
    expect(h.engine.install).toHaveBeenCalledTimes(2);
  });
});
