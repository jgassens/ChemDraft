import { applyPatch, createDocumentHistory, redo, undo, type ChemDraftDocument, type DocumentHistory } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions, type PluginCommandContext, type PluginAssistantToolHandler } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantTransactions } from "../assistant/assistantTransaction";
import type { AssistantHistoryPort } from "../assistant/historyPort";
import { testContext } from "../assistant/tools/testContext";
import { createPluginWriteGate } from "./applyPluginDocumentPatch";
import { createRuntimeDocumentPort } from "./runtimeDocumentPort";
import type { McpBridgeRequest, McpBridgeResponse } from "../assistant/assistantMcpEngine";
import { createPluginRuntime } from "./createPluginRuntime";
import { normalizeCommittedDocument } from "../documentWorkflow";
import { DrawingIncarnations } from "../documentIdentity";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerDocument } from "./runtimeBrokerDocument";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { createRuntimeAssistantClient } from "./runtimeAssistantClient";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import type { RuntimeMessage, RuntimeTransport } from "./runtimeBrokerProtocol";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop(); vi.restoreAllMocks(); });
class AsyncChannels extends RuntimeTestChannels {
  afterPrepare?: () => void;
  override deliver(recipient: string, sender: string, message: RuntimeMessage): void {
    super.deliver(recipient, sender, message);
    if (message.kind === "response" && message.method === "prepareAssistantWrite") this.afterPrepare?.();
  }
  override transport(label: string): RuntimeTransport {
    const transport = super.transport(label);
    return { ...transport, immediate: false, send: (recipient, message) => Promise.resolve().then(() => transport.send(recipient, message)) };
  }
}

async function fixture(remote: boolean, extra?: PluginAssistantToolHandler) {
  const f = testContext();
  const initial = normalizeCommittedDocument(applyPatch(f.context.getDocument()!, { op: "setSelection",
    pageId: f.context.getDocument()!.pages[0]!.id, objectIds: [f.molecule.id] }));
  let history = createDocumentHistory(initial);
  const labels: string[] = [];
  let active = f.context.tabId, closed = false, gesture = false;
  const incarnations = new DrawingIncarnations();
  const read = () => closed ? undefined : history.present;
  const gate = createPluginWriteGate({ isGestureActive: () => gesture });
  const port: AssistantHistoryPort = {
    read: tab => tab === f.context.tabId ? read() : undefined,
    runWrite: apply => gate.run(apply),
    getViewportRect: () => ({ x: 0, y: 0, width: 600, height: 600 }),
    push: (_tab, before, after, label) => { history = { past: [...history.past, before], present: after, future: [] }; labels.push(label); },
    amend: (_tab, after, label) => { history = { ...history, present: after }; labels[labels.length - 1] = label; },
    select: (_tab, ids) => { history = { ...history, present: applyPatch(history.present,
      { op: "setSelection", pageId: history.present.pages[0]!.id, objectIds: [...ids] }) }; },
    onUserEdit: () => () => {},
    undo: (_tab, expected) => { if (history.present !== expected) return false; history = undo(history); return true; }
  };
  const transactions = new AssistantTransactions(port);
  const channels = new AsyncChannels();
  const hostBroker = new RuntimeBroker("runtime", channels.transport("runtime"));
  const documentBroker = new RuntimeBroker("main", channels.transport("main"));
  const assistant = createRuntimeAssistantClient(hostBroker);
  let listener: ((request: McpBridgeRequest) => void) | undefined;
  const native = {
    open: vi.fn(async (_plugin, receive: (request: McpBridgeRequest) => void) => {
      listener = receive; return { sessionId: "session", serverName: "chemdraft" as const };
    }),
    close: vi.fn(async () => {}), respond: vi.fn(async (_session: string, _id: string, _response: McpBridgeResponse) => {}),
    status: vi.fn(async () => ({ listening: true, sessionCount: 1 }))
  };
  const runtime = createPluginRuntime({
    getActiveDocument: remote ? () => { throw new Error("Uncaptured document read"); } : read,
    getActiveDocumentTab: () => ({ id: active }), getSelection: () => ({ objectIds: initial.selection.objectIds, molecules: [] }),
    getAssistantDocument: port.read, getAssistantViewportRect: port.getViewportRect,
    runAssistantWrite: apply => gate.run(apply), assistantTransactions: () => transactions,
    captureAssistantRequest: assistant.begin, assistantMcpEngine: native, assistantContext: () => f.context
  });
  const documentPort = createRuntimeDocumentPort({ windowId: "main", commandRegistry: new CommandRegistry(),
    activeTabId: () => active, read: tab => tab === f.context.tabId && read() ? { document: read()!, documentKey: incarnations.key(tab) } : undefined,
    selection: () => ({ objectIds: initial.selection.objectIds, molecules: [] }), viewportRect: port.getViewportRect,
    assistant: { history: port, transactions, assertWritable: () => {} },
    assertWritable: () => {}, getWriteGate: () => gate, placement: () => ({}), normalize: normalizeCommittedDocument,
    prepare: (write, commit) => commit(write.proposed),
    commit: (write, after) => {
      const id = transactions.activeTransactionForPlugin(write.application.plugin.id, write.tabId);
      if (!id) throw new Error("Missing assistant transaction");
      transactions.writeAssistantTransaction(id, after, write.applied.receipt.objectIds, write.proposed);
    } });
  let context!: PluginCommandContext;
  let release!: () => void;
  const handler = vi.fn((ctx: PluginCommandContext) => { context = ctx; return new Promise<void>(resolve => { release = resolve; }); });
  runtime.registerPlugin({ id: f.context.plugin.id, name: "Assistant", version: "1", apiVersion: "^0.1.25", entry: "test.js",
    permissions: [...AssistantCapabilityPermissions], contributes: { commands: [{ id: "plugin.assistant.send", title: "Send" }] } },
  { commandHandlers: { "plugin.assistant.send": handler }, onAssistantToolCall: extra });
  const host = new RuntimeBrokerHost(hostBroker, () => runtime, () => ["main"]);
  const document = new RuntimeBrokerDocument(documentBroker, documentPort);
  await document.refreshContributions();
  let command = remote ? document.invokeCommand("plugin.assistant.send") : runtime.invokeCommand("plugin.assistant.send");
  await vi.waitFor(() => expect(context).toBeDefined());
  stops.push(() => { release(); void command.catch(() => {}); runtime.unregisterPlugin(f.context.plugin.id); document.dispose(); host.dispose();
    assistant.dispose(); documentBroker.dispose(); hostBroker.dispose(); gate.dispose(); transactions.dispose(); });
  const request = await context.assistant!.beginRequest({ prompt: "Add two labels", label: "Two labels" });
  let sequence = 0;
  return { get context() { return context; }, request, tabId: f.context.tabId, hostBroker,
    async bridge(name: string) {
      const requestId = String(++sequence);
      listener!({ sessionId: "session", requestId, method: "tools/call", params: { name, arguments: {} } });
      await vi.waitFor(() => expect(native.respond.mock.calls.some(([, id]) => id === requestId)).toBe(true));
      return native.respond.mock.calls.find(([, id]) => id === requestId)![2];
    },
    conflictOnCommit: () => { channels.afterPrepare = () => {
      channels.afterPrepare = undefined;
      history = { ...history, present: { ...history.present, title: "Edited while preparing" } };
    }; },
    undoThis: () => hostBroker.call("main", "assistantUndo", { requestId: request.requestId, pluginId: f.context.plugin.id,
      target: { windowId: "main", tabId: f.context.tabId }, documentKey: incarnations.key(f.context.tabId) }), channels, handler, native, initial, labels, transactions, read, history: () => history,
    replace: () => { incarnations.replace(f.context.tabId); history = createDocumentHistory(initial); },
    async beginFresh() {
      release(); await command;
      context = undefined as unknown as PluginCommandContext;
      command = document.invokeCommand("plugin.assistant.send");
      await vi.waitFor(() => expect(context).toBeDefined());
      return context.assistant!.beginRequest({ prompt: "Fresh drawing" });
    },
    selectAway: () => { active = "other-tab"; }, close: () => { closed = true; },
    gesture: (value: boolean) => { gesture = value; if (!value) gate.flush(); },
    tool: vi.fn((text: string) => context.assistant!.callTool({ name: "insert_text", input: { text } })),
    end: () => context.assistant!.endRequest(request),
    undo: () => { history = undo(history); }, redo: () => { history = redo(history); } };
}

describe("assistant data forwarding", () => {
  it("ends a replaced drawing's request without touching replacement history or selection, then accepts a new request", async () => {
    const f = await fixture(true);
    expect((await f.tool("Old drawing label")).isError).not.toBe(true);
    f.replace();
    const replacement = f.history();
    await expect(f.end()).resolves.toMatchObject({ touchedIds: [] });
    expect(f.transactions.hasRunningForTab(f.tabId)).toBe(false);
    expect(f.history()).toBe(replacement);
    expect(f.read()).toBe(replacement.present);
    const fresh = await f.beginFresh();
    expect((await f.tool("New drawing label")).isError).not.toBe(true);
    await f.context.assistant!.endRequest(fresh);
    expect(f.history().past).toEqual([replacement.present]);
  });

  it.each(["replace", "close"] as const)("authenticates stale cancellation independently of drawing reads after %s", async invalidate => {
    const f = await fixture(true);
    f.gesture(true);
    const pending = f.tool("Queued label");
    await vi.waitFor(() => expect(f.channels.deliveries.some(({ message }) => message.kind === "request" && message.method === "assistantWrite")).toBe(true));
    const write = f.channels.deliveries.flatMap(({ message }) => message.kind === "request" && message.method === "assistantWrite"
      ? [message.payload as import("./runtimeBrokerProtocol").RuntimeRequest<"assistantWrite">] : [])[0]!;
    f[invalidate]();
    const unchanged = f.history();
    await expect(f.hostBroker.call("main", "cancelAssistantWrite", { session: { ...write.session, pluginId: "forged" }, writeId: write.writeId })).rejects.toThrow(/another document target/);
    await expect(f.hostBroker.call("main", "cancelAssistantWrite", { session: write.session, writeId: write.writeId })).resolves.toBeNull();
    await expect(f.hostBroker.call("main", "cancelAssistantConsent", { session: write.session, decisionId: "cancelled-decision" })).resolves.toBeNull();
    f.gesture(false);
    expect((await pending).isError).toBe(true);
    await expect(f.end()).resolves.toMatchObject({ touchedIds: [] });
    expect(f.transactions.hasRunningForTab(f.tabId)).toBe(false);
    expect(f.history()).toBe(unchanged);
    await expect(f.hostBroker.call("main", "assistantUndo", write.session)).rejects.toThrow(/closed|replaced/);
  });

  it("keeps identical history, labels and selection, and redo makes no call", async () => {
    const local = await fixture(false);
    const remote = await fixture(true);
    for (const f of [local, remote]) {
      f.selectAway();
      const first = await f.tool("First"), second = await f.tool("Second");
      expect(first.isError, JSON.stringify(first)).not.toBe(true); expect(second.isError, JSON.stringify(second)).not.toBe(true);
      const result = await f.end();
      expect(f.history().past).toHaveLength(1);
      expect(f.labels).toEqual(["ChemDraft Assistant: Two labels"]);
      expect(result.touchedIds).toEqual(f.read()!.selection.objectIds);
      const written = f.read()!;
      const calls = f.handler.mock.calls.length, toolCalls = f.tool.mock.calls.length;
      f.undo(); expect(f.read()).toEqual(f.initial);
      f.redo(); expect(f.read()).toEqual(written);
      expect(f.handler).toHaveBeenCalledTimes(calls); expect(f.tool).toHaveBeenCalledTimes(toolCalls); expect(f.native.open).not.toHaveBeenCalled();
    }
    // Generated ids differ between independent runtimes; compare the full recorded documents
    // after replacing only those opaque ids with their occurrence positions.
    const canonical = (history: DocumentHistory) => {
      const json = JSON.stringify(history, (key, value: unknown) => key === "updatedAt" ? "clock" : value);
      const ids = [...new Set(json.match(/(?:assistant|text|molecule|mol|atom|bond)_[a-zA-Z0-9_-]+/g) ?? [])];
      return ids.reduce((value, id, index) => value.replaceAll(id, `id_${index}`), json);
    };
    expect(canonical(remote.history())).toBe(canonical(local.history()));
    expect(remote.channels.deliveries.some(({ message }) => message.kind === "request" && message.method === "prepareAssistantWrite")).toBe(true);
    expect(JSON.stringify(remote.channels.deliveries)).not.toMatch(/"signal":|"getDocument":|"apply":/);
  });

  it("keeps direct plugin extra-tool writes and host-tool writes in the Send transaction, with broker-owned Undo", async () => {
    const extra = vi.fn<PluginAssistantToolHandler>(async context => {
      const document = await context.documents.getActiveDocument!();
      await context.documents.applyPatch!({ reason: "Extra label", patch: { op: "addObject", pageId: document!.pages[0]!.id,
        object: { id: "extra_label", type: "text", x: 100, y: 100, width: 50, height: 20, rotation: 0, style: {}, text: "Extra", spans: [] } } });
      return { content: [{ type: "text", text: "Inserted" }] };
    });
    const f = await fixture(true, extra);
    await f.context.assistant!.createToolSession({ requestId: f.request.requestId,
      extraTools: [{ name: "plugin_label", description: "Insert a test label", inputSchema: { type: "object", properties: {} } }] });
    f.selectAway();
    expect(await f.bridge("plugin_label")).toMatchObject({ result: { content: [{ text: "Inserted" }] } });
    expect((await f.tool("Host label")).isError).not.toBe(true);
    const result = await f.end();
    expect(f.history().past).toHaveLength(1);
    expect(f.labels).toEqual(["ChemDraft Assistant: Two labels"]);
    expect(result.touchedIds).toContain("extra_label");
    expect(f.read()!.selection.objectIds).toEqual(result.touchedIds);
    const after = f.read();
    await expect(f.undoThis()).resolves.toBe(true);
    expect(f.read()).toEqual(f.initial);
    f.redo(); expect(f.read()).toEqual(after);
    expect(extra).toHaveBeenCalledTimes(1); expect(f.tool).toHaveBeenCalledTimes(1);
  });

  it("does not report touched ids or widen scope when the final document recheck refuses a prepared write", async () => {
    const f = await fixture(true);
    f.conflictOnCommit();
    expect((await f.tool("Refused label")).isError).toBe(true);
    expect(f.history().past).toEqual([]);
    const result = await f.end();
    expect(result.touchedIds).toEqual([]);
    expect(f.read()!.pages[0]!.objects).toEqual(f.initial.pages[0]!.objects);
  });

  it("refuses a write after its captured tab closes, including after waiting for a gesture", async () => {
    const f = await fixture(true);
    f.gesture(true);
    const pending = f.tool("Late label");
    await vi.waitFor(() => expect(f.channels.deliveries.some(({ message }) => message.kind === "request" && message.method === "assistantWrite")).toBe(true));
    f.close(); f.gesture(false);
    await expect(pending).resolves.toMatchObject({ isError: true });
    expect(f.history().past).toEqual([]);
    await expect(f.tool("Closed label")).rejects.toThrow(/closed|replaced/);
  });
});
