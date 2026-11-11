import { DefaultNativeDrawingStyle, type NativeDrawingStyle } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";

import { atomLabelLayout } from "./index";
import { atomLabelGlyphBoxes } from "./testing";

const pairs = [["O", "OH", "HO"], ["N", "NH2", "H2N"], ["S", "SH", "HS"]] as const;

/** Use only the engine's advance boxes: no DOM measurement or installed fonts. */
function hydrogenElementGapEm(label: string, element: string, style: NativeDrawingStyle): number {
  const boxes = atomLabelGlyphBoxes(atomLabelLayout(label, style).runs, style);
  const symbol = boxes.find((box) => box.text === element)!;
  // The hydrogen group includes its subscript count (H2 in H2N/NH2).
  const hydrogens = boxes.filter((box) => box !== symbol);
  expect(hydrogens.map((box) => box.text).join("")).toBe(element === "N" ? "H2" : "H");
  const left = Math.min(...hydrogens.map((box) => box.left));
  const right = Math.max(...hydrogens.map((box) => box.right));
  return (label.startsWith("H") ? symbol.left - right : left - symbol.right) / style.atomLabelFontSizePx;
}

describe("hydrogen-first and element-first advance-box spacing", () => {
  it.each(pairs)("measures %s's %s/%s gap in em", (element, trailing, leading) => {
    const rightGap = hydrogenElementGapEm(trailing, element, DefaultNativeDrawingStyle);
    const leftGap = hydrogenElementGapEm(leading, element, DefaultNativeDrawingStyle);
    console.log(JSON.stringify({ element, right: { label: trailing, gapEm: rightGap }, left: { label: leading, gapEm: leftGap } }));
    expect(Math.abs(rightGap)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1e-9);
  });

  it.each(pairs)("keeps %s's %s/%s gap equal across sizes, weights, slants and alignment", (element, trailing, leading) => {
    for (const atomLabelFontSizePx of [10, 15, 31]) {
      for (const atomLabelFontWeight of [400, 700]) {
        for (const atomLabelFontStyle of ["normal", "italic"] as const) {
          for (const atomLabelAlignment of ["automatic", "left", "center", "right"] as const) {
            const style = { ...DefaultNativeDrawingStyle, atomLabelFontSizePx, atomLabelFontWeight, atomLabelFontStyle, atomLabelAlignment };
            const rightGap = hydrogenElementGapEm(trailing, element, style);
            const leftGap = hydrogenElementGapEm(leading, element, style);
            expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1e-9);
          }
        }
      }
    }
  });
});
