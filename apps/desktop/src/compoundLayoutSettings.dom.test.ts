// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWindow } from "./PreferencesWindow";
import { loadCompoundLayoutSettings } from "./compoundLayoutSettings";
import { broadcastCompoundLayoutSettings, listenForCompoundLayoutSettings, COMPOUND_LAYOUT_SETTINGS_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({emit: vi.fn(), listen: vi.fn(), unlisten: vi.fn()}));
vi.mock("@tauri-apps/api/event", () => ({emit: native.emit, listen: native.listen}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { vi.stubGlobal("localStorage", new MemoryStorage()); });
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("compound layout preference synchronization", () => {
  it("the Settings checkbox persists and broadcasts one change in StrictMode", async () => {
    localStorage.clear(); const handler=vi.fn(),stop=await listenForCompoundLayoutSettings(handler);
    const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
    try {
      await act(async()=>root.render(createElement(StrictMode,null,createElement(PreferencesWindow))));
      const checkbox=container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;expect(checkbox.checked).toBe(false);
      await act(async()=>checkbox.click());expect(loadCompoundLayoutSettings().enabled).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);expect(handler).toHaveBeenCalledWith({enabled:true});
      await act(async()=>checkbox.click());expect(loadCompoundLayoutSettings().enabled).toBe(false);
    } finally {stop();await act(async()=>root.unmount());container.remove();}
  });
  it.each(["MacIntel", "Win32"])("broadcasts and validates native settings events on %s", async platform => {
    vi.stubGlobal("navigator", {platform}); vi.stubGlobal("__TAURI_INTERNALS__", {});
    const handler=vi.fn();native.listen.mockResolvedValue(native.unlisten);
    const stop=await listenForCompoundLayoutSettings(handler);
    expect(native.listen).toHaveBeenCalledWith(COMPOUND_LAYOUT_SETTINGS_EVENT,expect.any(Function));
    const callback=native.listen.mock.calls.at(-1)![1];
    callback({payload:{enabled:"true"}});expect(handler).not.toHaveBeenCalled();
    callback({payload:{enabled:true}});expect(handler).toHaveBeenCalledWith({enabled:true});
    await broadcastCompoundLayoutSettings({enabled:false});
    expect(native.emit).toHaveBeenCalledWith(COMPOUND_LAYOUT_SETTINGS_EVENT,{enabled:false});
    stop();expect(native.unlisten).toHaveBeenCalledTimes(1);
  });
});
