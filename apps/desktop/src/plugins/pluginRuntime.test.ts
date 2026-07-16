import {
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId
} from "@chemdraft/molscribe-ocsr-plugin";
import { nmrPredictCarbonCommandId, nmrPredictorManifest } from "@chemdraft/plugin-nmr-predictor";
import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
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
  it("registers molscribe-ocsr as a bundled plugin", () => {
    const runtime = makeRuntime();
    const descriptors = registerBundledPlugins(runtime);
    expect(runtime.host.listPlugins().map((manifest) => manifest.id)).toContain(molscribeOcsrManifest.id);
    expect(descriptors.map((descriptor) => descriptor.manifest.id)).toEqual([
      "org.chemdraft.ocsr.molscribe",
      "org.chemdraft.nmr.predictor",
      "org.chemdraft.mass.fragment"
    ]);
  });

  it("skips persisted disabled plugins during startup", () => {
    const runtime = makeRuntime();
    registerBundledPlugins(runtime, new Set([nmrPredictorManifest.id]));

    expect(runtime.host.getPlugin(nmrPredictorManifest.id)).toBeUndefined();
    expect(runtime.host.commands.has(nmrPredictCarbonCommandId)).toBe(false);
    expect(runtime.host.listPlugins()).toHaveLength(2);
  });

  it("applies enabled plugins idempotently and updates command and menu contributions live", () => {
    const runtime = makeRuntime();
    const descriptors = createBundledPluginDescriptors();
    const changes = vi.fn();
    runtime.host.subscribe(changes);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.listPlugins()).toHaveLength(3);
    expect(changes).toHaveBeenCalledTimes(3);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.listPlugins()).toHaveLength(3);
    expect(changes).toHaveBeenCalledTimes(3);

    applyEnabledPlugins(runtime, new Set([nmrPredictorManifest.id]), descriptors);
    expect(runtime.host.getPlugin(nmrPredictorManifest.id)).toBeUndefined();
    expect(runtime.host.commands.has(nmrPredictCarbonCommandId)).toBe(false);
    expect(runtime.host.listMenuContributions().some((entry) => entry.pluginId === nmrPredictorManifest.id)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(4);

    applyEnabledPlugins(runtime, new Set(), descriptors);
    expect(runtime.host.getPlugin(nmrPredictorManifest.id)?.manifest.id).toBe(nmrPredictorManifest.id);
    expect(runtime.host.commands.has(nmrPredictCarbonCommandId)).toBe(true);
    expect(runtime.host.listMenuContributions().some((entry) => entry.pluginId === nmrPredictorManifest.id)).toBe(true);
    expect(changes).toHaveBeenCalledTimes(5);
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

  it("builds Analyze menu items for registered contributions plus the diagnostics opener", () => {
    const runtime = makeRuntime();
    registerBundledPlugins(runtime);

    const items = buildPluginMenuItems(runtime.host.listMenuContributions());
    const commandIds = items.map((item) => item.command.commandId);

    expect(commandIds).toContain(molscribeOcsrCommandId);
    expect(commandIds).toContain(PLUGIN_DIAGNOSTICS_COMMAND_ID);
    expect(items.every((item) => item.command.pluginContributed === true)).toBe(true);
    expect(items.find((item) => item.command.commandId === molscribeOcsrCommandId)?.location).toBe("analyze");
  });
});
