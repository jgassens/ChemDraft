// @vitest-environment jsdom

import type { PluginManifest } from "@chemdraft/plugin-api";
import { act, createElement, Fragment, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";
import type { InstalledPluginCatalogEntry, PluginPackageInspection } from "./installPluginPackage";
import type { PickedPluginPackage } from "./pickPluginPackage";
import { buildPluginMenuItems } from "./pluginMenuModel";
import { PluginManagerDialog } from "./PluginManagerDialog";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";
import type {
  PluginUpdateCheckResult,
  PluginUpdateOffer,
  PreparedPluginUpdate
} from "./pluginUpdates";
import { createPluginRuntime, type DesktopPluginRuntime } from "./createPluginRuntime";
import { applyEnabledPlugins, type BundledPluginDescriptor } from "./registerBundledPlugins";

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
  installedPlugins?: readonly InstalledPluginCatalogEntry[];
  installedPluginCatalogReady?: boolean;
  onPickPackage?: () => Promise<PickedPluginPackage | undefined>;
  onInstallPackage?: (inspection: PluginPackageInspection) => Promise<void>;
  onUninstallPlugin?: (pluginId: string) => Promise<void>;
  onCheckPluginUpdates?: () => Promise<readonly PluginUpdateCheckResult[]>;
  onPreparePluginUpdate?: (offer: PluginUpdateOffer) => Promise<PreparedPluginUpdate>;
  onUpdatePlugin?: (prepared: PreparedPluginUpdate) => Promise<void>;
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

describe("PluginManagerDialog", () => {
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
});
