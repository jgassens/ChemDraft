import { describe, expect, it } from "vitest";
import { placePaletteTooltip } from "./PaletteTooltipWindow";

// The palette tooltip window positions itself in GLOBAL logical coordinates. The clamp
// must use the bounds of the monitor the anchor lives on — the old implementation
// clamped against window.screen (the display the hidden tooltip window was on), which
// dragged tooltips for a second-screen palette to the primary display's edge.
describe("placePaletteTooltip", () => {
  const size = { width: 120, height: 26 };

  it("centers under an anchor on a second monitor to the right of the primary", () => {
    const bounds = { left: 1512, top: 0, right: 3072, bottom: 982 };
    const placed = placePaletteTooltip({
      anchorCenterX: 2200,
      belowY: 180,
      aboveY: 150,
      ...size,
      bounds
    });
    expect(placed).toEqual({ x: 2200 - 60, y: 180 });
  });

  it("keeps an anchor on a monitor left of the primary in negative coordinate space", () => {
    const bounds = { left: -1600, top: 0, right: 0, bottom: 900 };
    const placed = placePaletteTooltip({
      anchorCenterX: -800,
      belowY: 300,
      aboveY: 270,
      ...size,
      bounds
    });
    expect(placed).toEqual({ x: -860, y: 300 });
  });

  it("clamps to the anchor monitor's right edge, not the primary's", () => {
    const bounds = { left: 1512, top: 0, right: 3072, bottom: 982 };
    const placed = placePaletteTooltip({
      anchorCenterX: 3060,
      belowY: 180,
      aboveY: 150,
      ...size,
      bounds
    });
    expect(placed.x).toBe(3072 - 120 - 4);
  });

  it("flips above the anchor when there is no room below on the anchor's monitor", () => {
    const bounds = { left: 1512, top: 0, right: 3072, bottom: 982 };
    const placed = placePaletteTooltip({
      anchorCenterX: 2000,
      belowY: 970,
      aboveY: 940,
      ...size,
      bounds
    });
    expect(placed.y).toBe(940 - 26);
  });

  it("never rises above the anchor monitor's top edge", () => {
    const bounds = { left: 0, top: 0, right: 1512, bottom: 982 };
    const placed = placePaletteTooltip({
      anchorCenterX: 400,
      belowY: 990,
      aboveY: 10,
      ...size,
      bounds
    });
    expect(placed.y).toBe(4);
  });

  it("places at the anchor unclamped when no monitor bounds are known", () => {
    const placed = placePaletteTooltip({
      anchorCenterX: 2200,
      belowY: 180,
      aboveY: 150,
      ...size
    });
    expect(placed).toEqual({ x: 2140, y: 180 });
  });
});
