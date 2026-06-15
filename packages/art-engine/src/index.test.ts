import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { GraphicObject } from "@chemdraft/chem-core";
import {
  editGraphicPathGeometry,
  graphicPathEditPoints,
  planNativeArtVisual,
  projectGraphicObjectPoint,
  unprojectGraphicObjectPoint
} from "./index";

const require = createRequire(import.meta.url);

const baseGraphic = {
  type: "graphic",
  id: "graphic_test",
  x: 120,
  y: 80,
  rotation: 0,
  style: {
    strokeColor: "#111111",
    fillColor: "none",
    strokeWidth: 2
  },
  data: {}
} satisfies Omit<GraphicObject, "graphicKind" | "width" | "height">;

describe("art-engine native art planning", () => {
  it("keeps Stage 2 dependency licenses inside the approved set", () => {
    const artEnginePackage = require("../package.json") as { dependencies?: Record<string, string> };
    const pathCommanderPackage = require("svg-path-commander/package.json") as { license: string };
    const domMatrixPackage = require("@thednp/dommatrix/package.json") as { license: string };

    expect(pathCommanderPackage.license).toBe("MIT");
    expect(domMatrixPackage.license).toBe("MIT");
    expect(Object.keys(artEnginePackage.dependencies ?? {})).not.toEqual(expect.arrayContaining([
      "makerjs",
      "d3-path",
      "@flatten-js/core",
      "bezier-js",
      "svg-pathdata",
      "perfect-freehand",
      "roughjs"
    ]));
  });

  it("plans native ellipse geometry without owning document state", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "ellipse",
      width: 72,
      height: 34,
      style: {
        ...baseGraphic.style,
        fillColor: "#1d7f68",
        fillMode: "gloss"
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan).toMatchObject({
      objectId: graphic.id,
      kind: "ellipse",
      coordinateSpace: "local",
      width: 72,
      height: 34,
      frameBounds: { x: 0, y: 0, width: 72, height: 34 },
      stroke: { color: "#111111", width: 2 },
      fill: { color: "#1d7f68", mode: "gloss" }
    });
    expect(plan.glossGradient).toMatchObject({
      cx: 24.48,
      cy: 9.52,
      r: 50.4
    });
  });

  it("plans circular arc path geometry from native arc metadata", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 58,
      height: 58,
      data: {
        artPathKind: "arc",
        arcSweepRadians: Math.PI * 1.5
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.pathD).toBeDefined();
    expect(plan.pathD?.startsWith("M ")).toBe(true);
    expect(plan.pathD).toContain(" A ");
    expect(plan.pathD).toContain("25 25");
    expect(plan.frameBounds).toEqual({ x: 0, y: 0, width: 58, height: 58 });
  });

  it("keeps projected bounds, matrix, and gradient data in one render plan", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "rect",
      width: 72,
      height: 40,
      rotation: 30,
      style: {
        ...baseGraphic.style,
        fillColor: "#111111",
        fillMode: "gloss",
        tiltXDegrees: 24,
        tiltYDegrees: -18
      },
      data: {
        cornerRadiusPx: 7
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.projectionMatrix).toMatchObject({
      a: expect.any(Number),
      b: expect.any(Number),
      c: expect.any(Number),
      d: expect.any(Number)
    });
    expect(plan.projectionTransform).toContain("matrix(");
    expect(plan.projectedShapePathD).toContain("M ");
    expect(plan.frameBounds.width).toBeGreaterThan(60);
    expect(plan.frameBounds.height).toBeGreaterThan(55);
    expect(plan.glossGradient?.gradientTransform).toBe(plan.projectionTransform);
  });

  it("uses dependency-backed bounds for local custom pathD without changing the public plan shape", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 100,
      height: 80,
      rotation: 22,
      data: {
        pathD: "M 10 10 C 30 5, 45 55, 65 60"
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.pathD).toBe(graphic.data.pathD);
    expect(plan.projectionMatrix).toBeDefined();
    expect(plan.frameBounds.width).toBeLessThan(85);
    expect(plan.frameBounds.height).toBeLessThan(80);
    expect(plan.frameBounds.x).toBeGreaterThan(0);
  });

  it("edits circular arc start and end handles as radian sweep metadata", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 58,
      height: 58,
      data: {
        artPathKind: "arc",
        arcSweepRadians: Math.PI * 1.5
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);

    if (!points) {
      throw new Error("Expected arc edit points.");
    }

    const completed = editGraphicPathGeometry(graphic, "end", points.start);

    expect(completed?.data.artPathKind).toBe("arc");
    expect(completed?.data.arcSweepRadians).toBeGreaterThan(Math.PI * 1.99);
    expect(completed?.x).toBe(graphic.x);
    expect(completed?.y).toBe(graphic.y);
  });

  it("expands and contracts circular arc radius from the middle handle around the same center", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 58,
      height: 58,
      data: {
        artPathKind: "arc",
        arcSweepRadians: Math.PI * 1.5
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);
    if (!points) {
      throw new Error("Expected arc edit points.");
    }
    const center = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };
    const dx = points.middle.x - center.x;
    const dy = points.middle.y - center.y;
    const length = Math.max(Math.hypot(dx, dy), 1);
    const outward = {
      x: center.x + dx / length * (length + 18),
      y: center.y + dy / length * (length + 18)
    };

    const expanded = editGraphicPathGeometry(graphic, "middle", outward);

    expect(expanded?.width).toBeGreaterThan(graphic.width);
    expect(expanded?.height).toBe(expanded?.width);
    expect((expanded?.x ?? 0) + (expanded?.width ?? 0) / 2).toBeCloseTo(center.x, 4);
    expect((expanded?.y ?? 0) + (expanded?.height ?? 0) / 2).toBeCloseTo(center.y, 4);
    expect(expanded?.data.arcSweepRadians).toBeCloseTo(Math.PI * 1.5, 6);
  });

  it("keeps transformed and tilted circular arcs editable through projected handle points", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 58,
      height: 58,
      rotation: 34,
      style: {
        ...baseGraphic.style,
        tiltXDegrees: 21,
        tiltYDegrees: -13
      },
      data: {
        artPathKind: "arc",
        arcSweepRadians: Math.PI
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);
    if (!points) {
      throw new Error("Expected arc edit points.");
    }
    const center = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };
    const outward = {
      x: center.x + (points.middle.x - center.x) * 1.35,
      y: center.y + (points.middle.y - center.y) * 1.35
    };
    const projectedDrag = projectGraphicObjectPoint(graphic, outward);
    const unprojectedDrag = unprojectGraphicObjectPoint(graphic, projectedDrag);

    expect(unprojectedDrag.x).toBeCloseTo(outward.x, 4);
    expect(unprojectedDrag.y).toBeCloseTo(outward.y, 4);
    const edited = editGraphicPathGeometry(graphic, "middle", unprojectedDrag);

    expect(edited?.data.arcSweepRadians).toBeCloseTo(Math.PI, 6);
    expect(edited?.width).toBeGreaterThan(graphic.width);
    expect(graphicPathEditPoints(edited as GraphicObject)?.middle.x).toBeCloseTo(unprojectedDrag.x, 3);
  });
});
