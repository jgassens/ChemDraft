import { applyPatch, createDocumentHistory, undo, redo, type DocumentHistory } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions, type PluginCommandContext } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { expect, it, vi } from "vitest";
import { AssistantTransactions } from "../assistant/assistantTransaction";
import { getAssistantHistoryPort, registerAssistantHistoryPort, type AssistantHistoryPort } from "../assistant/historyPort";
import { testContext } from "../assistant/tools/testContext";
import { normalizeCommittedDocument } from "../documentWorkflow";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { createPluginWriteGate } from "./applyPluginDocumentPatch";
import { createPluginRuntime } from "./createPluginRuntime";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { RuntimeBrokerDocument } from "./runtimeBrokerDocument";
import { createRuntimeAssistantClient } from "./runtimeAssistantClient";
import { createRuntimeDocumentPort } from "./runtimeDocumentPort";

it("keeps concurrent assistant requests in their Send targets with identical history/selection and no AI on undo/redo", async () => {
  const f = testContext();
  const initial = normalizeCommittedDocument(applyPatch(f.context.getDocument()!, { op: "setSelection", pageId: f.context.getDocument()!.pages[0]!.id, objectIds: [f.molecule.id] }));
  const channels = new RuntimeTestChannels();
  const transport = (label: string) => {
    const port = channels.transport(label);
    return { ...port, immediate: false, send: (recipient: string, message: Parameters<typeof port.send>[1]) => Promise.resolve().then(() => port.send(recipient, message)) };
  };
  const broker = new RuntimeBroker("runtime", transport("runtime"));
  const assistant = createRuntimeAssistantClient(broker);
  const runtime = createPluginRuntime({ getActiveDocument: () => { throw new Error("Uncaptured document read"); },
    captureAssistantRequest: assistant.begin, assistantContext: () => f.context });
  const contexts: PluginCommandContext[] = [];
  const releases: Array<() => void> = [];
  const send = vi.fn((context: PluginCommandContext) => {
    contexts.push(context);
    return new Promise<void>(resolve => releases.push(resolve));
  });
  runtime.registerPlugin({ id: f.context.plugin.id, name: "Assistant", version: "1", apiVersion: "^0.1.25", entry: "test.js",
    permissions: [...AssistantCapabilityPermissions], contributes: { commands: [{ id: "plugin.assistant.send", title: "Send" }] }
  }, { commandHandlers: { "plugin.assistant.send": send } });
  const host = new RuntimeBrokerHost(broker, () => runtime, () => ["main", "doc-b"]);
  const clients = ["main", "doc-b"].map(windowId => {
    let history = createDocumentHistory(initial);
    let active = f.context.tabId;
    const labels: string[] = [];
    const gate = createPluginWriteGate({ isGestureActive: () => false });
    const port: AssistantHistoryPort = {
      read: tabId => tabId === f.context.tabId ? history.present : undefined,
      runWrite: apply => gate.run(apply), getViewportRect: () => ({ x: 0, y: 0, width: 600, height: 600 }),
      push: (_tab, before, after, label) => { history = { past: [...history.past, before], present: after, future: [] }; labels.push(label); },
      amend: (_tab, after) => { history = { ...history, present: after }; },
      select: (_tab, ids) => { history = { ...history, present: applyPatch(history.present, { op: "setSelection", pageId: initial.pages[0]!.id, objectIds: [...ids] }) }; },
      onUserEdit: () => () => {},
      undo: (_tab, expected) => { if (history.present !== expected) return false; history = undo(history); return true; }
    };
    const transactions = new AssistantTransactions(port);
    const documentBroker = new RuntimeBroker(windowId, transport(windowId));
    const document = new RuntimeBrokerDocument(documentBroker, createRuntimeDocumentPort({
      windowId, commandRegistry: new CommandRegistry(), activeTabId: () => active,
      read: tabId => port.read(tabId) ? { document: port.read(tabId)!, documentKey: `${windowId}:drawing` } : undefined,
      selection: () => ({ objectIds: [...initial.selection.objectIds], molecules: [] }), viewportRect: port.getViewportRect,
      assistant: { history: port, transactions, assertWritable: () => {} }, assertWritable: () => {},
      getWriteGate: () => gate, placement: () => ({}), normalize: normalizeCommittedDocument,
      prepare: (write, commit) => commit(write.proposed), commit: (write, after) => {
        const id = transactions.activeTransactionForPlugin(write.application.plugin.id, write.tabId);
        if (!id) throw new Error("Missing target transaction");
        transactions.writeAssistantTransaction(id, after, write.applied.receipt.objectIds, write.proposed);
      }
    }));
    const unregister = registerAssistantHistoryPort(port, windowId);
    return { windowId, document, port, labels, transactions, history: () => history, activate: () => { active = "other-tab"; },
      undo: () => { history = undo(history); }, redo: () => { history = redo(history); },
      dispose: () => { unregister(); document.dispose(); documentBroker.dispose(); gate.dispose(); transactions.dispose(); } };
  });
  const commands: Promise<unknown>[] = [];
  try {
    expect(getAssistantHistoryPort()).toBe(clients[0]!.port);
    expect(getAssistantHistoryPort("doc-b")).toBe(clients[1]!.port);
    for (const client of clients) {
      await client.document.refreshContributions();
      commands.push(client.document.invokeCommand("plugin.assistant.send"));
      await vi.waitFor(() => expect(contexts).toHaveLength(commands.length));
    }
    const requests = await Promise.all(contexts.map(context => context.assistant!.beginRequest({ prompt: "Two labels", label: "Two labels" })));
    expect(clients.every(client => client.transactions.hasRunningForTab(f.context.tabId))).toBe(true);
    clients.forEach(client => client.activate());
    const tools = contexts.map(context => vi.fn((text: string) => context.assistant!.callTool({ name: "insert_text", input: { text } })));
    await Promise.all(tools.map(async tool => {
      const first = await tool("First"), second = await tool("Second");
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      expect(second.isError, JSON.stringify(second)).not.toBe(true);
    }));
    for (const [index, client] of clients.entries()) {
      const result = await contexts[index]!.assistant!.endRequest(requests[index]!);
      expect(client.transactions.hasRunningForTab(f.context.tabId)).toBe(false);
      expect(client.history().past).toHaveLength(1);
      expect(client.labels).toEqual(["ChemDraft Assistant: Two labels"]);
      expect(client.history().present.selection.objectIds).toEqual(result.touchedIds);
      const after = client.history().present;
      client.undo(); expect(client.history().present).toEqual(initial);
      client.redo(); expect(client.history().present).toEqual(after);
      expect(tools[index]).toHaveBeenCalledTimes(2);
    }
    const comparable = (history: DocumentHistory) => {
      let json = JSON.stringify(history, (key, value: unknown) => key === "updatedAt" ? "clock" : value);
      for (const [index, id] of [...new Set(json.match(/assistant_[A-Za-z0-9_-]+/g) ?? [])].entries()) json = json.replaceAll(id, `insert_${index}`);
      return json;
    };
    expect(comparable(clients[0]!.history())).toBe(comparable(clients[1]!.history()));
    expect(send).toHaveBeenCalledTimes(2);
    const targets = channels.deliveries.flatMap(({ message }) => message.kind === "request" && message.method === "assistantWrite"
      ? [(message.payload as { session: { target: { windowId: string; tabId: string } } }).session.target] : []);
    expect(new Set(targets.map(target => target.windowId))).toEqual(new Set(["main", "doc-b"]));
    expect(targets.every(target => target.tabId === f.context.tabId)).toBe(true);
  } finally {
    releases.forEach(release => release());
    await Promise.allSettled(commands);
    clients.forEach(client => client.dispose()); host.dispose(); assistant.dispose(); broker.dispose();
  }
});
