import {
  molscribeOcsrCommandId,
  molscribeOcsrManifest,
  molscribeOcsrPanelId
} from "@chemdraft/molscribe-ocsr-plugin";
import type { PluginSelectionSnapshot } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import { createPluginRuntime, type DesktopPluginRuntimeOptions } from "./createPluginRuntime";
import { buildPluginMenuItems, PLUGIN_DIAGNOSTICS_COMMAND_ID } from "./pluginMenuModel";
import { registerBundledPlugins } from "./registerBundledPlugins";

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
    registerBundledPlugins(runtime);
    expect(runtime.host.listPlugins().map((manifest) => manifest.id)).toContain(molscribeOcsrManifest.id);
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
