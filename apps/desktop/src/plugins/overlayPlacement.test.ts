import { describe, expect, it } from "vitest";
import { overlayPlacementAvoidingPalettes, paletteFrameInViewport } from "./overlayPlacement";

const viewport = { x: 0, y: 0, width: 500, height: 400 };
const overlay = { x: 400, y: 300, width: 100, height: 100 };
const corners = ["bottom-right", "bottom-left", "top-right", "top-left"] as const;
describe("overlay placement", () => {
  it("keeps a free position, including a user placement", () => {
    expect(overlayPlacementAvoidingPalettes(overlay, viewport, [], corners)).toEqual({ x: 400, y: 300, covered: false });
    expect(overlayPlacementAvoidingPalettes({ ...overlay, x: 200 }, viewport, [overlay], corners)).toEqual({ x: 200, y: 300, covered: false });
  });
  it("moves to the nearest free corner, or reports all covered", () => {
    expect(overlayPlacementAvoidingPalettes(overlay, viewport, [overlay], corners)).toEqual({ x: 400, y: 0, covered: false });
    expect(overlayPlacementAvoidingPalettes(overlay, viewport, [viewport], corners)).toEqual({ x: 400, y: 300, covered: true });
  });
  it.each([1, 1.25, 1.5])("converts screen frames at scale %s", scale => {
    expect(paletteFrameInViewport({ x: 100 + 200 * scale, y: 50 + 100 * scale, width: 100 * scale, height: 80 * scale },
      { x: 100, y: 50 }, scale, { x: 10, y: 20 })).toEqual({ x: 190, y: 80, width: 100, height: 80 });
  });
});
