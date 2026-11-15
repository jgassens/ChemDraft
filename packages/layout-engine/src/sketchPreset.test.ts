import { SketchStylePreset, createEmptyDocument, stylePresetToObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import * as artEngine from "@chemdraft/art-engine";
import { describe, expect, it, vi } from "vitest";
import { planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

function molecule(order: "single" | "double" | "triple", bondStyle?: "wedge" | "hashed"): MoleculeObject {
  const length = SketchStylePreset.drawing.bondLengthPx;
  return {
    id: "sketch", type: "molecule", x: 40, y: 40, width: length, height: 10, rotation: 0,
    style: stylePresetToObjectStyle(SketchStylePreset), structureFormat: "smiles", structure: "CC",
    superatoms: [], rGroups: [],
    atoms: [{ id: "a", element: "C", x: 40, y: 40, formalCharge: 0 },
      { id: "b", element: "C", x: 40 + length, y: 40, formalCharge: 0 }],
    bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order,
      display: { doubleBondSide: "center", ...(bondStyle ? { bondStyle } : {}) } }]
  };
}
const render = (object: MoleculeObject) => planPageSvgRender({ ...createEmptyDocument().pages[0]!, objects: [object] })
  .fragments.flatMap(elementFragments);
const sketch = (object: MoleculeObject) => render(object).filter(fragment => fragment.attrs.class === "native-molecule-sketch");

describe("Sketch preset bond geometry at roughness 1.25", () => {
  it.each([
    { name: "explicit bond", bondColor: "#123456", effectColor: "#654321", override: "#ab1234", expected: "#ab1234" },
    { name: "explicit black bond", override: "#000000", expected: "#000000" },
    { name: "Sketch effect", bondColor: "#123456", effectColor: "#654321", expected: "#654321" },
    { name: "black Sketch effect", effectColor: "#000000", expected: "#000000" },
    { name: "molecule bond", bondColor: "#123456", expected: "#123456" },
    { name: "default Sketch ink", expected: "#111111" }
  ])("uses the $name colour for rough ink without changing atom labels", ({ bondColor, effectColor, override, expected }) => {
    for (const bondStyle of [undefined, "wedge", "hashed"] as const) {
      const object = molecule("single", bondStyle);
      object.style = { ...object.style, ...(bondColor ? { bondColor } : {}),
        bondColors: override ? { ab: override } : {}, atomLabelColors: { b: "#267a38" },
        visualEffects: [{ kind: "sketch", roughness: 1.25, seed: 7, ...(effectColor ? { color: effectColor } : {}) }] };
      object.atoms[1]!.element = "N";
      const ink = sketch(object);
      expect(ink.length).toBeGreaterThan(0);
      expect(ink.every(mark => (mark.attrs.stroke === "none" ? mark.attrs.fill : mark.attrs.stroke) === expected)).toBe(true);
      expect(render(object).find(fragment => fragment.key === "label-sketch-b")?.attrs.fill).toBe("#267a38");
    }
  });

  it.each([undefined, "#654321"])("renders mismatched rough stroke counts with one resolved colour (effect %s)", effectColor => {
    const object = molecule("single");
    object.style = { ...object.style, bondColor: "#123456", bondColors: { ab: "#ab1234" },
      visualEffects: [{ kind: "sketch", ...(effectColor ? { color: effectColor } : {}) }] };
    object.atoms.push({ id: "c", element: "C", x: 100, y: 60, formalCharge: 0 });
    object.bonds.push({ id: "bc", fromAtomId: "b", toAtomId: "c", order: "single" });
    const original = artEngine.visualEffectPlansForStyle;
    const spy = vi.spyOn(artEngine, "visualEffectPlansForStyle").mockImplementation(input => {
      const effects = original(input);
      for (const effect of effects) {
        if (effect.kind === "sketch") effect.paths[0]!.d = "M 1 2 L 3 4";
      }
      return effects;
    });
    try {
      const ink = sketch(object);
      expect(ink).toHaveLength(1);
      expect(ink[0]!.attrs.d).toBe("M 1 2 L 3 4");
      expect(ink[0]!.attrs.stroke).toBe(effectColor ?? "#123456");
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["single", "double", "triple"] as const)("keeps the %s bond's separate parallel strokes", order => {
    const object = molecule(order);
    const count = { single: 1, double: 2, triple: 3 }[order];
    const lines = render(object).filter(fragment => fragment.attrs.class === "native-bond-hit-target");
    expect(lines).toHaveLength(count);
    expect(new Set(lines.map(line => line.attrs.y1)).size).toBe(count);
    const ink = sketch(object);
    expect(ink).toHaveLength(1);
    // Existing roughjs paired strokes for every source line, at the full preset roughness.
    expect(String(ink[0]!.attrs.d).match(/M/g)).toHaveLength(count * 2);
    expect(String(ink[0]!.attrs.d)).toContain("C");
    expect(sketch(structuredClone(object))).toEqual(ink);
    const clean = structuredClone(object); clean.style.visualEffects = [];
    expect(sketch(clean)).toEqual([]);
  });

  it("retains a solid tapered wedge with a rough outline around its broad end", () => {
    const object = molecule("single", "wedge");
    const wedge = render(object).find(fragment => fragment.tag === "polygon" && fragment.attrs["data-bond-id"] === "ab")!;
    const points = String(wedge.attrs.points).split(/\s+/).map(point => point.split(",").map(Number));
    expect(points).toHaveLength(3);
    expect(points[0]![0]).toBeLessThan(points[1]![0]!);
    const clean = structuredClone(object); clean.style.visualEffects = [];
    expect(wedge.attrs.points).toBe(render(clean).find(fragment => fragment.tag === "polygon")!.attrs.points);
    expect(Math.abs(points[1]![1]! - points[2]![1]!)).toBeGreaterThan(SketchStylePreset.drawing.bondStrokeWidthPx * 2);
    expect(String(sketch(object)[0]!.attrs.d).match(/M/g)).toHaveLength(6);
  });

  it("retains separated, progressively wider hashes with uneven ink and no axial stroke", () => {
    const object = molecule("single", "hashed");
    const marks = sketch(object);
    const clean = structuredClone(object); clean.style.visualEffects = [];
    expect(marks).toHaveLength(render(clean).filter(fragment => fragment.attrs.class === "native-bond-hash").length);
    expect(marks.length).toBeGreaterThan(1);
    let previousRight = -Infinity, previousWidth = 0;
    for (const mark of marks) {
      expect(mark.attrs.fill).not.toBe("none");
      expect(mark.attrs.stroke).toBe("none");
      const numbers = String(mark.attrs.d).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const xs = numbers.filter((_, i) => i % 2 === 0), ys = numbers.filter((_, i) => i % 2 === 1);
      expect(Math.min(...xs)).toBeGreaterThan(previousRight);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(previousWidth);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(SketchStylePreset.drawing.bondLengthPx / 2);
      previousRight = Math.max(...xs); previousWidth = Math.max(...ys) - Math.min(...ys);
    }
    expect(render(object).some(fragment => fragment.attrs.class === "native-bond-hash")).toBe(false);
  });
});
