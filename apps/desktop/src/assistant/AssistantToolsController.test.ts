import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, createCustomPageLayout, createEmptyDocument, DocumentObjectSchema, nativeDrawingStyleFromObjectStyle, toEngineDocument, undo, redo, type ReactionObject } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions, ProposedDocumentPatchSchema, runPluginWorker, parsePluginManifest, type PluginWorkerHandle,
  type PluginCommandContext, type PluginAssistantToolHandler } from "@chemdraft/plugin-api";
import { PluginHost } from "@chemdraft/plugin-host";
import { AssistantToolsController } from "./AssistantToolsController";
import { AssistantTransactions } from "./assistantTransaction";
import type { AssistantHistoryPort } from "./historyPort";
import type { McpBridgeRequest, McpBridgeResponse } from "./assistantMcpEngine";
import { testContext } from "./tools/testContext";
import { applyPluginDocumentPatch, createPluginWriteGate, PLUGIN_WRITE_MAX_WAIT_MS } from "../plugins/applyPluginDocumentPatch";
import { setNativePromptProvider, type NativePromptOptions } from "../nativePrompt";
import { commitWithPageFit } from "../pageEnlargement";
import { objectRect } from "./placement";
import { buildMoveObjects, translateObject } from "./writeBuilder";
import { applyChargeToolAtPoint } from "../documentWorkflow";
import { PluginWorkerBridge } from "../plugins/PluginWorkerBridge";
import { createWorkerRoutedOptions } from "../plugins/registerBundledPlugins";

function setup(onAssistantToolCall?: PluginAssistantToolHandler, directWrites = false, workerRouted = false, platform?: "macos" | "windows") {
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
  const writeSignals: AbortSignal[] = [];
  const listeners = new Map<string, (message: McpBridgeRequest) => void>();
  const engine = {
    open: vi.fn(async (_plugin, listener: (message: McpBridgeRequest) => void) => {
      const sessionId = `session${listeners.size}`; listeners.set(sessionId, listener);
      return { sessionId, serverName: "chemdraft" as const };
    }),
    close: vi.fn(async (_sessionId: string) => {}), respond: vi.fn(async (_sessionId: string, _requestId: string, _response: McpBridgeResponse) => {}),
    status: vi.fn(async () => ({ listening: true, sessionCount: listeners.size }))
  };
  const controller = new AssistantToolsController({ platform, host: (): PluginHost => host, engine,
    getActiveTabId: () => activeTabId, getSelectionIds, runWrite: apply => gate.run(apply),
    readDocument: port.read, transactions: () => transactions, createContext: () => context });
  const host = new PluginHost({ assistant: controller, getActiveDocument: () => port.read(activeTabId), getSelection: () => ({ objectIds: [], molecules: [] }),
    ...(directWrites ? { getActiveDocument: context.getDocument, applyDocumentPatch: (application: import("@chemdraft/plugin-host").PluginPatchApplicationRequest) => gate.run(() => {
      writeSignals.push(application.signal!);
      application.signal?.throwIfAborted();
      const applied = applyPluginDocumentPatch(context.getDocument()!, application.patch);
      const tx = transactions.activeTransactionForPlugin(context.plugin.id, context.tabId)!;
      transactions.writeAssistantTransaction(tx, applied.document, applied.receipt.objectIds);
      return applied.receipt;
    }) } : {})
  });
  const plugin = { id: context.plugin.id, name: context.plugin.name };
  let commandContext!: PluginCommandContext;
  let release!: () => void;
  const manifest = parsePluginManifest({ ...plugin, version: "0", apiVersion: "^0.1.21", entry: "worker.js",
    permissions: [...AssistantCapabilityPermissions], contributes: { commands: [{ id: "plugin.assistant.submit", title: "Submit" }] }
  });
  const registration = { manifest, onAssistantToolCall, commandHandlers: {
    "plugin.assistant.submit": (ctx: PluginCommandContext) => { commandContext = ctx; return new Promise<void>(resolve => { release = resolve; }); }
  } };
  const workerBridge = workerRouted ? new PluginWorkerBridge({ pluginId: plugin.id, createWorker: () => {
    // Clone and deliver asynchronously in both directions, like a browser Worker.
    let mainListener: (event: { data: unknown }) => void;
    let workerListener: (event: { data: unknown }) => void;
    let terminated = false;
    const deliver = (listener: () => (event: { data: unknown }) => void, message: unknown) => {
      const data = structuredClone(message);
      queueMicrotask(() => { if (!terminated) listener()({ data }); });
    };
    runPluginWorker(registration, {
      postMessage: message => deliver(() => mainListener, message),
      addEventListener: (_type, listener) => { workerListener = listener; }
    });
    return {
      postMessage: message => deliver(() => workerListener, message),
      addEventListener: (type, listener) => { if (type === "message") mainListener = listener; },
      terminate: () => { terminated = true; }
    } as PluginWorkerHandle;
  } }) : undefined;
  host.registerPlugin(manifest, workerBridge ? createWorkerRoutedOptions(manifest, workerBridge) : registration);
  const command = host.invokeCommand("plugin.assistant.submit");
  let sequence = 0;
  const bridge = async (sessionId: string, name: string, input: unknown) => {
    const requestId = String(++sequence);
    listeners.get(sessionId)!({ sessionId, requestId, method: "tools/call", params: { name, arguments: input } });
    await vi.waitFor(() => expect(engine.respond).toHaveBeenCalledWith(sessionId, requestId, expect.anything()));
    return engine.respond.mock.calls.find(call => call[0] === sessionId && call[1] === requestId)![2];
  };
  return { ...fixture, host, controller, engine, plugin, context, listeners, history, port, commandContext, bridge,
    gesture, gate, getSelectionIds, userEdits, transactions, workerBridge, writeSignals,
    select: (ids: string[]) => { selection = ids; }, activate: (tabId: string) => { activeTabId = tabId; },
    finishCommand: async () => { release(); await command; },
    finish: async () => { controller.closeAllForPlugin(plugin.id); gate.dispose(); release(); await command;
      workerBridge?.terminate(); transactions.dispose(); } };
}

afterEach(() => vi.useRealTimers());

describe("assistant write structural sharing", () => {
  it("groups insert_table and a later scoped edit into one request transaction", async () => {
    const s = setup();
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "Table of measured values" });
      const before = s.context.getDocument()!;
      const inserted = await s.controller.callTool(s.plugin, { name: "insert_table", input: {
        columns: [{ header: "Formula" }, { header: "Mass (g)", align: "decimal" }],
        rows: [["H2O", "18.015"]], besideObjectId: s.molecule.id
      } });
      expect(inserted.isError, JSON.stringify(inserted)).not.toBe(true);
      const id = (inserted.structuredContent!.objectIds as string[])[0]!;
      expect(s.context.getDocument()!.selection.objectIds).toContain(id);
      const edited = await s.controller.callTool(s.plugin, { name: "style_objects", input: {
        objectIds: [id], style: { color: "#112233" }
      } });
      expect(edited.isError, JSON.stringify(edited)).not.toBe(true);
      await s.controller.endRequest(s.plugin, { requestId });
      expect(s.history).toHaveLength(1);
      expect(s.history[0]!.before).toBe(before);
      expect(s.history[0]!.label).toBe("ChemDraft Assistant: Table of measured values");
      expect(s.history[0]!.after.pages[0]!.objects.find(object => object.id === id)).toMatchObject({
        type: "table", style: { color: "#112233" }
      });
    } finally { await s.finish(); }
  });
  it.each([1, 5000])("inserts a caption without copying or comparing unchanged graphs (%i molecules, 20 atoms each)", async count => {
    const s = setup();
    const document = s.context.getDocument()!;
    const page = document.pages[0]!;
    const atoms = Array.from({ length: 20 }, (_, index) => ({ ...s.molecule.atoms[0]!,
      id: `atom_${index}`, x: 100 + index * 10, y: 100 }));
    const bonds = atoms.slice(1).map((atom, index) => ({ ...s.molecule.bonds[0]!,
      id: `bond_${index}`, fromAtomId: atoms[index]!.id, toAtomId: atom.id }));
    s.replace(toEngineDocument({ ...document, pages: [{ ...page, objects: [
      ...Array.from({ length: count }, (_, index) => ({ ...s.molecule, id: `molecule_${index}`,
        atoms, bonds, x: 100, y: 100, width: 190, height: 0 })), s.text
    ] }] }));
    s.select([]);
    const before = s.context.getDocument()!;
    const stringify = JSON.stringify;
    let serializedCharacters = 0;
    const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      const result = stringify(...args);
      serializedCharacters += result?.length ?? 0;
      return result;
    });
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "caption" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Caption" } });
      // Count work rather than wall time: CI scheduling must not make this guard flaky.
      // A full-document clone or per-molecule JSON comparison serializes megabytes here.
      const serialized = serializedCharacters;
      serialization.mockRestore();
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(serialized).toBeLessThan(20_000);
      expect(clone.mock.calls.some(([value]) => value === before)).toBe(false);
      expect(s.context.chemistry.inspectStructure).not.toHaveBeenCalled();
      const after = s.context.getDocument()!;
      expect(after.pages[0]!.objects).toHaveLength(count + 2);
      expect(before.pages[0]!.objects).toHaveLength(count + 1);
      expect(after.pages[0]!.objects.slice(0, -1).every((object, index) => object === before.pages[0]!.objects[index])).toBe(true);
      expect(s.history).toHaveLength(1);
      expect(s.history[0]!.before).toBe(before);
      expect(s.history[0]!.after).toBe(after);
      const restored = undo({ past: [before], present: after, future: [] });
      expect(restored.present).toBe(before);
      expect(redo(restored).present).toBe(after);
    } finally { serialization.mockRestore(); clone.mockRestore(); await s.finish(); }
  });
});

function placementSetup(platform?: "macos" | "windows") {
  const s = setup(undefined, false, false, platform);
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

describe.each(["macos", "windows"] as const)("assistant host page enlargement on %s", platform => {
  it("shifts unselected content with the page after scoped verification, keeping only request insertions selected", async () => {
    const s = setup(undefined, false, false, platform);
    const document = s.context.getDocument()!, page = document.pages[0]!;
    const molecule = translateObject(s.molecule, -24 - s.molecule.x, -32 - s.molecule.y);
    s.replace(applyPatch({ ...document, pages: [{ ...page, objects: [molecule, s.text] },
      { ...page, id: "unaffected", objects: [{ ...s.text, id: "other-text" }] }] }, {
      op: "updatePageLayout", pageId: page.id, layout: createCustomPageLayout(400, 300, "css-px", page.margin)
    }));
    s.select([]);
    const before = s.context.getDocument()!;
    const prompt = vi.fn(async () => "enlarge"), restore = setNativePromptProvider(prompt);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "Long caption" });
      const result = await s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Caption\n".repeat(100) } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const inserted = result.structuredContent!.objectIds as string[];
      const after = s.context.getDocument()!;
      expect(after.selection.objectIds).toEqual(inserted);
      expect(after.pages[1]).toEqual(before.pages[1]);
      const moved = after.pages[0]!.objects.find(object => object.id === molecule.id)!;
      expect(moved).toMatchObject({ x: 0, y: 0, atoms: molecule.atoms.map(atom => ({ ...atom, x: atom.x + 24, y: atom.y + 32 })),
        bonds: molecule.bonds, chemistry: molecule.chemistry });
      const caption = await s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Second caption" } });
      expect(caption.isError, JSON.stringify(caption)).not.toBe(true);
      expect(prompt).toHaveBeenCalledOnce();
      await s.controller.endRequest(s.plugin, { requestId });
      const final = s.context.getDocument()!;
      expect(final.selection.objectIds).not.toContain(molecule.id);
      expect(final.selection.objectIds).not.toContain(s.text.id);
      expect(s.history).toHaveLength(1);
      const history = { past: [s.history[0]!.before], present: final, future: [] as typeof final[] };
      expect(undo(history).present).toEqual(before); expect(redo(undo(history)).present).toEqual(final);
    } finally { restore(); await s.finish(); }
  });

  it.each([false, true])("applies the same page-growth decision to native group labels (accepted: %s)", async accepted => {
    const s = placementSetup(platform);
    const document = s.context.getDocument()!;
    s.replace(applyPatch(document, { op: "updatePageLayout", pageId: document.pages[0]!.id,
      layout: createCustomPageLayout(200, 160, "css-px", { top: 36, right: 36, bottom: 36, left: 36 }) }));
    const prompt = vi.fn(async () => accepted ? "enlarge" : "keep");
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
        expect(page.objects).toHaveLength(24);
        expect(result.structuredContent?.reason).toBeUndefined();
      }
      for (const object of page.objects) {
        expect(object).toMatchObject({ type: "molecule", atoms: [expect.objectContaining({ labelLiteral: true })], bonds: [] });
        const rect = objectRect(object);
        if (accepted) {
          expect(rect.x + rect.width).toBeLessThanOrEqual(page.width - page.margin.right + 1e-6);
          expect(rect.y + rect.height).toBeLessThanOrEqual(page.height - page.margin.bottom + 1e-6);
        }
      }
      // The answer has returned control to the request; Stop can immediately cancel it again.
      await s.controller.endRequest(s.plugin, { requestId });
      await expect(s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "After Stop" } })).rejects.toThrow();
    } finally { restore(); await s.finish(); }
  });

  it.each([false, true])("shares the answer across tool calls and direct writes for one request (%s)", async accepted => {
    const s = placementSetup(platform);
    const prompt = vi.fn(async () => accepted ? "enlarge" : "keep");
    const restore = setNativePromptProvider(prompt);
    try {
      const before = s.context.getDocument()!;
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "Large structure and a long caption" });
      const structure = await s.controller.callTool(s.plugin, { name: "insert_structures", input: { items: [{ kind: "molecule", smiles: "CC" }] } });
      const caption = await s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Caption line\n".repeat(100) } });
      expect(structure.isError).not.toBe(true); expect(caption.isError).not.toBe(true);
      // documents.applyPatch in MainWindow reads this same transaction-owned consent.
      expect(await s.transactions.pageEnlargementConsent(requestId, platform).confirm()).toBe(accepted ? "enlarge" : "keep");
      expect(prompt).toHaveBeenCalledOnce();
      await s.controller.endRequest(s.plugin, { requestId });
      expect(s.history).toHaveLength(1);
      const after = s.context.getDocument()!;
      expect(after.pages[0]!.objects).toHaveLength(2);
      if (accepted) expect(after.pages[0]!.height).toBeGreaterThan(before.pages[0]!.height);
      else expect(after.pages[0]!.layout).toEqual(before.pages[0]!.layout);
      const history = { past: [s.history[0]!.before], present: after, future: [] as typeof after[] };
      expect(undo(history).present).toEqual(before);
      expect(redo(undo(history)).present).toEqual(after);
    } finally { restore(); await s.finish(); }
  });

  it("does not prompt for a fitting insertion", async () => {
    const s = placementSetup(platform);
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
    const s = placementSetup(platform);
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
        message: "This doesn't fit on the page. Enlarge the page to fit? Content on the page may shift to make room.",
        choices: [{ id: "enlarge", label: "Enlarge" }, { id: "keep", label: "Keep Page Size", cancel: true }]
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

  it.each([false, true].flatMap(mixed => ["keep", "unknown", "fallback"].map(answer => ({ mixed, answer }))))(
    "$answer keeps every item and its placement on the original page ($mixed)", async ({ mixed, answer }) => {
    const s = placementSetup(platform);
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
      expect(result.structuredContent?.reason).toBeUndefined();
      expect(prompt).toHaveBeenCalledOnce();
      const page = s.context.getDocument()!.pages[0]!;
      expect({ ...page, objects: [] }).toEqual(before);
      expect(page.objects).toHaveLength(mixed ? 4 : 2);
      expect(page.objects.some(object => object.type === "text" && object.text === "Olympiadane")).toBe(true);
      if (mixed) expect(page.objects.some(object => object.type === "text" && object.text === "Ethane")).toBe(true);
      expect(s.history).toHaveLength(1);
    } finally { restore(); await s.finish(); }
  });

  it.each(["insert_reaction", "insert_text"].flatMap(name => [false, true].map(accepted => ({ name, accepted }))))(
    "asks once for non-fitting $name (accepted: $accepted)", async ({ name, accepted }) => {
    const s = placementSetup(platform);
    const prompt = vi.fn(async () => accepted ? "enlarge" : "keep");
    const restore = setNativePromptProvider(prompt);
    try {
      await s.controller.beginRequest(s.plugin, { prompt: "insert" });
      const input = name === "insert_text" ? { text: "A line\n".repeat(100) } : { reactants: ["CC"], products: ["CC"] };
      const result = await s.controller.callTool(s.plugin, { name, input });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent?.reason).toBeUndefined();
      expect(prompt).toHaveBeenCalledOnce();
      const page = s.context.getDocument()!.pages[0]!;
      if (accepted) {
        expect(page.objects.length).toBeGreaterThan(0);
        for (const object of page.objects) {
          const rect = objectRect(object);
          expect(rect.x + rect.width).toBeLessThanOrEqual(page.width - page.margin.right + 1e-6);
          expect(rect.y + rect.height).toBeLessThanOrEqual(page.height - page.margin.bottom + 1e-6);
        }
      } else {
        expect(page.objects.length).toBeGreaterThan(0);
        expect(page.width).toBe(400); expect(page.height).toBe(300);
      }
      expect(s.history).toHaveLength(1);
    } finally { restore(); await s.finish(); }
  });

  it("wraps real widths first, then asks once to grow the height for the whole set", async () => {
    const s = placementSetup(platform);
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
    const s = placementSetup(platform);
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
    const s = placementSetup(platform);
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
      // Another tool in the same request must not reinterpret the timeout as explicit Keep.
      const second = await s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Long caption\n".repeat(100) } });
      expect(second.structuredContent?.reason).toBe(reason);
      expect(second.structuredContent?.objectIds).toEqual([]);
      // MainWindow uses this same preflight for direct documents.applyPatch writes.
      const proposed = applyPluginDocumentPatch(after, ProposedDocumentPatchSchema.parse({ reason: "Direct plugin write", patch: {
        op: "addObject", pageId: after.pages[0]!.id,
        object: DocumentObjectSchema.parse({ id: "direct-overflow", type: "plus", x: 0, y: 0, width: 1000, height: 1000 })
      } })).document;
      const commit = vi.fn();
      await expect(commitWithPageFit(after, proposed, commit, {
        consent: s.transactions.pageEnlargementConsent(requestId, platform)
      })).rejects.toThrow("No answer to the enlarge-page question");
      expect(commit).not.toHaveBeenCalled();
      expect(s.context.getDocument()).toEqual(after);
      expect(s.history).toHaveLength(includeFitting ? 1 : 0);
      expect(prompt).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { answer?.("decline"); restore(); await s.finish(); }
  });

  it("honours the tool's five-minute deadline when a direct plugin write opened the shared prompt first", async () => {
    vi.useFakeTimers();
    const s = placementSetup(platform);
    let answer!: (choice: string) => void;
    const prompt = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    const restore = setNativePromptProvider(prompt);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "Mixed writes" });
      const before = s.context.getDocument()!;
      const proposed = applyPluginDocumentPatch(before, ProposedDocumentPatchSchema.parse({ reason: "Direct plugin write", patch: {
        op: "addObject", pageId: before.pages[0]!.id,
        object: DocumentObjectSchema.parse({ id: "direct-first", type: "plus", x: 0, y: 0, width: 1000, height: 1000 })
      } })).document;
      const commit = vi.fn();
      // This caller has no human-decision deadline. The later tool still has its own.
      const direct = Promise.resolve(commitWithPageFit(before, proposed, commit, {
        consent: s.transactions.pageEnlargementConsent(requestId, platform)
      })).then(() => "committed", error => (error as Error).message);
      const pending = s.controller.callTool(s.plugin, { name: "insert_text", input: { text: "Long caption\n".repeat(100) } });
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(299_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await pending).structuredContent?.reason).toBe("declined: no answer to the enlarge-page question within 5 minutes");
      expect(await direct).toContain("No answer to the enlarge-page question");
      expect(commit).not.toHaveBeenCalled();
      expect(s.context.getDocument()).toBe(before);
      expect(s.history).toHaveLength(0);
      answer("enlarge");
      await vi.advanceTimersByTimeAsync(0);
      expect(s.context.getDocument()).toBe(before);
      expect(prompt).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { answer?.("keep"); restore(); await s.finish(); }
  });

  it("ignores a late Enlarge answer after host cancellation and draws none of the pending call's items", async () => {
    const s = placementSetup(platform);
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
    const s = placementSetup(platform);
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
  it("refuses a floating charge mark introduced after verification while waiting for a gesture", async () => {
    const s = setup();
    try {
      const input = { objectIds: [s.molecule.id], to: { relativeTo: s.text.id, side: "right" as const } };
      const planned = applyPatch(s.context.getDocument()!, buildMoveObjects(s.context, input).patch);
      const moved = planned.pages[0]!.objects.find(object => object.id === s.molecule.id)!;
      if (moved.type !== "molecule") throw new Error("Expected molecule");
      const atom = moved.atoms[0]!;
      await s.controller.beginRequest(s.plugin, { prompt: "move" });
      s.gesture.active = true;
      const pending = s.controller.callTool(s.plugin, { name: "move_objects", input });
      await vi.waitFor(() => expect(s.gate.pending()).toBe(1));
      const before = s.context.getDocument()!;
      // The queued patch is already placed; this later mark cannot trigger replanning.
      // Just outside one bond length, but inside the 1.15-bond association radius.
      const markOffset = nativeDrawingStyleFromObjectStyle(moved.style).bondLengthPx * 1.1;
      const withMark = applyChargeToolAtPoint(before, 1, { x: atom.x - markOffset, y: atom.y });
      s.port.push(s.context.tabId, before, withMark, "Draw charge");
      s.userEdits.forEach(listener => listener(s.context.tabId));
      s.gesture.active = false;
      s.gate.flush();
      expect(await pending).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("unselected charge mark") }] });
      expect(s.context.getDocument()).toBe(withMark);
      expect(s.history).toHaveLength(1);
      expect(s.history[0]!.label).toBe("Draw charge");
    } finally { await s.finish(); }
  });
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
  it.each([false, true])("checks removal cascades in the request tab after switching tabs (reaction in scope = %s)", async inScope => {
    const s = setup();
    try {
      const step: ReactionObject = {
        id: "step", type: "reaction", x: 0, y: 0, width: 100, height: 30, rotation: 0, style: {},
        mappingState: "absent", components: [], conditionsTextObjectIds: [], arrowObjectIds: [], plusObjectIds: []
      };
      s.replace(applyPatch(s.context.getDocument()!, {
        op: "addObject", pageId: s.context.getDocument()!.pages[0]!.id, object: step
      }));
      s.select(inScope ? [s.text.id, step.id] : [s.text.id]);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "delete selected text" });
      const foreground = createEmptyDocument();
      const read = s.port.read;
      vi.spyOn(s.port, "read").mockImplementation(tab => tab === "another-tab" ? foreground : read(tab));
      s.activate("another-tab");
      s.gesture.active = true;
      const pending = s.controller.callTool(s.plugin, { name: "delete_objects", input: { objectIds: [s.text.id] } });
      await vi.waitFor(() => expect(s.gate.pending()).toBe(1));
      // A reaction now references the text while the write waits for the drawing gesture.
      // This reaches the host's removal check after preparation's normalization check.
      s.replace(applyPatch(s.context.getDocument()!, {
        op: "updateObject", objectId: step.id, changes: { conditionsTextObjectIds: [s.text.id] }
      }));
      s.userEdits.forEach(listener => listener(s.context.tabId));
      const before = s.context.getDocument()!;
      const scopedWrite = vi.spyOn(s.host, "applyPatchForPlugin");
      s.gesture.active = false;
      s.gate.flush();
      const result = await pending;
      expect(scopedWrite).toHaveBeenCalledOnce();
      if (inScope) {
        expect(result).toMatchObject({ structuredContent: { objectIds: [s.text.id] } });
        expect(s.history).toHaveLength(1);
        expect(s.history[0]!.before).toBe(before);
        const objects = s.context.getDocument()!.pages[0]!.objects;
        expect(objects.some(object => object.id === s.text.id)).toBe(false);
        expect(objects.find(object => object.id === step.id)).toMatchObject({ conditionsTextObjectIds: [] });
      } else {
        expect(result).toMatchObject({ isError: true, content: [{ text:
          `Plugin patch refused: removing ${s.text.id} would change reaction step, which this command may not modify.`
        }] });
        expect(s.history).toHaveLength(0);
        expect(s.context.getDocument()).toBe(before);
      }
      expect(s.port.read("another-tab")).toBe(foreground);
      expect(foreground.pages[0]!.objects).toEqual([]);
      await s.controller.endRequest(s.plugin, { requestId });
    } finally { await s.finish(); }
  });
  it("refuses out-of-scope edits, empty-selection edits, writes without an own command, and calls on a closed tab", async () => {
    const s = setup();
    try {
      s.select([]);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "add" });
      expect(await s.controller.callTool(s.plugin, { name: "delete_objects", input: { objectIds: [s.text.id] } })).toMatchObject({ structuredContent: { refused: true } });
      // Check the host gate independently of the tool's own scope check.
      await expect(s.host.applyPatchForPlugin(s.plugin.id, undefined, { patch: { op: "removeObject", pageId: s.context.getDocument()!.pages[0]!.id, objectId: s.text.id }, reason: "test", requiresUserApproval: true }, { objectIds: [], getDocument: s.context.getDocument, apply: () => ({ applied: true, objectIds: [] }) })).rejects.toThrow("not selected");
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


const EXTRA_TOOL = { name: "plugin_lookup", description: "Look up a plugin-owned record", inputSchema: { type: "object", properties: { key: { type: "string" } } } };
const TOOL_OK = { content: [{ type: "text" as const, text: "plugin result" }] };

describe("session-scoped plugin assistant tools", () => {
  it.each(["settle", "cancel", "unregister"])("keeps one write lifetime per assistant tool and aborts it on %s", async action => {
    let release!: () => void;
    const s = setup(async context => {
      for (const id of ["first-note", "second-note"]) {
        await context.documents.applyPatch!({ reason: "Insert record", patch: {
          op: "addObject", pageId: s.context.getDocument()!.pages[0]!.id, object: { ...s.text, id }
        } });
      }
      await new Promise<void>(resolve => { release = resolve; });
      return TOOL_OK;
    }, true);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "record" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      const pending = s.bridge(session.sessionId, EXTRA_TOOL.name, {});
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(s.writeSignals).toHaveLength(2);
      expect(s.writeSignals[0]).toBe(s.writeSignals[1]);
      expect(s.writeSignals[0]!.aborted).toBe(false);
      if (action === "cancel") await s.controller.closeToolSession(s.plugin, { sessionId: session.sessionId });
      else if (action === "unregister") s.host.unregisterPlugin(s.plugin.id);
      else release();
      await pending;
      expect(s.writeSignals[0]!.aborted).toBe(true);
    } finally { release?.(); await s.finish(); }
  });

  it("lists the session's tools and routes calls to its owning handler with declared capabilities", async () => {
    const handler = vi.fn<PluginAssistantToolHandler>(async (context, call) => {
      expect(context.plugin.id).toBe(s.plugin.id);
      expect(context.chemistry).toBeDefined();
      expect(context.storage).toBeUndefined(); // no plugin.storage permission
      expect(call.input).toEqual({ key: "record" });
      return TOOL_OK;
    });
    const s = setup(handler);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "look up a record" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      expect(session.tools).toContain(EXTRA_TOOL.name);
      s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: "list", method: "tools/list", params: {} });
      await vi.waitFor(() => expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, "list",
        { result: { tools: expect.arrayContaining([EXTRA_TOOL, expect.objectContaining({ name: "get_document" })]) } }));
      expect(await s.controller.listTools(s.plugin)).not.toContainEqual(EXTRA_TOOL);
      expect(await s.bridge(session.sessionId, EXTRA_TOOL.name, { key: "record" })).toEqual({ result: TOOL_OK });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![1]).toEqual({ sessionId: session.sessionId, name: EXTRA_TOOL.name, input: { key: "record" } });
      expect(await s.bridge(session.sessionId, "get_document", {})).toHaveProperty("result");
    } finally { await s.finish(); }
  });

  it("keeps direct handler patches in the request scope and history for later host tools", async () => {
    const s = setup(async context => {
      const receipt = await context.documents.applyPatch!({ reason: "Insert record", patch: {
        op: "addObject", pageId: s.context.getDocument()!.pages[0]!.id,
        object: { ...s.text, id: "plugin-note", text: "Record" }
      } });
      return { content: [{ type: "text", text: "Inserted" }], structuredContent: receipt };
    }, true);
    try {
      s.select([]);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "record" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      expect(await s.bridge(session.sessionId, EXTRA_TOOL.name, {})).toMatchObject({ result: { structuredContent: { applied: true } } });
      expect(await s.bridge(session.sessionId, "style_objects", { objectIds: ["plugin-note"], style: { color: "#123456" } }))
        .toMatchObject({ result: { structuredContent: { objectIds: ["plugin-note"] } } });
      expect(s.history).toHaveLength(1);
      expect(await s.controller.endRequest(s.plugin, { requestId })).toMatchObject({ touchedIds: ["plugin-note"], summary: "1 object(s) changed." });
    } finally { await s.finish(); }
  });

  it("refuses a deferred handler patch after its session closes", async () => {
    const s = setup(async context => {
      await context.documents.applyPatch!({ reason: "Insert record", patch: {
        op: "addObject", pageId: s.context.getDocument()!.pages[0]!.id, object: { ...s.text, id: "cancelled-note" }
      } });
      return TOOL_OK;
    }, true);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "record" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      s.gesture.active = true;
      s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: "deferred", method: "tools/call", params: { name: EXTRA_TOOL.name } });
      await vi.waitFor(() => expect(s.gate.pending()).toBe(1));
      await s.controller.closeToolSession(s.plugin, { sessionId: session.sessionId });
      s.gesture.active = false; s.gate.flush();
      await vi.waitFor(() => expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, "deferred", expect.objectContaining({ result: expect.objectContaining({ isError: true }) })));
      expect(s.history).toHaveLength(0);
      expect(s.context.getDocument()!.pages[0]!.objects.some(object => object.id === "cancelled-note")).toBe(false);
    } finally { await s.finish(); }
  });

  it.each([
    [{ ...EXTRA_TOOL, name: "BadName" }, "name"],
    [{ ...EXTRA_TOOL, name: "a".repeat(49) }, "name"],
    [{ ...EXTRA_TOOL, description: "a".repeat(1001) }, "description"],
    [{ ...EXTRA_TOOL, inputSchema: [] }, "inputSchema"],
    [{ ...EXTRA_TOOL, inputSchema: { description: "x".repeat(16_384) } }, "inputSchema"],
    [{ ...EXTRA_TOOL, inputSchema: { description: "é".repeat(8192) } }, "inputSchema"],
    [{ ...EXTRA_TOOL, name: "get_document" }, "collides"]
  ])("refuses the whole session for invalid extra tool %#", async (tool, message) => {
    const s = setup(async () => TOOL_OK);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "test" });
      await expect(s.controller.createToolSession(s.plugin, { requestId, extraTools: [tool] } as never)).rejects.toThrow(message);
      expect(s.engine.open).not.toHaveBeenCalled();
    } finally { await s.finish(); }
  });

  it("refuses more than eight tools, duplicates, and a missing handler", async () => {
    const s = setup();
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "test" });
      await expect(s.controller.createToolSession(s.plugin, { requestId, extraTools: Array.from({ length: 9 }, (_, i) => ({ ...EXTRA_TOOL, name: `extra_${i}` })) })).rejects.toThrow("8");
      await expect(s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL, EXTRA_TOOL] })).rejects.toThrow("collides");
      await expect(s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] })).rejects.toThrow("no assistant tool handler");
      expect(s.engine.open).not.toHaveBeenCalled();
    } finally { await s.finish(); }
  });

  it("refuses extra tools up front when the worker registered no handler", async () => {
    const s = setup(undefined, false, true);
    try {
      await s.workerBridge!.whenReady();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(s.host.hasAssistantToolHandler(s.plugin.id)).toBe(false);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "lookup" });
      await expect(s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] }))
        .rejects.toThrow("no assistant tool handler");
      expect(s.engine.open).not.toHaveBeenCalled();
      // A worker without an extra-tool handler can still use the host's tools.
      await expect(s.controller.createToolSession(s.plugin, { requestId })).resolves.toHaveProperty("sessionId");
    } finally { await s.finish(); }
  });

  it("allows eight tools and snapshots their schemas before asynchronous session opening", async () => {
    const s = setup(async () => TOOL_OK);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "test" });
      const tools = Array.from({ length: 8 }, (_, i) => ({ ...EXTRA_TOOL, name: `extra_${i}`, inputSchema: { type: "object" } }));
      const opening = s.controller.createToolSession(s.plugin, { requestId, extraTools: tools });
      tools[0]!.inputSchema.type = "changed";
      const session = await opening;
      s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: "list", method: "tools/list", params: {} });
      await vi.waitFor(() => expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, "list",
        { result: { tools: expect.arrayContaining([expect.objectContaining({ name: "extra_0", inputSchema: { type: "object" } })]) } }));
    } finally { await s.finish(); }
  });

  it("turns thrown errors, invalid results, and oversized results into model-visible tool errors", async () => {
    const handler = vi.fn<PluginAssistantToolHandler>()
      .mockRejectedValueOnce(new Error("lookup failed"))
      .mockResolvedValueOnce({ noContent: true } as never)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] });
    const s = setup(handler);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "lookup" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      expect(await s.bridge(session.sessionId, EXTRA_TOOL.name, {})).toMatchObject({ result: { isError: true, content: [{ text: "lookup failed" }] } });
      for (let i = 0; i < 2; i++) expect(await s.bridge(session.sessionId, EXTRA_TOOL.name, {})).toMatchObject({ result: { isError: true } });
    } finally { await s.finish(); }
  });

  it("times out after 120 seconds and aborts the handler", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const s = setup((_ctx, _call, abort) => { signal = abort; return new Promise(() => {}); });
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "lookup" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: "timeout", method: "tools/call", params: { name: EXTRA_TOOL.name } });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(signal.aborted).toBe(true);
      expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, "timeout",
        { result: { isError: true, content: [{ type: "text", text: expect.stringContaining("deadline") }] } });
    } finally { await s.finish(); }
  });

  it.each([false, true])("holds slots across repeated timeouts until abort-ignoring handlers settle (worker: %s)", async worker => {
    vi.useFakeTimers();
    let running = 0;
    let maximumRunning = 0;
    const pending: { resolve(): void; reject(): void; signal: AbortSignal }[] = [];
    const handler = vi.fn<PluginAssistantToolHandler>(async (_context, _call, signal) => {
      maximumRunning = Math.max(maximumRunning, ++running);
      try {
        await new Promise<void>((resolve, reject) => pending.push({ resolve,
          reject: () => reject(new Error("late failure")), signal }));
        return TOOL_OK;
      } finally { running--; }
    });
    const s = setup(handler, false, worker);
    try {
      await s.workerBridge?.whenReady();
      await vi.advanceTimersByTimeAsync(0);
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "lookup" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      const send = (requestId: string) => s.listeners.get(session.sessionId)!({ sessionId: session.sessionId,
        requestId, method: "tools/call", params: { name: EXTRA_TOOL.name } });
      for (let i = 0; i < 4; i++) {
        send(`timeout${i}`);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, `timeout${i}`,
          { result: { isError: true, content: [{ type: "text", text: expect.stringContaining("deadline") }] } });
        expect(pending[i]!.signal.aborted).toBe(true);
        expect(running).toBe(i + 1);
      }
      for (let i = 0; i < 3; i++) {
        send(`blocked${i}`);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, `blocked${i}`,
          { result: { isError: true, content: [{ type: "text", text: expect.stringContaining("four") }] } });
      }
      expect(handler).toHaveBeenCalledTimes(4);
      await expect(s.controller.callTool(s.plugin, { name: "get_document", input: {} })).rejects.toThrow("four");
      // Both fulfillment and rejection of abandoned work must release the slot.
      pending[0]!.resolve();
      pending[1]!.reject();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 2; i++) send(`replacement${i}`);
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledTimes(6);
      expect(running).toBe(4);
      expect(maximumRunning).toBe(4);
      pending.slice(2).forEach(call => call.resolve());
      await vi.advanceTimersByTimeAsync(0);
      expect(running).toBe(0);
      expect(s.engine.respond.mock.calls.filter(([, id]) => id.startsWith("timeout"))).toHaveLength(4);
      await expect(s.controller.callTool(s.plugin, { name: "get_document", input: {} })).resolves.toHaveProperty("content");
    } finally {
      pending.forEach(call => call.resolve());
      await vi.advanceTimersByTimeAsync(0);
      await s.finish();
    }
  });

  it.each(["close", "unregister", "end"] as const)("%s cancels pending calls and refuses late calls", async action => {
    let signal!: AbortSignal;
    const handler = vi.fn<PluginAssistantToolHandler>((_ctx, _call, abort) => { signal = abort; return new Promise(() => {}); });
    const s = setup(handler);
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "lookup" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: "pending", method: "tools/call", params: { name: EXTRA_TOOL.name } });
      if (action === "close") await s.controller.closeToolSession(s.plugin, { sessionId: session.sessionId });
      else if (action === "end") await s.controller.endRequest(s.plugin, { requestId });
      else s.host.unregisterPlugin(s.plugin.id);
      expect(signal.aborted).toBe(true);
      await vi.waitFor(() => expect(s.engine.respond).toHaveBeenCalledWith(session.sessionId, "pending", expect.objectContaining({ result: expect.objectContaining({ isError: true }) })));
      expect(await s.bridge(session.sessionId, EXTRA_TOOL.name, {})).toHaveProperty("error");
      expect(handler).toHaveBeenCalledTimes(1);
    } finally { await s.finish(); }
  });

  it("shares the four-call limit with host tools", async () => {
    const s = setup(() => new Promise(() => {}));
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "lookup" });
      const session = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      for (let i = 0; i < 4; i++) s.listeners.get(session.sessionId)!({ sessionId: session.sessionId, requestId: `busy${i}`, method: "tools/call", params: { name: EXTRA_TOOL.name } });
      expect(await s.bridge(session.sessionId, EXTRA_TOOL.name, {})).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("four") }] } });
      await expect(s.controller.callTool(s.plugin, { name: "get_document", input: {} })).rejects.toThrow("four");
    } finally { await s.finish(); }
  });

  it("isolates tool lists and calls by session and plugin", async () => {
    const handler = vi.fn<PluginAssistantToolHandler>(async () => TOOL_OK);
    const s = setup(handler);
    const other = { id: "org.test.other", name: "Other" };
    s.host.registerPlugin({ ...other, version: "0", apiVersion: "^0.1.21", entry: "worker.js", permissions: [...AssistantCapabilityPermissions] },
      { onAssistantToolCall: handler });
    try {
      const { requestId } = await s.controller.beginRequest(s.plugin, { prompt: "lookup" });
      const own = await s.controller.createToolSession(s.plugin, { requestId, extraTools: [EXTRA_TOOL] });
      const plain = await s.controller.createToolSession(s.plugin, { requestId });
      expect(plain.tools).not.toContain(EXTRA_TOOL.name);
      expect(await s.bridge(plain.sessionId, EXTRA_TOOL.name, {})).toMatchObject({ result: { isError: true } });
      await expect(s.controller.closeToolSession(other, { sessionId: own.sessionId })).rejects.toThrow("does not belong");
      await expect(s.controller.createToolSession(other, { requestId, extraTools: [EXTRA_TOOL] })).rejects.toThrow("does not belong");
      // A native message injected into another session's listener cannot cross session ownership.
      s.listeners.get(own.sessionId)!({ sessionId: plain.sessionId, requestId: "plain", method: "tools/list", params: {} });
      await vi.waitFor(() => expect(s.engine.respond).toHaveBeenCalledWith(plain.sessionId, "plain",
        { result: { tools: expect.not.arrayContaining([EXTRA_TOOL]) } }));
      expect(handler).not.toHaveBeenCalled();
    } finally { await s.finish(); s.host.unregisterPlugin(other.id); }
  });
});
