import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, createCustomPageLayout, DocumentObjectSchema, toEngineDocument, undo, redo } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions, type PluginCommandContext } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { AssistantToolsController } from "./AssistantToolsController";
import { AssistantTransactions } from "./assistantTransaction";
import type { AssistantHistoryPort } from "./historyPort";
import type { McpBridgeRequest, McpBridgeResponse } from "./assistantMcpEngine";
import { testContext } from "./tools/testContext";
import { createPluginWriteGate, PLUGIN_WRITE_MAX_WAIT_MS } from "../plugins/applyPluginDocumentPatch";
import { setNativePromptProvider, type NativePromptOptions } from "../nativePrompt";
import { objectRect } from "./placement";

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

function placementSetup() {
  const s = setup();
  const document = s.context.getDocument()!;
  const page = document.pages[0]!;
  s.replace(applyPatch({ ...document, pages: [{ ...page, objects: [] }] }, {
    op: "updatePageLayout", pageId: page.id,
    layout: createCustomPageLayout(400, 300, "css-px", { top: 36, right: 36, bottom: 36, left: 36 })
  }));
  s.select([]);
  let index = 0;
  s.context.chemistry.structureFromSmiles = async () => {
    // Artificial wide depiction isolates placement from engine/layout behavior. No rescaling is allowed.
    const width = index++ === 0 ? 1000 : 28;
    const object = { ...s.molecule, width, atoms: s.molecule.atoms.map((atom, i) => ({ ...atom,
      x: s.molecule.atoms[0]!.x + i * width })) };
    return { available: true, built: true, object };
  };
  return s;
}

describe("assistant host page enlargement", () => {
  it.each([false, true])("applies the same page-growth decision to native group labels (accepted: %s)", async accepted => {
    const s = placementSetup();
    const document = s.context.getDocument()!;
    s.replace(applyPatch(document, { op: "updatePageLayout", pageId: document.pages[0]!.id,
      layout: createCustomPageLayout(200, 160, "css-px", { top: 36, right: 36, bottom: 36, left: 36 }) }));
    const prompt = vi.fn(async () => accepted ? "enlarge" : "decline");
    const restore = setNativePromptProvider(prompt);
    try {
      const before = structuredClone(s.context.getDocument()!.pages[0]!);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "draw groups" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_structures", input: {
        items: Array.from({ length: 24 }, (_, index) => ({ kind: "group", label: ["CH3", "Ph", "Boc", "OTs"][index % 4] }))
      } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(prompt).toHaveBeenCalledOnce();
      const page = s.context.getDocument()!.pages[0]!;
      if (accepted) {
        expect(page.objects).toHaveLength(24);
        expect(page.height).toBeGreaterThan(before.height);
      } else {
        expect(page.width).toBe(before.width); expect(page.height).toBe(before.height);
        expect(page.objects.length).toBeGreaterThan(0);
        expect(page.objects.length).toBeLessThan(24);
        expect(result.structuredContent).toMatchObject({ reason: "declined: the user chose not to enlarge the page", declined: expect.any(Array) });
      }
      for (const object of page.objects) {
        expect(object).toMatchObject({ type: "molecule", atoms: [expect.objectContaining({ labelLiteral: true })], bonds: [] });
        const rect = objectRect(object);
        expect(rect.x + rect.width).toBeLessThanOrEqual(page.width - page.margin.right + 1e-6);
        expect(rect.y + rect.height).toBeLessThanOrEqual(page.height - page.margin.bottom + 1e-6);
      }
      // The answer has returned control to the request; Stop can immediately cancel it again.
      await s.controller.endRequest(s.plugin, { requestId });
      await expect(s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "After Stop" } })).rejects.toThrow();
    } finally { restore(); await s.finish(); }
  });

  it("does not prompt for a fitting insertion", async () => {
    const s = placementSetup();
    const prompt = vi.fn(async () => "enlarge");
    const restore = setNativePromptProvider(prompt);
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "caption" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Fits" } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(s.context.getDocument()!.pages[0]!.objects).toHaveLength(1);
      expect(prompt).not.toHaveBeenCalled();
    } finally { restore(); await s.finish(); }
  });

  it("grows through the host with empty Send scope; one undo/redo restores page and all request objects", async () => {
    const s = placementSetup();
    const prompt = vi.fn(async (_prompt: NativePromptOptions) => "enlarge");
    const restore = setNativePromptProvider(prompt);
    const scopedWrite = vi.spyOn(s.host, "applyPatchForPlugin");
    try {
      const before = structuredClone(s.context.getDocument()!);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "Draw Olympiadane and a caption" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_structures", input: {
        items: [{ kind: "molecule", smiles: "CC", label: "Olympiadane" }]
      } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(prompt).toHaveBeenCalledOnce();
      const page = s.context.getDocument()!.pages[0]!;
      expect(page.width).toBeGreaterThan(before.pages[0]!.width);
      expect(page.height).toBe(before.pages[0]!.height);
      expect(page.layout).toMatchObject({ presetId: "custom", widthPx: page.width, heightPx: page.height });
      expect(prompt.mock.calls[0]![0]).toMatchObject({ owner: "document",
        message: `Olympiadane needs a page ${Math.round(page.width * 0.75)} × ${Math.round(page.height * 0.75)} pt. Enlarge the page to fit?`,
        choices: [{ id: "enlarge", label: "Enlarge Page" }, { id: "decline", label: "Cancel", cancel: true }]
      });
      const molecule = page.objects.find(object => object.type === "molecule")!;
      if (molecule.type !== "molecule") throw new Error("Expected molecule");
      expect(molecule.atoms[1]!.x - molecule.atoms[0]!.x).toBeCloseTo(1000);
      for (const object of page.objects) {
        const rect = objectRect(object);
        expect(rect.x + rect.width).toBeLessThanOrEqual(page.width - page.margin.right + 1e-6);
        expect(rect.y + rect.height).toBeLessThanOrEqual(page.height - page.margin.bottom + 1e-6);
      }
      // The layout op never enters the plugin patch/scope API.
      expect(JSON.stringify(scopedWrite.mock.calls[0])).not.toContain("updatePageLayout");
      const caption = await s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Caption" } });
      expect(caption.isError).not.toBe(true);
      await s.controller.endRequest(s.plugin, { requestId });
      const after = s.context.getDocument()!;
      expect(s.history).toHaveLength(1);
      expect(s.history[0]!.label).toBe("ChemDraft Assistant: Draw Olympiadane and a caption");
      let history = { past: s.history.map(entry => entry.before), present: after, future: [] as typeof before[] };
      history = undo(history);
      expect(history.present).toEqual(before);
      history = redo(history);
      expect(history.present).toEqual(after);
      expect(history.present.pages[0]!.objects).toHaveLength(3);
      expect(prompt).toHaveBeenCalledOnce();
      expect(scopedWrite).toHaveBeenCalledTimes(2);
    } finally { restore(); await s.finish(); }
  });

  it.each([false, true].flatMap(mixed => ["decline", "unknown", "fallback"].map(answer => ({ mixed, answer }))))(
    "$answer omits the oversized item and its label, retaining fitting items ($mixed)", async ({ mixed, answer }) => {
    const s = placementSetup();
    const prompt = vi.fn(async (options: NativePromptOptions, fallback: (options: NativePromptOptions) => Promise<string>) =>
      answer === "fallback" ? fallback(options) : answer);
    const restore = setNativePromptProvider(prompt);
    try {
      const before = structuredClone(s.context.getDocument()!.pages[0]!);
      await s.controller.beginRequest(s.plugin, { prompt: "structures" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_structures", input: {
        items: [{ kind: "molecule", smiles: "CC", label: "Olympiadane" },
          ...(mixed ? [{ kind: "molecule", smiles: "CC", label: "Ethane" }] : [])]
      } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ declined: ["Olympiadane"],
        reason: "declined: the user chose not to enlarge the page", warnings: [] });
      expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("declined: the user chose not to enlarge the page") })]);
      expect(prompt).toHaveBeenCalledOnce();
      const page = s.context.getDocument()!.pages[0]!;
      expect({ ...page, objects: [] }).toEqual(before);
      expect(page.objects).toHaveLength(mixed ? 2 : 0);
      expect(page.objects.some(object => object.type === "text" && object.text === "Olympiadane")).toBe(false);
      if (mixed) expect(page.objects.some(object => object.type === "text" && object.text === "Ethane")).toBe(true);
      expect(s.history).toHaveLength(mixed ? 1 : 0);
    } finally { restore(); await s.finish(); }
  });

  it.each(["insert_reaction", "insert_text"].flatMap(name => [false, true].map(accepted => ({ name, accepted }))))(
    "asks once for non-fitting $name (accepted: $accepted)", async ({ name, accepted }) => {
    const s = placementSetup();
    const prompt = vi.fn(async () => accepted ? "enlarge" : "decline");
    const restore = setNativePromptProvider(prompt);
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "insert" });
      const input = name === "insert_text" ? { text: "A line\n".repeat(100) } : { reactants: ["CC"], products: ["CC"] };
      const result = await s.controller.callTool(s.plugin, { name, input });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent?.reason).toBe(accepted ? undefined : "declined: the user chose not to enlarge the page");
      expect(prompt).toHaveBeenCalledOnce();
      const page = s.context.getDocument()!.pages[0]!;
      if (accepted) {
        expect(page.objects.length).toBeGreaterThan(0);
        for (const object of page.objects) {
          const rect = objectRect(object);
          expect(rect.x + rect.width).toBeLessThanOrEqual(page.width - page.margin.right + 1e-6);
          expect(rect.y + rect.height).toBeLessThanOrEqual(page.height - page.margin.bottom + 1e-6);
        }
      } else expect(page.objects).toHaveLength(0);
      expect(s.history).toHaveLength(accepted ? 1 : 0);
    } finally { restore(); await s.finish(); }
  });

  it("wraps real widths first, then asks once to grow the height for the whole set", async () => {
    const s = placementSetup();
    s.context.chemistry.structureFromSmiles = async () => ({ available: true, built: true, object: s.molecule });
    const prompt = vi.fn(async () => "enlarge");
    const restore = setNativePromptProvider(prompt);
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "24 structures" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_structures", input: { arrangement: "row",
        items: Array.from({ length: 24 }, (_, index) => ({ kind: "molecule", smiles: "CC", label: `Item ${index + 1}` }))
      } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(prompt).toHaveBeenCalledOnce();
      const page = s.context.getDocument()!.pages[0]!;
      expect(page.width).toBe(400);
      expect(page.height).toBeGreaterThan(300);
      expect(page.objects).toHaveLength(48);
      for (const object of page.objects) {
        const rect = objectRect(object);
        expect(rect.x + rect.width).toBeLessThanOrEqual(page.width - page.margin.right + 1e-6);
        expect(rect.y + rect.height).toBeLessThanOrEqual(page.height - page.margin.bottom + 1e-6);
      }
    } finally { restore(); await s.finish(); }
  });

  it("waits for a human answer beyond the tool deadlines", async () => {
    vi.useFakeTimers();
    const s = placementSetup();
    let answer!: (choice: string) => void;
    const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    const restore = setNativePromptProvider(prompt);
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "insert" });
      const pending = s.controller.callTool(s.plugin, { name: "insert_structures", input: { items: [{ kind: "molecule", smiles: "CC" }] } });
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(prompt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(settled).toBe(false);
      answer("enlarge");
      expect((await pending).isError).not.toBe(true);
      expect(s.context.getDocument()!.pages[0]!.objects).toHaveLength(1);
    } finally { answer?.("decline"); restore(); await s.finish(); }
  });

  it.each([false, true])("declines through the MCP bridge after five minutes and ignores a late Yes (fitting item: %s)", async includeFitting => {
    vi.useFakeTimers();
    const s = placementSetup();
    let answer!: (choice: string) => void;
    const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    const restore = setNativePromptProvider(prompt);
    try {
      const before = s.context.getDocument()!;
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "insert" });
      const { sessionId } = await s.controller.createToolSession(s.plugin, { requestId });
      s.listeners.get(sessionId)!({ sessionId, requestId: "growth", method: "tools/call", params: {
        name: "insert_structures", arguments: { items: [
          { kind: "molecule", smiles: "CC" }, ...(includeFitting ? [{ kind: "text", text: "Fits" }] : [])
        ] }
      } });
      await vi.advanceTimersByTimeAsync(0);
      expect(prompt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(s.engine.respond).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const reason = "declined: no answer to the enlarge-page question within 5 minutes";
      expect(s.engine.respond).toHaveBeenCalledExactlyOnceWith(sessionId, "growth", { result: expect.objectContaining({
        structuredContent: expect.objectContaining({ reason, declined: expect.any(Array) }),
        content: [expect.objectContaining({ text: expect.stringContaining(reason) })]
      }) });
      const after = s.context.getDocument()!;
      expect(after.pages[0]!.width).toBe(before.pages[0]!.width);
      expect(after.pages[0]!.objects).toHaveLength(includeFitting ? 1 : 0);
      expect(s.history).toHaveLength(includeFitting ? 1 : 0);
      answer("enlarge");
      await vi.advanceTimersByTimeAsync(480_000);
      expect(s.context.getDocument()).toEqual(after);
      expect(s.history).toHaveLength(includeFitting ? 1 : 0);
      expect(s.engine.respond).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { answer?.("decline"); restore(); await s.finish(); }
  });

  it("ignores a late Enlarge answer after host cancellation and draws none of the pending call's items", async () => {
    const s = placementSetup();
    let answer!: (choice: string) => void;
    const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    const restore = setNativePromptProvider(prompt);
    try {
      const before = s.context.getDocument();
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "insert" });
      const pending = s.controller.callTool(s.plugin, { name: "insert_structures", input: { items: [
        { kind: "molecule", smiles: "CC" }, { kind: "text", text: "Also held until the answer" }
      ] } });
      const stopped = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      await s.controller.endRequest(s.plugin, { requestId });
      await stopped;
      answer("enlarge");
      await Promise.resolve();
      expect(s.context.getDocument()).toEqual(before);
      expect(s.history).toHaveLength(0);
    } finally { answer?.("decline"); restore(); await s.finish(); }
  });

  it("rejects a stale plan if the document changes while confirmation is open", async () => {
    const s = placementSetup();
    const restore = setNativePromptProvider(async () => {
      const before = s.context.getDocument()!;
      s.replace(applyPatch(before, { op: "updatePageLayout", pageId: before.pages[0]!.id,
        layout: createCustomPageLayout(500, 350, "css-px", before.pages[0]!.margin) }));
      return "enlarge";
    });
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "insert" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_structures", input: { items: [{ kind: "molecule", smiles: "CC" }] } });
      expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("read it again and retry") }] });
      expect(s.context.getDocument()!.pages[0]!.width).toBe(500);
      expect(s.context.getDocument()!.pages[0]!.objects).toHaveLength(0);
      expect(s.history).toHaveLength(0);
    } finally { restore(); await s.finish(); }
  });
});

describe("assistant requests and MCP bridge", () => {
  it.each(["edited", "moved", "unchanged"])("rechecks the source %s during asynchronous structure building", async change => {
    const s = setup();
    let releaseBuild!: () => void;
    try {
      const build = s.context.chemistry.structureFromSmiles;
      const building = vi.fn();
      s.context.chemistry.structureFromSmiles = async input => {
        building();
        await new Promise<void>(resolve => { releaseBuild = resolve; });
        return build(input);
      };
      const apply = vi.spyOn(s.host, "applyPatchForPlugin");
      await s.controller.beginRequest(s.plugin, { prompt: "replace selection" });
      const pending = s.controller.callTool(s.plugin, { name: "edit_structure", input: { objectId: s.molecule.id, smiles: "CC" } });
      await vi.waitFor(() => expect(building).toHaveBeenCalledOnce());
      if (change !== "unchanged") {
        const before = s.context.getDocument()!;
        const next = { ...before, pages: before.pages.map(page => ({ ...page, objects: page.objects.map(object => {
          if (object.id !== s.molecule.id || object.type !== "molecule") return object;
          return change === "edited" ? { ...object, atoms: object.atoms.map((atom, i) => i === 0 ? { ...atom, element: "N" } : atom) } :
            { ...object, x: object.x + 50, atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + 50 })) };
        }) })) };
        s.port.push(s.context.tabId, before, next, "User edit");
        s.userEdits.forEach(listener => listener(s.context.tabId));
      }
      const preparedAgainst = s.context.getDocument();
      releaseBuild();
      const result = await pending;
      if (change === "unchanged") {
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(apply).toHaveBeenCalledOnce();
        expect(s.history).toHaveLength(1);
        const replacement = s.context.getDocument()!.pages[0]!.objects.find(object => object.type === "molecule")!;
        expect(replacement.id).not.toBe(s.molecule.id);
        expect(replacement.x + replacement.width / 2).toBeCloseTo(s.molecule.x + s.molecule.width / 2);
        expect(replacement.y + replacement.height / 2).toBeCloseTo(s.molecule.y + s.molecule.height / 2);
      } else {
        expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("read it again and retry") }] });
        expect(apply).not.toHaveBeenCalled();
        expect(s.history).toHaveLength(1);
        expect(s.context.getDocument()).toEqual(preparedAgainst);
      }
    } finally { releaseBuild?.(); await s.finish(); }
  });
  it.each(["edit_structure", "delete_objects", "move_objects"])("rechecks new anchors after %s waits for a gesture", async name => {
    const s = setup();
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "change selection" });
      s.gesture.active = true;
      const input = name === "edit_structure" ? { objectId: s.molecule.id, smiles: "CC" } :
        name === "move_objects" ? { objectIds: [s.molecule.id], to: { arrange: "row" } } : { objectIds: [s.molecule.id] };
      const pending = s.controller.callTool(s.plugin, { name, input });
      await vi.waitFor(() => expect(s.gate.pending()).toBe(1));
      const before = s.context.getDocument()!;
      const arrow = DocumentObjectSchema.parse({ id: "new_arrow", type: "mechanism-arrow", arrowKind: "full-headed",
        x: 100, y: 100, width: 20, height: 20,
        source: { kind: "atom", objectId: s.molecule.id, atomId: s.molecule.atoms[0]!.id },
        target: { kind: "point", point: { x: 100, y: 100 } } });
      const next = { ...before, pages: before.pages.map(page => ({ ...page, objects: [...page.objects, arrow] })) };
      s.port.push(s.context.tabId, before, next, "Draw arrow");
      s.userEdits.forEach(listener => listener(s.context.tabId));
      s.gesture.active = false;
      s.gate.flush();
      expect(await pending).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("mechanism-arrow new_arrow") }] });
      expect(s.context.getDocument()).toEqual(next);
      expect(s.history).toHaveLength(1);
    } finally { await s.finish(); }
  });
  const queuedWrites = ["edit_structure", "style_objects", "delete_objects", "move_objects"].flatMap(name =>
    [true, false].map(targetChanged => ({ name, targetChanged })));
  it.each(queuedWrites)("rechecks queued $name after a gesture (target changed: $targetChanged)", async ({ name, targetChanged }) => {
    const s = setup();
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "move selection" });
      s.gesture.active = true;
      const input = name === "edit_structure" ? { objectId: s.molecule.id, smiles: "CC" } :
        name === "style_objects" ? { objectIds: [s.molecule.id], style: { color: "#112233" } } :
        name === "move_objects" ? { objectIds: [s.molecule.id], to: { arrange: "row" } } : { objectIds: [s.molecule.id] };
      const pending = s.controller.callTool(s.plugin, { name, input });
      await vi.waitFor(() => expect(s.gate.pending()).toBe(1));
      const before = s.context.getDocument()!;
      const draggedId = targetChanged ? s.molecule.id : s.text.id;
      const dragged = { ...before, pages: before.pages.map(page => ({ ...page,
        objects: page.objects.map(object => object.id === draggedId ? { ...object, x: object.x + 50 } : object)
      })) };
      s.port.push(s.context.tabId, before, dragged, "Drag");
      s.userEdits.forEach(listener => listener(s.context.tabId));
      s.gesture.active = false;
      s.gate.flush();
      const result = await pending;
      if (targetChanged) {
        expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("read it again and retry") }] });
        expect(s.history).toHaveLength(1);
        expect(s.context.getDocument()).toEqual(dragged);
      } else {
        expect(result.isError).not.toBe(true);
        expect(s.history).toHaveLength(2);
        expect(s.context.getDocument()!.pages[0]!.objects.find(object => object.id === s.text.id)!.x).toBe(s.text.x + 50);
      }
      await s.controller.endRequest(s.plugin, { requestId });
    } finally { await s.finish(); }
  });
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
