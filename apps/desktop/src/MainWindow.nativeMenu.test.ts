import { CommandRegistry } from "@chemdraft/plugin-host";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_UPDATES_COMMAND_ID, type PluginAppMenuItem } from "./appMenu";
import { nativeStylePresetActions } from "./commands";
import { buildMainWindowNativeMenuItems, syncPluginNativeMenuItems } from "./plugins/nativePluginMenu";
import { buildOfficialPluginMenuItems, OFFICIAL_PLUGIN_MENUS } from "./plugins/officialPluginMenus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./window-manager", () => ({ isDesktopRuntime: () => true }));

describe.each(["macos", "windows"] as const)("MainWindow native menu payload (%s)", platform => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { platform: platform === "macos" ? "MacIntel" : "Win32" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([[], [0], [1], [0, 1]])("separates installed official aliases %j from presets in the synced payload", async (...installed) => {
    const registry = new CommandRegistry();
    for (const index of installed) {
      const alias = OFFICIAL_PLUGIN_MENUS[index]!;
      registry.register({ id: alias.commandId, title: alias.title, pluginId: `official.${index}` }, () => {});
    }
    const aliases = buildOfficialPluginMenuItems(id => registry.get(id));
    const other: PluginAppMenuItem = {
      location: "analyze",
      command: { kind: "command", id: "menu.other", commandId: "plugin.other.analyze", label: "Other", enabled: false }
    };
    // The update notice and another location precede the aliases in the real flattened payload.
    const contributions = [other, ...aliases];
    const before = structuredClone(contributions);
    for (const count of [0, 2]) {
      const payload = buildMainWindowNativeMenuItems(contributions, count);
      const structure = payload.filter(item => item.location === "structure");
      expect(structure.find(item => item.id === "style.preset.apply.chemdraft.sketch")?.label).toBe("Drawing style: Sketch");
      expect(structure.find(item => item.id === "style.preset.apply.chemdraft.synthetic")?.label).toBe("Drawing style: ChemDraft Synthetic");
      expect(structure).toEqual([
        ...nativeStylePresetActions.map(action => ({
          id: action.id, label: `Drawing style: ${action.title}`, enabled: true,
          coreRouted: true, location: "structure"
        })),
        ...aliases.map((item, index) => ({
          id: item.command.commandId, label: item.command.label, enabled: true, location: "structure",
          ...(index === 0 ? { separatorBefore: true } : {})
        }))
      ]);
      expect(payload.filter(item => item.separatorBefore)).toHaveLength(aliases.length ? 1 : 0);
      expect(payload.find(item => item.id === other.command.commandId)).toEqual({
        id: other.command.commandId, label: "Other", enabled: false, location: "analyze"
      });
      expect(payload.find(item => item.id === PLUGIN_UPDATES_COMMAND_ID)).toEqual(count ? {
        id: PLUGIN_UPDATES_COMMAND_ID, label: "Plugin Updates Available (2)…", enabled: true,
        coreRouted: true, location: "plugins"
      } : undefined);
      await syncPluginNativeMenuItems(payload);
      expect(invoke).toHaveBeenLastCalledWith("sync_plugin_menu_items", { items: payload });
    }
    expect(contributions).toEqual(before);
  });
});
