// @vitest-environment jsdom

import type { PluginManifest } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";

const mocks = vi.hoisted(() => ({ tauri: false, loadWebPreloadedPlugins: vi.fn() }));

vi.mock("./pluginStagingFs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pluginStagingFs")>();
  return {
    ...actual,
    isTauriHost: () => mocks.tauri,
    // A Tauri host also reloads installs; give it an empty catalog so only the preload path matters.
    createTauriPluginStagingFs: () => ({
      readTextFile: async () => undefined,
      readDirNames: async () => [],
      removeDir: async () => undefined,
      exists: async () => false
    })
  };
});
vi.mock("./webPreloadedPlugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webPreloadedPlugins")>()),
  loadWebPreloadedPlugins: mocks.loadWebPreloadedPlugins
}));

import { createPluginRuntime } from "./createPluginRuntime";
import { PluginManagerDialog } from "./PluginManagerDialog";
import { usePluginRuntime, type PluginRuntimeView } from "./usePluginRuntime";
import type { WebPreloadedPluginEntry } from "./webPreloadedPlugins";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: PluginManifest = {
  id: "org.example.preloaded",
  name: "Preloaded Teaching Plugin",
  version: "0.3.0",
  apiVersion: "^0.1.0",
  entry: "entry.js",
  permissions: ["ui.panel"],
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

const entry: WebPreloadedPluginEntry = {
  record: { id: manifest.id, version: manifest.version, dir: manifest.id, sha256: "c".repeat(64) },
  manifest,
  descriptor: { manifest, options: { commandHandlers: {} } } as unknown as WebPreloadedPluginEntry["descriptor"]
};

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

beforeEach(() => {
  mocks.loadWebPreloadedPlugins.mockReset();
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
});

async function renderHook(onStatus = vi.fn()): Promise<{ view: () => PluginRuntimeView | undefined; onStatus: typeof onStatus }> {
  let view: PluginRuntimeView | undefined;
  function Probe() {
    view = usePluginRuntime({
      getActiveDocument: () => undefined,
      getSelection: () => ({ objectIds: [], molecules: [] }),
      onPluginUpdateStatus: onStatus
    });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
    await Promise.resolve();
    await Promise.resolve();
  });
  return { view: () => view, onStatus };
}

describe("usePluginRuntime preloaded web plugins", () => {
  it("never runs the loader on a Tauri host", async () => {
    mocks.tauri = true;
    try {
      const { view } = await renderHook();
      expect(mocks.loadWebPreloadedPlugins).not.toHaveBeenCalled();
      expect(view()?.preloadedPlugins).toEqual([]);
    } finally {
      mocks.tauri = false;
    }
  });

  it("loads after the bundled plugins and puts a failure on the status line", async () => {
    mocks.loadWebPreloadedPlugins.mockResolvedValue({
      loaded: [entry],
      failures: [{ id: "org.example.broken", message: 'Preloaded plugin "org.example.broken" could not be loaded: boom' }]
    });
    const { view, onStatus } = await renderHook();
    expect(mocks.loadWebPreloadedPlugins).toHaveBeenCalledTimes(1);
    const options = mocks.loadWebPreloadedPlugins.mock.calls[0][0];
    // Bundled plugins are already registered and offered as replaceable, as for installs.
    expect(options.replacements).toBe(view()?.bundledPlugins);
    expect(options.runtime.host.listPlugins().length).toBeGreaterThan(0);
    expect(view()?.preloadedPlugins).toEqual([entry]);
    expect(onStatus).toHaveBeenCalledWith('Preloaded plugin "org.example.broken" could not be loaded: boom');
    expect(view()?.diagnostics.some((diagnostic) => diagnostic.message.includes("org.example.broken"))).toBe(true);
  });
});

describe("PluginManagerDialog preloaded rows", () => {
  it("lists a preloaded plugin as preloaded, toggleable, and neither removable nor updatable", () => {
    const runtime = createPluginRuntime({ getActiveDocument: () => undefined });
    mount(
      createElement(PluginManagerDialog, {
        runtime,
        bundledPlugins: [],
        preloadedPlugins: [entry],
        onUninstallPlugin: vi.fn(async () => undefined),
        onClose: vi.fn()
      })
    );
    const row = document.querySelector(`[data-plugin-id="${manifest.id}"]`);
    expect(row).not.toBeNull();
    expect(row!.querySelector('[data-testid="plugin-preloaded-badge"]')?.textContent).toBe("Preloaded");
    expect(row!.querySelector('[data-testid="plugin-preloaded-note"]')?.textContent).toMatch(/cannot be removed or updated/);
    expect(row!.textContent).not.toContain("Included with ChemDraft");
    expect(row!.querySelector('[data-action="uninstall-plugin"]')).toBeNull();
    expect(row!.querySelector('[data-action="review-plugin-update"]')).toBeNull();
    const toggle = row!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.disabled).toBe(false);
  });
});
