// @vitest-environment jsdom

import type { PluginManifest } from "@chemdraft/plugin-api";
import { act, createElement, Fragment, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";
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

function Harness({ runtime, onClose, onPluginsChanged }: {
  runtime: DesktopPluginRuntime;
  onClose: () => void;
  onPluginsChanged: () => void;
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
      onPluginsChanged
    })
  );
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

  it("shows the deferred package control and closes explicitly, with Escape, or from the backdrop", () => {
    const runtime = createRuntime();
    const onClose = vi.fn();
    applyEnabledPlugins(runtime, new Set(), descriptors);
    mount(createElement(Harness, { runtime, onClose, onPluginsChanged: vi.fn() }));

    const addPackage = document.querySelector<HTMLButtonElement>('[data-action="add-plugin-package"]');
    expect(addPackage?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Installing plugins from a package arrives with the plugin-packaging milestone."
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
});
