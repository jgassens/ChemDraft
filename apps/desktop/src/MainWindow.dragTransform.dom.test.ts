// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import * as layout from "@chemdraft/layout-engine";
import type { PageSvgElementFragment, PageSvgFragment } from "@chemdraft/layout-engine";
import { MainWindow, groupedDragObjectIdsForPointer } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe("object move retained SVG preview", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  const captureMethods = {
    set: Element.prototype.setPointerCapture, release: Element.prototype.releasePointerCapture,
    has: Element.prototype.hasPointerCapture
  };

  beforeEach(() => {
    frames = new Map();
    frameId = 0;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.set(++frameId, callback); return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
  });

  function rings(count = 2) {
    let doc = workflow.createPhase4Document("Retained drag preview");
    for (let i = 0; i < count; i++) doc = workflow.insertNativeTemplateMolecule(doc, { x: 300, y: 300 }, "benzene");
    return workflow.selectDocumentObjects(doc, doc.pages[0].id, doc.pages[0].objects.map(object => object.id));
  }
  async function mount(doc: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: doc, initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden",
      initialRulersVisible: false, initialCrosshairsVisible: false, nativePalette: false
    })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({})
    });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function move(target: EventTarget, point: { x: number; y: number }) {
    await act(async () => {
      pointer(target, "pointermove", point);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  async function flushFrames() {
    await act(async () => {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  async function start() {
    const molecule = [...snapshot().pages[0].objects].reverse().find(object => object.type === "molecule") as MoleculeObject;
    const point = molecule.atoms[0];
    const target = container.querySelector<HTMLElement>(`.native-molecule-object[data-object-id="${molecule.id}"]`)!;
    await act(async () => pointer(target, "pointerdown", point));
    return { molecule, point, target, before: snapshot() };
  }

  function oldMove(before: ChemDraftDocument, molecule: MoleculeObject, dx: number, dy: number) {
    const ids = groupedDragObjectIdsForPointer(before, molecule.id);
    return workflow.normalizeCommittedDocument(ids && ids.length > 1
      ? workflow.moveDocumentObjects(before, ids, dx, dy)
      : workflow.moveDocumentObject(before, molecule.id, { x: molecule.x + dx, y: molecule.y + dy }));
  }
  function paintedSvg() {
    return [...container.querySelectorAll(".native-molecule-overlay-visual, .page-svg-visual-layer")]
      .map(element => element.outerHTML);
  }
  function fragmentWithTag(fragments: readonly PageSvgFragment[], tag: string): PageSvgElementFragment | undefined {
    for (const fragment of fragments) {
      if (fragment.kind !== "element") continue;
      if (fragment.tag === tag) return fragment;
      const child = fragmentWithTag(fragment.children, tag);
      if (child) return child;
    }
    return undefined;
  }
  function scenario(kind: string) {
    let doc = rings(kind === "single" ? 1 : 2);
    if (kind.includes("rotated")) doc = workflow.rotateSelectedDocumentObjects90(doc);
    if (kind.includes("tilted")) {
      for (const object of doc.pages[0].objects) {
        if (object.type === "molecule") doc = workflow.tiltNativeMoleculeProjectedPlane(doc, object.id,
          { x: object.x + object.width / 2, y: object.y + object.height / 2 }, 0, 0.6,
          { tiltYRad: 0.3, persistTransform: true }).document;
      }
    }
    if (kind.includes("mixed")) {
      doc = workflow.insertNativeArtGraphicObject(doc, { x: 180, y: 180 }, "tool.art.rect");
      doc = workflow.insertNativeTextObject(doc, { x: 210, y: 210 }, "Move together");
      doc = workflow.selectDocumentObjects(doc, doc.pages[0].id, doc.pages[0].objects.map(object => object.id));
    }
    if (kind.includes("grouped")) doc = workflow.groupSelectedDocumentObjects(doc);
    return doc;
  }

  function anchoredArrowScenario(allAnchorsMoved = false) {
    let doc = rings(1);
    doc = workflow.insertNativeTemplateMolecule(doc, { x: 430, y: 350 }, "benzene");
    const [left, right] = doc.pages[0].objects as MoleculeObject[];
    doc = workflow.createMechanismArrowBetween(doc, "full-headed",
      { kind: "atom", objectId: left.id, atomId: left.atoms[0].id },
      { kind: "atom", objectId: right.id, atomId: right.atoms[0].id });
    const arrow = doc.pages[0].objects.find(object => object.type === "mechanism-arrow")!;
    return workflow.selectDocumentObjects(doc, doc.pages[0].id,
      allAnchorsMoved ? [left.id, right.id, arrow.id] : [right.id, arrow.id]);
  }

  it.each([false, true])("clears tab-switch previews and uses connected targets on the next drag (arrow: %s)", async arrow => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    await mount(arrow ? anchoredArrowScenario() : rings(1));
    const drag = await start();
    const paint = paintedSvg();
    await move(drag.target, { x: drag.point.x + 40, y: drag.point.y + 30 });
    await act(async () => container.querySelector('[aria-label="New tab"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(drag.target.isConnected).toBe(false);
    expect(drag.target.style.translate).toBe("");
    await act(async () => container.querySelector('[role="tab"][aria-selected="false"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(snapshot()).toEqual(drag.before);
    expect(paintedSvg()).toEqual(paint);
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({})
    });
    clock.mockReturnValue(2000);
    const next = await start();
    await move(next.target, { x: next.point.x + 20, y: next.point.y + 15 });
    expect(next.target.style.translate).toBe("calc(20px * var(--page-scale)) calc(15px * var(--page-scale))");
    await act(async () => pointer(next.target, "pointercancel", next.point));
    expect(snapshot()).toEqual(drag.before);
    expect(paintedSvg()).toEqual(paint);
  });

  it.each(["edit.undo", "edit.redo", "layout.rotate90"].flatMap(action =>
    [false, true].map(beforeFrame => ({ action, beforeFrame }))
  ))("cancels the retained gesture on external document install: $action (before frame: $beforeFrame)", async ({ action, beforeFrame }) => {
    await mount(rings(1));
    const initial = snapshot();
    await command("layout.rotate90");
    const rotated = snapshot();
    if (action === "edit.redo") await command("edit.undo");
    const drag = await start();
    if (beforeFrame) {
      await act(async () => pointer(drag.target, "pointermove", { x: drag.point.x + 40, y: drag.point.y + 30 }));
    } else await move(drag.target, { x: drag.point.x + 40, y: drag.point.y + 30 });
    await command(action);
    const installed = snapshot();
    if (action === "edit.undo") expect(installed).toEqual(initial);
    if (action === "edit.redo") expect(installed).toEqual(rotated);
    expect(container.querySelector("[data-object-move-preview]")).toBeNull();
    expect(drag.target.style.translate).toBe("");
    await move(drag.target, { x: drag.point.x + 60, y: drag.point.y + 50 });
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 60, y: drag.point.y + 50 }));
    await flushFrames();
    expect(snapshot()).toBe(installed);
    expect(container.querySelector("[data-object-move-preview]")).toBeNull();
    const paint = paintedSvg();
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(installed);
    expect(paintedSvg()).toEqual(paint);
  });

  it("recollects cached targets if a control wrapper detaches during the gesture", async () => {
    await mount(rings(1));
    const drag = await start();
    await move(drag.target, { x: drag.point.x + 20, y: drag.point.y + 15 });
    const original = container.querySelector<HTMLElement>(`[data-object-controls="${drag.molecule.id}"]`)!;
    const replacement = original.cloneNode(true) as HTMLElement;
    replacement.style.translate = "";
    replacement.removeAttribute("data-object-move-preview");
    original.replaceWith(replacement);
    try {
      await move(drag.target, { x: drag.point.x + 40, y: drag.point.y + 30 });
      expect(replacement.style.translate).toBe("calc(40px * var(--page-scale)) calc(30px * var(--page-scale))");
      expect(original.style.translate).toBe("");
    } finally {
      // Restore React's owned node before teardown.
      replacement.replaceWith(original);
    }
    await act(async () => pointer(drag.target, "pointercancel", drag.point));
    expect(snapshot()).toEqual(drag.before);
    expect(container.querySelector("[data-object-move-preview]")).toBeNull();
  });

  it("cancels a retained move on window blur through the Escape cancellation path", async () => {
    await mount(anchoredArrowScenario());
    const drag = await start();
    const paint = paintedSvg();
    await move(drag.target, { x: drag.point.x + 40, y: drag.point.y + 30 });
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(container.querySelector("[data-object-move-preview]")).toBeNull();
    expect(snapshot()).toEqual(drag.before);
    expect(paintedSvg()).toEqual(paint);
    await move(drag.target, { x: drag.point.x + 60, y: drag.point.y + 50 });
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 60, y: drag.point.y + 50 }));
    expect(snapshot()).toEqual(drag.before);
  });

  it.each([false, true])("places replanned arrow controls at the committed geometry (all anchors moved: %s)", async allAnchorsMoved => {
    await mount(anchoredArrowScenario(allAnchorsMoved));
    const arrow = snapshot().pages[0].objects.find(object => object.type === "mechanism-arrow")!;
    const controls = () => container.querySelector<HTMLElement>(`[data-object-controls="${arrow.id}"]`)!;
    const handles = () => [...controls().querySelectorAll<HTMLElement>(".mechanism-arrow-handle")]
      .map(element => element.getAttribute("style"));
    const initialControls = controls().getAttribute("style");
    const initialHandles = handles();
    expect(initialHandles.length).toBeGreaterThan(0);
    const drag = await start();
    await move(drag.target, { x: drag.point.x + 40, y: drag.point.y + 30 });
    expect(controls().style.translate).toBe("");
    if (!allAnchorsMoved) {
      expect(controls().getAttribute("style")).toBe(initialControls);
      expect(handles()).toEqual(initialHandles);
    }
    const previewControls = controls().getAttribute("style");
    const previewHandles = handles();
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 40, y: drag.point.y + 30 }));
    expect(controls().getAttribute("style")).toBe(previewControls);
    expect(handles()).toEqual(previewHandles);
    expect(snapshot()).toEqual(oldMove(drag.before, drag.molecule, 40, 30));
  });

  it.each(["single", "molecules", "mixed", "rotated tilted", "grouped", "mixed grouped rotated tilted"])(
    "retains SVG and commits the old path's exact document and paint: %s", async kind => {
      await mount(scenario(kind));
      const drag = await start();
      const geometry = paintedSvg();
      const moleculeSvgs = [...container.querySelectorAll(".native-molecule-overlay")];
      const descendants = moleculeSvgs.map(svg => [...svg.querySelectorAll("*")]);
      const changes: MutationRecord[] = [];
      const observer = new MutationObserver(records => changes.push(...records));
      moleculeSvgs.forEach(svg => observer.observe(svg, { subtree: true, childList: true, attributes: true }));
      const plan = vi.spyOn(layout, "planPageSvgRender");
      const moveOne = vi.spyOn(workflow, "moveDocumentObject");
      const moveMany = vi.spyOn(workflow, "moveDocumentObjects");
      for (const [dx, dy] of [[20, 10], [30, 20], [40, 30]]) {
        await move(drag.target, { x: drag.point.x + dx, y: drag.point.y + dy });
        expect(snapshot()).toBe(drag.before);
        expect(drag.target.style.translate).toContain(`${dx}px`);
        expect(drag.target.style.translate).toContain(`${dy}px`);
        moleculeSvgs.forEach((svg, index) => expect([...svg.querySelectorAll("*")]).toEqual(descendants[index]));
      }
      expect(plan).not.toHaveBeenCalled();
      expect(moveOne).not.toHaveBeenCalled();
      expect(moveMany).not.toHaveBeenCalled();
      expect(changes).toEqual([]);
      observer.disconnect();
      // Mixed selections also move the page-space SVG run; relative order never changes.
      if (kind.includes("mixed")) {
        const visual = container.querySelector("[data-page-svg-object-visual][data-object-move-preview]")!;
        expect(visual.getAttribute("transform")).toContain("translate(40 30)");
      } else expect(paintedSvg()).toEqual(geometry);
      const beforePlanCalls = plan.mock.calls.length;
      await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 40, y: drag.point.y + 30 }));
      expect(plan.mock.calls.length - beforePlanCalls).toBe(1);
      const committed = snapshot();
      const expected = oldMove(drag.before, drag.molecule, 40, 30);
      expect(committed).toEqual(expected);
      expect(container.querySelector("[data-object-move-preview]")).toBeNull();
      expect(drag.target.style.translate).toBe("");
      const paint = paintedSvg();
      await act(async () => root.unmount());
      root = createRoot(container);
      await mount(expected);
      expect(paintedSvg()).toEqual(paint);
      // A hit on the new atom starts the next move against the committed geometry.
      const next = await start();
      await move(next.target, { x: next.point.x + 15, y: next.point.y + 12 });
      await act(async () => pointer(next.target, "pointercancel", next.point));
      expect(snapshot()).toEqual(expected);
    }
  );

  it("clamps preview and release by the same delta, including anchored charge marks", async () => {
    const initial = rings();
    const molecule = initial.pages[0].objects[0] as MoleculeObject;
    let charged = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(initial, 1,
      { objectId: molecule.id, kind: "atom", atomId: molecule.atoms[0].id, distanceToPointer: 0 }));
    charged = workflow.selectDocumentObjects(charged, charged.pages[0].id, initial.selection.objectIds);
    await mount(charged);
    const drag = await start();
    const delta = workflow.documentObjectMoveDeltaResolver(drag.before, drag.molecule.id,
      groupedDragObjectIdsForPointer(drag.before, drag.molecule.id))(-1000, -1000);
    await move(drag.target, { x: drag.point.x - 1000, y: drag.point.y - 1000 });
    expect(drag.target.style.translate).toBe(`calc(${delta.x}px * var(--page-scale)) calc(${delta.y}px * var(--page-scale))`);
    const mark = drag.before.pages[0].objects.find(object => object.type === "electron-mark")!;
    expect(container.querySelector(`[data-page-svg-object-visual="${mark.id}"]`)?.getAttribute("transform"))
      .toContain(`translate(${Number(delta.x.toFixed(3))} ${Number(delta.y.toFixed(3))})`);
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x - 2000, y: drag.point.y - 2000 }));
    expect(snapshot()).toEqual(oldMove(drag.before, drag.molecule, -2000, -2000));
    expect(container.querySelector("[data-object-move-preview]")).toBeNull();
  });

  it.each([false, true])("keeps anchored arrows attached without rerendering molecules (arrow selected: %s)", async selected => {
    let doc = rings(1);
    doc = workflow.insertNativeTemplateMolecule(doc, { x: 430, y: 350 }, "benzene");
    const [left, right] = doc.pages[0].objects as MoleculeObject[];
    doc = workflow.createMechanismArrowBetween(doc, "full-headed",
      { kind: "atom", objectId: left.id, atomId: left.atoms[0].id },
      { kind: "atom", objectId: right.id, atomId: right.atoms[0].id });
    const arrow = doc.pages[0].objects.find(object => object.type === "mechanism-arrow")!;
    doc = workflow.selectDocumentObjects(doc, doc.pages[0].id, selected ? [right.id, arrow.id] : [right.id]);
    await mount(doc);
    const drag = await start();
    const originalPaint = paintedSvg();
    const plan = vi.spyOn(layout, "planPageSvgRender");
    for (const delta of [20, 30, 40]) {
      const svgBefore = [...container.querySelectorAll(".native-molecule-overlay-visual")].map(element => element.innerHTML);
      await move(drag.target, { x: drag.point.x + delta, y: drag.point.y + delta });
      expect([...container.querySelectorAll(".native-molecule-overlay-visual")].map(element => element.innerHTML)).toEqual(svgBefore);
      expect(plan.mock.calls.every(([page]) => page.objects.every(object => object.type === "mechanism-arrow"))).toBe(true);
      const expected = layout.planPageSvgRender(oldMove(drag.before, drag.molecule, delta, delta).pages[0]);
      const fragments = expected.fragments.filter(fragment => fragment.kind === "element" && fragment.attrs["data-object-id"] === arrow.id);
      const path = fragmentWithTag(fragments, "path");
      const head = fragmentWithTag(fragments, "polygon");
      if (!path || !head) throw new Error("Expected arrow geometry.");
      const visual = container.querySelector(`[data-page-svg-object-visual="${arrow.id}"]`)!;
      expect(visual.querySelector("path")?.getAttribute("d")).toBe(path.attrs.d);
      expect(visual.querySelector("polygon")?.getAttribute("points")).toBe(head.attrs.points);
      expect(visual.getAttribute("data-layer-index")).toBe("2");
      expect(visual.getAttribute("transform")).toBeNull();
      plan.mockClear();
    }
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(snapshot()).toEqual(drag.before);
    expect(paintedSvg()).toEqual(originalPaint);
    expect(container.querySelector("[data-object-move-preview]")).toBeNull();
  });

  it("retains existing crossing gaps during preview and recomputes the old path's gaps on release", async () => {
    let doc = rings(1);
    doc = workflow.insertNativeTemplateMolecule(doc, { x: 310, y: 306 }, "benzene");
    const molecule = doc.pages[0].objects[1] as MoleculeObject;
    doc = workflow.selectDocumentObjects(doc, doc.pages[0].id, [molecule.id]);
    await mount(doc);
    const drag = await start();
    expect(layout.planPageSvgRender(drag.before.pages[0]).crossings.length).toBeGreaterThan(0);
    const initialPaint = paintedSvg();
    const plan = vi.spyOn(layout, "planPageSvgRender");
    await move(drag.target, { x: drag.point.x + 60, y: drag.point.y + 50 });
    expect(paintedSvg()).toEqual(initialPaint);
    expect(plan).not.toHaveBeenCalled();
    await act(async () => pointer(drag.target, "pointerup", { x: drag.point.x + 60, y: drag.point.y + 50 }));
    expect(plan).toHaveBeenCalledTimes(1);
    const expected = oldMove(drag.before, drag.molecule, 60, 50);
    expect(snapshot()).toEqual(expected);
    expect(layout.planPageSvgRender(snapshot().pages[0]).crossings).toEqual(layout.planPageSvgRender(expected.pages[0]).crossings);
    expect(paintedSvg()).not.toEqual(initialPaint);
  });

  it.each(["Escape", "pointercancel", "tab switch", "Escape before frame", "tab switch before frame"])(
    "restores document, SVG, transforms and history exactly on %s", async cancellation => {
      await mount(scenario("mixed grouped rotated tilted"));
      const drag = await start();
      const geometry = paintedSvg();
      const transforms = [...container.querySelectorAll<HTMLElement>("[data-object-controls], .document-object")]
        .map(element => element.getAttribute("style"));
      if (cancellation.includes("before frame")) {
        await act(async () => pointer(drag.target, "pointermove", { x: drag.point.x + 40, y: drag.point.y + 30 }));
      } else await move(drag.target, { x: drag.point.x + 40, y: drag.point.y + 30 });
      if (cancellation.startsWith("Escape")) {
        await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      } else if (cancellation === "pointercancel") {
        await act(async () => pointer(drag.target, "pointercancel", drag.point));
      } else {
        await act(async () => container.querySelector('[aria-label="New tab"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })));
        const destination = snapshot();
        await act(async () => {
          pointer(container.querySelector(".page")!, "pointermove", { x: 700, y: 500 });
          pointer(container.querySelector(".page")!, "pointerup", { x: 700, y: 500 });
        });
        expect(snapshot()).toEqual(destination);
        await act(async () => container.querySelector('[role="tab"][aria-selected="false"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })));
      }
      await flushFrames();
      await act(async () => pointer(container.querySelector(".page")!, "pointerup", { x: drag.point.x + 40, y: drag.point.y + 30 }));
      expect(snapshot()).toEqual(drag.before);
      expect(paintedSvg()).toEqual(geometry);
      expect(container.querySelector("[data-object-move-preview]")).toBeNull();
      expect([...container.querySelectorAll<HTMLElement>("[data-object-controls], .document-object")]
        .map(element => element.getAttribute("style"))).toEqual(transforms);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    }
  );

  it.each(["Escape", "tab switch"])("preserves existing undo and redo stacks on %s", async cancellation => {
    await mount(scenario("mixed grouped rotated tilted"));
    const initial = snapshot();
    await command("layout.rotate90");
    await command("layout.rotate90");
    const future = snapshot();
    await command("edit.undo");
    const drag = await start();
    await move(drag.target, { x: drag.point.x + 40, y: drag.point.y + 30 });
    if (cancellation === "Escape") {
      await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    } else {
      await act(async () => container.querySelector('[aria-label="New tab"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await act(async () => container.querySelector('[role="tab"][aria-selected="false"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    }
    expect(snapshot()).toEqual(drag.before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("true");
    expect(container.querySelector("main")?.getAttribute("data-can-redo")).toBe("true");
    await command("edit.redo");
    expect(snapshot()).toEqual(future);
    await command("edit.undo");
    expect(snapshot()).toEqual(drag.before);
    await command("edit.undo");
    expect(snapshot()).toEqual(initial);
  });

  it("commits the release point before a queued frame and never reapplies that frame", async () => {
    await mount(rings());
    const drag = await start();
    await act(async () => {
      pointer(drag.target, "pointermove", { x: drag.point.x + 30, y: drag.point.y + 20 });
      pointer(drag.target, "pointerup", { x: drag.point.x + 40, y: drag.point.y + 25 });
    });
    const expected = oldMove(drag.before, drag.molecule, 40, 25);
    await flushFrames();
    expect(snapshot()).toEqual(expected);
    expect(container.querySelector("[data-object-move-preview]")).toBeNull();
  });

  it.runIf(process.env.CHEMDRAFT_DRAG_BENCH === "1")("measures 256 overlapping selected benzene rings (indicative jsdom only)", async () => {
    await mount(rings(256));
    const drag = await start();
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      const began = performance.now();
      await move(drag.target, { x: drag.point.x + 10 + i * 3, y: drag.point.y + 10 + i * 2 });
      if (i > 0) times.push(performance.now() - began);
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ benchmark: "256 overlapping benzene rings", samplesMs: times,
      medianMs: times[Math.floor(times.length / 2)] }));
    await act(async () => pointer(drag.target, "pointercancel", drag.point));
    expect(snapshot()).toEqual(drag.before);
  }, 120000);
});
