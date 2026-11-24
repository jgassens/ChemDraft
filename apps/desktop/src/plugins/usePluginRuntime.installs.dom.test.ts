// @vitest-environment jsdom

import type { ListenForAppHandoff } from "../appHandoff/nativeMenu";
import type { PluginCommandContext, PluginHandoffCommandResult, PluginManifest } from "@chemdraft/plugin-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";
import { deferred } from "../testSupport/deferred";
import appConfig from "../../src-tauri/tauri.conf.json";

const hookMocks = vi.hoisted(() => ({
  stagingFs: { readTextFile: vi.fn() },
  handoffTransport: vi.fn(),
  getVersion: vi.fn(),
  loadInstalledPlugins: vi.fn(),
  installPluginPackage: vi.fn(),
  uninstallPlugin: vi.fn(),
  updateInstalledPluginPackage: vi.fn()
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: hookMocks.getVersion }));

vi.mock("../appHandoff/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("../appHandoff/transport")>(),
  createTauriAppHandoffTransport: () => hookMocks.handoffTransport
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
    installPluginPackage: hookMocks.installPluginPackage,
    uninstallPlugin: hookMocks.uninstallPlugin,
    updateInstalledPluginPackage: hookMocks.updateInstalledPluginPackage
  };
});

import { PluginInstallError, PluginInstallErrorCodes, type InstalledPluginCatalogEntry } from "./installPluginPackage";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";
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
  hookMocks.stagingFs.readTextFile.mockReset();
  hookMocks.handoffTransport.mockReset();
  hookMocks.getVersion.mockReset().mockResolvedValue("1.9.99");
  hookMocks.loadInstalledPlugins.mockReset();
  hookMocks.installPluginPackage.mockReset();
  hookMocks.uninstallPlugin.mockReset();
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
  it.each(["catalog", "sideload"] as const)("dispatches native menu events and rechecks %s provenance", async source => {
    const id = "org.chemdraft.handoff.crystalBuilder";
    const commandId = "plugin.crystalBuilder.sendMolecule";
    const entry = catalogEntry("1.0.0", "a".repeat(64));
    const record = { ...entry.record, id, source, checksumVerified: true,
      repository: "jgassens/ChemDraft-CrystalBuilder-Plugin" };
    vi.stubGlobal("__CHEMDRAFT_HANDOFF_SIDELOAD_ALLOWED__", source === "sideload");
    const handoffManifest = { ...entry.manifest, id, name: "Send to Crystal Builder",
      permissions: ["apps.handoff", "native.execute", "selection.read"] as const,
      companions: [{ id: "mofBuild", tool: { macos: "Contents/MacOS/xtal", windows: "xtal.exe" },
        testedVersions: ["1.1.1"], combinations: { small: { repeat: "1x1x1" } }, steps: [
          { id: "preflight", args: ["capabilities", "--json"], timeoutSeconds: 30 },
          { id: "build", args: ["-o", "{outputFile:cif}", "--json"], timeoutSeconds: 30 }
        ] }],
      contributes: { ...entry.manifest.contributes, commands: [{ id: commandId, title: "Send" }],
        menus: [{ id: "menu.crystalBuilder.sendMolecule", commandId, title: "Send" }] } };
    hookMocks.loadInstalledPlugins.mockResolvedValue({ installed: [], failures: [] });
    hookMocks.handoffTransport.mockResolvedValue({ status: "sent" });
    hookMocks.stagingFs.readTextFile.mockResolvedValue(JSON.stringify({ version: 1, plugins: [record] }));
    const status = vi.fn();
    const runningVersion = deferred<string>();
    hookMocks.getVersion.mockReturnValue(runningVersion.promise);
    const identities: (PluginCommandContext["host"])[] = [];
    let view: PluginRuntimeView | undefined;
    const invocation = { pluginId: id, commandId, nonce: "2".repeat(32) };
    let click: () => Promise<void>;
    const listenForAppHandoff: ListenForAppHandoff = dispatch => {
      click = () => dispatch(invocation);
      return () => {};
    };
    function Probe() {
      view = usePluginRuntime({
        listenForAppHandoff,
        getActiveDocument: () => undefined,
        getSelection: warnings => {
          warnings?.push("Selection contains unsupported labels.");
          return { objectIds: [], molecules: [] };
        },
        onAppHandoffStatus: status
      });
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(Probe)));
    const request = { appId: "chosen", fileName: "model", extension: "cif" as const, text: "test data" };
    let attempt: (apps: NonNullable<PluginCommandContext["apps"]>) => Promise<unknown> = apps => apps.sendFile(request);
    let pluginStatus = "  File\r\n\u202eopened.\u2069 ";
    await act(async () => {
      view!.runtime.registerPlugin(handoffManifest, { execution: "worker",
        commandHandlers: { [commandId]: async (context): Promise<PluginHandoffCommandResult> => {
          await context.selection!.getSelection();
          identities.push(context.host);
          const result = await attempt(context.apps!).catch(() => undefined);
          if (result && typeof result === "object" && "status" in result && result.status === "failed") {
            const message = "diagnostic" in result
              ? (result.diagnostic as { json: { message: string } }).json.message
              : "ChemDraft verified\u200b this build. " + "🧪".repeat(600);
            return { ok: false, error: { code: "plugin-error", message } };
          }
          return { ok: true, data: { status: pluginStatus } };
        } } }, record);
    });
    await act(async () => { await click(); });
    expect(hookMocks.handoffTransport).toHaveBeenCalledExactlyOnceWith(invocation, "sendFile", request);
    expect(status.mock.calls).toEqual([
      ["Opened the handoff file in the chosen app."],
      ["Plugin (Send to Crystal Builder): File opened.\nSelection contains unsupported labels."]
    ]);
    expect(identities).toEqual([undefined]);
    expect("1.9.99").not.toBe(appConfig.version);
    await act(async () => { runningVersion.resolve("1.9.99"); });
    hookMocks.handoffTransport.mockResolvedValueOnce({ status: "declined" });
    await act(async () => { await click(); });
    expect(status.mock.calls.slice(-2)).toEqual([
      ["App handoff cancelled."], ["App handoff cancelled.\nSelection contains unsupported labels."]
    ]);
    hookMocks.handoffTransport.mockResolvedValueOnce({ status: "failed", code: "launch-failed", message: "The app refused to open the file." });
    await act(async () => { await click(); });
    expect(status.mock.calls.slice(-2)).toEqual([
      ["App handoff failed: The app refused to open the file."],
      [`App handoff failed: The app refused to open the file.\nPlugin (Send to Crystal Builder): ChemDraft verified this build. ${"🧪".repeat(468)}…\nSelection contains unsupported labels.`]
    ]);
    hookMocks.handoffTransport.mockRejectedValueOnce(new Error("The native endpoint refused the handoff."));
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith("The native endpoint refused the handoff.\nSelection contains unsupported labels.");
    hookMocks.stagingFs.readTextFile.mockResolvedValue(JSON.stringify({ version: 1, plugins: [{ ...record, version: "2.0.0" }] }));
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("checksum-verified install"));
    expect(hookMocks.handoffTransport).toHaveBeenCalledTimes(4);
    expect(hookMocks.stagingFs.readTextFile).toHaveBeenCalledTimes(5);
    expect(identities.slice(1)).toEqual(Array(4).fill({ name: "ChemDraft", version: "1.9.99" }));
    expect(hookMocks.getVersion).toHaveBeenCalledOnce();

    hookMocks.stagingFs.readTextFile.mockResolvedValue(JSON.stringify({ version: 1, plugins: [record] }));
    attempt = apps => apps.sendFile({ ...request, appId: "" });
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("Invalid apps.sendFile request"));
    expect(hookMocks.handoffTransport).toHaveBeenCalledTimes(4);

    attempt = async apps => {
      await apps.sendFile({ ...request, appId: "" }).catch(() => undefined);
      return apps.sendFile(request);
    };
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith("Plugin (Send to Crystal Builder): File opened.\nSelection contains unsupported labels.");

    status.mockClear();
    attempt = async apps => {
      const pendingSend = apps.sendFile(request);
      await apps.sendFile({ ...request, appId: "" }).catch(() => undefined);
      return pendingSend;
    };
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("Invalid apps.sendFile request"));
    expect(status).not.toHaveBeenCalledWith(expect.stringContaining("File opened."));

    attempt = async apps => {
      await apps.sendFile(request);
      return apps.sendFile(request);
    };
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("one file or run one companion pipeline"));

    const waiting = deferred<void>();
    hookMocks.stagingFs.readTextFile.mockImplementationOnce(() => waiting.promise);
    attempt = async apps => { void apps.sendFile(request).catch(() => undefined); };
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("before app handoff completed"));
    await act(async () => { waiting.resolve(); });

    attempt = apps => apps.runCompanion({ appId: request.appId, pipeline: "mofBuild", combination: "small", openOutput: true });
    hookMocks.handoffTransport.mockResolvedValueOnce({
      status: "failed", code: "exit-nonzero", message: "The build step exited unsuccessfully.",
      diagnostic: { step: "build", exitCode: 2, json: { message: "The linker has three connection points." } }
    });
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith(
      "Companion build failed: The build step exited unsuccessfully.\nPlugin (Send to Crystal Builder): The linker has three connection points.\nSelection contains unsupported labels."
    );

    pluginStatus = "C6H4X2 build completed.";
    hookMocks.handoffTransport.mockResolvedValueOnce({ status: "done", steps: [], opened: false });
    await act(async () => { await click(); });
    expect(status).toHaveBeenLastCalledWith(
      "Build completed, but the chosen app could not open it.\nPlugin (Send to Crystal Builder): C6H4X2 build completed.\nSelection contains unsupported labels."
    );
  });

  it("removes the UI entry and disabled flag before surfacing a post-uninstall storage deletion error", async () => {
    const initial = catalogEntry("1.0.0", "a".repeat(64));
    hookMocks.loadInstalledPlugins.mockResolvedValue({ installed: [initial], failures: [] });
    const error = new PluginInstallError(
      PluginInstallErrorCodes.UninstallStorageDeleteFailed,
      `Plugin "${pluginId}" was uninstalled, but its stored settings could not be deleted: permission denied`
    );
    hookMocks.uninstallPlugin.mockRejectedValue(error);
    saveDisabledPluginIds(new Set([pluginId, "org.chemdraft.other"]));

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
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
    });
    expect(view?.installedPlugins).toHaveLength(1);
    await act(async () => {
      await expect(view!.uninstallInstalledPlugin!(pluginId)).rejects.toBe(error);
    });
    expect(hookMocks.uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ bundledPlugins: view!.bundledPlugins })
    );
    expect(view?.installedPlugins).toEqual([]);
    expect([...loadDisabledPluginIds()]).toEqual(["org.chemdraft.other"]);
  });

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

  it("clears a stale disabled preference for the id a fresh install takes", async () => {
    // Left by the removed bundled canary that used the same id as the catalog plugin.
    saveDisabledPluginIds(new Set([pluginId, "org.chemdraft.other"]));
    hookMocks.loadInstalledPlugins.mockResolvedValue({ installed: [], failures: [] });
    const installed = catalogEntry("1.0.0", "c".repeat(64));
    hookMocks.installPluginPackage.mockResolvedValue({
      record: installed.record,
      descriptor: { manifest: installed.manifest, options: { commandHandlers: {} } }
    });

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
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
    });

    await act(async () => {
      await view!.installPackage!(preparedUpdate().inspection);
    });

    expect(hookMocks.installPluginPackage).toHaveBeenCalledOnce();
    // After a restart, loadInstalledPlugins reads this set: the new install must load enabled.
    expect([...loadDisabledPluginIds()]).toEqual(["org.chemdraft.other"]);
    expect(view?.installedPlugins.map((entry) => entry.record.id)).toEqual([pluginId]);
  });
});
