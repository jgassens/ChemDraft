import { describe, expect, it } from "vitest";
import { Acs1996StylePreset, RscJournalStylePreset, createEmptyDocument,
  stylePresetToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeMultipleBondGapPx, planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

describe.each([Acs1996StylePreset, RscJournalStylePreset])("$name geometry", preset => {
  function render(bondStyle: "wedge" | "hashed" | undefined, order: "single" | "double" = "single") {
    const document = createEmptyDocument();
    const molecule: MoleculeObject = {
      id: "m", type: "molecule", x: 100, y: 100, width: preset.drawing.bondLengthPx, height: 10, rotation: 0,
      style: stylePresetToObjectStyle(preset), structure: "CC", structureFormat: "smiles", superatoms: [], rGroups: [],
      atoms: [{ id: "a", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "b", element: "C", x: 100 + preset.drawing.bondLengthPx, y: 100, formalCharge: 0 }],
      bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order,
        display: { ...(bondStyle ? { bondStyle } : {}), ...(order === "double" ? { doubleBondSide: "center" as const } : {}) } }]
    };
    document.pages[0]!.objects = [molecule];
    return planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
  }

  it("draws the broad wedge end at the explicit publisher bold width", () => {
    const wedge = render("wedge").find(fragment => fragment.tag === "polygon" && fragment.attrs["data-bond-id"] === "ab")!;
    const points = String(wedge.attrs.points).split(/\s+/).map(point => point.split(",").map(Number));
    expect(Math.hypot(points[1]![0]! - points[2]![0]!, points[1]![1]! - points[2]![1]!))
      .toBeCloseTo(preset.drawing.bondBoldWidthPx, 2);
  });

  it("uses the explicit broad width and the sourced spacing for hashed wedges", () => {
    const hashes = render("hashed").filter(fragment => fragment.tag === "line" && fragment.attrs.class === "native-bond-hash");
    const lengths = hashes.map(({ attrs }) => Math.hypot(Number(attrs.x2) - Number(attrs.x1), Number(attrs.y2) - Number(attrs.y1)));
    expect(hashes).toHaveLength(Math.round(preset.drawing.bondLengthPx / preset.drawing.bondHashSpacingPx));
    expect(lengths.at(-1)).toBeCloseTo(preset.drawing.bondBoldWidthPx, 2);
    expect(lengths[0]).toBeLessThan(lengths.at(-1)!);
    for (const hash of hashes) expect(Number(hash.attrs["stroke-width"])).toBeCloseTo(preset.drawing.bondStrokeWidthPx, 2);
  });

  it("renders the percent double-bond gap through the shared page plan", () => {
    const lines = render(undefined, "double").filter(fragment => fragment.tag === "line" && fragment.attrs["data-bond-id"] === "ab"
      && String(fragment.attrs.class).split(" ").includes("native-bond-line"));
    expect(lines).toHaveLength(2);
    const gap = Math.abs(Number(lines[0]!.attrs.y1) - Number(lines[1]!.attrs.y1));
    expect(gap).toBeCloseTo(preset.drawing.bondLengthPx * preset.drawing.bondSpacingPercent / 100, 2);
    expect(gap).toBeCloseTo(nativeMultipleBondGapPx(preset.drawing), 2);
  });
});
