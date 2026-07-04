import { describe, expect, it } from "vitest";
import {
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  stylePresetToObjectStyle,
  type ChemDraftDocument,
  type DocumentObject,
  type GraphicObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import {
  createArtInspectorModel,
  createMoleculeRingArtInspectorModel,
  selectedGraphicObjectsForArtInspector,
  selectedVisualObjectsForArtInspector
} from "./artInspectorModel";
import type { MoleculeInspectorRingsModel } from "./moleculeInspectorModel";

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

  it("presents freehand strokes as stroke-color objects even though they render as filled outlines", () => {
    const graphic = pathGraphic("freehand", "freehand", {
      style: {
        fillColor: "none",
        strokeColor: "#1d7f68",
        strokeOpacity: 0.72
      },
      data: {
        artPathKind: "freehand",
        freehandPoints: [
          { x: 120, y: 100, pressure: 0.4 },
          { x: 150, y: 116, pressure: 0.8 }
        ],
        freehandOptions: { size: 8 }
      }
    });
    const model = createArtInspectorModel({
      document: documentWithSelectedGraphics([graphic]),
      selectedGraphicObjects: [graphic],
      requestedPaintTarget: "fill"
    });

    expect(model).toMatchObject({
      activePaintTarget: "stroke",
      supportsFillAny: false,
      supportsStrokeAny: true,
      supportsDashAny: false,
      fillSupportedCount: 0,
      strokeSupportedCount: 1
    });
    expect(model.values.fillColor).toEqual({ value: null, mixed: false });
    expect(model.values.strokeColor).toEqual({ value: "#1d7f68", mixed: false });
    expect(model.values.strokeOpacity).toEqual({ value: 0.72, mixed: false });
    expect(model.skippedObjectIdsByControl.fill).toEqual([{ objectId: "freehand", reason: "open-stroke" }]);
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

  it("reports native gradient and gloss paint types for selected graphics", () => {
    const gradient = rectGraphic("gradient", {
      style: {
        fillColor: "#1d7f68",
        fillPaint: {
          kind: "linear-gradient",
          units: "object",
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: "#1d7f68" },
            { offset: 1, color: "#ffffff", opacity: 0.35 }
          ]
        },
        strokeColor: "#b3261e",
        strokePaint: {
          kind: "radial-gradient",
          units: "object",
          cx: 0.5,
          cy: 0.5,
          r: 0.7,
          stops: [
            { offset: 0, color: "#ffffff" },
            { offset: 1, color: "#b3261e" }
          ]
        }
      }
    });
    const model = createArtInspectorModel({
      document: documentWithSelectedGraphics([gradient]),
      selectedGraphicObjects: [gradient],
      requestedPaintTarget: "fill"
    });

    expect(model.values.fillPaintType).toEqual({ value: "linear-gradient", mixed: false });
    expect(model.values.strokePaintType).toEqual({ value: "radial-gradient", mixed: false });
    expect(model.values.fillColor).toEqual({ value: "#1d7f68", mixed: false });
    expect(model.values.strokeColor).toEqual({ value: "#b3261e", mixed: false });
    expect(model.activeGradient).toEqual({
      paintType: "linear-gradient",
      mixed: false,
      editable: true,
      canAddStop: true,
      canDeleteStop: false,
      stops: [
        { offset: 0, color: "#1d7f68", opacity: 1 },
        { offset: 1, color: "#ffffff", opacity: 0.35 }
      ]
    });

    const strokeModel = createArtInspectorModel({
      document: documentWithSelectedGraphics([gradient]),
      selectedGraphicObjects: [gradient],
      requestedPaintTarget: "stroke"
    });
    expect(strokeModel.activeGradient).toEqual({
      paintType: "radial-gradient",
      mixed: false,
      editable: true,
      canAddStop: true,
      canDeleteStop: false,
      stops: [
        { offset: 0, color: "#ffffff", opacity: 1 },
        { offset: 1, color: "#b3261e", opacity: 1 }
      ]
    });

    const gloss = rectGraphic("gloss", {
      style: {
        fillColor: "#1d7f68",
        fillMode: "gloss",
        strokeColor: "#111111"
      }
    });
    const glossModel = createArtInspectorModel({
      document: documentWithSelectedGraphics([gloss]),
      selectedGraphicObjects: [gloss],
      requestedPaintTarget: "fill"
    });
    expect(glossModel.values.fillPaintType).toEqual({ value: "gloss", mixed: false });
    expect(glossModel.activeGradient).toEqual({
      paintType: null,
      stops: [],
      mixed: false,
      editable: false,
      canAddStop: false,
      canDeleteStop: false
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

  it("reports art effect state for visible toolbar controls", () => {
    const plain = rectGraphic("plain");
    const shadow = rectGraphic("shadow", {
      style: {
        effects: [{ kind: "shadow", color: "#52616b" }]
      }
    });
    const stacked = rectGraphic("stacked", {
      style: {
        effects: [{ kind: "shadow" }, { kind: "sketch", seed: 42 }]
      }
    });
    const legacyShadow = rectGraphic("legacy_shadow", {
      style: {
        effect: "shadow"
      }
    });

    expect(createArtInspectorModel({
      document: documentWithSelectedGraphics([plain]),
      selectedGraphicObjects: [plain]
    })).toMatchObject({
      effectKinds: [],
      values: { effect: { value: "none", mixed: false } },
      effectControls: {
        shadow: {
          presentCount: 0,
          presentAll: false,
          color: { value: "#52616b", mixed: false },
          opacity: { value: 0.28, mixed: false },
          size: { value: 0.25, mixed: false }
        }
      }
    });
    const shadowModel = createArtInspectorModel({
      document: documentWithSelectedGraphics([shadow]),
      selectedGraphicObjects: [shadow]
    });
    expect(shadowModel.values.effect).toEqual({ value: "shadow", mixed: false });
    expect(shadowModel.effectKinds).toEqual(["shadow"]);
    expect(shadowModel.effectControls.shadow).toMatchObject({
      presentCount: 1,
      presentAll: true,
      color: { value: "#52616b", mixed: false },
      opacity: { value: 0.28, mixed: false },
      size: { value: 0.25, mixed: false }
    });
    const stackedModel = createArtInspectorModel({
      document: documentWithSelectedGraphics([stacked]),
      selectedGraphicObjects: [stacked]
    });
    expect(stackedModel.values.effect).toEqual({ value: "multiple", mixed: false });
    expect(stackedModel.effectKinds).toEqual(["shadow", "sketch"]);
    expect(stackedModel.effectControls.sketch).toMatchObject({
      presentCount: 1,
      presentAll: true,
      opacity: { value: 1, mixed: false }
    });
    expect(stackedModel.effectControls.sketch.size.value).toBeCloseTo(1.25 / 3);
    expect(createArtInspectorModel({
      document: documentWithSelectedGraphics([legacyShadow]),
      selectedGraphicObjects: [legacyShadow]
    })).toMatchObject({
      effectKinds: ["shadow"],
      values: { effect: { value: "shadow", mixed: false } },
      effectControls: {
        shadow: {
          presentCount: 1,
          presentAll: true,
          color: { value: "#52616b", mixed: false }
        }
      }
    });
    const mixedModel = createArtInspectorModel({
      document: documentWithSelectedGraphics([plain, shadow]),
      selectedGraphicObjects: [plain, shadow]
    });
    expect(mixedModel.values.effect).toEqual({ value: null, mixed: true });
    expect(mixedModel.effectKinds).toEqual(["shadow"]);
    expect(mixedModel.effectControls.shadow).toMatchObject({
      presentCount: 1,
      presentAll: false,
      color: { value: "#52616b", mixed: false }
    });
  });

  it("selects graphics from the current document selection without carrying UI state", () => {
    const line = pathGraphic("line", "line");
    const circle = ellipseGraphic("circle");
    const document = documentWithSelectedGraphics([line, circle], ["circle"]);

    expect(selectedGraphicObjectsForArtInspector(document)).toEqual([circle]);
  });

  it("models selected molecules as art fill/stroke targets from the Art toolbar", () => {
    const molecule = moleculeObject("mol_effect", {
      style: {
        ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
        source: "chemdraft-native-drawing",
        bondColor: "#263238",
        fillColor: "#1d7f68",
        fillPaint: { kind: "solid", color: "#1d7f68", opacity: 0.4 },
        fillOpacity: 0.4,
        strokeOpacity: 0.72,
        visualEffects: [
          { kind: "glow", color: "#ffee66", opacity: 0.7, blurPx: 9, spreadPx: 2 }
        ]
      }
    });
    const document = documentWithSelectedObjects([molecule]);
    const selectedVisualObjects = selectedVisualObjectsForArtInspector(document);

    expect(selectedGraphicObjectsForArtInspector(document)).toEqual([]);
    expect(selectedVisualObjects).toEqual([molecule]);

    const model = createArtInspectorModel({
      document,
      selectedGraphicObjects: [],
      selectedVisualObjects
    });
    expect(model).toMatchObject({
      selectedCount: 1,
      selectedObjectIds: ["mol_effect"],
      selectedGraphicIds: [],
      supportsFillAny: true,
      supportsStrokeAny: true,
      supportsDashAny: false,
      values: {
        fillColor: { value: "#1d7f68", mixed: false },
        strokeColor: { value: "#263238", mixed: false },
        fillOpacity: { value: 0.4, mixed: false },
        strokeOpacity: { value: 0.72, mixed: false },
        effect: { value: "glow", mixed: false }
      },
      effectKinds: ["glow"],
      effectControls: {
        glow: {
          presentCount: 1,
          presentAll: true,
          color: { value: "#ffee66", mixed: false },
          opacity: { value: 0.7, mixed: false }
        }
      }
    });
    expect(model.effectControls.glow.size.value).toBeCloseTo(0.5);
    expect(model.activeGradient).toMatchObject({
      paintType: null,
      editable: false,
      mixed: false,
      stops: []
    });
  });

  it("projects selected molecule rings into the Art toolbar target model", () => {
    const moleculeInspector: MoleculeInspectorRingsModel = {
      enabled: true,
      selectedCount: 2,
      selectedRing: {
        objectId: "mol_ring",
        kind: "ring",
        ringKey: "bond_001|bond_002",
        atomIds: ["atom_001", "atom_002"],
        bondIds: ["bond_001", "bond_002"]
      },
      selectedRings: [
        {
          objectId: "mol_ring",
          kind: "ring",
          ringKey: "bond_001|bond_002",
          atomIds: ["atom_001", "atom_002"],
          bondIds: ["bond_001", "bond_002"]
        },
        {
          objectId: "mol_ring",
          kind: "ring",
          ringKey: "bond_003|bond_004",
          atomIds: ["atom_003", "atom_004"],
          bondIds: ["bond_003", "bond_004"]
        }
      ],
      effectKinds: ["glow"],
      values: {
        fillPaintType: { value: "solid", mixed: false },
        fillColor: { value: "#1d7f68", mixed: false },
        fillOpacity: { value: 0.42, mixed: false },
        effect: { value: "glow", mixed: false }
      },
      effectControls: {
        shadow: moleculeInspectorEffect("shadow"),
        glow: {
          ...moleculeInspectorEffect("glow"),
          presentCount: 2,
          presentAll: true,
          color: { value: "#ffee66", mixed: false },
          opacity: { value: 0.7, mixed: false },
          size: { value: 0.5, mixed: false }
        },
        sketch: moleculeInspectorEffect("sketch")
      }
    };

    const model = createMoleculeRingArtInspectorModel(moleculeInspector, "stroke");

    expect(model).toMatchObject({
      selectedCount: 2,
      selectedObjectIds: ["mol_ring:bond_001|bond_002", "mol_ring:bond_003|bond_004"],
      selectedGraphicIds: [],
      appearanceTarget: {
        kind: "molecule-rings",
        rings: [
          { objectId: "mol_ring", ringKey: "bond_001|bond_002" },
          { objectId: "mol_ring", ringKey: "bond_003|bond_004" }
        ]
      },
      requestedPaintTarget: "stroke",
      activePaintTarget: "fill",
      supportsFillAny: true,
      supportsStrokeAny: false,
      fillSupportedCount: 2,
      strokeSupportedCount: 0,
      values: {
        fillPaintType: { value: "solid", mixed: false },
        fillColor: { value: "#1d7f68", mixed: false },
        fillOpacity: { value: 0.42, mixed: false },
        effect: { value: "glow", mixed: false }
      },
      effectKinds: ["glow"],
      activeGradient: {
        paintType: null,
        editable: false,
        stops: []
      }
    });
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});

function documentWithSelectedGraphics(
  graphics: readonly GraphicObject[],
  selectedIds = graphics.map((graphic) => graphic.id)
): ChemDraftDocument {
  return documentWithSelectedObjects(graphics, selectedIds);
}

function documentWithSelectedObjects(
  objects: readonly DocumentObject[],
  selectedIds = objects.map((object) => object.id)
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
      objects: [...objects]
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

function moleculeObject(id: string, overrides: Partial<MoleculeObject> = {}): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 120,
    y: 120,
    width: 120,
    height: 32,
    rotation: 0,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      source: "chemdraft-native-drawing"
    },
    structureFormat: "smiles",
    structure: "CC",
    atoms: [
      { id: "atom_001", element: "C", x: 140, y: 180, formalCharge: 0 },
      { id: "atom_002", element: "C", x: 220, y: 180, formalCharge: 0 }
    ],
    bonds: [
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }
    ],
    chemistry: {
      formula: "C2H6",
      atomCount: 2,
      bondCount: 1,
      totalCharge: 0,
      radicalCount: 0,
      isotopeLabels: [],
      stereochemistry: [],
      warnings: []
    },
    superatoms: [],
    rGroups: [],
    ...overrides
  };
}

function moleculeInspectorEffect(
  kind: "shadow" | "glow" | "sketch"
): MoleculeInspectorRingsModel["effectControls"]["shadow"] {
  return {
    kind,
    presentCount: 0,
    presentAll: false,
    color: { value: "#52616b", mixed: false },
    opacity: { value: 1, mixed: false },
    size: { value: 0.25, mixed: false }
  };
}
