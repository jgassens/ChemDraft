// @vitest-environment jsdom

import { massAnalyzeCommandId } from "@chemdraft/plugin-mass-fragment";
import { CommandRegistry } from "@chemdraft/plugin-host";
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

function Probe({ registry, capture }: { registry: CommandRegistry; capture: (view: PluginRuntimeView) => void }) {
  capture(
    usePluginRuntime({
      getActiveDocument: () => undefined,
      getSelection: () => ({ objectIds: [], molecules: [] }),
      commandRegistry: registry
    })
  );
  return null;
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

