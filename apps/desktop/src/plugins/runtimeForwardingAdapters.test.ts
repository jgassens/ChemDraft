import { applyPatch, createEmptyDocument, type ChemDraftDocument, type TextObject } from "@chemdraft/chem-core";
import type { PluginCommandContext, PluginPermission, PluginProvidedImage } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeTestChannels } from "../testSupport/runtimeBrokerChannels";
import { createPluginRuntime, type DesktopPluginRuntimeOptions } from "./createPluginRuntime";
import { applyAcceptedPluginProposal, createPluginWriteGate } from "./applyPluginDocumentPatch";
import { applyRuntimeDocumentPatch, createRuntimeDocumentPort } from "./runtimeDocumentPort";
import { RuntimeBroker } from "./runtimeBroker";
import { RuntimeBrokerDocument } from "./runtimeBrokerDocument";
import { RuntimeBrokerHost } from "./runtimeBrokerHost";
import { fakeNamingEngine, namingMolecule } from "./structureNamingTestFixtures";
import * as chemistry from "./pluginChemistry";
import * as recognition from "./pluginStructureRecognition";
import { ImageSourceRegistry } from "./ImageSourceProvider";
import { RESERVED_PLUGIN_OBJECT_IDS } from "./reservedObjectIds";
import type { StructureRecognitionOutcome } from "./structureRecognitionEngine";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); vi.restoreAllMocks(); vi.useRealTimers(); RESERVED_PLUGIN_OBJECT_IDS.clear(); });
const text = (id: string, value: string): TextObject => ({ id, type: "text", text: value, spans: [],
  x: 100, y: 100, width: 60, height: 20, rotation: 0, style: {} });
const image: PluginProvidedImage = { mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), width: 120, height: 80, source: "file" };
const molfile = ["Mock formaldehyde", "  ChemDraft", "", "  2  1  0  0  0  0            999 V2000",
  "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0", "  1  2  2  0  0  0  0", "M  END"].join("\n");
const recognized: StructureRecognitionOutcome = { status: "recognized", smiles: "C=O", molfile, confidence: 0.9,
  atoms: [{ index: 0, symbol: "C", x: -0.75, y: 0, confidence: 0.9 }, { index: 1, symbol: "O", x: 0.75, y: 0, confidence: 0.9 }],
  bonds: [{ begin: 0, end: 1, bondType: "double", confidence: 0.9 }], elapsedMs: 20,
  agreement: { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: [800, 900, 1000, 1100, 1200] },
  engine: { name: "MolScribe", molscribeCommit: "mock", modelSha256: "a".repeat(64) } };

function fixture(remote: boolean, run: (context: PluginCommandContext) => unknown, permissions: PluginPermission[],
  options: Partial<DesktopPluginRuntimeOptions> = {}) {
  RESERVED_PLUGIN_OBJECT_IDS.clear();
  const empty = createEmptyDocument({ now: "2026-11-10T00:00:00.000Z" });
  const source: ChemDraftDocument = { ...empty, pages: [{ ...empty.pages[0]!,
    objects: [namingMolecule] }], selection: { pageId: empty.pages[0]!.id, objectIds: ["m1"] } };
  let document = source, active = "source", key = "drawing";
  const history: Array<{ before: ChemDraftDocument; after: ChemDraftDocument; label: string }> = [];
  const selection = () => ({ objectIds: document.selection.objectIds, molecules: [] });
  const viewport = { x: 200, y: 300, width: 500, height: 400 };
  const gate = createPluginWriteGate({ isGestureActive: () => false });
  const port = createRuntimeDocumentPort({ windowId: "main", commandRegistry: new CommandRegistry(), activeTabId: () => active,
    read: tabId => tabId === "source" ? { document, documentKey: key } : undefined,
    selection, viewportRect: () => viewport, getWriteGate: () => gate, assertWritable: () => {},
    placement: () => ({}), normalize: document => document, prepare: (write, commit) => commit(write.proposed),
    commit: (write, after) => { history.push({ before: document, after, label: write.application.undoLabel }); document = after; } });
  const channels = new RuntimeTestChannels();
  const hostBroker = new RuntimeBroker("runtime", channels.transport("runtime"));
  const documentBroker = new RuntimeBroker("main", channels.transport("main"));
  const runtime = createPluginRuntime({ getActiveDocument: () => {
    if (remote) throw new Error("Uncaptured document read"); return document;
  }, getSelection: () => { if (remote) throw new Error("Uncaptured selection read"); return selection(); },
  getActiveDocumentTab: () => ({ id: active }), getDocumentTabTitle: () => "Source",
  getAssistantViewportRect: () => viewport, applyDocumentPatch: request => applyRuntimeDocumentPatch(port, request),
  ...options });
  runtime.registerPlugin({ id: "org.test.forward", name: "Forward", version: "1", apiVersion: "^0.1.25", entry: "test.js", permissions,
    contributes: { commands: [{ id: "plugin.forward.run", title: "Run" }] } }, { commandHandlers: { "plugin.forward.run": run } });
  const host = new RuntimeBrokerHost(hostBroker, () => runtime, () => ["main"]);
  const client = new RuntimeBrokerDocument(documentBroker, port);
  cleanup.push(() => { client.dispose(); host.dispose(); documentBroker.dispose(); hostBroker.dispose(); gate.dispose(); runtime.unregisterPlugin("org.test.forward"); });
  return { runtime, channels, history, source, port, read: () => document, setSelection: (ids: string[]) => {
    document = applyPatch(document, { op: "setSelection", pageId: source.pages[0]!.id, objectIds: ids });
  }, activateAway: () => { active = "neighbor"; }, replace: () => { key = "replacement"; },
  invoke: async (selectionWarnings?: string[]) => {
    if (!remote) return runtime.invokeCommand("plugin.forward.run", { selectionWarnings });
    await client.refreshContributions(); return client.invokeCommand("plugin.forward.run", undefined, { selectionWarnings });
  }, accept: () => {
    const proposal = runtime.host.listProposedPatches("pending")[0]!;
    const after = runtime.host.acceptProposedPatch(proposal.id, document, { apply: (before, proposal) =>
      applyAcceptedPluginProposal(before, proposal, { now: "2026-11-10T00:00:00Z" }).document });
    history.push({ before: document, after, label: "Forward: Insert Recognized Structure" }); document = after;
  } };
}

describe("captured document adapters over the JSON broker", () => {
  it("names the captured molecule and preserves the direct path's history, label and selection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    const run = async (context: PluginCommandContext) => {
      const result = await context.chemistry!.structureToName!({ objectId: "m1" });
      if (result.status !== "named") throw new Error("Expected mocked ethanol name");
      return context.documents.applyPatch!({ reason: "Insert Name", patch: { op: "addObject", pageId: "page_001", object: text("name", result.name) } });
    };
    const permissions: PluginPermission[] = ["chemistry.compute", "native.execute", "selection.read", "document.write"];
    const options = { structureNamingEngine: fakeNamingEngine(), namingCanonicalizer: { canonicalize: async () => "CCO", version: "mock" } };
    const direct = fixture(false, run, permissions, options); await direct.invoke();
    const remote = fixture(true, run, permissions, options); await remote.invoke();
    expect(remote.history).toEqual(direct.history); expect(remote.read()).toEqual(direct.read());
    expect(remote.history.map(entry => entry.label)).toEqual(["Forward: Run"]);
    expect(remote.read().selection.objectIds).toEqual(["name"]);
    expect(remote.channels.deliveries.some(({ message }) => message.kind === "request" && message.method === "getSelection")).toBe(true);
  });

  it("lays out against the source page after activation changes and preserves the direct write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    // The engine boundary is deterministic; both paths still use the production layout adapter,
    // permission gates, broker document read, scope checks and document history port.
    vi.spyOn(chemistry, "structureFromSmilesForPlugin").mockImplementation(async (_request, read) => ({ available: true, built: true,
      object: { ...namingMolecule, id: "built", x: read()!.pages[0]!.width / 2, y: read()!.pages[0]!.height / 2 } }));
    let activate = () => {};
    const run = async (context: PluginCommandContext) => {
      activate();
      const result = await context.chemistry!.structureFromSmiles!({ smiles: "CCO" });
      if (!result.available || !result.built) throw new Error("Expected layout");
      return context.documents.applyPatch!({ reason: "Layout", patch: { op: "addObject", pageId: "page_001", object: result.object } });
    };
    const permissions: PluginPermission[] = ["chemistry.compute", "document.read", "document.write"];
    const direct = fixture(false, run, permissions); await direct.invoke();
    const remote = fixture(true, run, permissions); activate = remote.activateAway; await remote.invoke();
    expect(remote.history).toEqual(direct.history); expect(remote.read()).toEqual(direct.read());
    expect(remote.read().selection.objectIds).toEqual(["built"]);
  });

  it("prepares recognition for its source page after activation changes, with the same reviewed insertion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    const prepare = recognition.preparePluginStructureRecognition;
    vi.spyOn(recognition, "preparePluginStructureRecognition").mockImplementation(async (...args) => {
      const result = await prepare(...args);
      // Production reserves a different id for every recognition across runtimes. Pin only this
      // opaque fixture id so exact history/selection comparison can include the real prepared object.
      if (result.status === "recognized" && result.result.proposedPatch?.patch.op === "addObject") {
        result.result.proposedPatch.patch.object.id = "recognized";
      }
      return result;
    });
    let activate = () => {};
    const run = async (context: PluginCommandContext) => {
      const acquired = await context.images!.requestImage({ title: "Image" });
      if (acquired.status !== "provided") throw new Error("Expected chosen image");
      activate();
      const result = await context.recognition!.recognizeStructure(acquired.image);
      if (result.status !== "recognized") throw new Error("Expected mocked recognition");
      await context.documents.proposePatch({ ...result.result.proposedPatch!, requiresUserApproval: true });
      return result;
    };
    const options: Partial<DesktopPluginRuntimeOptions> = {
      imageSourceRegistry: new ImageSourceRegistry([{ id: "file", label: "File", isAvailable: async () => true, acquire: async () => image }]),
      structureRecognitionEngine: { status: async () => ({ state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 }),
        install: async () => ({ state: "installed", requiredDiskBytes: 0, freeDiskBytes: 0 }), cancelInstall: async () => {},
        uninstall: async () => ({ state: "notInstalled", requiredDiskBytes: 0, freeDiskBytes: 0 }), recognizeImage: async () => recognized },
      recognitionStructureValidator: async () => ({ valid: true, errors: [], warnings: [] })
    };
    const permissions: PluginPermission[] = ["image.read", "ml.inference", "model.load", "native.execute", "document.proposePatch"];
    const direct = fixture(false, run, permissions, options);
    const first = direct.invoke(); await vi.waitFor(() => expect(direct.runtime.images.getOpenRequest()).toBeDefined());
    await direct.runtime.images.acquire(direct.runtime.images.getOpenRequest()!.id, "file"); await first; direct.accept();
    const remote = fixture(true, run, permissions, options); activate = remote.activateAway;
    const second = remote.invoke(); await vi.waitFor(() => expect(remote.runtime.images.getOpenRequest()).toBeDefined());
    await remote.runtime.images.acquire(remote.runtime.images.getOpenRequest()!.id, "file"); await second;
    const proposal = remote.runtime.host.listProposedPatches("pending")[0]!;
    expect(remote.runtime.proposalDocumentTab(proposal.id)).toMatchObject({ id: "source", windowId: "main" });
    remote.accept();
    expect(remote.history).toEqual(direct.history); expect(remote.read()).toEqual(direct.read());
    expect(remote.read().selection.objectIds).toHaveLength(1);
  });

  it("places tables in the captured viewport with identical history, label and selection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    const run = (context: PluginCommandContext) => context.documents.insertTable!({ columns: [{ header: "Name" }], rows: [["ethanol"]] });
    const direct = fixture(false, run, ["document.write"]); direct.setSelection([]); await direct.invoke();
    const remote = fixture(true, run, ["document.write"]); remote.setSelection([]); await remote.invoke();
    expect(remote.history).toEqual(direct.history); expect(remote.read()).toEqual(direct.read());
    expect(remote.history.map(entry => entry.label)).toEqual(["Insert table"]);
    expect(remote.channels.deliveries.some(({ message }) => message.kind === "request" && message.method === "getViewportRect")).toBe(true);
  });

  it("refuses naming after drawing replacement, before contacting the native engine", async () => {
    const engine = fakeNamingEngine();
    let replace = () => {};
    const remote = fixture(true, context => { replace(); return context.chemistry!.structureToName!({ objectId: "m1" }); },
      ["chemistry.compute", "native.execute", "selection.read"], { structureNamingEngine: engine });
    replace = remote.replace;
    await expect(remote.invoke()).rejects.toThrow("document changed"); expect(engine.name).not.toHaveBeenCalled();
    expect(remote.history).toEqual([]);
  });

  it("keeps naming's internal selection read silent while collecting explicit selection reads", async () => {
    const remote = fixture(true, async context => {
      await context.chemistry!.structureToName!({ objectId: "m1" });
      return context.selection!.getSelection();
    }, ["chemistry.compute", "native.execute", "selection.read"], { structureNamingEngine: fakeNamingEngine(),
      namingCanonicalizer: { canonicalize: async () => "CCO", version: "mock" } });
    remote.port.selection = (_tabId, warnings) => { warnings?.push("Explicit read warning"); return { objectIds: ["m1"], molecules: [] }; };
    const warnings: string[] = [];
    await remote.invoke(warnings);
    expect(warnings).toEqual(["Explicit read warning"]);
  });
});
