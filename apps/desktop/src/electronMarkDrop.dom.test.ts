// @vitest-environment jsdom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, applyPatches, type ChemDraftDocument, type ElectronMarkObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { atomDisplayLabel, lonePairPlacementPlanForAtom, moleculeLayoutLabelBoxes, transformPointForObject } from "@chemdraft/layout-engine";
import { createNativeTextObject, documentDrawingDefaults, nativeAtomBondOrderUsage, nativeImplicitHydrogenCount,
  phase4Timestamp, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { ensureRdkit, resetRdkitForTesting, setRdkitModuleLoader } from "../../../packages/rdkit-adapter/src/conformer";
import { inspectStructureInWorker } from "./depiction2d/identityInspect";
import { MainWindow } from "./MainWindow";
import * as workflow from "./documentWorkflow";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { saveDirectElectronMarkEditing } from "./electronMarkEditingSettings";
import { ammoniumElectronMarkDropFixture, distantAttachedElectronMarkFixture, dropMark, dropMolecule,
  electronMarkDropFixture, fourBondNitrogenElectronMarkDropFixture, rotatedElectronMarkDropFixture } from "./testSupport/electronMarkDropFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }

describe.each(["macos", "windows"] as const)("electron-mark drops on %s", platform => {
describe.each([false, true])("electron-mark drop interaction with direct editing %s", enabled => {
  let container: HTMLDivElement, root: Root;
  let handleStyles: HTMLStyleElement;
  let frames: Map<number, FrameRequestCallback>, frameId: number;
  const captureMethods = { set: Element.prototype.setPointerCapture,
    release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    saveDirectElectronMarkEditing(enabled);
    // jsdom has no layout. Read the actual handle CSS for coordinate-based targeting below.
    handleStyles = document.createElement("style");
    handleStyles.textContent = [...readFileSync(resolve("apps/desktop/src/App.css"), "utf8")
      .matchAll(/[^{}]*\.object-resize-[^{}]*\{[^{}]*\}/g)].map(match => match[0]).join("\n");
    document.head.append(handleStyles);
    frames = new Map(); frameId = 0;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); handleStyles.remove();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    Element.prototype.setPointerCapture = captureMethods.set;
    Element.prototype.releasePointerCapture = captureMethods.release;
    Element.prototype.hasPointerCapture = captureMethods.has;
  });
  async function mount(document: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, { initialDocument: document,
      initialActiveToolCommandId: "tool.select", initialPaletteMode: "hidden", nativePalette: false,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform })));
    container.querySelector<HTMLElement>(".page")!.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: 792, bottom: 612, width: 792, height: 612, toJSON: () => ({}) });
  }
  const snapshot = () => window.__CHEMDRAFT_AGENT__!.snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const highlighted = () => container.querySelector("[data-delete-hover-atom-id]")?.getAttribute("data-delete-hover-atom-id");
  const page = () => container.querySelector(".page")!;
  function pointer(target: EventTarget, type: string, point: { x: number; y: number }, altKey = false) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y, altKey });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: "mouse" } });
    target.dispatchEvent(event);
  }
  async function command(commandId: string) {
    await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId } })));
  }
  async function start() {
    const mark = dropMark(snapshot());
    // Pick painted ink on both preference paths; a rectangular grab area is optional.
    const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle`)!;
    expect(target).not.toBeNull();
    await act(async () => pointer(target, "pointerdown", workflow.nativeChargeMarkCenter(mark)));
    return { target, mark };
  }
  async function move(target: EventTarget, point: { x: number; y: number }) {
    await act(async () => {
      pointer(target, "pointermove", point);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  function labels() {
    const molecule = dropMolecule(snapshot());
    return molecule.atoms.map(atom => atomDisplayLabel(atom, molecule.bonds, undefined, molecule.atoms));
  }

  describe("lone-pair placement with real DOM pointer events", () => {
    beforeAll(() => {
      // jsdom rewrites import.meta.url to HTTP; load the real vendored WASM by filesystem path.
      const glue = resolve("packages/rdkit-adapter/vendor/RDKit_minimal.js");
      const factory = new Function("require", "__dirname", `${readFileSync(glue, "utf8")}\n;return initRDKitModule;`)(
        createRequire(glue), resolve("packages/rdkit-adapter/vendor"));
      setRdkitModuleLoader(() => factory({ wasmBinary: new Uint8Array(readFileSync(resolve("packages/rdkit-adapter/vendor/RDKit_minimal.wasm"))) }));
    });
    afterAll(() => resetRdkitForTesting());
    const pairs = () => snapshot().pages[0].objects.filter((object): object is ElectronMarkObject =>
      object.type === "electron-mark" && object.markKind === "lone-pair");
    async function pressAtom(route: "object" | "page" = "object", offset = { x: 0, y: 0 }, rotation = 0) {
      const fixture = electronMarkDropFixture({ kind: "lone-pair" });
      const withoutMark = applyPatch(fixture.document,
        { op: "removeObject", objectId: dropMark(fixture.document).id }, { now: phase4Timestamp });
      const initial = workflow.normalizeCommittedDocument({ ...withoutMark, pages: withoutMark.pages.map(page => ({
        ...page, objects: page.objects.map(object => object.type === "molecule" ? { ...object,
          x: object.x + offset.x, y: object.y + offset.y, rotation,
          atoms: object.atoms.map(atom => ({ ...atom, x: atom.x + offset.x, y: atom.y + offset.y }))
        } : object)
      })) });
      await mount(initial);
      await command("tool.lonePair");
      const molecule = dropMolecule(initial);
      const localAtom = molecule.atoms.find(atom => atom.id === fixture.carbonylOxygen.id)!;
      const atom = { ...localAtom, ...transformPointForObject(molecule, localAtom) };
      // The page route covers bare vertices whose hover resolves the atom before the press.
      await act(async () => pointer(page(), "pointermove", atom));
      const target = route === "page" ? page() : container.querySelector(`[data-hit-target="atom"][data-atom-id="${atom.id}"]`)!;
      expect(target).not.toBeNull();
      const before = snapshot();
      await act(async () => pointer(target, "pointerdown", { x: atom.x + 1, y: atom.y }));
      expect(snapshot()).toEqual(before);
      expect(pairs()).toHaveLength(0);
      const end = (degrees: number) => ({ x: atom.x + 55 * Math.cos(degrees * Math.PI / 180),
        y: atom.y + 55 * Math.sin(degrees * Math.PI / 180) });
      return { before, target, atom, end };
    }
    async function assertSingleUndo(before: ChemDraftDocument, after: ChemDraftDocument) {
      await command("edit.undo");
      expect(status()).toBe("Undid Add Lone Pair");
      expect(snapshot()).toEqual(before);
      await command("edit.undo");
      expect(snapshot()).toEqual(before); // No preview or duplicate release created another entry.
      await command("edit.redo");
      expect(status()).toBe("Redid Add Lone Pair");
      expect(snapshot()).toEqual(after);
    }
    it.each(["object", "page"] as const)("auto-places a click through the %s route, only on release", async route => {
      const { before, target, atom } = await pressAtom(route);
      await act(async () => pointer(target, "pointermove", { x: atom.x + 2, y: atom.y }));
      expect(snapshot()).toEqual(before); // Sub-threshold movement remains a click.
      await act(async () => pointer(target, "pointerup", atom));
      expect(pairs()).toHaveLength(1);
      const molecule = dropMolecule(before), pageBefore = before.pages[0];
      const expected = lonePairPlacementPlanForAtom(molecule, atom.id, pageBefore.objects, pageBefore.width, pageBefore.height)!;
      expect(workflow.nativeChargeMarkCenter(pairs()[0])).toEqual(expected.center);
      expect(pairs()[0].rotation).toBe(expected.rotation);
      await assertSingleUndo(before, snapshot());
    });
    it("explains when a click has no gap that fits inside the page", async () => {
      const { before, target, atom } = await pressAtom("object", { x: 0, y: -226 });
      await act(async () => pointer(target, "pointerup", atom));
      expect(status()).toBe("Cannot place a lone pair on this atom: there is no room inside the page.");
      expect(snapshot()).toEqual(before);
      expect(pairs()).toHaveLength(0);
      await command("edit.undo");
      expect(snapshot()).toEqual(before);
    });
    it("refuses an off-page drag without substituting an automatic direction and explains how to fix it", async () => {
      const fixture = electronMarkDropFixture({ kind: "lone-pair" });
      const { before, target, end } = await pressAtom("object", {
        x: fixture.document.pages[0].width - 12 - fixture.carbonylOxygen.x, y: 0
      });
      const molecule = dropMolecule(before), pageBefore = before.pages[0];
      expect(lonePairPlacementPlanForAtom(molecule, molecule.atoms[10].id, pageBefore.objects,
        pageBefore.width, pageBefore.height)).toBeDefined();
      await act(async () => pointer(target, "pointermove", end(0)));
      expect(pairs()).toHaveLength(0);
      await act(async () => pointer(target, "pointerup", end(0)));
      expect(status()).toBe("Cannot place the lone pair there: it would fall outside the page. Drag toward the page.");
      expect(snapshot()).toEqual(before);
      await command("edit.undo");
      expect(snapshot()).toEqual(before);
    });
    it.each([false, true])("previews a 100° drag (Alt %s), commits once and preserves chemistry", async altKey => {
      const { before, target, atom, end } = await pressAtom();
      const moleculeBefore = dropMolecule(before);
      const module = await ensureRdkit();
      const identity = inspectStructureInWorker(module, stereoPerceptionMolfile(moleculeBefore));
      expect(identity.valid).toBe(true);
      if (!identity.valid) throw new Error(identity.reason);
      expect(identity.canonicalSmiles).not.toBe("");
      await act(async () => pointer(target, "pointermove", end(100), altKey));
      expect(pairs()).toHaveLength(1);
      const preview = pairs()[0];
      expect(preview.rotation).toBeCloseTo((altKey ? 100 : 105) + 90, 8);
      const previewCenter = workflow.nativeChargeMarkCenter(preview);
      expect(Math.atan2(previewCenter.y - atom.y, previewCenter.x - atom.x) * 180 / Math.PI).toBeCloseTo(altKey ? 100 : 105, 8);
      const rendered = container.querySelector(`[data-page-svg-object-visual="${preview.id}"]`);
      expect(rendered).not.toBeNull();
      expect(rendered!.querySelectorAll("circle")).toHaveLength(2);
      await act(async () => pointer(target, "pointerup", end(100), altKey));
      const after = snapshot();
      expect(pairs()).toEqual([preview]);
      expect(dropMolecule(after)).toEqual(moleculeBefore);
      expect(dropMolecule(after).atoms).toHaveLength(moleculeBefore.atoms.length);
      expect(dropMolecule(after).bonds).toHaveLength(moleculeBefore.bonds.length);
      expect(inspectStructureInWorker(module, stereoPerceptionMolfile(dropMolecule(after)))).toEqual(identity);
      await act(async () => pointer(target, "pointerup", end(100), altKey));
      expect(snapshot()).toEqual(after);
      await assertSingleUndo(before, after);
    });
    it.each(["object", "page"] as const)("places a rightward drag from a rotated atom through the %s route", async route => {
      const { before, target, atom, end } = await pressAtom(route, { x: 0, y: 0 }, 90);
      await act(async () => pointer(target, "pointermove", end(0)));
      const [pair] = pairs();
      expect(pair).toBeDefined();
      const center = workflow.nativeChargeMarkCenter(pair);
      const molecule = dropMolecule(before);
      expect(center.x - atom.x).toBeGreaterThanOrEqual(24.3 - 1e-8);
      expect(center.y).toBeCloseTo(atom.y, 10);
      expect(pair.rotation).toBeCloseTo(90, 10);
      expect(pair.anchor).toEqual({ kind: "atom", objectId: molecule.id, atomId: atom.id });
      await act(async () => pointer(target, "pointerup", end(0)));
      expect(pairs()).toEqual([pair]);
      expect(dropMolecule(snapshot())).toEqual(molecule);
      await assertSingleUndo(before, snapshot());
    });
    it("uses the release point and its Alt state after multiple preview frames", async () => {
      const { before, target, end } = await pressAtom();
      for (const degrees of [30, 65, 100]) {
        await act(async () => pointer(target, "pointermove", end(degrees)));
        expect(pairs()).toHaveLength(1);
      }
      await act(async () => pointer(page(), "pointerup", end(110), true));
      expect(pairs()[0].rotation).toBeCloseTo(200, 8);
      await assertSingleUndo(before, snapshot());
    });
    it.each(["Escape", "object cancel", "page cancel", "lost capture"])("cancels on %s with no document change or undo entry", async cancel => {
      const { before, target, end } = await pressAtom();
      await act(async () => pointer(target, "pointermove", end(100)));
      const previewId = pairs()[0].id;
      await act(async () => {
        if (cancel === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        else pointer(cancel === "page cancel" ? page() : target,
          cancel === "lost capture" ? "lostpointercapture" : "pointercancel", end(100));
      });
      expect(snapshot()).toEqual(before);
      expect(pairs()).toHaveLength(0);
      expect(container.querySelector(`[data-page-svg-object-visual="${previewId}"]`)).toBeNull();
      await act(async () => pointer(target, "pointerup", end(100)));
      expect(snapshot()).toEqual(before);
      await command("edit.undo");
      expect(snapshot()).toEqual(before);
      await command("edit.redo");
      expect(snapshot()).toEqual(before);
    });
  });

  async function selectedMark(zoom: number, rotation: number, size = 18) {
    let initial = electronMarkDropFixture().document;
    const mark = dropMark(initial);
    initial = applyPatch(initial, { op: "updateObject", objectId: mark.id,
      changes: { x: 450, y: 350, width: size, height: size, rotation, chargeStyle: "circled" } }, { now: phase4Timestamp });
    initial = workflow.selectDocumentObjects(initial, initial.pages[0].id, [mark.id]);
    await mount(initial);
    if (zoom !== 1) await act(async () => {
      container.querySelector(".canvas-region")!.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(zoom) / 0.002
      }));
    });
    expect((window.__CHEMDRAFT_AGENT__!.snapshot().viewport as { scale: number }).scale).toBeCloseTo(zoom);
    return snapshot();
  }
  function handleBoxes(zoom: number) {
    const mark = dropMark(snapshot());
    const frame = container.querySelector<HTMLElement>(`[data-object-controls="${mark.id}"] [data-art-transform-frame]`);
    if (!frame) return [];
    const value = (key: string, fallback: number) => {
      const number = /calc\(([-\d.]+)px/.exec(frame.style.getPropertyValue(key));
      return (number ? Number(number[1]) : fallback) * zoom;
    };
    const left = mark.x * zoom + value("left", 0), top = mark.y * zoom + value("top", 0);
    const width = value("width", mark.width), height = value("height", mark.height);
    return [...frame.querySelectorAll<HTMLButtonElement>("[data-object-resize-corner]")].map(handle => {
      const css = getComputedStyle(handle), w = Number.parseFloat(css.width), h = Number.parseFloat(css.height);
      const corner = handle.dataset.objectResizeCorner!;
      const x = left + (corner.endsWith("left") ? Number.parseFloat(css.left) : width - Number.parseFloat(css.right) - w);
      const y = top + (corner.startsWith("top") ? Number.parseFloat(css.top) : height - Number.parseFloat(css.bottom) - h);
      expect([x, y, w, h].every(Number.isFinite)).toBe(true);
      return { handle, x, y, width: w, height: h, frame: { x: left, y: top, width, height } };
    });
  }
  function resizeHandleAt(point: { x: number; y: number }, zoom: number) {
    // Resolve HTML corner hit boxes using production offsets. Dispatching straight to the
    // SVG would bypass the bug: jsdom does not implement elementFromPoint/layout.
    return handleBoxes(zoom).reverse().find(box => point.x >= box.x && point.x <= box.x + box.width &&
      point.y >= box.y && point.y <= box.y + box.height)?.handle;
  }
  function targetAt(point: { x: number; y: number }, zoom: number) {
    const mark = dropMark(snapshot());
    // The canvas grab target stays available with either direct-editing setting.
    return resizeHandleAt(point, zoom) ?? container.querySelector(`[data-electron-mark-hit-target="${mark.id}"]`) ??
      container.querySelector(`[data-page-svg-object-visual="${mark.id}"] line:last-child`)!;
  }
  async function exactUndoRedo(before: ChemDraftDocument, after: ChemDraftDocument, label: string) {
    await command("edit.undo"); expect(status()).toBe(`Undid ${label}`); expect(snapshot()).toEqual(before);
    // A second Undo must have nothing else to undo: the gesture committed exactly once.
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(snapshot()).toEqual(after);
  }

  const markViews = [0.5, 1, 2].flatMap(zoom => [0, 37].map(rotation => ({ zoom, rotation })));
  it.each(markViews)("moves a selected mark from its center at zoom $zoom, rotation $rotation in one undo step", async ({ zoom, rotation }) => {
    const before = await selectedMark(zoom, rotation), mark = dropMark(before);
    const center = { x: (mark.x + mark.width / 2) * zoom, y: (mark.y + mark.height / 2) * zoom };
    const end = { x: center.x + 40 * zoom, y: center.y + 30 * zoom };
    const target = targetAt(center, zoom);
    expect(target).toBe(container.querySelector(`[data-electron-mark-hit-target="${mark.id}"]`));
    expect(target.tagName).toBe("rect");
    expect(Number(target.getAttribute("x")) + Number(target.getAttribute("width")) / 2).toBeCloseTo(center.x / zoom);
    expect(Number(target.getAttribute("y")) + Number(target.getAttribute("height")) / 2).toBeCloseTo(center.y / zoom);
    await act(async () => pointer(target, "pointerdown", center));
    await move(page(), end);
    await act(async () => pointer(page(), "pointerup", end));
    const after = snapshot(), moved = dropMark(after);
    expect(moved).toMatchObject({ x: mark.x + 40, y: mark.y + 30,
      width: mark.width, height: mark.height, rotation: mark.rotation });
    expect(status()).toBe("Moved electron mark");
    expect(dropMolecule(after)).toEqual(dropMolecule(before));
    expect(container.querySelectorAll(".object-resize-compact")).toHaveLength(enabled ? 1 : 0);
    expect(container.querySelectorAll("[data-object-resize-corner]")).toHaveLength(enabled ? 4 : 0);
    await exactUndoRedo(before, after, "Move electron mark");
  });

  const cornerViews = markViews.flatMap(view => ["top-left", "top-right", "bottom-left", "bottom-right"]
    .map(corner => ({ ...view, corner })));
  it.runIf(enabled).each(cornerViews)("resizes a selected mark from $corner at zoom $zoom, rotation $rotation in one undo step", async ({ zoom, rotation, corner }) => {
    const before = await selectedMark(zoom, rotation), mark = dropMark(before);
    const box = handleBoxes(zoom).find(box => box.handle.dataset.objectResizeCorner === corner)!;
    // Review P2-a/P2-b: 18px at -15px -> 11px at -8px preserves the 3px
    // overlap while restoring the ordinary reach beside atoms and page edges.
    expect(box).toMatchObject({ width: 11, height: 11 });
    const css = getComputedStyle(box.handle);
    expect(corner.endsWith("left") ? css.left : css.right).toBe("-8px");
    expect(corner.startsWith("top") ? css.top : css.bottom).toBe("-8px");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(targetAt(point, zoom)).toBe(box.handle);
    const center = { x: (mark.x + mark.width / 2) * zoom, y: (mark.y + mark.height / 2) * zoom };
    const end = { x: center.x + 1.5 * (point.x - center.x), y: center.y + 1.5 * (point.y - center.y) };
    await act(async () => pointer(box.handle, "pointerdown", point));
    await move(page(), end);
    await act(async () => pointer(page(), "pointerup", end));
    const after = snapshot();
    expect(dropMark(after).width).toBeGreaterThan(mark.width);
    expect(dropMark(after).height).toBeGreaterThan(mark.height);
    expect(status()).toBe("Resized electron mark");
    expect(dropMolecule(after)).toEqual(dropMolecule(before));
    await exactUndoRedo(before, after, "Resize electron mark");
  });

  it.runIf(enabled).each(markViews)("leaves a press 12px outside the bottom-left corner clear of resize handles at zoom $zoom, rotation $rotation", async ({ zoom, rotation }) => {
    const before = await selectedMark(zoom, rotation);
    const boxes = handleBoxes(zoom);
    expect(boxes).toHaveLength(4);
    const { frame } = boxes[0];
    const point = { x: frame.x - 12, y: frame.y + frame.height + 12 };
    // An adjacent atom here was covered by the old -15px compact targets (P2-a).
    expect(resizeHandleAt(point, zoom)).toBeUndefined();
    await act(async () => pointer(page(), "pointerdown", point));
    await act(async () => pointer(page(), "pointerup", point));
    expect(dropMark(snapshot())).toEqual(dropMark(before));
  });

  it.runIf(enabled).each([
    { size: 53, zoom: 1, rotation: 0, compact: true },
    { size: 54, zoom: 1, rotation: 0, compact: false },
    { size: 54, zoom: 0.5, rotation: 0, compact: true },
    { size: 27, zoom: 2, rotation: 0, compact: false },
    { size: 40, zoom: 1, rotation: 45, compact: false }
  ])("uses screen frame size for compact handles: $size px, zoom $zoom, rotation $rotation", async ({ size, zoom, rotation, compact }) => {
    await selectedMark(zoom, rotation, size);
    expect(container.querySelectorAll(".object-resize-compact")).toHaveLength(compact ? 1 : 0);
  });

  it("keeps normal rectangle handle offsets unchanged", async () => {
    const initial = workflow.createPhase4Document("Normal art handles");
    initial.pages[0].objects = [{ id: "rectangle", type: "graphic", graphicKind: "rect", x: 100, y: 100,
      width: 160, height: 120, rotation: 0, style: {}, data: {} }];
    initial.selection.objectIds = ["rectangle"];
    await mount(initial);
    expect(container.querySelector(".object-resize-compact")).toBeNull();
    const handles = [...container.querySelectorAll<HTMLElement>("[data-object-resize-corner]")];
    expect(handles).toHaveLength(4);
    for (const handle of handles) {
      const css = getComputedStyle(handle), corner = handle.dataset.objectResizeCorner!;
      expect(css.width).toBe("18px"); expect(css.height).toBe("18px");
      expect(corner.endsWith("left") ? css.left : css.right).toBe("-8px");
      expect(corner.startsWith("top") ? css.top : css.bottom).toBe("-8px");
    }
  });

  it.each((["radical-dot", "lone-pair", "charge", "unknown"] as const).flatMap(markKind =>
    (["atom", "bond"] as const).map(part => ({ markKind, part }))))(
    "selects and drags a tiny $markKind beside a $part from blank grab space, yielding to the nearer part", async ({ markKind, part }) => {
      const base = workflow.insertNativeSingleBondMolecule(workflow.createPhase4Document("Small mark target"), { x: 300, y: 300 });
      const molecule = dropMolecule(base), [a, b] = molecule.atoms;
      const partPoint = part === "atom" ? a : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const center = { x: partPoint.x, y: partPoint.y - 16 };
      const mark: ElectronMarkObject = { id: "tiny-mark", type: "electron-mark", markKind,
        x: center.x - 1, y: center.y - 1, width: 2, height: 2, rotation: 0, style: {},
        ...(markKind === "charge" ? { charge: 1 } : {}),
        anchor: { kind: "point", point: center }, atomAssociation: "explicit" };
      const drawing = { ...base, pages: [{ ...base.pages[0], objects: [molecule, mark] }],
        selection: { ...base.selection, objectIds: [] } };
      await mount(drawing);
      const beforeSvg = exportDocumentToSvg(snapshot()).contents;
      const catcher = () => container.querySelector<SVGRectElement>(`[data-electron-mark-hit-target="${mark.id}"]`)!;
      expect(catcher()).not.toBeNull();
      expect(Number(catcher().getAttribute("width"))).toBe(36);
      expect(Number(catcher().getAttribute("height"))).toBe(36);
      // Beyond the previous 24px target and far from the painted dot, but nearer the mark.
      const start = { x: center.x, y: center.y - 14 };
      expect(start.y).toBeGreaterThan(Number(catcher().getAttribute("y")));
      await act(async () => pointer(catcher(), "pointerdown", start));
      await act(async () => pointer(catcher(), "pointerup", start));
      expect(snapshot().selection.objectIds).toEqual([mark.id]);
      expect(dropMark(snapshot())).toEqual(mark);
      expect(exportDocumentToSvg(snapshot()).contents).toBe(beforeSvg);
      const end = { x: start.x + 60, y: start.y - 40 };
      await act(async () => pointer(catcher(), "pointerdown", start));
      await move(catcher(), end);
      await act(async () => pointer(catcher(), "pointerup", end));
      expect(dropMark(snapshot())).toMatchObject({ x: mark.x + 60, y: mark.y - 40, width: 2, height: 2 });
      expect(dropMolecule(snapshot())).toEqual(molecule);
      await command("edit.undo");
      expect(dropMark(snapshot())).toEqual(mark);
      expect(exportDocumentToSvg(snapshot()).contents).toBe(beforeSvg);
      // The enlarged catcher is above this part; send it the event as the browser would.
      // Both a nearby point and the exact atom/bond must still select that molecule part.
      let pressTime = Date.now();
      const clock = vi.spyOn(Date, "now");
      for (const point of [{ x: partPoint.x, y: partPoint.y - 4 }, partPoint]) {
        clock.mockReturnValue(pressTime += 1000); // Independent clicks, not a double-click drill-in.
        await act(async () => pointer(catcher(), "pointerdown", point));
        await act(async () => pointer(moleculeTarget(), "pointerup", point));
        expect(snapshot().selection.objectIds).not.toContain(mark.id);
        expect(window.__CHEMDRAFT_AGENT__!.snapshot().selectedNativeMoleculePart).toMatchObject({
          objectId: molecule.id, kind: part, ...(part === "atom" ? { atomId: a.id } : { bondId: molecule.bonds[0].id })
        });
        expect(dropMark(snapshot())).toEqual(mark);
      }
      function moleculeTarget() { return container.querySelector(`[data-object-id="${molecule.id}"]`)!; }
    });

  it.each([
    ["tool.plus", "Add Charge"], ["tool.minus", "Add Charge"],
    ["tool.radical", "Add Radical"], ["tool.lonePair", "Add Lone Pair"],
    ["tool.radicalCation", "Add Charge"], ["tool.radicalAnion", "Add Charge"]
  ])("labels %s placement on both an atom and empty canvas", async (tool, label) => {
    const initial = workflow.insertNativeSingleBondMolecule(workflow.createPhase4Document("Mark labels"), { x: 300, y: 300 });
    await mount(initial);
    const atom = dropMolecule(snapshot()).atoms[0];
    for (const point of [atom, { x: 600, y: 500 }]) {
      await command(tool);
      await act(async () => pointer(page(), "pointermove", point));
      const before = snapshot();
      await act(async () => pointer(page(), "pointerdown", point));
      await act(async () => pointer(page(), "pointerup", point));
      const after = snapshot();
      expect(after).not.toEqual(before);
      await command("edit.undo");
      expect(status()).toBe(`Undid ${label}`);
      expect(snapshot()).toEqual(before);
      await command("edit.redo");
      expect(status()).toBe(`Redid ${label}`);
      expect(snapshot()).toEqual(after);
      await command("edit.undo");
    }
  });

  it.each([1, -1] as const)("labels reducing and removing a %s charge", async sign => {
    await mount(electronMarkDropFixture({ kind: "charge", charge: sign }).document);
    const atom = dropMolecule(snapshot()).atoms[7];
    for (const [tool, label] of [
      [sign > 0 ? "tool.plus" : "tool.minus", "Add Charge"],
      [sign > 0 ? "tool.minus" : "tool.plus", "Remove Charge"],
      [sign > 0 ? "tool.minus" : "tool.plus", "Remove Charge"]
    ]) {
      await command(tool);
      await act(async () => pointer(page(), "pointermove", atom));
      const before = snapshot();
      await act(async () => pointer(page(), "pointerdown", atom));
      await act(async () => pointer(page(), "pointerup", atom));
      const after = snapshot();
      expect(after).not.toEqual(before);
      await command("edit.undo"); expect(status()).toBe(`Undid ${label}`); expect(snapshot()).toEqual(before);
      await command("edit.redo"); expect(status()).toBe(`Redid ${label}`); expect(snapshot()).toEqual(after);
    }
  });

  it("keeps repeated charge-tool clicks stacked through +9, warning beyond carbon's valence", async () => {
    const ethane = workflow.insertNativeSingleBondMolecule(workflow.createPhase4Document("Carbon charge stacking"), { x: 300, y: 300 });
    const molecule = dropMolecule(ethane);
    const methane = workflow.applyNativeMoleculeDeleteTarget(ethane, {
      objectId: molecule.id, kind: "bond", bondId: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002",
      terminalAtomId: "atom_002", distanceToPointer: 0
    });
    await mount(methane);
    const atom = dropMolecule(snapshot()).atoms[0];
    await command("tool.plus");
    await act(async () => pointer(page(), "pointermove", atom));
    expect(highlighted()).toBe(atom.id);
    const atomTarget = () => container.querySelector(`[data-hit-target="atom"][data-atom-id="${atom.id}"]`)!;
    const clickAtom = async () => {
      expect(atomTarget()).not.toBeNull();
      await act(async () => pointer(atomTarget(), "pointerdown", atom));
      await act(async () => pointer(atomTarget(), "pointerup", atom));
    };
    let markId: string | undefined;
    // Drawing edits preserve the requested charge and warn; only the ±9 format cap refuses.
    for (let charge = 1; charge <= 9; charge++) {
      await clickAtom();
      const after = snapshot(), mark = dropMark(after);
      markId ??= mark.id;
      expect(after.pages[0].objects.filter(object => object.type === "electron-mark"), `press ${charge}`).toHaveLength(1);
      expect(mark).toMatchObject({ id: markId, charge,
        anchor: { kind: "atom", objectId: molecule.id, atomId: atom.id } });
      expect(dropMolecule(after).atoms[0]).toMatchObject({ formalCharge: charge, markCharge: charge });
      expect(status()).toBe(`Placed positive charge${charge > 1 ? ` ${charge}+` : ""} on hovered atom`);
      if (charge > 4) {
        // Valence warnings identify the charged atom within the molecule.
        expect(dropMolecule(after).chemistry?.warnings).toContainEqual(expect.objectContaining({
          code: "chemistry.invalid_valence", objectId: atom.id
        }));
      }
    }
    const charged = snapshot();
    await clickAtom();
    expect(snapshot()).toBe(charged);
    expect(status()).toBe("Charge is already at the ±9 limit");
    await command("edit.undo");
    expect(status()).toBe("Undid Add Charge");
    expect(dropMolecule(snapshot()).atoms[0]).toMatchObject({ formalCharge: 8, markCharge: 8 });
    await command("edit.redo");
    expect(status()).toBe("Redid Add Charge");
    expect(snapshot()).toEqual(charged);
  });

  it.each(["object", "page"])("moves charge through the full Boc-glycine sequence with one exact undo/redo step per %s drop", async route => {
    const { document, nitrogen, carbonylOxygen, hydroxylOxygen } = electronMarkDropFixture();
    await mount(document);
    const reporter = vi.spyOn(workflow, "electronMarkChemistryChanges");
    const states = [snapshot()];
    for (const [point, message, expectedLabels] of [
      [carbonylOxygen, "Charge moved from N to O (O now OH, N now NH)", ["NH", "OH", "OH"]],
      [hydroxylOxygen, "Charge moved from O (C=O) to O (OH) (OH now OH2, C=O now O)", ["NH", "O", "OH2"]],
      [nitrogen, "Charge moved from O to N (N now NH2, O now OH)", ["NH2", "O", "OH"]]
    ] as const) {
      const drag = await start(), before = snapshot(), calls = reporter.mock.calls.length;
      await move(drag.target, point);
      expect(snapshot()).toBe(before);
      expect(reporter).toHaveBeenCalledTimes(calls);
      expect(highlighted()).toBe(point.id);
      expect(container.querySelector(".native-atom-hover")).not.toBeNull();
      await act(async () => pointer(route === "page" ? page() : drag.target, "pointerup", point));
      expect(highlighted()).toBeUndefined();
      expect(status()).toBe(message);
      expect(reporter).toHaveBeenCalledTimes(calls + 1);
      expect([labels()[7], labels()[10], labels()[11]]).toEqual(expectedLabels);
      // Real DOM pointer events commit geometry as well as chemistry, for both release routes.
      const mark = dropMark(snapshot()), molecule = dropMolecule(snapshot());
      const targetLabel = moleculeLayoutLabelBoxes(molecule).find(label => molecule.atoms[label.atom].id === point.id)!;
      expect(mark.x < targetLabel.x + targetLabel.width && mark.x + mark.width > targetLabel.x &&
        mark.y < targetLabel.y + targetLabel.height && mark.y + mark.height > targetLabel.y).toBe(false);
      const after = snapshot(); states.push(after);
      await command("edit.undo");
      expect(status()).toBe("Undid Move Charge");
      expect(snapshot()).toEqual(before);
      await command("edit.redo");
      expect(snapshot()).toEqual(after);
      expect(reporter).toHaveBeenCalledTimes(calls + 1);
    }
    for (const state of states.slice(0, -1).reverse()) {
      await command("edit.undo");
      expect(snapshot()).toEqual(state);
    }
    for (const state of states.slice(1)) {
      await command("edit.redo");
      expect(snapshot()).toEqual(state);
    }
  });

  it.each(["object", "page"])("dissociates ammonium on a far %s drop, reattaches on return, and undoes each drag exactly once", async route => {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    await mount(document);
    const before = snapshot(), drag = await start(), end = { x: 600, y: 500 };
    expect(labels()[0]).toBe("NH4");
    await move(drag.target, end);
    expect(highlighted()).toBeUndefined();
    expect(snapshot()).toBe(before);
    await act(async () => pointer(route === "page" ? page() : drag.target, "pointerup", end));
    const detached = snapshot();
    expect(dropMark(detached).anchor).toEqual({ kind: "point", point: end });
    expect(dropMolecule(detached).atoms[0]).toMatchObject({ formalCharge: 0 });
    expect(dropMolecule(detached).atoms[0].markCharge).toBeUndefined();
    expect(labels()[0]).toBe("NH3");
    expect(status()).toBe("Charge removed from N (N now NH3)");
    await command("edit.undo");
    expect(status()).toBe("Undid Move Charge");
    expect(snapshot()).toEqual(before);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(snapshot()).toEqual(detached);
    await command("edit.redo"); expect(snapshot()).toEqual(detached);

    const returning = await start();
    await move(returning.target, nitrogen);
    expect(highlighted()).toBe(nitrogen.id);
    await act(async () => pointer(route === "page" ? page() : returning.target, "pointerup", nitrogen));
    const attached = snapshot();
    expect(dropMark(attached).anchor).toEqual(dropMark(before).anchor);
    expect(dropMolecule(attached)).toEqual(dropMolecule(before));
    expect(labels()[0]).toBe("NH4");
    expect(status()).toBe("Charge attached to N (N now NH4)");
    await command("edit.undo");
    expect(status()).toBe("Undid Move Charge");
    expect(snapshot()).toEqual(detached);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(snapshot()).toEqual(detached);
    await command("edit.redo"); expect(snapshot()).toEqual(attached);
  });

  async function dragAtom(objectId: string, from: { x: number; y: number }, to: { x: number; y: number }) {
    const target = container.querySelector(`.native-molecule-object[data-object-id="${objectId}"]`)!;
    expect(target).not.toBeNull();
    await act(async () => pointer(target, "pointerdown", from));
    const before = snapshot();
    await move(page(), to);
    const preview = snapshot();
    await act(async () => pointer(page(), "pointerup", to));
    return { before, preview };
  }

  it("labels Undo when nitrogen moves away from its stationary charge", async () => {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    const molecule = dropMolecule(document);
    await mount(document);
    const end = { x: nitrogen.x + 100, y: nitrogen.y + 100 };
    const { before } = await dragAtom(molecule.id, nitrogen, end);
    const after = snapshot();
    expect(dropMolecule(after).atoms[0]).toMatchObject({ ...end, formalCharge: 0 });
    expect(dropMark(after)).toMatchObject({ x: dropMark(before).x, y: dropMark(before).y, anchor: { kind: "point" } });
    expect(labels()[0]).toBe("NH3");
    expect.soft(status()).toBe("Charge removed from N (N now NH3)");
    await exactUndoRedo(before, after, "Move and Remove Charge");
  });

  it("refuses an atom drag that would leave a neutral four-bond nitrogen", async () => {
    const { document, nitrogen } = fourBondNitrogenElectronMarkDropFixture();
    await mount(document);
    const { before, preview } = await dragAtom(dropMolecule(document).id, nitrogen, { x: nitrogen.x + 100, y: nitrogen.y + 100 });
    expect(status()).toMatch(/^Cannot move Charge from N.*bond\/radical valence 4/);
    expect(preview).toEqual(before);
    expect(snapshot()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it("names a charge transfer to oxygen when nitrogen moves away from a stationary mark", async () => {
    const { document, nitrogen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const mark = dropMark(document);
    await mount(applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      x: nitrogen.x - 19 - mark.width / 2, y: nitrogen.y - 14 - mark.height / 2
    } }, { now: phase4Timestamp }));
    const { before } = await dragAtom(molecule.id, nitrogen, { x: nitrogen.x + 100, y: nitrogen.y + 100 });
    expect(dropMark(before).anchor.atomId).toBe(nitrogen.id);
    const after = snapshot();
    expect(dropMark(after)).toMatchObject({
      x: dropMark(before).x, y: dropMark(before).y, anchor: { kind: "atom", atomId: molecule.atoms[6].id }
    });
    expect(status()).toBe("Charge moved from N to O (O now OH, N now NH)");
    await exactUndoRedo(before, after, "Move and Transfer Charge");
  });

  function rotatedMoleculeWithCharge(drawing: ChemDraftDocument, center: { x: number; y: number },
    anchor: ElectronMarkObject["anchor"] = { kind: "point", point: center }) {
    const mark = dropMark(drawing);
    return applyPatches(drawing, [
      { op: "updateObject", objectId: dropMolecule(drawing).id, changes: { rotation: 90 } },
      { op: "updateObject", objectId: mark.id, changes: { atomAssociation: undefined,
        anchor, x: center.x - mark.width / 2, y: center.y - mark.height / 2 } }
    ], { now: phase4Timestamp });
  }

  const legacyAnchorCases = (["bond", "object"] as const).flatMap(anchorKind => [
    { anchorKind, name: "four-bond N+", fixture: fourBondNitrogenElectronMarkDropFixture,
      chemistry: { formalCharge: 1, markCharge: 1 } },
    { anchorKind, name: "N radical", fixture: () => electronMarkDropFixture({ kind: "radical-dot" }),
      chemistry: { formalCharge: 0, markRadicals: 1 } }
  ]);

  function legacyNitrogenMark(anchorKind: "bond" | "object", fixture: typeof electronMarkDropFixture) {
    const { document, nitrogen, saturatedCarbon } = fixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const bond = molecule.bonds.find(bond => bond.fromAtomId === nitrogen.id || bond.toAtomId === nitrogen.id)!;
    const anchor: ElectronMarkObject["anchor"] = anchorKind === "bond"
      ? { kind: "bond", objectId: molecule.id, bondId: bond.id }
      : { kind: "object", objectId: molecule.id };
    const drawing = applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      anchor, atomAssociation: undefined, x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2
    } }, { now: phase4Timestamp });
    return { drawing, anchor, molecule, mark, nitrogen, saturatedCarbon };
  }

  it.each(legacyAnchorCases)("keeps the $anchorKind anchor and $name through a text insertion and native save/reopen",
    ({ anchorKind, fixture, chemistry }) => {
      const { drawing, anchor, molecule, mark, nitrogen } = legacyNitrogenMark(anchorKind, fixture);
      const edited = workflow.normalizeCommittedDocument(workflow.insertNativeTextObject(drawing, { x: 400, y: 400 }, "Caption"));
      expect(edited.pages[0].objects).toHaveLength(drawing.pages[0].objects.length + 1);
      const saved = workflow.createNativeSavePayload(edited);
      const reopened = workflow.openNativeDocument(saved.contents).document!;
      for (const document of [edited, reopened, workflow.normalizeCommittedDocument(reopened)]) {
        expect(dropMark(document).id).toBe(mark.id);
        expect(dropMark(document).anchor).toEqual(anchor);
        expect(dropMolecule(document).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject(chemistry);
        expect(dropMolecule(document).structure).toBe(molecule.structure);
      }
    });

  it.each(legacyAnchorCases)("preserves the $anchorKind anchor and $name when dragging a part of its rotated molecule",
    async ({ anchorKind, fixture, chemistry }) => {
      const { drawing, anchor, molecule, mark, nitrogen, saturatedCarbon } = legacyNitrogenMark(anchorKind, fixture);
      const rotated = applyPatch(drawing, { op: "updateObject", objectId: molecule.id, changes: { rotation: 90 } });
      await mount(rotated);
      const start = transformPointForObject(dropMolecule(rotated), saturatedCarbon);
      const end = { x: start.x - 100, y: start.y + 100 };
      const { before, preview } = await dragAtom(molecule.id, start, end);
      const after = snapshot();
      expect(dropMolecule(after).atoms.find(atom => atom.id === saturatedCarbon.id)).not.toEqual(saturatedCarbon);
      for (const document of [before, preview, after]) {
        expect(dropMark(document).id).toBe(mark.id);
        expect(dropMark(document).anchor).toEqual(anchor);
        expect(dropMolecule(document).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject(chemistry);
      }
      await exactUndoRedo(before, after, "Move");
    });

  it.each(["bond", "object"] as const)("refuses to drag four-bond N away from its legacy %s-anchored charge",
    async anchorKind => {
      const { drawing, anchor, molecule, nitrogen } = legacyNitrogenMark(anchorKind, fourBondNitrogenElectronMarkDropFixture);
      const rotated = applyPatch(drawing, { op: "updateObject", objectId: molecule.id, changes: { rotation: 90 } });
      await mount(rotated);
      const start = transformPointForObject(dropMolecule(rotated), nitrogen);
      const { before, preview } = await dragAtom(molecule.id, start, { x: start.x + 100, y: start.y + 100 });
      expect(dropMark(before).anchor).toEqual(anchor);
      expect(dropMolecule(before).atoms.find(atom => atom.id === nitrogen.id)).toMatchObject({ formalCharge: 1, markCharge: 1 });
      expect(status()).toMatch(/^Cannot move Charge from N(?: to \w+)?: N cannot carry formal charge 0 with bond\/radical valence 4$/);
      expect(preview).toEqual(before);
      expect(snapshot()).toEqual(before);
      expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
    });

  it("names a valid charge removal without changing its legacy object anchor", async () => {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    const anchor = { kind: "object", objectId: molecule.id } as const;
    const drawing = applyPatch(document, { op: "updateObject", objectId: mark.id, changes: {
      anchor, atomAssociation: undefined, x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2
    } }, { now: phase4Timestamp });
    await mount(drawing);
    const { before } = await dragAtom(molecule.id, nitrogen, { x: nitrogen.x + 100, y: nitrogen.y + 100 });
    const after = snapshot();
    expect(dropMark(after)).toEqual(dropMark(before));
    expect(dropMolecule(after).atoms[0].formalCharge).toBe(0);
    expect(status()).toBe("Charge removed from N (N now NH3)");
    await exactUndoRedo(before, after, "Move and Remove Charge");
  });

  function legacyNitrogenMarks(bondCount: number, charge: number, secondCharge?: number) {
    const { document, nitrogen } = ammoniumElectronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document), pageId = document.pages[0].id;
    // Space the neighbors outside the mark's association radius so moving N leaves the marks free.
    const hydrogens = [[-56, 0], [56, 0], [0, -56], [0, 56]].slice(0, bondCount).map(([dx, dy], index) => ({
      id: `legacy_h${index}`, element: "H", formalCharge: 0, x: nitrogen.x + dx, y: nitrogen.y + dy
    }));
    const bonds = hydrogens.map(atom => ({
      id: `bond_${atom.id}`, fromAtomId: nitrogen.id, toAtomId: atom.id, order: "single" as const
    }));
    const placement = { x: nitrogen.x - mark.width / 2, y: nitrogen.y - mark.height / 2, atomAssociation: undefined };
    const secondMark: ElectronMarkObject = { ...mark, ...placement, id: "legacy_second_mark",
      markKind: secondCharge === undefined ? "radical-dot" : "charge", charge: secondCharge,
      anchor: { kind: "bond", objectId: molecule.id, bondId: bonds[0].id } };
    const drawing = workflow.normalizeCommittedDocument(applyPatches(document, [
      { op: "updateObject", objectId: molecule.id, changes: {
        x: nitrogen.x - 56, y: nitrogen.y - 56, width: 112, height: bondCount === 4 ? 112 : 56,
        atoms: [...molecule.atoms, ...hydrogens], bonds
      } },
      { op: "updateObject", objectId: mark.id, changes: {
        ...placement, charge, anchor: { kind: "object", objectId: molecule.id }
      } },
      { op: "addObject", pageId, object: secondMark }
    ], { now: phase4Timestamp }));
    return { drawing, molecule, nitrogen, marks: [mark.id, secondMark.id] };
  }

  async function moveNitrogenAway(fixture: ReturnType<typeof legacyNitrogenMarks>, operation: "part drag" | "group rotation") {
    const { drawing, molecule, nitrogen } = fixture;
    if (operation === "part drag") {
      await mount(drawing);
      return (await dragAtom(molecule.id, nitrogen, { x: nitrogen.x + 100, y: nitrogen.y + 100 })).before;
    }

    const pageId = drawing.pages[0].id;
    const caption = createNativeTextObject(drawing, { x: 620, y: 250 }, "Caption");
    const withCaption = applyPatch(drawing, { op: "addObject", pageId, object: caption }, { now: phase4Timestamp });
    await mount(workflow.selectDocumentObjects(withCaption, pageId, [molecule.id, caption.id]));
    const before = snapshot();
    const frame = container.querySelector<HTMLElement>("[data-group-selection]")!;
    const frameNumber = (key: "left" | "top" | "width" | "height") => Number(/calc\(([-\d.]+)px/.exec(frame.style[key])![1]);
    const center = { x: frameNumber("left") + frameNumber("width") / 2, y: frameNumber("top") + frameNumber("height") / 2 };
    const handle = frame.querySelector("[data-group-rotate-handle]")!;
    const end = { x: center.x + 150, y: center.y };
    await act(async () => pointer(handle, "pointerdown", { x: center.x, y: frameNumber("top") - 20 }));
    await move(page(), end);
    await act(async () => pointer(page(), "pointerup", end));
    return before;
  }

  const legacyMarkOperations = ["part drag", "group rotation"] as const;
  const validLegacyDetachments = [{ marks: "opposite charges", secondCharge: -1 }, { marks: "a charge and a radical" }];
  it.each(validLegacyDetachments.flatMap(example => legacyMarkOperations.map(operation => ({ ...example, operation }))))(
    "detaches $marks from three-bond N during a $operation", async ({ operation, secondCharge }) => {
      const fixture = legacyNitrogenMarks(3, 1, secondCharge);
      const before = await moveNitrogenAway(fixture, operation);
      const after = snapshot();
      const nitrogenIn = (document: ChemDraftDocument) => dropMolecule(document).atoms.find(atom => atom.id === fixture.nitrogen.id)!;
      const beforeAssignments = workflow.committedElectronMarkAssignments(before.pages[0]).anchorByMarkId;
      const afterAssignments = workflow.committedElectronMarkAssignments(after.pages[0]).anchorByMarkId;
      expect(nitrogenIn(before).formalCharge).toBe(secondCharge === undefined ? 1 : 0);
      expect(nitrogenIn(before).markRadicals ?? 0).toBe(secondCharge === undefined ? 1 : 0);
      expect(status()).toMatch(/^Charge removed from N/);
      expect(dropMolecule(after)).not.toEqual(dropMolecule(before));
      expect(nitrogenIn(after).formalCharge).toBe(0);
      expect(nitrogenIn(after).markCharge ?? 0).toBe(0);
      expect(nitrogenIn(after).markRadicals ?? 0).toBe(0);
      for (const markId of fixture.marks) {
        expect(beforeAssignments.get(markId)).toEqual({ objectId: fixture.molecule.id, atomId: fixture.nitrogen.id });
        expect(afterAssignments.get(markId)).toBeUndefined();
        expect(workflow.findDocumentObject(after, markId)).toEqual(workflow.findDocumentObject(before, markId));
      }
      await exactUndoRedo(before, after, operation === "part drag" ? "Move and Remove Charge" : "Rotate selection and Remove Charge");
    });

  it.each(legacyMarkOperations)("names the invalid final valence when both charges would detach during a %s", async operation => {
    const fixture = legacyNitrogenMarks(4, 2, -1);
    const before = await moveNitrogenAway(fixture, operation);
    expect(dropMolecule(before).atoms[0]).toMatchObject({ formalCharge: 1, markCharge: 1 });
    expect(status()).toBe("Cannot move Charge from N: N cannot carry formal charge 0 with bond/radical valence 4");
    expect(snapshot()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each(["point", "bond", "object"] as const)("preserves the %s anchor when only a rotated carbon's raw coordinates reach the mark", async kind => {
    const { document, saturatedCarbon } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    // Start on the rotation pivot so the raw and drawn positions agree at the press.
    const start = { x: molecule.x + molecule.width / 2, y: saturatedCarbon.y };
    const center = { x: start.x - 100, y: start.y + 100 };
    const drawing = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: {
      atoms: molecule.atoms.map(atom => atom.id === saturatedCarbon.id ? { ...atom, ...start } : atom)
    } });
    const anchor: ElectronMarkObject["anchor"] = kind === "point"
      ? { kind, point: center }
      : { kind, objectId: molecule.id, ...(kind === "bond" ? { bondId: molecule.bonds[0].id } : {}) };
    await mount(rotatedMoleculeWithCharge(drawing, center, anchor));
    const { before } = await dragAtom(molecule.id, start, center);
    expect(dropMark(before).anchor).toEqual(anchor);
    const after = snapshot();
    const moved = dropMolecule(after);
    const carbon = moved.atoms.find(atom => atom.id === saturatedCarbon.id)!;
    expect(Math.hypot(carbon.x - center.x, carbon.y - center.y)).toBeLessThan(1);
    const drawn = transformPointForObject(moved, carbon);
    expect(Math.hypot(drawn.x - center.x, drawn.y - center.y)).toBeGreaterThan(26);
    expect(dropMark(after).anchor).toEqual(anchor);
    expect(carbon.formalCharge).toBe(0);
    await command("edit.undo");
    expect(snapshot()).toEqual(before);
    await command("edit.redo");
    expect(snapshot()).toEqual(after);
    const saved = workflow.createNativeSavePayload(snapshot());
    const reopened = workflow.openNativeDocument(saved.contents).document!;
    expect(dropMark(reopened).anchor).toEqual(anchor);
    expect(dropMark(workflow.normalizeCommittedDocument(reopened)).anchor).toEqual(anchor);
  });

  it("leaves a legacy floating plus by a stationary rotated oxygen when another molecule's atom moves", async () => {
    const { document, carbonylOxygen } = electronMarkDropFixture();
    const molecule = dropMolecule(document);
    const center = transformPointForObject({ ...molecule, rotation: 90 }, carbonylOxygen);
    const drawing = workflow.insertNativeSingleBondMolecule(rotatedMoleculeWithCharge(document, center), { x: 440, y: 420 });
    await mount(workflow.selectDocumentObjects(drawing, drawing.pages[0].id, []));
    const other = snapshot().pages[0].objects.find(object => object.type === "molecule" && object.id !== molecule.id);
    if (other?.type !== "molecule") throw new Error("Expected a second molecule");
    const start = other.atoms[0];
    const { before } = await dragAtom(other.id, start, { x: start.x, y: start.y + 10 });
    const after = snapshot();
    const moved = workflow.findDocumentObject(after, other.id);
    expect(moved).not.toEqual(other);
    expect(dropMark(before).anchor.kind).toBe("point");
    expect(dropMark(after)).toEqual(dropMark(before));
    expect(dropMolecule(after)).toEqual(dropMolecule(before));
    expect(status()).toBe("Moved selected molecule part");
  });

  async function mountMarkAndTextSelection(drawing: ChemDraftDocument, addThirdObject = false) {
    const mark = dropMark(drawing), pageId = drawing.pages[0].id;
    const text = createNativeTextObject(drawing, { x: 120, y: 125 }, "Caption");
    let withText = applyPatch(drawing, { op: "addObject", pageId, object: text }, { now: phase4Timestamp });
    const selected = [mark.id, text.id];
    if (addThirdObject) {
      const other = createNativeTextObject(withText, { x: 620, y: 300 }, "Another caption");
      withText = applyPatch(withText, { op: "addObject", pageId, object: other }, { now: phase4Timestamp });
      selected.push(other.id);
    }
    await mount(workflow.selectDocumentObjects(withText, pageId, selected));
    return { mark, text, before: snapshot() };
  }

  const selectionCommands = {
    "rotate 90°": "layout.rotate90", flip: "layout.flipHorizontal", align: "layout.alignLeft", distribute: "layout.distributeHorizontal"
  } as const;
  const selectionTransforms = ["resize", "rotate handle", "rotate 90°", "flip", "align", "distribute", "nudge"] as const;
  const nitrogenFixtures = [
    { molecule: "four-bond N+", fixture: fourBondNitrogenElectronMarkDropFixture, refused: true },
    { molecule: "NH4+", fixture: ammoniumElectronMarkDropFixture, refused: false }
  ];
  it.each(nitrogenFixtures.flatMap(example => selectionTransforms.map(transform => ({ ...example, transform }))))(
    "checks a $transform of the $molecule charge and a text box as one edit", async ({ fixture, refused, transform }) => {
      const { document, nitrogen } = fixture();
      const original = dropMark(document);
      const drawing = transform === "nudge" ? applyPatch(document, { op: "updateObject", objectId: original.id, changes: {
        x: nitrogen.x + 22 - original.width / 2, y: nitrogen.y + 9 - original.height / 2
      } }, { now: phase4Timestamp }) : document;
      const { before, mark, text } = await mountMarkAndTextSelection(drawing, transform === "distribute");
      expect(dropMark(before).anchor.atomId).toBe(nitrogen.id);
      let undoLabel: string | undefined;
      if (transform === "resize" || transform === "rotate handle") {
        const frame = container.querySelector<HTMLElement>("[data-group-selection]")!;
        const frameNumber = (key: "left" | "top" | "width" | "height") => Number(/calc\(([-\d.]+)px/.exec(frame.style[key])![1]);
        const left = frameNumber("left"), top = frameNumber("top"), width = frameNumber("width"), height = frameNumber("height");
        const center = { x: left + width / 2, y: top + height / 2 };
        const resize = transform === "resize";
        const handle = frame.querySelector(resize ? '[data-object-resize-corner="top-right"]' : "[data-group-rotate-handle]")!;
        const start = resize ? { x: left + width, y: top } : { x: center.x, y: top - 20 };
        const end = resize ? { x: center.x + width, y: center.y - height } : { x: center.x + height, y: center.y };
        await act(async () => pointer(handle, "pointerdown", start));
        await move(page(), end);
        if (refused) expect(snapshot()).toEqual(before);
        await act(async () => pointer(page(), "pointerup", end));
        undoLabel = resize ? "Resize selection and Remove Charge" : "Rotate selection and Remove Charge";
      } else if (transform === "nudge") {
        await act(async () => page().dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true
        })));
        undoLabel = "Move and Remove Charge";
      } else {
        await command(selectionCommands[transform]);
        if (transform === "align") undoLabel = "Align Left and Remove Charge";
        if (transform === "distribute") undoLabel = "Distribute Horizontally and Remove Charge";
      }

      const after = snapshot();
      if (refused) {
        expect(status()).toBe("Cannot move Charge from N: N cannot carry formal charge 0 with bond/radical valence 4");
        expect(after).toEqual(before);
        expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
      } else {
        expect(dropMark(after)).toMatchObject({ id: mark.id, anchor: { kind: "point" }, atomAssociation: "explicit" });
        expect(dropMolecule(after).atoms[0]).toMatchObject({ formalCharge: 0 });
        expect(labels()[0]).toBe("NH3");
        expect(status()).toBe("Charge removed from N (N now NH3)");
        if (transform !== "align" && transform !== "distribute") expect(workflow.findDocumentObject(after, text.id)).not.toEqual(text);
        if (undoLabel) await exactUndoRedo(before, after, undoLabel);
        else {
          await command("edit.undo"); expect(snapshot()).toEqual(before);
          await command("edit.redo"); expect(snapshot()).toEqual(after);
        }
      }
    }
  );

  it("refuses a charge and text drag off a four-bond N as a unit", async () => {
    const { document } = fourBondNitrogenElectronMarkDropFixture();
    const { before } = await mountMarkAndTextSelection(document);
    const { target } = await start();
    const end = { x: 600, y: 500 };
    await move(target, end);
    await act(async () => pointer(target, "pointerup", end));
    expect(status()).toBe("Cannot move Charge from N: N cannot carry formal charge 0 with bond/radical valence 4");
    expect(snapshot()).toEqual(before);
    expect(container.querySelector("main")?.getAttribute("data-can-undo")).toBe("false");
  });

  it.each([
    { name: "ammonium charge", fixture: ammoniumElectronMarkDropFixture, label: "NH3",
      status: "Charge removed from N (N now NH3)" },
    { name: "radical", fixture: () => electronMarkDropFixture({ kind: "radical-dot" }), label: "NH",
      status: "Radical electron removed from N (N now NH)" },
    { name: "lone pair", fixture: () => electronMarkDropFixture({ kind: "lone-pair" }), label: "NH",
      status: "Lone pair removed from N" }
  ])("dissociates a selected $name when dragging its selected text companion", async ({ fixture, label, status: message }) => {
    const { document, nitrogen } = fixture();
    const { mark, text, before } = await mountMarkAndTextSelection(document);
    const target = container.querySelector(`[data-page-svg-object-visual="${text.id}"] text`)!;
    expect(target).not.toBeNull();
    const delta = { x: 330, y: 235 };
    const end = { x: text.x + delta.x, y: text.y + delta.y };
    await act(async () => pointer(target, "pointerdown", text));
    await move(target, end);
    expect(snapshot()).toEqual(before);
    await act(async () => pointer(page(), "pointerup", end));

    const after = snapshot();
    const center = workflow.nativeChargeMarkCenter(mark);
    expect(dropMark(after)).toMatchObject({
      x: mark.x + delta.x, y: mark.y + delta.y, atomAssociation: "explicit",
      anchor: { kind: "point", point: { x: center.x + delta.x, y: center.y + delta.y } }
    });
    expect(workflow.findDocumentObject(after, text.id)).toEqual({ ...text, x: end.x, y: end.y });
    const molecule = dropMolecule(after), atom = molecule.atoms.find(atom => atom.id === nitrogen.id)!;
    expect(atom.formalCharge).toBe(0);
    expect(atom.markCharge).toBeUndefined();
    expect(atom.markRadicals).toBeUndefined();
    expect(labels()[molecule.atoms.indexOf(atom)]).toBe(label);
    if (mark.markKind === "lone-pair") expect(molecule).toEqual(dropMolecule(before));
    expect(status()).toBe(message);
    await exactUndoRedo(before, after, mark.markKind === "charge" ? "Move and Remove Charge" : "Move");
  });

  it("keeps a selected charge, radical and lone pair attached when their selected molecule moves", async () => {
    const { document, nitrogen, carbonylOxygen } = electronMarkDropFixture();
    const molecule = dropMolecule(document), pageId = document.pages[0].id;
    let drawing = workflow.applyChargeToolAtNativeAtom(document, { kind: "radical-dot" },
      { kind: "atom", objectId: molecule.id, atomId: nitrogen.id, distanceToPointer: 0 });
    drawing = workflow.normalizeCommittedDocument(workflow.applyChargeToolAtNativeAtom(drawing, { kind: "lone-pair" },
      { kind: "atom", objectId: molecule.id, atomId: carbonylOxygen.id, distanceToPointer: 0 }));
    const marks = (document: ChemDraftDocument) => document.pages[0].objects.filter(object => object.type === "electron-mark");
    const initialMarks = marks(drawing);
    expect(initialMarks.map(mark => mark.markKind)).toEqual(["charge", "radical-dot", "lone-pair"]);
    await mount(workflow.selectDocumentObjects(drawing, pageId, [molecule.id, ...initialMarks.map(mark => mark.id)]));
    const before = snapshot(), { target, mark } = await start();
    const center = workflow.nativeChargeMarkCenter(mark);
    const end = { x: center.x + 100, y: center.y + 100 };
    await move(target, end);
    await act(async () => pointer(target, "pointerup", end));
    const after = snapshot(), originalMolecule = dropMolecule(before);
    expect(marks(after)).toEqual(marks(before).map(mark => ({ ...mark, x: mark.x + 100, y: mark.y + 100 })));
    expect(dropMolecule(after)).toEqual({ ...originalMolecule, x: originalMolecule.x + 100, y: originalMolecule.y + 100,
      atoms: originalMolecule.atoms.map(atom => ({ ...atom, x: atom.x + 100, y: atom.y + 100 })) });
    expect(status()).toBe("Moved selected object");
    await exactUndoRedo(before, after, "Move");
  });

  it("carries an ammonium molecule together with its mark in one exactly reversible drag", async () => {
    const { document } = ammoniumElectronMarkDropFixture();
    const molecule = dropMolecule(document), mark = dropMark(document);
    await mount(workflow.groupSelectedDocumentObjects(workflow.selectDocumentObjects(document,
      document.pages[0].id, [molecule.id, mark.id])));
    const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"] circle`)!;
    expect(target).not.toBeNull();
    const point = workflow.nativeChargeMarkCenter(mark);
    await act(async () => pointer(target, "pointerdown", point));
    const before = snapshot();
    await move(target, { x: point.x + 100, y: point.y + 100 });
    await act(async () => pointer(target, "pointerup", { x: point.x + 100, y: point.y + 100 }));
    const after = snapshot(), movedMark = dropMark(after);
    expect(movedMark.anchor).toEqual(mark.anchor);
    expect(workflow.nativeChargeMarkCenter(movedMark)).toEqual({ x: point.x + 100, y: point.y + 100 });
    expect(dropMolecule(after).atoms[0]).toMatchObject({ formalCharge: 1, markCharge: 1,
      x: molecule.atoms[0].x + 100, y: molecule.atoms[0].y + 100 });
    expect(labels()[0]).toBe("NH4");
    await command("edit.undo");
    expect(status()).toBe("Undid Move group");
    expect(snapshot()).toEqual(before);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(snapshot()).toEqual(after);
  });

  it.each([20, 8])("commits a floating charge released %s px from O with accurate status", async separation => {
    const fixture = electronMarkDropFixture();
    const document = workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 }));
    await mount(document);
    const before = snapshot(), drag = await start();
    const point = { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - separation };
    await move(drag.target, point);
    expect(highlighted()).toBe(separation === 8 ? fixture.carbonylOxygen.id : undefined);
    await act(async () => pointer(drag.target, "pointerup", point));
    if (separation === 20) {
      expect(dropMark(snapshot()).anchor.kind).toBe("point");
      expect(dropMolecule(snapshot())).toEqual(dropMolecule(before));
      expect(status()).toBe("Moved electron mark");
    } else {
      expect(dropMark(snapshot()).anchor.atomId).toBe(fixture.carbonylOxygen.id);
      expect(dropMolecule(snapshot()).atoms[10]).toMatchObject({ formalCharge: 1, markCharge: 1 });
      expect(labels()[10]).toBe("OH");
      expect(status()).toBe("Charge attached to O (O now OH)");
    }
    const after = snapshot();
    await command("edit.undo"); expect(snapshot()).toEqual(before);
    await command("edit.redo"); expect(snapshot()).toEqual(after);
  });

  it.each(["Select All", "selection click"])("keeps a deliberately floating drop neutral after %s", async action => {
    const fixture = electronMarkDropFixture();
    await mount(workflow.normalizeCommittedDocument(workflow.moveDocumentObject(fixture.document,
      dropMark(fixture.document).id, { x: 591, y: 491 })));
    const drag = await start();
    const point = { x: fixture.carbonylOxygen.x, y: fixture.carbonylOxygen.y - 20 };
    await move(drag.target, point);
    expect(highlighted()).toBeUndefined();
    await act(async () => pointer(drag.target, "pointerup", point));
    expect(status()).toBe("Moved electron mark");
    const after = snapshot(), mark = dropMark(after), molecule = dropMolecule(after);
    expect(mark.anchor.kind).toBe("point");
    expect(molecule.atoms[10].formalCharge).toBe(0);
    if (action === "Select All") {
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "a", bubbles: true, metaKey: platform === "macos", ctrlKey: platform === "windows"
      })));
      expect(status()).toBe("Selected 2 canvas objects");
    } else {
      await act(async () => pointer(page(), "pointerdown", { x: 650, y: 500 }));
      await act(async () => pointer(page(), "pointerup", { x: 650, y: 500 }));
    }
    expect(snapshot().selection).not.toEqual(after.selection);
    expect(dropMolecule(snapshot()).atoms[10].formalCharge).toBe(0);
    expect(dropMolecule(snapshot())).toEqual(molecule);
    expect(dropMark(snapshot())).toEqual(mark);
  });

  it.each([0, 180])("previews and commits the rendered O target in a molecule rotated %s degrees", async rotation => {
    await mount(rotatedElectronMarkDropFixture(rotation));
    const molecule = dropMolecule(snapshot()), oxygen = molecule.atoms[0], nitrogen = molecule.atoms[3];
    const point = { x: rotation === 180 ? 200 : 100, y: 110 };
    const drag = await start(), before = snapshot();
    await move(drag.target, point);
    expect(snapshot()).toBe(before);
    expect(highlighted()).toBe(oxygen.id);
    await act(async () => pointer(drag.target, "pointerup", point));
    expect(dropMark(snapshot()).anchor.atomId).toBe(oxygen.id);
    expect(dropMolecule(snapshot()).atoms.find(atom => atom.id === oxygen.id)?.formalCharge).toBe(1);
    expect(dropMolecule(snapshot()).atoms.find(atom => atom.id === nitrogen.id)?.formalCharge).toBe(0);
    const center = workflow.nativeChargeMarkCenter(dropMark(snapshot()));
    const renderedOxygen = transformPointForObject(molecule, oxygen);
    const renderedNitrogen = transformPointForObject(molecule, nitrogen);
    const oxygenDistance = Math.hypot(center.x - renderedOxygen.x, center.y - renderedOxygen.y);
    // Match the unit regression's bound, based on the unrotated placement distance.
    expect(oxygenDistance).toBeLessThanOrEqual(documentDrawingDefaults(snapshot()).bondLengthPx * 1.5);
    expect(Math.hypot(center.x - renderedNitrogen.x, center.y - renderedNitrogen.y)).toBeGreaterThan(oxygenDistance);
    expect(status()).toBe("Charge attached to O (O now H2O)");
  });

  it.each([1, -1] as const)("keeps a legacy distant radical ion on its atom when neutralising charge %s", async charge => {
    const fixture = distantAttachedElectronMarkFixture({ kind: "charge", charge, radical: true });
    await mount(fixture.document);
    const distant = snapshot(), original = dropMark(distant);
    await act(async () => pointer(page(), "pointermove", fixture.sourceAtom));
    await command(charge > 0 ? "tool.minus" : "tool.plus");
    await act(async () => pointer(page(), "pointerdown", fixture.sourceAtom));
    const neutral = snapshot(), molecule = dropMolecule(neutral);
    const atom = molecule.atoms.find(atom => atom.id === fixture.sourceAtom.id)!;
    expect(dropMark(neutral)).toMatchObject({ id: original.id, markKind: "radical-dot",
      anchor: original.anchor, atomAssociation: "explicit", x: original.x, y: original.y });
    expect(atom).toMatchObject({ formalCharge: 0, markRadicals: 1 });
    expect(nativeImplicitHydrogenCount(workflow.nativeElementFromAtomLabel(atom.element)!,
      nativeAtomBondOrderUsage(atom.id, molecule.bonds, molecule.atoms), atom.formalCharge, atom.markRadicals)).toBe(charge > 0 ? 0 : 2);
    expect(status()).toBe("Placed radical electron on hovered atom");
    await command("edit.undo"); expect(snapshot()).toEqual(distant);
    expect(status()).toBe("Undid Remove Charge");
    await command("edit.redo"); expect(snapshot()).toEqual(neutral);
    expect(status()).toBe("Redid Remove Charge");
  });

  it("highlights a refused target, reports why, and leaves no undo entry", async () => {
    const { document, saturatedCarbon } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start();
    await move(drag.target, saturatedCarbon);
    expect(highlighted()).toBe(saturatedCarbon.id);
    await act(async () => pointer(drag.target, "pointerup", saturatedCarbon));
    expect(snapshot()).toEqual(before);
    expect(status()).toBe("Cannot move Charge from N to C: C cannot carry formal charge +1 with bond/radical valence 4");
    expect(highlighted()).toBeUndefined();
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });

  it.each(["Escape", "object cancel", "page cancel"])("clears the attachment highlight and preserves chemistry on %s", async cancel => {
    const { document, carbonylOxygen } = electronMarkDropFixture(); await mount(document);
    const before = snapshot(), drag = await start();
    await move(drag.target, carbonylOxygen);
    expect(highlighted()).toBe(carbonylOxygen.id);
    await act(async () => {
      if (cancel === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else pointer(cancel === "page cancel" ? page() : drag.target, "pointercancel", carbonylOxygen);
    });
    expect(highlighted()).toBeUndefined();
    expect(snapshot()).toEqual(before);
    await act(async () => pointer(drag.target, "pointerup", carbonylOxygen));
    expect(snapshot()).toEqual(before);
  });

  it.each(["radical-dot", "lone-pair", "unknown"] as const)("attaches a dragged %s through painted ink with either preference", async kind => {
    const fixture = electronMarkDropFixture({ kind: kind === "unknown" ? "lone-pair" : kind });
    const document = kind === "unknown" ? applyPatch(fixture.document, { op: "updateObject",
      objectId: dropMark(fixture.document).id, changes: { markKind: "unknown" } }, { now: phase4Timestamp }) : fixture.document;
    await mount(document);
    const before = snapshot();
    // Unknown marks render as a fallback glyph rather than a dot; their wrapper still owns the drag.
    const mark = dropMark(before);
    const target = container.querySelector(`[data-page-svg-object-visual="${mark.id}"]`)!;
    await act(async () => pointer(target, "pointerdown", workflow.nativeChargeMarkCenter(mark)));
    await move(target, fixture.hydroxylOxygen);
    expect(highlighted()).toBe(fixture.hydroxylOxygen.id);
    await act(async () => pointer(target, "pointerup", fixture.hydroxylOxygen));
    expect(dropMark(snapshot()).anchor.atomId).toBe(fixture.hydroxylOxygen.id);
    expect(dropMolecule(snapshot()).atoms[7].markRadicals ?? 0).toBe(0);
    expect(dropMolecule(snapshot()).atoms[11].markRadicals ?? 0).toBe(kind === "radical-dot" ? 1 : 0);
    await command("edit.undo"); expect(snapshot()).toEqual(before);
  });
});
});
