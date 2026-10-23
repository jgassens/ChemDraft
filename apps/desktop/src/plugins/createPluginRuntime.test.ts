import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { toEngineDocument } from "@chemdraft/chem-core";
import { AssistantCapabilityPermissions } from "@chemdraft/plugin-api";
import { AssistantTransactions } from "../assistant/assistantTransaction";
import { testContext } from "../assistant/tools/testContext";
import type { AssistantHistoryPort } from "../assistant/historyPort";
import { describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import { RECOGNITION_FIXTURE_COMMAND_ID, recognitionFixtureDescriptor } from "../testSupport/recognitionFixturePlugin";
import { createPluginRuntime } from "./createPluginRuntime";
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
