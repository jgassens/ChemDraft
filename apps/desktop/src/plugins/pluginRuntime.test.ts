import { massAnalyzeCommandId, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";

import { createPhase4Document } from "../documentWorkflow";
import {
  RECOGNITION_FIXTURE_COMMAND_ID,
  RECOGNITION_FIXTURE_PANEL_ID,
  RECOGNITION_FIXTURE_TITLE,
  recognitionFixtureDescriptor,
  recognitionFixtureManifest
} from "../testSupport/recognitionFixturePlugin";
import { createPluginRuntime, type DesktopPluginRuntimeOptions } from "./createPluginRuntime";
import { ImageSourceRegistry, type ImageSourceProvider } from "./ImageSourceProvider";
import { buildPluginMenuItems, PLUGIN_DIAGNOSTICS_COMMAND_ID } from "./pluginMenuModel";
import {
  applyEnabledPlugins,
  createBundledPluginDescriptors,
  registerBundledPlugins
} from "./registerBundledPlugins";
import type {
  StructureRecognitionEngine,
  StructureRecognitionEngineStatus,
  StructureRecognitionOutcome
} from "./structureRecognitionEngine";

const emptySelection: PluginSelectionSnapshot = { objectIds: [], molecules: [] };

const carbonMonoxideMolfile = [
  "Recognized carbon monoxide",
  "  MolScribe",
  "",
  "  2  1  0  0  0  0            999 V2000",
  "   -0.7500    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.7500    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0  0  0  0",
  "M  END"
].join("\n");

const recognizedCarbonMonoxide: StructureRecognitionOutcome = {
  status: "recognized",
  smiles: "C=O",
  molfile: carbonMonoxideMolfile,
  confidence: 0.91,
  atoms: [
    { index: 0, symbol: "C", x: -0.75, y: 0, confidence: 0.9 },
    { index: 1, symbol: "O", x: 0.75, y: 0, confidence: 0.92 }
  ],
  bonds: [{ begin: 0, end: 1, bondType: "double", confidence: 0.89 }],
  agreement: { runs: 5, agreeing: 5, invalidRuns: 0, scalesPx: [800, 900, 1000, 1100, 1200] },
  elapsedMs: 80,
  engine: { name: "MolScribe", molscribeCommit: "abc123", modelSha256: "a".repeat(64) }
};

function installedEngine(
  recognizeImage: StructureRecognitionEngine["recognizeImage"]
): StructureRecognitionEngine & { recognizeImage: ReturnType<typeof vi.fn> } {
  const status: StructureRecognitionEngineStatus = {
    state: "installed",
    requiredDiskBytes: 0,
    freeDiskBytes: 0
  };
  return {
    status: vi.fn(async () => status),
    install: vi.fn(async () => status),
    cancelInstall: vi.fn(async () => status),
    uninstall: vi.fn(async () => status),
    recognizeImage: vi.fn(recognizeImage)
  };
}

/** The bundled catalog plus the test-only recognizer, standing in for an installed recognition plugin. */
function registerWithRecognitionFixture(runtime: ReturnType<typeof makeRuntime>) {
  const descriptors = [...createBundledPluginDescriptors(), recognitionFixtureDescriptor()];
  applyEnabledPlugins(runtime, new Set(), descriptors);
  return descriptors;
}

function makeRuntime(overrides: Partial<DesktopPluginRuntimeOptions> = {}) {
  const imageProvider: ImageSourceProvider = {
    id: "file",
    label: "File",
    isAvailable: async () => true,
    acquire: async () => ({
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      width: 320,
      height: 200,
      source: "file",
      fileName: "test.png"
    })
  };
  return createPluginRuntime({
    getActiveDocument: () => undefined,
    getSelection: () => emptySelection,
    now: () => "2026-07-07T00:00:00.000Z",
    imageSourceRegistry: new ImageSourceRegistry([imageProvider]),
    ...overrides
  });
}

describe("desktop plugin runtime", () => {
  it("rejects reserved desktop permissions before registration, so hasPermission never reports a false grant", () => {
    const runtime = makeRuntime();
    const candidate = {
      id: "org.test.network",
      name: "Network Test",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: ["network.fetch"]
    };

    expect(() => runtime.registerPlugin(candidate)).toThrow(/network\.fetch.*unavailable/i);
    expect(runtime.host.getPlugin(candidate.id)).toBeUndefined();
    expect(runtime.host.hasPermission(candidate.id, "network.fetch")).toBe(false);
  });

  it("bundles no image recognizer: MolScribe OCSR arrives only by installing it", () => {
    const runtime = makeRuntime();
    const descriptors = registerBundledPlugins(runtime);
    expect(descriptors.map((descriptor) => descriptor.manifest.id)).toEqual(["org.chemdraft.mass.fragment"]);
    expect(runtime.host.getPlugin("org.chemdraft.ocsr.molscribe")).toBeUndefined();
    expect(runtime.host.commands.has("plugin.molscribeOcsr.recognizeImage")).toBe(false);
    const items = buildPluginMenuItems(runtime.host.listMenuContributions());
    expect(items.some((item) => /molscribe/i.test(item.command.commandId))).toBe(false);
    expect(items.some((item) => item.command.label === "Recognize Structure from Image")).toBe(false);
  });

  it("skips persisted disabled plugins during startup", () => {
    const runtime = makeRuntime();
    registerBundledPlugins(runtime, new Set([massFragmentManifest.id]));

    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeUndefined();
    expect(runtime.host.commands.has(massAnalyzeCommandId)).toBe(false);
    expect(runtime.host.listPlugins()).toHaveLength(0);
  });

  it("applies enabled plugins idempotently and updates command and menu contributions live", () => {
    const runtime = makeRuntime();
    const descriptors = createBundledPluginDescriptors();
    const changes = vi.fn();
    runtime.host.subscribe(changes);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.listPlugins()).toHaveLength(1);
    expect(changes).toHaveBeenCalledTimes(1);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.listPlugins()).toHaveLength(1);
    expect(changes).toHaveBeenCalledTimes(1);

    applyEnabledPlugins(runtime, new Set([massFragmentManifest.id]), descriptors);
    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeUndefined();
    expect(runtime.host.commands.has(massAnalyzeCommandId)).toBe(false);
    expect(runtime.host.listMenuContributions().some((entry) => entry.pluginId === massFragmentManifest.id)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.getPlugin(massFragmentManifest.id)?.manifest.id).toBe(massFragmentManifest.id);
    expect(runtime.host.commands.has(massAnalyzeCommandId)).toBe(true);
    expect(runtime.host.listMenuContributions().some((entry) => entry.pluginId === massFragmentManifest.id)).toBe(true);
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("totally tears down a disabled worker plugin and creates a fresh bridge when re-enabled", () => {
    const runtime = makeRuntime();
    const descriptors = createBundledPluginDescriptors({
      pluginWorkerFactories: new Map([[massFragmentManifest.id, () => ({}) as never]])
    });
    const mass = descriptors.find((descriptor) => descriptor.manifest.id === massFragmentManifest.id)!;
    const firstBridge = mass.bridge!;
    const terminate = vi.spyOn(firstBridge, "terminate");

    applyEnabledPlugins(runtime, new Set(), descriptors);
    applyEnabledPlugins(runtime, new Set([massFragmentManifest.id]), descriptors);

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeUndefined();

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(mass.bridge).toBeDefined();
    expect(mass.bridge).not.toBe(firstBridge);
    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeDefined();
  });

  it("closes a plugin-owned panel before unregistering its close hook", async () => {
    const runtime = makeRuntime();
    const descriptors = registerWithRecognitionFixture(runtime);
    const notifyPanelClosed = vi.spyOn(runtime.host, "notifyPanelClosed");

    const invocation = runtime.host.invokeCommand(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    await invocation;
    expect(runtime.panels.getOpenPanel()?.pluginId).toBe(recognitionFixtureManifest.id);

    applyEnabledPlugins(runtime, new Set([recognitionFixtureManifest.id]), descriptors);

    expect(notifyPanelClosed).toHaveBeenCalledWith(recognitionFixtureManifest.id, RECOGNITION_FIXTURE_PANEL_ID);
    expect(runtime.panels.getOpenPanel()).toBeUndefined();
    expect(runtime.host.getPlugin(recognitionFixtureManifest.id)).toBeUndefined();
  });

  it("acquires an image and reports engineNotInstalled in one line when no install dialog is attached", async () => {
    // No UI host renders the installer here, so the host must answer at once instead of waiting on a
    // dialog that will never appear.
    const runtime = makeRuntime();
    registerWithRecognitionFixture(runtime);

    expect(runtime.panels.getOpenPanel()).toBeUndefined();

    const invocation = runtime.host.invokeCommand(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    await expect(invocation).resolves.toEqual({ status: "engineNotInstalled" });

    expect(runtime.recognition.getOpenInstall()).toBeUndefined();
    const open = runtime.panels.getOpenPanel();
    expect(open?.panelId).toBe(RECOGNITION_FIXTURE_PANEL_ID);
    expect(open?.title).toBe(RECOGNITION_FIXTURE_TITLE);
    expect(open?.commandId).toBe(RECOGNITION_FIXTURE_COMMAND_ID);
    expect(open?.report.title).toBe(RECOGNITION_FIXTURE_TITLE);
    expect(open?.report.sections).toEqual([{ kind: "text", body: "Recognition needs the local engine." }]);

    runtime.panels.closePanel();
    expect(runtime.panels.getOpenPanel()).toBeUndefined();
  });

  it("turns an installed engine's recognition into a reviewable proposal without opening a panel", async () => {
    const document = createPhase4Document();
    const engine = installedEngine(async () => recognizedCarbonMonoxide);
    const validator = vi.fn(async () => ({ valid: true, errors: [], warnings: [] }));
    const runtime = makeRuntime({
      getActiveDocument: () => document,
      structureRecognitionEngine: engine,
      recognitionStructureValidator: validator
    });
    registerWithRecognitionFixture(runtime);

    const invocation = runtime.host.invokeCommand(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    await expect(invocation).resolves.toMatchObject({ status: "recognized" });

    expect(engine.recognizeImage).toHaveBeenCalledWith({ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    expect(validator).toHaveBeenCalledWith({ format: "molfile-v2000", value: carbonMonoxideMolfile });
    const proposals = runtime.host.listProposedPatches();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      pluginId: recognitionFixtureManifest.id,
      proposal: {
        requiresUserApproval: true,
        patch: { op: "addObject", pageId: document.pages[0]!.id, object: { type: "molecule" } },
        recognition: { proposedSmiles: "C=O", proposedMolfile: carbonMonoxideMolfile }
      }
    });
    expect(runtime.panels.getOpenPanel()).toBeUndefined();
  });

  it("reports a failed recognition in the plugin panel and proposes nothing", async () => {
    const runtime = makeRuntime({
      structureRecognitionEngine: installedEngine(async () => ({
        status: "failed",
        code: "invalidImage",
        message: "The file was not a decodable image."
      }))
    });
    registerWithRecognitionFixture(runtime);

    const invocation = runtime.host.invokeCommand(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    await expect(invocation).resolves.toEqual({
      status: "failed",
      code: "invalidImage",
      message: "The file was not a decodable image."
    });

    expect(runtime.host.listProposedPatches()).toEqual([]);
    expect(runtime.panels.getOpenPanel()?.report.sections).toEqual([
      { kind: "text", body: "Recognition failed: The file was not a decodable image." }
    ]);
  });

  it("reads selection from the provider on demand, so the persistent host sees live state", async () => {
    let selection: PluginSelectionSnapshot = { objectIds: [], molecules: [] };
    const runtime = makeRuntime({ getSelection: () => selection });

    runtime.host.registerPlugin(
      {
        id: "org.test.selreader",
        name: "Selection Reader",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["selection.read"],
        contributes: {
          commands: [{ id: "plugin.selReader.read", title: "Read", requiredPermissions: ["selection.read"] }]
        }
      },
      {
        commandHandlers: {
          "plugin.selReader.read": async (context) => context.selection?.getSelection()
        }
      }
    );

    await expect(runtime.host.invokeCommand("plugin.selReader.read")).resolves.toMatchObject({ objectIds: [] });

    selection = {
      objectIds: ["m1"],
      molecules: [{ objectId: "m1", structureFormat: "smiles", structure: "c1ccccc1", sourceFingerprint: "fp-m1" }]
    };

    await expect(runtime.host.invokeCommand("plugin.selReader.read")).resolves.toMatchObject({
      objectIds: ["m1"]
    });
  });

  it("records a controlled diagnostic instead of crashing when a report targets an unknown panel", () => {
    const runtime = makeRuntime();
    registerWithRecognitionFixture(runtime);

    runtime.panels.showReport(recognitionFixtureManifest.id, "panel.does.not.exist", { title: "X", sections: [] });

    expect(runtime.panels.getOpenPanel()).toBeUndefined();
    expect(runtime.panels.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain("panel-unknown");
  });

  it("shares an injected CommandRegistry with core commands and keeps plugin ownership distinguishable", async () => {
    // The union runtime registers plugin commands into the SAME registry MainWindow's core commands
    // live in (commands/coreCommandRegistrar). Presence in the registry therefore no longer implies
    // "plugin command" — ownership is the pluginId stamped on the definition (study R3).
    const shared = new CommandRegistry();
    let coreRan = 0;
    shared.register({ id: "core.probe", title: "Probe", source: "core" }, () => {
      coreRan += 1;
      return undefined;
    });

    const runtime = makeRuntime({ commandRegistry: shared });
    registerWithRecognitionFixture(runtime);

    // One registry serves both worlds.
    expect(runtime.host.commands).toBe(shared);
    expect(runtime.host.commands.has("core.probe")).toBe(true);
    expect(runtime.host.commands.has(RECOGNITION_FIXTURE_COMMAND_ID)).toBe(true);

    // Ownership: core commands carry no pluginId; plugin commands carry their manifest id.
    expect(runtime.host.commands.get("core.probe")?.pluginId).toBeUndefined();
    expect(runtime.host.commands.get(RECOGNITION_FIXTURE_COMMAND_ID)?.pluginId).toBe(recognitionFixtureManifest.id);

    // Single dispatch handles both: plain for core, permission context for plugin-owned.
    await runtime.host.invokeCommand("core.probe");
    expect(coreRan).toBe(1);
    const invocation = runtime.host.invokeCommand(RECOGNITION_FIXTURE_COMMAND_ID);
    await vi.waitFor(() => expect(runtime.images.getOpenRequest()).toBeDefined());
    await runtime.images.acquire(runtime.images.getOpenRequest()!.id, "file");
    await invocation;
    expect(runtime.panels.getOpenPanel()?.panelId).toBe(RECOGNITION_FIXTURE_PANEL_ID);

    // Unregistering a plugin removes only its own commands from the shared registry.
    runtime.unregisterPlugin(recognitionFixtureManifest.id);
    expect(runtime.host.commands.has(RECOGNITION_FIXTURE_COMMAND_ID)).toBe(false);
    expect(runtime.host.commands.has("core.probe")).toBe(true);
  });

  it("builds Analyze menu items for registered contributions plus the diagnostics opener", () => {
    const runtime = makeRuntime();
    registerWithRecognitionFixture(runtime);

    const items = buildPluginMenuItems(runtime.host.listMenuContributions());
    const commandIds = items.map((item) => item.command.commandId);

    expect(commandIds).toContain(RECOGNITION_FIXTURE_COMMAND_ID);
    expect(commandIds).toContain(massAnalyzeCommandId);
    expect(commandIds).toContain(PLUGIN_DIAGNOSTICS_COMMAND_ID);
    expect(items.every((item) => item.command.pluginContributed === true)).toBe(true);
    expect(items.find((item) => item.command.commandId === RECOGNITION_FIXTURE_COMMAND_ID)?.location).toBe("analyze");

    // Core-only build (M39): no bundled contribution may put an NMR item in any menu — NMR features
    // can arrive only through the installer.
    expect(items.some((item) => /nmr/i.test(item.command.commandId) || /nmr/i.test(item.command.label))).toBe(false);
  });
});
