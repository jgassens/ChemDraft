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
import { loadDisabledPluginIds } from "./pluginPreferences";
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
  onPickPackage?: () => Promise<PickedPluginPackage | undefined>;
  onInstallPackage?: (inspection: PluginPackageInspection) => Promise<void>;
  onUninstallPlugin?: (pluginId: string) => Promise<void>;
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
  permissions: ["ui.menu", "network.fetch"],
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

/** A catalog entry shaped like a real install, with a descriptor carrying real command handlers. */
function installedEntry(): InstalledPluginCatalogEntry {
  return {
    record: {
      id: installedPluginId,
      version: "2.0.1",
      name: "Installed Test Plugin",
      stagedPath: `installed-plugins/${installedPluginId}`,
      sourceChecksum: "a".repeat(64),
      installedAt: "2026-07-16T00:00:00.000Z"
    },
    manifest: installedManifest,
    descriptor: {
      manifest: installedManifest,
      options: { commandHandlers: { [installedCommandId]: async () => ({ ok: true }) } },
      bridge: { terminate: () => {} } as never,
      entryUrl: new URL(`tauri://localhost/installed-plugins/${installedPluginId}/entry.js`),
      provenance: {
        sdk: "@chemdraft/plugin-api",
        sdkVersion: "0.1.0",
        sourceCommit: "0fd3eceec674f207fe2651fe7a19f6438a55fb17",
        sourceTree: "clean",
        licenseFile: "LICENSE",
        packagedAt: "2026-07-16T14:07:19.768Z"
      }
    } as never
  };
}

function pickedPackage(): PickedPluginPackage {
  return {
    sourcePath: "/Users/someone/Downloads/nmr-predictor-0.0.0.zip",
    checksumVerified: true,
    inspection: {
      manifest: installedManifest,
      provenance: installedEntry().descriptor!.provenance,
      sourceChecksum: "b".repeat(64),
      entries: [],
      unpackedBytes: 17_834_630
    }
  };
}

function mount(element: ReturnType<typeof createElement>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
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
    expect(document.body.textContent).toContain(
      "Installing plugins from a package is only available in the ChemDraft desktop app."
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
      document.querySelector<HTMLElement>('[data-testid="plugin-manager-backdrop"]')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Criterion 2: the UI displays what the package declares, and nothing gates the install on it.
  it("displays a picked package's description and declared permissions, then installs with no consent gate", async () => {
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

    // Every declared permission is shown; the dangerous one is marked but still simply granted.
    const permissions = document.querySelector('[data-testid="plugin-package-permissions"]');
    expect(permissions?.querySelector('[data-permission="ui.menu"]')).not.toBeNull();
    expect(permissions?.querySelector('[data-permission="network.fetch"]')?.className).toContain("is-dangerous");
    expect(permissions?.textContent).toContain("Granted permissions:");

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
    expect(row?.querySelector('[data-permission="network.fetch"]')).not.toBeNull();
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
});
