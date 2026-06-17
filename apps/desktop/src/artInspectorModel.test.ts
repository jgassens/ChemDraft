import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { createArtInspectorModel, selectedGraphicObjectsForArtInspector } from "./artInspectorModel";

const baseGraphic = {
  type: "graphic",
  x: 120,
  y: 80,
  rotation: 0,
  style: {
    strokeColor: "#111111",
    fillColor: "none",
    strokeWidth: 2
  },
  data: {}
} satisfies Omit<GraphicObject, "id" | "graphicKind" | "width" | "height">;

describe("ArtInspectorModel", () => {
  it("derives a serializable stroke-only model for line, arc, wavy, and quadratic path graphics", () => {
    for (const artPathKind of ["line", "arc", "wavy", "quadratic"] as const) {
      const graphic = pathGraphic(`graphic_${artPathKind}`, artPathKind);
      const model = createArtInspectorModel({
        document: documentWithSelectedGraphics([graphic]),
        selectedGraphicObjects: [graphic],
        requestedPaintTarget: "fill"
      });

      expect(JSON.parse(JSON.stringify(model))).toEqual(model);
      expect(model).toMatchObject({
        selectedCount: 1,
        selectedGraphicIds: [graphic.id],
        selectedGraphicKinds: ["path"],
        requestedPaintTarget: "fill",
        activePaintTarget: "stroke",
        supportsFillAny: false,
        supportsFillAll: false,
        supportsStrokeAny: true,
        supportsStrokeAll: true,
        supportsDashAny: true,
        supportsDashAll: true,
        supportsLineEndsAny: true,
        supportsLineEndsAll: true,
        supportsCornersAny: false,
        supportsCornersAll: false,
        supportsFillOpacityAny: false,
        supportsStrokeOpacityAny: true,
        skippedObjectIdsByControl: {
          fill: [{ objectId: graphic.id, reason: "open-stroke" }],
          corners: [{ objectId: graphic.id, reason: "no-corners" }]
        }
      });
      expect(model.skippedObjectIdsByControl.lineEnds).toBeUndefined();
      expect(model.values.fillColor).toEqual({ value: null, mixed: false });
      expect(model.values.strokeColor).toEqual({ value: "#111111", mixed: false });
    }
  });

  it("shows fill and stroke controls for closed ellipse graphics while hiding line ends and corners", () => {
    const graphic = ellipseGraphic("ellipse", {
      style: {
        strokeColor: "#1648ff",
        fillColor: "#1d7f68",
        strokeWidth: 4,
        strokeDasharray: "8 6",
        fillOpacity: 0.7,
        strokeOpacity: 0.5
      }
    });
    const model = createArtInspectorModel({
      document: documentWithSelectedGraphics([graphic]),
      selectedGraphicObjects: [graphic],
      requestedPaintTarget: "fill"
    });

    expect(model).toMatchObject({
      activePaintTarget: "fill",
      supportsFillAny: true,
      supportsFillAll: true,
      supportsStrokeAny: true,
      supportsStrokeAll: true,
      supportsDashAny: true,
      supportsDashAll: true,
      supportsLineEndsAny: false,
      supportsLineEndsAll: false,
      supportsCornersAny: false,
      supportsCornersAll: false,
      skippedObjectIdsByControl: {
        lineEnds: [{ objectId: "ellipse", reason: "closed-shape" }],
        corners: [{ objectId: "ellipse", reason: "no-corners" }]
      }
    });
    expect(model.skippedObjectIdsByControl.fill).toBeUndefined();
    expect(model.values).toMatchObject({
      fillColor: { value: "#1d7f68", mixed: false },
      strokeColor: { value: "#1648ff", mixed: false },
      fillOpacity: { value: 0.7, mixed: false },
      strokeOpacity: { value: 0.5, mixed: false },
      strokeWidth: { value: 4, mixed: false },
      dash: { value: "8 6", mixed: false }
    });
  });

  it("hides rectangle corners in this pass while preserving fill, stroke, width, and dash support", () => {
    const graphic = rectGraphic("rectangle");
    const model = createArtInspectorModel({
      document: documentWithSelectedGraphics([graphic]),
      selectedGraphicObjects: [graphic],
      requestedPaintTarget: "fill"
    });

    expect(model).toMatchObject({
      supportsFillAny: true,
      supportsFillAll: true,
      supportsStrokeAny: true,
      supportsStrokeAll: true,
      supportsDashAny: true,
      supportsDashAll: true,
      supportsLineEndsAny: false,
      supportsCornersAny: false,
      skippedObjectIdsByControl: {
        lineEnds: [{ objectId: "rectangle", reason: "closed-shape" }],
        corners: [{ objectId: "rectangle", reason: "no-corners" }]
      }
    });
  });

  it("keeps corners available only for tested custom cornered paths", () => {
    const closedCorneredPath = pathGraphic("custom_path", undefined, {
      data: {
        pathD: "M 4 4 L 76 4 L 76 44 L 4 44 Z"
      },
      style: {
        fillColor: "#f8faf9",
        strokeColor: "#111111"
      }
    });
    const model = createArtInspectorModel({
      document: documentWithSelectedGraphics([closedCorneredPath]),
      selectedGraphicObjects: [closedCorneredPath],
      requestedPaintTarget: "fill"
    });

    expect(model).toMatchObject({
      supportsFillAny: true,
      supportsFillAll: true,
      supportsLineEndsAny: false,
      supportsCornersAny: true,
      supportsCornersAll: true
    });
    expect(model.skippedObjectIdsByControl.corners).toBeUndefined();
  });

  it("tracks partial applicability and skip reasons for mixed line plus circle selections", () => {
    const line = pathGraphic("line", "line", {
      style: {
        strokeColor: "#111111",
        strokeWidth: 6
      }
    });
    const circle = ellipseGraphic("circle", {
      style: {
        strokeColor: "#111111",
        fillColor: "#1d7f68",
        strokeWidth: 6
      }
    });
    const model = createArtInspectorModel({
      document: documentWithSelectedGraphics([line, circle]),
      selectedGraphicObjects: [line, circle],
      requestedPaintTarget: "fill"
    });

    expect(model).toMatchObject({
      selectedCount: 2,
      selectedGraphicIds: ["line", "circle"],
      selectedGraphicKinds: ["path", "ellipse"],
      activePaintTarget: "fill",
      supportsFillAny: true,
      supportsFillAll: false,
      supportsStrokeAny: true,
      supportsStrokeAll: true,
      supportsDashAny: true,
      supportsDashAll: true,
      supportsLineEndsAny: true,
      supportsLineEndsAll: false,
      supportsCornersAny: false,
      supportsCornersAll: false,
      fillSupportedCount: 1,
      strokeSupportedCount: 2,
      lineEndsSupportedCount: 1,
      skippedObjectIdsByControl: {
        fill: [{ objectId: "line", reason: "open-stroke" }],
        lineEnds: [{ objectId: "circle", reason: "closed-shape" }],
        corners: [
          { objectId: "line", reason: "no-corners" },
          { objectId: "circle", reason: "no-corners" }
        ]
      }
    });
    expect(model.values.fillColor).toEqual({ value: "#1d7f68", mixed: false });
    expect(model.values.strokeColor).toEqual({ value: "#111111", mixed: false });
    expect(model.values.strokeWidth).toEqual({ value: 6, mixed: false });
  });

  it("reports mixed supported values without letting unsupported objects create fake mixed states", () => {
    const first = ellipseGraphic("first", {
      style: {
        fillColor: "#1d7f68",
        strokeColor: "#111111",
        strokeWidth: 2
      }
    });
    const second = ellipseGraphic("second", {
      style: {
        fillColor: "#b3261e",
        strokeColor: "#111111",
        strokeWidth: 4
      }
    });
    const line = pathGraphic("line", "line", {
      style: {
        fillColor: "#ffffff",
        strokeColor: "#111111",
        strokeWidth: 4
      }
    });
    const model = createArtInspectorModel({
      document: documentWithSelectedGraphics([first, second, line]),
      selectedGraphicObjects: [first, second, line],
      requestedPaintTarget: "fill"
    });

    expect(model.values.fillColor).toEqual({ value: null, mixed: true });
    expect(model.values.strokeColor).toEqual({ value: "#111111", mixed: false });
    expect(model.values.strokeWidth).toEqual({ value: null, mixed: true });
    expect(model.skippedObjectIdsByControl.fill).toEqual([{ objectId: "line", reason: "open-stroke" }]);
  });

  it("selects graphics from the current document selection without carrying UI state", () => {
    const line = pathGraphic("line", "line");
    const circle = ellipseGraphic("circle");
    const document = documentWithSelectedGraphics([line, circle], ["circle"]);

    expect(selectedGraphicObjectsForArtInspector(document)).toEqual([circle]);
  });
});

function documentWithSelectedGraphics(
  graphics: readonly GraphicObject[],
  selectedIds = graphics.map((graphic) => graphic.id)
): ChemDraftDocument {
  const document = createEmptyDocument({
    id: "doc_art_inspector",
    pageId: "page_art_inspector",
    title: "Art Inspector"
  });
  return {
    ...document,
    pages: [{
      ...document.pages[0],
      objects: [...graphics]
    }],
    selection: {
      objectIds: [...selectedIds]
    }
  };
}

function pathGraphic(
  id: string,
  artPathKind?: "line" | "arc" | "wavy" | "quadratic" | "polyline" | "bezier" | "freehand",
  overrides: Partial<GraphicObject> = {}
): GraphicObject {
  return {
    ...baseGraphic,
    id,
    graphicKind: "path",
    width: 82,
    height: 46,
    ...overrides,
    style: {
      ...baseGraphic.style,
      ...overrides.style
    },
    data: {
      ...(artPathKind ? { artPathKind } : {}),
      ...overrides.data
    }
  };
}

function ellipseGraphic(id: string, overrides: Partial<GraphicObject> = {}): GraphicObject {
  return {
    ...baseGraphic,
    id,
    graphicKind: "ellipse",
    width: 48,
    height: 48,
    ...overrides,
    style: {
      ...baseGraphic.style,
      ...overrides.style
    },
    data: {
      ...overrides.data
    }
  };
}

function rectGraphic(id: string, overrides: Partial<GraphicObject> = {}): GraphicObject {
  return {
    ...baseGraphic,
    id,
    graphicKind: "rect",
    width: 72,
    height: 40,
    ...overrides,
    style: {
      ...baseGraphic.style,
      ...overrides.style
    },
    data: {
      ...overrides.data
    }
  };
}
