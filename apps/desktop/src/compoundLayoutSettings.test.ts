import { describe, expect, it, afterEach, vi } from "vitest";
import { MemoryStorage } from "./testSupport/memoryStorage";
import { COMPOUND_LAYOUT_STORAGE_KEY, loadCompoundLayoutSettings, saveCompoundLayoutSettings, isCompoundLayoutCommand, compoundLayoutCommandDisabledReason, isCompoundLayoutSettings, isCompoundLayoutCommandHidden } from "./compoundLayoutSettings";
import { createLayerActions } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { getToolsetPaletteGroups, compoundLayoutRegistry, desktopToolsetRegistry, createDesktopToolsetRegistry } from "./toolsets";
import { PreferencesWindow } from "./PreferencesWindow";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

afterEach(() => vi.unstubAllGlobals());
describe("opt-in compound layouts", () => {
  it("validates child settings and leaves all new options off for existing profiles", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveCompoundLayoutSettings({enabled:true});
    const settings=loadCompoundLayoutSettings();
    expect(compoundLayoutCommandDisabledReason("layout.arrange.row",settings)).toBeUndefined();
    expect(isCompoundLayoutCommandHidden("layout.adjustArrangementSpacing",settings)).toBe(false);
    expect(isCompoundLayoutCommandHidden("layout.adjustArrangementSpacing",{enabled:true,arrangementArrows:true})).toBe(true);
    expect(compoundLayoutCommandDisabledReason("layout.adjustArrangementSpacing",{enabled:true,arrangementArrows:true})).toBeUndefined();
    for(const id of ["layout.arrangeOptions","arrow.attachOffshoot.above","arrow.conditions"])
      expect(compoundLayoutCommandDisabledReason(id,settings)).toMatch(/^Enable /);
    expect(isCompoundLayoutSettings({enabled:true,offshootArrows:"true"})).toBe(false);
    expect(isCompoundLayoutSettings({enabled:true,arrangementArrows:1})).toBe(false);
  });
  it.each(Array.from({length:8},(_,bits)=>bits))("independently gates each feature combination %s, including custom toolbar entries", bits => {
    const settings={enabled:true,arrangementArrows:!!(bits&1),offshootArrows:!!(bits&2),formattedReactionConditions:!!(bits&4)};
    const ids=["layout.arrangeOptions","arrow.attachOffshoot.above","arrow.conditions"];
    const registry=createDesktopToolsetRegistry(undefined,new Set(ids),[{id:"custom.arrows",title:"Arrows",source:"user",defaultVisible:true,defaultMode:"floating",groups:[{id:"arrows",items:ids.map(id=>({id,commandId:id,title:id}))}]}]);
    const visible=compoundLayoutRegistry(registry,true,settings).require("custom.arrows").groups[0].items.map(i=>i.commandId);
    ids.forEach((id,index)=> {
      expect(!compoundLayoutCommandDisabledReason(id,settings)).toBe(!!(bits&(1<<index)));
      expect(visible.includes(id)).toBe(!!(bits&(1<<index)));
      expect(compoundLayoutCommandDisabledReason(id,{...settings,enabled:false})).toBe("Enable Compound layout tools in Settings");
    });
    expect(compoundLayoutCommandDisabledReason("layout.arrange.circle",settings)).toBeUndefined();
    expect(compoundLayoutRegistry(registry,false,settings).require("custom.arrows").groups[0].items).toHaveLength(0);
    expect(registry.require("custom.arrows").groups[0].items).toHaveLength(3);
  });
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
    expect(compoundLayoutRegistry(registry,true,{enabled:true,arrangementArrows:true,offshootArrows:true,formattedReactionConditions:true}).require("custom.layouts").groups[0].items).toHaveLength(2);
  });
  it.each(["core.main", "core.art", "core.layout"])("hides %s layout surfaces and disables all commands when off", toolset => {
    const filtered = compoundLayoutRegistry(desktopToolsetRegistry, false);
    expect(filtered.require(toolset).groups.flatMap(g => g.items).some(i => isCompoundLayoutCommand(i.commandId ?? i.id ?? ""))).toBe(false);
    const off = getToolsetPaletteGroups(toolset, undefined, undefined, false).flatMap(g => g.items);
    expect(off.some(i => isCompoundLayoutCommand(i.id))).toBe(false);
    const on = getToolsetPaletteGroups(toolset, undefined, undefined, true, {enabled:true,arrangementArrows:true}).flatMap(g => g.items);
    const item = on.find(i => i.id === "layout.arrange.circle")!;
    expect(item).toBeDefined(); expect(item.submenu?.items).toHaveLength(8);
    expect(item.submenu?.items.some(choice => choice.id === "layout.arrangeOptions")).toBe(true);
    const commands = createLayerActions(createPhase4Document(), false).filter(c => isCompoundLayoutCommand(c.id));
    expect(commands).toHaveLength(9);
    for (const command of commands) expect(command).toMatchObject({ enabled: false, disabledReason: "Enable Compound layout tools in Settings" });
  });
});
