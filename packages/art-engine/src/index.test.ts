import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { GraphicObject } from "@chemdraft/chem-core";
import { getPathBBox, getPointAtLength, getTotalLength } from "svg-path-commander/util";
import {
  deleteGraphicPathSegment,
  deleteGraphicPathNode,
  editGraphicCornerRadius,
  editGraphicMarkerSize,
  MARKER_SIZE_STEP_PX,
  editGraphicPathGeometry,
  graphicEquilibriumGeometry,
  graphicEquilibriumHandlePoints,
  graphicDualShaftScaleHandlePoint,
  EQUILIBRIUM_SHAFT_HANDLE_INSET_PX,
  graphicCornerRadiusEditPoint,
  graphicObjectIntersectsPolygon,
  graphicPathEditPoints,
  graphicPathNodeEditPoints,
  graphicObjectSupportsBooleanOperation,
  maxGraphicCornerRadius,
  planNativeArtBooleanOperation,
  planNativeArtVisual,
  prepareGraphicPathForDirectEdit,
  projectGraphicObjectPoint,
  splitGraphicPathSegmentAtPoint,
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
    const flattenPackage = JSON.parse(readFileSync(
      require.resolve("@flatten-js/core").replace(/dist\/main\.cjs$/, "package.json"),
      "utf8"
    )) as { license: string };
    const perfectFreehandPackage = JSON.parse(readFileSync(
      require.resolve("perfect-freehand").replace(/dist\/cjs\/index\.js$/, "package.json"),
      "utf8"
    )) as { license: string };
    const roughPackage = require("roughjs/package.json") as { license: string };

    expect(pathCommanderPackage.license).toBe("MIT");
    expect(domMatrixPackage.license).toBe("MIT");
    expect(flattenPackage.license).toBe("MIT");
    expect(perfectFreehandPackage.license).toBe("MIT");
    expect(roughPackage.license).toBe("MIT");
    expect(Object.keys(artEnginePackage.dependencies ?? {})).toContain("@flatten-js/core");
    expect(Object.keys(artEnginePackage.dependencies ?? {})).toContain("roughjs");
    ["makerjs", "d3-path", "bezier-js", "svg-pathdata"].forEach((dependency) => {
      expect(Object.keys(artEnginePackage.dependencies ?? {})).not.toContain(dependency);
    });
  });

  it("plans native art effects from legacy and explicit metadata", () => {
    const graphic = {
      ...baseGraphic,
      id: "effect_rect",
      graphicKind: "rect",
      width: 90,
      height: 46,
      style: {
        ...baseGraphic.style,
        fillColor: "#f8faf9",
        effect: "shadow",
        effects: [
          { kind: "glow", color: "#1d7f68", opacity: 0.5, blurPx: 9 },
          { kind: "sketch", seed: 1729, roughness: 1.4, bowing: 0.7 }
        ]
      },
      data: {
        cornerRadiusPx: 6
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.effects.map((effect) => effect.kind)).toEqual(["shadow", "glow", "sketch"]);
    expect(plan.effects[0]).toMatchObject({
      kind: "shadow",
      offsetX: 6,
      offsetY: 6
    });
    expect(plan.effects[1]).toMatchObject({
      kind: "glow",
      color: "#1d7f68",
      opacity: 0.5,
      blurPx: 9
    });
    const sketch = plan.effects.find((effect) => effect.kind === "sketch");
    expect(sketch).toMatchObject({
      kind: "sketch",
      seed: 1729,
      roughness: 1.4,
      bowing: 0.7
    });
    expect(sketch?.paths.length).toBeGreaterThan(0);
    expect(sketch?.paths[0]?.d).toMatch(/^M/);
  });

  it("uses a stable generated sketch seed when none is stored", () => {
    const graphic = {
      ...baseGraphic,
      id: "stable_sketch_seed",
      graphicKind: "ellipse",
      width: 80,
      height: 42,
      style: {
        ...baseGraphic.style,
        effects: [{ kind: "sketch" }]
      }
    } satisfies GraphicObject;

    const first = planNativeArtVisual(graphic, { coordinateSpace: "page" });
    const second = planNativeArtVisual(graphic, { coordinateSpace: "page" });
    const firstSketch = first.effects.find((effect) => effect.kind === "sketch");
    const secondSketch = second.effects.find((effect) => effect.kind === "sketch");

    expect(firstSketch?.seed).toBe(secondSketch?.seed);
    expect(firstSketch?.paths.map((path) => path.d)).toEqual(secondSketch?.paths.map((path) => path.d));
  });

  it("keeps color effect defaults independent while sketch stroke follows object stroke", () => {
    const graphic = {
      ...baseGraphic,
      id: "independent_effect_style",
      graphicKind: "path",
      width: 120,
      height: 24,
      style: {
        ...baseGraphic.style,
        strokeColor: "#b3261e",
        fillColor: "#1648ff",
        strokeWidth: 12,
        effects: [{ kind: "glow" }, { kind: "sketch" }]
      },
      data: {
        pathD: "M 0 12 L 120 12"
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });
    const glow = plan.effects.find((effect) => effect.kind === "glow");
    const sketch = plan.effects.find((effect) => effect.kind === "sketch");

    expect(glow).toMatchObject({ color: "#fdd835" });
    expect(sketch).toMatchObject({ color: "#111111", strokeWidth: 12 });
  });

  it("plans a boolean union from two closed rectangles", () => {
    const first = {
      ...baseGraphic,
      id: "rect_a",
      graphicKind: "rect",
      x: 100,
      y: 100,
      width: 80,
      height: 54,
      style: {
        ...baseGraphic.style,
        fillColor: "#1d7f68"
      }
    } satisfies GraphicObject;
    const second = {
      ...first,
      id: "rect_b",
      x: 148,
      y: 120
    } satisfies GraphicObject;

    const plan = planNativeArtBooleanOperation([first, second], "union");

    expect(graphicObjectSupportsBooleanOperation(first)).toBe(true);
    expect(plan.eligibleInputIds).toEqual(["rect_a", "rect_b"]);
    expect(plan.skippedInputs).toEqual([]);
    expect(plan.resultPaths).toHaveLength(1);
    expect(plan.resultPaths[0]?.pathD).toMatch(/^M /);
    expect(plan.resultPaths[0]?.pathD).toContain("Z");
    expect(plan.resultPaths[0]?.bounds).toMatchObject({ x: 100, y: 100, width: 128, height: 74 });
  });

  it("plans rectangle subtraction with an ellipse hole", () => {
    const rect = {
      ...baseGraphic,
      id: "rect_source",
      graphicKind: "rect",
      x: 100,
      y: 90,
      width: 120,
      height: 90,
      style: {
        ...baseGraphic.style,
        fillColor: "#111111"
      }
    } satisfies GraphicObject;
    const ellipse = {
      ...baseGraphic,
      id: "circle_cutout",
      graphicKind: "ellipse",
      x: 138,
      y: 112,
      width: 44,
      height: 44,
      style: {
        ...baseGraphic.style,
        fillColor: "#ffffff"
      }
    } satisfies GraphicObject;

    const plan = planNativeArtBooleanOperation([rect, ellipse], "subtract");
    const result = plan.resultPaths[0];

    expect(plan.skippedInputs).toEqual([]);
    expect(result?.bounds).toMatchObject({ x: 100, y: 90, width: 120, height: 90 });
    expect(result?.faceCount).toBe(2);
    expect((result?.pathD.match(/M /g) ?? [])).toHaveLength(2);
    expect(result?.area).toBeLessThan(rect.width * rect.height);
  });

  it("plans ellipse intersections and skips open path inputs", () => {
    const first = {
      ...baseGraphic,
      id: "ellipse_a",
      graphicKind: "ellipse",
      x: 100,
      y: 90,
      width: 120,
      height: 84,
      style: {
        ...baseGraphic.style,
        fillColor: "#1d7f68"
      }
    } satisfies GraphicObject;
    const second = {
      ...first,
      id: "ellipse_b",
      x: 160
    } satisfies GraphicObject;
    const openLine = {
      ...baseGraphic,
      id: "open_line",
      graphicKind: "path",
      width: 96,
      height: 48,
      data: {
        artPathKind: "line"
      }
    } satisfies GraphicObject;

    const intersection = planNativeArtBooleanOperation([first, second], "intersect");
    const skipped = planNativeArtBooleanOperation([first, openLine], "union");

    expect(intersection.resultPaths).toHaveLength(1);
    expect(intersection.resultPaths[0]?.area).toBeGreaterThan(0);
    expect(intersection.resultPaths[0]?.area).toBeLessThan(Math.PI * (first.width / 2) * (first.height / 2));
    expect(graphicObjectSupportsBooleanOperation(openLine)).toBe(false);
    expect(skipped.resultPaths).toEqual([]);
    expect(skipped.eligibleInputIds).toEqual(["ellipse_a"]);
    expect(skipped.skippedInputs).toEqual([{ objectId: "open_line", reason: "open-shape" }]);
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
      r: 50.4,
      stops: [
        { offset: 0, color: "#e4f0ed", opacity: 1 },
        { offset: 0.28, color: "#a0c9c0", opacity: 1 },
        { offset: 0.72, color: "#1d7f68", opacity: 1 },
        { offset: 1, color: "#0d382e", opacity: 1 }
      ]
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
        lineStart: { x: 120, y: 80 },
        lineEnd: { x: 202, y: 80 },
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
    expect(plan.markerStartTerminal?.point).toEqual({ x: 0, y: 0 });
    expect(plan.markerStartTerminal?.direction).toEqual({ x: -1, y: 0 });
    expect(plan.markerEndTerminal?.point).toEqual({ x: 82, y: 0 });
    expect(plan.markerEndTerminal?.direction).toEqual({ x: 1, y: 0 });
    expect(plan.visiblePathD).toBeDefined();
    expect(plan.visiblePathD).not.toBe(plan.pathD);
    expect(plan.capabilities.supportsFill).toBe(false);
  });

  it("keeps filled arrowheads proportionate on thick dashed strokes", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      style: {
        ...baseGraphic.style,
        strokeWidth: 5,
        strokeDasharray: "32 8"
      },
      data: {
        artPathKind: "line",
        markerEnd: { kind: "filled-arrow", sizePx: 10 }
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.markerEnd).toMatchObject({
      kind: "filled-arrow",
      sizePx: 20
    });
    expect(plan.pathD).toContain("L 79 43");
    expect(plan.visiblePathD).toBeDefined();
    expect(plan.visiblePathD).not.toContain("L 79 43");
  });

  it("keeps resized curved arrow shafts inside filled heads without adding connector strokes", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      x: 100,
      y: 90,
      width: 730,
      height: 210,
      style: {
        ...baseGraphic.style,
        strokeColor: "#b3261e",
        strokeWidth: 8,
        strokeDasharray: "0 6",
        strokeLineCap: "round"
      },
      data: {
        artPathKind: "quadratic",
        lineStart: { x: 120, y: 100 },
        pathControlPoint: { x: 235, y: 134 },
        lineEnd: { x: 825, y: 258 },
        markerEnd: { kind: "filled-arrow", sizePx: 80 }
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });
    if (!plan.visiblePathD || !plan.markerEnd || !plan.markerEndTerminal) {
      throw new Error("Expected visible curved arrowhead path.");
    }

    const visibleEnd = getPointAtLength(plan.visiblePathD, getTotalLength(plan.visiblePathD));
    const terminal = plan.markerEndTerminal.point;
    const visibleInset = Math.hypot(visibleEnd.x - terminal.x, visibleEnd.y - terminal.y);

    expect(visibleInset).toBeLessThan(plan.markerEnd.sizePx * 0.55);
    expect(visibleInset).toBeGreaterThan(8);
  });

  it("edits arrowhead marker size from marker handle drag distance", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line",
        markerEnd: { kind: "filled-arrow", sizePx: 10 }
      }
    } satisfies GraphicObject;
    const plan = planNativeArtVisual(graphic, { coordinateSpace: "page" });
    const handle = plan.markerHandles.find((candidate) => candidate.id === "markerEnd");
    if (!handle) {
      throw new Error("Expected marker end handle.");
    }

    const edited = editGraphicMarkerSize(graphic, "markerEnd", {
      x: handle.terminal.point.x - handle.terminal.direction.x * 24,
      y: handle.terminal.point.y - handle.terminal.direction.y * 24
    });

    expect(edited?.data.markerEnd).toEqual({
      kind: "filled-arrow",
      sizePx: 24
    });
  });

  it("plans an equilibrium arrow as two opposed half-shafts with independent lengths", () => {
    const equilibrium = (extra: Record<string, unknown> = {}) => ({
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 40,
      data: {
        artPathKind: "line",
        dualShaft: true,
        dualShaftGapPx: 8,
        lineStart: { x: 0, y: 20 },
        lineEnd: { x: 100, y: 20 },
        markerStart: { kind: "half-arrow", sizePx: 14 },
        markerEnd: { kind: "half-arrow", sizePx: 14 },
        ...extra
      }
    }) as GraphicObject;

    const geometry = graphicEquilibriumGeometry(equilibrium());
    if (!geometry) {
      throw new Error("Expected equilibrium geometry.");
    }
    // The shafts straddle the axis pointing opposite ways, forward above and reverse below — the
    // conventional layout, which also puts each half-arrow's barb on the outside of the pair.
    expect(geometry.forward.start).toEqual({ x: 0, y: 16 });
    expect(geometry.forward.end).toEqual({ x: 100, y: 16 });
    expect(geometry.forward.direction).toEqual({ x: 1, y: 0 });
    expect(geometry.reverse.start).toEqual({ x: 100, y: 24 });
    expect(geometry.reverse.end).toEqual({ x: 0, y: 24 });
    expect(geometry.reverse.direction.x).toBe(-1);
    expect(geometry.reverse.direction.y).toBeCloseTo(0, 10);

    // At full length each head lands on the axis endpoint, so the length handles are seated back
    // along their shafts — otherwise they would stack on the endpoint handles and never win a press.
    const handles = graphicEquilibriumHandlePoints(equilibrium());
    expect(handles?.forward.x).toBeCloseTo(100 - EQUILIBRIUM_SHAFT_HANDLE_INSET_PX, 6);
    expect(handles?.reverse.x).toBeCloseTo(EQUILIBRIUM_SHAFT_HANDLE_INSET_PX, 6);

    // Each direction's length is independent — an equilibrium's two sides are rarely equal — but a
    // shorter shaft stays centred on the axis rather than sliding to one end.
    const lopsided = graphicEquilibriumGeometry(equilibrium({ dualShaftForwardFrac: 0.4 }));
    expect(lopsided?.forward.start.x).toBeCloseTo(30, 6);
    expect(lopsided?.forward.end.x).toBeCloseTo(70, 6);
    const forwardCentre = ((lopsided?.forward.start.x ?? 0) + (lopsided?.forward.end.x ?? 0)) / 2;
    const reverseCentre = ((lopsided?.reverse.start.x ?? 0) + (lopsided?.reverse.end.x ?? 0)) / 2;
    expect(forwardCentre).toBeCloseTo(50, 6);
    expect(reverseCentre).toBeCloseTo(50, 6);

    // Both shafts render in one two-subpath `d`, and the marker terminals sit at the two heads.
    const plan = planNativeArtVisual(equilibrium(), { coordinateSpace: "page" });
    expect((plan.pathD ?? "").match(/M/g)?.length).toBe(2);
    expect(plan.markerEndTerminal?.point).toEqual(geometry.forward.end);
    expect(plan.markerStartTerminal?.point).toEqual(geometry.reverse.end);
    expect(plan.markerHandles.map((handle) => handle.id).sort()).toEqual(["markerEnd", "markerStart"]);
  });

  it("plans a retrosynthetic arrow as two parallel shafts under one head", () => {
    const retro = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 40,
      data: {
        artPathKind: "line",
        dualShaft: true,
        dualShaftParallel: true,
        dualShaftGapPx: 5,
        lineStart: { x: 0, y: 20 },
        lineEnd: { x: 100, y: 20 }
      }
    } as GraphicObject;

    const geometry = graphicEquilibriumGeometry(retro);
    if (!geometry) {
      throw new Error("Expected retrosynthetic geometry.");
    }
    // Both shafts run the SAME way (unlike an equilibrium's opposed halves), straddling the axis...
    expect(geometry.forward.direction).toEqual(geometry.reverse.direction);
    expect(geometry.forward.start).toEqual({ x: 0, y: 17.5 });
    expect(geometry.reverse.start).toEqual({ x: 0, y: 22.5 });
    // ...under a single head centred on the axis end, spanning them.
    expect(geometry.head?.point).toEqual({ x: 100, y: 20 });

    // Four subpaths: two shafts plus the two head arms — the "=>" head is path geometry, not a
    // marker, because an axis-centred marker can never span both shafts.
    const plan = planNativeArtVisual(retro, { coordinateSpace: "page" });
    const subpaths = (plan.pathD ?? "").split("M").map((part) => part.trim()).filter(Boolean);
    expect(subpaths).toHaveLength(4);
    // Arms start at the tip and sweep back past both shafts (shafts at y=17.5/22.5; arms reach ±7).
    expect(subpaths[2]).toBe("100 20 L 90 13");
    expect(subpaths[3]).toBe("100 20 L 90 27");
    expect(plan.markerEnd).toBeUndefined();
    expect(plan.markerHandles).toHaveLength(0);

    // The two halves are one arrow, so there are no independent shaft-length handles to offer.
    expect(graphicEquilibriumHandlePoints(retro)).toBeUndefined();
    expect(editGraphicPathGeometry(retro, "shaft:forward", { x: 60, y: 20 })).toBeUndefined();
  });

  it("resizes an equilibrium arrow from its middle knob: gap, harpoons, and seats together", () => {
    const equilibrium = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 40,
      data: {
        artPathKind: "line",
        dualShaft: true,
        dualShaftGapPx: 8,
        lineStart: { x: 0, y: 20 },
        lineEnd: { x: 100, y: 20 },
        markerStart: { kind: "half-arrow", sizePx: 14 },
        markerEnd: { kind: "half-arrow", sizePx: 14 }
      }
    } as GraphicObject;

    // The knob sits off the axis and its distance reads as the scale — same idiom as retrosynthetic.
    expect(graphicDualShaftScaleHandlePoint(equilibrium)).toEqual({ x: 50, y: 8 });
    const bigger = editGraphicPathGeometry(equilibrium, "middle", { x: 50, y: -4 });
    if (!bigger) {
      throw new Error("Expected a resized equilibrium arrow.");
    }
    expect(bigger.data.dualShaftScale).toBeCloseTo(2, 3);

    // Gap doubles...
    const gap = (object: GraphicObject) => {
      const geometry = graphicEquilibriumGeometry(object)!;
      return Math.abs(geometry.forward.start.y - geometry.reverse.start.y);
    };
    expect(gap(bigger)).toBeCloseTo(gap(equilibrium) * 2, 3);

    // ...both harpoon heads double with it...
    const planBefore = planNativeArtVisual(equilibrium, { coordinateSpace: "page" });
    const planAfter = planNativeArtVisual(bigger, { coordinateSpace: "page" });
    expect(planAfter.markerStart?.sizePx).toBeCloseTo((planBefore.markerStart?.sizePx ?? 0) * 2, 3);
    expect(planAfter.markerEnd?.sizePx).toBeCloseTo((planBefore.markerEnd?.sizePx ?? 0) * 2, 3);

    // ...and the shaft-length seats slide back so they stay at the base of the grown heads.
    const seatBefore = graphicEquilibriumHandlePoints(equilibrium)!;
    const seatAfter = graphicEquilibriumHandlePoints(bigger)!;
    expect(100 - seatAfter.forward.x).toBeCloseTo((100 - seatBefore.forward.x) * 2, 3);

    // Per-shaft length dragging still works at the new scale, measuring through the scaled seat.
    const shortened = editGraphicPathGeometry(bigger, "shaft:forward", { x: 60, y: 44 });
    expect(shortened?.data.dualShaftForwardFrac).toBeCloseTo((2 * (60 - 50 + 32)) / 100, 3);

    // The middle knob never bends the axis.
    expect(bigger.data.pathControlPoint).toBeUndefined();
  });

  it("resizes a retrosynthetic arrow from its middle knob, keeping the proportions", () => {
    const retro = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 40,
      data: {
        artPathKind: "line",
        dualShaft: true,
        dualShaftParallel: true,
        dualShaftGapPx: 5,
        lineStart: { x: 0, y: 20 },
        lineEnd: { x: 100, y: 20 }
      }
    } as GraphicObject;

    // The knob sits off the axis at a distance that tracks the scale, so grabbing it never jumps.
    expect(graphicDualShaftScaleHandlePoint(retro)).toEqual({ x: 50, y: 8 });

    // Dragging it to twice that distance doubles the arrow: shaft gap and head grow together.
    const bigger = editGraphicPathGeometry(retro, "middle", { x: 50, y: -4 });
    if (!bigger) {
      throw new Error("Expected a resized retrosynthetic arrow.");
    }
    expect(bigger.data.dualShaftScale).toBeCloseTo(2, 3);
    expect(graphicDualShaftScaleHandlePoint(bigger)).toEqual({ x: 50, y: -4 });

    const before = graphicEquilibriumGeometry(retro)!;
    const after = graphicEquilibriumGeometry(bigger)!;
    const gap = (g: NonNullable<ReturnType<typeof graphicEquilibriumGeometry>>) =>
      Math.abs(g.forward.start.y - g.reverse.start.y);
    expect(gap(after)).toBeCloseTo(gap(before) * 2, 3);

    const subpathsOf = (object: GraphicObject) =>
      (planNativeArtVisual(object, { coordinateSpace: "page" }).pathD ?? "")
        .split("M").map((part) => part.trim()).filter(Boolean);
    const armReach = (object: GraphicObject) => {
      const [, armY] = subpathsOf(object)[2]!.split("L")[1]!.trim().split(" ").map(Number);
      return Math.abs(20 - armY!);
    };
    expect(armReach(bigger)).toBeCloseTo(armReach(retro) * 2, 3);

    // The shafts stop where the head arms cross them AT EVERY SCALE — with a fixed trim, growing the
    // head sent the shafts spearing straight through the V. Where an arm crosses a shaft's offset:
    // x = tip - back * (halfGap / reach); each shaft must end there, not past it.
    for (const object of [retro, bigger]) {
      const subpaths = subpathsOf(object);
      const geometry = graphicEquilibriumGeometry(object)!;
      const halfGap = Math.abs(geometry.forward.start.y - geometry.reverse.start.y) / 2;
      const armEnd = subpaths[2]!.split("L")[1]!.trim().split(" ").map(Number);
      const back = 100 - armEnd[0]!;
      const reach = Math.abs(20 - armEnd[1]!);
      const crossingX = 100 - back * (halfGap / reach);
      for (const shaftIndex of [0, 1]) {
        const shaftEndX = Number(subpaths[shaftIndex]!.split("L")[1]!.trim().split(" ")[0]);
        expect(shaftEndX).toBeCloseTo(crossingX, 3);
      }
    }

    // Resizing must never bend it — the axis of a retrosynthetic arrow stays straight.
    expect(bigger.data.pathControlPoint).toBeUndefined();
    expect(bigger.data.artPathKind).toBe("line");
  });

  it("stores a dual-shaft head size at the pointer, not the scale applied twice", () => {
    // A dual-shaft arrow DISPLAYS its heads scaled by dualShaftScale, so a drag measured against the
    // displayed handle must divide that scale back out before storing. It did not, so the stored
    // size was the displayed distance and the head rendered at scale² of the pointer (14 -> 40
    // stored, rendering at 80 for a 2x arrow).
    const equilibrium = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 40,
      data: {
        artPathKind: "line",
        dualShaft: true,
        dualShaftScale: 2,
        lineStart: { x: 0, y: 20 },
        lineEnd: { x: 100, y: 20 },
        markerStart: { kind: "half-arrow", sizePx: 14 },
        markerEnd: { kind: "half-arrow", sizePx: 14 }
      }
    } as GraphicObject;

    const plan = planNativeArtVisual(equilibrium, { coordinateSpace: "page" });
    const tip = plan.markerEndTerminal?.point;
    if (!tip) {
      throw new Error("Expected an end terminal.");
    }
    // Drag the head handle to 40px from the tip: the head should RENDER at ~40, so the stored raw
    // size must be ~20 (40 / scale 2).
    const dragged = editGraphicMarkerSize(equilibrium, "markerEnd", { x: tip.x - 40, y: tip.y }, { symmetric: true });
    if (!dragged) {
      throw new Error("Expected a resized marker.");
    }
    expect(dragged.data.markerEnd?.sizePx).toBeCloseTo(20, 3);
    const draggedPlan = planNativeArtVisual(dragged, { coordinateSpace: "page" });
    expect(draggedPlan.markerEnd?.sizePx).toBeCloseTo(40, 3);

    // An unscaled arrow is unaffected by the division.
    const plainScale = { ...equilibrium, data: { ...equilibrium.data, dualShaftScale: 1 } } as GraphicObject;
    const plainTip = planNativeArtVisual(plainScale, { coordinateSpace: "page" }).markerEndTerminal!.point;
    const plainDragged = editGraphicMarkerSize(plainScale, "markerEnd", { x: plainTip.x - 24, y: plainTip.y }, { symmetric: true });
    expect(plainDragged?.data.markerEnd?.sizePx).toBeCloseTo(24, 3);
  });

  it("keeps equilibrium shaft handles invertible: an unchanged handle never moves the shaft", () => {
    // The handle seat is capped so it can never land on the arrow's centre; at a half-shaft cap it
    // did, so every short shaft shared one handle position and feeding that position back changed
    // the length (0.2 -> 0.32) — the shaft jumped the instant it was grabbed.
    const equilibriumAt = (frac: number, scale?: number) => ({
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 40,
      data: {
        artPathKind: "line",
        dualShaft: true,
        lineStart: { x: 0, y: 20 },
        lineEnd: { x: 100, y: 20 },
        markerStart: { kind: "half-arrow", sizePx: 14 },
        markerEnd: { kind: "half-arrow", sizePx: 14 },
        dualShaftForwardFrac: frac,
        dualShaftReverseFrac: frac,
        ...(scale === undefined ? {} : { dualShaftScale: scale })
      }
    } as GraphicObject);

    for (const scale of [undefined, 0.5, 1.5, 2.5]) {
      for (const frac of [0.08, 0.2, 0.35, 0.5, 0.75, 1]) {
        const object = equilibriumAt(frac, scale);
        const handles = graphicEquilibriumHandlePoints(object);
        if (!handles) {
          throw new Error("Expected equilibrium handles.");
        }
        for (const handle of ["shaft:forward", "shaft:reverse"] as const) {
          const seat = handle === "shaft:forward" ? handles.forward : handles.reverse;
          // Re-feeding the handle's own position is a no-op: editGraphicPathGeometry returns the
          // same object when nothing changed.
          const edited = editGraphicPathGeometry(object, handle, seat);
          const key = handle === "shaft:forward" ? "dualShaftForwardFrac" : "dualShaftReverseFrac";
          const nextFrac = (edited ?? object).data[key];
          expect(
            Math.abs(Number(nextFrac) - frac),
            `${handle} frac ${frac} at scale ${String(scale)}`
          ).toBeLessThan(0.01);
        }
      }
    }
  });

  it("drags an equilibrium half-shaft to set only that direction's length", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 40,
      data: {
        artPathKind: "line",
        dualShaft: true,
        lineStart: { x: 0, y: 20 },
        lineEnd: { x: 100, y: 20 },
        markerStart: { kind: "half-arrow", sizePx: 14 },
        markerEnd: { kind: "half-arrow", sizePx: 14 }
      }
    } as GraphicObject;

    // Shafts are centred, so a drag measures the head's distance from the midpoint (x=50) — half the
    // shaft — and the handle's seat inset is added back so the tip tracks the cursor.
    const fracFor = (headX: number) => (2 * (headX - 50 + EQUILIBRIUM_SHAFT_HANDLE_INSET_PX)) / 100;
    const shortened = editGraphicPathGeometry(graphic, "shaft:forward", { x: 60, y: 44 });
    expect(shortened?.data.dualShaftForwardFrac).toBeCloseTo(fracFor(60), 3);
    expect(shortened?.data.dualShaftReverseFrac).toBeUndefined();

    // The reverse shaft measures the other way from the same midpoint.
    const reverse = editGraphicPathGeometry(graphic, "shaft:reverse", { x: 25, y: 4 });
    expect(reverse?.data.dualShaftReverseFrac).toBeCloseTo(fracFor(75), 3);
    expect(reverse?.data.dualShaftForwardFrac).toBeUndefined();

    // An equilibrium's axis is straight: the middle handle resizes the arrow, never bends it.
    const resized = editGraphicPathGeometry(graphic, "middle", { x: 50, y: 0 });
    expect(resized?.data.pathControlPoint).toBeUndefined();
    expect(resized?.data.artPathKind).toBe("line");
    expect(resized?.data.dualShaftScale).toBeGreaterThan(1);
  });

  it("snaps arrowhead marker size to discrete 4px steps", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line",
        markerEnd: { kind: "filled-arrow", sizePx: 16 }
      }
    } satisfies GraphicObject;
    const plan = planNativeArtVisual(graphic, { coordinateSpace: "page" });
    const handle = plan.markerHandles.find((candidate) => candidate.id === "markerEnd");
    if (!handle) {
      throw new Error("Expected marker end handle.");
    }

    // Every snapped size is a multiple of the 4px step, regardless of the exact drag distance.
    const sizesByDistance = [18, 22, 30, 44, 60].map((distance) => {
      const edited = editGraphicMarkerSize(graphic, "markerEnd", {
        x: handle.terminal.point.x - handle.terminal.direction.x * distance,
        y: handle.terminal.point.y - handle.terminal.direction.y * distance
      });
      const sizePx = edited?.data.markerEnd?.sizePx;
      if (typeof sizePx !== "number") {
        throw new Error("Expected a resized arrowhead.");
      }
      return sizePx;
    });
    for (const sizePx of sizesByDistance) {
      expect(sizePx % MARKER_SIZE_STEP_PX).toBe(0);
    }
    // Larger drags never produce a smaller snapped size (monotonic, stepped).
    for (let index = 1; index < sizesByDistance.length; index += 1) {
      expect(sizesByDistance[index]).toBeGreaterThanOrEqual(sizesByDistance[index - 1]);
    }
  });

  it("resizes both arrowheads symmetrically by default and only one when asked", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line",
        markerStart: { kind: "filled-arrow", sizePx: 16 },
        markerEnd: { kind: "filled-arrow", sizePx: 16 }
      }
    } satisfies GraphicObject;
    const plan = planNativeArtVisual(graphic, { coordinateSpace: "page" });
    const handle = plan.markerHandles.find((candidate) => candidate.id === "markerEnd");
    if (!handle) {
      throw new Error("Expected marker end handle.");
    }
    const dragPoint = {
      x: handle.terminal.point.x - handle.terminal.direction.x * 40,
      y: handle.terminal.point.y - handle.terminal.direction.y * 40
    };

    // Default (symmetric): dragging the end head also grows the start head to the same size.
    const symmetric = editGraphicMarkerSize(graphic, "markerEnd", dragPoint, { symmetric: true });
    expect(symmetric?.data.markerEnd?.sizePx).toBe(40);
    expect(symmetric?.data.markerStart?.sizePx).toBe(40);

    // Shift held (symmetric: false): only the dragged head changes.
    const single = editGraphicMarkerSize(graphic, "markerEnd", dragPoint, { symmetric: false });
    expect(single?.data.markerEnd?.sizePx).toBe(40);
    expect(single?.data.markerStart?.sizePx).toBe(16);
  });

  it("plans half-arrow markers on lines and arcs with size handles", () => {
    const fishhookLine = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line",
        markerEnd: { kind: "half-arrow", sizePx: 16 }
      }
    } satisfies GraphicObject;
    const linePlan = planNativeArtVisual(fishhookLine, { coordinateSpace: "page" });
    expect(linePlan.markerEnd).toMatchObject({ kind: "half-arrow", sizePx: 16 });
    expect(linePlan.markerEndTerminal).toBeDefined();
    expect(linePlan.markerHandles.some((handle) => handle.id === "markerEnd")).toBe(true);

    const fishhookArc = {
      ...baseGraphic,
      graphicKind: "path",
      width: 58,
      height: 58,
      data: {
        artPathKind: "arc",
        arcSweepRadians: Math.PI,
        markerEnd: { kind: "half-arrow", sizePx: 16 }
      }
    } satisfies GraphicObject;
    const arcPlan = planNativeArtVisual(fishhookArc, { coordinateSpace: "page" });
    expect(arcPlan.markerEnd).toMatchObject({ kind: "half-arrow", sizePx: 16 });
    expect(arcPlan.markerEndTerminal).toBeDefined();
    expect(arcPlan.markerHandles.some((handle) => handle.id === "markerEnd")).toBe(true);
  });

  it("plans the no-reaction cross at the shaft midpoint", () => {
    const noReaction = {
      ...baseGraphic,
      graphicKind: "path",
      width: 82,
      height: 46,
      data: {
        artPathKind: "line",
        lineStart: { x: 10, y: 20 },
        lineEnd: { x: 74, y: 20 },
        markerEnd: { kind: "filled-arrow", sizePx: 16 },
        shaftMark: "cross"
      }
    } satisfies GraphicObject;
    const plan = planNativeArtVisual(noReaction, { coordinateSpace: "page" });
    expect(plan.shaftMark?.kind).toBe("cross");
    // Midpoint of the horizontal shaft, tangent along +x.
    expect(plan.shaftMark?.point.x).toBeCloseTo(42, 0);
    expect(plan.shaftMark?.point.y).toBeCloseTo(20, 0);
    expect(Math.abs(plan.shaftMark?.direction.x ?? 0)).toBeCloseTo(1, 1);
    // No mark without the data flag.
    const plain = planNativeArtVisual({
      ...noReaction,
      data: { ...noReaction.data, shaftMark: undefined }
    }, { coordinateSpace: "page" });
    expect(plain.shaftMark).toBeUndefined();
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

  it("plans native polyline path nodes as open stroke geometry", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      data: {
        artPathKind: "polyline",
        pathNodes: [
          { point: { x: 132, y: 108 } },
          { point: { x: 176, y: 132 } },
          { point: { x: 208, y: 104 } }
        ]
      }
    } satisfies GraphicObject;

    const localPlan = planNativeArtVisual(graphic, { coordinateSpace: "local" });
    const pagePlan = planNativeArtVisual(graphic, { coordinateSpace: "page" });

    expect(localPlan.pathD).toBe("M 12 28 L 56 52 L 88 24");
    expect(pagePlan.pathD).toBe("M 132 108 L 176 132 L 208 104");
    expect(localPlan.frameBounds).toEqual({ x: 6, y: 18, width: 88, height: 40 });
    expect(localPlan.capabilities).toMatchObject({
      supportsFill: false,
      supportsLineCap: true,
      supportsLineJoin: true,
      isOpenStroke: true,
      hasCorners: true
    });
  });

  it("allows closed native polyline paths to use fill", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      style: {
        ...baseGraphic.style,
        fillColor: "#1d7f68"
      },
      data: {
        artPathKind: "polyline",
        pathClosed: true,
        pathNodes: [
          { point: { x: 132, y: 108 } },
          { point: { x: 196, y: 132 } },
          { point: { x: 160, y: 148 } }
        ]
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.pathD).toBe("M 12 28 L 76 52 L 40 68 Z");
    expect(plan.fill.color).toBe("#1d7f68");
    expect(plan.capabilities).toMatchObject({
      supportsFill: true,
      supportsLineCap: false,
      supportsLineJoin: true,
      isClosedShape: true
    });
  });

  it("moves native polyline nodes without dropping neighboring path nodes", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      data: {
        artPathKind: "polyline",
        pathNodes: [
          { point: { x: 132, y: 108 } },
          { point: { x: 176, y: 132 } },
          { point: { x: 208, y: 104 } }
        ]
      }
    } satisfies GraphicObject;

    expect(graphicPathNodeEditPoints(graphic)).toMatchObject({
      pathKind: "polyline",
      pathClosed: false,
      nodes: [
        { index: 0, point: { x: 132, y: 108 } },
        { index: 1, point: { x: 176, y: 132 } },
        { index: 2, point: { x: 208, y: 104 } }
      ]
    });

    const edited = editGraphicPathGeometry(graphic, "node:1", { x: 190, y: 120 });

    expect(edited?.data.pathNodes).toEqual([
      { point: { x: 132, y: 108 } },
      { point: { x: 190, y: 120 } },
      { point: { x: 208, y: 104 } }
    ]);
    expect(planNativeArtVisual(edited!, { coordinateSpace: "page" }).pathD).toBe("M 132 108 L 190 120 L 208 104");
  });

  it("deletes native polyline nodes and recomputes path bounds", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 140,
      height: 90,
      data: {
        artPathKind: "polyline",
        pathNodes: [
          { point: { x: 132, y: 108 } },
          { point: { x: 176, y: 152 } },
          { point: { x: 232, y: 104 } }
        ]
      }
    } satisfies GraphicObject;

    const edited = deleteGraphicPathNode(graphic, 1);

    expect(edited?.data.pathNodes).toEqual([
      { point: { x: 132, y: 108 } },
      { point: { x: 232, y: 104 } }
    ]);
    expect(edited?.x).toBeCloseTo(126, 3);
    expect(edited?.y).toBeCloseTo(98, 3);
    expect(edited?.width).toBeCloseTo(112, 3);
    expect(edited?.height).toBeCloseTo(16, 3);
    expect(planNativeArtVisual(edited!, { coordinateSpace: "page" }).pathD).toBe("M 132 108 L 232 104");
  });

  it("deletes closed native polyline segments by opening the path at the clicked edge", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 140,
      height: 100,
      data: {
        artPathKind: "polyline",
        pathClosed: true,
        pathNodes: [
          { point: { x: 132, y: 108 } },
          { point: { x: 232, y: 108 } },
          { point: { x: 232, y: 168 } },
          { point: { x: 132, y: 168 } }
        ]
      }
    } satisfies GraphicObject;

    const edited = deleteGraphicPathSegment(graphic, 1);

    expect(edited?.data.pathClosed).toBe(false);
    expect(edited?.data.pathNodes).toEqual([
      { point: { x: 232, y: 168 } },
      { point: { x: 132, y: 168 } },
      { point: { x: 132, y: 108 } },
      { point: { x: 232, y: 108 } }
    ]);
    expect(planNativeArtVisual(edited!, { coordinateSpace: "page" }).pathD).toBe(
      "M 232 168 L 132 168 L 132 108 L 232 108"
    );
  });

  it("splits native line paths into editable polyline nodes", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 100,
      height: 60,
      data: {
        artPathKind: "line"
      }
    } satisfies GraphicObject;

    const split = splitGraphicPathSegmentAtPoint(graphic, { x: 170, y: 110 }, { maxDistancePx: 2 });

    expect(split?.segmentIndex).toBe(0);
    expect(split?.object.data.artPathKind).toBe("polyline");
    expect(split?.object.data.pathNodes).toEqual([
      { point: { x: 123, y: 83 } },
      { point: { x: 170, y: 110 } },
      { point: { x: 217, y: 137 } }
    ]);
    expect(planNativeArtVisual(split!.object, { coordinateSpace: "page" }).pathD).toBe(
      "M 123 83 L 170 110 L 217 137"
    );
  });

  it("splits native polyline path segments at the nearest point", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 140,
      height: 90,
      data: {
        artPathKind: "polyline",
        pathNodes: [
          { point: { x: 132, y: 108 } },
          { point: { x: 232, y: 108 } },
          { point: { x: 232, y: 168 } }
        ]
      }
    } satisfies GraphicObject;

    const split = splitGraphicPathSegmentAtPoint(graphic, { x: 180, y: 111 }, { maxDistancePx: 6 });

    expect(split?.segmentIndex).toBe(0);
    expect(split?.object.data.pathNodes).toEqual([
      { point: { x: 132, y: 108 } },
      { point: { x: 180, y: 108 } },
      { point: { x: 232, y: 108 } },
      { point: { x: 232, y: 168 } }
    ]);
    expect(split?.object.x).toBeCloseTo(126, 3);
    expect(planNativeArtVisual(split!.object, { coordinateSpace: "page" }).pathD).toBe(
      "M 132 108 L 180 108 L 232 108 L 232 168"
    );
  });

  it("plans native Bezier path nodes with cubic controls", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      data: {
        artPathKind: "bezier",
        pathNodes: [
          {
            point: { x: 124, y: 144 },
            outControl: { x: 144, y: 100 }
          },
          {
            point: { x: 208, y: 132 },
            inControl: { x: 176, y: 108 }
          }
        ]
      }
    } satisfies GraphicObject;

    const plan = planNativeArtVisual(graphic, { coordinateSpace: "local" });

    expect(plan.pathD).toBe("M 4 64 C 24 20 56 28 88 52");
    expect(plan.capabilities).toMatchObject({
      supportsFill: false,
      supportsLineCap: true,
      supportsLineJoin: false,
      isOpenStroke: true
    });
  });

  it("adds and moves native Bezier control handles", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      data: {
        artPathKind: "bezier",
        pathNodes: [
          { point: { x: 132, y: 108 } },
          { point: { x: 208, y: 148 } }
        ]
      }
    } satisfies GraphicObject;

    const edited = editGraphicPathGeometry(graphic, "node:0:out", { x: 178, y: 92 });

    expect(edited?.data.pathNodes).toEqual([
      {
        point: { x: 132, y: 108 },
        outControl: { x: 178, y: 92 }
      },
      { point: { x: 208, y: 148 } }
    ]);
    expect(planNativeArtVisual(edited!, { coordinateSpace: "page" }).pathD).toBe("M 132 108 C 178 92 208 148 208 148");
  });

  it("splits native Bezier path segments while preserving the cubic shape", () => {
    const graphic = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      data: {
        artPathKind: "bezier",
        pathNodes: [
          {
            point: { x: 100, y: 100 },
            outControl: { x: 130, y: 50 }
          },
          {
            point: { x: 200, y: 100 },
            inControl: { x: 170, y: 150 }
          }
        ]
      }
    } satisfies GraphicObject;

    const split = splitGraphicPathSegmentAtPoint(graphic, { x: 150, y: 100 }, { maxDistancePx: 2 });
    const nodes = split?.object.data.pathNodes;

    expect(split?.segmentIndex).toBe(0);
    expect(nodes).toHaveLength(3);
    expect(nodes?.[0]?.point).toEqual({ x: 100, y: 100 });
    expect(nodes?.[0]?.outControl?.x).toBeCloseTo(115, 1);
    expect(nodes?.[0]?.outControl?.y).toBeCloseTo(75, 1);
    expect(nodes?.[1]?.point.x).toBeCloseTo(150, 1);
    expect(nodes?.[1]?.point.y).toBeCloseTo(100, 1);
    expect(nodes?.[1]?.inControl?.x).toBeCloseTo(132.5, 1);
    expect(nodes?.[1]?.inControl?.y).toBeCloseTo(87.5, 1);
    expect(nodes?.[1]?.outControl?.x).toBeCloseTo(167.5, 1);
    expect(nodes?.[1]?.outControl?.y).toBeCloseTo(112.5, 1);
    expect(nodes?.[2]?.point).toEqual({ x: 200, y: 100 });
    expect(nodes?.[2]?.inControl?.x).toBeCloseTo(185, 1);
    expect(nodes?.[2]?.inControl?.y).toBeCloseTo(125, 1);
    expect(planNativeArtVisual(split!.object, { coordinateSpace: "page" }).pathD?.match(/ C /g)).toHaveLength(2);
  });

  it("plans pressure-sensitive native freehand strokes as filled outline paths", () => {
    const lowPressure = {
      ...baseGraphic,
      graphicKind: "path",
      width: 120,
      height: 80,
      data: {
        artPathKind: "freehand",
        freehandOptions: {
          size: 18,
          thinning: 0.75,
          smoothing: 0.5,
          streamline: 0.35,
          simulatePressure: false
        },
        freehandPoints: [
          { x: 132, y: 112, pressure: 0.18 },
          { x: 164, y: 118, pressure: 0.18 },
          { x: 200, y: 112, pressure: 0.18 }
        ]
      }
    } satisfies GraphicObject;
    const highPressure = {
      ...lowPressure,
      id: "graphic_high_pressure",
      data: {
        ...lowPressure.data,
        freehandPoints: lowPressure.data.freehandPoints.map((point) => ({ ...point, pressure: 0.92 }))
      }
    } satisfies GraphicObject;

    const lowPlan = planNativeArtVisual(lowPressure, { coordinateSpace: "local" });
    const highPlan = planNativeArtVisual(highPressure, { coordinateSpace: "local" });

    expect(lowPlan.pathD).toMatch(/^M /);
    expect(lowPlan.pathD).toContain(" Z");
    expect(lowPlan.capabilities).toMatchObject({
      supportsFill: false,
      supportsStroke: true,
      supportsDash: false,
      isClosedShape: false,
      isOpenStroke: true
    });
    expect(lowPlan.fill.color).toBe("#111111");
    expect(lowPlan.stroke.paint).toEqual({ kind: "none", opacity: 0 });
    expect(graphicPathEditPoints(lowPressure)).toBeUndefined();
    expect(getPathBBox(highPlan.pathD ?? "").height).toBeGreaterThan(getPathBBox(lowPlan.pathD ?? "").height);
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
    expect(plan.frameBounds.height).toBeGreaterThan(40);
    expect(plan.glossGradient?.gradientTransform).toBe(plan.projectionTransform);
  });

  it("keeps plain Z rotation out of projected custom path planning", () => {
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
    expect(plan.projectionMatrix).toBeUndefined();
    expect(plan.projectionTransform).toBeUndefined();
    expect(plan.frameBounds).toEqual({ x: 0, y: 0, width: 100, height: 80 });

    const tilted = planNativeArtVisual({
      ...graphic,
      style: {
        ...graphic.style,
        tiltYDegrees: 20
      }
    }, { coordinateSpace: "local" });
    expect(tilted.projectionMatrix).toBeDefined();
    expect(tilted.frameBounds).not.toEqual(plan.frameBounds);
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
    const projectedStart = rotatePagePointAroundGraphicCenter(
      graphic,
      projectGraphicObjectPoint(graphic, points.start),
      graphic.rotation
    );
    const projectedMiddle = rotatePagePointAroundGraphicCenter(
      graphic,
      projectGraphicObjectPoint(graphic, points.middle),
      graphic.rotation
    );
    const projectedEnd = rotatePagePointAroundGraphicCenter(
      graphic,
      projectGraphicObjectPoint(graphic, points.end),
      graphic.rotation
    );

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

  it("hit-tests a rotated open stroke along its visible rotated position", () => {
    const line = {
      ...baseGraphic,
      id: "graphic_rotated_line",
      graphicKind: "line",
      x: 100,
      y: 100,
      width: 80,
      height: 0,
      rotation: 90
    } satisfies GraphicObject;
    // After a 90° rotation about the center (140,100) the stroke is vertical at x=140, y∈[60,140];
    // the un-rotated stroke would sit horizontally at y=100.
    const lassoOverRotatedStroke = [
      { x: 134, y: 64 },
      { x: 146, y: 64 },
      { x: 146, y: 78 },
      { x: 134, y: 78 }
    ];
    expect(graphicObjectIntersectsPolygon(line, lassoOverRotatedStroke)).toBe(true);
  });

  it("selects a closed shape that only the lasso closing edge crosses", () => {
    const rect = {
      ...baseGraphic,
      id: "graphic_closing_edge_rect",
      graphicKind: "rect",
      x: 195,
      y: 95,
      width: 10,
      height: 10,
      rotation: 0,
      style: { ...baseGraphic.style, fillColor: "#3366cc" }
    } satisfies GraphicObject;
    // Triangle whose two open edges miss the 10×10 rect; only the closing edge (last→first) passes
    // through the rect at (200,100).
    const lasso = [
      { x: 300, y: 120 },
      { x: 300, y: 40 },
      { x: 100, y: 80 }
    ];
    expect(graphicObjectIntersectsPolygon(rect, lasso)).toBe(true);
  });
});

function rotatePagePointAroundGraphicCenter(
  graphic: GraphicObject,
  point: { x: number; y: number },
  rotationDegrees: number
): { x: number; y: number } {
  const center = {
    x: graphic.x + Math.max(graphic.width, 1) / 2,
    y: graphic.y + Math.max(graphic.height, 1) / 2
  };
  const rotationRad = rotationDegrees * Math.PI / 180;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}
