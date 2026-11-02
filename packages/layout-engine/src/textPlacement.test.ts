import { describe, expect, it } from "vitest";
import { createEmptyDocument, TextObjectSchema } from "@chemdraft/chem-core";
import { planPageSvgRender, measureNativeTextSpanLineWidth, textObjectSpanLines } from "./index";
import { elementFragments } from "./testing";
import { planTextObjectEditorPlacement, planTextObjectPlacement } from "./textPlacement";

const cases = [0.5, 1, 2].flatMap(zoom => (["left", "center", "right"] as const).flatMap(textAlign =>
  (["auto", "fixed-width", "fixed-size"] as const).map(textBoxSizingMode => ({ zoom, textAlign, textBoxSizingMode }))));

describe("SVG and CSS text placement", () => {
  it.each(cases.flatMap(placement => [0, 0.1].flatMap(height =>
    ["", "H"].map(text => ({ ...placement, height, text })))))(
    "keeps a one-line hit area and baseline for '$text', height $height, $textAlign, $zoom, $textBoxSizingMode",
    ({ zoom, textAlign, textBoxSizingMode, height, text }) => {
      const object = TextObjectSchema.parse({ id: "text", type: "text", x: 200, y: 160, width: 1, height,
        text, style: { fontSizePx: 18.667, textAlign, textBoxSizingMode } });
      const original = structuredClone(object);
      const svg = planTextObjectPlacement(object);
      const metrics = { ascentPx: 17 * zoom, descentPx: 4 * zoom };
      const { frame, content } = planTextObjectEditorPlacement(object, zoom, 12, metrics);
      const lineHeight = svg.lineAdvance * zoom;
      expect(frame.height).toBeGreaterThanOrEqual(lineHeight);
      expect(content.height).toBeGreaterThanOrEqual(lineHeight);
      expect(frame.width).toBeGreaterThanOrEqual(24);
      expect(content.width).toBeGreaterThanOrEqual(24);
      expect(frame.top).toBe(object.y * zoom);
      expect(frame.left + content.left + svg.alignment * content.width).toBeCloseTo(svg.x * zoom, 10);
      expect(Math.abs(frame.top + content.top + (lineHeight + metrics.ascentPx - metrics.descentPx) / 2 - svg.y * zoom))
        .toBeLessThan(0.25);
      expect(frame.left + frame.originX).toBeCloseTo((object.x + object.width / 2) * zoom, 10);
      expect(frame.top + frame.originY).toBeCloseTo((object.y + object.height / 2) * zoom, 10);
      expect(object).toEqual(original);
    });

  it.each(cases)("shares the first baseline: $textAlign, zoom $zoom, $textBoxSizingMode", ({ zoom, textAlign, textBoxSizingMode }) => {
    const object = TextObjectSchema.parse({
      id: "text", type: "text", x: 203.125, y: 160.25, width: 72, height: 28,
      text: "HHHHHH", spans: [], style: { fontFamily: "Arial", fontSizePx: 18.667, lineHeight: 1.2, textAlign, textBoxSizingMode }
    });
    const page = { ...createEmptyDocument().pages[0], width: 792, height: 612, objects: [object] };
    const text = planPageSvgRender(page).fragments.flatMap(elementFragments).find(fragment => fragment.tag === "text")!;
    const style = planTextObjectPlacement(object).style;
    // Arial.ttf head.unitsPerEm=2048; hhea ascender=1854, descender=-434.
    // Win ascent/descent are the same. No host font dependency in this unit test.
    const metrics = { ascentPx: 1854 / 2048 * 18.667 * zoom, descentPx: 434 / 2048 * 18.667 * zoom };
    const contentWidth = measureNativeTextSpanLineWidth(textObjectSpanLines(object)[0], style);
    const { frame, content } = planTextObjectEditorPlacement(object, zoom, contentWidth, metrics);
    const anchor = textAlign === "center" ? 0.5 : textAlign === "right" ? 1 : 0;
    const halfLeading = (parseFloat(content.lineHeight) - metrics.ascentPx - metrics.descentPx) / 2;
    // Reconstruct from the actual CSS style fields, not the helper's baseline output.
    const contentWidthCss = content.width - 2 * (content.borderWidth + content.padding);
    // Same six glyphs at the same size: subtract their advance for the baseline's
    // starting point, rather than comparing only the middle/end alignment anchor.
    const advance = contentWidth * zoom;
    const editorX = frame.left + content.left + content.borderWidth + content.padding + anchor * (contentWidthCss - advance);
    const editorY = frame.top + content.top + content.borderWidth + content.padding + halfLeading + metrics.ascentPx;
    expect(Math.abs(editorX - (Number(text.attrs.x) * zoom - anchor * advance))).toBeLessThan(0.25);
    expect(Math.abs(editorY - Number(text.attrs.y) * zoom)).toBeLessThan(0.25);
    expect(text.attrs["text-anchor"]).toBe(textAlign === "center" ? "middle" : textAlign === "right" ? "end" : "start");
    expect(content.fontSize).toBe(18.667 * zoom);
    expect(content.boxSizing).toBe("border-box");
    expect(frame.left + frame.originX).toBeCloseTo((object.x + object.width / 2) * zoom, 10);
    expect(frame.top + frame.originY).toBeCloseTo((object.y + object.height / 2) * zoom, 10);
  });

  it.each([1, 2])("uses SVG's border-reduced viewport scale at zoom %s", zoom => {
    const object = TextObjectSchema.parse({ id: "text", type: "text", x: 300, y: 240, width: 90, height: 28,
      text: "HHHHHH", style: { fontSizePx: 18.667, textAlign: "center" } });
    // 792 x 612 border-box page, 1 px borders, SVG xMidYMid meet.
    const scale = Math.min((792 * zoom - 2) / 792, (612 * zoom - 2) / 612);
    const offset = { x: (792 * zoom - 2 - 792 * scale) / 2, y: 0 };
    const metrics = { ascentPx: 17 * scale, descentPx: 4 * scale };
    const { frame, content } = planTextObjectEditorPlacement(object, scale, 81, metrics, offset);
    const svg = planTextObjectPlacement(object);
    expect(frame.left + content.left + content.width / 2).toBeCloseTo(offset.x + svg.x * scale, 10);
    expect(frame.top + content.top + (parseFloat(content.lineHeight) + metrics.ascentPx - metrics.descentPx) / 2)
      .toBeCloseTo(svg.y * scale, 10);
  });

  it("preserves the baseline when metrics include equal half-leading", () => {
    const object = TextObjectSchema.parse({ id: "text", type: "text", x: 0, y: 0, width: 90, height: 28, text: "HHHHHH" });
    const raw = planTextObjectEditorPlacement(object, 1, 80, { ascentPx: 17, descentPx: 4 });
    const measured = planTextObjectEditorPlacement(object, 1, 80, { ascentPx: 18.25, descentPx: 5.25 });
    expect(measured.content.top).toBe(raw.content.top);
  });
});
