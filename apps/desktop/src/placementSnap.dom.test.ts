// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject, Point } from "@chemdraft/chem-core";
import { nativeBondLengthPx } from "@chemdraft/document-workflow-core";
import { MainWindow } from "./MainWindow";
import { applyNativeChainTool, applySingleBondToolAtPoint, createPhase4Document, insertNativeSingleBondMolecule } from "./documentWorkflow";
import { saveKeybindingSettings } from "./keybindingSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
const molecules = (document: ChemDraftDocument) => document.pages[0].objects.filter((object): object is MoleculeObject => object.type === "molecule");
const angle = (start: Point, end: Point) => Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
const pointAt = (start: Point, degrees: number, length = nativeBondLengthPx * 3) => ({
  x: start.x + Math.cos(degrees * Math.PI / 180) * length,
  y: start.y + Math.sin(degrees * Math.PI / 180) * length
});

describe.each(["macos", "windows"] as const)("placement pointer handlers on %s", (platform) => {
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
  const hint = () => container.querySelector("[data-modifier-hint]")?.textContent ?? "";
  async function mount(tool: string, document = createPhase4Document("Placement snap")) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: document, initialActiveToolCommandId: tool, initialCrosshairsVisible: false,
      initialRulersVisible: false, initialPaletteMode: "hidden", nativePalette: true
    })));
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) } as DOMRect;
    for (const element of container.querySelectorAll<HTMLElement>(".page, .canvas-region")) element.getBoundingClientRect = () => rect;
  }
  async function pointer(type: "pointerdown" | "pointermove" | "pointerup", point: Point, target: Element = page(), altKey = false) {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
        buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y, altKey });
      Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    });
  }
  async function undoOnce(before: MoleculeObject[]) {
    await act(async () => { await window.__CHEMDRAFT_AGENT__!.command("edit.undo"); });
    expect(molecules(current())).toEqual(before);
    expect(container.querySelector('[data-can-undo="true"]')).toBeNull();
  }
  const tools = ["tool.bond", "tool.wedgeBond", "tool.hashedBond", "tool.dashedBond", "tool.boldBond"];

  it.each(tools.flatMap((tool) => [false, true].map((alt) => [tool, alt] as const)))("aims %s from an atom (Alt: %s), previews and commits once", async (tool, alt) => {
    const seed = insertNativeSingleBondMolecule(createPhase4Document("Seed"), { x: 240, y: 240 });
    await mount(tool, seed);
    const before = molecules(current());
    const source = before[0].atoms[1];
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${before[0].id}"]`)!;
    const end = pointAt(source, 23, nativeBondLengthPx * 1.2);
    await pointer("pointerdown", source, wrapper);
    await pointer("pointermove", end, wrapper, alt);
    const line = container.querySelector<SVGLineElement>(".native-bond-freeform-line")!;
    expect(line).not.toBeNull();
    const previewStart = { x: Number(line.getAttribute("x1")), y: Number(line.getAttribute("y1")) };
    const previewEnd = { x: Number(line.getAttribute("x2")), y: Number(line.getAttribute("y2")) };
    expect(angle(previewStart, previewEnd)).toBeCloseTo(alt ? 23 : 30, 8);
    expect(Math.hypot(previewEnd.x - previewStart.x, previewEnd.y - previewStart.y)).toBeCloseTo(nativeBondLengthPx, 8);
    expect(hint()).toContain(alt ? "Free angle" : `${platform === "macos" ? "⌥" : "Alt"}: free angle`);
    // Release cannot replace the last preview with a different angle or modifier state.
    await pointer("pointerup", pointAt(source, 43), wrapper, !alt);
    const placed = molecules(current())[0];
    expect(placed.atoms.slice(0, 2)).toEqual(before[0].atoms);
    expect(placed.bonds.slice(0, 1)).toEqual(before[0].bonds);
    expect(placed.atoms).toHaveLength(3);
    expect(placed.bonds).toHaveLength(2);
    const terminal = placed.atoms[2];
    expect(angle(source, terminal)).toBeCloseTo(alt ? 23 : 30, 8);
    expect(terminal.x - source.x).toBeCloseTo(previewEnd.x - previewStart.x, 8);
    expect(terminal.y - source.y).toBeCloseTo(previewEnd.y - previewStart.y, 8);
    expect(placed.structure).toBe("CCC");
    await undoOnce(before);
  });

  it.each([false, true])("keeps long atom drags custom length (Alt: %s), with preview matching commit", async (alt) => {
    await mount("tool.bond", insertNativeSingleBondMolecule(createPhase4Document("Long drag"), { x: 240, y: 240 }));
    const before = molecules(current());
    const source = before[0].atoms[1];
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${before[0].id}"]`)!;
    await pointer("pointerdown", source, wrapper);
    await pointer("pointermove", pointAt(source, 23, 240), wrapper, alt);
    const line = container.querySelector<SVGLineElement>(".native-bond-freeform-line")!;
    const previewStart = { x: Number(line.getAttribute("x1")), y: Number(line.getAttribute("y1")) };
    const end = {
      x: source.x + Number(line.getAttribute("x2")) - previewStart.x,
      y: source.y + Number(line.getAttribute("y2")) - previewStart.y
    };
    expect(angle(source, end)).toBeCloseTo(alt ? 23 : 30, 8);
    expect(Math.hypot(end.x - source.x, end.y - source.y)).toBeCloseTo(240, 8);
    expect(wrapper.dataset.freeformPreviewCustomLength).toBe("true");
    expect(Number(wrapper.dataset.freeformPreviewLengthAngstrom)).toBeCloseTo(240 / nativeBondLengthPx * 1.56, 2);
    await pointer("pointerup", pointAt(source, 43), wrapper, !alt);
    expect(molecules(current())[0].atoms.at(-1)).toMatchObject(end);
    expect(molecules(current())[0].structure).toBe("CCC");
    await undoOnce(before);
  });

  it("keeps custom length unlocked when the pointer returns below breakaway", async () => {
    await mount("tool.bond", insertNativeSingleBondMolecule(createPhase4Document("Return drag"), { x: 240, y: 240 }));
    const before = molecules(current());
    const source = before[0].atoms[1];
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${before[0].id}"]`)!;
    await pointer("pointerdown", source, wrapper);
    await pointer("pointermove", pointAt(source, 23, 240), wrapper);
    await pointer("pointermove", pointAt(source, 23, nativeBondLengthPx * 0.8), wrapper);
    expect(wrapper.dataset.freeformPreviewCustomLength).toBe("true");
    await pointer("pointerup", pointAt(source, 43), wrapper);
    const end = molecules(current())[0].atoms.at(-1)!;
    expect(angle(source, end)).toBeCloseTo(30, 8);
    expect(Math.hypot(end.x - source.x, end.y - source.y)).toBeCloseTo(nativeBondLengthPx * 0.8, 8);
    await undoOnce(before);
  });

  it.each(tools.flatMap((tool) => [false, true].map((alt) => [tool, alt] as const)))("aims %s from empty space (Alt: %s) with one undo", async (tool, alt) => {
    await mount(tool);
    const start = { x: 240, y: 240 };
    await pointer("pointerdown", start);
    await pointer("pointermove", pointAt(start, 23), page(), alt);
    const preview = molecules(current())[0];
    expect(preview.atoms[0]).toMatchObject(start);
    expect(angle(preview.atoms[0], preview.atoms[1])).toBeCloseTo(alt ? 23 : 30, 8);
    expect(Math.hypot(preview.atoms[1].x - start.x, preview.atoms[1].y - start.y)).toBeCloseTo(nativeBondLengthPx, 8);
    await pointer("pointerup", pointAt(start, 43), page(), !alt);
    expect(molecules(current())[0]).toEqual(preview);
    await undoOnce([]);
  });

  it.each(["tool.cyclohexane", "tool.benzene"])("snaps %s aim, allows Alt mid-drag, and commits the preview", async (tool) => {
    await mount(tool);
    const start = { x: 300, y: 300 };
    await pointer("pointerdown", start);
    const initial = molecules(current())[0];
    expect(initial).toBeDefined();
    const relativeAngle = () => angle(molecules(current())[0].atoms[0], molecules(current())[0].atoms[1]) - angle(initial.atoms[0], initial.atoms[1]);
    await pointer("pointermove", pointAt(start, 23));
    expect(relativeAngle()).toBeCloseTo(30, 6);
    await pointer("pointermove", pointAt(start, 23), page(), true);
    expect(relativeAngle()).toBeCloseTo(23, 6);
    await pointer("pointermove", pointAt(start, 23));
    const preview = molecules(current())[0];
    expect(relativeAngle()).toBeCloseTo(30, 6);
    expect(preview.structure).toBe(initial.structure);
    expect(preview.bonds.map((bond) => bond.order)).toEqual(initial.bonds.map((bond) => bond.order));
    for (const bond of preview.bonds) {
      const from = preview.atoms.find((atom) => atom.id === bond.fromAtomId)!;
      const to = preview.atoms.find((atom) => atom.id === bond.toAtomId)!;
      expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeCloseTo(nativeBondLengthPx, 6);
    }
    await pointer("pointerup", pointAt(start, 43), page(), true);
    expect(molecules(current())[0]).toEqual(preview);
    await undoOnce([]);
  });

  it.each(["tool.chain", "tool.chainFlexible"].flatMap((tool) => [false, true].map((alt) => [tool, alt] as const)))("aims the first bond of %s (Alt: %s) and preserves its preview", async (tool, alt) => {
    await mount(tool);
    const start = { x: 240, y: 240 };
    await pointer("pointerdown", start);
    await pointer("pointermove", pointAt(start, 23), page(), alt);
    const preview = molecules(current())[0];
    if (alt || tool === "tool.chainFlexible") expect(angle(preview.atoms[0], preview.atoms[1])).toBeCloseTo(-7, 8);
    else expect(angle(preview.atoms[0], preview.atoms[1]) / 15).toBeCloseTo(Math.round(angle(preview.atoms[0], preview.atoms[1]) / 15), 8);
    if (tool === "tool.chainFlexible") expect(hint()).toBe("");
    else expect(hint()).toContain(alt ? "Free angle" : "Snaps to 15°");
    for (let i = 1; i < preview.atoms.length; i++) expect(Math.hypot(preview.atoms[i].x - preview.atoms[i - 1].x, preview.atoms[i].y - preview.atoms[i - 1].y)).toBeCloseTo(nativeBondLengthPx, 8);
    await pointer("pointerup", pointAt(start, 43));
    expect(molecules(current())[0].atoms).toEqual(preview.atoms);
    expect(molecules(current())[0].bonds).toEqual(preview.bonds);
    await undoOnce([]);
  });

  it.each([false, true])("keeps click placement geometry unchanged (on atom: %s)", async (onAtom) => {
    const seed = onAtom ? insertNativeSingleBondMolecule(createPhase4Document("Click"), { x: 240, y: 240 }) : createPhase4Document("Click");
    await mount("tool.bond", seed);
    const before = molecules(current());
    const point = onAtom ? before[0].atoms[1] : { x: 240, y: 240 };
    const expected = molecules(applySingleBondToolAtPoint(seed, point));
    const target = onAtom ? container.querySelector<HTMLElement>(`[data-object-id="${before[0].id}"]`)! : page();
    await pointer("pointerdown", point, target, true);
    await pointer("pointerup", point, target, true);
    expect(molecules(current())).toEqual(expected);
    await undoOnce(before);
  });

  it("connects existing atoms without moving them to the angle grid", async () => {
    const seed = applyNativeChainTool(createPhase4Document("Close chain"), { x: 240, y: 240 }, { x: 315, y: 269 });
    await mount("tool.bond", seed);
    const before = molecules(current());
    const source = before[0].atoms[0];
    const target = before[0].atoms.at(-1)!;
    const wrapper = container.querySelector<HTMLElement>(`[data-object-id="${before[0].id}"]`)!;
    await pointer("pointerdown", source, wrapper);
    await pointer("pointermove", target, wrapper);
    expect(wrapper.dataset.freeformPreviewTargetAtomId).toBe(target.id);
    await pointer("pointerup", target, wrapper);
    const placed = molecules(current())[0];
    expect(placed.atoms).toEqual(before[0].atoms);
    expect(placed.bonds).toHaveLength(before[0].bonds.length + 1);
    expect(placed.bonds.at(-1)).toMatchObject({ fromAtomId: source.id, toAtomId: target.id });
    await undoOnce(before);
  });
});
