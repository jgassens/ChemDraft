import { createEmptyDocument } from "@chemdraft/chem-core";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogCoordinator } from "../dialogs/DialogCoordinator";
import { dialogEnvelope, type DialogMessage, type EngineInstallSnapshot } from "../dialogs/dialogProtocol";
import type { DialogTransport } from "../dialogs/dialogTransport";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { RuntimeBroker } from "./runtimeBroker";
import type { RuntimeDocumentPort } from "./runtimeBrokerDocument";
import { bindRuntimeDialogs, createRuntimeDialogClient } from "./runtimeDialogs";
import { ExternalToolsController } from "../externalTools/ExternalToolsController";
import { UnsupportedExternalToolsEngine } from "../externalTools/externalToolsEngine";
import { presentExternalToolInstall } from "../externalTools/presentExternalToolInstall";

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
const snapshot: EngineInstallSnapshot = { engineName: "Naming", title: "Install Naming Engine", pluginName: "Test",
  pluginId: "org.test", disclosure: "Runs locally", requiredDiskBytes: 0, freeDiskBytes: 0,
  state: { status: "notInstalled" }, buttons: ["install", "close"] };

function documentClient(windowId: string, channels: RuntimeTestChannels) {
  const broker = new RuntimeBroker(windowId, channels.transport(windowId));
  let document: ReturnType<typeof createEmptyDocument> | undefined = createEmptyDocument();
  const transport: DialogTransport = { subscribe: vi.fn(async () => () => {}),
    open: vi.fn(async value => ({ hostId: windowId, windowLabel: `dialog-${windowId}-${value.dialogKind}-1` })),
    publish: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const coordinator = new DialogCoordinator(transport, { applyPageSize: vi.fn(), onError: vi.fn() }, { ownerWindowId: windowId, readyTimeoutMs: 30_000 });
  const port: RuntimeDocumentPort = { windowId, commandRegistry: new CommandRegistry(), activeTabId: () => "same-tab",
    read: tab => tab === "same-tab" && document ? { document, documentKey: `drawing-${windowId}` } : undefined,
    selection: () => ({ objectIds: [], molecules: [] }), runWrite: async commit => { throw new Error(String(commit)); }, commit: () => { throw new Error("Unexpected write"); } };
  const stop = bindRuntimeDialogs(broker, port, () => coordinator);
  stops.push(() => broker.dispose(), () => coordinator.dispose(), stop);
  const deliver = async (type: "ready" | "action", action?: "install" | "close" | "allow") => {
    const value = vi.mocked(transport.open).mock.calls.at(-1)![0];
    const label = `dialog-${windowId}-${value.dialogKind}-1`;
    await coordinator.receive({ senderWindowId: label, windowLabel: label,
      message: { ...dialogEnvelope(value), type, data: action ? { action } : {}, requestId: crypto.randomUUID() } as DialogMessage });
  };
  return { transport, deliver, close: () => { document = undefined; }, target: { windowId, tabId: "same-tab", documentKey: `drawing-${windowId}` } };
}

describe("runtime dialog requests", () => {
  it("captures external-tool consent before status awaits and opens through that document's coordinator", async () => {
    const channels = new RuntimeTestChannels(), broker = new RuntimeBroker("runtime", channels.transport("runtime"));
    const client = createRuntimeDialogClient(broker); stops.push(() => broker.dispose(), client.dispose);
    const a = documentClient("doc-a", channels), b = documentClient("doc-b", channels);
    const engine = new UnsupportedExternalToolsEngine();
    let finishStatus!: () => void;
    vi.spyOn(engine, "status").mockImplementation(() => new Promise(resolve => {
      finishStatus = () => resolve({ tool: "claude", publisher: "Anthropic", state: "missing", pinnedVersion: "2",
        pinnedDownloadBytes: 100, freeDiskBytes: null, canInstall: true, consented: false, probedAt: "now" });
    }));
    const controller = new ExternalToolsController(engine);
    const presenter = presentExternalToolInstall(controller, { coordinator: target => target && client.forTarget(target), documentTabId: () => "active-neighbor" });
    stops.push(presenter);
    const pending = controller.install({ id: "org.test", name: "Test" }, { tool: "claude" }, new AbortController().signal, {
      target: { windowId: a.target.windowId, tabId: a.target.tabId }, getDocumentKey: () => a.target.documentKey,
      getDocument: () => undefined, getSelection: () => ({ objectIds: [], molecules: [] }), applyDocumentPatch: () => { throw new Error("Unexpected write"); }
    });
    const rejected = expect(pending).rejects.toThrow("declined");
    finishStatus();
    await vi.waitFor(() => expect(a.transport.open).toHaveBeenCalledTimes(1));
    expect(b.transport.open).not.toHaveBeenCalled();
    expect(vi.mocked(a.transport.open).mock.calls[0]![0]).toMatchObject({ dialogKind: "toolInstall", ownerWindowId: "doc-a", documentTabId: "same-tab" });
    await a.deliver("ready"); await a.deliver("action", "close"); await rejected;
  });

  it("opens and replies in the requesting window with independent same-tab sessions", async () => {
    const channels = new RuntimeTestChannels();
    const broker = new RuntimeBroker("runtime", channels.transport("runtime"));
    const client = createRuntimeDialogClient(broker);
    stops.push(() => broker.dispose(), client.dispose);
    const a = documentClient("doc-a", channels), b = documentClient("doc-b", channels);
    const actionA = vi.fn(), actionB = vi.fn();
    const requestA = client.forTarget(a.target), requestB = client.forTarget(b.target);
    await requestA.openEngineInstall("same-tab", snapshot, { action: actionA, closed: vi.fn() });
    expect(a.transport.open).toHaveBeenCalledTimes(1); expect(b.transport.open).not.toHaveBeenCalled();
    await requestB.openEngineInstall("same-tab", snapshot, { action: actionB, closed: vi.fn() });
    expect(vi.mocked(a.transport.open).mock.calls[0]![0]).toMatchObject({ ownerWindowId: "doc-a", documentTabId: "same-tab" });
    expect(vi.mocked(b.transport.open).mock.calls[0]![0]).toMatchObject({ ownerWindowId: "doc-b", documentTabId: "same-tab" });
    await a.deliver("ready"); await b.deliver("ready"); await a.deliver("action", "install");
    expect(actionA).toHaveBeenCalledExactlyOnceWith("install"); expect(actionB).not.toHaveBeenCalled();
    await requestA.closeEngineInstall("same-tab");
    expect(a.transport.close).toHaveBeenCalled(); expect(b.transport.close).not.toHaveBeenCalled();
    await b.deliver("action", "install"); expect(actionB).toHaveBeenCalledExactlyOnceWith("install");
    const id = channels.deliveries.find(({ recipient, message }) => recipient === "doc-a" && message.kind === "request" && message.method === "runtimeDialogRequest")!;
    expect(id.message.kind).toBe("request");
    if (id.message.kind === "request") {
      const payload = id.message.payload as { id: string };
      const foreign = new RuntimeBroker("main", channels.transport("main")); stops.push(() => foreign.dispose());
      await expect(foreign.call("runtime", "runtimeDialogAction", { target: b.target, id: payload.id, action: "install" })).rejects.toThrow(/requesting document/);
    }
  });

  it("refuses stale targets before opening any dialog", async () => {
    const channels = new RuntimeTestChannels(), broker = new RuntimeBroker("runtime", channels.transport("runtime"));
    const client = createRuntimeDialogClient(broker); stops.push(() => broker.dispose(), client.dispose);
    const a = documentClient("doc-a", channels);
    a.close();
    await expect(client.forTarget(a.target).openEngineInstall("same-tab", snapshot, { action: vi.fn(), closed: vi.fn() })).rejects.toThrow(/closed|replaced/);
    expect(a.transport.open).not.toHaveBeenCalled();
  });
});
