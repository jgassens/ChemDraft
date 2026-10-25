// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject, GraphicObject, Point } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeSingleBondMolecule, nativeOrbitalAnchorPoint } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const molecules = (document: ChemDraftDocument) => document.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");

describe.each(["macos", "windows"] as const)("orbital placement and rotation on %s", (platform) => {
  let root: Root;
  let container: HTMLDivElement;
  const captureMethods = ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const;
  let descriptors: Array<PropertyDescriptor | undefined>;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    descriptors = captureMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    for (const name of captureMethods) Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true, value: name === "hasPointerCapture" ? () => false : () => {}
    });
    Object.defineProperty(navigator, "platform", { configurable: true, value: platform === "macos" ? "MacIntel" : "Win32" });
    saveKeybindingSettings({ scheme: "chemdraft" });
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    captureMethods.forEach((name, i) => {
      const descriptor = descriptors[i];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
    window.history.replaceState(null, "", "/");
    Reflect.deleteProperty(navigator, "platform"); delete window.__CHEMDRAFT_AGENT__;
  });
  const current = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const page = () => container.querySelector<HTMLElement>(".page")!;
  async function mount(tool: string, document = createPhase4Document("Placement snap")) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: document, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  }
  async function pointer(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", point: Point, target: Element = page(), altKey = false, shiftKey = false) {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y, altKey, shiftKey });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    });
  }

  const graphics = () => current().pages[0].objects.filter((object): object is GraphicObject => object.type === "graphic");
  const targetFor = (id: string) => container.querySelector<HTMLElement>(`[data-object-id="${id}"]`)!;
  const atAngle = (center: Point, degrees: number) => ({ x: center.x + 70 * Math.cos(degrees * Math.PI / 180), y: center.y + 70 * Math.sin(degrees * Math.PI / 180) });
  const closeTo = (actual: Point | undefined, expected: Point) => { expect(actual?.x).toBeCloseTo(expected.x, 6); expect(actual?.y).toBeCloseTo(expected.y, 6); };

  it.each(["tool.lobe", "tool.shadedLobe", "tool.pOrbital", "tool.sOrbital"])("keeps %s active and adds at the preceding node without edit handles intercepting", async tool => {
    await mount(tool);
    const node = { x: 320, y: 300 };
    await pointer("pointerdown", node); await pointer("pointerup", node);
    const first = graphics()[0]; closeTo(nativeOrbitalAnchorPoint(first), node);
    expect(window.__CHEMDRAFT_AGENT__!.snapshot().activeToolCommandId).toBe(tool);
    expect(container.querySelector('[data-graphic-path-node-index]')).toBeNull();
    await pointer("pointerdown", { x: node.x + 3, y: node.y - 2 }, targetFor(first.id));
    await pointer("pointerup", node, targetFor(first.id));
    expect(graphics()).toHaveLength(2); closeTo(nativeOrbitalAnchorPoint(graphics()[1]), node);
    expect(graphics()[0]).toEqual(first);
    if (tool !== "tool.sOrbital") expect(graphics()[1].rotation).not.toBe(first.rotation);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(graphics()).toEqual([first]);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.redo"); });
    expect(graphics()).toHaveLength(2);
  });

  it.each([false, true])("orients placement freely and uses Shift for exact 15-degree steps (Shift: %s)", async shift => {
    await mount("tool.pOrbital"); const node = { x: 320, y: 300 }, end = atAngle(node, -76.75);
    await pointer("pointerdown", node); await pointer("pointermove", end, page(), false, shift);
    const preview = graphics()[0]; closeTo(nativeOrbitalAnchorPoint(preview), node);
    expect(preview.rotation).toBeCloseTo(shift ? 15 : 13.25, 6);
    await pointer("pointerup", end); expect(graphics()[0]).toEqual(preview);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); }); expect(graphics()).toHaveLength(0);
  });

  it("exposes rotation directly and keeps arbitrary angles around a lobe tip", async () => {
    await mount("tool.shadedLobe"); const node = { x: 320, y: 300 };
    await pointer("pointerdown", node); await pointer("pointerup", node);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.select"); });
    const handle = container.querySelector<HTMLElement>('[data-selection-rotate-handle="true"]'); expect(handle).not.toBeNull();
    await pointer("pointerdown", atAngle(node, 0), handle!);
    await pointer("pointermove", atAngle(node, 13.25)); await pointer("pointerup", atAngle(node, 13.25));
    closeTo(nativeOrbitalAnchorPoint(graphics()[0]), node); expect(graphics()[0].rotation).toBeCloseTo(13.25, 6);
  });

  it("drags a second orbital from the first orbital's node and retains Direct Edit", async () => {
    await mount("tool.pOrbital"); const node = { x:320, y:300 };
    await pointer("pointerdown", node); await pointer("pointerup", node);
    const first = graphics()[0], target = targetFor(first.id), end = atAngle(node, -30);
    await pointer("pointerdown", node, target); await pointer("pointermove", end, target);
    expect(graphics()[1].rotation).toBeCloseTo(60, 6); closeTo(nativeOrbitalAnchorPoint(graphics()[1]), node);
    await pointer("pointerup", end, target); expect(graphics()[0]).toEqual(first);
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("tool.art.directEdit"); });
    expect(container.querySelector('[data-graphic-path-node-index]')).not.toBeNull();
  });

  it("restores the pre-gesture document on cancellation and leaves molecules unchanged", async () => {
    const seed = insertNativeSingleBondMolecule(createPhase4Document("Orbital on atom"), { x: 320, y: 300 });
    await mount("tool.pOrbital", seed); const molecule = molecules(current())[0], node = molecule.atoms[1];
    await pointer("pointerdown", node, targetFor(molecule.id)); await pointer("pointermove", atAngle(node, 37), targetFor(molecule.id));
    await pointer("pointercancel", atAngle(node, 37), targetFor(molecule.id)); expect(graphics()).toHaveLength(0); expect(molecules(current())).toEqual([molecule]);
    await pointer("pointerdown", node, targetFor(molecule.id)); await pointer("pointerup", node, targetFor(molecule.id));
    closeTo(nativeOrbitalAnchorPoint(graphics()[0]), node); expect(molecules(current())).toEqual([molecule]);
  });
});
