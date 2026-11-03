import { describe, expect, it, afterEach, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { COMPOUND_LAYOUT_STORAGE_KEY, loadCompoundLayoutSettings, saveCompoundLayoutSettings, isCompoundLayoutCommand } from "./compoundLayoutSettings";
import { createLayerActions } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { getToolsetPaletteGroups, compoundLayoutRegistry, desktopToolsetRegistry, createDesktopToolsetRegistry } from "./toolsets";
import { PreferencesWindow } from "./PreferencesWindow";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

afterEach(() => vi.unstubAllGlobals());
describe("opt-in compound layouts", () => {
  it("defaults off for missing, malformed and invalid storage; persists explicit choices", () => {
    const storage = new MemoryStorage(); vi.stubGlobal("localStorage", storage);
    for (const value of [null, "broken", "null", '{}', '{"enabled":"true"}']) {
      if (value === null) storage.removeItem(COMPOUND_LAYOUT_STORAGE_KEY); else storage.setItem(COMPOUND_LAYOUT_STORAGE_KEY, value);
      expect(loadCompoundLayoutSettings()).toEqual({ enabled: false });
    }
    saveCompoundLayoutSettings({ enabled: true }); expect(loadCompoundLayoutSettings().enabled).toBe(true);
    expect(renderToStaticMarkup(createElement(PreferencesWindow))).toContain('type="checkbox" checked=""');
    saveCompoundLayoutSettings({ enabled: false }); expect(loadCompoundLayoutSettings().enabled).toBe(false);
    expect(renderToStaticMarkup(createElement(PreferencesWindow))).not.toContain('type="checkbox" checked=""');
  });
  it("filters custom layout entries without losing the stored toolbar definition", () => {
    const registry=createDesktopToolsetRegistry(undefined,undefined,[{id:"custom.layouts",title:"Layouts",source:"user",defaultVisible:true,defaultMode:"floating",groups:[{id:"custom.group",items:[
      {id:"custom.layout",commandId:"layout.arrange.row",title:"Row"},
      {id:"custom.flyout",commandId:"tool.select",title:"Select",submenu:{type:"command-grid",id:"custom.menu",items:[{commandId:"layout.arrange.oval",label:"Oval"}]}}
    ]}]}]);
    const hidden=compoundLayoutRegistry(registry,false).require("custom.layouts");
    expect(hidden.groups[0].items).toHaveLength(1);expect(hidden.groups[0].items[0].submenu).toBeNull();
    expect(registry.require("custom.layouts").groups[0].items).toHaveLength(2);
    expect(compoundLayoutRegistry(registry,true)).toBe(registry);
  });
  it.each(["core.main", "core.art", "core.layout"])("hides %s layout surfaces and disables all commands when off", toolset => {
    const filtered = compoundLayoutRegistry(desktopToolsetRegistry, false);
    expect(filtered.require(toolset).groups.flatMap(g => g.items).some(i => isCompoundLayoutCommand(i.commandId ?? i.id ?? ""))).toBe(false);
    const off = getToolsetPaletteGroups(toolset, undefined, undefined, false).flatMap(g => g.items);
    expect(off.some(i => isCompoundLayoutCommand(i.id))).toBe(false);
    const on = getToolsetPaletteGroups(toolset, undefined, undefined, true).flatMap(g => g.items);
    const item = on.find(i => i.id === "layout.arrange.circle")!;
    expect(item).toBeDefined(); expect(item.submenu?.items).toHaveLength(9);
    expect(item.submenu?.items.some(choice => choice.id === "layout.arrangeOptions")).toBe(true);
    const commands = createLayerActions(createPhase4Document(), false).filter(c => isCompoundLayoutCommand(c.id));
    expect(commands).toHaveLength(9);
    for (const command of commands) expect(command).toMatchObject({ enabled: false, disabledReason: "Enable Compound layout tools in Settings" });
  });
});
