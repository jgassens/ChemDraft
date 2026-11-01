import { describe, expect, it } from "vitest";
import { applyPatch, ChemDraftSyntheticStylePreset, nativeDrawingStyleFromObjectStyle, stylePresetToObjectStyle, type ChemDraftDocument } from "@chemdraft/chem-core";
import { planPageSvgRender, type PageSvgElementFragment } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { createNativeSingleBondMolecule, createPhase4Document, resizeNativeMoleculeObject } from "./documentWorkflow";

function fixture(mode: "default" | "percent") {
  const empty = createPhase4Document("Resize rendering");
  const seed = createNativeSingleBondMolecule(empty);
  const molecule = {
    ...seed,
    // Equal, separate carbon bonds avoid label clipping and junction miters.
    atoms: [0, 1, 2, 3, 4, 5].map((index) => ({
      id: `a${index}`, element: "C", formalCharge: 0,
      x: 100 + (index % 2) * 40, y: 100 + Math.floor(index / 2) * 60
    })),
    bonds: [
      { id: "wedge", fromAtomId: "a0", toAtomId: "a1", order: "single" as const, display: { bondStyle: "wedge" as const } },
      { id: "hash", fromAtomId: "a2", toAtomId: "a3", order: "single" as const, display: { bondStyle: "hashed" as const } },
      { id: "double", fromAtomId: "a4", toAtomId: "a5", order: "double" as const }
    ],
    style: mode === "percent"
      ? { ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset), bondLengthPx: 40, bondSpacingMode: "percent", bondSpacingPercent: 18, bondStrokeWidthPx: 1, bondBoldWidthPx: 1, bondHashSpacingPx: 5 }
      : { ...seed.style, bondLengthPx: 40 }
  };
  return { document: applyPatch(empty, { op: "addObject", pageId: empty.pages[0].id, object: molecule }), molecule };
}

function render(document: ChemDraftDocument) {
  const fragments = planPageSvgRender(document.pages[0]).fragments.flatMap(elementFragments);
  const wedge = fragments.find((f) => f.attrs["data-bond-id"] === "wedge" && f.tag === "polygon")!;
  const points = String(wedge.attrs.points).split(/\s+/).map((point) => point.split(",").map(Number));
  const wide = Math.hypot(points[1]![0]! - points[2]![0]!, points[1]![1]! - points[2]![1]!);
  const lines = fragments.filter((f) => f.attrs["data-bond-id"] === "double" && f.tag === "line" && String(f.attrs.class).includes("native-bond-line"));
  expect(lines).toHaveLength(2);
  const midpoint = (line: PageSvgElementFragment) => ({ x: (Number(line.attrs.x1) + Number(line.attrs.x2)) / 2, y: (Number(line.attrs.y1) + Number(line.attrs.y2)) / 2 });
  const [a, b] = lines.map(midpoint);
  return {
    wide,
    gap: Math.hypot(a!.x - b!.x, a!.y - b!.y),
    stroke: Number(lines[0]!.attrs["stroke-width"]),
    hashes: fragments.filter((f) => f.attrs.class === "native-bond-hash").length
  };
}

function expectedHashes(length: number, spacing: number, stroke: number) {
  const nominalLength = Math.max(Math.max(2, spacing), length);
  const nominalCount = Math.max(5, Math.round(nominalLength / Math.max(2, spacing)));
  const readable = Math.max(2, Math.floor(length / (stroke + Math.max(1, stroke))));
  return Math.max(2, Math.min(24, readable, Math.round(nominalCount * length / nominalLength)));
}

// Intended behavior change: a resized molecule renders like any molecule drawn at that size.
describe("resized molecule rendering", () => {
  it.each([2, 0.5])("scales wedge and percent spacing at %sx without scaling stroke", (scale) => {
    const { document, molecule } = fixture("percent");
    const before = render(document);
    const after = render(resizeNativeMoleculeObject(document, molecule.id, { x: scale, y: scale }));
    expect(after.wide / before.wide).toBeGreaterThan(scale * 0.98);
    expect(after.wide / before.wide).toBeLessThan(scale * 1.02);
    expect(after.gap / before.gap).toBeGreaterThan(scale * 0.98);
    expect(after.gap / before.gap).toBeLessThan(scale * 1.02);
    expect(before.hashes).toBe(expectedHashes(40, 5, before.stroke));
    expect(after.hashes).toBe(expectedHashes(40 * scale, 5, after.stroke));
    expect(after.stroke).toBe(before.stroke);
  });

  it.each([2, 0.5])("preserves the default preset's spacing behavior at %sx", (scale) => {
    const { document, molecule } = fixture("default");
    const style = nativeDrawingStyleFromObjectStyle(molecule.style);
    expect(style.bondSpacingMode).toBe("absolute");
    const before = render(document);
    const after = render(resizeNativeMoleculeObject(document, molecule.id, { x: scale, y: scale }));
    expect(after.gap / before.gap).toBeCloseTo(1, 2);
    expect(before.hashes).toBe(expectedHashes(40, style.bondHashSpacingPx, before.stroke));
    expect(after.hashes).toBe(expectedHashes(40 * scale, style.bondHashSpacingPx, after.stroke));
    expect(after.stroke).toBe(before.stroke);
  });
});
