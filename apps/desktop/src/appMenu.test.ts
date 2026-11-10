import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { NativeStylePresets } from "@chemdraft/chem-core";

import {
  buildAppMenuModel,
  flattenAppMenuCommands,
  formatMenuShortcut,
  nativeRoutedCommandIds,
  PLUGIN_MANAGER_COMMAND_ID,
  PLUGIN_UPDATES_COMMAND_ID,
  pluginUpdatesAvailableMenuItem,
  type AppMenuCommand,
  type AppMenuContext
} from "./appMenu";
import { pluginItemsForNativeMenu } from "./plugins/nativePluginMenu";
import { VIBE_CODE_STARTER_COMMAND_ID } from "./commands/vibeCodeStarter";
import { nativeStylePresetCommandId } from "./commands";

const EMPTY_CONTEXT: AppMenuContext = {
  rulersVisible: true,
  crosshairsVisible: true,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  hasSelectedMolecule: false,
  canConvertTextToAtomLabel: true,
  platform: "macos",
  toolbars: []
};

/**
 * Parse the authoritative routed-command list (`MENU_COMMAND_IDS`) out of the Rust source. Entries
 * are either string literals or `SCREAMING_CASE` constant references, which we resolve to their
 * `const IDENT: &str = "…"` values. This is what keeps the web menu and native menu in lock-step.
 */
function parseNativeMenuCommandIds(): string[] {
  const libPath = fileURLToPath(new URL("../src-tauri/src/lib.rs", import.meta.url));
  const source = readFileSync(libPath, "utf8");

  const block = source.match(/const MENU_COMMAND_IDS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  if (!block) {
    throw new Error("Could not find MENU_COMMAND_IDS in lib.rs");
  }
  const body = block[1];

  const ids = new Set<string>();
  for (const match of body.matchAll(/"([^"]+)"/g)) {
    ids.add(match[1]);
  }
  for (const match of body.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)) {
    const constMatch = source.match(new RegExp(`const ${match[1]}:\\s*&str\\s*=\\s*"([^"]+)"`));
    if (!constMatch) {
      throw new Error(`Could not resolve MENU_COMMAND_IDS constant ${match[1]}`);
    }
    ids.add(constMatch[1]);
  }
  return [...ids];
}

describe("app menu model", () => {
  it.each(["macos", "windows"] as const)("keeps a separate plugin alias block after the drawing styles on %s", platform => {
    const context = { ...EMPTY_CONTEXT, platform };
    const base = buildAppMenuModel(context).find(section => section.id === "structure")!;
    const aliases: AppMenuCommand[] = ["first", "second"].map(name => ({
      kind: "command", id: `menu.test.${name}`, commandId: `plugin.test.${name}`,
      label: name, enabled: true, pluginContributed: true
    }));
    const model = buildAppMenuModel({ ...context, pluginMenuItems: aliases.map(command => ({ location: "structure", command })) });
    const structure = model.find(section => section.id === "structure")!;
    expect(base.items.slice(-NativeStylePresets.length)).toEqual(NativeStylePresets.map(preset =>
      expect.objectContaining({ kind: "command", commandId: nativeStylePresetCommandId(preset.id) })));
    expect(structure.items.slice(0, base.items.length)).toEqual(base.items);
    expect(structure.items.slice(base.items.length)).toEqual([expect.objectContaining({ kind: "separator" }), ...aliases]);
    expect(nativeRoutedCommandIds(model)).toEqual(nativeRoutedCommandIds(buildAppMenuModel(context)));
  });

  it.each(["MacIntel", "Win32"])("shows the counted plugin update notice only for available offers on %s", platform => {
    vi.stubGlobal("navigator", { platform });
    try {
      const context = { ...EMPTY_CONTEXT, platform: platform === "MacIntel" ? "macos" as const : "windows" as const };
      for (const count of [undefined, 0, -1]) {
        const model = buildAppMenuModel({ ...context, availablePluginUpdateCount: count });
        expect(flattenAppMenuCommands(model).some(item => item.commandId === PLUGIN_UPDATES_COMMAND_ID)).toBe(false);
      }
      const model = buildAppMenuModel({ ...context, availablePluginUpdateCount: 2 });
      const plugins = model.find(section => section.id === "plugins")!;
      const notice = flattenAppMenuCommands([plugins]).filter(item => item.commandId === PLUGIN_UPDATES_COMMAND_ID);
      expect(PLUGIN_UPDATES_COMMAND_ID).toBe("plugins.showUpdates");
      expect(notice).toEqual([expect.objectContaining({ label: "Plugin Updates Available (2)…", enabled: true, coreRouted: true })]);
      expect(notice[0]?.pluginContributed).not.toBe(true);
      expect(nativeRoutedCommandIds(model)).not.toContain(PLUGIN_UPDATES_COMMAND_ID);
      expect(pluginItemsForNativeMenu(pluginUpdatesAvailableMenuItem(2))).toEqual([{
        id: PLUGIN_UPDATES_COMMAND_ID, coreRouted: true,
        label: "Plugin Updates Available (2)…", enabled: true, location: "plugins"
      }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("dispatches explicitly core-routed dynamic native items to the core command on both platforms", () => {
    const source = readFileSync("apps/desktop/src-tauri/src/lib.rs", "utf8");
    expect(source).toContain("#[serde(default)]\n    core_routed: bool");
    const routing = source.split("fn is_core_routed_dynamic_menu_command")[1]?.split("fn plugin_menu_items_in")[0];
    expect(routing).toContain("item.core_routed && item.id == command_id");
    const click = source.split(".on_menu_event(")[1]?.split(".on_window_event(")[0];
    expect(click).toContain("is_core_routed_dynamic_menu_command(command_id, &current_plugin_menu_items(app))");
    expect(click).toContain("emit_menu_command(app, command_id)");
    const main = readFileSync("apps/desktop/src/MainWindow.tsx", "utf8");
    expect(main).toContain("for (const commandId of [PLUGIN_MANAGER_COMMAND_ID, PLUGIN_UPDATES_COMMAND_ID]) register(");
    expect(main).not.toContain("plugin.runtime.showUpdates");
  });

  it.each(["MacIntel", "Win32"])("places Insert > Templates… after Edit on %s", platform => {
    vi.stubGlobal("navigator", { platform });
    try {
      const context = { ...EMPTY_CONTEXT, platform: platform === "MacIntel" ? "macos" as const : "windows" as const };
      const model = buildAppMenuModel(context);
      const index = model.findIndex(section => section.id === "edit");
      expect(model.slice(index, index + 3).map(section => section.id)).toEqual(["edit", "insert", "view"]);
      // Insert holds Table… (tables) and Templates… (structure templates) since both landed.
      expect(model[index + 1]!.items).toEqual([
        expect.objectContaining({ commandId: "table.insertDialog", label: "Table…" }),
        expect.objectContaining({ commandId: "template.insertDialog", label: "Templates…" })
      ]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("routes synced plugin items by section in the shared native builder for both platforms", () => {
    const source = readFileSync("apps/desktop/src-tauri/src/lib.rs", "utf8");
    const builder = source.split("fn create_app_menu_for_toolsets<R: Runtime>")[1]?.split("/// Close Window")[0];
    expect(builder).toContain('plugin_menu_items_in(plugin_items, "structure")');
    expect(builder).toContain("structure_menu.append");
    expect(builder).toContain("&structure_menu,");
    expect(builder).toContain('plugin_menu_items_in(plugin_items, "plugins")');
    expect(builder).toContain("plugins_menu.append");
    expect(builder).toContain("&plugins_menu,");
    const analyze = source.split("fn build_analyze_submenu<R: Runtime>")[1]?.split("fn create_app_menu")[0];
    expect(analyze).toContain('plugin_menu_items_in(plugin_items, "analyze")');
    const install = source.split("fn install_app_menu<R: Runtime>")[1]?.split("fn reinstall_app_menu")[0];
    expect(install).toContain('#[cfg(target_os = "macos")]\n    app.set_menu(menu)?;');
    expect(install).toContain('#[cfg(not(target_os = "macos"))]');
    expect(install).toContain("app.get_webview_window(MAIN_WINDOW_LABEL)");
    expect(install).toContain("window.set_menu(menu)?;");
  });

  it("exposes routed Select All with the same command and accelerator as the native menu", () => {
    const command = flattenAppMenuCommands(buildAppMenuModel(EMPTY_CONTEXT)).find(item => item.commandId === "edit.selectAll");
    expect(command).toMatchObject({ label: "Select All", accelerator: "Cmd+A", enabled: true });
    expect(command?.nativePredefined).toBeFalsy();
    expect(parseNativeMenuCommandIds()).toContain("edit.selectAll");
  });
  it.each(["MacIntel", "Win32"])("omits kept-drawing actions from the menu on %s", (platform) => {
    vi.stubGlobal("navigator", { platform });
    try {
      const context = { ...EMPTY_CONTEXT, platform: platform === "MacIntel" ? "macos" as const : "windows" as const };
      const commands = flattenAppMenuCommands(buildAppMenuModel(context));
      for (const id of ["document.saveUnrestoredTabs", "document.discardUnrestoredTabs"]) {
        expect(commands.some(command => command.commandId === id)).toBe(false);
        expect(parseNativeMenuCommandIds()).not.toContain(id);
      }
      const source = readFileSync("apps/desktop/src-tauri/src/lib.rs", "utf8");
      expect(source).not.toContain('"Save Unrestored Tabs…"');
      expect(source).not.toContain('"Discard Unrestored Tabs…"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("stays in sync with the native menu's routed command ids (lib.rs MENU_COMMAND_IDS)", () => {
    const nativeIds = parseNativeMenuCommandIds();
    const webIds = nativeRoutedCommandIds(buildAppMenuModel(EMPTY_CONTEXT));

    // Sanity: the parse actually found the native list (guards against a silent regex miss).
    expect(nativeIds.length).toBeGreaterThan(20);
    expect([...webIds].sort()).toEqual([...nativeIds].sort());
  });

  it.each(["macos", "windows"] as const)("wires the toolbar size reset in the %s menu", (platform) => {
    for (const enabled of [false, true]) {
      const commands = flattenAppMenuCommands(buildAppMenuModel({ ...EMPTY_CONTEXT, platform, resizableToolbars: enabled }));
      expect(commands.find(item => item.commandId === "view.toolbars.resetSizes")).toMatchObject({ enabled, label: "Reset Toolbar Sizes" });
    }
    const source = readFileSync("apps/desktop/src-tauri/src/lib.rs", "utf8");
    const menu = source.split("fn create_toolbars_menu<R: Runtime>")[1]?.split("fn ensure_toolset_window")[0];
    expect(menu).toContain('"view.toolbars.resetSizes"');
    expect(menu).toContain("resizable_toolbars,");
    expect(source).toContain("create_toolbars_menu(app, entries, view_state.resizable_toolbars)");
  });

  it("exposes the OS-predefined clipboard commands as web commands but excludes them from the native set", () => {
    const commands = flattenAppMenuCommands(buildAppMenuModel(EMPTY_CONTEXT));
    const predefined = commands.filter((command) => command.nativePredefined).map((command) => command.commandId);
    expect(predefined).toEqual(["clipboard.cut", "clipboard.copy", "clipboard.paste"]);

    const routed = nativeRoutedCommandIds(buildAppMenuModel(EMPTY_CONTEXT));
    expect(routed).not.toContain("clipboard.paste");
  });

  // Tester report: no working Undo. AppKit's predefined Undo only reaches the webview's text undo
  // manager, so Edit ▸ Undo/Redo must be routed commands that reach the document history.
  it("routes Edit ▸ Undo ⌘Z and Redo ⇧⌘Z to the document, first in the Edit menu", () => {
    const edit = buildAppMenuModel(EMPTY_CONTEXT).find((section) => section.id === "edit");
    const [undo, redo, divider] = edit?.items ?? [];
    expect(undo).toMatchObject({ kind: "command", commandId: "edit.undo", label: "Undo", shortcut: "⌘Z" });
    expect(redo).toMatchObject({ kind: "command", commandId: "edit.redo", label: "Redo", shortcut: "⇧⌘Z" });
    expect(divider?.kind).toBe("separator");
    expect((undo as AppMenuCommand).nativePredefined).toBeFalsy();
    expect((redo as AppMenuCommand).nativePredefined).toBeFalsy();

    const routed = nativeRoutedCommandIds(buildAppMenuModel(EMPTY_CONTEXT));
    expect(routed).toContain("edit.undo");
    expect(routed).toContain("edit.redo");
  });

  it("reflects toggle state on checkable items", () => {
    const model = buildAppMenuModel({ ...EMPTY_CONTEXT, rulersVisible: false, crosshairsVisible: true });
    const commands = flattenAppMenuCommands(model);
    expect(commands.find((command) => command.commandId === "view.toggleRulers")?.checked).toBe(false);
    expect(commands.find((command) => command.commandId === "view.toggleCrosshairs")?.checked).toBe(true);
  });

  it("disables selection-dependent items until there is a selection", () => {
    const empty = flattenAppMenuCommands(buildAppMenuModel(EMPTY_CONTEXT));
    expect(empty.find((command) => command.commandId === "clipboard.copy")?.enabled).toBe(false);
    expect(empty.find((command) => command.commandId === "chemistry.validateSelection")?.enabled).toBe(false);
    expect(empty.find((command) => command.commandId === "edit.undo")?.enabled).toBe(false);

    const active = flattenAppMenuCommands(
      buildAppMenuModel({ ...EMPTY_CONTEXT, hasSelection: true, hasSelectedMolecule: true, canUndo: true })
    );
    expect(active.find((command) => command.commandId === "clipboard.copy")?.enabled).toBe(true);
    expect(active.find((command) => command.commandId === "chemistry.validateSelection")?.enabled).toBe(true);
    expect(active.find((command) => command.commandId === "edit.undo")?.enabled).toBe(true);
  });

  it("mirrors the dynamic View ▸ Toolbars submenu from context", () => {
    const model = buildAppMenuModel({
      ...EMPTY_CONTEXT,
      toolbars: [
        { id: "tb1", commandId: "view.toolset.toggle.core.main", title: "Main Toolbar", checked: true },
        { id: "tb2", commandId: "view.toolset.toggle.core.art", title: "Art Toolbar", checked: false }
      ]
    });
    const view = model.find((section) => section.id === "view");
    const toolbars = view?.items.find((item) => item.kind === "submenu" && item.id === "view.toolbars");
    expect(toolbars?.kind).toBe("submenu");
    if (toolbars?.kind === "submenu") {
      expect(toolbars.items.map((item) => (item.kind === "command" ? item.commandId : item.kind))).toEqual([
        "view.toolset.toggle.core.main",
        "view.toolset.toggle.core.art",
        "separator",
        "view.toolbars.resetSizes"
      ]);
    }

    // Dynamic toggles must not leak into the native-parity set.
    expect(nativeRoutedCommandIds(model)).not.toContain("view.toolset.toggle.core.main");
  });

  it("formats accelerators as mac glyphs", () => {
    expect(formatMenuShortcut("Cmd+N")).toBe("⌘N");
    expect(formatMenuShortcut("Shift+Cmd+S")).toBe("⇧⌘S");
    expect(formatMenuShortcut("Cmd+,")).toBe("⌘,");
    expect(formatMenuShortcut(undefined)).toBeUndefined();
  });

  it("presents the expected top-level sections", () => {
    expect(buildAppMenuModel(EMPTY_CONTEXT).map((section) => section.label)).toEqual([
      "ChemDraft",
      "File",
      "Edit",
      "Insert",
      "View",
      "Structure",
      "Tools",
      "Analyze",
      "Plugins",
      "Help"
    ]);
  });

  it("exposes Insert after Edit and before View with the routed Table command", () => {
    const model = buildAppMenuModel(EMPTY_CONTEXT);
    const index = model.findIndex((section) => section.id === "insert");
    expect(model[index - 1]?.id).toBe("edit");
    expect(model[index + 1]?.id).toBe("view");
    // Templates… (structure templates) shares the Insert menu.
    expect(model[index]?.items).toEqual([
      expect.objectContaining({ kind: "command", commandId: "table.insertDialog", label: "Table…", enabled: true }),
      expect.objectContaining({ kind: "command", commandId: "template.insertDialog", label: "Templates…" })
    ]);
    expect(nativeRoutedCommandIds(model)).toContain("table.insertDialog");
  });

  it.each(["macos", "windows"] as const)("exposes the plugin manager and starter in order on %s", platform => {
    const model = buildAppMenuModel({ ...EMPTY_CONTEXT, platform });
    const plugins = model.find((section) => section.id === "plugins");

    expect(plugins?.label).toBe("Plugins");
    expect(plugins?.items).toEqual([
      expect.objectContaining({
        kind: "command",
        commandId: PLUGIN_MANAGER_COMMAND_ID,
        label: "Add or Remove Plugins…",
        enabled: true
      }),
      expect.objectContaining({ kind: "separator" }),
      expect.objectContaining({
        kind: "command",
        commandId: VIBE_CODE_STARTER_COMMAND_ID,
        label: "Vibe Code Your Own Plugin…",
        enabled: true
      })
    ]);
    expect(nativeRoutedCommandIds(model)).toContain(PLUGIN_MANAGER_COMMAND_ID);
    expect(nativeRoutedCommandIds(model)).toContain(VIBE_CODE_STARTER_COMMAND_ID);
    const source = readFileSync("apps/desktop/src-tauri/src/lib.rs", "utf8");
    const builder = source.split("let plugins_menu =")[1]!.split("let plugins_plugin_items")[0]!;
    expect(builder).toMatch(/"plugins.manage",\s*"Add or Remove Plugins…"[\s\S]*PredefinedMenuItem::separator\(app\)[\s\S]*"plugins.vibeCodeStarter",\s*"Vibe Code Your Own Plugin…"/);
  });

  it("appends plugin menu items to their target section without disturbing the native routed set", () => {
    const pluginItem: AppMenuCommand = {
      kind: "command",
      id: "menu.massFragment.analyze",
      commandId: "plugin.massFragment.analyzeSelectedStructure",
      label: "Analyze Mass / m/z",
      enabled: true,
      pluginContributed: true
    };

    const model = buildAppMenuModel({
      ...EMPTY_CONTEXT,
      pluginMenuItems: [{ location: "analyze", command: pluginItem }]
    });

    // Item lands in Analyze; no new top-level section appears for a known location.
    expect(model.map((section) => section.label)).toEqual([
      "ChemDraft",
      "File",
      "Edit",
      "Insert",
      "View",
      "Structure",
      "Tools",
      "Analyze",
      "Plugins",
      "Help"
    ]);
    const analyze = model.find((section) => section.id === "analyze");
    const analyzeCommandIds = flattenAppMenuCommands(analyze ? [analyze] : []).map((item) => item.commandId);
    expect(analyzeCommandIds).toContain("plugin.massFragment.analyzeSelectedStructure");

    // Plugin items are excluded from the native-routed set (native menu does not route them yet),
    // so the routed set is identical to the pure core menu — the drift test stays meaningful.
    expect(nativeRoutedCommandIds(model)).not.toContain("plugin.massFragment.analyzeSelectedStructure");
    expect(nativeRoutedCommandIds(model).sort()).toEqual(
      nativeRoutedCommandIds(buildAppMenuModel(EMPTY_CONTEXT)).sort()
    );
  });

  it("contains no NMR entry anywhere in the core menu model (M39 core-only build)", () => {
    // The core-only ChemDraft must not know the NMR plugin exists: no core command id or label may
    // reference it. NMR menu items can appear only as pluginMenuItems supplied by an installed plugin.
    const commands = flattenAppMenuCommands(buildAppMenuModel(EMPTY_CONTEXT));
    expect(commands.length).toBeGreaterThan(20);
    expect(commands.some((command) => /nmr/i.test(command.commandId) || /nmr/i.test(command.label))).toBe(false);
  });

  it("appends contributed items after the core Plugins commands and a separator", () => {
    const model = buildAppMenuModel({
      ...EMPTY_CONTEXT,
      pluginMenuItems: [
        {
          location: "plugins",
          command: {
            kind: "command",
            id: "menu.demo.open",
            commandId: "plugin.demo.open",
            label: "Open Demo",
            enabled: true,
            pluginContributed: true
          }
        }
      ]
    });

    const plugins = model.find((section) => section.id === "plugins");
    expect(plugins?.items.map((item) => (item.kind === "command" ? item.commandId : item.kind))).toEqual([
      PLUGIN_MANAGER_COMMAND_ID,
      "separator",
      VIBE_CODE_STARTER_COMMAND_ID,
      "separator",
      "plugin.demo.open"
    ]);
    expect(nativeRoutedCommandIds(model)).toContain(PLUGIN_MANAGER_COMMAND_ID);
    expect(nativeRoutedCommandIds(model)).not.toContain("plugin.demo.open");
  });
});


describe("Preferences placement", () => {
  it("keeps native Preferences in the macOS application menu and Windows File menu", () => {
    const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
    const builder = source.split("fn create_app_menu_for_toolsets<R: Runtime>")[1]!.split("/// Close Window")[0]!;
    const fileMenu = builder.split('"File",')[1]!.split('"Edit",')[0]!;
    expect(fileMenu).toContain('#[cfg(not(target_os = "macos"))]\n                    &preferences_menu_item(app)?');
    expect(fileMenu.indexOf('"export.open"')).toBeLessThan(fileMenu.indexOf("&preferences_menu_item(app)?"));
    expect(source).toContain('#[cfg(target_os = "macos")]\nfn create_native_app_menu<R: Runtime>');
    const appMenu = source.split("fn create_native_app_menu<R: Runtime>")[1]!.split("fn create_page_setup_menu")[0]!;
    expect(appMenu.indexOf("PredefinedMenuItem::about")).toBeLessThan(appMenu.indexOf("&preferences_menu_item(app)?"));
    expect(appMenu.indexOf("&preferences_menu_item(app)?")).toBeLessThan(appMenu.indexOf("PredefinedMenuItem::services"));
    const item = source.split("fn preferences_menu_item<R: Runtime>")[1]!.split("fn create_view_menu")[0]!;
    expect(item).toContain("PREFERENCES_TOGGLE_COMMAND_ID");
    expect(item).toContain('Some("CmdOrCtrl+,")');
    const viewMenu = source.split("fn create_view_menu<R: Runtime>")[1]!.split("fn create_toolbars_menu")[0]!;
    expect(viewMenu).not.toContain("preferences");
    expect(source).toContain('const PREFERENCES_TOGGLE_COMMAND_ID: &str = "view.togglePreferences";');
  });

  it.each(["macos", "windows"] as const)("places Preferences in the platform menu on %s", platform => {
    const sections = buildAppMenuModel({ ...EMPTY_CONTEXT, platform });
    const owner = sections.find(section => section.items.some(item => item.kind === "command" && item.commandId === "view.togglePreferences"))!;
    expect(owner.id).toBe(platform === "macos" ? "app" : "file");
    const preferences = flattenAppMenuCommands(sections).filter(item => item.commandId === "view.togglePreferences");
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({ accelerator: "Cmd+,", shortcut: platform === "macos" ? "⌘," : "Ctrl+," });
    expect(flattenAppMenuCommands(sections.filter(section => section.id === "view")).some(item => item.commandId === "view.togglePreferences")).toBe(false);
  });
});
