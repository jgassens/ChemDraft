import { afterEach, describe, expect, it } from "vitest";
import type { PluginToolbarGroupId } from "@chemdraft/plugin-api";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { parseToolsetLayoutState } from "@chemdraft/toolset-registry";
import { createPluginRuntime } from "./createPluginRuntime";
import { createToolbarCatalog } from "../toolbars/toolbarCatalog";
import { createDesktopToolsetRegistry } from "../toolsets";
import { buildMainToolbarCustomizeGroups } from "../toolbars/CustomizeMainToolbar/groupModel";
import { buildMainToolbarGallerySections } from "../toolbars/CustomizeMainToolbar/galleryModel";
import { applyToolsetLayoutEdit } from "../toolbars/CustomizeMainToolbar/applyLayoutEdit";
import { foldMainToolbar } from "../toolbars/toolbarFit";
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
        panels: [{ id: "panel.surfaces.result", title: "Result" }]
      }
    };

    let seenStructure = "";
    runtime.registerPlugin(manifest, {
      commandHandlers: {
        "plugin.surfaces.run": async (context) => {
          const selection = await context.selection?.getSelection();
          seenStructure = selection?.molecules[0]?.structure ?? "";
          await context.panels?.showReport("panel.surfaces.result", {
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
    expect(runtime.panels.getOpenPanel()?.panelId).toBe("panel.surfaces.result");
  });

  it("restores the previous registration when a same-id replacement fails", async () => {
    const runtime = makeRuntime();
    let originalRuns = 0;
    runtime.registerPlugin(
      fixturePluginManifest,
      createFixturePluginOptions(() => {
        originalRuns += 1;
      })
    );
    const invalidReplacement = { ...fixturePluginManifest, permissions: [] };

    expect(() => runtime.replacePlugin(FIXTURE_PLUGIN_ID, invalidReplacement, createFixturePluginOptions())).toThrow(
      /ui\.toolbar/
    );

    expect(runtime.host.getPlugin(FIXTURE_PLUGIN_ID)).toBeDefined();
    expect(runtime.listPluginToolsets().map((toolset) => toolset.id)).toContain(FIXTURE_PLUGIN_TOOLSET_ID);
    await runtime.host.invokeCommand(FIXTURE_PLUGIN_PING_COMMAND_ID);
    expect(originalRuns).toBe(1);
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

describe("plugin buttons in Main's home groups", () => {
  const commandId = "plugin.toolbarHome.run";
  const manifest = (toolbarGroup?: PluginToolbarGroupId) => ({
    id: "org.chemdraft.toolbarHome", name: "Toolbar Home", version: "1.0.0", apiVersion: "^0.1.20", entry: "test",
    permissions: ["ui.toolbar"],
    contributes: {
      commands: [{ id: commandId, title: "Run home tool" }],
      toolbarButtons: [{ id: "toolbar.home.run", commandId, toolbarGroup }]
    }
  });
  const idsInGroup = (catalog: ReturnType<typeof createToolbarCatalog>, groupId: string) =>
    catalog.registry().require("core.main").groups.find(group => group.id === groupId)?.items.map(item => item.commandId) ?? [];
  afterEach(() => { createToolbarCatalog(); }); // Clear this webview's live home metadata.

  it("appends declared buttons to their home, shares detached composition, and creates no extra toolbar", async () => {
    const runtime = makeRuntime();
    let runs = 0;
    runtime.registerPlugin(manifest("arrows"), { commandHandlers: { [commandId]: () => { runs++; } } });
    const catalog = createToolbarCatalog();
    const coreIds = idsInGroup(catalog, "arrows");
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(idsInGroup(catalog, "arrows")).toEqual([...coreIds, commandId]);
    expect(catalog.registry().listToolsets().filter(toolset => toolset.source === "plugin")).toEqual([]);
    expect(catalog.registry().require("core.main").groups.flatMap(group => group.items)
      .filter(item => item.commandId === commandId)).toHaveLength(1);
    expect(runtime.pluginIdForToolset("core.main")).toBeUndefined();
    const detached = createDesktopToolsetRegistry(undefined, undefined, runtime.listPluginToolsets());
    expect(detached.require("core.main")).toEqual(catalog.registry().require("core.main"));
    await runtime.host.invokeCommand(commandId);
    expect(runs).toBe(1);
  });

  it("places legacy buttons in conditional Undeclared, which folds together with Orbitals", () => {
    const runtime = makeRuntime();
    const catalog = createToolbarCatalog();
    expect(catalog.registry().require("core.main").groups.some(group => group.id === "undeclared")).toBe(false);
    runtime.registerPlugin(manifest());
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(idsInGroup(catalog, "undeclared")).toEqual([commandId]);
    const group = catalog.registry().require("core.main").groups.find(group => group.id === "undeclared")!;
    expect(group).toMatchObject({ label: "Undeclared", foldRank: 1 });
    expect(foldMainToolbar(["orbitals", "undeclared", "arrows"].map(id => ({ id, length: 100, prefixes: [100], foldedLength: 20 })),
      200, 0)).toEqual(new Set(["orbitals", "undeclared"]));
    catalog.setLayoutState({ version: 1, userToolsets: [], toolsetOverrides: [{ toolsetId: "core.main", hiddenCommandIds: [commandId] }] });
    expect(catalog.registry().require("core.main").groups.some(group => group.id === "undeclared")).toBe(false);
  });

  it("removes buttons and an emptied Undeclared on runtime unregister, retaining explicit palettes", () => {
    const runtime = makeRuntime();
    runtime.registerPlugin(fixturePluginManifest, createFixturePluginOptions());
    const catalog = createToolbarCatalog();
    runtime.onDidChange(() => catalog.setPluginToolsets(runtime.listPluginToolsets()));
    runtime.registerPlugin(manifest());
    expect(idsInGroup(catalog, "undeclared")).toEqual([commandId]);
    runtime.unregisterPlugin(manifest().id);
    expect(runtime.host.commands.has(commandId)).toBe(false);
    expect(catalog.registry().require("core.main").groups.some(group => group.id === "undeclared")).toBe(false);
    expect(catalog.registry().get(FIXTURE_PLUGIN_TOOLSET_ID)).toBeDefined();
    runtime.unregisterPlugin(FIXTURE_PLUGIN_ID);
    expect(catalog.registry().get(FIXTURE_PLUGIN_TOOLSET_ID)).toBeUndefined();
  });

  it("supports multiple plugins and deduplicates repeated command buttons", () => {
    const runtime = makeRuntime();
    const first = manifest("arrange");
    runtime.registerPlugin({ ...first, contributes: { ...first.contributes,
      toolbarButtons: [...first.contributes.toolbarButtons, { ...first.contributes.toolbarButtons[0], id: "toolbar.home.duplicate" }] } });
    runtime.registerPlugin({ ...manifest(), id: "org.chemdraft.second", contributes: {
      commands: [{ id: "plugin.second.run", title: "Second" }],
      toolbarButtons: [{ id: "toolbar.second.run", commandId: "plugin.second.run", toolbarGroup: "arrange" }]
    } });
    const catalog = createToolbarCatalog();
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(idsInGroup(catalog, "arrange").slice(-2)).toEqual([commandId, "plugin.second.run"]);
    runtime.unregisterPlugin(first.id);
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(idsInGroup(catalog, "arrange")).not.toContain(commandId);
    expect(idsInGroup(catalog, "arrange")).toContain("plugin.second.run");
  });

  it("enforces ui.toolbar on buttons alone and rolls back commands and other contributions", () => {
    const runtime = makeRuntime();
    const denied = { ...manifest("arrows"), permissions: [] };
    expect(() => runtime.registerPlugin(denied)).toThrow(/ui\.toolbar/);
    expect(runtime.host.getPlugin(denied.id)).toBeUndefined();
    expect(runtime.host.commands.has(commandId)).toBe(false);
    expect(runtime.listPluginToolsets()).toEqual([]);
    const bad = manifest("arrows");
    expect(() => runtime.registerPlugin({ ...bad, contributes: { ...bad.contributes,
      toolsets: fixturePluginManifest.contributes.toolsets.map(toolset => ({ ...toolset,
        groups: [{ items: [{ commandId }] }] })),
      menus: [{ id: "menu.toolbarHome.run", title: "Run", commandId }],
      toolbarButtons: [{ id: "toolbar.home.bad", commandId: "plugin.someoneElse.run", toolbarGroup: "arrows" }]
    } })).toThrow(/does not contribute/);
    expect(runtime.host.commands.has(commandId)).toBe(false);
    expect(runtime.host.listMenuContributions()).toEqual([]);
    expect(runtime.listPluginToolsets()).toEqual([]);
    expect(runtime.pluginIdForToolset(FIXTURE_PLUGIN_TOOLSET_ID)).toBeUndefined();
  });

  it("restores main buttons when a replacement fails, and moves changed homes without duplication", () => {
    const runtime = makeRuntime();
    runtime.registerPlugin(manifest("arrows"));
    expect(() => runtime.replacePlugin(manifest().id, { ...manifest("arrange"), permissions: [] })).toThrow(/ui\.toolbar/);
    const catalog = createToolbarCatalog();
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(idsInGroup(catalog, "arrows")).toContain(commandId);
    runtime.replacePlugin(manifest().id, manifest("arrange"));
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    expect(idsInGroup(catalog, "arrows")).not.toContain(commandId);
    expect(idsInGroup(catalog, "arrange")).toContain(commandId);
  });

  it("hides and reorders plugin buttons only in their home, including gallery re-adds", () => {
    const runtime = makeRuntime();
    runtime.registerPlugin(manifest("arrows"));
    const catalog = createToolbarCatalog();
    catalog.setPluginToolsets(runtime.listPluginToolsets());
    let state = parseToolsetLayoutState({ version: 1, userToolsets: [], toolsetOverrides: [] });
    const coreIds = idsInGroup(catalog, "arrows").filter(id => id !== commandId) as string[];
    const context = { presentItemIds: new Set<string>(), commandTitle: () => "Run home tool",
      orderedItemIdsByGroup: new Map([["arrows", coreIds]]) };
    state = applyToolsetLayoutEdit(state, { toolsetId: "core.main", edit: { kind: "reorderItems", groupId: "arrows", orderedItemIds: [commandId, ...coreIds] } }, context);
    catalog.setLayoutState(state);
    expect(idsInGroup(catalog, "arrows")[0]).toBe(commandId);
    expect(buildMainToolbarCustomizeGroups(state).find(group => group.id === "arrows")?.items[0].id).toBe(commandId);
    expect(buildMainToolbarGallerySections([{ id: commandId, title: "Run home tool", icon: "palette", enabled: true }], [], new Set(), "")[0].id).toBe("arrows");
    const before = state;
    state = applyToolsetLayoutEdit(state, { toolsetId: "core.main", edit: { kind: "reorderItems", groupId: "arrange", orderedItemIds: [commandId] } }, context);
    expect(state).toBe(before);
    state = applyToolsetLayoutEdit(state, { toolsetId: "core.main", edit: { kind: "setItemHidden", itemId: commandId, hidden: true } }, context);
    catalog.setLayoutState(state);
    expect(idsInGroup(catalog, "arrows")).not.toContain(commandId);
    state = applyToolsetLayoutEdit(state, { toolsetId: "core.main", edit: { kind: "addCommand", commandId, groupId: "arrows", index: 0 } }, context);
    catalog.setLayoutState(state);
    expect(idsInGroup(catalog, "arrows")[0]).toBe(commandId);
  });
});
