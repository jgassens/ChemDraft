import { afterEach, describe, expect, it, vi } from "vitest";
import { toEngineDocument } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions, type PluginCommandContext } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { AssistantToolsController } from "./AssistantToolsController";
import { AssistantTransactions } from "./assistantTransaction";
import type { AssistantHistoryPort } from "./historyPort";
import type { McpBridgeRequest, McpBridgeResponse } from "./assistantMcpEngine";
import { testContext } from "./tools/testContext";
import { createPluginWriteGate, PLUGIN_WRITE_MAX_WAIT_MS } from "../plugins/applyPluginDocumentPatch";

function setup() {
  const fixture = testContext();
  const { context, replace } = fixture;
  replace(toEngineDocument(context.getDocument()!));
  let selection = [fixture.molecule.id];
  let activeTabId = context.tabId;
  const baseline = context.getDocument()!;
  const history: { before: typeof baseline; after: typeof baseline; label: string }[] = [];
  const userEdits = new Set<(tabId: string) => void>();
  const gesture = { active: false };
  const gate = createPluginWriteGate({ isGestureActive: () => gesture.active });
  const getSelectionIds = vi.fn(() => selection);
  const port: AssistantHistoryPort = {
    read: tab => tab === context.tabId ? context.getDocument() : undefined,
    push: (_tab, before, after, label) => { history.push({ before, after, label }); replace(after); },
    amend: (_tab, after, label) => { Object.assign(history[history.length - 1]!, { after, label }); replace(after); },
    select: (_tab, ids) => replace({ ...context.getDocument()!, selection: { objectIds: [...ids] } }),
    onUserEdit: listener => { userEdits.add(listener); return () => { userEdits.delete(listener); }; }, undo: () => false
  };
  const transactions = new AssistantTransactions(port);
  const listeners = new Map<string, (message: McpBridgeRequest) => void>();
  const engine = {
    open: vi.fn(async (_plugin, listener: (message: McpBridgeRequest) => void) => {
      const sessionId = `session${listeners.size}`; listeners.set(sessionId, listener);
      return { sessionId, serverName: "chemdraft" as const };
    }),
    close: vi.fn(async (_sessionId: string) => {}), respond: vi.fn(async (_sessionId: string, _requestId: string, _response: McpBridgeResponse) => {}),
    status: vi.fn(async () => ({ listening: true, sessionCount: listeners.size }))
  };
  const controller = new AssistantToolsController({ host: (): PluginHost => host, engine,
    getActiveTabId: () => activeTabId, getSelectionIds, runWrite: apply => gate.run(apply),
    readDocument: port.read, transactions: () => transactions, createContext: () => context });
  const host = new PluginHost({ assistant: controller, getSelection: () => ({ objectIds: [], molecules: [] }) });
  const plugin = { id: context.plugin.id, name: context.plugin.name };
  let commandContext!: PluginCommandContext;
  let release!: () => void;
  host.registerPlugin({ ...plugin, version: "0", apiVersion: "^0.1.9", entry: "worker.js",
    permissions: [...AssistantCapabilityPermissions], contributes: { commands: [{ id: "plugin.assistant.submit", title: "Submit" }] }
  }, { commandHandlers: { "plugin.assistant.submit": ctx => { commandContext = ctx; return new Promise<void>(resolve => { release = resolve; }); } } });
  const command = host.invokeCommand("plugin.assistant.submit");
  let sequence = 0;
  const bridge = async (sessionId: string, name: string, input: unknown) => {
    const requestId = String(++sequence);
    listeners.get(sessionId)!({ sessionId, requestId, method: "tools/call", params: { name, arguments: input } });
    await vi.waitFor(() => expect(engine.respond).toHaveBeenCalledWith(sessionId, requestId, expect.anything()));
    return engine.respond.mock.calls.find(call => call[0] === sessionId && call[1] === requestId)![2];
  };
  return { ...fixture, host, controller, engine, plugin, context, listeners, history, port, commandContext, bridge,
    gesture, gate, getSelectionIds, userEdits,
    select: (ids: string[]) => { selection = ids; }, activate: (tabId: string) => { activeTabId = tabId; },
    finishCommand: async () => { release(); await command; },
    finish: async () => { controller.closeAllForPlugin(plugin.id); gate.dispose(); release(); await command; transactions.dispose(); } };
}

afterEach(() => vi.useRealTimers());
describe("assistant requests and MCP bridge", () => {
  it("waits for a gesture to commit, then applies the write without losing either edit", async () => {
    const s = setup();
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "caption" });
      expect(s.getSelectionIds).toHaveBeenCalledOnce();
      s.gesture.active = true;
      const pending = s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "After drag" } });
      await vi.waitFor(() => expect(s.gate.pending()).toBe(1));
      expect(s.history).toHaveLength(0);
      const before = s.context.getDocument()!;
      const dragged = { ...before, pages: before.pages.map(page => ({ ...page,
        objects: page.objects.map(object => object.id === s.text.id ? { ...object, x: object.x + 50 } : object)
      })) };
      s.port.push(s.context.tabId, before, dragged, "Drag");
      s.userEdits.forEach(listener => listener(s.context.tabId));
      s.gesture.active = false;
      s.gate.flush();
      expect(await pending).toMatchObject({ structuredContent: { objectIds: [expect.any(String)] } });
      expect(s.history).toHaveLength(2);
      expect(s.history[1]!.before).toEqual(dragged);
      expect(s.context.getDocument()!.pages[0]!.objects).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: s.text.id, x: s.text.x + 50 }),
        expect.objectContaining({ type: "text", text: "After drag" })
      ]));
      const result = await s.controller.endRequest(s.plugin, { requestId });
      expect(result.previewSvg).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    } finally { await s.finish(); }
  });
  it("returns the gesture timeout as a tool error and never applies the abandoned write", async () => {
    vi.useFakeTimers();
    const s = setup();
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "caption" });
      s.gesture.active = true;
      const pending = s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Blocked" } });
      await vi.advanceTimersByTimeAsync(PLUGIN_WRITE_MAX_WAIT_MS - 1);
      expect(s.gate.pending()).toBe(1);
      expect(s.history).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(51);
      expect(await pending).toMatchObject({ isError: true,
        content: [{ text: "The drawing is being edited; try again" }] });
      s.gesture.active = false;
      s.gate.flush();
      expect(s.history).toHaveLength(0);
    } finally { await s.finish(); }
  });
  it("does not apply a queued write after the request ends", async () => {
    const s = setup();
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "caption" });
      s.gesture.active = true;
      const pending = s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Cancelled" } });
      const rejection = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(s.gate.pending()).toBe(1));
      await s.controller.endRequest(s.plugin, { requestId });
      await rejection;
      s.gesture.active = false;
      s.gate.flush();
      expect(s.history).toHaveLength(0);
    } finally { await s.finish(); }
  });
  it("captures selection at Send, writes through plugin scope and groups multiple calls into one undo entry", async () => {
    const s = setup();
    try {
      // Invocation selection was empty; Send's selection is the authoritative scope.
      const { requestId } = await s.commandContext.assistant!.beginRequest({ prompt: "restyle and caption" });
      const session = await s.controller.createToolSession(s.plugin, { requestId });
      s.select([s.text.id]);
      s.activate("another-tab");
      const apply = vi.spyOn(s.host, "applyPatchForPlugin");
      expect(await s.bridge(session.sessionId, "style_objects", { objectIds: [s.molecule.id], style: { color: "#112233" } })).toMatchObject({ result: { structuredContent: { objectIds: [s.molecule.id] } } });
      const inserted = await s.bridge(session.sessionId, "insert_text", { text: "AI caption" });
      expect(inserted).toHaveProperty("result");
      expect(apply).toHaveBeenCalledTimes(2);
      expect(apply.mock.calls[0]![0]).toBe(s.plugin.id);
      expect(s.history).toHaveLength(1);
      const newText = s.context.getDocument()!.pages[0]!.objects.find(o => o.type === "text" && o.id !== s.text.id)!;
      await s.bridge(session.sessionId, "style_objects", { objectIds: [newText.id], style: { color: "#223344" } });
      const result = await s.controller.endRequest(s.plugin, { requestId });
      expect(result).toMatchObject({ split: false, touchedIds: expect.arrayContaining([s.molecule.id, newText.id]) });
      expect(s.history).toHaveLength(1);
      expect(s.history[0]!.label).toBe("ChemDraft Assistant: restyle and caption");
      expect(s.context.getDocument()!.selection.objectIds).toEqual(expect.arrayContaining([s.molecule.id, newText.id]));
      expect(s.engine.close).toHaveBeenCalledWith(session.sessionId);
      expect(await s.bridge(session.sessionId, "insert_text", { text: "late" })).toHaveProperty("error");
      expect(s.history).toHaveLength(1);
      // Send-time grants and assistant insertions do not widen the surrounding command's grant.
      await expect(s.commandContext.documents.applyPatch!({ patch: { op: "removeObject", objectId: newText.id },
        reason: "outside assistant request", requiresUserApproval: true })).rejects.toThrow("not selected");
    } finally { await s.finish(); }
  });
  it("refuses out-of-scope edits, empty-selection edits, writes without an own command, and calls on a closed tab", async () => {
    const s = setup();
    try {
      s.select([]);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "add" });
      expect(await s.controller.callTool(s.plugin, { name: "delete_objects", input: { objectIds: [s.text.id] } })).toMatchObject({ structuredContent: { refused: true } });
      // Check the host gate independently of the tool's own scope check.
      await expect(s.host.applyPatchForPlugin(s.plugin.id, undefined, { patch: { op: "removeObject", pageId: s.context.getDocument()!.pages[0]!.id, objectId: s.text.id }, reason: "test", requiresUserApproval: true }, { objectIds: [], apply: () => ({ applied: true, objectIds: [] }) })).rejects.toThrow("not selected");
      await s.controller.endRequest(s.plugin, { requestId });
      s.close();
      await expect(s.controller.callTool(s.plugin, { name: "get_document", input: {} })).rejects.toThrow("No assistant request");
      expect(s.history).toHaveLength(0);
    } finally { await s.finish(); }
  });
  it("limits concurrency to four, cancels with Rust's envelope request id, and blocks late writes", async () => {
    const s = setup();
    try {
      let resolve!: (value: Awaited<ReturnType<typeof s.context.chemistry.nameToStructure>>) => void;
      s.context.chemistry.nameToStructure = () => new Promise(done => { resolve = done; });
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "compute" });
      const session = await s.controller.createToolSession(s.plugin, { requestId });
      for (let i = 0; i < 4; i++) s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: String(i), method: "tools/call", params: { name: "name_to_structure", arguments: { name: "ethane" } } });
      await expect(s.controller.callTool(s.plugin, { name: "get_document", input: {} })).rejects.toThrow("four");
      s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: "0", method: "cancel", params: { reason: "deadline" } });
      await vi.waitFor(() => expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, "0", expect.objectContaining({ error: expect.anything() })));
      await expect(s.controller.callTool(s.plugin, { name: "get_document", input: {} })).rejects.toThrow("four");
      await s.controller.endRequest(s.plugin, { requestId });
      resolve({ available: false, reason: "cancelled" });
      expect(s.history).toHaveLength(0);
    } finally { await s.finish(); }
  });
  it("caps sessions at two and closes them on unregister", async () => {
    const s = setup();
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "work" });
      await s.controller.createToolSession(s.plugin, { requestId });
      await s.controller.createToolSession(s.plugin, { requestId });
      await expect(s.controller.createToolSession(s.plugin, { requestId })).rejects.toThrow("two");
      s.host.unregisterPlugin(s.plugin.id);
      expect(s.engine.close).toHaveBeenCalledTimes(2);
    } finally { await s.finish(); }
  });
  it("refuses writes once the submit command returns and closes sessions when the pinned tab closes", async () => {
    const s = setup();
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "write" });
      const session = await s.controller.createToolSession(s.plugin, { requestId });
      await s.finishCommand();
      const response = await s.bridge(session.sessionId, "insert_text", { text: "forbidden" });
      expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("own commands") }] } });
      expect(s.history).toHaveLength(0);
      s.close();
      expect(await s.bridge(session.sessionId, "get_document", {})).toMatchObject({ error: { message: expect.stringContaining("tab has closed") } });
      s.controller.closeAllForTab(s.context.tabId);
      expect(s.engine.close).toHaveBeenCalledWith(session.sessionId);
    } finally { await s.finish(); }
  });
  it("closes a session whose open completes after endRequest", async () => {
    const s = setup();
    try {
      let opened!: (value: { sessionId: string; serverName: "chemdraft" }) => void;
      s.engine.open.mockImplementationOnce(() => new Promise(resolve => { opened = resolve; }));
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "open" });
      const pending = s.controller.createToolSession(s.plugin, { requestId });
      await s.controller.endRequest(s.plugin, { requestId });
      opened({ sessionId: "late", serverName: "chemdraft" });
      await expect(pending).rejects.toThrow("ended");
      expect(s.engine.close).toHaveBeenCalledWith("late");
    } finally { await s.finish(); }
  });
  it("returns deadline errors for native work and never commits its late result", async () => {
    const s = setup();
    try {
      vi.useFakeTimers();
      let resolve!: (value: Awaited<ReturnType<typeof s.context.chemistry.structureFromSmiles>>) => void;
      s.context.chemistry.structureFromSmiles = () => new Promise(done => { resolve = done; });
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "draw" });
      const call = s.controller.callTool(s.plugin, { name: "insert_structures", input: { items: [{ kind: "molecule", smiles: "CC" }] } });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await call).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("timed out") }] });
      resolve({ available: true, built: true, object: s.molecule });
      await vi.advanceTimersByTimeAsync(1);
      expect(s.history).toHaveLength(0);
      await s.controller.endRequest(s.plugin, { requestId });
    } finally { await s.finish(); }
  });
});
