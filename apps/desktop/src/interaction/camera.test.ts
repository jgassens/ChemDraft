import { describe, it, expect } from "vitest";

import { clientToPage, pageToClient } from "./camera";

describe("camera transform", () => {
  it("round-trips client <-> page coordinates", () => {
    const transform = { pageRect: { left: 120, top: 80 }, scale: 2 };
    const client = { x: 340, y: 300 };

    const page = clientToPage(client, transform);
    expect(page).toEqual({ x: 110, y: 110 });
    expect(pageToClient(page, transform)).toEqual(client);
  });

  it("guards against a non-positive scale (treats it as 1)", () => {
    const transform = { pageRect: { left: 120, top: 80 }, scale: 0 };
    expect(clientToPage({ x: 340, y: 300 }, transform)).toEqual({ x: 220, y: 220 });
  });

  it("keeps the focal point fixed across a zoom (the pinch-zoom invariant)", () => {
    // zoomCanvasAtClientPoint records the page point under the cursor, changes scale, then
    // compensates the page rect (via native scroll) so that page point lands back under
    // the same client point. This proves that compensation math via the camera.
    const before = { pageRect: { left: 100, top: 60 }, scale: 1 };
    const focalClient = { x: 250, y: 200 };
    const focalPage = clientToPage(focalClient, before);

    const newScale = 2.5;
    const compensatedRect = {
      left: focalClient.x - focalPage.x * newScale,
      top: focalClient.y - focalPage.y * newScale
    };

    expect(pageToClient(focalPage, { pageRect: compensatedRect, scale: newScale })).toEqual(focalClient);
  });
});
