import type { PluginCommandInput, PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { toEngineDocument } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions } from "@chemdraft/plugin-api";
import { AssistantTransactions } from "../assistant/assistantTransaction";
import { testContext } from "../assistant/tools/testContext";
import type { AssistantHistoryPort } from "../assistant/historyPort";
import { describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { RECOGNITION_FIXTURE_COMMAND_ID, recognitionFixtureDescriptor } from "../testSupport/recognitionFixturePlugin";
import { createPluginRuntime } from "./createPluginRuntime";
import { canvasOverlayPrompt } from "./pluginCanvasOverlayControls";
import { ImageSourceRegistry } from "./ImageSourceProvider";
import { proposalReviewItem } from "./PatchReviewTray";
import { recognitionDisagreementWarning } from "./recognitionAgreement";
import type {
  StructureRecognitionAgreement,
  StructureRecognitionEngine,
  StructureRecognitionEngineStatus,
  StructureRecognitionOutcome
} from "./structureRecognitionEngine";

const emptySelection: PluginSelectionSnapshot = { objectIds: [], molecules: [] };

describe("createPluginRuntime canvas overlays", () => {
  const commandId = "plugin.chat.submit";
  const overlayId = "overlay.chat.main";
  const manifest = {
    id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js",
    permissions: ["ui.canvas"], contributes: {
      commands: [{ id: commandId, title: "Send" }],
      canvasOverlays: [{ id: overlayId, title: "Chat", icon: "data:image/png;base64,YQ==",
        commandId, prompt: { kind: "prompt", id: "composer", commandId } }]
    }
  };

  it.each([false, true])("replaces prompt disabled state on every content call (declared %s)", async disabled => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    runtime.registerPlugin({ ...manifest, contributes: { ...manifest.contributes,
      canvasOverlays: [{ ...manifest.contributes.canvasOverlays[0], prompt: { kind: "prompt", id: "composer", commandId, disabled } }]
    } });
    const overlay = runtime.listCanvasOverlays()[0]!.overlay;
    const live = () => canvasOverlayPrompt(overlay, runtime.getCanvasOverlayContents().get(overlayId) ?? []);
    const api = runtime.host.createCommandContext(manifest.id).overlays!;
    expect(live().disabled).toBe(disabled);
    for (const prompt of [{ disabled: true }, undefined, { disabled: true }, {}, { disabled: true }, { disabled: false }]) {
      await api.setContent({ overlayId, sections: [], ...(prompt ? { prompt } : {}) });
      expect(live().disabled ?? false).toBe(prompt?.disabled ?? false);
    }
    expect(overlay.prompt.disabled).toBe(disabled);
    runtime.unregisterPlugin(manifest.id);
    expect(runtime.getCanvasOverlayContents().size).toBe(0);
  });

  it("keeps content/open notifications separate from toolset sync and clears them on replacement", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    runtime.registerPlugin(manifest, { commandHandlers: { [commandId]: ctx => ctx.overlays!.open({ overlayId, focus: true }) } });
    const sync = vi.fn(); const changed = vi.fn(); const opened = vi.fn();
    runtime.onDidChange(sync);
    const offContent = runtime.subscribeCanvasOverlayContent(changed);
    const offOpen = runtime.subscribeCanvasOverlayOpen(opened);
    const api = runtime.host.createCommandContext(manifest.id).overlays!;
    await api.setContent({ overlayId, sections: [{ kind: "actions", id: "setup", buttons: [
      { id: "go", label: "Go", commandId, payload: { nested: ["original"] } }
    ] }] });
    const snapshot = runtime.getCanvasOverlayContents();
    const action = snapshot.get(overlayId)![0]!;
    expect(Object.isFrozen(action)).toBe(true);
    if (action.kind !== "actions") throw new Error("Expected actions");
    expect(Object.isFrozen(action.buttons[0]!.payload)).toBe(true);
    (snapshot as Map<string, unknown>).clear();
    expect(runtime.getCanvasOverlayContents().size).toBe(1);
    await runtime.invokeCommand(commandId);
    const first = runtime.getCanvasOverlayOpenRequests().get(overlayId);
    await runtime.invokeCommand(commandId);
    expect(runtime.getCanvasOverlayOpenRequests().get(overlayId)).not.toBe(first);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
    await api.setContent({ overlayId, sections: [] });
    expect(runtime.getCanvasOverlayContents().size).toBe(0);
    await api.setContent({ overlayId, sections: [{ kind: "text", body: "Setup" }] });
    runtime.replacePlugin(manifest.id, manifest);
    expect(runtime.getCanvasOverlayContents().size).toBe(0);
    expect(runtime.getCanvasOverlayOpenRequests().size).toBe(0);
    offContent(); offOpen();
    changed.mockClear(); opened.mockClear();
    await runtime.host.createCommandContext(manifest.id).overlays!.setContent({ overlayId, sections: [] });
    expect(changed).not.toHaveBeenCalled();
    runtime.unregisterPlugin(manifest.id);
  });

  it("publishes status changes only to overlay status subscribers without leaking snapshots", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined, getSelection: () => emptySelection });
    const contributionChanges: { ids: string[]; statuses: [string, string][] }[] = [];
    const statusChanges: [string, string][][] = [];
    const unsubscribe = runtime.onDidChange(() => contributionChanges.push({
      ids: runtime.listCanvasOverlays().map(entry => entry.overlay.id),
      statuses: [...runtime.getCanvasOverlayStatuses()]
    }));
    const unsubscribeStatus = runtime.subscribeCanvasOverlayStatus(() => statusChanges.push([...runtime.getCanvasOverlayStatuses()]));
    expect(runtime.listCanvasOverlays()).toEqual([]);
    expect(runtime.getCanvasOverlayStatuses().size).toBe(0);
    runtime.registerPlugin(manifest, { commandHandlers: {
      [commandId]: async ctx => {
        await ctx.overlays!.setStatus({ overlayId, text: ctx.input?.text ?? "" });
        return ctx.input;
      }
    } });
    const input: PluginCommandInput = { source: "overlay", overlayId, sectionId: "composer", control: "prompt", text: "Working" };
    expect(await runtime.invokeCommand(commandId, { input })).toEqual(input);
    const snapshot = runtime.getCanvasOverlayStatuses();
    expect(snapshot.get(overlayId)).toBe("Working");
    await runtime.invokeCommand(commandId, { input }); // unchanged status does not notify
    expect(contributionChanges).toHaveLength(1);
    expect(statusChanges).toEqual([[[overlayId, "Working"]]]);
    await runtime.invokeCommand(commandId);
    expect(runtime.getCanvasOverlayStatuses().size).toBe(0);
    expect(snapshot.get(overlayId)).toBe("Working");
    await runtime.invokeCommand(commandId, { input });
    runtime.unregisterPlugin(manifest.id);
    expect(runtime.listCanvasOverlays()).toEqual([]);
    expect(runtime.getCanvasOverlayStatuses().size).toBe(0);
    expect(contributionChanges).toEqual([
      { ids: [overlayId], statuses: [] },
      { ids: [], statuses: [] }
    ]);
    expect(statusChanges).toEqual([
      [[overlayId, "Working"]],
      [],
      [[overlayId, "Working"]],
      []
    ]);
    unsubscribe();
    unsubscribeStatus();
    runtime.registerPlugin(manifest);
    expect(contributionChanges).toHaveLength(2);
    runtime.unregisterPlugin(manifest.id);
  });

  it("publishes immutable transcripts without triggering contribution/toolset or status synchronization", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined, getSelection: () => emptySelection });
    runtime.registerPlugin(manifest);
    const contributions = vi.fn(); const statuses = vi.fn(); const transcripts = vi.fn();
    runtime.onDidChange(contributions);
    runtime.subscribeCanvasOverlayStatus(statuses);
    const unsubscribe = runtime.subscribeCanvasOverlayTranscript(transcripts);
    const api = runtime.host.createCommandContext(manifest.id).overlays!;
    await api.setTranscript({ overlayId, entries: [{ role: "assistant", text: "First" }] });
    const snapshot = runtime.getCanvasOverlayTranscripts().get(overlayId)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(runtime.getCanvasOverlayTranscripts().get(overlayId)).toBe(snapshot);
    await api.setTranscript({ overlayId, entries: [{ role: "error", text: "Second" }] });
    expect(snapshot[0]!.text).toBe("First");
    await api.setTranscript({ overlayId, entries: [] });
    expect(runtime.getCanvasOverlayTranscripts().size).toBe(0);
    expect(contributions).not.toHaveBeenCalled();
    expect(statuses).not.toHaveBeenCalled();
    expect(transcripts).toHaveBeenCalledTimes(3);
    await api.setTranscript({ overlayId, entries: [{ role: "notice", text: "Last" }] });
    runtime.unregisterPlugin(manifest.id);
    expect(runtime.getCanvasOverlayTranscripts().size).toBe(0);
    expect(transcripts).toHaveBeenCalledTimes(5);
    unsubscribe(); runtime.registerPlugin(manifest);
    await runtime.host.createCommandContext(manifest.id).overlays!.setTranscript({ overlayId, entries: [{ role: "user", text: "New" }] });
    expect(transcripts).toHaveBeenCalledTimes(5);
    runtime.unregisterPlugin(manifest.id);
  });

  it("rolls back a duplicate overlay registration and clears status on replacement", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined, getSelection: () => emptySelection });
    runtime.registerPlugin(manifest);
    await runtime.host.createCommandContext(manifest.id).overlays!.setStatus({ overlayId, text: "Old" });
    expect(() => runtime.registerPlugin({ ...manifest, id: "other", contributes: {
      commands: [{ id: "plugin.other.submit", title: "Other" }],
      canvasOverlays: [{ ...manifest.contributes.canvasOverlays[0], commandId: "plugin.other.submit",
        prompt: { kind: "prompt", id: "composer", commandId: "plugin.other.submit" } }]
    } })).toThrow(/already contributed/);
    expect(runtime.host.commands.has("plugin.other.submit")).toBe(false);
    expect(runtime.listCanvasOverlays()).toHaveLength(1);
    runtime.replacePlugin(manifest.id, { ...manifest, contributes: { ...manifest.contributes, canvasOverlays: [] } });
    expect(runtime.listCanvasOverlays()).toEqual([]);
    expect(runtime.getCanvasOverlayStatuses().size).toBe(0);
    runtime.unregisterPlugin(manifest.id);
  });
});


describe("createPluginRuntime panel input", () => {
  it("omits the host options argument when input is undefined", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined, getSelection: () => emptySelection });
    const commandId = "plugin.chat.submit";
    runtime.registerPlugin({
      id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js", permissions: ["ui.panel", "selection.read"],
      contributes: { commands: [{ id: commandId, title: "Send" }], panels: [{ id: "panel.chat.main", title: "Chat" }] }
    }, { commandHandlers: { [commandId]: async ctx => ctx.input } });
    const invoke = vi.spyOn(runtime.host, "invokeCommand");
    const input: PluginCommandInput = { source: "panel", panelId: "panel.chat.main", sectionId: "composer", control: "prompt", text: "Draw water" };

    await runtime.invokeCommand(commandId);
    expect(invoke).toHaveBeenLastCalledWith(commandId);
    await runtime.invokeCommand(commandId, { input });
    expect(invoke).toHaveBeenLastCalledWith(commandId, { input });
    runtime.unregisterPlugin("org.test.chat");
  });

  it("forwards input alongside selection warnings through the desktop host override", async () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined, getSelection: () => emptySelection });
    const commandId = "plugin.chat.submit";
    const input: PluginCommandInput = { source: "panel", panelId: "panel.chat.main", sectionId: "composer", control: "prompt", text: "Draw water" };
    runtime.registerPlugin({
      id: "org.test.chat", name: "Chat", version: "0", apiVersion: "^0.1.10", entry: "worker.js", permissions: ["ui.panel", "selection.read"],
      contributes: { commands: [{ id: commandId, title: "Send" }], panels: [{ id: "panel.chat.main", title: "Chat" }] }
    }, { commandHandlers: { [commandId]: async ctx => {
      await ctx.selection!.getSelection();
      return ctx.input;
    } } });
    const warnings: string[] = [];
    expect(await runtime.invokeCommand(commandId, { input, selectionWarnings: warnings })).toEqual(input);
    expect(warnings).toEqual([]);
    expect(await runtime.invokeCommand(commandId)).toBeUndefined();
    await expect(runtime.invokeCommand(commandId, { input: { ...input, panelId: "panel.other.main" } }))
      .rejects.toThrow(/does not declare panel/);
    runtime.unregisterPlugin("org.test.chat");
  });
});

describe("createPluginRuntime assistant integration", () => {
  it("lazily wires an injectable MCP engine and request transaction through the host", async () => {
    const fixture = testContext();
    const { context, replace } = fixture;
    replace(toEngineDocument(context.getDocument()!));
    const push = vi.fn((_tab: string, _before: NonNullable<ReturnType<typeof context.getDocument>>, after: NonNullable<ReturnType<typeof context.getDocument>>) => { replace(after); });
    const port: AssistantHistoryPort = {
      read: () => context.getDocument(), push,
      amend: (_tab, after) => replace(after), select: () => {}, onUserEdit: () => () => {}, undo: () => false
    };
    const transactions = new AssistantTransactions(port);
    const engine = {
      open: vi.fn(async () => ({ sessionId: "mcp", serverName: "chemdraft" as const })),
      close: vi.fn(async () => {}), respond: vi.fn(async () => {}),
      status: vi.fn(async () => ({ listening: false, sessionCount: 0 }))
    };
    const ordinaryWrite = vi.fn();
    const getSelection = vi.fn(() => { throw new Error("Send must not build molfiles"); });
    const viewport = vi.fn((_tabId: string) => ({ x: 50, y: 600, width: 400, height: 200 }));
    let activeTabId = context.tabId;
    const runtime = createPluginRuntime({ getActiveDocument: context.getDocument,
      getActiveDocumentTab: () => ({ id: activeTabId }), getSelection,
      assistantMcpEngine: engine, getAssistantDocument: port.read,
      getAssistantViewportRect: viewport, runAssistantWrite: async apply => apply(),
      assistantTransactions: () => transactions, applyDocumentPatch: ordinaryWrite });
    expect(engine.open).not.toHaveBeenCalled();
    expect(engine.status).not.toHaveBeenCalled();
    runtime.registerPlugin({ id: context.plugin.id, name: "Assistant", version: "0", apiVersion: "^0.1.9", entry: "worker.js",
      permissions: [...AssistantCapabilityPermissions], contributes: { commands: [{ id: "plugin.assistant.submit", title: "Submit" }] }
    }, { commandHandlers: { "plugin.assistant.submit": async ctx => {
      const api = ctx.assistant!;
      const { requestId } = await api.beginRequest({ prompt: "caption" });
      activeTabId = "other-tab";
      await api.createToolSession({ requestId });
      const result = await api.callTool({ name: "insert_text", input: { text: "Assistant caption" } });
      expect(result.isError).not.toBe(true);
      return api.endRequest({ requestId });
    } } });
    await expect(runtime.invokeCommand("plugin.assistant.submit")).resolves.toMatchObject({ touchedIds: [expect.any(String)], split: false });
    expect(engine.open).toHaveBeenCalledOnce();
    expect(engine.close).toHaveBeenCalledWith("mcp");
    expect(push).toHaveBeenCalledOnce();
    expect(ordinaryWrite).not.toHaveBeenCalled();
    expect(getSelection).not.toHaveBeenCalled();
    expect(viewport).toHaveBeenCalledWith(context.tabId);
    expect(context.getDocument()!.pages[0]!.objects).toHaveLength(3);
    const caption = context.getDocument()!.pages[0]!.objects[2]!;
    expect(caption.x + caption.width / 2).toBeCloseTo(250);
    expect(caption.y + caption.height / 2).toBeCloseTo(700);
    runtime.unregisterPlugin(context.plugin.id);
    transactions.dispose();
  });
});

const molfile = [
  "Recognized carbon monoxide",
  "  MolScribe",
  "",
  "  2  1  0  0  0  0            999 V2000",
  "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0  0  0  0",
  "M  END"
].join("\n");

const SPLIT: StructureRecognitionAgreement = {
  runs: 15,
  agreeing: 3,
  invalidRuns: 12,
  scalesPx: [760, 800, 840, 880, 900, 920, 960, 1000, 1040, 1080, 1100, 1120, 1160, 1200, 1240]
};

function installedEngine(outcome: StructureRecognitionOutcome): StructureRecognitionEngine {
  const status: StructureRecognitionEngineStatus = { state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 };
  return {
    status: vi.fn(async () => status),
    install: vi.fn(async () => status),
    cancelInstall: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => status),
    recognizeImage: vi.fn(async () => outcome)
  };
}

describe("createPluginRuntime recognition review", () => {
  it("carries the host's agreement-capped tier from the engine to the review, whatever the plugin claims", async () => {
    const document = createPhase4Document();
    const runtime = createPluginRuntime({
      getActiveDocument: () => document,
      getSelection: () => emptySelection,
      now: () => "2026-09-27T00:00:00.000Z",
      structureRecognitionEngine: installedEngine({
        status: "recognized",
        smiles: "C=O",
        molfile,
        confidence: 0.97,
        atoms: [
          { index: 0, symbol: "C", x: -0.75, y: 0, confidence: 0.9 },
          { index: 1, symbol: "O", x: 0.75, y: 0, confidence: 0.92 }
        ],
        bonds: [{ begin: 0, end: 1, bondType: "double", confidence: 0.89 }],
        agreement: SPLIT,
        elapsedMs: 80,
        engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
      }),
      recognitionStructureValidator: async () => ({ valid: true, errors: [], warnings: [] }),
      imageSourceRegistry: new ImageSourceRegistry([
        {
          id: "file",
          label: "File",
          isAvailable: async () => true,
          acquire: async () => ({
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
            width: 320,
            height: 200,
            source: "file",
            fileName: "split.png"
          })
        }
      ])
    });
    // The fixture recognizer claims "high" and passes on only the warnings it was handed.
    const fixture = recognitionFixtureDescriptor();
    runtime.registerPlugin(fixture.manifest, fixture.options);

    const invocation = runtime.host.invokeCommand(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    const outcome = await invocation;
    // The plugin never sees the host's review facts.
    expect(JSON.stringify(outcome)).not.toContain("hostReview");

    const [queued] = runtime.host.listProposedPatches("pending");
    const item = proposalReviewItem(runtime.host, queued!);
    expect(item.recognition).toMatchObject({
      confidenceTier: "low",
      sourceImageRef: "data:image/png;base64,AQID",
      proposedSmiles: "C=O",
      proposedMolfile: molfile
    });
    expect(item.warnings[0]).toEqual(recognitionDisagreementWarning(SPLIT));
  });
});
