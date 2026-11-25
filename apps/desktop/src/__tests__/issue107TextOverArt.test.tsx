// @vitest-environment jsdom
//
// Issue #107: text (and other objects) placed in front of art must paint in front of it on every
// surface, and Send to Back must hide it on every surface, because every surface draws objects in
// page.objects order. These tests pin that for the canvas (DOM stacking plus a rasterised copy of the
// layers the canvas paints), the SVG export, the PDF export (content-stream drawing order) and the
// PNG export (the export SVG rasterised by resvg, the renderer the desktop's native writer uses).
//
// Set ISSUE107_OUT=<dir> to also write every export (and the canvas composite) to that directory.

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, DocumentObject, GraphicObject, MoleculeObject, TextObject } from "@chemdraft/chem-core";
import { ensureRdkit, resetRdkitForTesting, setRdkitModuleLoader } from "@chemdraft/rdkit-adapter";
import { MainWindow } from "../MainWindow";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { installDomRdkitLoader } from "../testSupport/rdkitIdentity";
import { DOM_COMMAND_EVENT } from "../window-manager";
import {
  createPhase4Document,
  exportPhase4Pdf,
  exportPhase4Svg,
  insertNativeArtGraphicObject,
  insertNativeTemplateMolecule,
  insertNativeTextObject
} from "../documentWorkflow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

beforeAll(async () => {
  installDomRdkitLoader(setRdkitModuleLoader);
  await ensureRdkit();
});
afterAll(() => resetRdkitForTesting());

const OUT = process.env.ISSUE107_OUT;
function save(name: string, contents: string | Uint8Array) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), contents);
}

type Rgb = [number, number, number];
type Box = { x: number; y: number; width: number; height: number };
const ORANGE: Rgb = [0xef, 0x8a, 0x24];

// ---------------------------------------------------------------- fixtures

const base = createPhase4Document("Issue 107");

function rectangle(id: string, box: Box, color: string): GraphicObject {
  const art = insertNativeArtGraphicObject(base, { x: 40, y: 40 }, "tool.art.rect").pages[0].objects.at(-1)!;
  if (art.type !== "graphic") throw new Error("Expected a rectangle graphic.");
  return { ...art, id, ...box, rotation: 0,
    style: { fillMode: "solid", fillColor: color, strokeColor: color, strokeWidth: 2 } };
}

function textObject(): TextObject {
  const inserted = insertNativeTextObject(base, { x: 250, y: 260 }, "TOP").pages[0].objects.at(-1)!;
  if (inserted.type !== "text") throw new Error("Expected text.");
  return { ...inserted, id: "front-text", x: 250, y: 260, width: 120, height: 50, text: "TOP", spans: [],
    style: { fontSizePx: 36, color: "#111111" } };
}

function molecule(labelled: boolean): MoleculeObject {
  const inserted = insertNativeTemplateMolecule(base, { x: 310, y: 290 }, "cyclohexane").pages[0].objects.at(-1)!;
  if (inserted.type !== "molecule") throw new Error("Expected a molecule.");
  if (!labelled) return { ...inserted, id: "molecule" };
  // Tetrahydropyran: one ring atom becomes O, which draws an atom label.
  return { ...inserted, id: "molecule", atoms: inserted.atoms.map((atom, index) => index === 0 ? { ...atom, element: "O" } : atom) };
}

function withObjects(objects: DocumentObject[], selected: string[] = []): ChemDraftDocument {
  return { ...base, pages: [{ ...base.pages[0], objects }], selection: { ...base.selection, objectIds: selected } };
}

const RECT_BOX: Box = { x: 230, y: 230, width: 160, height: 120 };
// The text sits entirely inside the rectangle; sample its box inset from the text frame.
const TEXT_INK: Box = { x: 252, y: 262, width: 116, height: 46 };

function case1() {
  const rect = rectangle("rectangle", RECT_BOX, "#ef8a24");
  const text = textObject();
  return { document: withObjects([rect, text]), rect, text };
}

function case2() {
  const { rect, text } = case1();
  return { document: withObjects([text, rect]), rect, text };
}

function case3() {
  const mol = molecule(false);
  // White box over the left half of the molecule, molecule first so the box is in front.
  const cover: Box = { x: mol.x - 12, y: mol.y - 12, width: mol.width / 2 + 12, height: mol.height + 24 };
  const white = rectangle("white-box", cover, "#ffffff");
  return {
    document: withObjects([mol, white]), molecule: mol, white,
    covered: { x: cover.x + 3, y: cover.y + 3, width: cover.width - 6, height: cover.height - 6 },
    uncovered: { x: cover.x + cover.width + 3, y: mol.y - 6, width: mol.width / 2 - 3, height: mol.height + 12 }
  };
}

function case4() {
  const mol = molecule(true);
  const oxygen = mol.atoms[0]!;
  const shape = rectangle("shape-under-label", { x: oxygen.x - 30, y: oxygen.y - 30, width: 60, height: 60 }, "#ef8a24");
  return {
    document: withObjects([shape, mol]), molecule: mol, shape,
    label: { x: oxygen.x - 6, y: oxygen.y - 7, width: 12, height: 14 }
  };
}

// ---------------------------------------------------------------- pixels

function rasterize(svg: string) {
  const raster = new Resvg(svg, { background: "white" }).render();
  return { png: raster.asPng(), width: raster.width, pixels: raster.pixels };
}

function near(a: Rgb, b: Rgb, tolerance = 12) {
  return a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);
}

function countPixels(raster: { width: number; pixels: Uint8Array | Buffer }, box: Box, predicate: (rgb: Rgb) => boolean) {
  let count = 0;
  for (let y = Math.ceil(box.y); y < box.y + box.height; y++) {
    for (let x = Math.ceil(box.x); x < box.x + box.width; x++) {
      const offset = (y * raster.width + x) * 4;
      if (predicate([raster.pixels[offset]!, raster.pixels[offset + 1]!, raster.pixels[offset + 2]!])) count++;
    }
  }
  return count;
}

const dark = (rgb: Rgb) => rgb.every(value => value < 110);
const notOrange = (rgb: Rgb) => !near(rgb, ORANGE);

// ---------------------------------------------------------------- SVG export order

async function exportSvg(document: ChemDraftDocument) {
  // The SVG the Export dialog writes, and the SVG its PNG path hands to the native rasterizer.
  return (await exportPhase4Svg(document, { includeWarnings: true, background: "#ffffff" })).contents;
}

function svgObjectOrder(svg: string, ids: string[]) {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  return [...new Set(Array.from(parsed.querySelectorAll("[data-object-id]"))
    .map(element => element.getAttribute("data-object-id")!)
    .filter(id => ids.includes(id)))];
}

// ---------------------------------------------------------------- PDF content-stream order

function pdfContentStream(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("latin1");
  const page = text.match(/\/Type \/Page\b[\s\S]*?\/Contents (\d+) 0 R/);
  if (!page) throw new Error("No page contents in PDF.");
  const object = text.match(new RegExp(`\\n${page[1]} 0 obj\\n([\\s\\S]*?)\\nendobj`))![1]!;
  const start = object.indexOf("stream\n") + 7;
  const length = Number(object.match(/\/Length (\d+)/)![1]);
  const raw = Buffer.from(object.slice(start, start + length), "latin1");
  return (object.includes("/FlateDecode") ? inflateSync(raw) : raw).toString("latin1");
}

type PdfPaint = { index: number; op: "fill" | "stroke" | "text"; rgb: Rgb };

/**
 * The page's painting operators in content-stream order (later paints on top), each with the colour
 * in effect: fills (f, f*, B, B*, b, b*) and shown text (Tj, TJ) use the fill colour (rg or g), strokes
 * (S, s) the stroke colour (RG or G).
 */
function pdfPaints(stream: string): PdfPaint[] {
  const paints: PdfPaint[] = [];
  let fill: Rgb = [0, 0, 0];
  let stroke: Rgb = [0, 0, 0];
  const stack: Array<{ fill: Rgb; stroke: Rgb }> = [];
  const channel = (value: string) => Math.round(Number(value) * 255);
  for (const line of stream.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const op = parts.at(-1);
    if (op === "q") stack.push({ fill, stroke });
    else if (op === "Q") ({ fill, stroke } = stack.pop() ?? { fill, stroke });
    else if (op === "rg" && parts.length === 4) fill = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)];
    else if (op === "g" && parts.length === 2) fill = [channel(parts[0]!), channel(parts[0]!), channel(parts[0]!)];
    else if (op === "RG" && parts.length === 4) stroke = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)];
    else if (op === "G" && parts.length === 2) stroke = [channel(parts[0]!), channel(parts[0]!), channel(parts[0]!)];
    else if (op && /^(f\*?|B\*?|b\*?)$/.test(op) && parts.length === 1) paints.push({ index: paints.length, op: "fill", rgb: fill });
    else if (op && /^(S|s)$/.test(op) && parts.length === 1) paints.push({ index: paints.length, op: "stroke", rgb: stroke });
    // A text object's colour is set inside BT; record the run when its glyphs are shown.
    else if (op === "Tj" || op === "TJ") paints.push({ index: paints.length, op: "text", rgb: fill });
  }
  return paints;
}

function pdfOffsets(stream: string, op: PdfPaint["op"], rgb?: Rgb): number[] {
  return pdfPaints(stream).filter(paint => paint.op === op && (!rgb || near(paint.rgb, rgb, 3))).map(paint => paint.index);
}

async function exportPdf(document: ChemDraftDocument) {
  // svg2pdf measures text with getBBox, which jsdom lacks. The stub only feeds text-anchor offsets
  // (where a run starts), never which operators are emitted or their order.
  const previous = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: function (this: Element) {
    const size = Number.parseFloat(this.getAttribute("font-size") ?? "16") || 16;
    return { x: 0, y: 0, width: (this.textContent ?? "").length * size * 0.6, height: size };
  } });
  try {
    return (await exportPhase4Pdf(document, { compress: false })).bytes;
  } finally {
    if (previous) Object.defineProperty(SVGElement.prototype, "getBBox", previous);
    else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  }
}

// ---------------------------------------------------------------- the four surfaces

describe("issue #107: art never hides an object in front of it", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stylesheet: HTMLStyleElement;

  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      for (const proto of [SVGElement.prototype, HTMLElement.prototype]) {
        Object.defineProperty(proto, name, { configurable: true, writable: true,
          value: name === "hasPointerCapture" ? () => false : () => {} });
      }
    }
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    // The real stylesheet: stacking (z-index, position) and pointer-events come from App.css.
    stylesheet = document.createElement("style");
    const css = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    const tokens = Object.fromEntries([...css.slice(0, css.indexOf("}")).matchAll(/(--cd-[\w-]+):\s*([^;]+);/g)]
      .map(match => [match[1], match[2]]));
    stylesheet.textContent = css.replace(/var\((--cd-[\w-]+)\)/g, (expression, name: string) => tokens[name] ?? expression);
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

  async function renderCanvas(nativeDocument: ChemDraftDocument) {
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: nativeDocument,
      initialActiveToolCommandId: "tool.select",
      initialPaletteMode: "hidden",
      initialCrosshairsVisible: false,
      initialRulersVisible: false,
      nativePalette: true
    })));
    const page = container.querySelector<HTMLElement>(".page")!;
    page.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      right: nativeDocument.pages[0].width, bottom: nativeDocument.pages[0].height,
      width: nativeDocument.pages[0].width, height: nativeDocument.pages[0].height, toJSON: () => ({}) });
  }

  const zIndex = (element: Element) => Number(getComputedStyle(element).zIndex);

  /** The element that carries an object's visible canvas paint, and the stacking box it paints in. */
  function canvasPaint(id: string) {
    const svgVisual = container.querySelector(`[data-page-svg-object-visual="${id}"]`);
    if (svgVisual) return { visual: svgVisual, box: svgVisual.closest("svg.page-svg-visual-layer") ?? svgVisual.closest("svg")! };
    const molecule = container.querySelector(`.native-molecule-object[data-object-id="${id}"]`);
    if (molecule) return { visual: molecule.querySelector("[data-native-molecule-overlay-visual]") ?? molecule, box: molecule };
    throw new Error(`No canvas paint for ${id}`);
  }

  /**
   * Bottom-to-top paint order of the given objects on the canvas, from the DOM the browser composites:
   * every paint box must be a positioned child of the one page-object stack (a single stacking
   * context), so the order is z-index, then DOM order.
   */
  function canvasOrder(ids: string[]) {
    const stack = container.querySelector("[data-page-object-stack]")!;
    expect(stack).not.toBeNull();
    const paints = ids.map(id => ({ id, ...canvasPaint(id) }));
    for (const paint of paints) {
      expect(paint.box.parentElement, `${paint.id} paints outside the page object stack`).toBe(stack);
      expect(getComputedStyle(paint.box).position).toBe("absolute");
      expect(Number.isFinite(zIndex(paint.box))).toBe(true);
    }
    return paints.sort((a, b) => zIndex(a.box) - zIndex(b.box) ||
      (a.visual.compareDocumentPosition(b.visual) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).map(paint => paint.id);
  }

  /** Every element that paints something an export would not: dormant overlay copies must be invisible. */
  function expectNoVisibleDuplicatePaint() {
    for (const selector of [".graphic-object .graphic-glyph-shell", ".reaction-arrow-object > .reaction-arrow-glyph",
      ".bracket-object > .bracket-glyph"]) {
      for (const element of container.querySelectorAll(selector)) {
        expect(getComputedStyle(element).opacity, `${selector} is a visible second copy`).toBe("0");
      }
    }
    const textOverlay = container.querySelectorAll(".text-object.document-object-overlay");
    for (const element of textOverlay) {
      // The text's positioned frame carries no glyphs of its own; its paint is the ordered SVG group.
      expect(element.textContent?.trim() ?? "").toBe("");
    }
  }

  /**
   * A standalone SVG of exactly what the canvas paints, in its stacking order (the composite a user
   * sees, minus browser text shaping): the ordered SVG runs and the native molecule overlays.
   */
  function canvasComposite(nativeDocument: ChemDraftDocument): string {
    const page = nativeDocument.pages[0];
    const stack = container.querySelector("[data-page-object-stack]")!;
    const boxes = [...stack.children].filter(element =>
      element.matches("svg.page-svg-visual-layer, .native-molecule-object"))
      .sort((a, b) => zIndex(a) - zIndex(b) || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const visible = (element: Element) => {
      const copy = element.cloneNode(true) as Element;
      // Transparent routing shapes (transparent only through App.css, which resvg does not load).
      copy.querySelectorAll("[data-hit-target], .native-molecule-ring-hit-target, .graphic-glyph-hit-target, .native-bond-hover-decorator, [data-table-hit-target], [data-electron-mark-hit-target]")
        .forEach(hit => hit.remove());
      return copy;
    };
    const paint = boxes.map(element => {
      if (element instanceof SVGElement) return visible(element).innerHTML;
      const molecule = page.objects.find(object => object.id === element.getAttribute("data-object-id")) as MoleculeObject;
      const overlay = element.querySelector("[data-native-molecule-overlay-visual]");
      return overlay ? `<g transform="translate(${molecule.x} ${molecule.y})">${visible(overlay).outerHTML}</g>` : "";
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">${paint}</svg>`;
  }

  async function pointer(target: Element, type: "pointerdown" | "pointerup", point: { x: number; y: number }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1,
      detail: 1, clientX: point.x, clientY: point.y });
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 7 }, pointerType: { value: "mouse" } });
    await act(async () => target.dispatchEvent(event));
  }

  // ------------------------------------------------------------ case 1

  describe("case 1: text in front of a filled opaque rectangle", () => {
    it("canvas paints the text above the rectangle", async () => {
      const { document: doc, rect, text } = case1();
      await renderCanvas(doc);
      expect(canvasOrder([text.id, rect.id])).toEqual([rect.id, text.id]);
      expectNoVisibleDuplicatePaint();
      const composite = canvasComposite(doc);
      const raster = rasterize(composite);
      save("case1-canvas-composite.svg", composite);
      save("case1-canvas-composite.png", raster.png);
      expect(countPixels(raster, TEXT_INK, dark)).toBeGreaterThan(20);
    });

    it("SVG export draws the text after the rectangle", async () => {
      const { document: doc, rect, text } = case1();
      const svg = await exportSvg(doc);
      save("case1-svg.svg", svg);
      expect(svgObjectOrder(svg, [rect.id, text.id])).toEqual([rect.id, text.id]);
    });

    it("PDF export fills the rectangle before it draws the text", async () => {
      const { document: doc } = case1();
      const bytes = await exportPdf(doc);
      save("case1-pdf.pdf", bytes);
      const stream = pdfContentStream(bytes);
      save("case1-pdf-content-stream.txt", stream);
      const fills = pdfOffsets(stream, "fill", ORANGE);
      const texts = pdfOffsets(stream, "text");
      expect(fills.length).toBeGreaterThan(0);
      expect(texts.length).toBeGreaterThan(0);
      expect(Math.max(...fills)).toBeLessThan(Math.min(...texts));
    });

    it("PNG export shows the text ink inside the rectangle", async () => {
      const { document: doc } = case1();
      const raster = rasterize(await exportSvg(doc));
      save("case1-png.png", raster.png);
      expect(countPixels(raster, TEXT_INK, dark)).toBeGreaterThan(20);
    });
  });

  // ------------------------------------------------------------ case 2

  describe("case 2: the same text sent to back is covered by the rectangle", () => {
    it("canvas paints the rectangle above the text, after Send to Back", async () => {
      const { document: front, rect, text } = case1();
      await renderCanvas(withObjects(front.pages[0].objects, [text.id]));
      await act(async () => window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "layout.sendToBack" } })));
      expect(window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects.map(object => object.id)).toEqual([text.id, rect.id]);
      expect(canvasOrder([text.id, rect.id])).toEqual([text.id, rect.id]);
      expectNoVisibleDuplicatePaint();
      const composite = canvasComposite(case2().document);
      const raster = rasterize(composite);
      save("case2-canvas-composite.svg", composite);
      save("case2-canvas-composite.png", raster.png);
      expect(countPixels(raster, TEXT_INK, notOrange)).toBe(0);
    });

    it("SVG export draws the rectangle after the text", async () => {
      const { document: doc, rect, text } = case2();
      const svg = await exportSvg(doc);
      save("case2-svg.svg", svg);
      expect(svgObjectOrder(svg, [rect.id, text.id])).toEqual([text.id, rect.id]);
    });

    it("PDF export draws the text before it fills the rectangle", async () => {
      const { document: doc } = case2();
      const bytes = await exportPdf(doc);
      save("case2-pdf.pdf", bytes);
      const stream = pdfContentStream(bytes);
      save("case2-pdf-content-stream.txt", stream);
      const fills = pdfOffsets(stream, "fill", ORANGE);
      const texts = pdfOffsets(stream, "text");
      expect(fills.length).toBeGreaterThan(0);
      expect(texts.length).toBeGreaterThan(0);
      expect(Math.max(...texts)).toBeLessThan(Math.min(...fills));
    });

    it("PNG export shows only the rectangle where the text is", async () => {
      const { document: doc } = case2();
      const raster = rasterize(await exportSvg(doc));
      save("case2-png.png", raster.png);
      expect(countPixels(raster, TEXT_INK, notOrange)).toBe(0);
    });
  });

  // ------------------------------------------------------------ case 3

  describe("case 3: a white rectangle in front of part of a molecule covers it", () => {
    it("canvas paints the white rectangle above the native molecule", async () => {
      const { document: doc, molecule: mol, white, covered, uncovered } = case3();
      await renderCanvas(doc);
      expect(canvasOrder([mol.id, white.id])).toEqual([mol.id, white.id]);
      expectNoVisibleDuplicatePaint();
      const composite = canvasComposite(doc);
      const raster = rasterize(composite);
      save("case3-canvas-composite.svg", composite);
      save("case3-canvas-composite.png", raster.png);
      expect(countPixels(raster, uncovered, dark)).toBeGreaterThan(10);
      expect(countPixels(raster, covered, dark)).toBe(0);
    });

    it("SVG export draws the white rectangle after the molecule", async () => {
      const { document: doc, molecule: mol, white } = case3();
      const svg = await exportSvg(doc);
      save("case3-svg.svg", svg);
      expect(svgObjectOrder(svg, [mol.id, white.id])).toEqual([mol.id, white.id]);
    });

    it("PDF export strokes the bonds before it fills the white rectangle", async () => {
      const { document: doc } = case3();
      const bytes = await exportPdf(doc);
      save("case3-pdf.pdf", bytes);
      const stream = pdfContentStream(bytes);
      save("case3-pdf-content-stream.txt", stream);
      // The first white fill is the page background; the box is the white fill after it.
      const whiteFills = pdfOffsets(stream, "fill", [255, 255, 255]);
      const bondStrokes = pdfOffsets(stream, "stroke", [0, 0, 0]);
      expect(bondStrokes.length).toBeGreaterThan(0);
      expect(whiteFills.length).toBeGreaterThan(1);
      expect(Math.max(...bondStrokes)).toBeLessThan(whiteFills.at(-1)!);
    });

    it("PNG export shows no bond ink under the white rectangle", async () => {
      const { document: doc, covered, uncovered } = case3();
      const raster = rasterize(await exportSvg(doc));
      save("case3-png.png", raster.png);
      expect(countPixels(raster, uncovered, dark)).toBeGreaterThan(10);
      expect(countPixels(raster, covered, dark)).toBe(0);
    });
  });

  // ------------------------------------------------------------ case 4

  describe("case 4: a molecule's atom label in front of a filled shape", () => {
    it("canvas paints the molecule (and its O label) above the shape", async () => {
      const { document: doc, molecule: mol, shape, label } = case4();
      await renderCanvas(doc);
      expect(canvasOrder([shape.id, mol.id])).toEqual([shape.id, mol.id]);
      const labelText = [...canvasPaint(mol.id).visual.querySelectorAll("text")].find(node => node.textContent?.trim() === "O");
      expect(labelText, "native molecule paints an O label").toBeDefined();
      expectNoVisibleDuplicatePaint();
      const composite = canvasComposite(doc);
      const raster = rasterize(composite);
      save("case4-canvas-composite.svg", composite);
      save("case4-canvas-composite.png", raster.png);
      expect(countPixels(raster, label, notOrange)).toBeGreaterThan(10);
    });

    it("SVG export draws the molecule after the shape", async () => {
      const { document: doc, molecule: mol, shape } = case4();
      const svg = await exportSvg(doc);
      save("case4-svg.svg", svg);
      expect(svgObjectOrder(svg, [shape.id, mol.id])).toEqual([shape.id, mol.id]);
    });

    it("PDF export fills the shape before it draws the O label", async () => {
      const { document: doc } = case4();
      const bytes = await exportPdf(doc);
      save("case4-pdf.pdf", bytes);
      const stream = pdfContentStream(bytes);
      save("case4-pdf-content-stream.txt", stream);
      const fills = pdfOffsets(stream, "fill", ORANGE);
      const texts = pdfOffsets(stream, "text");
      expect(fills.length).toBeGreaterThan(0);
      expect(texts.length).toBeGreaterThan(0);
      expect(Math.max(...fills)).toBeLessThan(Math.min(...texts));
    });

    it("PNG export shows the O label over the shape", async () => {
      const { document: doc, label } = case4();
      const raster = rasterize(await exportSvg(doc));
      save("case4-png.png", raster.png);
      expect(countPixels(raster, label, notOrange)).toBeGreaterThan(10);
    });
  });

  // ------------------------------------------------------------ case 5

  describe("case 5: clicking the front text selects the text, not the rectangle", () => {
    it("routes a press at the overlap to the text and selects it", async () => {
      const { document: doc, rect, text } = case1();
      await renderCanvas(doc);
      // Inside the "T" of TOP (36 px glyphs from the text top), where a real press would land on the glyph.
      const overlap = { x: text.x + 10, y: text.y + 20 };
      // jsdom has no elementFromPoint. Find the topmost element that takes pointer events at the overlap
      // from the real DOM and CSS: the highest paint box first, then later DOM order inside it.
      const textGlyph = canvasPaint(text.id).visual.querySelector("text")!;
      const rectCatcher = canvasPaint(rect.id).visual.querySelector(".graphic-glyph-hit-target, .graphic-glyph-shape")!;
      expect(textGlyph).not.toBeNull();
      expect(rectCatcher).not.toBeNull();
      expect(getComputedStyle(textGlyph).pointerEvents).not.toBe("none");
      expect(canvasOrder([rect.id, text.id]).at(-1)).toBe(text.id);
      // Hidden overlay copies of the rectangle must not catch the press (issue #107 comment, point 3).
      for (const dormant of container.querySelectorAll(`.graphic-object[data-object-id="${rect.id}"] *`)) {
        expect(getComputedStyle(dormant).pointerEvents, "dormant rectangle copy catches pointer events").toBe("none");
      }
      // Nothing in the interaction layer above the paint stack may catch the press either.
      const interaction = container.querySelector("[data-page-interaction-layer]");
      for (const element of interaction?.querySelectorAll<HTMLElement>("*") ?? []) {
        if (getComputedStyle(element).pointerEvents !== "none") {
          expect(element.closest(`[data-object-controls="${rect.id}"]`), "rectangle chrome catches the press").toBeNull();
        }
      }
      await pointer(textGlyph, "pointerdown", overlap);
      await pointer(textGlyph, "pointerup", overlap);
      expect(window.__CHEMDRAFT_AGENT__!.snapshot().selection.objectIds).toEqual([text.id]);
    });
  });
});
