import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { GraphicObject } from "@chemdraft/chem-core";
import {
  editGraphicCornerRadius,
  editGraphicPathGeometry,
  graphicCornerRadiusEditPoint,
  graphicPathEditPoints,
  maxGraphicCornerRadius,
  planNativeArtVisual,
  prepareGraphicPathForDirectEdit,
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

  it("resolves explicit solid paints while preserving legacy fill and stroke fields", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "rect",
      width: 80,
      height: 48,
      style: {
        ...baseGraphic.style,
        opacity: 0.7,
        fillColor: "#111111",
        strokeColor: "#222222",
        fillPaint: { kind: "solid", color: "#1d7", opacity: 0.45 },
        strokePaint: { kind: "solid", color: "#abc", opacity: 0.8 },
        fillOpacity: 0.5,
        strokeOpacity: 0.25,
        strokeLineCap: "square",
        strokeLineJoin: "bevel",
        strokeMiterLimit: 6
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.opacity).toBe(0.7);
    expect(plan.fill.color).toBe("#111111");
    expect(plan.fill.opacity).toBe(0.5);
    expect(plan.fill.paint).toEqual({ kind: "solid", color: "#11dd77", opacity: 0.225 });
    expect(plan.stroke.color).toBe("#222222");
    expect(plan.stroke.opacity).toBe(0.25);
    expect(plan.stroke.paint).toEqual({ kind: "solid", color: "#aabbcc", opacity: 0.2 });
    expect(plan.stroke.lineCap).toBe("square");
    expect(plan.stroke.lineJoin).toBe("bevel");
    expect(plan.stroke.miterLimit).toBe(6);
  });

  it("resolves object-local gradient paint into render-space coordinates and projection data", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "ellipse",
      width: 100,
      height: 50,
      style: {
        ...baseGraphic.style,
        fillPaint: {
          kind: "linear-gradient",
          units: "object",
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 0.5,
          stops: [
            { offset: 1, color: "#00f", opacity: 0.4 },
            { offset: 0, color: "#fff" }
          ]
        },
        fillOpacity: 0.5,
        tiltXDegrees: 20
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "page" });

    expect(plan.fill.paint).toMatchObject({
      kind: "linear-gradient",
      idHint: `graphic-fill-${graphic.id}`,
      x1: graphic.x,
      y1: graphic.y,
      x2: graphic.x + graphic.width,
      y2: graphic.y + graphic.height / 2,
      gradientTransform: plan.projectionTransform
    });
    expect(plan.fill.paint.kind === "linear-gradient" ? plan.fill.paint.stops : []).toEqual([
      { offset: 0, color: "#ffffff", opacity: 0.5 },
      { offset: 1, color: "#0000ff", opacity: 0.2 }
    ]);
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

  it("marks open stroke graphics as non-fillable and resolves stale fill as none", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      style: {
        ...baseGraphic.style,
        fillColor: "#ff0000",
        fillPaint: { kind: "solid", color: "#ff0000", opacity: 0.5 },
        fillOpacity: 0.4
      },
      data: {
        artPathKind: "line"
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.capabilities).toMatchObject({
      supportsFill: false,
      supportsStroke: true,
      supportsDash: true,
      supportsLineCap: true,
      supportsLineJoin: false,
      isOpenStroke: true,
      isClosedShape: false,
      hasCorners: false
    });
    expect(plan.fill).toMatchObject({
      color: "none",
      opacity: 1,
      paint: { kind: "none", opacity: 1 }
    });
  });

  it("plans native graphic markers for open stroke paths", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line",
        markerStart: { kind: "open-arrow", sizePx: 8 },
        markerEnd: { kind: "filled-arrow", sizePx: 12, angleDegrees: 15 }
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.markerStart).toEqual({
      kind: "open-arrow",
      sizePx: 8,
      angleDegrees: 0
    });
    expect(plan.markerEnd).toEqual({
      kind: "filled-arrow",
      sizePx: 12,
      angleDegrees: 15
    });
    expect(plan.capabilities.supportsFill).toBe(false);
  });

  it("derives fill and corner capabilities for custom path topology", () => {
    const rectangle = {
      ...baseGraphic,
      graphicKind: "rect",
      width: 80,
      height: 48,
      data: {}
    } satisfies GraphicObject;
    const closedCornered = {
      ...baseGraphic,
      graphicKind: "path",
      width: 80,
      height: 48,
      data: {
        pathD: "M 4 4 L 76 4 L 76 44 L 4 44 Z"
      }
    } satisfies GraphicObject;
    const openCurved = {
      ...baseGraphic,
      graphicKind: "path",
      width: 80,
      height: 48,
      data: {
        pathD: "M 4 44 C 22 2, 58 2, 76 44"
      }
    } satisfies GraphicObject;

    expect(planNativeArtVisual(rectangle, { coordinateSpace: "local" }).capabilities).toMatchObject({
      supportsFill: true,
      supportsLineCap: false,
      supportsLineJoin: false,
      isClosedShape: true,
      hasCorners: false
    });
    expect(planNativeArtVisual(closedCornered, { coordinateSpace: "local" }).capabilities).toMatchObject({
      supportsFill: true,
      supportsLineCap: false,
      supportsLineJoin: true,
      isClosedShape: true,
      hasCorners: true
    });
    expect(planNativeArtVisual(openCurved, { coordinateSpace: "local" }).capabilities).toMatchObject({
      supportsFill: false,
      supportsLineCap: true,
      supportsLineJoin: false,
      isOpenStroke: true,
      hasCorners: false
    });
  });

  it("clamps rectangle corner radius and exposes a direct local edit point", () => {
    const square = {
      ...baseGraphic,
      graphicKind: "rect",
      width: 48,
      height: 48,
      data: {
        cornerRadiusPx: 200
      }
    } satisfies GraphicObject;
    const wide = {
      ...baseGraphic,
      graphicKind: "rect",
      width: 120,
      height: 32,
      data: {
        cornerRadiusPx: 18
      }
    } satisfies GraphicObject;
    const ellipse = {
      ...baseGraphic,
      graphicKind: "ellipse",
      width: 48,
      height: 48,
      data: {
        cornerRadiusPx: 20
      }
    } satisfies GraphicObject;

    expect(maxGraphicCornerRadius(square)).toBe(24);
    expect(maxGraphicCornerRadius(wide)).toBe(16);
    expect(maxGraphicCornerRadius(ellipse)).toBe(0);
    expect(planNativeArtVisual(square, { coordinateSpace: "local" }).cornerRadius).toBe(24);
    expect(graphicCornerRadiusEditPoint(square)).toEqual({ x: 24, y: 0 });
    expect(graphicCornerRadiusEditPoint(ellipse)).toBeUndefined();

    const reset = editGraphicCornerRadius(square, { x: -12, y: 0 });
    expect(reset?.graphicKind).toBe("rect");
    expect(reset?.data).toEqual({ cornerRadiusPx: 0 });

    expect(editGraphicCornerRadius(square, { x: 0.46, y: 0 })?.data).toEqual({ cornerRadiusPx: 0 });

    const pill = editGraphicCornerRadius(wide, { x: 200, y: 0 });
    expect(pill?.data).toEqual({ cornerRadiusPx: 16 });
    expect(editGraphicCornerRadius(wide, { x: 15.6, y: 0 })?.data).toEqual({ cornerRadiusPx: 16 });
    expect(pill).toMatchObject({
      x: wide.x,
      y: wide.y,
      width: wide.width,
      height: wide.height,
      graphicKind: "rect"
    });
  });

  it("keeps projected rectangle corner radius editing object-local after Z rotation and X/Y tilt", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "rect",
      width: 84,
      height: 42,
      rotation: 28,
      style: {
        ...baseGraphic.style,
        tiltXDegrees: 24,
        tiltYDegrees: -14
      },
      data: {
        cornerRadiusPx: 6
      }
    } satisfies GraphicObject;
    const maxRadius = maxGraphicCornerRadius(graphic);
    const projectedLocal = projectGraphicObjectPoint(
      graphic,
      { x: maxRadius, y: 0 },
      { coordinateSpace: "local" }
    );
    const projectedPage = {
      x: graphic.x + projectedLocal.x,
      y: graphic.y + projectedLocal.y
    };
    const unprojectedPage = unprojectGraphicObjectPoint(graphic, projectedPage);
    const edited = editGraphicCornerRadius(graphic, {
      x: unprojectedPage.x - graphic.x,
      y: unprojectedPage.y - graphic.y
    });

    expect(edited?.data.cornerRadiusPx).toBeCloseTo(maxRadius, 3);
    expect(planNativeArtVisual(edited ?? graphic, { coordinateSpace: "local" }).cornerRadius).toBeCloseTo(maxRadius, 3);
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
    const center = {
      x: graphic.x + graphic.width / 2,
      y: graphic.y + graphic.height / 2
    };

    expect(completed?.data.artPathKind).toBe("arc");
    expect(completed?.data.arcCenter).toEqual(center);
    expect(completed?.data.arcRadiusX).toBeCloseTo(25, 6);
    expect(completed?.data.arcRadiusY).toBeCloseTo(25, 6);
    expect(completed?.data.arcSweepRadians).toBeGreaterThan(Math.PI * 1.99);
    expect(completed?.x).toBeLessThanOrEqual(center.x - 25);
    expect(completed?.y).toBeLessThanOrEqual(center.y - 25);
  });

  it("bends a line middle handle into a freeform quadratic curve with the handle on the curve", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line"
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);
    if (!points) {
      throw new Error("Expected line edit points.");
    }
    const target = {
      x: (points.start.x + points.end.x) / 2,
      y: points.start.y - 42
    };

    const bent = editGraphicPathGeometry(graphic, "middle", target);
    const bentPoints = graphicPathEditPoints(bent as GraphicObject);
    const plan = planNativeArtVisual(bent as GraphicObject, { coordinateSpace: "page" });
    const pathMatch = plan.pathD?.match(/^M\s+([\d.-]+)\s+([\d.-]+)\s+Q\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/);
    if (!pathMatch) {
      throw new Error(`Expected a quadratic path, received ${plan.pathD}`);
    }
    const [, startX, startY, controlX, controlY, endX, endY] = pathMatch.map(Number);
    const visibleMiddle = {
      x: 0.25 * startX + 0.5 * controlX + 0.25 * endX,
      y: 0.25 * startY + 0.5 * controlY + 0.25 * endY
    };

    expect(bent?.data.artPathKind).toBe("quadratic");
    expect(bent?.data.pathControlPoint).toEqual(target);
    expect(bent?.data.lineStart).toEqual(points.start);
    expect(bent?.data.lineEnd).toEqual(points.end);
    expect(bent?.data.arcCenter).toBeUndefined();
    expect(bent?.data.arcRadiusX).toBeUndefined();
    expect(bent?.data.arcRadiusY).toBeUndefined();
    expect(bent?.data.arcSweepRadians).toBeUndefined();
    expect(bentPoints?.middle.x).toBeCloseTo(target.x, 3);
    expect(bentPoints?.middle.y).toBeCloseTo(target.y, 3);
    expect(plan.pathD).toContain(" Q ");
    expect(plan.pathD).not.toContain(" A ");
    expect(visibleMiddle.x).toBeCloseTo(target.x, 3);
    expect(visibleMiddle.y).toBeCloseTo(target.y, 3);
  });

  it("treats legacy arc paths with control points as quadratic curves and rewrites them on edit", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 132,
      height: 92,
      data: {
        artPathKind: "arc",
        lineStart: { x: 100, y: 170 },
        pathControlPoint: { x: 160, y: 90 },
        lineEnd: { x: 220, y: 170 }
      }
    } satisfies GraphicObject;
    const target = { x: 165, y: 82 };

    const points = graphicPathEditPoints(graphic);
    const plan = planNativeArtVisual(graphic, { coordinateSpace: "page" });
    const edited = editGraphicPathGeometry(graphic, "middle", target);

    expect(points?.pathKind).toBe("quadratic");
    expect(points?.middle).toEqual(graphic.data.pathControlPoint);
    expect(plan.pathD).toContain(" Q ");
    expect(plan.pathD).not.toContain(" A ");
    expect(edited?.data.artPathKind).toBe("quadratic");
    expect(edited?.data.pathControlPoint).toEqual(target);
    expect(edited?.data.arcCenter).toBeUndefined();
    expect(edited?.data.arcRadiusX).toBeUndefined();
    expect(edited?.data.arcRadiusY).toBeUndefined();
    expect(edited?.data.arcStartRadians).toBeUndefined();
    expect(edited?.data.arcSweepRadians).toBeUndefined();
  });

  it("updates quadratic start, middle, and end handles without changing semantic arc fields", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 132,
      height: 92,
      data: {
        artPathKind: "quadratic",
        lineStart: { x: 100, y: 170 },
        pathControlPoint: { x: 160, y: 90 },
        lineEnd: { x: 220, y: 170 },
        arcCenter: { x: 160, y: 130 },
        arcRadiusX: 40,
        arcRadiusY: 40,
        arcStartRadians: 0,
        arcSweepRadians: Math.PI
      }
    } satisfies GraphicObject;
    const nextStart = { x: 92, y: 166 };
    const nextMiddle = { x: 168, y: 74 };
    const nextEnd = { x: 236, y: 162 };

    const startEdited = editGraphicPathGeometry(graphic, "start", nextStart);
    const middleEdited = editGraphicPathGeometry(graphic, "middle", nextMiddle);
    const endEdited = editGraphicPathGeometry(graphic, "end", nextEnd);

    expect(startEdited?.data).toMatchObject({
      artPathKind: "quadratic",
      lineStart: nextStart,
      pathControlPoint: graphic.data.pathControlPoint,
      lineEnd: graphic.data.lineEnd
    });
    expect(middleEdited?.data).toMatchObject({
      artPathKind: "quadratic",
      lineStart: graphic.data.lineStart,
      pathControlPoint: nextMiddle,
      lineEnd: graphic.data.lineEnd
    });
    expect(endEdited?.data).toMatchObject({
      artPathKind: "quadratic",
      lineStart: graphic.data.lineStart,
      pathControlPoint: graphic.data.pathControlPoint,
      lineEnd: nextEnd
    });
    for (const edited of [startEdited, middleEdited, endEdited]) {
      expect(edited?.data.arcCenter).toBeUndefined();
      expect(edited?.data.arcRadiusX).toBeUndefined();
      expect(edited?.data.arcRadiusY).toBeUndefined();
      expect(edited?.data.arcStartRadians).toBeUndefined();
      expect(edited?.data.arcSweepRadians).toBeUndefined();
    }
  });

  it("preserves the side of the segment used to bend a line into a freeform curve", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line"
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);
    if (!points) {
      throw new Error("Expected line edit points.");
    }
    const upwardTarget = {
      x: (points.start.x + points.end.x) / 2,
      y: points.start.y - 42
    };
    const downwardTarget = {
      x: (points.start.x + points.end.x) / 2,
      y: points.end.y + 42
    };

    const upward = editGraphicPathGeometry(graphic, "middle", upwardTarget);
    const downward = editGraphicPathGeometry(graphic, "middle", downwardTarget);

    expect(graphicPathEditPoints(upward as GraphicObject)?.middle.y).toBeCloseTo(upwardTarget.y, 3);
    expect(graphicPathEditPoints(downward as GraphicObject)?.middle.y).toBeCloseTo(downwardTarget.y, 3);
    expect(upward?.data.arcSweepRadians).toBeUndefined();
    expect(downward?.data.arcSweepRadians).toBeUndefined();
    expect(planNativeArtVisual(upward as GraphicObject, { coordinateSpace: "page" }).pathD).toContain(" Q ");
    expect(planNativeArtVisual(downward as GraphicObject, { coordinateSpace: "page" }).pathD).toContain(" Q ");
  });

  it("recomputes quadratic bounds from sampled curve geometry", () => {
    const graphic = {
      ...baseGraphic,
      x: 0,
      y: 0,
      graphicKind: "path",
      width: 100,
      height: 20,
      data: {
        artPathKind: "line"
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);
    if (!points) {
      throw new Error("Expected line edit points.");
    }
    const target = {
      x: (points.start.x + points.end.x) / 2,
      y: -40
    };

    const bent = editGraphicPathGeometry(graphic, "middle", target);

    expect(bent?.data.artPathKind).toBe("quadratic");
    expect(bent?.x).toBeCloseTo(points.start.x - 6, 3);
    expect(bent?.y).toBeLessThanOrEqual(target.y - 6);
    expect(bent?.height).toBeGreaterThan(graphic.height);
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
    const expandedPoints = graphicPathEditPoints(expanded as GraphicObject);

    expect(expanded?.width).toBeGreaterThan(graphic.width);
    expect(expanded?.height).toBeGreaterThan(graphic.height);
    expect(expanded?.data.arcCenter).toEqual(center);
    expect(expanded?.data.arcRadiusX).toBeCloseTo(length + 18, 4);
    expect(expanded?.data.arcRadiusY).toBeCloseTo(length + 18, 4);
    expect(expandedPoints?.middle.x).toBeCloseTo(outward.x, 3);
    expect(expandedPoints?.middle.y).toBeCloseTo(outward.y, 3);
    expect(expanded?.data.arcSweepRadians).toBeCloseTo(Math.PI * 1.5, 6);
  });

  it("keeps semantic arc start and end drags from changing radius", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      data: {
        artPathKind: "arc",
        arcCenter: { x: 180, y: 140 },
        arcRadiusX: 48,
        arcRadiusY: 32,
        arcStartRadians: 0,
        arcSweepRadians: Math.PI
      }
    } satisfies GraphicObject;
    const startTarget = { x: 180, y: 108 };
    const endTarget = { x: 180, y: 172 };

    const startEdited = editGraphicPathGeometry(graphic, "start", startTarget);
    const endEdited = editGraphicPathGeometry(graphic, "end", endTarget);

    expect(startEdited?.data.arcRadiusX).toBe(48);
    expect(startEdited?.data.arcRadiusY).toBe(32);
    expect(endEdited?.data.arcRadiusX).toBe(48);
    expect(endEdited?.data.arcRadiusY).toBe(32);
    expect(startEdited?.data.pathControlPoint).toBeUndefined();
    expect(endEdited?.data.pathControlPoint).toBeUndefined();
  });

  it("derives semantic arc handles from arc metadata instead of object bounds", () => {
    const graphic = {
      ...baseGraphic,
      x: 10,
      y: 10,
      graphicKind: "path",
      width: 22,
      height: 18,
      data: {
        artPathKind: "arc",
        arcCenter: { x: 300, y: 240 },
        arcRadiusX: 40,
        arcRadiusY: 20,
        arcStartRadians: 0,
        arcSweepRadians: Math.PI / 2
      }
    } satisfies GraphicObject;

    const points = graphicPathEditPoints(graphic);

    expect(points?.start.x).toBeCloseTo(340, 6);
    expect(points?.start.y).toBeCloseTo(240, 6);
    expect(points?.middle.x).toBeCloseTo(300 + Math.cos(Math.PI / 4) * 40, 6);
    expect(points?.middle.y).toBeCloseTo(240 + Math.sin(Math.PI / 4) * 20, 6);
    expect(points?.end.x).toBeCloseTo(300, 6);
    expect(points?.end.y).toBeCloseTo(260, 6);
  });

  it("keeps the circular arc middle handle attached when a rectangular arc becomes circular", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 96,
      height: 54,
      data: {
        artPathKind: "arc",
        arcStartRadians: Math.PI * 0.18,
        arcSweepRadians: Math.PI * 1.36
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);
    if (!points) {
      throw new Error("Expected arc edit points.");
    }
    const target = {
      x: points.middle.x + 31,
      y: points.middle.y - 17
    };

    const edited = editGraphicPathGeometry(graphic, "middle", target);
    const editedPoints = graphicPathEditPoints(edited as GraphicObject);

    expect(edited?.data.arcSweepRadians).toBeCloseTo(graphic.data.arcSweepRadians, 6);
    expect(edited?.data.arcRadiusX).toBeCloseTo(edited?.data.arcRadiusY as number, 6);
    expect(editedPoints?.middle.x).toBeCloseTo(target.x, 3);
    expect(editedPoints?.middle.y).toBeCloseTo(target.y, 3);
    expect(planNativeArtVisual(edited as GraphicObject, { coordinateSpace: "page" }).pathD).toContain(" A ");
  });

  it("recomputes semantic arc bounds from sampled arc geometry", () => {
    const graphic = {
      ...baseGraphic,
      x: 100,
      y: 100,
      graphicKind: "path",
      width: 58,
      height: 58,
      data: {
        artPathKind: "arc",
        arcStartRadians: 0,
        arcSweepRadians: Math.PI / 2
      }
    } satisfies GraphicObject;
    const center = { x: 129, y: 129 };
    const target = { x: center.x + 42, y: center.y + 42 };

    const edited = editGraphicPathGeometry(graphic, "middle", target);

    expect(edited?.data.artPathKind).toBe("arc");
    expect(edited?.data.arcCenter).toEqual(center);
    expect(edited?.data.arcRadiusX).toBeCloseTo(Math.hypot(42, 42), 6);
    expect(edited?.data.arcRadiusY).toBeCloseTo(Math.hypot(42, 42), 6);
    expect(edited?.data.pathControlPoint).toBeUndefined();
    expect(edited?.x).toBeLessThanOrEqual(center.x - 6);
    expect(edited?.y).toBeLessThanOrEqual(center.y - 6);
    expect(edited?.width).toBeGreaterThan(graphic.width);
    expect(edited?.height).toBeGreaterThan(graphic.height);
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

  it("bakes transformed and tilted quadratic paths into page-space geometry before direct editing", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 112,
      height: 84,
      rotation: 28,
      style: {
        ...baseGraphic.style,
        tiltXDegrees: 128,
        tiltYDegrees: -94
      },
      data: {
        artPathKind: "quadratic",
        lineStart: { x: 130, y: 96 },
        pathControlPoint: { x: 170, y: 92 },
        lineEnd: { x: 218, y: 152 }
      }
    } satisfies GraphicObject;
    const points = graphicPathEditPoints(graphic);
    if (!points) {
      throw new Error("Expected quadratic edit points.");
    }
    const projectedStart = projectGraphicObjectPoint(graphic, points.start);
    const projectedMiddle = projectGraphicObjectPoint(graphic, points.middle);
    const projectedEnd = projectGraphicObjectPoint(graphic, points.end);

    const prepared = prepareGraphicPathForDirectEdit(graphic);
    const preparedPoints = graphicPathEditPoints(prepared);

    expect(prepared.rotation).toBe(0);
    expect(prepared.style.tiltXDegrees).toBeUndefined();
    expect(prepared.style.tiltYDegrees).toBeUndefined();
    expect(prepared.data.artPathKind).toBe("quadratic");
    expect(preparedPoints?.start.x).toBeCloseTo(projectedStart.x, 3);
    expect(preparedPoints?.start.y).toBeCloseTo(projectedStart.y, 3);
    expect(preparedPoints?.middle.x).toBeCloseTo(projectedMiddle.x, 3);
    expect(preparedPoints?.middle.y).toBeCloseTo(projectedMiddle.y, 3);
    expect(preparedPoints?.end.x).toBeCloseTo(projectedEnd.x, 3);
    expect(preparedPoints?.end.y).toBeCloseTo(projectedEnd.y, 3);
  });
});
