// @vitest-environment jsdom

import { dangerousPluginPermissions, type PluginManifest, type PluginPermission } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";

const mocks = vi.hoisted(() => ({ tauri: false, loadWebPreloadedPlugins: vi.fn() }));

vi.mock("./pluginStagingFs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pluginStagingFs")>()),
  isTauriHost: () => mocks.tauri
}));
vi.mock("./webPreloadedPlugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webPreloadedPlugins")>()),
  loadWebPreloadedPlugins: mocks.loadWebPreloadedPlugins
}));

import { isTauriHost } from "./pluginStagingFs";
import { usePluginRuntime, type PluginRuntimeView } from "./usePluginRuntime";
import type { WebPreloadedPluginEntry } from "./webPreloadedPlugins";
import {
  claimWebStartupCommandForPage,
  decideWebStartupCommand,
  resetWebStartupCommandPageGuard,
  tourModeForStartupCommand,
  useWebStartupCommand,
  webStartupCommandId
} from "./webStartupCommand";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRELOADED_ID = "org.example.spectrum-game";
const BOARD_COMMAND = "plugin.nmrGame.nextPuzzle";

const manifest: PluginManifest = {
  id: PRELOADED_ID,
  name: "Spectrum Game",
  version: "0.1.0",
  apiVersion: "^0.1.0",
  entry: "entry.js",
  permissions: ["ui.panel"],
  contributes: {
    commands: [{ id: BOARD_COMMAND, title: "Next Puzzle", requiredPermissions: [], enabled: true }],
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

const boardHandler = vi.fn(async () => undefined);
const entry: WebPreloadedPluginEntry = {
  record: { id: PRELOADED_ID, version: manifest.version, dir: PRELOADED_ID, sha256: "d".repeat(64) },
  manifest,
  descriptor: { manifest, options: { commandHandlers: { [BOARD_COMMAND]: boardHandler } } } as unknown as WebPreloadedPluginEntry["descriptor"]
};

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  mocks.loadWebPreloadedPlugins.mockReset();
  boardHandler.mockClear();
  resetWebStartupCommandPageGuard();
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The plugin runtime and the startup command together, as MainWindow wires them, optionally under StrictMode. */
async function renderApp(options: { commandId: string | undefined; strict?: boolean; registry?: CommandRegistry }) {
  const registry = options.registry ?? new CommandRegistry();
  const invoke = vi.fn(async (commandId: string) => { await registry.invoke(commandId); });
  const report = vi.fn();
  let view: PluginRuntimeView | undefined;
  function Probe() {
    view = usePluginRuntime({
      getActiveDocument: () => undefined,
      getSelection: () => ({ objectIds: [], molecules: [] }),
      commandRegistry: registry
    });
    useWebStartupCommand({
      commandId: options.commandId,
      enabled: !isTauriHost(),
      preloadedLoad: view.preloadedPluginsLoad,
      getCommand: commandId => registry.get(commandId),
      invoke,
      report
    });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    const probe = createElement(Probe);
    root!.render(options.strict ? createElement(StrictMode, null, probe) : probe);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  return { invoke, report, registry, view: () => view! };
}

/** The mocked loader registers the preloaded plugin into the runtime it is handed, as the real one does. */
function preloadRegisters(failures: { id: string; message: string }[] = []) {
  mocks.loadWebPreloadedPlugins.mockImplementation(async ({ runtime }) => {
    runtime.registerPlugin(manifest, entry.descriptor!.options);
    return { loaded: [entry], failures };
  });
}

describe("the build-time startup command in this (normal) build", () => {
  it("is unset", () => {
    expect(webStartupCommandId).toBeUndefined();
  });
});

describe("first-run tour with a startup command", () => {
  it("is suppressed only when a startup command is configured, and an explicit mode still wins", () => {
    expect(tourModeForStartupCommand(undefined, undefined)).toBeUndefined();
    expect(tourModeForStartupCommand(undefined, BOARD_COMMAND)).toBe("suppress");
    expect(tourModeForStartupCommand("automatic", undefined)).toBe("automatic");
    expect(tourModeForStartupCommand("force", BOARD_COMMAND)).toBe("force");
  });
});

describe("decideWebStartupCommand", () => {
  const getCommand = (definitions: Record<string, { source: "core" | "plugin"; pluginId?: string }>) =>
    (id: string) => definitions[id] ? { id, title: id, ...definitions[id] } : undefined;

  it("runs a preloaded plugin's command", () => {
    expect(decideWebStartupCommand({
      commandId: BOARD_COMMAND, preloaded: [entry], failures: [],
      getCommand: getCommand({ [BOARD_COMMAND]: { source: "plugin", pluginId: PRELOADED_ID } })
    })).toEqual({ kind: "run", commandId: BOARD_COMMAND, pluginId: PRELOADED_ID });
  });

  it("refuses a malformed id, a core command, a bundled plugin's command and an unknown id, naming why", () => {
    const lookup = getCommand({ "edit.undo": { source: "core" }, "plugin.bundled.go": { source: "plugin", pluginId: "org.chemdraft.bundled" } });
    const decide = (commandId: string) => decideWebStartupCommand({ commandId, preloaded: [entry], failures: [], getCommand: lookup });
    expect(decide("not a command")).toEqual({ kind: "refuse", message: expect.stringMatching(/not a valid command id/) });
    expect(decide("edit.undo")).toEqual({ kind: "refuse", message: expect.stringMatching(/registered by ChemDraft itself/) });
    expect(decide("plugin.bundled.go")).toEqual({ kind: "refuse", message: expect.stringMatching(/org\.chemdraft\.bundled", which is not a preloaded plugin/) });
    expect(decide("plugin.nobody.here")).toEqual({ kind: "refuse", message: expect.stringMatching(/no preloaded plugin registers/) });
  });

  it("says nothing more when a preloaded plugin that could have registered the command failed to load", () => {
    const decide = (failure: { id: string; message: string; commandIds?: string[] }) =>
      decideWebStartupCommand({ commandId: BOARD_COMMAND, preloaded: [], failures: [failure], getCommand: () => undefined });
    // Its manifest was never read, so it could have registered anything.
    expect(decide({ id: PRELOADED_ID, message: "boom" })).toEqual({ kind: "skip" });
    // Its manifest was read and declares the command.
    expect(decide({ id: PRELOADED_ID, message: "boom", commandIds: [BOARD_COMMAND] })).toEqual({ kind: "skip" });
  });

  it("still reports an unknown command when only unrelated preloaded plugins failed", () => {
    expect(decideWebStartupCommand({
      commandId: "plugin.nmrGame.missing",
      preloaded: [entry],
      failures: [
        { id: "org.example.other", message: "boom", commandIds: ["plugin.other.run"] },
        { id: PRELOADED_ID, message: "listed twice", commandIds: [] }
      ],
      getCommand: () => undefined
    })).toEqual({ kind: "refuse", message: expect.stringMatching(/"plugin\.nmrGame\.missing" was not run: no preloaded plugin registers that command/) });
  });

  it("refuses a preloaded plugin that declares any dangerous permission, naming them", () => {
    const lookup = (id: string) => id === BOARD_COMMAND ? { id, title: id, source: "plugin" as const, pluginId: PRELOADED_ID } : undefined;
    const withPermissions = (permissions: PluginPermission[]): WebPreloadedPluginEntry => ({ ...entry, manifest: { ...manifest, permissions } });
    for (const permission of dangerousPluginPermissions) {
      expect(decideWebStartupCommand({ commandId: BOARD_COMMAND, preloaded: [withPermissions(["ui.panel", permission])], failures: [], getCommand: lookup }))
        .toEqual({ kind: "refuse", message: `Startup command "${BOARD_COMMAND}" was not run: its plugin "${PRELOADED_ID}" declares the dangerous permission ${permission}, so its commands run only when you choose them.` });
    }
    expect(decideWebStartupCommand({
      commandId: BOARD_COMMAND, preloaded: [withPermissions(["document.write", "network.fetch"])], failures: [], getCommand: lookup
    })).toEqual({ kind: "refuse", message: expect.stringMatching(/declares the dangerous permissions document\.write, network\.fetch,/) });
  });

  it("runs a plugin with Spectrum Match's exact permission set, none of which is dangerous", () => {
    const spectrumMatch: PluginPermission[] = ["document.read", "selection.read", "chemistry.compute", "ui.menu", "ui.panel", "plugin.storage"];
    for (const permission of spectrumMatch) expect(dangerousPluginPermissions as readonly string[]).not.toContain(permission);
    expect(decideWebStartupCommand({
      commandId: BOARD_COMMAND,
      preloaded: [{ ...entry, manifest: { ...manifest, permissions: spectrumMatch } }],
      failures: [],
      getCommand: id => id === BOARD_COMMAND ? { id, title: id, source: "plugin", pluginId: PRELOADED_ID } : undefined
    })).toEqual({ kind: "run", commandId: BOARD_COMMAND, pluginId: PRELOADED_ID });
  });
});

describe("claimWebStartupCommandForPage", () => {
  it("is true once per page global and false after", () => {
    const page = {};
    expect(claimWebStartupCommandForPage(page)).toBe(true);
    expect(claimWebStartupCommandForPage(page)).toBe(false);
    expect(claimWebStartupCommandForPage({})).toBe(true);
  });
});

describe("useWebStartupCommand with the plugin runtime", () => {
  it("runs nothing when no startup command is configured", async () => {
    preloadRegisters();
    const { invoke, report } = await renderApp({ commandId: undefined });
    expect(invoke).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(boardHandler).not.toHaveBeenCalled();
  });

  it("invokes a preloaded plugin's command exactly once, after it registered, under StrictMode too", async () => {
    for (const strict of [false, true]) {
      boardHandler.mockClear();
      resetWebStartupCommandPageGuard();
      let resolveLoad!: () => void;
      mocks.loadWebPreloadedPlugins.mockImplementation(({ runtime, signal }) => new Promise(resolve => {
        resolveLoad = () => {
          if (signal?.aborted) return resolve({ loaded: [], failures: [] });
          runtime.registerPlugin(manifest, entry.descriptor!.options);
          resolve({ loaded: [entry], failures: [] });
        };
      }));
      const app = await renderApp({ commandId: BOARD_COMMAND, strict });
      expect(app.invoke).not.toHaveBeenCalled();
      await act(async () => {
        resolveLoad();
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(app.invoke).toHaveBeenCalledTimes(1);
      expect(app.invoke).toHaveBeenCalledWith(BOARD_COMMAND);
      expect(boardHandler).toHaveBeenCalledTimes(1);
      expect(app.report).not.toHaveBeenCalled();
      // A later change of the plugin list (a reload) never runs it again.
      await act(async () => {
        app.view().runtime.unregisterPlugin(PRELOADED_ID);
        await Promise.resolve();
      });
      expect(app.invoke).toHaveBeenCalledTimes(1);
      act(() => root?.unmount());
      container?.remove();
      root = undefined;
    }
  });

  it("refuses a core command with a diagnostic and does not invoke it", async () => {
    preloadRegisters();
    const registry = new CommandRegistry();
    const undo = vi.fn();
    registry.register({ id: "edit.undo", title: "Undo", source: "core" }, undo);
    const { invoke, report } = await renderApp({ commandId: "edit.undo", registry });
    expect(invoke).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatch(/Startup command "edit\.undo" was not run: it is registered by ChemDraft itself/);
  });

  it("refuses a bundled plugin's command", async () => {
    preloadRegisters();
    const registry = new CommandRegistry();
    const probe = await renderApp({ commandId: undefined, registry });
    const bundled = registry.list().find(command => command.source === "plugin" && command.pluginId !== PRELOADED_ID);
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    expect(bundled, "a bundled plugin registers at least one command").toBeDefined();
    expect(probe.view().bundledPlugins.some(plugin => plugin.manifest.id === bundled!.pluginId)).toBe(true);
    const decision = decideWebStartupCommand({ commandId: bundled!.id, preloaded: [entry], failures: [], getCommand: id => registry.get(id) });
    expect(decision).toEqual({ kind: "refuse", message: expect.stringMatching(/which is not a preloaded plugin/) });
  });

  it("refuses an unknown id with a diagnostic", async () => {
    preloadRegisters();
    const { invoke, report } = await renderApp({ commandId: "plugin.nmrGame.missing" });
    expect(invoke).not.toHaveBeenCalled();
    expect(report.mock.calls[0][0]).toMatch(/no preloaded plugin registers that command/);
  });

  it("refuses a preloaded plugin that declares a dangerous permission and does not invoke it", async () => {
    const dangerousManifest: PluginManifest = { ...manifest, permissions: ["ui.panel", "document.write"] };
    mocks.loadWebPreloadedPlugins.mockImplementation(async ({ runtime }) => {
      runtime.registerPlugin(dangerousManifest, entry.descriptor!.options);
      return { loaded: [{ ...entry, manifest: dangerousManifest }], failures: [] };
    });
    const { invoke, report } = await renderApp({ commandId: BOARD_COMMAND });
    expect(invoke).not.toHaveBeenCalled();
    expect(boardHandler).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatch(/declares the dangerous permission document\.write/);
  });

  it("runs once per page load, not again when a hot reload remounts the app", async () => {
    preloadRegisters();
    const first = await renderApp({ commandId: BOARD_COMMAND });
    expect(first.invoke).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    const second = await renderApp({ commandId: BOARD_COMMAND });
    expect(second.invoke).not.toHaveBeenCalled();
    expect(second.report).not.toHaveBeenCalled();
    expect(boardHandler).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown command when only an unrelated preloaded plugin failed", async () => {
    mocks.loadWebPreloadedPlugins.mockImplementation(async ({ runtime }) => {
      runtime.registerPlugin(manifest, entry.descriptor!.options);
      return { loaded: [entry], failures: [{ id: "org.example.other", message: "boom", commandIds: ["plugin.other.run"] }] };
    });
    const { invoke, report } = await renderApp({ commandId: "plugin.nmrGame.missing" });
    expect(invoke).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatch(/no preloaded plugin registers that command/);
  });

  it("does nothing beyond the load failure when the preloaded plugin failed", async () => {
    mocks.loadWebPreloadedPlugins.mockResolvedValue({ loaded: [], failures: [{ id: PRELOADED_ID, message: "boom" }] });
    const { invoke, report } = await renderApp({ commandId: BOARD_COMMAND });
    expect(invoke).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("never runs on a Tauri host", async () => {
    mocks.tauri = true;
    try {
      preloadRegisters();
      const { invoke, report, view } = await renderApp({ commandId: BOARD_COMMAND });
      expect(view().preloadedPluginsLoad).toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      mocks.tauri = false;
    }
  });
});
