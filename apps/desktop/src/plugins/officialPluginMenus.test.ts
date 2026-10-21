import { CommandRegistry } from "@chemdraft/plugin-host";
import { describe, expect, it, vi } from "vitest";
import { buildAppMenuModel, nativeRoutedCommandIds } from "../appMenu";
import { buildOfficialPluginMenuItems, OFFICIAL_PLUGIN_MENUS } from "./officialPluginMenus";
import { pluginItemsForNativeMenu } from "./nativePluginMenu";

describe("official Structure menu aliases", () => {
  it.each([{ installed: [] }, { installed: [0] }, { installed: [1] }, { installed: [1, 0] }])("shows only registered commands, in host order: %j", async ({ installed }) => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    for (const index of installed) {
      registry.register({ id: OFFICIAL_PLUGIN_MENUS[index]!.commandId, title: "Plugin title", pluginId: `official.${index}`, source: "plugin" }, handler);
    }
    const items = buildOfficialPluginMenuItems(id => registry.get(id));
    const expected = OFFICIAL_PLUGIN_MENUS.filter((_, index) => installed.includes(index));
    expect(items.map(item => item.command.label)).toEqual(expected.map(item => item.title));
    const context = { rulersVisible: true, crosshairsVisible: true, canUndo: false, canRedo: false, hasSelection: false, hasSelectedMolecule: false, toolbars: [] };
    const base = buildAppMenuModel(context);
    const model = buildAppMenuModel({ ...context, pluginMenuItems: items });
    const coreItems = base.find(section => section.id === "structure")!.items;
    const structure = model.find(section => section.id === "structure")!;
    expect(structure.items.slice(0, coreItems.length)).toEqual(coreItems);
    expect(structure.items.slice(coreItems.length)).toEqual(items.length ? [expect.objectContaining({ kind: "separator" }), ...items.map(item => item.command)] : []);
    expect(nativeRoutedCommandIds(model)).toEqual(nativeRoutedCommandIds(base));
    expect(pluginItemsForNativeMenu(items)).toEqual(expected.map(item => ({ id: item.commandId, label: item.title, enabled: true, location: "structure" })));
    for (const item of items) await registry.invoke(item.command.commandId);
    expect(handler).toHaveBeenCalledTimes(installed.length);
  });

  it("hides disabled and unowned registrations and removes uninstalled commands", () => {
    const registry = new CommandRegistry();
    const [orthonym, opsin] = OFFICIAL_PLUGIN_MENUS;
    registry.register({ id: orthonym.commandId, title: "Name", pluginId: "official", enabled: false }, () => {});
    registry.register({ id: opsin.commandId, title: "Structure" }, () => {});
    expect(buildOfficialPluginMenuItems(id => registry.get(id))).toEqual([]);
    registry.unregister(orthonym.commandId);
    expect(buildOfficialPluginMenuItems(id => registry.get(id))).toEqual([]);
  });
});
