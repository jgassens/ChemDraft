// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeTextStyleFromObjectStyle, type TextObject } from "@chemdraft/chem-core";
import { measureNativeTextSpanLineWidth, planTextObjectEditorPlacement, textObjectSpanLines } from "@chemdraft/layout-engine";
import { MainWindow } from "./MainWindow";
import { createPhase4Document, insertNativeTextObject } from "./documentWorkflow";
import * as metricsReader from "./textEditorMetrics";
import { MemoryStorage } from "./testSupport/memoryStorage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["macos", "windows"] as const)("text editor placement (%s)", platform => {
  let container: HTMLDivElement, root: Root;
  let stylesheet: HTMLStyleElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    window.history.replaceState(null, "", "/?agentBridge=1");
    stylesheet = document.createElement("style");
    // Include the real editor rules to catch a CSS inset/min-width/border regression.
    const css = readFileSync(resolve("apps/desktop/src/App.css"), "utf8");
    stylesheet.textContent = ["text-object-content", "text-object-edit-preview", "text-object-editor", "rich-text-object-editor"]
      .map(name => css.match(new RegExp(`^\\.${name} \\{[^}]+\\}`, "m"))![0]).join("\n");
    document.head.append(stylesheet);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.spyOn(metricsReader, "measureTextEditorMetrics").mockImplementation((style, scale) => ({
      ascentPx: 1854 / 2048 * style.fontSizePx * scale,
      descentPx: 434 / 2048 * style.fontSizePx * scale
    }));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); stylesheet.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  it.each([
    ...[1, 1.25, 1.5, 2].flatMap(dpr => [12, 13.333, 18.667, 14 * 96 / 72, 24].flatMap(fontSizePx => [1, 2].flatMap(zoom =>
      (["left", "center", "right"] as const).map(textAlign => ({ zoom, textAlign, fontSizePx, dpr, text: "HHHHHH", height: undefined }))))),
    ...[0.5, 1].flatMap(zoom => (["left", "center", "right"] as const).flatMap(textAlign =>
      [0, 0.1].flatMap(height => ["", "H"].map(text => ({ zoom, textAlign, fontSizePx: 14 * 96 / 72, dpr: 1, text, height })))))
  ])(
    "applies glyph origins: '$text', height $height, $fontSizePx px, $textAlign at $zoom, DPR $dpr", async ({ zoom, textAlign, fontSizePx, dpr, text, height }) => {
      vi.stubGlobal("devicePixelRatio", dpr);
      const drawing = structuredClone(insertNativeTextObject(createPhase4Document("Text placement"), { x: 200, y: 160 }, text,
        { fontFamily: "Arial", fontSizePx, textAlign }));
      const object = drawing.pages[0].objects[0] as TextObject;
      if (height !== undefined) {
        object.height = height;
        object.width = 1;
        object.style.textBoxSizingMode = "fixed-size";
      }
      const original = structuredClone(object);
      const scale = Math.min((drawing.pages[0].width * zoom - 2) / drawing.pages[0].width,
        (drawing.pages[0].height * zoom - 2) / drawing.pages[0].height);
      const offset = { x: (drawing.pages[0].width * zoom - 2 - drawing.pages[0].width * scale) / 2,
        y: (drawing.pages[0].height * zoom - 2 - drawing.pages[0].height * scale) / 2 + 0.375 / dpr };
      vi.spyOn(metricsReader, "measureTextEditorViewport").mockReturnValue({ scale, offset });
      await act(async () => root.render(createElement(MainWindow, {
        initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true,
        initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
      })));
      if (zoom !== 1) await act(async () => {
        container.querySelector(".canvas-region")!.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(zoom) / 0.002
        }));
      });
      const glyph = container.querySelector<SVGTextElement>(`[data-page-svg-object-visual="${object.id}"] text`)!;
      const svgX = Number(glyph.getAttribute("x")), svgY = Number(glyph.getAttribute("y"));
      await act(async () => glyph.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
      await act(async () => vi.advanceTimersByTimeAsync(100));
      const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
      const preview = container.querySelector<SVGGElement>(".text-object-edit-preview")!;
      // Identical attributes in a second, HTML-sized SVG do not imply identical
      // rendered glyphs: its fractional viewport has its own layout/raster phase.
      // Chromium trace, 18.667 px at 200%, 32-unit-high box: the old preview's
      // requested 63.9215686 px height became 63.90625 px, changing its Y scale
      // from the canvas's 1.9975490 to 1.9970703. CSS style algebra misses this.
      // The live glyphs must inherit the very same page viewport as the canvas.
      expect(preview.ownerSVGElement).toBe(glyph.ownerSVGElement);
      expect(preview.parentElement).toBe(glyph.parentElement!.parentElement);
      expect(preview.getAttribute("transform")).toBe(glyph.parentElement!.getAttribute("transform"));
      expect(preview.getAttribute("style")).toBeNull();
      expect(glyph.ownerSVGElement!.querySelector("svg")).toBeNull();
      const frame = editor.closest<HTMLElement>(".document-object-chrome")!;
      const style = nativeTextStyleFromObjectStyle(object.style);
      const metrics = metricsReader.measureTextEditorMetrics(style, scale, style.fontSizePx * style.lineHeight * scale)!;
      const expected = planTextObjectEditorPlacement(object, scale,
        measureNativeTextSpanLineWidth(textObjectSpanLines(object)[0], style), metrics, offset);
      const computed = getComputedStyle(editor);
      for (const key of ["left", "top", "width", "height", "fontSize", "padding", "borderWidth"] as const) {
        expect(parseFloat(computed[key]), key).toBeCloseTo(expected.content[key], 8);
      }
      expect(computed.lineHeight).toBe(expected.content.lineHeight);
      expect(computed.boxSizing).toBe("border-box");
      expect(computed.textAlign).toBe(textAlign);
      expect(parseFloat(computed.minHeight)).toBe(0);
      expect(editor.style.right).toBe("");
      expect(preview.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(getComputedStyle(preview).pointerEvents).toBe("none");
      const previewGlyph = preview.querySelector("text")!;
      expect(previewGlyph.outerHTML).toBe(glyph.outerHTML);
      // Both glyphs inherit the *same* page transform, rather than deriving a
      // second transform from CSS lengths (jsdom cannot resolve SVG viewports).
      const previewX = offset.x + Number(previewGlyph.getAttribute("x")) * scale;
      const previewY = offset.y + Number(previewGlyph.getAttribute("y")) * scale;
      expect(Math.abs(previewX - (offset.x + svgX * scale))).toBeLessThan(0.25);
      expect(Math.abs(previewY - (offset.y + svgY * scale))).toBeLessThan(0.25);
      expect(previewX).toBeCloseTo(offset.x + svgX * scale, 10);
      expect(previewY).toBeCloseTo(offset.y + svgY * scale, 10);
      expect(frame.style.left).toBe(`${expected.frame.left}px`);
      expect(frame.style.top).toBe(`${expected.frame.top}px`);
      expect(frame.style.width).toBe(`${expected.frame.width}px`);
      expect(frame.style.getPropertyValue("--page-scale")).toBe(String(scale));
      const lineHeight = parseFloat(editor.style.lineHeight);
      expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(lineHeight);
      expect(parseFloat(editor.style.height)).toBeGreaterThanOrEqual(lineHeight);
      expect(parseFloat(frame.style.width)).toBeGreaterThanOrEqual(24);
      expect(parseFloat(editor.style.width)).toBeGreaterThanOrEqual(24);
      const baseline = parseFloat(frame.style.top) + parseFloat(editor.style.top)
        + (lineHeight + metrics.ascentPx - metrics.descentPx) / 2;
      expect(Math.abs(baseline - (offset.y + svgY * scale))).toBeLessThan(0.25);
      const anchor = textAlign === "center" ? 0.5 : textAlign === "right" ? 1 : 0;
      expect(parseFloat(frame.style.left) + parseFloat(editor.style.left) + anchor * parseFloat(editor.style.width))
        .toBeCloseTo(offset.x + svgX * scale, 8);
      const saved = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0].objects[0];
      expect(saved()).toEqual(original);
      await act(async () => editor.blur());
      expect(container.querySelector(".text-object-editor")).toBeNull();
      expect(container.querySelector(".text-object-edit-preview")).toBeNull();
      expect(container.querySelector(`[data-page-svg-object-visual="${object.id}"] text`)).toBe(glyph);
      expect(glyph.parentElement!.getAttribute("visibility")).toBeNull();
      expect(saved()).toEqual(original);
    });

  it.each([0, 31, -45])("keeps rich text in the canvas coordinate system through typing and blur at %s degrees", async rotation => {
    const drawing = structuredClone(insertNativeTextObject(createPhase4Document("Rich text placement"),
      { x: 200.125, y: 160.375 }, "H2O solution", { fontSizePx: 18.667, textAlign: "center" }));
    const object = drawing.pages[0].objects[0] as TextObject;
    object.rotation = rotation;
    object.spans = [
      { text: "H", script: "normal", style: { fontSizePx: 18.667 } },
      { text: "2", script: "subscript", style: {} },
      { text: "O solution", script: "normal", style: { fontSizePx: 13.333 } }
    ];
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
    })));
    const glyph = container.querySelector<SVGTextElement>(`[data-page-svg-object-visual="${object.id}"] text`)!;
    const canvas = glyph.ownerSVGElement;
    await act(async () => glyph.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const preview = () => container.querySelector<SVGGElement>(".text-object-edit-preview")!;
    expect(preview().ownerSVGElement).toBe(canvas);
    expect(preview().querySelector("text")!.outerHTML).toBe(glyph.outerHTML);
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "H2O solution updated");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(preview().ownerSVGElement).toBe(canvas);
    const edited = preview().querySelector("text")!;
    expect(edited.textContent).toBe("H2O solution updated");
    expect(edited.outerHTML).toBe(glyph.outerHTML);
    const editedMarkup = edited.outerHTML;
    await act(async () => editor.blur());
    expect(preview()).toBeNull();
    expect(glyph.ownerSVGElement).toBe(canvas);
    expect(glyph.outerHTML).toBe(editedMarkup);
  });

  it("remeasures on DPR and container resize, re-arms resolution, and cleans up on unmount", async () => {
    const queries: Array<{ query: string; target: EventTarget; add: ReturnType<typeof vi.spyOn>; remove: ReturnType<typeof vi.spyOn> }> = [];
    vi.stubGlobal("devicePixelRatio", 1);
    vi.stubGlobal("matchMedia", vi.fn((query: string) => {
      const target = new EventTarget();
      queries.push({ query, target, add: vi.spyOn(target, "addEventListener"), remove: vi.spyOn(target, "removeEventListener") });
      return target;
    }));
    const observers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      constructor(public callback: () => void) { observers.push(this); }
    });
    const viewport = vi.spyOn(metricsReader, "measureTextEditorViewport").mockReturnValue({ scale: 1, offset: { x: 0, y: 0 } });
    const measure = vi.mocked(metricsReader.measureTextEditorMetrics);
    const drawing = insertNativeTextObject(createPhase4Document("DPR placement"), { x: 200, y: 160 }, "H");
    await act(async () => root.render(createElement(MainWindow, {
      initialDocument: drawing, initialPaletteMode: "hidden", nativePalette: true,
      initialRulersVisible: false, initialCrosshairsVisible: false, shortcutPlatform: platform
    })));
    const observerCount = observers.length;
    await act(async () => container.querySelector("[data-page-svg-object-visual] text")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const editor = container.querySelector<HTMLTextAreaElement>(".text-object-editor")!;
    const initialTop = parseFloat(editor.style.top);
    const observer = observers.slice(observerCount).find(item => item.observe.mock.calls.some(([target]) => target.matches(".page")))!;
    expect(observer.observe).toHaveBeenCalledWith(container.querySelector(".canvas-region"));
    let query = queries[queries.length - 1];
    expect(query.query).toBe("(resolution: 1dppx)");
    measure.mockClear(); viewport.mockClear();
    measure.mockReturnValue({ ascentPx: 15, descentPx: 3 });
    vi.stubGlobal("devicePixelRatio", 2);
    await act(async () => { query.target.dispatchEvent(new Event("change")); });
    expect(measure).toHaveBeenCalledTimes(1);
    expect(viewport).toHaveBeenCalledTimes(1);
    expect(parseFloat(editor.style.top)).not.toBe(initialTop);
    expect(query.remove).toHaveBeenCalledWith("change", query.add.mock.calls[0][1]);
    query = queries[queries.length - 1];
    expect(query.query).toBe("(resolution: 2dppx)");
    vi.stubGlobal("devicePixelRatio", 1);
    await act(async () => { query.target.dispatchEvent(new Event("change")); });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(queries[queries.length - 1].query).toBe("(resolution: 1dppx)");
    viewport.mockReturnValue({ scale: 0.5, offset: { x: 0.25, y: 0 } });
    await act(async () => observer.callback());
    expect(measure).toHaveBeenCalledTimes(3);
    expect(viewport).toHaveBeenCalledTimes(3);
    expect(editor.closest<HTMLElement>(".document-object-chrome")!.style.getPropertyValue("--page-scale")).toBe("0.5");
    // Content edits do not invalidate browser metrics or recreate subscriptions.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "HH");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(measure).toHaveBeenCalledTimes(3);
    // Render away the document so afterEach can still unmount the root normally.
    await act(async () => root.render(null));
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    for (const watched of queries) {
      expect(watched.remove).toHaveBeenCalledWith("change", watched.add.mock.calls[0][1]);
      watched.target.dispatchEvent(new Event("change"));
    }
    expect(measure).toHaveBeenCalledTimes(3);
  });
});
