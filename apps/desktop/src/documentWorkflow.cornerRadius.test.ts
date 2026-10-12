import { planNativeArtVisual, projectGraphicObjectPoint } from "@chemdraft/art-engine";
import type { GraphicObject } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import {
  createPhase4Document,
  insertNativeArtGraphicObject,
  nativeGraphicCornerRadiusEditPoint,
  nativeGraphicCornerRadiusHandlePoint,
  GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX
} from "./documentWorkflow";

function rectangle(radius = 0, width = 100): GraphicObject {
  const document = insertNativeArtGraphicObject(createPhase4Document("Radius"), { x: 200, y: 200 }, "tool.art.rect");
  const object = document.pages[0].objects.find((item) => item.id === document.selection.objectIds[0]);
  if (object?.type !== "graphic") throw new Error("Expected rectangle");
  return { ...object, x: 400, width, height: 100, data: { ...object.data, cornerRadiusPx: radius } };
}

const page = { width: 2000, height: 2000 };

// Unrotated, untilted shapes only: smallest gap between the 9px handle box and
// the four 18px resize targets drawn 8px outside the frame corners.
function gap(object: GraphicObject, point: { x: number; y: number }, scale: number): number {
  const bounds = planNativeArtVisual(object, { coordinateSpace: "local" }).frameBounds;
  const cx = (object.x + point.x) * scale;
  const cy = (object.y + point.y) * scale;
  const left = (object.x + bounds.x) * scale;
  const top = (object.y + bounds.y) * scale;
  const right = left + bounds.width * scale;
  const bottom = top + bounds.height * scale;
  const boxes = [left, right].flatMap((x) => [top, bottom].map((y) => ({
    left: x === left ? x - 8 : x - 10,
    right: x === left ? x + 10 : x + 8,
    top: y === top ? y - 8 : y - 10,
    bottom: y === top ? y + 10 : y + 8
  })));
  return Math.min(...boxes.map((box) => Math.max(
    box.left - (cx + 4.5), (cx - 4.5) - box.right, box.top - (cy + 4.5), (cy - 4.5) - box.bottom
  )));
}

function expectUsableAndClear(object: GraphicObject, point: { x: number; y: number }, scale: number) {
  const cx = (object.x + point.x) * scale;
  const cy = (object.y + point.y) * scale;
  expect(cx).toBeGreaterThanOrEqual(0);
  expect(cx).toBeLessThanOrEqual(page.width * scale);
  expect(cy).toBeGreaterThanOrEqual(0);
  expect(cy).toBeLessThanOrEqual(page.height * scale);
  expect(gap(object, point, scale)).toBeGreaterThanOrEqual(2 - 1e-8);
}

describe("corner radius handle placement", () => {
  it.each([0.1, 0.5, 1, 2, 8])("keeps zero and small radii clear at scale %s", (scale) => {
    for (const radius of [0, 0.25, 1]) {
      const object = rectangle(radius, 1000);
      const point = nativeGraphicCornerRadiusHandlePoint(object, scale, page)!;
      expect(point.x * scale).toBeCloseTo(GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX);
      expect(point.y).toBe(0);
      expect(nativeGraphicCornerRadiusEditPoint(object)?.x).toBe(radius);
    }
  });

  it("follows the true radius once it clears the minimum", () => {
    expect(nativeGraphicCornerRadiusHandlePoint(rectangle(30), 1, page)).toEqual({ x: 30, y: 0 });
  });

  it.each([0.1, 1, 8])("continues outward for shapes too small at scale %s", (scale) => {
    const object = rectangle(0, 2);
    const point = nativeGraphicCornerRadiusHandlePoint(object, scale, page)!;
    expect(point.x * scale).toBeCloseTo(-GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX);
    // All resize corners are at or to the right of x=0, so even a collapsed
    // width/height leaves this target separate from every resize target.
    expect(point.x).toBeLessThan(0);
  });

  it("chooses the controlled-corner outside placement near the right page edge", () => {
    const object = { ...rectangle(0, 10), x: page.width - 15 };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
    expect(point.x).toBeLessThan(0);
    expect(object.x + point.x - 4.5).toBeGreaterThanOrEqual(0);
    expect(object.x + point.x + 4.5).toBeLessThanOrEqual(page.width);
  });

  it("chooses the opposite-corner outside placement near the left page edge", () => {
    const object = { ...rectangle(0, 10), x: 5 };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
    expect(point.x).toBeGreaterThan(object.width);
    expect(object.x + point.x - 4.5).toBeGreaterThanOrEqual(0);
    expect(object.x + point.x + 4.5).toBeLessThanOrEqual(page.width);
    expect(point.x - 4.5).toBeGreaterThanOrEqual(object.width + 8 + 2);
  });

  it("places the 10px-wide top-edge case outside, clear of both top resize targets", () => {
    const object = { ...rectangle(0, 10), y: 0 };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
    expect(point.x).not.toBe(5);
    expectUsableAndClear(object, point, 1);
  });

  it.each([
    ["top edge", { x: 200, y: 0 }],
    ["top-left page corner", { x: 0, y: 0 }],
    ["left page edge", { x: 0, y: 400 }],
    ["right page edge", { x: page.width - 100, y: 400 }],
    ["top-right page corner", { x: page.width - 100, y: 0 }]
  ])("keeps the radius placement for a shape at the %s", (_label, at) => {
    const object = { ...rectangle(20), ...at };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
    expect(point).toEqual({ x: 20, y: 0 });
    expectUsableAndClear(object, point, 1);
  });

  it.each([
    ["left", (offset: number) => ({ x: offset, y: 400 })],
    ["right", (offset: number) => ({ x: page.width - 10 - offset, y: 400 })],
    ["top", (offset: number) => ({ x: 400, y: offset })]
  ])("keeps small shapes near the %s page edge clear and visible", (_label, at) => {
    for (let offset = 0; offset <= 30; offset += 0.5) {
      const object = { ...rectangle(0, 10), ...at(offset) };
      const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
      expectUsableAndClear(object, point, 1);
    }
  });

  it.each([1, 2])("moves the handle continuously as a shape crosses the top page edge at scale %s", (scale) => {
    for (const radius of [0, 20]) {
      let previous: number | undefined;
      for (let y = 0; y <= 20; y += 0.5) {
        const object = { ...rectangle(radius), x: 200, y };
        const point = nativeGraphicCornerRadiusHandlePoint(object, scale, page)!;
        const screenX = (object.x + point.x) * scale;
        if (previous !== undefined) expect(Math.abs(screenX - previous)).toBeLessThanOrEqual(1.01);
        previous = screenX;
      }
    }
  });

  it("moves the handle continuously as a shape slides along the left page edge", () => {
    let previous: number | undefined;
    for (let x = 0; x <= 20; x += 0.5) {
      const object = { ...rectangle(20), x, y: 0 };
      const point = nativeGraphicCornerRadiusHandlePoint(object, 1, page)!;
      const screenX = object.x + point.x;
      if (previous !== undefined) expect(Math.abs(screenX - previous - 0.5)).toBeLessThanOrEqual(1.01);
      previous = screenX;
    }
  });

  it("falls back to the visible spot with the most clearance when nothing is clear", () => {
    // A page barely wider than the shape, which hangs off its left edge: every
    // outside spot is off the page, every inside spot overlaps a resize
    // target, and the midpoint itself is off the page.
    const tightPage = { width: 12, height: 12 };
    const object = { ...rectangle(0, 10), x: -8, y: 0, height: 10 };
    const point = nativeGraphicCornerRadiusHandlePoint(object, 1, tightPage)!;
    const centre = object.x + point.x;
    expect(centre).toBeGreaterThanOrEqual(0);
    expect(centre).toBeLessThanOrEqual(tightPage.width);
    expect(point.x).not.toBe(5);
    for (let x = 8; x <= 10; x += 0.25) {
      expect(gap(object, point, 1)).toBeGreaterThanOrEqual(gap(object, { x, y: 0 }, 1) - 1e-8);
    }
  });

  it.each([0, 37, 90, 143])("clears every actual resize box with both tilts and rotation %s", (rotation) => {
    const object = { ...rectangle(), rotation, style: { ...rectangle().style, tiltXDegrees: 60, tiltYDegrees: 60 } };
    const scale = 2;
    const point = nativeGraphicCornerRadiusHandlePoint(object, scale, page)!;
    const angle = rotation * Math.PI / 180;
    const rotate = (p: { x: number; y: number }) => ({
      x: (object.width / 2 + (p.x - object.width / 2) * Math.cos(angle) - (p.y - object.height / 2) * Math.sin(angle)) * scale,
      y: (object.height / 2 + (p.x - object.width / 2) * Math.sin(angle) + (p.y - object.height / 2) * Math.cos(angle)) * scale
    });
    const projected = rotate(projectGraphicObjectPoint(object, point, { coordinateSpace: "local" }));
    const bounds = planNativeArtVisual(object, { coordinateSpace: "local" }).frameBounds;
    const corners = [
      { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x, y: bounds.y + bounds.height }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
    ].map(rotate);
    const left = Math.min(...corners.map(p => p.x));
    const right = Math.max(...corners.map(p => p.x));
    const top = Math.min(...corners.map(p => p.y));
    const bottom = Math.max(...corners.map(p => p.y));
    const half = 4.5 * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
    for (const x of [left + 1, right - 1]) {
      for (const y of [top + 1, bottom - 1]) {
        expect(Math.abs(projected.x - x) >= 9 + half + 2 - 1e-8 ||
          Math.abs(projected.y - y) >= 9 + half + 2 - 1e-8).toBe(true);
      }
    }
    if (rotation === 0) {
      const corner = projectGraphicObjectPoint(object, { x: 0, y: 0 }, { coordinateSpace: "local" });
      const unit = projectGraphicObjectPoint(object, { x: 1, y: 0 }, { coordinateSpace: "local" });
      const oldMinimum = GRAPHIC_CORNER_RADIUS_HANDLE_SEPARATION_PX / (scale * Math.hypot(unit.x - corner.x, unit.y - corner.y));
      const old = rotate(projectGraphicObjectPoint(object, { x: oldMinimum, y: 0 }, { coordinateSpace: "local" }));
      expect(Math.abs(old.x - (left + 1))).toBeLessThan(9 + half);
      expect(Math.abs(old.y - (top + 1))).toBeLessThan(9 + half);
      expect(point.x).toBeGreaterThan(oldMinimum);
    }
  });
});
