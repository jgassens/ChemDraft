import { describe, expect, it } from "vitest";
import { createEmptyDocument, DOCUMENT_STYLE_UNITS_PER_PT, DocumentStylePreset, DocumentTextStyle,
  stylePresetToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { DocumentStyleScale, nativeMultipleBondGapPx, planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

describe("document physical style", () => {
  it("uses one point scale for every dimension and the native renderer's percent gap", () => {
    const drawing = DocumentStylePreset.drawing;
    const pt = DocumentStyleScale.pointsPerUnit;
    expect(drawing.bondLengthPx).toBe(22);
    expect(drawing.bondLengthPx * pt).toBe(14.4);
    expect(drawing.bondStrokeWidthPx * pt).toBe(1.134);
    expect(drawing.bondBoldWidthPx * pt).toBe(2.268);
    expect(nativeMultipleBondGapPx(drawing) * pt).toBeCloseTo(14.4 * 0.18, 10);
    expect(drawing.bondHashSpacingPx * pt).toBe(2.5);
    expect(drawing.bondMarginWidthPx * pt).toBe(1.6);
    expect(drawing.chainAngleDegrees).toBe(120);
    expect(drawing.atomLabelFontFamily.split(",")[0]).toBe("Arial");
    expect(drawing.atomLabelFontSizePx * pt).toBe(10);
    expect(DocumentTextStyle.fontSizePx).toBe(drawing.atomLabelFontSizePx);
    expect(DocumentStyleScale.pointsPerUnit * DOCUMENT_STYLE_UNITS_PER_PT).toBeCloseTo(1, 12);
    expect(DocumentStyleScale.marginPt).toBe(4);
  });

  it("draws the specified broad wedge end through the canvas's shared render plan", () => {
    const document = createEmptyDocument();
    const molecule: MoleculeObject = {
      id: "wedge", type: "molecule", x: 100, y: 100, width: 22, height: 1, rotation: 0,
      style: stylePresetToObjectStyle(DocumentStylePreset),
      compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
      structureFormat: "smiles", structure: "CC",
      superatoms: [], rGroups: [],
      atoms: [{ id: "a", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "b", element: "C", x: 122, y: 100, formalCharge: 0 }],
      bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single", display: { bondStyle: "wedge" } }]
    };
    document.pages[0]!.objects = [molecule];
    const wedge = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments)
      .find((fragment) => fragment.tag === "polygon" && fragment.attrs["data-bond-id"] === "ab")!;
    const points = String(wedge.attrs.points).split(/\s+/).map((point) => point.split(",").map(Number));
    const width = Math.hypot(points[1]![0]! - points[2]![0]!, points[1]![1]! - points[2]![1]!);
    expect(width * DocumentStyleScale.pointsPerUnit).toBeCloseTo(2.268, 2);
  });
});
