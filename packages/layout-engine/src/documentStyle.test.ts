import { describe, expect, it } from "vitest";
import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, stylePresetToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { DocumentStylePreset, DocumentStyleScale, DocumentTextStyle, nativeMultipleBondGapPx, planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

describe("document physical style", () => {
  it("uses one point scale for every dimension and the native renderer's percent gap", () => {
    const drawing = nativeDrawingStyleFromObjectStyle(stylePresetToObjectStyle(DocumentStylePreset));
    const pt = DocumentStyleScale.pointsPerUnit;
    expect(drawing.bondLengthPx).toBe(22);
    expect(drawing.bondLengthPx * pt).toBeCloseTo(14.4, 10);
    expect(drawing.bondStrokeWidthPx * pt).toBeCloseTo(1.134, 10);
    expect(drawing.bondBoldWidthPx * pt).toBeCloseTo(2.268, 10);
    expect(nativeMultipleBondGapPx(drawing) * pt).toBeCloseTo(14.4 * 0.18, 10);
    expect(drawing.bondHashSpacingPx * pt).toBeCloseTo(2.5, 10);
    expect(drawing.bondMarginWidthPx * pt).toBeCloseTo(1.6, 10);
    expect(drawing.chainAngleDegrees).toBe(120);
    expect(drawing.atomLabelFontFamily).toBe("Arial");
    expect(drawing.atomLabelFontSizePx * pt).toBeCloseTo(10, 10);
    expect(DocumentTextStyle.fontSizePx).toBe(drawing.atomLabelFontSizePx);
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
