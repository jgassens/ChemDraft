// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { applySingleBondToolAtPoint, createPhase4Document } from "./documentWorkflow";
import { broadcastDrawingSettings } from "./window-manager";
import { loadDrawingSettings } from "./drawingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["MacIntel", "Win32"])("uses a live preference change for hover key 2 on %s without editing the open document", async platform => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
  window.history.replaceState(null, "", "/?agentBridge=1");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const initialDocument = applySingleBondToolAtPoint(createPhase4Document(), { x: 300, y: 300 });
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot();
  const molecule = () => snapshot().document.pages[0].objects[0] as MoleculeObject;
  try {
    await act(async () => root.render(createElement(MainWindow, {
      initialActiveToolCommandId: "tool.bond", initialCrosshairsVisible: false, initialDocument,
      initialPaletteMode: "hidden", initialRulersVisible: false, nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
    const before = structuredClone(snapshot().document);
    await act(async () => broadcastDrawingSettings({ defaultDoubleBond: "centred" }));
    expect(loadDrawingSettings().defaultDoubleBond).toBe("centred");
    expect(snapshot().document).toEqual(before);
    const [from, to] = molecule().atoms;
    await act(async () => {
      const event = new MouseEvent("pointermove", {
        bubbles: true, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, buttons: 0
      });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      container.querySelector(".page")!.dispatchEvent(event);
    });
    expect(snapshot().hoveredNativeTarget?.kind).toBe("bond");
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true })
      );
    });
    expect(molecule().bonds[0]).toMatchObject({ order: "double", display: { doubleBondSide: "center" } });
    const after = structuredClone(snapshot().document);
    await act(async () => broadcastDrawingSettings({ defaultDoubleBond: "offset" }));
    expect(snapshot().document).toEqual(after);
  } finally {
    await act(async () => root.unmount()); container.remove();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
    else Reflect.deleteProperty(navigator, "platform");
    vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
