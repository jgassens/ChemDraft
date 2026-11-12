import { expect, it } from "vitest";
import { type BracketObject, nativeTextStyleFromObjectStyle } from "@chemdraft/chem-core";
import { bracketGlyphPathD, bracketLabelPlan, bracketVisualBounds, nativeTextScriptFontScale } from "./index";

const closing: BracketObject = { id: "b2", type: "bracket", bracketKind: "round", side: "close", pairId: "b1",
  repeatUnit: true, x: 100, y: 120, width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [] };

it("mirrors every square and round path control for the closing glyph", () => {
  expect(bracketGlyphPathD("square", 16, 64, undefined, "close")).toBe("M 0 0 L 15 0 L 15 63 L 0 63");
  const points: number[] = [];
  bracketGlyphPathD("round", 16, 64, point => { points.push(point.x); return point; }, "close");
  expect(points).toEqual([0, 15 - 16 * 0.18, 15 - 16 * 0.18, 0]);
});
it("plans a default subscript below and right of only the closing repeat bracket", () => {
  const label = bracketLabelPlan(closing)!;
  expect(label.text).toBe("n");
  expect(label.x).toBeGreaterThan(closing.width);
  expect(label.y).toBeGreaterThan(closing.height);
  expect(label.fontSize).toBe(nativeTextStyleFromObjectStyle(closing.style).fontSizePx * nativeTextScriptFontScale);
  expect(bracketLabelPlan({ ...closing, side: "open" })).toBeUndefined();
  expect(bracketLabelPlan({ ...closing, repeatUnit: undefined, bracketKind: "polymer" })).toBeUndefined();
});
it("reserves the full custom label and scales its font from the annotation style", () => {
  const label = bracketLabelPlan({ ...closing, label: "many", style: { fontSizePx: 24 } })!;
  expect(label.text).toBe("many");
  expect(label.fontSize).toBe(24 * nativeTextScriptFontScale);
  expect(bracketVisualBounds({ ...closing, label: "many" }).width).toBeGreaterThan(closing.width);
});
