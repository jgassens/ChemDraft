// @vitest-environment jsdom

import type { MoleculeObject } from "@chemdraft/chem-core";
import { massAnalyzeCommandId } from "@chemdraft/plugin-mass-fragment";
import type { AppliedPatchReceipt, PluginManifest } from "@chemdraft/plugin-api";
import { CommandRegistry, type PluginPatchApplicationRequest } from "@chemdraft/plugin-host";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  StructureRecognitionEngine,
  StructureRecognitionEngineStatus,
  StructureRecognitionInstallProgress
} from "./structureRecognitionEngine";

const engineHooks = vi.hoisted(() => ({
  report: undefined as undefined | ((progress: StructureRecognitionInstallProgress) => void)
}));

// The hook builds its runtime itself; give that runtime an engine whose install the test drives.
vi.mock("./createPluginRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./createPluginRuntime")>();
  const notInstalled: StructureRecognitionEngineStatus = {
    state: "notInstalled",
    requiredDiskBytes: 3e9,
    freeDiskBytes: 8e9
  };
  const engine: StructureRecognitionEngine = {
    status: async () => notInstalled,
    install: (onProgress) =>
      new Promise(() => {
        engineHooks.report = onProgress;
      }),
    cancelInstall: async () => undefined,
    uninstall: async () => notInstalled,
    recognizeImage: async () => ({ status: "notInstalled" })
  };
  return {
    ...actual,
    createPluginRuntime: (options: Parameters<typeof actual.createPluginRuntime>[0]) =>
      actual.createPluginRuntime({ ...options, structureRecognitionEngine: engine })
  };
});

import { recognitionInstallProgressStore } from "./structureRecognitionInstallProgress";
import { usePluginRuntime, type PluginRuntimeView } from "./usePluginRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
});

function Probe({
  registry,
  capture,
  getActiveDocumentKey,
  applyDocumentPatch
}: {
  registry: CommandRegistry;
  capture: (view: PluginRuntimeView) => void;
  getActiveDocumentKey?: () => string | undefined;
  applyDocumentPatch?: (
    request: PluginPatchApplicationRequest
  ) => AppliedPatchReceipt | Promise<AppliedPatchReceipt>;
}) {
  capture(
    usePluginRuntime({
      getActiveDocument: () => undefined,
      getActiveDocumentKey,
      getSelection: () => ({ objectIds: [], molecules: [] }),
      commandRegistry: registry,
      applyDocumentPatch
    })
  );
  return null;
}

function moleculeObject(id = "mol_001"): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 80,
    y: 96,
    width: 160,
    height: 120,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "c1ccccc1",
    atoms: [],
    bonds: [],
    superatoms: [],
    rGroups: []
  };
}

describe("usePluginRuntime on the shared command registry", () => {
  it("isPluginCommand is a pluginId-ownership check, not registry membership (study R3)", async () => {
    const registry = new CommandRegistry();
    let coreRan = 0;
    registry.register({ id: "core.probe", title: "Probe", source: "core" }, () => {
      coreRan += 1;
      return undefined;
    });

    let view: PluginRuntimeView | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Probe, {
          registry,
          capture: (captured) => {
            view = captured;
          }
        })
      );
      await Promise.resolve();
    });

    // The host shares the injected registry, so membership alone would misclassify core commands.
    expect(view!.runtime.host.commands).toBe(registry);
    expect(view!.runtime.host.commands.has("core.probe")).toBe(true);
    expect(view!.isPluginCommand("core.probe")).toBe(false);
    expect(view!.isPluginCommand(massAnalyzeCommandId)).toBe(true);
    expect(view!.isPluginCommand("no.such.command")).toBe(false);

    // Single dispatch: the same invoke path reaches core commands in the shared registry.
    await act(async () => {
      await view!.invokePluginCommand("core.probe");
    });
    expect(coreRan).toBe(1);
  });

  it("keeps engine-install progress out of the shared version, so the menu model keeps its identity", async () => {
    const registry = new CommandRegistry();
    let view: PluginRuntimeView | undefined;
    let renders = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Probe, {
          registry,
          capture: (captured) => {
            renders += 1;
            view = captured;
          }
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      void view!.startRecognitionEngineInstall();
      await Promise.resolve();
    });
    expect(view!.recognitionEngineInstall?.running).toBe(true);
    const menuItems = view!.pluginMenuItems;
    const plugins = view!.plugins;
    const detachedPanels = view!.detachedPanels;
    const rendersBefore = renders;

    for (let index = 1; index <= 25; index += 1) {
      act(() =>
        engineHooks.report!({
          phase: "downloadingModel",
          message: "Downloading the recognition model…",
          bytesDone: index * 10e6,
          bytesTotal: 1134.9e6
        })
      );
    }

    // No re-render of the window that owns the runtime, and no new menu model to re-sync.
    expect(renders).toBe(rendersBefore);
    expect(view!.pluginMenuItems).toBe(menuItems);
    expect(view!.plugins).toBe(plugins);
    expect(view!.detachedPanels).toBe(detachedPanels);
    // The progress display still sees every event, through its own store.
    expect(recognitionInstallProgressStore.getSnapshot()?.progress).toMatchObject({
      phase: "downloadingModel",
      bytesDone: 250e6
    });

    // A notification that does re-render but changes nothing the menu shows keeps its identity too.
    act(() => view!.runtime.panels.reportDiagnostic("test-diagnostic", "Nothing the menu shows."));
    expect(renders).toBeGreaterThan(rendersBefore);
    expect(view!.pluginMenuItems).toBe(menuItems);
    expect(view!.plugins).toBe(plugins);

    // Unmounting the runtime's owner disconnects the store.
    act(() => root!.unmount());
    root = undefined;
    expect(recognitionInstallProgressStore.getSnapshot()).toBeUndefined();
  });
});

describe("usePluginRuntime document identity wiring", () => {
  const documentWritePluginId = "org.chemdraft.test.documentKey";
  const documentWriteCommandId = "plugin.documentKeyTest.write";
  const documentWriteManifest: PluginManifest = {
    id: documentWritePluginId,
    name: "Document Key Test Plugin",
    version: "1.0.0",
    apiVersion: "^0.1.0",
    entry: "dist/plugin.js",
    permissions: ["document.write"],
    contributes: {
      commands: [
        { id: documentWriteCommandId, title: "Write", requiredPermissions: ["document.write"], enabled: true }
      ],
      menus: [],
      panels: [],
      toolbarButtons: [],
      toolsets: [],
      inspectors: [],
      templates: [],
      importers: [],
      exporters: [],
      analyzers: [],
      transformers: [],
      recognizers: []
    }
  };

  it("threads getActiveDocumentKey through to the host so a write started before a document replace is refused", async () => {
    const registry = new CommandRegistry();
    let activeKey = "doc-1";
    // Flips true for the second invocation, mid-command — the moment File > New (bumping MainWindow's
    // document identity ref) would land while a plugin write is in flight.
    let replaceDocumentMidCommand = false;
    const applyDocumentPatch = vi.fn(
      (): AppliedPatchReceipt => ({ applied: true, objectIds: ["mol_001"] })
    );

    let view: PluginRuntimeView | undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Probe, {
          registry,
          capture: (captured) => {
            view = captured;
          },
          getActiveDocumentKey: () => activeKey,
          applyDocumentPatch
        })
      );
      await Promise.resolve();
    });

    act(() => {
      view!.runtime.registerPlugin(documentWriteManifest, {
        commandHandlers: {
          [documentWriteCommandId]: async (context) => {
            if (replaceDocumentMidCommand) activeKey = "doc-2";
            return context.documents.applyPatch!({
              reason: "test write",
              patch: { op: "addObject", pageId: "page_001", object: moleculeObject() }
            });
          }
        }
      });
    });

    // An ordinary edit: the document identity is unchanged for the whole command, so the write lands.
    await act(async () => {
      await expect(view!.invokePluginCommand(documentWriteCommandId)).resolves.toMatchObject({ applied: true });
    });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);

    // File > New (or Open) replaces the document while this command is still running: the key it
    // started with no longer matches, and the write is refused rather than landing in the new document.
    replaceDocumentMidCommand = true;
    await act(async () => {
      await expect(view!.invokePluginCommand(documentWriteCommandId)).rejects.toThrow(
        "The document changed while the plugin was running; nothing was inserted."
      );
    });
    expect(applyDocumentPatch).toHaveBeenCalledTimes(1);
  });
});
