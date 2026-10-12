// @vitest-environment jsdom

import { Resvg } from "@resvg/resvg-js";
import * as layoutEngine from "@chemdraft/layout-engine";
import { DOM_COMMAND_EVENT, PALETTE_COMMAND_PREVIEW_EVENT, PALETTE_COMMAND_CANCEL_EVENT, PALETTE_COMMAND_COMMIT_EVENT } from "./window-manager";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, DocumentObject, MoleculeObject, TextObject, GraphicObject } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { nativeMoleculeRings, planPageSvgRender } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import {
  createPhase4Document,
  applyChargeToolAtPoint,
  createMechanismArrowBetween,
  insertNativeArtGraphicObject,
  insertNativeTemplateMolecule,
  insertNativeTextObject,
  nativeBezierPathDocument,
  attachSpin3dModel,
  buildSpin3dModel
} from "./documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fills = [
  { name: "solid", style: { fillColor: "#ef8a24", fillOpacity: 0.8 } },
  {
    name: "gradient",
    style: {
      fillOpacity: 0.9,
      fillPaint: {
        kind: "linear-gradient", units: "object", x1: 0, y1: 0, x2: 1, y2: 1,
        stops: [{ offset: 0, color: "#ffb347" }, { offset: 1, color: "#ef6c00" }]
      }
    }
  },
  {
    name: "glow",
    style: {
      fillColor: "#ef8a24", fillOpacity: 0.8,
      visualEffects: [{ kind: "glow", color: "#ffb347", opacity: 0.8, blurPx: 12, spreadPx: 4 }]
    }
  }
];

function ringLetterDocument(ringStyle: Record<string, unknown>) {
  // Art before the letters exercises the full-page index, rather than a type-filtered index.
  const withArt = insertNativeArtGraphicObject(createPhase4Document("Ring letters"), { x: 40, y: 40 }, "tool.art.rect");
  const withRing = insertNativeTemplateMolecule(withArt, { x: 300, y: 300 }, "benzene");
  const molecule = withRing.pages[0].objects[1];
  if (molecule.type !== "molecule") throw new Error("Expected benzene.");
  const ring = nativeMoleculeRings(molecule)[0]!;
  const withBackLetter = insertNativeTextObject(withRing, { x: ring.center.x - 8, y: ring.center.y - 12 }, "A");
  const withFrontLetter = insertNativeTextObject(withBackLetter, { x: ring.center.x - 8, y: ring.center.y - 12 }, "B");
  const [art, , backLetter, frontLetter] = withFrontLetter.pages[0].objects;
  const styledMolecule = { ...molecule, style: { ...molecule.style, ringStyles: { [ring.ringKey]: ringStyle } } };
  const page = { ...withFrontLetter.pages[0], objects: [art, backLetter, styledMolecule, frontLetter] };
  return {
    document: { ...withFrontLetter, pages: [page], selection: { ...withFrontLetter.selection, objectIds: [] } },
    molecule: styledMolecule,
    backLetter,
    frontLetter
  };
}

describe("canvas ring-fill layers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stylesheet: HTMLStyleElement;

  beforeEach(() => {
    window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Object.defineProperty(SVGElement.prototype, name, { configurable: true, writable: true,
        value: name === "hasPointerCapture" ? () => false : () => {} });
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, writable: true,
        value: name === "hasPointerCapture" ? () => false : () => {} });
    }
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    stylesheet = document.createElement("style");
    stylesheet.textContent = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    document.head.append(stylesheet);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stylesheet.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    delete window.__CHEMDRAFT_AGENT__;
    for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Reflect.deleteProperty(SVGElement.prototype, name);
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  });

  async function renderDocument(nativeDocument: ChemDraftDocument, tool = "tool.select") {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: nativeDocument,
      initialActiveToolCommandId: tool,
      initialPaletteMode: "hidden",
      initialCrosshairsVisible: false,
      initialRulersVisible: false,
      nativePalette: true
    })));
    const page = container.querySelector<HTMLElement>(".page")!;
    page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: nativeDocument.pages[0].width, bottom: nativeDocument.pages[0].height,
      width: nativeDocument.pages[0].width, height: nativeDocument.pages[0].height,
      toJSON: () => ({}) });
  }

  async function renderFixture(style: Record<string, unknown>) {
    const fixture = ringLetterDocument(style);
    await renderDocument(fixture.document);
    return fixture;
  }

  function objectVisual(id: string) {
    return container.querySelector<SVGGElement>(`[data-page-svg-object-visual="${id}"]`);
  }

  function svgPaintLayer(id: string) {
    // Fall back to the original paint surface so old code fails the order assertion,
    // rather than throwing when a newly introduced visual layer is absent.
    return objectVisual(id)?.closest("svg") ??
      container.querySelector(`[data-page-text-visual="${id}"]`) ??
      container.querySelector("[data-page-svg-surface]")!;
  }

  function moleculeLayer(id: string) {
    return container.querySelector<HTMLElement>(`.molecule-object[data-object-id="${id}"]`)!;
  }

  function layer(element: Element) {
    return Number(getComputedStyle(element).zIndex);
  }

  function expectCanvasOrder(nativeDocument: ChemDraftDocument, ids: string[], moleculeId: string) {
    const plan = planPageSvgRender(nativeDocument.pages[0]);
    const expectedOrder = [...new Set(plan.fragments
      .map(fragment => fragment.attrs["data-object-id"])
      .filter((id): id is string => typeof id === "string" && ids.includes(id)))];
    const paintElements = ids.map(id => ({ id, element: id === moleculeId ? moleculeLayer(id) : svgPaintLayer(id) }));
    const canvasOrder = paintElements.sort((a, b) => {
      const depth = layer(a.element) - layer(b.element);
      if (depth !== 0) return depth;
      const first = objectVisual(a.id) ?? a.element;
      const second = objectVisual(b.id) ?? b.element;
      return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    }).map(entry => entry.id);
    expect(canvasOrder).toEqual(expectedOrder);
    const exported = new DOMParser().parseFromString(exportDocumentToSvg(nativeDocument).contents, "image/svg+xml");
    const exportOrder = [...new Set(Array.from(exported.querySelectorAll("[data-object-id]"))
      .map(element => element.getAttribute("data-object-id"))
      .filter(id => ids.includes(id!)))];
    expect(canvasOrder).toEqual(exportOrder);
  }

  function documentWithObjects(base: ChemDraftDocument, objects: DocumentObject[], selected: string[] = []): ChemDraftDocument {
    return { ...base, pages: [{ ...base.pages[0], objects }], selection: { ...base.selection, objectIds: selected } };
  }

  function rectangleFixture() {
    const fixture = ringLetterDocument(fills[0].style);
    const art = fixture.document.pages[0].objects[0];
    if (art.type !== "graphic" || fixture.frontLetter.type !== "text") throw new Error("Expected art and text.");
    const rectangle: GraphicObject = { ...art, id: "rectangle", x: 230, y: 230, width: 160, height: 120,
      style: { fillMode: "solid", fillColor: "#ef8a24", strokeColor: "#ef8a24", strokeWidth: 2 } };
    const text: TextObject = { ...fixture.frontLetter, id: "front-text", x: 250, y: 260,
      width: 120, height: 50, text: "TOP", spans: [], style: { fontSize: 36, color: "#111111" } };
    return { ...fixture, rectangle, text };
  }

  async function command(commandId: string, eventName = DOM_COMMAND_EVENT) {
    await act(async () => window.dispatchEvent(new CustomEvent(eventName, { detail: { commandId } })));
  }

  async function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup", point: { x: number; y: number }, buttons = type === "pointerup" ? 0 : 1) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons,
      detail: 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 17 }, pointerType: { value: "mouse" } });
    await act(async () => target.dispatchEvent(event));
  }

  // jsdom has no browser hit testing. Check the real DOM stack/catchers, then dispatch
  // at the overlap on the front catcher. A native WKWebView/WebView2 pass is still needed.
  function topHitAtOverlap(ids: string[], point: { x: number; y: number }) {
    const visuals = ids.map(id => {
      const svg = objectVisual(id);
      const wrapper = moleculeLayer(id);
      return { id, visual: svg ?? wrapper, layer: svg ? svgPaintLayer(id) : wrapper };
    }).sort((a, b) => {
      const depth = layer(a.layer) - layer(b.layer);
      return depth || (a.visual.compareDocumentPosition(b.visual) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    });
    const top = visuals.at(-1)!;
    expect(point.x).toBeGreaterThanOrEqual(230);
    expect(point.y).toBeGreaterThanOrEqual(230);
    const hit = top.visual.querySelector(".graphic-glyph-hit-target, text, [data-hit-target='atom']") ?? top.visual;
    expect(getComputedStyle(hit).pointerEvents).not.toBe("none");
    return { ...top, hit };
  }

  function canvasSvg(nativeDocument: ChemDraftDocument): string {
    const page = nativeDocument.pages[0];
    const elements = [...container.querySelectorAll<Element>("[data-page-svg-visual-layer], .native-molecule-object")]
      .sort((a, b) => layer(a) - layer(b));
    function visibleMarkup(element: Element, inner: boolean): string {
      const copy = element.cloneNode(true) as Element;
      // These routing shapes are transparent only through App.css, which the standalone
      // rasterizer does not load. Export excludes them too; they contribute no canvas paint.
      copy.querySelectorAll("[data-hit-target], .native-molecule-ring-hit-target, .graphic-glyph-hit-target, .native-bond-hover-decorator")
        .forEach(hit => hit.remove());
      return inner ? copy.innerHTML : copy.outerHTML;
    }
    const paint = elements.map(element => {
      if (element instanceof SVGElement) return visibleMarkup(element, true);
      const molecule = page.objects.find((object): object is MoleculeObject => object.id === element.getAttribute("data-object-id") && object.type === "molecule")!;
      return `<g transform="translate(${molecule.x} ${molecule.y})">${visibleMarkup(element.querySelector("[data-native-molecule-overlay-visual]")!, false)}</g>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">${paint}</svg>`;
  }

  function darkPixels(svg: string, bounds: { x: number; y: number; width: number; height: number }) {
    const raster = new Resvg(svg, { background: "white" }).render();
    const pixels = raster.pixels;
    let dark = 0;
    for (let y = Math.ceil(bounds.y); y < bounds.y + bounds.height; y++) {
      for (let x = Math.ceil(bounds.x); x < bounds.x + bounds.width; x++) {
        const offset = (y * raster.width + x) * 4;
        if (pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100) dark++;
      }
    }
    return dark;
  }

  function expectInk(nativeDocument: ChemDraftDocument, bounds: { x: number; y: number; width: number; height: number }, visible: boolean) {
    for (const svg of [canvasSvg(nativeDocument), exportDocumentToSvg(nativeDocument).contents]) {
      const dark = darkPixels(svg, bounds);
      if (visible) expect(dark).toBeGreaterThan(10);
      else expect(dark).toBe(0);
    }
  }

  it.each(fills)("paints $name ring fills below the front letter, with hits in the same ordered layer", async ({ name, style }) => {
    const { molecule, backLetter, frontLetter } = await renderFixture(style);
    const moleculeElement = moleculeLayer(molecule.id);
    const fill = moleculeElement.querySelector<SVGPathElement>("[data-molecule-fill-ring]")!;
    const bond = moleculeElement.querySelector(".native-bond-line")!;
    expect(fill).not.toBeNull();
    expect(bond).not.toBeNull();
    expect(fill.compareDocumentPosition(bond) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(layer(svgPaintLayer(frontLetter.id))).toBeGreaterThan(layer(moleculeElement));
    expect(svgPaintLayer(frontLetter.id).parentElement).toBe(moleculeElement.parentElement);
    expect(layer(svgPaintLayer(backLetter.id))).toBeLessThan(layer(moleculeElement));
    expect(objectVisual(frontLetter.id)?.textContent).toBe("B");
    expect(getComputedStyle(svgPaintLayer(frontLetter.id)).position).toBe("absolute");
    expect(getComputedStyle(svgPaintLayer(frontLetter.id)).pointerEvents).toBe("none");
    expect(getComputedStyle(moleculeElement.querySelector(".native-molecule-overlay")!).overflow).toBe("visible");
    const hit = objectVisual(frontLetter.id)!.querySelector("text")!;
    expect(hit.getAttribute("opacity")).not.toBe("0");
    expect(hit.closest("[data-page-svg-visual-layer]")).toBe(svgPaintLayer(frontLetter.id));
    expect(hit.getAttribute("pointer-events")).toBeNull();
    expect(fill.getAttribute("pointer-events")).toBe("none");

    if (name === "gradient") {
      expect(fill.getAttribute("fill")).toMatch(/^url\(#molecule-fill-/);
      expect(moleculeElement.querySelector("linearGradient")).not.toBeNull();
    }
    if (name === "glow") {
      expect(fill.getAttribute("filter")).toMatch(/^url\(#molecule-ring-effects-/);
      expect(moleculeElement.querySelector("feGaussianBlur")).not.toBeNull();
      expect(Number(moleculeElement.querySelector("filter")!.getAttribute("x"))).toBeLessThan(molecule.x);
    }
  });

  it.each(fills)("matches the export plan and SVG order for $name fills and both letters", async ({ style }) => {
    const { document: nativeDocument, molecule, backLetter, frontLetter } = await renderFixture(style);
    const plan = planPageSvgRender(nativeDocument.pages[0]);
    const fillIndex = plan.fragments.findIndex(fragment => fragment.attrs["data-molecule-fill-ring"] === "true");
    const backIndex = plan.fragments.findIndex(fragment => fragment.attrs["data-object-id"] === backLetter.id);
    const frontIndex = plan.fragments.findIndex(fragment => fragment.attrs["data-object-id"] === frontLetter.id);
    expect(backIndex).toBeGreaterThanOrEqual(0);
    expect(backIndex).toBeLessThan(fillIndex);
    expect(fillIndex).toBeLessThan(frontIndex);
    const expectedOrder = [backLetter.id, molecule.id, frontLetter.id];
    expectCanvasOrder(nativeDocument, [frontLetter.id, molecule.id, backLetter.id], molecule.id);
    expect(layer(svgPaintLayer(frontLetter.id))).toBe(Number(plan.fragments[frontIndex].attrs["data-layer-index"]) + 20);

    const exported = new DOMParser().parseFromString(exportDocumentToSvg(nativeDocument).contents, "image/svg+xml");
    const visibleObjects = Array.from(exported.querySelectorAll("[data-object-id]"))
      .map(element => element.getAttribute("data-object-id"))
      .filter(id => expectedOrder.includes(id!));
    expect([...new Set(visibleObjects)]).toEqual(expectedOrder);
    expect(exported.querySelector("[data-molecule-fill-ring]")!.getAttribute("fill"))
      .toBe(moleculeLayer(molecule.id).querySelector("[data-molecule-fill-ring]")!.getAttribute("fill"));
  });

  it("selects front text on pointer-down on its visible ordered SVG glyph", async () => {
    const { frontLetter } = await renderFixture(fills[0].style);
    const page = container.querySelector<HTMLElement>(".page")!;
    page.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 792, bottom: 612, width: 792, height: 612,
      toJSON: () => ({})
    });
    const hit = objectVisual(frontLetter.id)!.querySelector("text")!;
    expect(hit.getAttribute("opacity")).not.toBe("0");
    expect(hit.closest("[data-page-svg-visual-layer]")).toBe(svgPaintLayer(frontLetter.id));
    const event = new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1,
      clientX: frontLetter.x + 4, clientY: frontLetter.y + 4
    });
    Object.defineProperties(event, {
      isPrimary: { value: true }, pointerId: { value: 1 }, pointerType: { value: "mouse" }
    });
    hit.setPointerCapture = vi.fn();
    hit.releasePointerCapture = vi.fn();
    hit.hasPointerCapture = () => false;
    await act(async () => hit.dispatchEvent(event));
    expect(container.querySelector(`.text-object[data-object-id="${frontLetter.id}"]`)?.classList.contains("selected"))
      .toBe(true);
  });

  it.each(["lone-pair", "radical-dot", "charge", "mechanism-arrow", "plus", "non-native-molecule"] as const)(
    "paints a %s above a filled ring in the same order as export", async (kind) => {
      const fixture = ringLetterDocument({ fillColor: "#ef8a24", fillOpacity: 1 });
      let nativeDocument: ChemDraftDocument = fixture.document;
      if (kind === "mechanism-arrow") {
        nativeDocument = createMechanismArrowBetween(nativeDocument, "full-headed",
          { kind: "atom", objectId: fixture.molecule.id, atomId: fixture.molecule.atoms[0].id },
          { kind: "atom", objectId: fixture.molecule.id, atomId: fixture.molecule.atoms[3].id });
      } else if (kind === "plus" || kind === "non-native-molecule") {
        const object: DocumentObject = kind === "plus"
          ? { id: "plus-front", type: "plus", x: fixture.frontLetter.x, y: fixture.frontLetter.y,
            width: 24, height: 24, rotation: 0, style: {} }
          : { ...fixture.molecule, id: "fallback-front", atoms: [], bonds: [], style: {} };
        nativeDocument = { ...nativeDocument, pages: [{ ...nativeDocument.pages[0],
          objects: [...nativeDocument.pages[0].objects, object] }] };
      } else {
        const center = nativeMoleculeRings(fixture.molecule)[0].center;
        nativeDocument = applyChargeToolAtPoint(nativeDocument,
          kind === "charge" ? { kind, charge: 1 } : { kind }, center);
      }
      nativeDocument = { ...nativeDocument, selection: { ...nativeDocument.selection, objectIds: [] } };
      const frontObject = nativeDocument.pages[0].objects.at(-1)!;
      await renderDocument(nativeDocument);
      expectCanvasOrder(nativeDocument, [frontObject.id, fixture.molecule.id], fixture.molecule.id);
      expect(layer(svgPaintLayer(frontObject.id))).toBeGreaterThan(layer(moleculeLayer(fixture.molecule.id)));
      expect(objectVisual(frontObject.id)?.childElementCount).toBeGreaterThan(0);
      expect(svgPaintLayer(frontObject.id)).toBe(svgPaintLayer(fixture.frontLetter.id));
      expect(getComputedStyle(svgPaintLayer(frontObject.id)).pointerEvents).toBe("none");
      if (kind === "non-native-molecule") {
        const wrapper = moleculeLayer(frontObject.id);
        expect(getComputedStyle(wrapper).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        expect(getComputedStyle(wrapper).borderTopColor).toBe("rgba(0, 0, 0, 0)");
      }
      expect(objectVisual(frontObject.id)?.getAttribute("opacity")).not.toBe("0");
      expect(container.querySelector(`[data-page-svg-surface] [data-object-id="${frontObject.id}"]`)).toBeNull();
    }
  );

  it("groups hundreds of labels into two layers around one native molecule", async () => {
    const fixture = ringLetterDocument(fills[0].style);
    const labels = Array.from({ length: 400 }, (_, index) => ({
      ...fixture.frontLetter, id: `label-${index}`, text: String(index), spans: []
    }));
    const nativeDocument = { ...fixture.document, pages: [{ ...fixture.document.pages[0],
      objects: [...labels.slice(0, 200), fixture.molecule, ...labels.slice(200)] }] };
    await renderDocument(nativeDocument);
    const layers = container.querySelectorAll("[data-page-svg-visual-layer]");
    expect(layers.length).toBe(2);
    expect(layers[0].querySelectorAll("[data-page-svg-object-visual]").length).toBe(200);
    expect(layers[1].querySelectorAll("[data-page-svg-object-visual]").length).toBe(200);
    expect(Array.from(container.querySelectorAll("[data-page-svg-object-visual]"))
      .map(element => element.getAttribute("data-page-svg-object-visual"))).toEqual(labels.map(label => label.id));
    expectCanvasOrder(nativeDocument, [labels[399].id, fixture.molecule.id, labels[0].id], fixture.molecule.id);
    expect(layer(layers[0])).toBe(20);
    expect(layer(layers[1])).toBe(221);
  });

  it("groups art and text into the same SVG run, split only by native molecules", async () => {
    const fixture = ringLetterDocument(fills[0].style);
    const art = fixture.document.pages[0].objects[0];
    const middleLetter = { ...fixture.frontLetter, id: "middle-letter", text: "C", spans: [] };
    const nativeDocument = { ...fixture.document, pages: [{ ...fixture.document.pages[0],
      objects: [fixture.backLetter, art, middleLetter, fixture.molecule, fixture.frontLetter] }] };
    await renderDocument(nativeDocument);
    expect(container.querySelectorAll("[data-page-svg-visual-layer]").length).toBe(2);
    expect(svgPaintLayer(fixture.backLetter.id)).toBe(svgPaintLayer(art.id));
    expect(svgPaintLayer(middleLetter.id)).toBe(svgPaintLayer(art.id));
    expectCanvasOrder(nativeDocument,
      [fixture.frontLetter.id, fixture.molecule.id, art.id, middleLetter.id, fixture.backLetter.id], fixture.molecule.id);
  });
  it("paints text above a filled rectangle, then Send to Back hides it in canvas and export", async () => {
    const fixture = rectangleFixture();
    const front = documentWithObjects(fixture.document, [fixture.rectangle, fixture.text], [fixture.text.id]);
    await renderDocument(front);
    expectCanvasOrder(front, [fixture.text.id, fixture.rectangle.id], "none");
    expectInk(front, fixture.text, true);
    const overlap = { x: fixture.text.x + 10, y: fixture.text.y + 20 };
    const top = topHitAtOverlap([fixture.text.id, fixture.rectangle.id], overlap);
    expect(top.id).toBe(fixture.text.id);
    await pointer(top.hit, "pointerdown", overlap);
    await pointer(top.hit, "pointerup", overlap);
    expect(container.querySelector(`.text-object[data-object-id="${fixture.text.id}"]`)?.classList.contains("selected")).toBe(true);
    await command("layout.sendToBack");
    const back = documentWithObjects(front, [fixture.text, fixture.rectangle], [fixture.text.id]);
    expectCanvasOrder(back, [fixture.text.id, fixture.rectangle.id], "none");
    expectInk(back, fixture.text, false);
    const nextTop = topHitAtOverlap([fixture.text.id, fixture.rectangle.id], overlap);
    expect(nextTop.id).toBe(fixture.rectangle.id);
    const dormantHit = container.querySelector(`.graphic-object[data-object-id="${fixture.rectangle.id}"] .graphic-glyph-hit-target`)!;
    expect(getComputedStyle(dormantHit).pointerEvents).toBe("none");
    await pointer(nextTop.hit, "pointerdown", overlap);
    await pointer(nextTop.hit, "pointerup", overlap);
    expect(container.querySelector(".text-object.selected")).toBeNull();
    await act(async () => nextTop.hit.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true,
      cancelable: true, button: 2, clientX: overlap.x, clientY: overlap.y })));
    expect(container.querySelector("[data-context-object-id]")?.getAttribute("data-context-object-id")).toBe(fixture.rectangle.id);
  }, 20_000);

  it.each([
    { commandId: "layout.bringToFront", order: ["rectangle", "middle", "front-text"] },
    { commandId: "layout.bringForward", order: ["rectangle", "front-text", "middle"] },
    { commandId: "layout.sendBackward", order: ["front-text", "rectangle", "middle"] },
    { commandId: "layout.sendToBack", order: ["front-text", "rectangle", "middle"] }
  ])("$commandId changes SVG paint and export identically", async ({ commandId, order }) => {
    const fixture = rectangleFixture();
    const middle = { ...fixture.text, id: "middle", text: "M" };
    const objects = commandId.includes("bring")
      ? [fixture.text, fixture.rectangle, middle] : [fixture.rectangle, fixture.text, middle];
    const before = documentWithObjects(fixture.document, objects, [fixture.text.id]);
    await renderDocument(before);
    await command(commandId);
    const after = documentWithObjects(before, order.map(id => objects.find(object => object.id === id)!));
    expectCanvasOrder(after, order, "none");
  });

  it.each([false, true])("a white rectangle and molecule cover each other by document order (molecule front: %s)", async moleculeFront => {
    const fixture = rectangleFixture();
    const white = { ...fixture.rectangle, style: { ...fixture.rectangle.style, fillColor: "#ffffff", strokeColor: "#ffffff" } };
    const molecule = { ...fixture.molecule, style: {} };
    const objects = moleculeFront ? [white, molecule] : [molecule, white];
    const nativeDocument = documentWithObjects(fixture.document, objects);
    await renderDocument(nativeDocument);
    expectCanvasOrder(nativeDocument, objects.map(object => object.id), molecule.id);
    expectInk(nativeDocument, { x: molecule.x - 5, y: molecule.y - 5, width: molecule.width + 10, height: molecule.height + 10 }, moleculeFront);
    const overlap = { x: molecule.atoms[0].x, y: molecule.atoms[0].y };
    const top = topHitAtOverlap(objects.map(object => object.id), overlap);
    expect(top.id).toBe(objects.at(-1)!.id);
    await pointer(top.hit, "pointerdown", overlap);
    await pointer(top.hit, "pointerup", overlap);
    if (moleculeFront) expect(moleculeLayer(molecule.id).getAttribute("data-selected-native-kind")).toBe("atom");
    else expect(moleculeLayer(molecule.id).classList.contains("native-molecule-selected")).toBe(false);
  }, 20_000);

  it.each(["text", "graphic", "bracket", "reaction-arrow", "electron-mark", "plus", "mechanism-arrow", "fallback-molecule"] as const)(
    "keeps %s paint and hits above a native molecule", async kind => {
      const fixture = rectangleFixture();
      let extra: DocumentObject;
      if (kind === "graphic") extra = fixture.rectangle;
      else if (kind === "text") extra = fixture.text;
      else if (kind === "fallback-molecule") extra = { ...fixture.molecule, id: "fallback", atoms: [], bonds: [], style: {} };
      else if (kind === "mechanism-arrow") {
        const withArrow = createMechanismArrowBetween(fixture.document, "full-headed",
          { kind: "atom", objectId: fixture.molecule.id, atomId: fixture.molecule.atoms[0].id },
          { kind: "atom", objectId: fixture.molecule.id, atomId: fixture.molecule.atoms[3].id });
        extra = withArrow.pages[0].objects.at(-1)!;
      } else {
        const base = { id: `front-${kind}`, x: fixture.molecule.x, y: fixture.molecule.y,
          width: 50, height: 50, rotation: 0, style: {} };
        if (kind === "bracket") extra = { ...base, type: "bracket", bracketKind: "square", containedObjectIds: [] };
        else if (kind === "reaction-arrow") extra = { ...base, type: "reaction-arrow", arrowKind: "forward", labels: [],
          start: { kind: "point", point: { x: base.x, y: base.y + 25 } },
          end: { kind: "point", point: { x: base.x + 50, y: base.y + 25 } } };
        else if (kind === "electron-mark") extra = { ...base, type: "electron-mark", markKind: "lone-pair",
          anchor: { kind: "point", point: { x: base.x + 25, y: base.y + 25 } } };
        else extra = { ...base, type: "plus" };
      }
      const nativeDocument = documentWithObjects(fixture.document, [fixture.molecule, extra]);
      await renderDocument(nativeDocument);
      expectCanvasOrder(nativeDocument, [fixture.molecule.id, extra.id], fixture.molecule.id);
      const visible = objectVisual(extra.id)!;
      expect(getComputedStyle(visible).pointerEvents).toBe("auto");
      const point = { x: extra.x + extra.width / 2, y: extra.y + extra.height / 2 };
      const hit = visible.querySelector(".graphic-glyph-hit-target, text, path, circle, rect") ?? visible;
      await pointer(hit, "pointerdown", point);
      await pointer(hit, "pointerup", point);
      expect(moleculeLayer(fixture.molecule.id).classList.contains("native-molecule-selected")).toBe(false);
      expect(window.__CHEMDRAFT_AGENT__!.snapshot().selection.objectIds).toEqual([extra.id]);
      await act(async () => hit.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
        button: 2, clientX: point.x, clientY: point.y })));
      expect(container.querySelector("[data-context-object-id]")?.getAttribute("data-context-object-id")).toBe(extra.id);
      await command("layout.sendToBack");
      const sentBack = documentWithObjects(nativeDocument, [extra, fixture.molecule]);
      expectCanvasOrder(sentBack, [fixture.molecule.id, extra.id], fixture.molecule.id);
  });

  it("previews, cancels and commits colour on the visible graphic", async () => {
    const fixture = rectangleFixture();
    const nativeDocument = documentWithObjects(fixture.document, [fixture.rectangle, fixture.text], [fixture.rectangle.id]);
    await renderDocument(nativeDocument);
    await command("object.style.target.fill");
    const paint = () => objectVisual(fixture.rectangle.id)!.querySelector(".graphic-glyph-shape")!;
    const original = paint().getAttribute("fill");
    await command("object.color.red", PALETTE_COMMAND_PREVIEW_EVENT);
    expect(paint().getAttribute("fill")).toBe("#b3261e");
    await command("palette.preview.cancel", PALETTE_COMMAND_CANCEL_EVENT);
    expect(paint().getAttribute("fill")).toBe(original);
    await command("object.color.green", PALETTE_COMMAND_PREVIEW_EVENT);
    expect(paint().getAttribute("fill")).toBe("#1d7f68");
    await command("object.color.green", PALETTE_COMMAND_COMMIT_EVENT);
    expect(paint().getAttribute("fill")).toBe("#1d7f68");
  });

  it("moves the visible graphic without replanning the page during drag frames", async () => {
    const fixture = rectangleFixture();
    await renderDocument(documentWithObjects(fixture.document, [fixture.rectangle, fixture.text]));
    const plan = vi.spyOn(layoutEngine, "planPageSvgRender");
    const point = { x: 270, y: 275 };
    const visible = objectVisual(fixture.rectangle.id)!;
    await pointer(visible.querySelector(".graphic-glyph-hit-target")!, "pointerdown", point);
    // Selecting may update the plan once; the frames themselves must only transform existing paint.
    plan.mockClear();
    for (const offset of [20, 30, 40]) {
      await pointer(container.querySelector(".page")!, "pointermove", { x: point.x + offset, y: point.y + 10 });
      await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });
      expect(objectVisual(fixture.rectangle.id)!.getAttribute("transform")).toContain(`translate(${offset} 10)`);
      expect(objectVisual(fixture.rectangle.id)!.querySelector("image[data-art-transform-drag-preview='image']")).not.toBeNull();
      expectInteractionAbovePaint(container.querySelector(`[data-object-controls='${fixture.rectangle.id}'] [data-art-transform-drag-preview]`)!);
      expect(objectVisual(fixture.text.id)!.getAttribute("transform")).toBeNull();
    }
    expect(plan).not.toHaveBeenCalled();
    await pointer(container.querySelector(".page")!, "pointerup", { x: point.x + 40, y: point.y + 10 });
    expect(objectVisual(fixture.rectangle.id)!.getAttribute("transform")).toBeNull();
    expect(objectVisual(fixture.rectangle.id)!.querySelector("svg")!.getAttribute("x")).toBe("270");
  });

  it("does not hover or erase a molecule hidden under a graphic", async () => {
    const fixture = rectangleFixture();
    await renderDocument(documentWithObjects(fixture.document, [fixture.molecule, fixture.rectangle]), "tool.eraser");
    const visible = objectVisual(fixture.rectangle.id)!;
    const point = fixture.molecule.atoms[0];
    await pointer(visible.querySelector(".graphic-glyph-hit-target")!, "pointermove", point, 0);
    expect(moleculeLayer(fixture.molecule.id).getAttribute("data-delete-hover-atom-id")).toBeNull();
    await pointer(visible.querySelector(".graphic-glyph-hit-target")!, "pointerdown", point);
    expect(objectVisual(fixture.rectangle.id)).toBeNull();
    expect(moleculeLayer(fixture.molecule.id)).not.toBeNull();
  });

  it("paints a curved art arrow over a filled ring, then hides it when sent behind the ring", async () => {
    const fixture = ringLetterDocument({ fillColor: "#ef8a24", fillOpacity: 1 });
    const center = nativeMoleculeRings(fixture.molecule)[0].center;
    const withArrow = nativeBezierPathDocument(documentWithObjects(fixture.document, [fixture.molecule]), [
      { point: { x: center.x - 12, y: center.y + 6 }, outControl: { x: center.x - 8, y: center.y - 12 } },
      { point: { x: center.x + 12, y: center.y + 6 }, inControl: { x: center.x + 8, y: center.y - 12 } }
    ]);
    const arrow = withArrow.pages[0].objects.at(-1)!;
    if (arrow.type !== "graphic") throw new Error("Expected a curved art arrow.");
    const curvedArrow = { ...arrow, data: { ...arrow.data, markerEnd: { kind: "filled-arrow" as const, sizePx: 6 } } };
    const front = documentWithObjects(withArrow, [fixture.molecule, curvedArrow], [curvedArrow.id]);
    await renderDocument(front);
    expect(objectVisual(arrow.id)!.querySelector(".graphic-glyph-path")!.getAttribute("d")).toBeTruthy();
    // Sample the ring interior, clear of the inward double-bond strokes.
    const bounds = { x: center.x - 10, y: center.y - 8, width: 20, height: 16 };
    expectCanvasOrder(front, [arrow.id, fixture.molecule.id], fixture.molecule.id);
    expectInk(front, bounds, true);
    await command("layout.sendToBack");
    const back = documentWithObjects(front, [curvedArrow, fixture.molecule]);
    expectCanvasOrder(back, [arrow.id, fixture.molecule.id], fixture.molecule.id);
    expectInk(back, bounds, false);
  }, 20_000);

  it("keeps the native molecule at 10% opacity during Spin 3D and restores it on cancel", async () => {
    const fixture = ringLetterDocument(fills[0].style);
    const model = buildSpin3dModel({ molecule: fixture.molecule,
      coords3d: fixture.molecule.atoms.flatMap(atom => [atom.x, -atom.y, 0]),
      orientation: { x: 0, y: 0, z: 0, w: 1 } });
    const nativeDocument = attachSpin3dModel(documentWithObjects(fixture.document,
      [fixture.molecule, fixture.frontLetter], [fixture.molecule.id]), fixture.molecule.id, model);
    await renderDocument(nativeDocument);
    await command("structure.spin3d");
    expect(container.querySelector("[data-spin3d-overlay]")).not.toBeNull();
    expect(moleculeLayer(fixture.molecule.id).querySelector<SVGElement>(".native-molecule-overlay")!.style.opacity).toBe("0.1");
    expect(objectVisual(fixture.frontLetter.id)!.getAttribute("opacity")).toBeNull();
    expectCanvasOrder(nativeDocument, [fixture.molecule.id, fixture.frontLetter.id], fixture.molecule.id);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[data-spin3d-overlay]")).toBeNull();
    expect(moleculeLayer(fixture.molecule.id).querySelector<SVGElement>(".native-molecule-overlay")!.style.opacity).toBe("");
  });

  function expectInteractionAbovePaint(element: Element) {
    // Compare the stacking contexts at their common page parent, not the local handle z-index.
    const interaction = element.closest("[data-page-interaction-layer]");
    expect(interaction).not.toBeNull();
    const paint = container.querySelector("[data-page-object-stack]")!;
    expect(paint).not.toBeNull();
    expect(interaction!.parentElement).toBe(paint.parentElement);
    expect(layer(interaction!)).toBeGreaterThan(layer(paint));
    for (const run of container.querySelectorAll("[data-page-svg-visual-layer], .native-molecule-object")) {
      expect(run.closest("[data-page-object-stack]")).toBe(paint);
    }
  }

  it("retains arrow hover ownership from paint to marker, endpoint and catcher, then clears outside", async () => {
    const withArrow = insertNativeArtGraphicObject(createPhase4Document("Arrow ownership"),
      { x: 100, y: 100 }, "tool.art.resonanceArrow");
    const arrow = withArrow.pages[0].objects[0];
    await renderDocument(documentWithObjects(withArrow, [arrow]), "tool.art.resonanceArrow");
    const painted = objectVisual(arrow.id)!;
    await pointer(painted, "pointermove", { x: 140, y: 112 }, 0);
    const marker = container.querySelector("[data-graphic-marker-handle]")!;
    expect(marker).not.toBeNull();
    async function moveBetween(from: Element, to: Element) {
      await act(async () => {
        from.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: to }));
        to.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: from }));
      });
    }
    await moveBetween(painted, marker);
    expect(container.querySelector("[data-graphic-marker-handle]")).toBe(marker);
    const endpoint = container.querySelector("[data-graphic-path-handle='end']")!;
    await moveBetween(marker, endpoint);
    expect(endpoint.isConnected).toBe(true);
    const catcher = painted.querySelector(".graphic-glyph-hit-target")!;
    await moveBetween(endpoint, catcher);
    expect(marker.isConnected).toBe(true);
    await moveBetween(catcher, container.querySelector(".page")!);
    expect(container.querySelector("[data-graphic-marker-handle]")).toBeNull();
  });

  it.each(["shape", "400 labels"])("keeps molecule handles, hover rings and label editor above a later %s", async front => {
    const fixture = rectangleFixture();
    const labels = Array.from({ length: 400 }, (_, index) => ({ ...fixture.text, x: 600, y: 500, id: `chrome-label-${index}` }));
    const objects = front === "shape" ? [fixture.molecule, { ...fixture.rectangle, x: 600, y: 500 }]
      : [...labels.slice(0, 200), fixture.molecule, ...labels.slice(200)];
    await renderDocument(documentWithObjects(fixture.document, objects, [fixture.molecule.id]));
    expectInteractionAbovePaint(container.querySelector("[data-object-resize-corner]")!);
    // The atom is unobscured, while the same molecule's controls can overhang later objects.
    await pointer(moleculeLayer(fixture.molecule.id), "pointermove", fixture.molecule.atoms[0], 0);
    expectInteractionAbovePaint(container.querySelector(".native-atom-hover")!);
    await command("tool.atom");
    await pointer(moleculeLayer(fixture.molecule.id), "pointerdown", fixture.molecule.atoms[0]);
    const editor = container.querySelector<HTMLInputElement>("[data-atom-label-editor]")!;
    expect(editor).not.toBeNull();
    expectInteractionAbovePaint(editor);
    expect(getComputedStyle(editor).pointerEvents).not.toBe("none");
  });

  it.each(["lasso", "marquee", "spin"])("keeps %s above both SVG runs of a 400-label page", async kind => {
    const fixture = rectangleFixture();
    const labels = Array.from({ length: 400 }, (_, index) => ({ ...fixture.text, id: `gesture-label-${index}` }));
    const model = buildSpin3dModel({ molecule: fixture.molecule,
      coords3d: fixture.molecule.atoms.flatMap(atom => [atom.x, -atom.y, 0]),
      orientation: { x: 0, y: 0, z: 0, w: 1 } });
    const nativeDocument = attachSpin3dModel(documentWithObjects(fixture.document,
      [...labels.slice(0, 200), fixture.molecule, ...labels.slice(200)], [fixture.molecule.id]), fixture.molecule.id, model);
    await renderDocument(nativeDocument, kind === "lasso" ? "tool.lasso" : "tool.select");
    if (kind === "spin") await command("structure.spin3d");
    else {
      const page = container.querySelector(".page")!;
      await pointer(page, "pointerdown", { x: 50, y: 50 });
      await pointer(page, "pointermove", { x: 80, y: 80 });
    }
    const overlay = container.querySelector(kind === "spin" ? "[data-spin3d-overlay]"
      : kind === "lasso" ? ".selection-lasso-surface" : ".selection-marquee")!;
    expect(overlay).not.toBeNull();
    expectInteractionAbovePaint(overlay);
    if (kind === "spin") {
      const ghost = container.querySelector<SVGElement>("[data-spin3d-ghost]")!;
      expectInteractionAbovePaint(ghost);
      expect(ghost.style.opacity).toBe("0.1");
      expect(getComputedStyle(overlay).pointerEvents).toBe("auto");
    }
  });

  function projectedArtFixture(type: "reaction-arrow" | "bracket", rotation: number, tiltYDegrees: number): DocumentObject {
    const base = { id: `projected-${type}`, x: 100, y: 100, width: 120, height: 24,
      rotation, style: { tiltYDegrees } };
    return type === "reaction-arrow" ? { ...base, type, arrowKind: "forward", labels: [],
      start: { kind: "point", point: { x: 100, y: 112 } },
      end: { kind: "point", point: { x: 220, y: 112 } } }
      : { ...base, type, bracketKind: "square", containedObjectIds: [] };
  }

  it.each([
    ["reaction-arrow", 0], ["reaction-arrow", 60], ["bracket", 0], ["bracket", 60]
  ] as const)("rotates and projects the %s catcher with its paint (Y tilt %s)", async (type, tilt) => {
    const object = projectedArtFixture(type, 90, tilt);
    await renderDocument(documentWithObjects(createPhase4Document("Projected catcher"), [object]));
    const rect = objectVisual(object.id)!.querySelector("rect")!;
    expect(rect.getAttribute("transform")).toBe(tilt ? "matrix(0 1 -0.5 0 216 -48)" : "rotate(90 160 112)");
    // Rasterize just the catcher as opaque ink to test its actual transformed footprint.
    const copy = rect.cloneNode(true) as Element;
    copy.setAttribute("fill", "black");
    const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">${copy.outerHTML}</svg>`,
      { background: "white" }).render();
    const at = (x: number, y: number) => raster.pixels[(y * raster.width + x) * 4];
    expect(at(110, 110)).toBe(255); // formerly invisible, unrotated hit area
    expect(at(160, 70)).toBe(0); // projected shaft/outline area
  });

  it.each(["reaction-arrow", "bracket"] as const)("paints the tilted %s in the same projection as its controls and export", async type => {
    const object = projectedArtFixture(type, 0, 60);
    const nativeDocument = documentWithObjects(createPhase4Document("Projected paint"), [object], [object.id]);
    await renderDocument(nativeDocument);
    const visible = objectVisual(object.id)!;
    if (type === "reaction-arrow") {
      expect(visible.querySelector("line")!.getAttribute("x1")).toBe("130");
      expect(visible.querySelector("line")!.getAttribute("x2")).toBe("190");
    } else {
      expect(visible.querySelector("path")!.getAttribute("transform"))
        .toBe("matrix(0.5 0 0 1 80 0) translate(100 100)");
    }
    const frame = container.querySelector<HTMLElement>("[data-art-transform-frame]")!;
    expect(frame.style.left).toBe("calc(30px * var(--page-scale))");
    expect(frame.style.width).toBe("calc(60px * var(--page-scale))");
    const exported = new DOMParser().parseFromString(exportDocumentToSvg(nativeDocument).contents, "image/svg+xml");
    for (const selector of ["line", "polygon", "path"]) {
      const canvas = visible.querySelector(selector);
      if (!canvas) continue;
      const output = exported.querySelector(`${selector}[data-object-id='${object.id}']`)!;
      for (const attr of ["x1", "y1", "x2", "y2", "points", "d", "transform"]) {
        const value = canvas.getAttribute(attr);
        const exportedValue = output.getAttribute(attr);
        if (value !== null && exportedValue !== null && ["x1", "y1", "x2", "y2"].includes(attr)) {
          expect(Number(value)).toBeCloseTo(Number(exportedValue), 3);
        } else expect(value).toBe(exportedValue);
      }
    }
  });

});
