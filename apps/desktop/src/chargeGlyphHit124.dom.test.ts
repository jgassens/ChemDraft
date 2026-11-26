// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatches, type ElectronMarkObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

// A charge glyph is drawn upright whatever its stored rotation, so its grab target must be
// upright too. jsdom has no hit testing: resolve each click point against the catcher's real
// attributes (frame plus transform), then dispatch only when the browser would have hit it.
describe.each([false, true])("charge glyph hit target, direct editing %s", enabled => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDirectElectronMarkEditing(enabled);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function mountWithMark(rotation: number, size: { width: number; height: number }) {
    const base = workflow.createPhase4Document("Charge hit");
    const mark: ElectronMarkObject = { id: "wide-charge", type: "electron-mark", markKind: "charge", charge: 2,
      x: 300, y: 300, ...size, rotation, style: {}, anchor: { kind: "point", point: { x: 300, y: 300 } } };
    const document = applyPatches(base, [{ op: "addObject", pageId: base.pages[0].id, object: mark }],
      { now: workflow.phase4Timestamp });
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: false,
      initialRulersVisible: false, initialCrosshairsVisible: false })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
    return mark;
  }
  /** Would the browser put this point inside the catcher, once its own transform is applied? */
  function insideCatcher(catcher: SVGRectElement, point: { x: number; y: number }) {
    const x = Number(catcher.getAttribute("x")), y = Number(catcher.getAttribute("y"));
    const width = Number(catcher.getAttribute("width")), height = Number(catcher.getAttribute("height"));
    let local = point;
    const turn = /^rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)$/.exec(catcher.getAttribute("transform") ?? "");
    if (turn) {
      const angle = -Number(turn[1]) * Math.PI / 180, dx = point.x - Number(turn[2]), dy = point.y - Number(turn[3]);
      local = { x: Number(turn[2]) + dx * Math.cos(angle) - dy * Math.sin(angle),
        y: Number(turn[3]) + dx * Math.sin(angle) + dy * Math.cos(angle) };
    } else expect(catcher.getAttribute("transform") ?? "").toBe("");
    return local.x >= x && local.x <= x + width && local.y >= y && local.y <= y + height;
  }
  const catcherFor = (id: string) => container.querySelector<SVGRectElement>(`[data-electron-mark-hit-target="${id}"]`)!;
  async function click(id: string, point: { x: number; y: number }) {
    const catcher = catcherFor(id);
    // Outside the catcher the click lands on the empty page, as the browser would route it.
    const target = insideCatcher(catcher, point) ? catcher : container.querySelector(".page")!;
    await act(async () => pointer(target, "pointerdown", point));
    await act(async () => pointer(target, "pointerup", point));
  }

  it.each([37, 90])("selects at a point inside the upright glyph of a wide charge mark rotated %s degrees", async rotation => {
    const mark = await mountWithMark(rotation, { width: 72, height: 18 });
    // The 72 x 36 grab area is centered on (336, 309); a rotated box would be 36 wide at 90 degrees.
    const catcher = catcherFor(mark.id);
    expect(catcher).not.toBeNull();
    expect(catcher.getAttribute("transform") ?? "").toBe("");
    const center = { x: mark.x + 36, y: mark.y + 9 };
    // Inside the upright frame, but well outside the box turned 90 degrees (35 > 18 away along x).
    const point = { x: center.x + 30, y: center.y };
    expect(snapshot().selection.objectIds).toEqual([]);
    await click(mark.id, point);
    expect(snapshot().selection.objectIds).toEqual([mark.id]);
  });

  it.each([37, 90])("draws the selection chrome of a wide charge mark rotated %s degrees upright", async rotation => {
    const mark = await mountWithMark(rotation, { width: 72, height: 18 });
    await click(mark.id, { x: mark.x + 36, y: mark.y + 9 });
    expect(snapshot().selection.objectIds).toEqual([mark.id]);
    const chrome = [...container.querySelectorAll<HTMLElement>(`[data-object-controls="${mark.id}"]`)];
    expect(chrome.length).toBeGreaterThan(0);
    // The outline, hover outline, handle frame and transform frame all live in this one box.
    for (const element of chrome) expect(element.style.transform).not.toContain("rotate");
  });

  it("keeps the selection chrome of a lone pair turned with its stored rotation", async () => {
    const base = workflow.createPhase4Document("Lone pair chrome");
    const pair: ElectronMarkObject = { id: "turned-pair", type: "electron-mark", markKind: "lone-pair",
      x: 300, y: 300, width: 18, height: 18, rotation: 37, style: {}, anchor: { kind: "point", point: { x: 300, y: 300 } } };
    const document = applyPatches(base, [{ op: "addObject", pageId: base.pages[0].id, object: pair }],
      { now: workflow.phase4Timestamp });
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: false,
      initialRulersVisible: false, initialCrosshairsVisible: false })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
    await click(pair.id, { x: 309, y: 309 });
    expect(snapshot().selection.objectIds).toEqual([pair.id]);
    const chrome = [...container.querySelectorAll<HTMLElement>(`[data-object-controls="${pair.id}"]`)];
    expect(chrome.length).toBeGreaterThan(0);
    // Direct editing draws every mark's chrome unturned already (its handles use the unrotated frame).
    for (const element of chrome) expect(element.style.transform).toBe(enabled ? "" : "rotate(37deg)");
  });

  it("does not select at a point that was only inside the old rotated box", async () => {
    const mark = await mountWithMark(90, { width: 72, height: 18 });
    const center = { x: mark.x + 36, y: mark.y + 9 };
    // Along y, 30 from the center: inside the old 36 x 72 rotated box, outside the upright 72 x 36 one.
    await click(mark.id, { x: center.x, y: center.y + 30 });
    expect(snapshot().selection.objectIds).toEqual([]);
  });
});
