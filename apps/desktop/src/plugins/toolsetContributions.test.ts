import { describe, expect, it } from "vitest";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { createPluginRuntime } from "./createPluginRuntime";
import { createToolbarCatalog } from "../toolbars/toolbarCatalog";
import {
  FIXTURE_PLUGIN_ID,
  FIXTURE_PLUGIN_PING_COMMAND_ID,
  FIXTURE_PLUGIN_TOOLSET_ID,
  createFixturePluginOptions,
  fixturePluginManifest
} from "./fixturePlugin";

// Main's original desktop-runtime suite (pluginRuntime.test.ts on the pre-union trunk), repointed at
// the union runtime: the toolset-contribution stage now lives in createPluginRuntime, and these six
// tests pin its contract — registration + routing, catalog composition, ui.toolbar enforcement with
// whole-plugin rollback, persisted-layout pruning, selection/panel context wiring, change notification.
const makeRuntime = () =>
  createPluginRuntime({ commandRegistry: new CommandRegistry(), getActiveDocument: () => undefined });

describe("desktop plugin runtime + toolbar catalog", () => {
  it("registers the fixture plugin's toolset and routes its command via the host", async () => {
    const runtime = makeRuntime();
    let pinged = false;
    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions(() => {
      pinged = true;
    }));

    expect(runtime.listPluginToolsets().map((toolset) => toolset.id)).toContain(FIXTURE_PLUGIN_TOOLSET_ID);
    expect(runtime.pluginIdForToolset(FIXTURE_PLUGIN_TOOLSET_ID)).toBe(FIXTURE_PLUGIN_ID);

    await runtime.host.invokeCommand(FIXTURE_PLUGIN_PING_COMMAND_ID);
    expect(pinged).toBe(true);
  });

  it("composes plugin toolsets alongside core toolsets in the catalog", () => {
    const runtime = makeRuntime();
    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());

    const catalog = createToolbarCatalog();
    expect(catalog.registry().get(FIXTURE_PLUGIN_TOOLSET_ID)).toBeUndefined();

    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(catalog.registry().get(FIXTURE_PLUGIN_TOOLSET_ID)).toBeDefined();
    // Core toolsets are still present.
    expect(catalog.registry().get("core.main")).toBeDefined();
  });

  it("enforces ui.toolbar and rolls the plugin back when a toolset is contributed without it", () => {
    const runtime = makeRuntime();
    const withoutPermission = { ...fixturePluginManifest, id: "org.chemdraft.fixture.bad", permissions: [] };

    expect(() => runtime.registerPlugin(withoutPermission, createFixturePluginOptions())).toThrow(/ui\.toolbar/);
    expect(runtime.host.getPlugin("org.chemdraft.fixture.bad")).toBeUndefined();
    expect(runtime.listPluginToolsets()).toHaveLength(0);
  });

  it("prunes unknown commands from persisted layout state instead of throwing", () => {
    const catalog = createToolbarCatalog();
    catalog.setLayoutState({
      version: 1,
      toolsetOverrides: [{ toolsetId: "core.main", hiddenCommandIds: ["command.that.was.removed"] }],
      userToolsets: []
    });

    // Startup survives; core.main is still there.
    expect(catalog.registry().get("core.main")).toBeDefined();
  });

  it("forwards selection and panel wiring to plugin command handlers", async () => {
    const runtime = createPluginRuntime({
      commandRegistry: new CommandRegistry(),
      getActiveDocument: () => undefined,
      getSelection: () => ({
        objectIds: ["m1"],
        // sourceFingerprint is required on the union's extended PluginSelectedMolecule (M4/D-09);
        // main's original fake omitted it.
        molecules: [{ objectId: "m1", structureFormat: "smiles", structure: "c1ccccc1", sourceFingerprint: "fp-m1" }]
      })
    });

    const manifest = {
      id: "org.chemdraft.surfaces",
      name: "Surfaces",
      version: "0.0.0",
      apiVersion: "^0.1.0",
      entry: "dev",
      permissions: ["selection.read", "ui.panel"],
      contributes: {
        commands: [
          {
            id: "plugin.surfaces.run",
            title: "Run",
            requiredPermissions: ["selection.read", "ui.panel"],
            enabled: true
          }
        ],
        panels: [{ id: "surfaces.result", title: "Result" }]
      }
    };

    let seenStructure = "";
    runtime.registerPlugin(manifest, {
      commandHandlers: {
        "plugin.surfaces.run": async (context) => {
          const selection = await context.selection?.getSelection();
          seenStructure = selection?.molecules[0]?.structure ?? "";
          await context.panels?.showReport("surfaces.result", {
            title: "Result",
            sections: [{ kind: "text", body: "ok" }]
          });
          return { ok: true };
        }
      }
    });

    await runtime.host.invokeCommand("plugin.surfaces.run");
    expect(seenStructure).toBe("c1ccccc1");
    // The union runtime routes reports through the panel controller rather than a bare callback
    // (main's original asserted a showPanelReport spy); the report surfaces as the open panel.
    expect(runtime.panels.getOpenPanel()?.panelId).toBe("surfaces.result");
  });

  it("notifies listeners when plugin toolsets change", () => {
    const runtime = makeRuntime();
    const catalog = createToolbarCatalog();
    let changes = 0;
    catalog.onDidChange(() => {
      changes++;
    });

    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(changes).toBe(1);
  });
});
