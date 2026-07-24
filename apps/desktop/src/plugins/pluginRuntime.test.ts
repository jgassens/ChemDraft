import {
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId
} from "@chemdraft/molscribe-ocsr-plugin";
import { massAnalyzeCommandId, massFragmentManifest } from "@chemdraft/plugin-mass-fragment";
import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";

import { createPluginRuntime, type DesktopPluginRuntimeOptions } from "./createPluginRuntime";
import { buildPluginMenuItems, PLUGIN_DIAGNOSTICS_COMMAND_ID } from "./pluginMenuModel";
import {
  applyEnabledPlugins,
  createBundledPluginDescriptors,
  registerBundledPlugins
} from "./registerBundledPlugins";

const emptySelection: PluginSelectionSnapshot = { objectIds: [], molecules: [] };

function makeRuntime(overrides: Partial<DesktopPluginRuntimeOptions> = {}) {
  return createPluginRuntime({
    getActiveDocument: () => undefined,
    getSelection: () => emptySelection,
    now: () => "2026-07-07T00:00:00.000Z",
    ...overrides
  });
}

describe("desktop plugin runtime", () => {
  it("rejects reserved desktop permissions before registration, so hasPermission never reports a false grant", () => {
    const runtime = makeRuntime();
    const candidate = {
      id: "org.test.network",
      name: "Network Test",
      version: "0.0.1",
      apiVersion: "^0.1.0",
      entry: "dist/plugin.js",
      permissions: ["network.fetch"]
    };

    expect(() => runtime.registerPlugin(candidate)).toThrow(/network\.fetch.*unavailable/i);
    expect(runtime.host.getPlugin(candidate.id)).toBeUndefined();
    expect(runtime.host.hasPermission(candidate.id, "network.fetch")).toBe(false);
  });

  it("registers molscribe-ocsr as a bundled plugin", () => {
    const runtime = makeRuntime();
    const descriptors = registerBundledPlugins(runtime);
    expect(runtime.host.listPlugins().map((manifest) => manifest.id)).toContain(molscribeOcsrManifest.id);
    expect(descriptors.map((descriptor) => descriptor.manifest.id)).toEqual([
      "org.chemdraft.ocsr.molscribe",
      "org.chemdraft.mass.fragment"
    ]);
  });

  it("skips persisted disabled plugins during startup", () => {
    const runtime = makeRuntime();
    registerBundledPlugins(runtime, new Set([massFragmentManifest.id]));

    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeUndefined();
    expect(runtime.host.commands.has(massAnalyzeCommandId)).toBe(false);
    expect(runtime.host.listPlugins()).toHaveLength(1);
  });

  it("applies enabled plugins idempotently and updates command and menu contributions live", () => {
    const runtime = makeRuntime();
    const descriptors = createBundledPluginDescriptors();
    const changes = vi.fn();
    runtime.host.subscribe(changes);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.listPlugins()).toHaveLength(2);
    expect(changes).toHaveBeenCalledTimes(2);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.listPlugins()).toHaveLength(2);
    expect(changes).toHaveBeenCalledTimes(2);

    applyEnabledPlugins(runtime, new Set([massFragmentManifest.id]), descriptors);
    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeUndefined();
    expect(runtime.host.commands.has(massAnalyzeCommandId)).toBe(false);
    expect(runtime.host.listMenuContributions().some((entry) => entry.pluginId === massFragmentManifest.id)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(3);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.getPlugin(massFragmentManifest.id)?.manifest.id).toBe(massFragmentManifest.id);
    expect(runtime.host.commands.has(massAnalyzeCommandId)).toBe(true);
    expect(runtime.host.listMenuContributions().some((entry) => entry.pluginId === massFragmentManifest.id)).toBe(true);
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it("totally tears down a disabled worker plugin and creates a fresh bridge when re-enabled", () => {
    const runtime = makeRuntime();
    const descriptors = createBundledPluginDescriptors({
      pluginWorkerFactories: new Map([[massFragmentManifest.id, () => ({}) as never]])
    });
    const mass = descriptors.find((descriptor) => descriptor.manifest.id === massFragmentManifest.id)!;
    const firstBridge = mass.bridge!;
    const terminate = vi.spyOn(firstBridge, "terminate");

    applyEnabledPlugins(runtime, new Set(), descriptors);
    applyEnabledPlugins(runtime, new Set([massFragmentManifest.id]), descriptors);

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeUndefined();

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(mass.bridge).toBeDefined();
    expect(mass.bridge).not.toBe(firstBridge);
    expect(runtime.host.getPlugin(massFragmentManifest.id)).toBeDefined();
  });

  it("closes a plugin-owned panel before unregistering its close hook", async () => {
    const runtime = makeRuntime();
    const descriptors = registerBundledPlugins(runtime);
    const notifyPanelClosed = vi.spyOn(runtime.host, "notifyPanelClosed");

    await runtime.host.invokeCommand(molscribeOcsrCommandId);
    expect(runtime.panels.getOpenPanel()?.pluginId).toBe(molscribeOcsrManifest.id);

    applyEnabledPlugins(runtime, new Set([molscribeOcsrManifest.id]), descriptors);

    expect(notifyPanelClosed).toHaveBeenCalledWith(molscribeOcsrManifest.id, molscribeOcsrPanelId);
    expect(runtime.panels.getOpenPanel()).toBeUndefined();
    expect(runtime.host.getPlugin(molscribeOcsrManifest.id)).toBeUndefined();
  });

  it("runs the canary command through the host and renders its report to the panel controller", async () => {
    const runtime = makeRuntime();
    registerBundledPlugins(runtime);

    expect(runtime.panels.getOpenPanel()).toBeUndefined();

    await runtime.host.invokeCommand(molscribeOcsrCommandId);

    const open = runtime.panels.getOpenPanel();
    expect(open?.panelId).toBe(molscribeOcsrPanelId);
    expect(open?.title).toBe("MolScribe OCSR Review");
    expect(open?.commandId).toBe(molscribeOcsrCommandId);
    expect(open?.report.title).toContain("MolScribe");

    runtime.panels.closePanel();
    expect(runtime.panels.getOpenPanel()).toBeUndefined();
  });

  it("reads selection from the provider on demand, so the persistent host sees live state", async () => {
    let selection: PluginSelectionSnapshot = { objectIds: [], molecules: [] };
    const runtime = makeRuntime({ getSelection: () => selection });

    runtime.host.registerPlugin(
      {
        id: "org.test.selreader",
        name: "Selection Reader",
        version: "0.0.1",
        apiVersion: "^0.1.0",
        entry: "dist/plugin.js",
        permissions: ["selection.read"],
        contributes: {
          commands: [{ id: "plugin.selReader.read", title: "Read", requiredPermissions: ["selection.read"] }]
        }
      },
      {
        commandHandlers: {
          "plugin.selReader.read": async (context) => context.selection?.getSelection()
        }
      }
    );

    await expect(runtime.host.invokeCommand("plugin.selReader.read")).resolves.toMatchObject({ objectIds: [] });

    selection = {
      objectIds: ["m1"],
      molecules: [{ objectId: "m1", structureFormat: "smiles", structure: "c1ccccc1", sourceFingerprint: "fp-m1" }]
    };

    await expect(runtime.host.invokeCommand("plugin.selReader.read")).resolves.toMatchObject({
      objectIds: ["m1"]
    });
  });

  it("records a controlled diagnostic instead of crashing when a report targets an unknown panel", () => {
    const runtime = makeRuntime();
    registerBundledPlugins(runtime);

    runtime.panels.showReport(molscribeOcsrManifest.id, "panel.does.not.exist", { title: "X", sections: [] });

    expect(runtime.panels.getOpenPanel()).toBeUndefined();
    expect(runtime.panels.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain("panel-unknown");
  });

  it("shares an injected CommandRegistry with core commands and keeps plugin ownership distinguishable", async () => {
    // The union runtime registers plugin commands into the SAME registry MainWindow's core commands
    // live in (commands/coreCommandRegistrar). Presence in the registry therefore no longer implies
    // "plugin command" — ownership is the pluginId stamped on the definition (study R3).
    const shared = new CommandRegistry();
    let coreRan = 0;
    shared.register({ id: "core.probe", title: "Probe", source: "core" }, () => {
      coreRan += 1;
      return undefined;
    });

    const runtime = makeRuntime({ commandRegistry: shared });
    registerBundledPlugins(runtime);

    // One registry serves both worlds.
    expect(runtime.host.commands).toBe(shared);
    expect(runtime.host.commands.has("core.probe")).toBe(true);
    expect(runtime.host.commands.has(molscribeOcsrCommandId)).toBe(true);

    // Ownership: core commands carry no pluginId; plugin commands carry their manifest id.
    expect(runtime.host.commands.get("core.probe")?.pluginId).toBeUndefined();
    expect(runtime.host.commands.get(molscribeOcsrCommandId)?.pluginId).toBe(molscribeOcsrManifest.id);

    // Single dispatch handles both: plain for core, permission context for plugin-owned.
    await runtime.host.invokeCommand("core.probe");
    expect(coreRan).toBe(1);
    await runtime.host.invokeCommand(molscribeOcsrCommandId);
    expect(runtime.panels.getOpenPanel()?.panelId).toBe(molscribeOcsrPanelId);

    // Unregistering a plugin removes only its own commands from the shared registry.
    runtime.unregisterPlugin(molscribeOcsrManifest.id);
    expect(runtime.host.commands.has(molscribeOcsrCommandId)).toBe(false);
    expect(runtime.host.commands.has("core.probe")).toBe(true);
  });

  it("builds Analyze menu items for registered contributions plus the diagnostics opener", () => {
    const runtime = makeRuntime();
    registerBundledPlugins(runtime);

    const items = buildPluginMenuItems(runtime.host.listMenuContributions());
    const commandIds = items.map((item) => item.command.commandId);

    expect(commandIds).toContain(molscribeOcsrCommandId);
    expect(commandIds).toContain(massAnalyzeCommandId);
    expect(commandIds).toContain(PLUGIN_DIAGNOSTICS_COMMAND_ID);
    expect(items.every((item) => item.command.pluginContributed === true)).toBe(true);
    expect(items.find((item) => item.command.commandId === molscribeOcsrCommandId)?.location).toBe("analyze");

    // Core-only build (M39): no bundled contribution may put an NMR item in any menu — NMR features
    // can arrive only through the installer.
    expect(items.some((item) => /nmr/i.test(item.command.commandId) || /nmr/i.test(item.command.label))).toBe(false);
  });
});
