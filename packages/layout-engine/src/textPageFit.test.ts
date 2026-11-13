import { describe, expect, it } from "vitest";
import { TextObjectSchema } from "@chemdraft/chem-core";
import { objectFrameBoundsForPageFit, textVisualBoundsForArrangement, textVisualBoundsForPageFit } from "./index";

const text = () => TextObjectSchema.parse({ id: "caption", type: "text", text: "MMMMM\nMMMMM\nMMMMM",
  x: 100, y: 100, width: 20, height: 20, rotation: 0, spans: [],
  style: { fontFamily: "Courier New", fontSizePx: 20, lineHeight: 1, paragraphSpacingPx: 0 } });

describe("text painted beyond constrained frames", () => {
  it("keeps a rotated frame that fits at the page edge exact", () => {
    const object = text(); Object.assign(object, { x: 0, y: 5, width: 20, height: 10, rotation: 90 });
    const bounds = objectFrameBoundsForPageFit(object);
    expect(bounds.x).toBeCloseTo(5); expect(bounds.y).toBeCloseTo(0);
    expect(bounds.width).toBeCloseTo(10); expect(bounds.height).toBeCloseTo(20);
  });
  it("includes all explicit lines without changing the object or arrangement-frame contract", () => {
    const object = text(), before = structuredClone(object);
    expect(textVisualBoundsForArrangement(object)).toEqual({ x: 100, y: 100, width: 20, height: 20 });
    const bounds = textVisualBoundsForPageFit(object);
    // Five Courier M advances are at least 60 px; the third baseline is y=160.
    expect(bounds.width).toBeGreaterThanOrEqual(60);
    expect(bounds.y + bounds.height).toBeCloseTo(164.2);
    expect(object).toEqual(before);
  });
  it.each(["left", "center", "right"] as const)("keeps %s alignment anchored to the stored frame", alignment => {
    const object = text(); object.style.textAlign = alignment;
    const bounds = textVisualBoundsForPageFit(object);
    const x = alignment === "left" ? 100 : alignment === "center" ? 110 - bounds.width / 2 : 120 - bounds.width;
    expect(bounds.x).toBeCloseTo(x);
  });
  it("rotates overflowing lines around the original frame center", () => {
    const object = text(); object.rotation = 180;
    const bounds = textVisualBoundsForPageFit(object);
    // Stored pivot is (110,110), rather than the center of the expanded text extent.
    expect(bounds.x + bounds.width).toBeCloseTo(120);
    expect(bounds.y).toBeCloseTo(55.8);
    expect(bounds.y + bounds.height).toBeCloseTo(120);
  });
  it("retains a frame that already encloses its text", () => {
    const object = text(); object.width = 300; object.height = 300;
    expect(textVisualBoundsForPageFit(object)).toEqual(textVisualBoundsForArrangement(object));
  });
  it("includes a larger styled span that the SVG renderer paints above its stored frame", () => {
    const object = text(); object.text = "M";
    object.spans = [{ text: "M", script: "normal", style: { fontSizePx: 60 } }];
    expect(textVisualBoundsForPageFit(object).y).toBe(60);
  });
});
