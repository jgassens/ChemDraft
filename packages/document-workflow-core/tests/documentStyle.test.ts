import { describe, expect, it } from "vitest";
import { ChemDraftDocumentSchema, createEmptyDocument, type CompatibilityWarning, type MoleculeObject } from "@chemdraft/chem-core";
import { DocumentMoleculeSizeStyle, DocumentStyleScale, planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { applyDocumentStyle } from "../src/documentStyle";
import { createNativeReactionArrow } from "../src/reactionArrows";

function molecule(id = "m", length = 28): MoleculeObject {
  return { id, type: "molecule", x: 100, y: 100, width: length, height: 20, rotation: 0,
    structure: "CC", structureFormat: "smiles", style: {}, superatoms: [], rGroups: [],
    atoms: [{ id: "a", element: "C", x: 100, y: 110, formalCharge: 0 },
      { id: "b", element: "C", x: 100 + length, y: 110, formalCharge: 0 }],
    bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" }] };
}

describe("applyDocumentStyle", () => {
  it("selects the explicit physical wedge width without replacing its colour", () => {
    const document = createEmptyDocument(), mol = molecule();
    mol.bonds[0]!.display = { bondStyle: "wedge" };
    mol.style.bondColor = "#ff0000";
    document.pages[0]!.objects = [mol];
    const styled = applyDocumentStyle(document);
    const wedge = planPageSvgRender(styled.pages[0]!).fragments.flatMap(elementFragments)
      .find((fragment) => fragment.tag === "polygon" && fragment.attrs["data-bond-id"] === "ab")!;
    const points = String(wedge.attrs.points).split(/\s+/).map((point) => point.split(",").map(Number));
    expect(Math.hypot(points[1]![0]! - points[2]![0]!, points[1]![1]! - points[2]![1]!) * DocumentStyleScale.pointsPerUnit)
      .toBeCloseTo(2.268, 2);
    expect(wedge.attrs.fill).toBe("#ff0000");
  });
  it("scales pixel overrides while preserving colours and dimensionless styling", () => {
    const document = createEmptyDocument(), mol = molecule("m", 44);
    mol.style = { bondColor: "#ff0000", atomLabelColor: "#00ff00", atomLabelBackgroundColor: "transparent",
      stylePresetId: "custom", atomLabelHideImplicitHydrogens: true, atomIndicatorShowAtomNumbers: true,
      bondIndicatorShowReaction: false, atomLabelFontWeight: 700, bondLineCap: "round",
      bondColors: { ab: "#112233" }, atomLabelColors: { a: "blue" },
      bondLengths: { ab: 44 }, bondStrokeWidths: { ab: 4 }, bondBoldWidths: { ab: 8 },
      bondMultipleBondGaps: { ab: 6 }, bondDoubleBondInsets: { ab: 2 },
      bondMarginWidths: { ab: 10 }, bondHashSpacings: { ab: 12 }, bondOverlapClearances: { ab: 14 },
      atomLabelFontSizes: { a: 20 }, atomLabelPaddings: { a: 4 }, atomLabelBondClearances: { a: 6 },
      bondSpacingPercents: { ab: 18 }, atomLabelFontWeights: { a: 700 },
      atomLabelPaddingPx: 4, atomLabelBondClearancePx: 6, bondOverlapClearancePx: 8,
      visualEffects: [{ kind: "shadow", color: "red", opacity: 0.5, offsetX: 4, offsetY: -6, blurPx: 8, spreadPx: 2 },
        { kind: "sketch", strokeWidth: 4, roughness: 1.5, bowing: 0.8, seed: 7 }],
      atomLabelFontFamilies: { a: "Courier" }, bondStrokeWidthPx: 3, atomLabelFontSizePx: 20 };
    const original = structuredClone(mol);
    document.pages[0]!.objects = [mol];
    const styled = applyDocumentStyle(document).pages[0]!.objects[0]!;
    if (styled.type !== "molecule") throw new Error("fixture type");
    const scaledOverrides = {
      bondLengths: { ab: 22 }, bondStrokeWidths: { ab: 2 }, bondBoldWidths: { ab: 4 },
      bondMultipleBondGaps: { ab: 3 }, bondDoubleBondInsets: { ab: 1 },
      bondMarginWidths: { ab: 5 }, bondHashSpacings: { ab: 6 }, bondOverlapClearances: { ab: 7 },
      atomLabelFontSizes: { a: 10 }, atomLabelPaddings: { a: 2 }, atomLabelBondClearances: { a: 3 },
      atomLabelPaddingPx: 2, atomLabelBondClearancePx: 3, bondOverlapClearancePx: 4,
      visualEffects: [{ kind: "shadow", color: "red", opacity: 0.5, offsetX: 2, offsetY: -3, blurPx: 4, spreadPx: 1 },
        { kind: "sketch", strokeWidth: 2, roughness: 1.5, bowing: 0.8, seed: 7 }]
    };
    expect(styled.style).toEqual({ ...original.style, ...scaledOverrides, ...DocumentMoleculeSizeStyle });
    for (const [key, value] of Object.entries(original.style)) {
      if (!(key in DocumentMoleculeSizeStyle) && !(key in scaledOverrides)) expect(styled.style[key]).toEqual(value);
    }
    expect(mol).toEqual(original);
  });

  it("renders a 4-unit bond stroke at 2 units when 44-unit bonds scale to 22", () => {
    const document = createEmptyDocument(), mol = molecule("m", 44);
    mol.bonds[0]!.id = "b";
    mol.style.bondStrokeWidths = { b: 4 };
    document.pages[0]!.objects = [mol];
    const page = applyDocumentStyle(document).pages[0]!;
    const bond = planPageSvgRender(page).fragments.flatMap(elementFragments)
      .find((fragment) => String(fragment.attrs.class).includes("native-bond-line") && fragment.attrs["data-bond-id"] === "b")!;
    expect(Number(bond.attrs["stroke-width"])).toBe(2);
    const styled = page.objects[0]!;
    if (styled.type !== "molecule") throw new Error("fixture type");
    expect(styled.atoms[1]!.x - styled.atoms[0]!.x).toBe(22);
  });

  it("scales all page geometry together while keeping explicit text sizes and chemistry", () => {
    const document = createEmptyDocument(), page = document.pages[0]!, mol = molecule();
    page.objects = [mol, createNativeReactionArrow(document, { x: 128, y: 110 }, { x: 200, y: 110 }, "forward"),
      { id: "caption", type: "text", x: 100, y: 150, width: 100, height: 20, rotation: 20,
        text: "caption", spans: [{ text: "caption", script: "normal", style: { fontSizePx: 12 } }], style: {} },
      { id: "explicit", type: "text", x: 200, y: 150, width: 100, height: 20, rotation: 0,
        text: "explicit", spans: [], style: { fontSizePx: 30, color: "red" } },
      { id: "highlight", type: "graphic", x: 90, y: 90, width: 48, height: 40, rotation: 0,
        graphicKind: "rect", style: { fillColor: "yellow", strokeWidth: 5 }, data: { cornerRadiusPx: 5 } },
      { id: "curve", type: "graphic", x: 128, y: 80, width: 100, height: 30, rotation: 0,
        graphicKind: "path", style: {}, data: { artPathKind: "bezier", pathNodes: [
          { point: { x: 128, y: 80 }, outControl: { x: 140, y: 90 } },
          { point: { x: 228, y: 110 }, inControl: { x: 210, y: 90 } }],
          pathD: "M0 0 C10 20 30 40 50 60", arcCenter: { x: 150, y: 100 }, arcRadiusX: 20, arcRadiusY: 10 } },
      { id: "mechanism", type: "mechanism-arrow", x: 128, y: 80, width: 100, height: 30, rotation: 0,
        style: {}, arrowKind: "full-headed", source: { kind: "point", point: { x: 128, y: 80 } },
        target: { kind: "point", point: { x: 228, y: 110 } }, controlPoints: [{ x: 180, y: 50 }], warnings: [] }];
    document.pages.push({ ...page, id: "second", objects: [molecule("second", 40)] });
    const original = structuredClone(document), scale = 22 / 28;
    const result = applyDocumentStyle(document), scaled = result.pages[0]!;
    expect(ChemDraftDocumentSchema.safeParse(result).success).toBe(true);
    expect(result.pages[1]).toBe(document.pages[1]);
    expect(document).toEqual(original);
    expect(scaled.width).toBeCloseTo(page.width * scale);
    expect(scaled.height).toBeCloseTo(page.height * scale);
    expect(scaled.layout.widthPx).toBe(scaled.width);
    for (const [index, object] of scaled.objects.entries()) {
      const source = page.objects[index]!;
      for (const key of ["x", "y", "width", "height"] as const) expect(object[key]).toBeCloseTo(source[key] * scale);
      expect(object.rotation).toBe(source.rotation);
    }
    const [newMol, arrow, caption, explicit, highlight, curve, mechanism] = scaled.objects;
    if (newMol?.type !== "molecule" || arrow?.type !== "reaction-arrow" || caption?.type !== "text" ||
      explicit?.type !== "text" || highlight?.type !== "graphic" || curve?.type !== "graphic" || mechanism?.type !== "mechanism-arrow") throw new Error("fixture types");
    expect(newMol.atoms[1]!.x - newMol.atoms[0]!.x).toBeCloseTo(22);
    expect(newMol.bonds).toEqual(mol.bonds);
    expect(arrow.start.point!.x).toBeCloseTo(newMol.x + newMol.width);
    expect(caption.y - newMol.y).toBeCloseTo(50 * scale);
    expect(caption.style.fontSizePx as number * DocumentStyleScale.pointsPerUnit).toBeCloseTo(10);
    expect((caption.spans[0]!.style.fontSizePx as number)).toBeCloseTo(12 * scale);
    expect(explicit.style.fontSizePx).toBeCloseTo(30 * scale);
    expect(explicit.style.color).toBe("red");
    expect(highlight.data.cornerRadiusPx).toBeCloseTo(5 * scale);
    expect(highlight.style.fillColor).toBe("yellow");
    expect(arrow.style.strokeWidth as number * DocumentStyleScale.pointsPerUnit).toBeCloseTo(1.134);
    expect(highlight.style.strokeWidth).toBeCloseTo(5 * scale);
    expect(curve.style.strokeWidth! * DocumentStyleScale.pointsPerUnit).toBeCloseTo(1.134);
    expect(curve.data.pathNodes![0]!.outControl!.x).toBeCloseTo(140 * scale);
    expect(curve.data.arcCenter!.x).toBeCloseTo(150 * scale);
    expect(curve.data.arcRadiusX).toBeCloseTo(20 * scale);
    const pathCoordinates = curve.data.pathD!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(pathCoordinates).toHaveLength(8);
    for (const [index, value] of [0, 0, 10, 20, 30, 40, 50, 60].entries()) {
      expect(pathCoordinates[index]).toBeCloseTo(value * scale, 5);
    }
    expect(mechanism.controlPoints[0]!.x).toBeCloseTo(180 * scale);
    expect(mechanism.style.strokeWidth as number * DocumentStyleScale.pointsPerUnit).toBeCloseTo(1.134);
  });

  it("scales authored graphic strokes, defaults absent strokes, and leaves image styles untouched", () => {
    const document = createEmptyDocument();
    const graphics = (["rect", "ellipse", "path", "image"] as const).flatMap((graphicKind) =>
      [undefined, 8].map((strokeWidth) => ({
        id: `${graphicKind}-${strokeWidth}`, type: "graphic" as const, graphicKind,
        x: 10, y: 20, width: 80, height: 40, rotation: 0, data: {},
        style: { fillColor: "yellow", ...(strokeWidth === undefined ? {} : { strokeWidth }) }
      })));
    document.pages[0]!.objects = [molecule("m", 44), ...graphics];
    const original = structuredClone(document);
    const result = applyDocumentStyle(document);
    for (const [index, source] of graphics.entries()) {
      const graphic = result.pages[0]!.objects[index + 1]!;
      expect(graphic.style).toEqual(source.graphicKind === "image" ? source.style : {
        ...source.style, strokeWidth: source.style.strokeWidth === undefined
          ? DocumentMoleculeSizeStyle.bondStrokeWidthPx : 4
      });
      expect(graphic.width).toBe(40);
    }
    expect(document).toEqual(original);
  });

  it("uses the median of molecule medians and warns only above 2% without distorting layout", () => {
    const document = createEmptyDocument();
    document.pages[0]!.objects = [molecule("a", 28), molecule("b", 55.99999999999997)];
    const warnings: CompatibilityWarning[] = [];
    const result = applyDocumentStyle(document, warnings);
    expect(warnings).toEqual([expect.objectContaining({ code: "document_style.mixed_bond_lengths",
      message: expect.stringMatching(/median across molecules \(42 native units\)/) })]);
    const lengths = result.pages[0]!.objects.map((object) => object.width);
    expect(lengths[1]! / lengths[0]!).toBeCloseTo(2);
    document.pages[0]!.objects = [molecule("a", 28), molecule("b", 56.2468)];
    const decimalWarnings: CompatibilityWarning[] = [];
    applyDocumentStyle(document, decimalWarnings);
    expect(decimalWarnings[0]!.message).toContain("(42.12 native units)");
    document.pages[0]!.objects = [molecule("a", 28), molecule("b", 28.5)];
    const similarWarnings: CompatibilityWarning[] = [];
    applyDocumentStyle(document, similarWarnings);
    expect(similarWarnings).toEqual([]);
  });
});
