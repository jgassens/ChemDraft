// @vitest-environment jsdom

import type { PluginManifest } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";

const hookMocks = vi.hoisted(() => ({
  stagingFs: {},
  loadInstalledPlugins: vi.fn(),
  updateInstalledPluginPackage: vi.fn()
}));

vi.mock("./pluginStagingFs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pluginStagingFs")>();
  return {
    ...actual,
    isTauriHost: () => true,
    createTauriPluginStagingFs: () => hookMocks.stagingFs
  };
});

vi.mock("./installPluginPackage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installPluginPackage")>();
  return {
    ...actual,
    loadInstalledPlugins: hookMocks.loadInstalledPlugins,
    updateInstalledPluginPackage: hookMocks.updateInstalledPluginPackage
  };
});

import type { InstalledPluginCatalogEntry } from "./installPluginPackage";
import type { PreparedPluginUpdate } from "./pluginUpdates";
import { usePluginRuntime, type PluginRuntimeView } from "./usePluginRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pluginId = "org.chemdraft.test.catalog-transition";

function manifest(version: string): PluginManifest {
  return {
    id: pluginId,
    name: "Catalog Transition Test Plugin",
    version,
    apiVersion: "^0.1.0",
    entry: "entry.js",
    permissions: [],
    contributes: {
      commands: [],
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
}

function catalogEntry(version: string, sourceChecksum: string): InstalledPluginCatalogEntry {
  return {
    record: {
      id: pluginId,
      version,
      name: "Catalog Transition Test Plugin",
      stagedPath: `installed-plugins/by-package/${sourceChecksum}`,
      sourceChecksum,
      installedAt: "2026-07-25T12:00:00.000Z"
    },
    manifest: manifest(version),
    descriptor: undefined
  };
}

function preparedUpdate(): PreparedPluginUpdate {
  const nextManifest = manifest("2.0.0");
  const sourceChecksum = "b".repeat(64);
  return {
    offer: {
      pluginId,
      pluginName: nextManifest.name,
      installedVersion: "1.0.0",
      version: nextManifest.version,
      releaseUrl: "https://github.com/example/plugin/releases/tag/v2.0.0",
      packageUrl: "https://github.com/example/plugin/releases/download/v2.0.0/plugin-2.0.0.zip",
      packageName: "plugin-2.0.0.zip",
      sourceChecksum,
      compressedBytes: 1024,
      publishedAt: "2026-07-25T12:00:00.000Z"
    },
    inspection: {
      manifest: nextManifest,
      provenance: {
        sdk: "@chemdraft/plugin-api",
        sdkVersion: "0.1.0",
        sourceCommit: "eed188881f5c74e3e44683bd6f5ce60e18d5f559",
        sourceTree: "clean",
        licenseFile: "LICENSE",
        packagedAt: "2026-07-25T12:00:00.000Z"
      },
      sourceChecksum,
      entries: [],
      unpackedBytes: 1024
    },
    sourcePath: "https://github.com/example/plugin/releases/download/v2.0.0/plugin-2.0.0.zip",
    checksumVerified: true
  };
}

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  hookMocks.loadInstalledPlugins.mockReset();
  hookMocks.updateInstalledPluginPackage.mockReset();
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
});

describe("usePluginRuntime installed catalog readiness", () => {
  it("withholds update actions until loading completes and refreshes the catalog after an update", async () => {
    const initial = catalogEntry("1.0.0", "a".repeat(64));
    let finishLoad!: (result: {
      installed: readonly InstalledPluginCatalogEntry[];
      failures: readonly [];
    }) => void;
    hookMocks.loadInstalledPlugins.mockReturnValue(
      new Promise((resolve) => {
        finishLoad = resolve;
      })
    );

    let view: PluginRuntimeView | undefined;
    function Probe() {
      view = usePluginRuntime({
        getActiveDocument: () => undefined,
        getSelection: () => ({ objectIds: [], molecules: [] })
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Probe));
    });

    expect(view?.installedPluginCatalogReady).toBe(false);
    expect(view?.installedPlugins).toEqual([]);
    expect(view?.checkInstalledPluginUpdates).toBeUndefined();
    expect(view?.prepareInstalledPluginUpdate).toBeUndefined();
    expect(view?.updateInstalledPlugin).toBeUndefined();

    await act(async () => {
      finishLoad({ installed: [initial], failures: [] });
      await Promise.resolve();
    });

    expect(view?.installedPluginCatalogReady).toBe(true);
    expect(view?.installedPlugins.map((entry) => entry.record.version)).toEqual(["1.0.0"]);
    expect(view?.checkInstalledPluginUpdates).toEqual(expect.any(Function));
    await expect(view!.checkInstalledPluginUpdates!()).resolves.toEqual([
      {
        status: "unsupported",
        pluginId,
        installedVersion: "1.0.0"
      }
    ]);

    const prepared = preparedUpdate();
    const updated = catalogEntry("2.0.0", prepared.inspection.sourceChecksum);
    const descriptor = {
      manifest: updated.manifest,
      options: { commandHandlers: {} }
    };
    hookMocks.updateInstalledPluginPackage.mockResolvedValue({
      record: updated.record,
      descriptor
    });

    await act(async () => {
      await view!.updateInstalledPlugin!(prepared);
    });

    expect(hookMocks.updateInstalledPluginPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        current: initial,
        inspection: prepared.inspection
      })
    );
    expect(view?.installedPlugins.map((entry) => entry.record.version)).toEqual(["2.0.0"]);
    expect(view?.installedPlugins[0]?.manifest).toBe(updated.manifest);
  });
});
