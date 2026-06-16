import { describe, expect, it } from "vitest";
import {
  DocumentPatchError,
  DocumentSchemaVersion,
  applyPatch,
  applyPatchWithHistory,
  applyPatches,
  ChemDraftSyntheticStylePreset,
  createPageLayout,
  createDocumentHistory,
  createEmptyDocument,
  DefaultNativeDrawingStyle,
  DefaultNativeTextStyle,
  deserializeDocument,
  inchesToCssPx,
  mmToCssPx,
  nativeDrawingStyleFromObjectStyle,
  nativeTextStyleFromObjectStyle,
  pageLayoutMatchesSize,
  redo,
  serializeDocument,
  stylePresetToObjectStyle,
  textStyleToObjectStyle,
  undo,
  validateDocument,
  type AnnotationObject,
  type CrossingOverride,
  type GraphicObject,
  type MoleculeObject
} from "./index";

const timestamp = "2026-05-29T00:00:00.000Z";

function moleculeObject(id = "mol_001"): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 120,
    y: 160,
    width: 180,
    height: 120,
    rotation: 0,
    style: {},
    structureFormat: "smiles",
    structure: "c1ccccc1",
    atoms: [],
    bonds: [],
    chemistry: {
      formula: "C6H6",
      averageMass: 78.114,
      exactMass: 78.047,
      atomCount: 6,
      bondCount: 6,
      totalCharge: 0,
      radicalCount: 0,
      isotopeLabels: [],
      stereochemistry: [],
      warnings: []
    },
    superatoms: [],
    rGroups: []
  };
}

function annotationObject(id = "ann_001"): AnnotationObject {
  return {
    id,
    type: "annotation",
    x: 24,
    y: 32,
    width: 180,
    height: 28,
    rotation: 0,
    style: {},
    targetObjectIds: ["mol_001"],
    message: "Review stereochemistry before export."
  };
}

describe("createEmptyDocument", () => {
  it("returns a minimal native document with a page and no objects", () => {
    const document = createEmptyDocument({
      id: "doc_test",
      pageId: "page_test",
      title: "Test Document",
      now: timestamp
    });

    expect(document).toEqual({
      schema: DocumentSchemaVersion,
      id: "doc_test",
      title: "Test Document",
      createdAt: timestamp,
      updatedAt: timestamp,
      pages: [
        {
          id: "page_test",
          width: 816,
          height: 1056,
          margin: {
            top: 72,
            right: 72,
            bottom: 72,
            left: 72
          },
          layout: {
            presetId: "letter",
            orientation: "portrait",
            widthPx: 816,
            heightPx: 1056,
            marginTopPx: 72,
            marginRightPx: 72,
            marginBottomPx: 72,
            marginLeftPx: 72,
            sourceUnit: "inch",
            sourceWidth: 8.5,
            sourceHeight: 11
          },
          objects: [],
          crossings: []
        }
      ],
      selection: {
        objectIds: []
      },
      styles: {},
      plugins: {},
      compatibility: {
        warnings: []
      }
    });
  });
});

describe("page crossing overrides", () => {
  function crossingMolecule(id: string, bondId = "bond_001"): MoleculeObject {
    return {
      ...moleculeObject(id),
      structure: "CC",
      atoms: [
        { id: "atom_001", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 160, y: 100, formalCharge: 0 }
      ],
      bonds: [{ id: bondId, fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }]
    };
  }

  function documentWithCrossingMolecules() {
    return applyPatches(
      createEmptyDocument({ now: timestamp }),
      [
        { op: "addObject", pageId: "page_001", object: crossingMolecule("mol_back", "bond_back") },
        { op: "addObject", pageId: "page_001", object: crossingMolecule("mol_front", "bond_front") }
      ],
      { now: timestamp }
    );
  }

  it("defaults page crossings for old and new documents without bumping the schema", () => {
    const document = createEmptyDocument({ now: timestamp });
    expect(document.schema).toBe(DocumentSchemaVersion);
    expect(document.pages[0].crossings).toEqual([]);

    const serialized = JSON.parse(serializeDocument(document)) as { pages: Array<Record<string, unknown>> };
    delete serialized.pages[0].crossings;

    expect(deserializeDocument(JSON.stringify(serialized)).pages[0].crossings).toEqual([]);
  });

  it("sets, canonicalizes, replaces, and clears crossing overrides", () => {
    const document = documentWithCrossingMolecules();
    const crossing: CrossingOverride = {
      bonds: [
        { objectId: "mol_front", bondId: "bond_front" },
        { objectId: "mol_back", bondId: "bond_back" }
      ],
      front: { objectId: "mol_front", bondId: "bond_front" },
      clearancePx: 12
    };

    const withCrossing = applyPatch(document, {
      op: "setCrossingOverride",
      pageId: "page_001",
      crossing
    }, { now: timestamp });

    expect(withCrossing.pages[0].crossings).toEqual([{
      bonds: [
        { objectId: "mol_back", bondId: "bond_back" },
        { objectId: "mol_front", bondId: "bond_front" }
      ],
      front: { objectId: "mol_front", bondId: "bond_front" },
      clearancePx: 12
    }]);

    const flipped = applyPatch(withCrossing, {
      op: "setCrossingOverride",
      pageId: "page_001",
      crossing: {
        ...crossing,
        front: { objectId: "mol_back", bondId: "bond_back" }
      }
    }, { now: timestamp });

    expect(flipped.pages[0].crossings).toHaveLength(1);
    expect(flipped.pages[0].crossings[0].front).toEqual({ objectId: "mol_back", bondId: "bond_back" });

    const cleared = applyPatch(flipped, {
      op: "clearCrossingOverride",
      pageId: "page_001",
      bonds: [
        { objectId: "mol_front", bondId: "bond_front" },
        { objectId: "mol_back", bondId: "bond_back" }
      ]
    }, { now: timestamp });

    expect(cleared.pages[0].crossings).toEqual([]);
  });

  it("rejects crossing overrides with invalid fronts or missing bonds", () => {
    const document = documentWithCrossingMolecules();

    expect(() => applyPatch(document, {
      op: "setCrossingOverride",
      pageId: "page_001",
      crossing: {
        bonds: [
          { objectId: "mol_front", bondId: "bond_front" },
          { objectId: "mol_back", bondId: "bond_back" }
        ],
        front: { objectId: "mol_missing", bondId: "bond_missing" }
      }
    }, { now: timestamp })).toThrow(DocumentPatchError);

    expect(() => applyPatch(document, {
      op: "setCrossingOverride",
      pageId: "page_001",
      crossing: {
        bonds: [
          { objectId: "mol_front", bondId: "bond_missing" },
          { objectId: "mol_back", bondId: "bond_back" }
        ],
        front: { objectId: "mol_back", bondId: "bond_back" }
      }
    }, { now: timestamp })).toThrow(DocumentPatchError);
  });

  it("prunes crossing overrides when referenced objects or bond identities change", () => {
    const document = applyPatch(documentWithCrossingMolecules(), {
      op: "setCrossingOverride",
      pageId: "page_001",
      crossing: {
        bonds: [
          { objectId: "mol_front", bondId: "bond_front" },
          { objectId: "mol_back", bondId: "bond_back" }
        ],
        front: { objectId: "mol_front", bondId: "bond_front" }
      }
    }, { now: timestamp });

    expect(applyPatch(document, { op: "removeObject", objectId: "mol_front" }, { now: timestamp }).pages[0].crossings).toEqual([]);

    const moved = applyPatch(document, {
      op: "updateObject",
      objectId: "mol_front",
      changes: {
        atoms: [
          { id: "atom_001", element: "C", x: 110, y: 120, formalCharge: 0 },
          { id: "atom_002", element: "C", x: 170, y: 120, formalCharge: 0 }
        ]
      }
    }, { now: timestamp });
    expect(moved.pages[0].crossings).toHaveLength(1);

    const changedEndpoint = applyPatch(document, {
      op: "updateObject",
      objectId: "mol_front",
      changes: {
        bonds: [{ id: "bond_front", fromAtomId: "atom_002", toAtomId: "atom_001", order: "single" }]
      }
    }, { now: timestamp });
    expect(changedEndpoint.pages[0].crossings).toEqual([]);

    // A structure-string change that does NOT alter the bond graph (e.g. relabelling a carbon
    // to oxygen) keeps the override — each bond's identity is still stable. Previously this
    // cleared every override and made a threaded rotaxane pop back in front.
    const relabelled = applyPatch(document, {
      op: "updateObject",
      objectId: "mol_front",
      changes: { structure: "CCC" }
    }, { now: timestamp });
    expect(relabelled.pages[0].crossings).toHaveLength(1);
  });
});

describe("page layout presets and migration", () => {
  it("converts required paper presets through the 96 CSS px per inch coordinate convention", () => {
    expect(createPageLayout("letter")).toMatchObject({
      widthPx: inchesToCssPx(8.5),
      heightPx: inchesToCssPx(11),
      sourceUnit: "inch",
      sourceWidth: 8.5,
      sourceHeight: 11
    });
    expect(createPageLayout("legal")).toMatchObject({
      widthPx: inchesToCssPx(8.5),
      heightPx: inchesToCssPx(14),
      sourceUnit: "inch",
      sourceWidth: 8.5,
      sourceHeight: 14
    });

    expect(createPageLayout("a4")).toMatchObject({
      widthPx: mmToCssPx(210),
      heightPx: mmToCssPx(297),
      sourceUnit: "mm",
      sourceWidth: 210,
      sourceHeight: 297
    });
    expect(createPageLayout("a3")).toMatchObject({
      widthPx: mmToCssPx(297),
      heightPx: mmToCssPx(420)
    });
    expect(createPageLayout("a2")).toMatchObject({
      widthPx: mmToCssPx(420),
      heightPx: mmToCssPx(594)
    });
    expect(createPageLayout("a1")).toMatchObject({
      widthPx: mmToCssPx(594),
      heightPx: mmToCssPx(841)
    });
    expect(createPageLayout("a0")).toMatchObject({
      widthPx: mmToCssPx(841),
      heightPx: mmToCssPx(1189)
    });
    expect(createPageLayout("a5")).toMatchObject({
      widthPx: mmToCssPx(148),
      heightPx: mmToCssPx(210)
    });
  });

  it("swaps page dimensions and source units for landscape orientation", () => {
    const a4Landscape = createPageLayout("a4", "landscape");

    expect(a4Landscape).toMatchObject({
      orientation: "landscape",
      widthPx: mmToCssPx(297),
      heightPx: mmToCssPx(210),
      sourceWidth: 297,
      sourceHeight: 210
    });
  });

  it("enforces the invariant between page layout geometry and denormalized page dimensions", () => {
    const document = createEmptyDocument({ now: timestamp });
    const result = validateDocument({
      ...document,
      pages: [
        {
          ...document.pages[0],
          width: 1
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => issue.message)).toContain(
      "Page layout widthPx/heightPx must match page width/height."
    );
  });

  it("migrates Phase 4 pages without layout to Letter portrait without changing content", () => {
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      { op: "addObject", pageId: "page_001", object: moleculeObject() },
      { now: timestamp }
    );
    const selected = applyPatch(document, { op: "setSelection", pageId: "page_001", objectIds: ["mol_001"] }, { now: timestamp });
    const legacy = JSON.parse(serializeDocument(selected)) as {
      pages: Array<Record<string, unknown>>;
    };
    delete legacy.pages[0].layout;

    const migrated = deserializeDocument(JSON.stringify(legacy));

    expect(migrated.pages[0].layout).toMatchObject({
      presetId: "letter",
      orientation: "portrait",
      widthPx: 816,
      heightPx: 1056
    });
    expect(migrated.pages[0].objects).toEqual(selected.pages[0].objects);
    expect(migrated.selection).toEqual(selected.selection);
    expect(migrated.pages[0].objects[0]).toMatchObject({
      type: "molecule",
      structure: "c1ccccc1",
      chemistry: selected.pages[0].objects[0]?.type === "molecule" ? selected.pages[0].objects[0].chemistry : undefined
    });
  });

  it("updates page layout through patches without moving or changing molecules", () => {
    const selected = applyPatches(
      createEmptyDocument({ now: timestamp }),
      [
        { op: "addObject", pageId: "page_001", object: moleculeObject() },
        { op: "setSelection", pageId: "page_001", objectIds: ["mol_001"] }
      ],
      { now: timestamp }
    );
    const moleculeBefore = selected.pages[0].objects[0];
    const a3Landscape = createPageLayout("a3", "landscape");
    const resized = applyPatch(
      selected,
      { op: "updatePageLayout", pageId: "page_001", layout: a3Landscape },
      { now: timestamp }
    );

    expect(pageLayoutMatchesSize(resized.pages[0].layout, resized.pages[0].width, resized.pages[0].height)).toBe(true);
    expect(resized.pages[0]).toMatchObject({
      width: a3Landscape.widthPx,
      height: a3Landscape.heightPx,
      margin: {
        top: a3Landscape.marginTopPx,
        right: a3Landscape.marginRightPx,
        bottom: a3Landscape.marginBottomPx,
        left: a3Landscape.marginLeftPx
      }
    });
    expect(resized.pages[0].objects[0]).toEqual(moleculeBefore);
    expect(resized.selection).toEqual(selected.selection);
    expect(deserializeDocument(serializeDocument(resized))).toEqual(resized);
  });
});

describe("native drawing styles", () => {
  it("keeps the ChemDraft synthetic style in CSS-px page units", () => {
    expect(ChemDraftSyntheticStylePreset).toMatchObject({
      id: "chemdraft.synthetic",
      source: "core",
      drawing: {
        bondLengthPx: 22,
        bondStrokeWidthPx: 2,
        doubleBondInsetPx: 4.5,
        bondOverlapClearancePx: 6,
        atomLabelFontFamily: expect.stringContaining("Arial")
      }
    });
  });

  it("serializes presets into object style metadata and resolves missing values", () => {
    const objectStyle = stylePresetToObjectStyle(ChemDraftSyntheticStylePreset);
    const resolved = nativeDrawingStyleFromObjectStyle({
      ...objectStyle,
      bondStrokeWidthPx: 2.4,
      bondLineCap: "round",
      atomLabelPaddingPx: 3
    });

    expect(objectStyle).toMatchObject({
      stylePresetId: "chemdraft.synthetic",
      bondLengthPx: DefaultNativeDrawingStyle.bondLengthPx
    });
    expect(resolved).toMatchObject({
      stylePresetId: "chemdraft.synthetic",
      bondLengthPx: DefaultNativeDrawingStyle.bondLengthPx,
      bondStrokeWidthPx: 2.4,
      bondLineCap: "round",
      doubleBondInsetPx: DefaultNativeDrawingStyle.doubleBondInsetPx,
      bondOverlapClearancePx: DefaultNativeDrawingStyle.bondOverlapClearancePx,
      atomLabelPaddingPx: 3
    });
    expect(nativeDrawingStyleFromObjectStyle({ bondLengthPx: -1, atomLabelFontFamily: "" })).toMatchObject({
      bondLengthPx: DefaultNativeDrawingStyle.bondLengthPx,
      atomLabelFontFamily: DefaultNativeDrawingStyle.atomLabelFontFamily
    });
  });

  it("resolves native text style metadata for document text objects", () => {
    const objectStyle = textStyleToObjectStyle({
      fontFamily: "Times New Roman, Times, serif",
      fontSizePx: 24,
      color: "#b3261e",
      textAlign: "center",
      fontWeight: 700
    });
    const resolved = nativeTextStyleFromObjectStyle({
      ...objectStyle,
      lineHeight: 1.5,
      letterSpacingPx: 0.8,
      fontStyle: "italic",
      textDecoration: "underline"
    });

    expect(objectStyle).toMatchObject({
      fontFamily: "Times New Roman, Times, serif",
      fontSizePx: 24,
      color: "#b3261e",
      textAlign: "center",
      fontWeight: 700
    });
    expect(resolved).toMatchObject({
      fontFamily: "Times New Roman, Times, serif",
      fontSizePx: 24,
      color: "#b3261e",
      lineHeight: 1.5,
      letterSpacingPx: 0.8,
      textAlign: "center",
      fontWeight: 700,
      fontStyle: "italic",
      textDecoration: "underline"
    });
    expect(nativeTextStyleFromObjectStyle({ fontSizePx: -1, textAlign: "sideways" })).toMatchObject({
      fontSizePx: DefaultNativeTextStyle.fontSizePx,
      textAlign: DefaultNativeTextStyle.textAlign
    });
  });
});

describe("native document validation and serialization", () => {
  it("round-trips a valid native document through JSON", () => {
    const document = createEmptyDocument({ id: "doc_roundtrip", now: timestamp });
    const withMolecule = applyPatch(
      document,
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(deserializeDocument(serializeDocument(withMolecule))).toEqual(withMolecule);
  });

  it("accepts optional molecule bond display metadata", () => {
    const molecule = {
      ...moleculeObject(),
      atoms: [
        { id: "atom_001", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 22, y: 0, formalCharge: 0 }
      ],
      bonds: [
        {
          id: "bond_001",
          fromAtomId: "atom_001",
          toAtomId: "atom_002",
          order: "double",
          display: { doubleBondSide: "right", bondStyle: "dashed" }
        }
      ]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      { op: "addObject", pageId: "page_001", object: molecule },
      { now: timestamp }
    );

    expect(deserializeDocument(serializeDocument(document)).pages[0].objects[0]).toMatchObject({
      bonds: [{ id: "bond_001", display: { doubleBondSide: "right", bondStyle: "dashed" } }]
    });
  });

  it("accepts optional molecule atom depth metadata", () => {
    const molecule = {
      ...moleculeObject(),
      atoms: [
        { id: "atom_001", element: "C", x: 0, y: 0, z: 12.5, formalCharge: 0 },
        { id: "atom_002", element: "C", x: 22, y: 0, z: -3.25, formalCharge: 0 }
      ],
      bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }]
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      { op: "addObject", pageId: "page_001", object: molecule },
      { now: timestamp }
    );

    expect(deserializeDocument(serializeDocument(document)).pages[0].objects[0]).toMatchObject({
      atoms: [
        { id: "atom_001", z: 12.5 },
        { id: "atom_002", z: -3.25 }
      ]
    });
  });

  it("accepts optional molecule transform state metadata", () => {
    const molecule = {
      ...moleculeObject(),
      transform: {
        scaleX: 2,
        scaleY: 0.75,
        rotationDegrees: 45,
        tiltXDegrees: 40,
        tiltYDegrees: -15
      }
    } satisfies MoleculeObject;
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      { op: "addObject", pageId: "page_001", object: molecule },
      { now: timestamp }
    );

    expect(deserializeDocument(serializeDocument(document)).pages[0].objects[0]).toMatchObject({
      transform: {
        scaleX: 2,
        scaleY: 0.75,
        rotationDegrees: 45,
        tiltXDegrees: 40,
        tiltYDegrees: -15
      }
    });
  });

  it("formalizes native graphic style and data fields", () => {
    const graphic = {
      id: "graphic_contract",
      type: "graphic",
      x: 100,
      y: 120,
      width: 72,
      height: 40,
      rotation: 15,
      graphicKind: "rect",
      style: {
        strokeColor: "#1d7f68",
        strokePaint: {
          kind: "solid",
          color: "#1d7f68",
          opacity: 0.8
        },
        fillColor: "#f8faf9",
        fillPaint: {
          kind: "linear-gradient",
          units: "object",
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
          stops: [
            { offset: 0, color: "#ffffff", opacity: 0.9 },
            { offset: 1, color: "#1d7f68", opacity: 0.4 }
          ]
        },
        opacity: 0.75,
        fillOpacity: 0.6,
        strokeOpacity: 0.8,
        strokeWidth: 2,
        strokeDasharray: "3 4",
        strokeLineCap: "round",
        strokeLineJoin: "bevel",
        strokeMiterLimit: 3,
        fillMode: "gloss",
        effect: "shadow",
        tiltXDegrees: 12,
        tiltYDegrees: -8,
        artToolCommandId: "tool.art.roundedRectGloss"
      },
      data: {
        cornerRadiusPx: 7,
        artPathKind: "arc",
        arcCenter: { x: 136, y: 140 },
        arcRadiusX: 32,
        arcRadiusY: 24,
        arcStartRadians: -5 * Math.PI / 4,
        arcSweepRadians: Math.PI,
        lineStart: { x: 100, y: 160 },
        pathControlPoint: { x: 136, y: 104 },
        lineEnd: { x: 172, y: 160 },
        artToolId: "roundedRectGloss"
      }
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      { op: "addObject", pageId: "page_001", object: graphic },
      { now: timestamp }
    );

    expect(deserializeDocument(serializeDocument(document)).pages[0].objects[0]).toMatchObject({
      type: "graphic",
      style: {
        strokeColor: "#1d7f68",
        strokePaint: {
          kind: "solid",
          color: "#1d7f68",
          opacity: 0.8
        },
        fillPaint: {
          kind: "linear-gradient",
          stops: [
            { offset: 0, color: "#ffffff", opacity: 0.9 },
            { offset: 1, color: "#1d7f68", opacity: 0.4 }
          ]
        },
        opacity: 0.75,
        strokeLineCap: "round",
        strokeLineJoin: "bevel",
        fillMode: "gloss",
        effect: "shadow",
        tiltXDegrees: 12,
        tiltYDegrees: -8
      },
      data: {
        cornerRadiusPx: 7,
        arcCenter: { x: 136, y: 140 },
        arcRadiusX: 32,
        arcRadiusY: 24,
        arcStartRadians: -5 * Math.PI / 4,
        arcSweepRadians: Math.PI,
        pathControlPoint: { x: 136, y: 104 }
      }
    });
  });

  it("round-trips signed semantic arc sweep metadata", () => {
    const graphic = {
      id: "graphic_signed_arc",
      type: "graphic",
      x: 100,
      y: 120,
      width: 72,
      height: 72,
      rotation: 0,
      graphicKind: "path",
      style: {},
      data: {
        artPathKind: "arc",
        arcCenter: { x: 136, y: 156 },
        arcRadiusX: 32,
        arcRadiusY: 32,
        arcStartRadians: Math.PI / 2,
        arcSweepRadians: -Math.PI / 2
      }
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      { op: "addObject", pageId: "page_001", object: graphic },
      { now: timestamp }
    );

    const reopenedGraphic = deserializeDocument(serializeDocument(document)).pages[0].objects[0] as GraphicObject;

    expect(reopenedGraphic.data.artPathKind).toBe("arc");
    expect(reopenedGraphic.data.arcSweepRadians).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("migrates branch-era graphic arc degree metadata to radians", () => {
    const graphic = {
      id: "graphic_legacy_arc",
      type: "graphic",
      x: 100,
      y: 120,
      width: 72,
      height: 40,
      rotation: 15,
      graphicKind: "path",
      style: {},
      data: {
        artPathKind: "arc",
        arcStartRadians: -5 * Math.PI / 4,
        arcSweepRadians: Math.PI
      }
    } satisfies GraphicObject;
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      { op: "addObject", pageId: "page_001", object: graphic },
      { now: timestamp }
    );
    const legacy = JSON.parse(serializeDocument(document)) as {
      pages: Array<{ objects: Array<{ data: Record<string, unknown> }> }>;
    };
    const data = legacy.pages[0].objects[0].data;
    data.arcStartDegrees = -225;
    data.arcAngleDegrees = 180;
    delete data.arcStartRadians;
    delete data.arcSweepRadians;

    const migratedGraphic = deserializeDocument(JSON.stringify(legacy)).pages[0].objects[0] as GraphicObject;

    expect(migratedGraphic.data.arcStartRadians).toBeCloseTo(-5 * Math.PI / 4, 6);
    expect(migratedGraphic.data.arcSweepRadians).toBeCloseTo(Math.PI, 6);
    expect(migratedGraphic.data).not.toHaveProperty("arcStartDegrees");
    expect(migratedGraphic.data).not.toHaveProperty("arcAngleDegrees");
  });

  it("reports validation issues for unsupported object shapes", () => {
    const document = createEmptyDocument({ now: timestamp });
    const result = validateDocument({
      ...document,
      pages: [
        {
          ...document.pages[0],
          objects: [{ id: "bad_001", type: "unsupported" }]
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toContain("pages.0.objects.0.type");
  });
});

describe("document patches", () => {
  it("adds, moves, updates, batches, and removes objects without mutating the original", () => {
    const document = createEmptyDocument({ now: timestamp });
    const added = applyPatch(
      document,
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(document.pages[0].objects).toEqual([]);
    expect(added.pages[0].objects).toHaveLength(1);

    const moved = applyPatch(added, { op: "moveObject", objectId: "mol_001", x: 200, y: 240 }, { now: timestamp });
    expect(moved.pages[0].objects[0]).toMatchObject({ x: 200, y: 240 });

    const selected = applyPatch(
      moved,
      { op: "setSelection", pageId: "page_001", objectIds: ["mol_001"] },
      { now: timestamp }
    );
    expect(selected.selection).toEqual({ pageId: "page_001", objectIds: ["mol_001"] });

    const updated = applyPatch(
      selected,
      { op: "updateObject", objectId: "mol_001", changes: { structure: "CCO" } },
      { now: timestamp }
    );
    expect(updated.pages[0].objects[0]).toMatchObject({ structure: "CCO" });

    const removed = applyPatches(
      updated,
      [
        { op: "addAnnotation", pageId: "page_001", annotation: annotationObject() },
        { op: "removeObject", objectId: "mol_001" }
      ],
      { now: timestamp }
    );
    expect(removed.pages[0].objects).toEqual([annotationObject()]);
  });

  it("rejects duplicate object IDs and identity-changing updates", () => {
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(() =>
      applyPatch(document, {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      })
    ).toThrow(DocumentPatchError);

    expect(() =>
      applyPatch(document, {
        op: "updateObject",
        objectId: "mol_001",
        changes: { id: "mol_002" }
      })
    ).toThrow(DocumentPatchError);

    expect(() =>
      applyPatch(document, {
        op: "setSelection",
        pageId: "page_001",
        objectIds: ["mol_missing"]
      })
    ).toThrow(DocumentPatchError);
  });

  it("reorders objects without changing selection or object payloads", () => {
    const document = applyPatches(
      createEmptyDocument({ now: timestamp }),
      [
        { op: "addObject", pageId: "page_001", object: moleculeObject("mol_back") },
        { op: "addObject", pageId: "page_001", object: moleculeObject("mol_middle") },
        { op: "addObject", pageId: "page_001", object: moleculeObject("mol_front") },
        { op: "setSelection", pageId: "page_001", objectIds: ["mol_middle"] }
      ],
      { now: timestamp }
    );
    const selectedPayload = document.pages[0].objects[1];
    const forward = applyPatch(
      document,
      { op: "reorderObject", objectId: "mol_middle", placement: "forward" },
      { now: timestamp }
    );
    const back = applyPatch(
      forward,
      { op: "reorderObject", objectId: "mol_middle", placement: "back" },
      { now: timestamp }
    );
    const front = applyPatch(
      back,
      { op: "reorderObject", objectId: "mol_middle", placement: "front" },
      { now: timestamp }
    );
    const backward = applyPatch(
      front,
      { op: "reorderObject", objectId: "mol_middle", placement: "backward" },
      { now: timestamp }
    );

    expect(forward.pages[0].objects.map((object) => object.id)).toEqual(["mol_back", "mol_front", "mol_middle"]);
    expect(back.pages[0].objects.map((object) => object.id)).toEqual(["mol_middle", "mol_back", "mol_front"]);
    expect(front.pages[0].objects.map((object) => object.id)).toEqual(["mol_back", "mol_front", "mol_middle"]);
    expect(backward.pages[0].objects.map((object) => object.id)).toEqual(["mol_back", "mol_middle", "mol_front"]);
    expect(backward.pages[0].objects[1]).toEqual(selectedPayload);
    expect(backward.selection).toEqual({ pageId: "page_001", objectIds: ["mol_middle"] });
  });

  it("only removes annotations through removeAnnotation", () => {
    const document = applyPatch(
      createEmptyDocument({ now: timestamp }),
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(() => applyPatch(document, { op: "removeAnnotation", annotationId: "mol_001" })).toThrow(
      DocumentPatchError
    );
  });
});

describe("document history", () => {
  it("supports undo and redo around controlled patches", () => {
    const document = createEmptyDocument({ now: timestamp });
    const history = createDocumentHistory(document);
    const withPatch = applyPatchWithHistory(
      history,
      {
        op: "addObject",
        pageId: "page_001",
        object: moleculeObject()
      },
      { now: timestamp }
    );

    expect(withPatch.present.pages[0].objects).toHaveLength(1);

    const undone = undo(withPatch);
    expect(undone.present.pages[0].objects).toHaveLength(0);

    const redone = redo(undone);
    expect(redone.present.pages[0].objects).toHaveLength(1);
  });
});
