// @vitest-environment jsdom

import type { PluginManifest } from "@chemdraft/plugin-api";
import { act, createElement, Fragment, useEffect, useReducer, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";
import type { InstalledPluginCatalogEntry, PluginPackageInspection } from "./installPluginPackage";
import type { PickedPluginPackage } from "./pickPluginPackage";
import { buildPluginMenuItems } from "./pluginMenuModel";
import { PluginManagerDialog } from "./PluginManagerDialog";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";
import type {
  PreparedOfficialPluginInstall,
  PluginUpdateCheckResult,
  PluginUpdateOffer,
  PreparedPluginUpdate
} from "./pluginUpdates";
import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";
import { applyEnabledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";
import type {
  StructureRecognitionEngine,
  StructureRecognitionEngineStatus,
  StructureRecognitionInstallProgress
} from "./structureRecognitionEngine";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pluginId = "org.chemdraft.test.manager";
const commandId = "plugin.managerTest.run";

const manifest: PluginManifest = {
  id: pluginId,
  name: "Manager Test Plugin",
  version: "1.2.3",
  apiVersion: "^0.1.0",
  description: "A fixture plugin used to verify live plugin management.",
  entry: "dist/plugin.js",
  permissions: ["ui.menu"],
  contributes: {
    commands: [{ id: commandId, title: "Run Manager Test", requiredPermissions: [], enabled: true }],
    menus: [
      {
        id: "menu.managerTest.run",
        title: "Run Manager Test",
        commandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ],
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

const descriptors: readonly BundledPluginDescriptor[] = [
  {
    manifest,
    options: { commandHandlers: { [commandId]: async () => ({ ok: true }) } }
  }
];

let container: HTMLElement | undefined;
let root: Root | undefined;
const originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage()
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  }
});

function createRuntime(): DesktopPluginRuntime {
  return createPluginRuntime({
    getActiveDocument: () => undefined,
    getSelection: () => ({ objectIds: [], molecules: [] })
  });
}

function Harness({ runtime, onClose, onPluginsChanged, ...installProps }: {
  runtime: DesktopPluginRuntime;
  onClose: () => void;
  onPluginsChanged: () => void;
  bundledPlugins?: readonly BundledPluginDescriptor[];
  installedPlugins?: readonly InstalledPluginCatalogEntry[];
  installedPluginCatalogReady?: boolean;
  onPickPackage?: () => Promise<PickedPluginPackage | undefined>;
  onInstallPackage?: (inspection: PluginPackageInspection) => Promise<void>;
  onPrepareOfficialPluginInstall?: (pluginId: string) => Promise<PreparedOfficialPluginInstall>;
  onUninstallPlugin?: (pluginId: string) => Promise<void>;
  onCheckPluginUpdates?: () => Promise<readonly PluginUpdateCheckResult[]>;
  onPreparePluginUpdate?: (offer: PluginUpdateOffer) => Promise<PreparedPluginUpdate>;
  onUpdatePlugin?: (prepared: PreparedPluginUpdate) => Promise<void>;
  recognitionEngineStatus?: import("./structureRecognitionEngine").StructureRecognitionEngineStatus;
  onRefreshRecognitionEngineStatus?: () => Promise<void>;
  recognitionEngineInstall?: import("./StructureRecognitionController").StructureRecognitionInstallRun;
  onInstallRecognitionEngine?: () => Promise<boolean>;
  onCancelRecognitionEngineInstall?: () => Promise<void>;
  onUninstallRecognitionEngine?: () => Promise<void>;
}) {
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  useEffect(() => runtime.host.subscribe(refresh), [runtime]);
  const menuItems = buildPluginMenuItems(runtime.host.listMenuContributions());

  return createElement(
    Fragment,
    null,
    createElement(
      "div",
      { "data-testid": "live-plugin-menu" },
      menuItems.map((item) =>
        createElement("span", { "data-command-id": item.command.commandId, key: item.command.id })
      )
    ),
    createElement(PluginManagerDialog, {
      runtime,
      bundledPlugins: descriptors,
      onClose,
      onPluginsChanged,
      ...installProps
    })
  );
}

const installedPluginId = "org.chemdraft.test.installed";
const installedCommandId = "plugin.installedTest.run";

const installedManifest: PluginManifest = {
  ...manifest,
  id: installedPluginId,
  name: "Installed Test Plugin",
  version: "2.0.1",
  description: "A packaged plugin installed at runtime.",
  permissions: ["ui.menu"],
  contributes: {
    ...manifest.contributes,
    commands: [{ id: installedCommandId, title: "Run Installed", requiredPermissions: [], enabled: true }],
    menus: [
      {
        id: "menu.installedTest.run",
        title: "Run Installed",
        commandId: installedCommandId,
        location: "analyze",
        requiredPermissions: ["ui.menu"]
      }
    ]
  }
};

const networkPluginManifest: PluginManifest = {
  ...installedManifest,
  permissions: ["ui.menu", "network.fetch"]
};

/** A catalog entry shaped like a real install, with a descriptor carrying real command handlers. */
function installedEntry(
  entryManifest: PluginManifest = installedManifest,
  loadable = true
): InstalledPluginCatalogEntry {
  return {
    record: {
      id: entryManifest.id,
      version: entryManifest.version,
      name: entryManifest.name,
      stagedPath: `installed-plugins/${entryManifest.id}`,
      sourceChecksum: "a".repeat(64),
      installedAt: "2026-07-16T00:00:00.000Z"
    },
    manifest: entryManifest,
    descriptor: loadable
      ? ({
          manifest: entryManifest,
          options: { commandHandlers: { [installedCommandId]: async () => ({ ok: true }) } },
          bridge: { terminate: () => {} } as never,
          entryUrl: new URL(`tauri://localhost/installed-plugins/${entryManifest.id}/entry.js`),
          provenance: {
            sdk: "@chemdraft/plugin-api",
            sdkVersion: "0.1.0",
            sourceCommit: "0fd3eceec674f207fe2651fe7a19f6438a55fb17",
            sourceTree: "clean",
            licenseFile: "LICENSE",
            packagedAt: "2026-07-16T14:07:19.768Z"
          }
        } as never)
      : undefined
  };
}

function pickedPackage(packageManifest: PluginManifest = installedManifest): PickedPluginPackage {
  const provenance = installedEntry().descriptor!.provenance;
  return {
    sourcePath: "/Users/someone/Downloads/installed-test-plugin-2.0.1.zip",
    checksumVerified: true,
    inspection: {
      manifest: packageManifest,
      provenance,
      sourceChecksum: "b".repeat(64),
      entries: [],
      unpackedBytes: 17_834_630
    }
  };
}

function updateOffer(): PluginUpdateOffer {
  return {
    pluginId: installedPluginId,
    pluginName: installedManifest.name,
    installedVersion: installedManifest.version,
    version: "2.1.0",
    releaseUrl: "https://github.com/example/plugin/releases/tag/v2.1.0",
    packageUrl: "https://github.com/example/plugin/releases/download/v2.1.0/plugin-2.1.0.zip",
    packageName: "plugin-2.1.0.zip",
    sourceChecksum: "b".repeat(64),
    compressedBytes: 3_100_000,
    publishedAt: "2026-07-25T12:00:00.000Z"
  };
}

function preparedUpdate(): PreparedPluginUpdate {
  const picked = pickedPackage({ ...installedManifest, version: "2.1.0" });
  return {
    offer: updateOffer(),
    inspection: picked.inspection,
    sourcePath: updateOffer().packageUrl,
    checksumVerified: true
  };
}

const officialNmrPluginId = "org.chemdraft.nmr.predictor";
const officialOpsinPluginId = "org.chemdraft.opsin.nameToStructure";
const officialNmrManifest: PluginManifest = {
  ...installedManifest,
  id: officialNmrPluginId,
  name: "NMR Shift Predictor",
  version: "0.1.0",
  description: "¹H/¹³C shift prediction from NMRShiftDB2-derived statistics."
};

function preparedOfficialInstall(): PreparedOfficialPluginInstall {
  const picked = pickedPackage(officialNmrManifest);
  return {
    pluginId: officialNmrPluginId,
    inspection: picked.inspection,
    sourcePath:
      "https://github.com/jgassens/ChemDraft-NMR-Plugin/releases/download/v0.1.0/" +
      "nmr-predictor-0.1.0.zip",
    checksumVerified: true
  };
}

function mount(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function OfficialCatalogHarness({
  runtime,
  initialInstalled = false,
  prepare,
  onInstall = async () => {},
  onUninstall = async () => {}
}: {
  runtime: DesktopPluginRuntime;
  initialInstalled?: boolean;
  prepare: (pluginId: string) => Promise<PreparedOfficialPluginInstall>;
  onInstall?: (inspection: PluginPackageInspection) => Promise<void>;
  onUninstall?: (pluginId: string) => Promise<void>;
}) {
  const [installed, setInstalled] = useState<readonly InstalledPluginCatalogEntry[]>(
    initialInstalled ? [installedEntry(officialNmrManifest, false)] : []
  );
  return createElement(Harness, {
    runtime,
    onClose: vi.fn(),
    onPluginsChanged: vi.fn(),
    installedPlugins: installed,
    onInstallPackage: async (inspection) => {
      await onInstall(inspection);
      setInstalled([installedEntry(inspection.manifest, false)]);
    },
    onPrepareOfficialPluginInstall: prepare,
    onUninstallPlugin: async (pluginId) => {
      await onUninstall(pluginId);
      setInstalled((current) => current.filter((entry) => entry.record.id !== pluginId));
    }
  });
}

describe("PluginManagerDialog", () => {
  const molscribeManifest: PluginManifest = {
    ...manifest,
    id: "org.chemdraft.ocsr.molscribe",
    name: "MolScribe OCSR",
    apiVersion: "^0.1.6"
  };
  const molscribeInstalled = installedEntry(molscribeManifest);
  const installedEngineStatus = {
    state: "installed" as const,
    installed: {
      uvVersion: "0.8.0",
      pythonVersion: "3.12.8",
      molscribeCommit: "abc123",
      modelSha256: "a".repeat(64),
      installedAt: "2026-09-24T00:00:00.000Z",
      diskBytes: 2.5e9
    },
    requiredDiskBytes: 2.5e9,
    freeDiskBytes: 8e9
  };

  it("shows no engine row while the MolScribe plugin is not installed", () => {
    const runtime = createRuntime();
    mount(
      createElement(Harness, {
        runtime,
        // Even a descriptor carrying the id (a dev build, say) is not an install.
        bundledPlugins: [{ manifest: molscribeManifest, options: { commandHandlers: {} } }],
        recognitionEngineStatus: installedEngineStatus,
        onUninstallRecognitionEngine: vi.fn(async () => undefined),
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );
    expect(document.querySelector('[data-testid="molscribe-engine-row"]')).toBeNull();
  });

  it.each([
    ["Remove", "confirm-remove-recognition-engine", 1],
    ["Keep", "keep-recognition-engine", 0]
  ])(
    "asks once after uninstalling MolScribe whether to remove the engine too (%s)",
    async (_label, action, removals) => {
      const runtime = createRuntime();
      const onUninstallRecognitionEngine = vi.fn(async () => undefined);
      const onUninstall = vi.fn(async (_pluginId: string) => {});
      function UninstallHarness() {
        const [installed, setInstalled] = useState<readonly InstalledPluginCatalogEntry[]>([molscribeInstalled]);
        return createElement(Harness, {
          runtime,
          installedPlugins: installed,
          recognitionEngineStatus: installedEngineStatus,
          onUninstallRecognitionEngine,
          onUninstallPlugin: async (pluginId) => {
            await onUninstall(pluginId);
            setInstalled((current) => current.filter((entry) => entry.record.id !== pluginId));
          },
          onClose: vi.fn(),
          onPluginsChanged: vi.fn()
        });
      }
      mount(createElement(UninstallHarness));
      expect(document.querySelector('[data-testid="molscribe-engine-row"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="recognition-engine-removal-offer"]')).toBeNull();

      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            `[data-action="uninstall-plugin"][data-plugin-id="${molscribeManifest.id}"]`
          )!
          .click();
      });
      expect(onUninstall).toHaveBeenCalledWith(molscribeManifest.id);
      // The plugin is gone, so its engine row is too; the engine itself is still on disk until asked.
      expect(document.querySelector('[data-testid="molscribe-engine-row"]')).toBeNull();
      const offer = document.querySelector('[data-testid="recognition-engine-removal-offer"]');
      expect(offer?.textContent).toContain("Also remove the recognition engine (2.5 GB)?");
      expect(onUninstallRecognitionEngine).not.toHaveBeenCalled();

      await act(async () => {
        offer!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
      });
      expect(onUninstallRecognitionEngine).toHaveBeenCalledTimes(removals);
      expect(document.querySelector('[data-testid="recognition-engine-removal-offer"]')).toBeNull();
      expect(document.querySelector(".plugin-manager-error")).toBeNull();
      if (removals === 1) {
        expect(document.querySelector('[data-testid="plugin-manager-status"]')?.textContent).toBe(
          "Recognition engine removed."
        );
      }
    }
  );

  it("does not offer engine removal after uninstalling MolScribe when no engine is installed", async () => {
    const runtime = createRuntime();
    const onUninstallRecognitionEngine = vi.fn(async () => undefined);
    mount(
      createElement(Harness, {
        runtime,
        installedPlugins: [molscribeInstalled],
        recognitionEngineStatus: { state: "notInstalled", requiredDiskBytes: 0, freeDiskBytes: 0 },
        onUninstallRecognitionEngine,
        onUninstallPlugin: vi.fn(async () => {}),
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(`[data-action="uninstall-plugin"][data-plugin-id="${molscribeManifest.id}"]`)!
        .click();
    });
    expect(document.querySelector('[data-testid="recognition-engine-removal-offer"]')).toBeNull();
    expect(onUninstallRecognitionEngine).not.toHaveBeenCalled();
  });

  it("offers host-owned recognition-engine installation from the MolScribe row", () => {
    const runtime = createRuntime();
    const onInstallRecognitionEngine = vi.fn(async () => true);
    mount(
      createElement(Harness, {
        runtime,
        installedPlugins: [molscribeInstalled],
        recognitionEngineStatus: {
          state: "notInstalled",
          requiredDiskBytes: 2e9,
          freeDiskBytes: 8e9
        },
        onInstallRecognitionEngine,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );

    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: not installed"
    );
    expect(document.querySelector('[data-testid="molscribe-engine-install-note"]')?.textContent).toContain(
      "Downloads about 2.5 GB and needs 2 GB free (8 GB free now)."
    );
    const install = document.querySelector<HTMLButtonElement>('[data-action="install-recognition-engine"]')!;
    // A full-size button, never a small text link.
    expect(install.className).toBe("plugin-manager-button");
    expect(install.textContent).toBe("Install engine");
    act(() => install.click());
    expect(onInstallRecognitionEngine).toHaveBeenCalledOnce();
  });

  it("says in plain words why a broken engine must be installed again", () => {
    const runtime = createRuntime();
    const onInstallRecognitionEngine = vi.fn(async () => true);
    mount(
      createElement(Harness, {
        runtime,
        installedPlugins: [molscribeInstalled],
        recognitionEngineStatus: {
          state: "broken",
          requiredDiskBytes: 3e9,
          freeDiskBytes: 8e9,
          detail: "The recognition engine needs to be updated. Install the engine again to update it."
        },
        onInstallRecognitionEngine,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );

    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: needs to be installed again"
    );
    expect(document.querySelector('[data-testid="molscribe-engine-detail"]')?.textContent).toBe(
      "The recognition engine needs to be updated. Install the engine again to update it."
    );
    const install = document.querySelector<HTMLButtonElement>('[data-action="install-recognition-engine"]')!;
    expect(install.textContent).toBe("Install engine again");
    act(() => install.click());
    expect(onInstallRecognitionEngine).toHaveBeenCalledOnce();
  });

  it("shows the host's check of an older engine as a running step, not an Install button", () => {
    const runtime = createRuntime();
    mount(
      createElement(Harness, {
        runtime,
        installedPlugins: [molscribeInstalled],
        recognitionEngineStatus: {
          state: "installing",
          requiredDiskBytes: 3e9,
          freeDiskBytes: 8e9,
          progress: {
            phase: "verifying",
            message: "Checking the installed recognition engine against this version of ChemDraft."
          },
          installElapsedMs: 1200
        },
        onInstallRecognitionEngine: vi.fn(async () => true),
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );

    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: installing"
    );
    expect(document.querySelector('[data-testid="recognition-install-step"]')?.textContent).toBe(
      "Step 5 of 5: Checking the installation"
    );
    expect(document.querySelector('[data-action="install-recognition-engine"]')).toBeNull();
    expect(document.querySelector('[data-testid="molscribe-engine-detail"]')).toBeNull();
  });

  it("shows installed engine size and removal in the MolScribe row", () => {
    const runtime = createRuntime();
    const onUninstallRecognitionEngine = vi.fn(async () => undefined);
    mount(
      createElement(Harness, {
        runtime,
        installedPlugins: [molscribeInstalled],
        recognitionEngineStatus: {
          state: "installed",
          installed: {
            uvVersion: "0.8.0",
            pythonVersion: "3.12.8",
            molscribeCommit: "abc123",
            modelSha256: "a".repeat(64),
            installedAt: "2026-09-24T00:00:00.000Z",
            diskBytes: 2e9
          },
          requiredDiskBytes: 2e9,
          freeDiskBytes: 8e9
        },
        onUninstallRecognitionEngine,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );

    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: installed (2 GB)"
    );
    const remove = document.querySelector<HTMLButtonElement>('[data-action="remove-recognition-engine"]')!;
    expect(remove.className).toBe("plugin-manager-button");
    expect(remove.textContent).toBe("Remove engine");
    act(() => remove.click());
    expect(onUninstallRecognitionEngine).toHaveBeenCalledOnce();
  });

  it("reads the engine status when the dialog opens and reports a failed removal in plain words", async () => {
    const runtime = createRuntime();
    const onRefreshRecognitionEngineStatus = vi.fn(async () => undefined);
    const onUninstallRecognitionEngine = vi.fn(async () => {
      throw { code: "failed", message: "The engine folder is in use." };
    });
    mount(
      createElement(Harness, {
        runtime,
        installedPlugins: [molscribeInstalled],
        recognitionEngineStatus: {
          state: "installed",
          installed: {
            uvVersion: "0.8.0",
            pythonVersion: "3.12.8",
            molscribeCommit: "abc123",
            modelSha256: "a".repeat(64),
            installedAt: "2026-09-24T00:00:00.000Z",
            diskBytes: 2e9
          },
          requiredDiskBytes: 2e9,
          freeDiskBytes: 8e9
        },
        onRefreshRecognitionEngineStatus,
        onUninstallRecognitionEngine,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );
    expect(onRefreshRecognitionEngineStatus).toHaveBeenCalledOnce();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="remove-recognition-engine"]')!.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="molscribe-engine-row"] [role="alert"]')?.textContent).toBe(
      "The engine could not be removed: The engine folder is in use."
    );
  });

  it("says the engine is unsupported without offering an install", () => {
    const runtime = createRuntime();
    mount(
      createElement(Harness, {
        runtime,
        installedPlugins: [molscribeInstalled],
        recognitionEngineStatus: { state: "unsupported", requiredDiskBytes: 0, freeDiskBytes: 0 },
        onInstallRecognitionEngine: vi.fn(async () => true),
        onClose: vi.fn(),
        onPluginsChanged: vi.fn()
      })
    );
    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: not supported on this computer"
    );
    expect(document.querySelector('[data-action="install-recognition-engine"]')).toBeNull();
  });

  it("leaves Escape to the engine install dialog opened over it", () => {
    const runtime = createRuntime();
    const onClose = vi.fn();
    mount(createElement(Harness, { runtime, onClose, onPluginsChanged: vi.fn() }));
    const installDialog = document.createElement("div");
    installDialog.className = "recognition-install-dialog";
    const target = document.createElement("button");
    installDialog.appendChild(target);
    document.body.appendChild(installDialog);

    act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables and re-enables a bundled plugin live while persisting the preference", () => {
    const runtime = createRuntime();
    const onPluginsChanged = vi.fn();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(createElement(Harness, { runtime, onClose: vi.fn(), onPluginsChanged }));

    const rowSelector = `[data-plugin-id="${pluginId}"]`;
    expect(runtime.host.getPlugin(pluginId)).toBeDefined();
    expect(document.querySelector(`${rowSelector} input`)?.getAttribute("aria-label")).toBe("Enable Manager Test Plugin");
    expect((document.querySelector(`${rowSelector} input`) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector(`[data-command-id="${commandId}"]`)).not.toBeNull();

    act(() => {
      (document.querySelector(`${rowSelector} input`) as HTMLInputElement).click();
    });

    expect(runtime.host.getPlugin(pluginId)).toBeUndefined();
    expect(loadDisabledPluginIds()).toEqual(new Set([pluginId]));
    expect(document.querySelector(rowSelector)).not.toBeNull();
    expect((document.querySelector(`${rowSelector} input`) as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector(rowSelector)?.textContent).toContain("Disabled");
    expect(document.querySelector(`[data-command-id="${commandId}"]`)).toBeNull();

    act(() => {
      (document.querySelector(`${rowSelector} input`) as HTMLInputElement).click();
    });

    expect(runtime.host.getPlugin(pluginId)).toBeDefined();
    expect(loadDisabledPluginIds()).toEqual(new Set());
    expect((document.querySelector(`${rowSelector} input`) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector(`[data-command-id="${commandId}"]`)).not.toBeNull();
    expect(onPluginsChanged).toHaveBeenCalledTimes(2);
  });

  it("disables the package control only where installing is unsupported, and closes explicitly, with Escape, or from the backdrop", () => {
    const runtime = createRuntime();
    const onClose = vi.fn();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(createElement(Harness, { runtime, onClose, onPluginsChanged: vi.fn() }));

    // No install actions supplied (the browser build / a non-Tauri host): honestly disabled rather than
    // offering an install that would fail on click.
    const addPackage = document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]');
    expect(addPackage?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Installing and updating plugins is only available in the ChemDraft desktop app."
    );

    act(() => {
      document.querySelector<HTMLButtonElement>('.plugin-manager-header .plugin-manager-button')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    act(() => {
      document.querySelector<HTMLElement>('[data-testid="plugin-manager-dialog"]')!.click();
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      const backdrop = document.querySelector<HTMLElement>('[data-testid="plugin-manager-backdrop"]')!;
      backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      backdrop.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not treat a text-selection drag that ends on the backdrop as a dismissal", () => {
    const runtime = createRuntime();
    const onClose = vi.fn();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(createElement(Harness, { runtime, onClose, onPluginsChanged: vi.fn() }));

    const dialog = document.querySelector<HTMLElement>('[data-testid="plugin-manager-dialog"]')!;
    const backdrop = document.querySelector<HTMLElement>('[data-testid="plugin-manager-backdrop"]')!;
    act(() => {
      dialog.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      backdrop.click();
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays closable but refuses a second operation while an install is in progress", async () => {
    const runtime = createRuntime();
    const onClose = vi.fn();
    let finishInstall: (() => void) | undefined;
    const install = vi.fn(
      () => new Promise<void>((resolve) => {
        finishInstall = resolve;
      })
    );
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(Harness, {
        runtime,
        onClose,
        onPluginsChanged: vi.fn(),
        onPickPackage: vi.fn(async () => pickedPackage()),
        onInstallPackage: install
      })
    );

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')!.click();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!.click();
    });
    expect(install).toHaveBeenCalledOnce();
    // What must be locked while an operation runs is the ability to start a *second* one.
    expect(document.querySelector<HTMLInputElement>(`[data-plugin-id="${pluginId}"] input`)?.disabled).toBe(true);
    // Closing is not one of those. A trusted-update download is allowed two minutes, and the work
    // belongs to the install machinery rather than to this dialog, so refusing to close only traps
    // the user in front of a progress line they cannot leave.
    expect(document.querySelector<HTMLButtonElement>(".plugin-manager-header .plugin-manager-button")?.disabled).toBe(
      false
    );

    // An accidental backdrop click still must not dismiss mid-operation...
    act(() => {
      const backdrop = document.querySelector<HTMLElement>('[data-testid="plugin-manager-backdrop"]')!;
      backdrop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      backdrop.click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(runtime.host.getPlugin(pluginId)).toBeDefined();

    // ...but a deliberate Escape does, and so does the Close button.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    act(() => {
      document.querySelector<HTMLButtonElement>(".plugin-manager-header .plugin-manager-button")!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishInstall?.();
      await Promise.resolve();
    });
    expect(document.querySelector<HTMLInputElement>(`[data-plugin-id="${pluginId}"] input`)?.disabled).toBe(false);
  });

  it("preserves disabled ids that are absent from the visible catalog", () => {
    const runtime = createRuntime();
    const absentPluginId = "org.chemdraft.missing.install";
    saveDisabledPluginIds(new Set([absentPluginId]));
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(createElement(Harness, { runtime, onClose: vi.fn(), onPluginsChanged: vi.fn() }));

    act(() => {
      (document.querySelector(`[data-plugin-id="${pluginId}"] input`) as HTMLInputElement).click();
    });
    expect(loadDisabledPluginIds()).toEqual(new Set([absentPluginId, pluginId]));

    act(() => {
      (document.querySelector(`[data-plugin-id="${pluginId}"] input`) as HTMLInputElement).click();
    });
    expect(loadDisabledPluginIds()).toEqual(new Set([absentPluginId]));
  });

  // Criterion 2: the UI discloses supported permissions, without adding a per-permission consent gate.
  it("displays a picked package's description and declared permissions, then installs it", async () => {
    const runtime = createRuntime();
    const onPickPackage = vi.fn(async () => pickedPackage());
    const onInstallPackage = vi.fn(async (_inspection: PluginPackageInspection) => {});
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        onPickPackage,
        onInstallPackage
      })
    );

    expect(document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')?.disabled).toBe(false);
    expect(document.querySelector('[data-testid="plugin-package-review"]')).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')!.click();
    });

    const review = document.querySelector('[data-testid="plugin-package-review"]');
    expect(review).not.toBeNull();
    expect(review?.textContent).toContain("Installed Test Plugin");
    expect(review?.textContent).toContain("v2.0.1");
    expect(document.querySelector('[data-testid="plugin-package-description"]')?.textContent).toBe(
      "A packaged plugin installed at runtime."
    );

    // Every declared permission is shown without calling a reserved capability "granted".
    const permissions = document.querySelector('[data-testid="plugin-package-permissions"]');
    expect(permissions?.querySelector('[data-permission="ui.menu"]')).not.toBeNull();
    expect(permissions?.textContent).toContain("Declared permissions:");

    // Provenance and integrity are disclosed too.
    expect(review?.textContent).toContain("checksum verified");
    expect(review?.textContent).toContain("17.01 MB unpacked");
    expect(review?.textContent).toContain("0fd3eceec674");

    // There is no allow/deny for permissions — only install or cancel.
    expect(review?.querySelector('[data-action="deny-permission"]')).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!.click();
    });

    expect(onInstallPackage).toHaveBeenCalledTimes(1);
    expect(onInstallPackage.mock.calls[0][0]).toMatchObject({ manifest: { id: installedPluginId } });
    expect(document.querySelector('[data-testid="plugin-package-review"]')).toBeNull();
  });

  it("lists every uninstalled official plugin in Available and hides installed entries there", () => {
    const runtime = createRuntime();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(OfficialCatalogHarness, {
        runtime,
        initialInstalled: true,
        prepare: vi.fn(async () => preparedOfficialInstall())
      })
    );

    const available = document.querySelector('[aria-label="Available official plugins"]');
    expect(available?.querySelector(`[data-plugin-id="${officialNmrPluginId}"]`)).toBeNull();
    expect(available?.querySelector(`[data-plugin-id="${officialOpsinPluginId}"]`)?.textContent).toContain(
      "Name to Structure (OPSIN)"
    );
    expect(available?.textContent).toContain("Type a systematic chemical name and insert its structure.");
    expect(
      available?.querySelector<HTMLButtonElement>(
        `[data-action="install-official-plugin"][data-plugin-id="${officialOpsinPluginId}"]`
      )?.textContent
    ).toBe("Install");
  });

  it("badges only the MolScribe catalog entry as Experimental, not NMR or OPSIN", () => {
    const runtime = createRuntime();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(OfficialCatalogHarness, {
        runtime,
        prepare: vi.fn(async () => preparedOfficialInstall())
      })
    );

    const available = document.querySelector('[aria-label="Available official plugins"]');
    const molscribeRow = available?.querySelector('[data-plugin-id="org.chemdraft.ocsr.molscribe"]');
    expect(molscribeRow?.querySelector('[data-testid="plugin-experimental-badge"]')).not.toBeNull();
    expect(molscribeRow?.querySelector('[data-testid="plugin-experimental-note"]')?.textContent).toContain(
      "Experimental"
    );

    const nmrRow = available?.querySelector(`[data-plugin-id="${officialNmrPluginId}"]`);
    const opsinRow = available?.querySelector(`[data-plugin-id="${officialOpsinPluginId}"]`);
    expect(nmrRow?.querySelector('[data-testid="plugin-experimental-badge"]')).toBeNull();
    expect(opsinRow?.querySelector('[data-testid="plugin-experimental-badge"]')).toBeNull();
  });

  it("downloads an official plugin, reviews it, installs it, and returns it to Available after uninstall", async () => {
    const runtime = createRuntime();
    const prepared = deferred<PreparedOfficialPluginInstall>();
    const onInstall = vi.fn(async () => {});
    const onUninstall = vi.fn(async () => {});
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(OfficialCatalogHarness, {
        runtime,
        prepare: vi.fn(() => prepared.promise),
        onInstall,
        onUninstall
      })
    );

    const installSelector =
      `[data-action="install-official-plugin"][data-plugin-id="${officialNmrPluginId}"]`;
    act(() => {
      document.querySelector<HTMLButtonElement>(installSelector)!.click();
    });
    expect(document.querySelector<HTMLButtonElement>(installSelector)?.textContent).toBe("Downloading…");

    await act(async () => {
      prepared.resolve(preparedOfficialInstall());
      await prepared.promise;
    });
    const review = document.querySelector('[data-testid="plugin-package-review"]');
    expect(review?.textContent).toContain("NMR Shift Predictor");
    expect(review?.textContent).toContain("checksum verified");
    expect(review?.querySelector('[data-permission="ui.menu"]')).not.toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!.click();
    });
    expect(onInstall).toHaveBeenCalledOnce();
    expect(
      document.querySelector(
        `[aria-label="Available official plugins"] [data-plugin-id="${officialNmrPluginId}"]`
      )
    ).toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-action="uninstall-plugin"][data-plugin-id="${officialNmrPluginId}"]`
        )!
        .click();
    });
    expect(onUninstall).toHaveBeenCalledWith(officialNmrPluginId);
    expect(document.querySelector<HTMLButtonElement>(installSelector)?.textContent).toBe("Install");
  });

  it.each([
    [officialOpsinPluginId, "No release published yet"],
    [officialNmrPluginId, "The plugin package does not match its .sha256 checksum."]
  ])("shows an official install failure on its own row for %s", async (pluginId, message) => {
    const runtime = createRuntime();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(OfficialCatalogHarness, {
        runtime,
        prepare: vi.fn(async () => {
          throw new Error(message);
        })
      })
    );

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-action="install-official-plugin"][data-plugin-id="${pluginId}"]`
        )!
        .click();
    });

    expect(document.querySelector(`[data-official-install-error="${pluginId}"]`)?.textContent).toContain(message);
    expect(document.querySelector(".plugin-manager-error")).toBeNull();
  });

  it("identifies network.fetch as unavailable and refuses to install the package", async () => {
    const runtime = createRuntime();
    const onInstallPackage = vi.fn(async (_inspection: PluginPackageInspection) => {});
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        onPickPackage: vi.fn(async () => pickedPackage(networkPluginManifest)),
        onInstallPackage
      })
    );

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')!.click();
    });

    const permission = document.querySelector('[data-permission="network.fetch"]');
    expect(permission?.className).toContain("is-dangerous");
    expect(permission?.className).toContain("is-unavailable");
    expect(permission?.textContent).toContain("unavailable in this build");
    expect(document.querySelector('[data-testid="plugin-package-unavailable"]')?.textContent).toContain(
      "Cannot install this package"
    );

    const install = document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!;
    expect(install.disabled).toBe(true);
    expect(install.textContent).toBe("Cannot install");
    install.click();
    expect(onInstallPackage).not.toHaveBeenCalled();
  });

  it("treats a cancelled picker as a no-op, not a failure", async () => {
    const runtime = createRuntime();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        onPickPackage: vi.fn(async () => undefined),
        onInstallPackage: vi.fn(async () => {})
      })
    );

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')!.click();
    });

    expect(document.querySelector('[data-testid="plugin-package-review"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("surfaces a refused install as a clear message rather than failing silently", async () => {
    const runtime = createRuntime();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        onPickPackage: vi.fn(async () => {
          throw new Error("This plugin package does not match its .sha256 checksum.");
        }),
        onInstallPackage: vi.fn(async () => {})
      })
    );

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')!.click();
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("does not match its .sha256 checksum");
  });

  // Criteria 5 and 6: an installed plugin is listed, uninstallable, and manageable exactly like a bundled one.
  it("lists an installed plugin with its permissions, uninstalls it, and keeps it re-enableable while disabled", async () => {
    const runtime = createRuntime();
    const onUninstallPlugin = vi.fn(async () => {});
    const entry = installedEntry();
    applyEnabledPlugins(runtime, new Set(), [...descriptors, { manifest: entry.manifest, options: entry.descriptor!.options }]);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins: [entry],
        onPickPackage: vi.fn(async () => undefined),
        onInstallPackage: vi.fn(async () => {}),
        onUninstallPlugin
      })
    );

    const row = document.querySelector(`[data-plugin-id="${installedPluginId}"]`);
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Installed");
    expect(row?.querySelector('[data-permission="ui.menu"]')).not.toBeNull();
    expect(document.querySelector(`[data-command-id="${installedCommandId}"]`)).not.toBeNull();

    // Disabling an installed plugin keeps it listed and re-enableable — the bundled rule, inherited.
    act(() => {
      (document.querySelector(`[data-plugin-id="${installedPluginId}"] input`) as HTMLInputElement).click();
    });
    expect(runtime.host.getPlugin(installedPluginId)).toBeUndefined();
    expect(document.querySelector(`[data-plugin-id="${installedPluginId}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-command-id="${installedCommandId}"]`)).toBeNull();

    act(() => {
      (document.querySelector(`[data-plugin-id="${installedPluginId}"] input`) as HTMLInputElement).click();
    });
    expect(runtime.host.getPlugin(installedPluginId)).toBeDefined();
    expect(document.querySelector(`[data-command-id="${installedCommandId}"]`)).not.toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(`[data-action="uninstall-plugin"][data-plugin-id="${installedPluginId}"]`)!.click();
    });
    expect(onUninstallPlugin).toHaveBeenCalledWith(installedPluginId);

    // A bundled plugin never offers Uninstall — it is not installed, it is compiled in.
    expect(document.querySelector(`[data-action="uninstall-plugin"][data-plugin-id="${pluginId}"]`)).toBeNull();
  });

  it("waits for the installed-plugin catalog before enabling package and update actions", async () => {
    const runtime = createRuntime();
    const entry = installedEntry();
    const onCheckPluginUpdates = vi.fn(async (): Promise<readonly PluginUpdateCheckResult[]> => [
      {
        status: "upToDate",
        pluginId: installedPluginId,
        installedVersion: installedManifest.version,
        latestVersion: installedManifest.version
      }
    ]);
    const renderDialog = (ready: boolean, installedPlugins: readonly InstalledPluginCatalogEntry[]) =>
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins,
        installedPluginCatalogReady: ready,
        onPickPackage: vi.fn(async () => undefined),
        onInstallPackage: vi.fn(async () => {}),
        onCheckPluginUpdates,
        onPreparePluginUpdate: vi.fn(async () => preparedUpdate()),
        onUpdatePlugin: vi.fn(async () => {})
      });

    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(renderDialog(false, []));

    expect(document.querySelector('[data-testid="plugin-manager-status"]')?.textContent).toContain(
      "Loading installed plugins"
    );
    expect(document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')?.disabled).toBe(true);
    expect(onCheckPluginUpdates).not.toHaveBeenCalled();

    act(() => {
      root!.render(renderDialog(true, [entry]));
    });
    expect(document.querySelector('[data-testid="plugin-manager-status"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]')?.disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')?.disabled).toBe(false);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
    });
    expect(onCheckPluginUpdates).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="plugin-manager-status"]')?.textContent).toContain(
      "All supported installed plugins are up to date"
    );
  });

  it("announces progress while checking and downloading an update", async () => {
    const runtime = createRuntime();
    const entry = installedEntry();
    const offer = updateOffer();
    const check = deferred<readonly PluginUpdateCheckResult[]>();
    const prepare = deferred<PreparedPluginUpdate>();
    applyEnabledPlugins(runtime, new Set(), [
      ...descriptors,
      { manifest: entry.manifest, options: entry.descriptor!.options }
    ]);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins: [entry],
        onCheckPluginUpdates: vi.fn(() => check.promise),
        onPreparePluginUpdate: vi.fn(() => prepare.promise),
        onUpdatePlugin: vi.fn(async () => {})
      })
    );

    act(() => {
      document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
    });
    expect(document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')?.textContent).toBe(
      "Checking…"
    );
    expect(document.querySelector('[data-testid="plugin-manager-status"]')?.textContent).toContain(
      "Checking installed plugins for updates"
    );

    await act(async () => {
      check.resolve([
        {
          status: "available",
          pluginId: installedPluginId,
          installedVersion: installedManifest.version,
          latestVersion: offer.version,
          offer
        }
      ]);
      await check.promise;
    });

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-action="review-plugin-update"][data-plugin-id="${installedPluginId}"]`
        )!
        .click();
    });
    expect(
      document.querySelector<HTMLButtonElement>(
        `[data-action="review-plugin-update"][data-plugin-id="${installedPluginId}"]`
      )?.textContent
    ).toBe("Downloading update…");
    expect(document.querySelector('[data-testid="plugin-manager-status"]')?.textContent).toContain(
      "Downloading and verifying the Installed Test Plugin update"
    );

    await act(async () => {
      prepare.resolve(preparedUpdate());
      await prepare.promise;
    });
    expect(document.querySelector('[data-testid="plugin-package-review"]')).not.toBeNull();
  });

  it("invalidates checked and prepared updates when the installed catalog changes", async () => {
    const runtime = createRuntime();
    const entry = installedEntry();
    const offer = updateOffer();
    const onUpdatePlugin = vi.fn(async () => {});
    const onUninstallPlugin = vi.fn(async () => {});
    const renderDialog = (installedPlugins: readonly InstalledPluginCatalogEntry[]) =>
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins,
        onUninstallPlugin,
        onCheckPluginUpdates: vi.fn(async (): Promise<readonly PluginUpdateCheckResult[]> => [
          {
            status: "available",
            pluginId: installedPluginId,
            installedVersion: installedManifest.version,
            latestVersion: offer.version,
            offer
          }
        ]),
        onPreparePluginUpdate: vi.fn(async () => preparedUpdate()),
        onUpdatePlugin
      });

    applyEnabledPlugins(runtime, new Set(), [
      ...descriptors,
      { manifest: entry.manifest, options: entry.descriptor!.options }
    ]);
    mount(renderDialog([entry]));

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-action="review-plugin-update"][data-plugin-id="${installedPluginId}"]`
        )!
        .click();
    });
    expect(document.querySelector('[data-testid="plugin-package-review"]')).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-action="uninstall-plugin"][data-plugin-id="${installedPluginId}"]`
        )!
        .click();
    });
    act(() => {
      root!.render(renderDialog([]));
    });
    expect(document.querySelector('[data-testid="plugin-package-review"]')).toBeNull();
    expect(document.querySelector('[data-action="confirm-plugin-update"]')).toBeNull();

    const reinstalled = installedEntry();
    reinstalled.record = {
      ...reinstalled.record,
      sourceChecksum: "c".repeat(64),
      installedAt: "2026-07-25T12:00:00.000Z"
    };
    act(() => {
      root!.render(renderDialog([reinstalled]));
    });
    expect(document.querySelector('[data-action="review-plugin-update"]')).toBeNull();
    expect(onUpdatePlugin).not.toHaveBeenCalled();
  });

  it("summarizes available updates and failed checks together", async () => {
    const runtime = createRuntime();
    const entry = installedEntry();
    const failedManifest: PluginManifest = {
      ...installedManifest,
      id: "org.chemdraft.test.failed-update",
      name: "Failed Update Test Plugin"
    };
    const failedEntry = installedEntry(failedManifest, false);
    const offer = updateOffer();
    applyEnabledPlugins(runtime, new Set(), [
      ...descriptors,
      { manifest: entry.manifest, options: entry.descriptor!.options }
    ]);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins: [entry, failedEntry],
        onCheckPluginUpdates: vi.fn(async (): Promise<readonly PluginUpdateCheckResult[]> => [
          {
            status: "available",
            pluginId: installedPluginId,
            installedVersion: installedManifest.version,
            latestVersion: offer.version,
            offer
          },
          {
            status: "failed",
            pluginId: failedManifest.id,
            installedVersion: failedManifest.version,
            message: "The release service is unavailable."
          }
        ]),
        onPreparePluginUpdate: vi.fn(async () => preparedUpdate()),
        onUpdatePlugin: vi.fn(async () => {})
      })
    );

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
    });
    const summary = document.querySelector('[data-testid="plugin-manager-status"]')?.textContent;
    expect(summary).toContain("1 plugin update is available");
    expect(summary).toContain("1 update check failed");
    expect(summary).toContain("See the plugin list for details");
  });

  it("checks, reviews, and explicitly applies an available plugin update", async () => {
    const runtime = createRuntime();
    const entry = installedEntry();
    const offer = updateOffer();
    const prepared = preparedUpdate();
    const onPluginsChanged = vi.fn();
    const onCheckPluginUpdates = vi.fn(async (): Promise<readonly PluginUpdateCheckResult[]> => [
      {
        status: "available",
        pluginId: installedPluginId,
        installedVersion: installedManifest.version,
        latestVersion: offer.version,
        offer
      }
    ]);
    const onPreparePluginUpdate = vi.fn(async () => prepared);
    const onUpdatePlugin = vi.fn(async () => {});
    applyEnabledPlugins(runtime, new Set(), [
      ...descriptors,
      { manifest: entry.manifest, options: entry.descriptor!.options }
    ]);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged,
        installedPlugins: [entry],
        onPickPackage: vi.fn(async () => undefined),
        onInstallPackage: vi.fn(async () => {}),
        onUninstallPlugin: vi.fn(async () => {}),
        onCheckPluginUpdates,
        onPreparePluginUpdate,
        onUpdatePlugin
      })
    );

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
    });

    const rowSelector = `[data-plugin-id="${installedPluginId}"]`;
    expect(onCheckPluginUpdates).toHaveBeenCalledOnce();
    expect(document.querySelector(rowSelector)?.textContent).toContain("Update available");
    expect(document.querySelector(rowSelector)?.textContent).toContain("Version 2.1.0 is available");
    expect(onPreparePluginUpdate).not.toHaveBeenCalled();
    expect(onUpdatePlugin).not.toHaveBeenCalled();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-action="review-plugin-update"][data-plugin-id="${installedPluginId}"]`
        )!
        .click();
    });

    const review = document.querySelector('[data-testid="plugin-package-review"]');
    expect(onPreparePluginUpdate).toHaveBeenCalledWith(offer);
    expect(review?.textContent).toContain("Updating v2.0.1 → v2.1.0");
    expect(review?.textContent).toContain("checksum verified");
    expect(review?.textContent).toContain("not a cryptographic publisher signature");
    expect(review?.querySelector('[data-permission="ui.menu"]')).not.toBeNull();
    expect(onUpdatePlugin).not.toHaveBeenCalled();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="confirm-plugin-update"]')!.click();
    });

    expect(onUpdatePlugin).toHaveBeenCalledWith(prepared);
    expect(document.querySelector('[data-testid="plugin-package-review"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Installed Test Plugin updated to version 2.1.0"
    );
    expect(onPluginsChanged).toHaveBeenCalledOnce();
  });

  it("reports up-to-date and failed checks without inventing an available update", async () => {
    const runtime = createRuntime();
    const entry = installedEntry();
    const onCheckPluginUpdates = vi
      .fn<() => Promise<readonly PluginUpdateCheckResult[]>>()
      .mockResolvedValueOnce([
        {
          status: "upToDate",
          pluginId: installedPluginId,
          installedVersion: installedManifest.version,
          latestVersion: installedManifest.version
        }
      ])
      .mockResolvedValueOnce([
        {
          status: "failed",
          pluginId: installedPluginId,
          installedVersion: installedManifest.version,
          message: "GitHub release service is unavailable."
        }
      ]);
    applyEnabledPlugins(runtime, new Set(), [
      ...descriptors,
      { manifest: entry.manifest, options: entry.descriptor!.options }
    ]);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins: [entry],
        onCheckPluginUpdates,
        onPreparePluginUpdate: vi.fn(async () => preparedUpdate()),
        onUpdatePlugin: vi.fn(async () => {})
      })
    );

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
    });
    expect(document.querySelector('[data-update-status="up-to-date"]')?.textContent).toContain("Up to date");
    expect(document.querySelector('[data-action="review-plugin-update"]')).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="check-plugin-updates"]')!.click();
    });
    expect(document.querySelector('[data-update-status="failed"]')?.textContent).toContain(
      "GitHub release service is unavailable"
    );
    expect(document.querySelector('[data-action="review-plugin-update"]')).toBeNull();
  });

  it("keeps an older install with an unavailable permission visible and uninstallable, but not enableable", async () => {
    const runtime = createRuntime();
    const onUninstallPlugin = vi.fn(async () => {});
    const entry = installedEntry(networkPluginManifest, false);
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins: [entry],
        onPickPackage: vi.fn(async () => undefined),
        onInstallPackage: vi.fn(async () => {}),
        onUninstallPlugin
      })
    );

    const rowSelector = `[data-plugin-id="${installedPluginId}"]`;
    const toggle = document.querySelector<HTMLInputElement>(`${rowSelector} input`)!;
    expect(toggle.disabled).toBe(true);
    expect(document.querySelector(rowSelector)?.textContent).toContain("Unavailable");
    expect(document.querySelector(`${rowSelector} [data-permission="network.fetch"]`)?.textContent).toContain(
      "unavailable in this build"
    );
    expect(runtime.host.getPlugin(installedPluginId)).toBeUndefined();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-action="uninstall-plugin"][data-plugin-id="${installedPluginId}"]`
        )!
        .click();
    });
    expect(onUninstallPlugin).toHaveBeenCalledWith(installedPluginId);
  });

  it("keeps the keyboard on the dialog when a row's Uninstall button becomes disabled mid-operation", async () => {
    const runtime = createRuntime();
    // Never resolves during the test: the button stays disabled and "Uninstalling…" for the assertions.
    const onUninstallPlugin = vi.fn(() => new Promise<void>(() => {}));
    const entry = installedEntry();
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins: [entry],
        onUninstallPlugin
      })
    );

    const uninstallButton = document.querySelector<HTMLButtonElement>(
      `[data-action="uninstall-plugin"][data-plugin-id="${installedPluginId}"]`
    )!;
    act(() => uninstallButton.focus());
    expect(document.activeElement).toBe(uninstallButton);

    await act(async () => {
      uninstallButton.click();
    });

    // The button itself stays in the tree but turns disabled — jsdom, like the browser, does not move
    // focus off it on its own, so without keepFocusInsideDialog the keyboard would stay stranded there.
    expect(uninstallButton.textContent).toBe("Uninstalling…");
    expect(uninstallButton.disabled).toBe(true);
    expect(document.activeElement).not.toBe(uninstallButton);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector('[data-testid="plugin-manager-dialog"]')!.contains(document.activeElement)).toBe(
      true
    );
  });
});

describe("PluginManagerDialog one-click engine install", () => {
  const molscribeId = "org.chemdraft.ocsr.molscribe";
  const molscribeManifest: PluginManifest = {
    ...installedManifest,
    id: molscribeId,
    name: "MolScribe OCSR",
    version: "0.1.0",
    description: "Recognize a drawn structure from an image."
  };
  // Disk sizes are decimal gigabytes throughout the install flow.
  const gb = 1e9;
  const notInstalled: StructureRecognitionEngineStatus = {
    state: "notInstalled",
    requiredDiskBytes: 3e9,
    freeDiskBytes: 8 * gb
  };
  const installedStatus: StructureRecognitionEngineStatus = {
    state: "installed",
    installed: {
      uvVersion: "0.12.18",
      pythonVersion: "3.10",
      molscribeCommit: "abc123",
      modelSha256: "a".repeat(64),
      installedAt: "2026-09-24T00:00:00.000Z",
      diskBytes: 2.5 * gb
    },
    requiredDiskBytes: 3e9,
    freeDiskBytes: 5 * gb
  };

  /** A native engine whose install the test drives by hand: progress events, then success or failure. */
  function fakeEngine(initial: StructureRecognitionEngineStatus = notInstalled) {
    let status = initial;
    let report: ((progress: StructureRecognitionInstallProgress) => void) | undefined;
    let finish: ((status: StructureRecognitionEngineStatus) => void) | undefined;
    let fail: ((error: unknown) => void) | undefined;
    const engine: StructureRecognitionEngine = {
      status: vi.fn(async () => status),
      install: vi.fn(
        (onProgress) =>
          new Promise<StructureRecognitionEngineStatus>((resolve, reject) => {
            report = onProgress;
            finish = resolve;
            fail = reject;
          })
      ),
      // Like Rust's `ocsr_engine_cancel_install`: it returns nothing; the install's rejection reports it.
      cancelInstall: vi.fn(async () => {
        fail?.({ code: "cancelled", message: "MolScribe installation was cancelled." });
      }),
      uninstall: vi.fn(async () => notInstalled),
      recognizeImage: vi.fn(async () => ({ status: "notInstalled" as const }))
    };
    return {
      engine,
      setStatus: (next: StructureRecognitionEngineStatus) => {
        status = next;
      },
      progress: (event: StructureRecognitionInstallProgress) => act(() => report!(event)),
      succeed: async () => {
        status = installedStatus;
        await act(async () => finish!(installedStatus));
      },
      fail: async (error: unknown) => {
        await act(async () => fail!(error));
      }
    };
  }

  function preparedMolscribe(): PreparedOfficialPluginInstall {
    return {
      pluginId: molscribeId,
      inspection: pickedPackage(molscribeManifest).inspection,
      sourcePath:
        "https://github.com/jgassens/ChemDraft-MolScribe-Plugin/releases/download/v0.1.0/molscribe-ocsr-0.1.0.zip",
      checksumVerified: true
    };
  }

  /** Wires the dialog to the runtime's real recognition controller, the way MainWindow does. */
  function WiredHarness({
    runtime,
    installed,
    onInstallPackage
  }: {
    runtime: DesktopPluginRuntime;
    installed: readonly InstalledPluginCatalogEntry[];
    onInstallPackage: (inspection: PluginPackageInspection) => Promise<void>;
  }) {
    const [, bump] = useReducer((version: number) => version + 1, 0);
    useEffect(() => runtime.recognition.subscribe(bump), [runtime]);
    return createElement(Harness, {
      runtime,
      onClose: vi.fn(),
      onPluginsChanged: vi.fn(),
      installedPlugins: installed,
      onInstallPackage,
      onPrepareOfficialPluginInstall: async () => preparedMolscribe(),
      onUninstallPlugin: async () => {},
      recognitionEngineStatus: runtime.recognition.getStatus(),
      recognitionEngineInstall: runtime.recognition.getInstallRun(),
      onRefreshRecognitionEngineStatus: async () => {
        await runtime.recognition.refreshStatus();
      },
      onInstallRecognitionEngine: () => runtime.recognition.installEngine(),
      onCancelRecognitionEngineInstall: () => runtime.recognition.cancelEngineInstall(),
      onUninstallRecognitionEngine: async () => {
        await runtime.recognition.uninstall();
      }
    });
  }

  function CatalogFlow({ runtime, onInstall }: { runtime: DesktopPluginRuntime; onInstall: () => void }) {
    const [installed, setInstalled] = useState<readonly InstalledPluginCatalogEntry[]>([]);
    return createElement(WiredHarness, {
      runtime,
      installed,
      onInstallPackage: async (inspection) => {
        onInstall();
        setInstalled([installedEntry(inspection.manifest)]);
      }
    });
  }

  function runtimeWith(engine: StructureRecognitionEngine): DesktopPluginRuntime {
    return createPluginRuntime({
      getActiveDocument: () => undefined,
      getSelection: () => ({ objectIds: [], molecules: [] }),
      structureRecognitionEngine: engine
    });
  }

  async function reviewAndConfirmMolscribe(): Promise<void> {
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(`[data-action="install-official-plugin"][data-plugin-id="${molscribeId}"]`)!
        .click();
    });
  }

  const stepText = () => document.querySelector('[data-testid="recognition-install-step"]')?.textContent;
  const engineRow = () => document.querySelector('[data-testid="molscribe-engine-row"]');

  it("shows the Experimental badge and caveat in the MolScribe install review", async () => {
    const fake = fakeEngine();
    const runtime = runtimeWith(fake.engine);
    mount(createElement(CatalogFlow, { runtime, onInstall: vi.fn() }));

    await reviewAndConfirmMolscribe();
    const review = document.querySelector('[data-testid="plugin-package-review"]');
    expect(review?.querySelector('[data-testid="plugin-experimental-badge"]')).not.toBeNull();
    expect(review?.querySelector('[data-testid="plugin-experimental-note"]')?.textContent).toContain(
      "Experimental"
    );
  });

  it("states the engine in the review, then installs the plugin and the engine from one Install", async () => {
    const fake = fakeEngine();
    const runtime = runtimeWith(fake.engine);
    const onInstall = vi.fn();
    mount(createElement(CatalogFlow, { runtime, onInstall }));

    await reviewAndConfirmMolscribe();
    const disclosure = document.querySelector('[data-testid="plugin-package-engine-disclosure"]');
    expect(disclosure?.textContent).toContain("Also installs the local recognition engine");
    expect(disclosure?.textContent).toContain("about 2.5 GB to download");
    // 3,000,000,000 bytes is 3 GB, as every other size in the flow is stated (not 2.8 "GB" of 1024³).
    expect(disclosure?.textContent).toContain("Needs 3 GB free. Free now: 8 GB.");
    expect(fake.engine.install).not.toHaveBeenCalled();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!.click();
    });
    expect(onInstall).toHaveBeenCalledOnce();
    expect(fake.engine.install).toHaveBeenCalledOnce();

    // The plugin is installed and its row carries the engine install in progress — no second click.
    expect(engineRow()).not.toBeNull();
    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: installing"
    );
    expect(document.querySelector('[data-action="install-recognition-engine"]')).toBeNull();
    expect(stepText()).toBe("Step 1 of 5: Checking free disk space");

    fake.progress({ phase: "downloadingUv", message: "m", bytesDone: 4e6, bytesTotal: 17e6 });
    expect(stepText()).toBe("Step 1 of 5: Downloading the installer");
    expect(document.querySelector('[data-testid="recognition-install-phase-text"]')?.textContent).toBe(
      "4 MB of 17 MB"
    );

    // uv sends no byte counts here; the step and the overall bar must not disappear.
    fake.progress({ phase: "installingPackages", message: "Installing pinned MolScribe dependencies." });
    expect(stepText()).toBe("Step 3 of 5: Installing PyTorch and MolScribe");
    expect(document.querySelector('[data-testid="recognition-install-overall"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="recognition-install-phase-text"]')?.textContent).toContain(
      "usually takes"
    );

    fake.progress({ phase: "installingPackages", message: "m", bytesDone: 300e6, bytesTotal: 1200e6, estimated: true });
    expect(document.querySelector('[data-testid="recognition-install-phase-text"]')?.textContent).toBe(
      "About 300 MB of 1,200 MB (estimated)"
    );

    await fake.succeed();
    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: installed (2.5 GB)"
    );
    expect(document.querySelector('[data-testid="recognition-install-progress"]')).toBeNull();
  });

  it("keeps the plugin installed and offers an Install engine button when the engine install fails", async () => {
    const fake = fakeEngine();
    const runtime = runtimeWith(fake.engine);
    mount(createElement(CatalogFlow, { runtime, onInstall: vi.fn() }));
    await reviewAndConfirmMolscribe();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!.click();
    });
    fake.progress({ phase: "downloadingModel", message: "m", bytesDone: 10e6, bytesTotal: 1134.9e6 });

    await fake.fail({ code: "network", message: "Download interrupted for https://huggingface.co/…" });

    const row = document.querySelector(`li[data-plugin-id="${molscribeId}"]`)!;
    expect(row.querySelector(".plugin-manager-badge")?.textContent).toBe("Installed");
    expect(row.querySelector('[data-action="uninstall-plugin"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="molscribe-engine-install-error"]')?.textContent).toBe(
      "The recognition engine could not be downloaded. Check your connection and try again."
    );
    const retry = row.querySelector<HTMLButtonElement>('[data-action="install-recognition-engine"]')!;
    expect(retry.className).toBe("plugin-manager-button");
    expect(retry.textContent).toBe("Install engine again");
    expect(retry.disabled).toBe(false);

    await act(async () => retry.click());
    expect(fake.engine.install).toHaveBeenCalledTimes(2);
    expect(stepText()).toBe("Step 1 of 5: Checking free disk space");
  });

  it("reports a cancelled engine install in plain words and keeps the plugin", async () => {
    const fake = fakeEngine();
    const runtime = runtimeWith(fake.engine);
    mount(createElement(CatalogFlow, { runtime, onInstall: vi.fn() }));
    await reviewAndConfirmMolscribe();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="confirm-install-package"]')!.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="cancel-recognition-engine-install"]')!.click();
    });
    expect(fake.engine.cancelInstall).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="molscribe-engine-install-error"]')?.textContent).toBe(
      "Installation was cancelled."
    );
    expect(document.querySelector('[data-action="install-recognition-engine"]')?.textContent).toBe(
      "Install engine again"
    );
  });

  it("reattaches to the running install when Add or Remove Plugins is closed and reopened", async () => {
    const fake = fakeEngine();
    const runtime = runtimeWith(fake.engine);
    const molscribeInstalled = [installedEntry(molscribeManifest)];
    const open = (): void =>
      mount(createElement(WiredHarness, { runtime, installed: molscribeInstalled, onInstallPackage: async () => {} }));

    open();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="install-recognition-engine"]')!.click();
    });
    fake.progress({ phase: "installingPackages", message: "m", bytesDone: 480e6, bytesTotal: 1200e6, estimated: true });
    // The host now reports the install in progress to anyone who asks.
    fake.setStatus({ ...notInstalled, state: "installing" });

    // Close the manager while uv is still working…
    act(() => root!.unmount());
    container!.remove();
    expect(document.querySelector('[data-testid="plugin-manager-dialog"]')).toBeNull();

    // …and open it again: the same install, still in progress, and no second Install offered.
    open();
    await act(async () => {
      await Promise.resolve();
    });
    expect(stepText()).toBe("Step 3 of 5: Installing PyTorch and MolScribe");
    expect(document.querySelector('[data-testid="recognition-install-phase-text"]')?.textContent).toBe(
      "About 480 MB of 1,200 MB (estimated)"
    );
    expect(document.querySelector('[data-action="install-recognition-engine"]')).toBeNull();
    expect(document.querySelector('[data-action="cancel-recognition-engine-install"]')).not.toBeNull();
    expect(fake.engine.install).toHaveBeenCalledOnce();

    fake.progress({ phase: "downloadingModel", message: "m", bytesDone: 500e6, bytesTotal: 1134.9e6 });
    expect(stepText()).toBe("Step 4 of 5: Downloading the recognition model");
  });

  it("keeps Cancel install available for the whole install started from the row, and cancels it", async () => {
    const fake = fakeEngine();
    const runtime = runtimeWith(fake.engine);
    mount(
      createElement(WiredHarness, {
        runtime,
        installed: [installedEntry(molscribeManifest)],
        onInstallPackage: async () => {}
      })
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="install-recognition-engine"]')!.click();
    });
    // The install's promise is still pending (it settles only when the whole install ends)…
    fake.progress({ phase: "installingPackages", message: "m", bytesDone: 100e6, bytesTotal: 1200e6, estimated: true });
    const cancel = document.querySelector<HTMLButtonElement>('[data-action="cancel-recognition-engine-install"]')!;
    // …and Cancel install is usable throughout.
    expect(cancel.disabled).toBe(false);

    await act(async () => cancel.click());
    expect(fake.engine.cancelInstall).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="molscribe-engine-install-error"]')?.textContent).toBe(
      "Installation was cancelled."
    );
    const retry = document.querySelector<HTMLButtonElement>('[data-action="install-recognition-engine"]')!;
    expect(retry.textContent).toBe("Install engine again");
    expect(retry.disabled).toBe(false);

    // Starting again from "Install engine again" leaves Cancel install enabled too.
    await act(async () => retry.click());
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="cancel-recognition-engine-install"]')?.disabled
    ).toBe(false);
  });

  it("keeps the keyboard on the dialog when Install engine unmounts and Cancel install takes its place", async () => {
    const fake = fakeEngine();
    const runtime = runtimeWith(fake.engine);
    mount(
      createElement(WiredHarness, {
        runtime,
        installed: [installedEntry(molscribeManifest)],
        onInstallPackage: async () => {}
      })
    );
    await act(async () => {
      await Promise.resolve();
    });

    const install = document.querySelector<HTMLButtonElement>('[data-action="install-recognition-engine"]')!;
    act(() => install.focus());
    expect(document.activeElement).toBe(install);

    await act(async () => {
      install.click();
    });
    fake.progress({ phase: "installingPackages", message: "m", bytesDone: 100e6, bytesTotal: 1200e6, estimated: true });

    // The row swaps from an Install engine button to a distinct Cancel install button: the focused
    // element is unmounted, not merely disabled.
    expect(install.isConnected).toBe(false);
    expect(document.querySelector('[data-action="cancel-recognition-engine-install"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector('[data-testid="plugin-manager-dialog"]')!.contains(document.activeElement)).toBe(
      true
    );
  });

  it("renders a null engine status as still checking instead of crashing", async () => {
    const runtime = createRuntime();
    // What the old cancelInstall contract stored: Tauri's null for Rust's `()`.
    const nullStatus = null as unknown as StructureRecognitionEngineStatus;
    mount(
      createElement(Harness, {
        runtime,
        onClose: vi.fn(),
        onPluginsChanged: vi.fn(),
        installedPlugins: [installedEntry(molscribeManifest)],
        recognitionEngineStatus: nullStatus,
        onInstallRecognitionEngine: vi.fn(async () => true),
        onUninstallRecognitionEngine: vi.fn(async () => undefined)
      })
    );
    expect(document.querySelector('[data-testid="molscribe-engine-state"]')?.textContent).toBe(
      "Recognition engine: checking…"
    );
    expect(document.querySelector('[data-action="install-recognition-engine"]')).toBeNull();
  });
});
