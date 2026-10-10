import { describe, expect, it } from "vitest";
import {
  ChemDraftSyntheticStylePreset,
  createEmptyDocument,
  stylePresetToObjectStyle,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

const BOND_LENGTH = 60;
type BondStyle = "hashed" | "dashed" | "wedge" | "bold" | undefined;

function molecule(bondStyle: BondStyle, sketch: boolean): MoleculeObject {
  return {
    id: "mol_sketch",
    type: "molecule",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      source: "chemdraft-native-drawing",
      // Zero roughness and bowing keep every sketch stroke on its source line, so lengths are exact.
      visualEffects: sketch ? [{ kind: "sketch", color: "#111111", seed: 1, roughness: 0, bowing: 0 }] : []
    },
    structureFormat: "smiles",
    structure: "CC",
    atoms: [
      { id: "a", element: "C", x: 40, y: 60, formalCharge: 0 },
      { id: "b", element: "C", x: 40 + BOND_LENGTH, y: 60, formalCharge: 0 }
    ],
    bonds: [{
      id: "b1",
      fromAtomId: "a",
      toAtomId: "b",
      order: "single",
      ...(bondStyle ? { display: { bondStyle } } : {})
    }],
    chemistry: {}
  } as unknown as MoleculeObject;
}

function render(bondStyle: BondStyle, sketch: boolean) {
  const page = { ...createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" }).pages[0]!, objects: [molecule(bondStyle, sketch)] };
  return planPageSvgRender(page).fragments.flatMap(elementFragments);
}

/** Distinct strokes of the sketch layer as [start, end] points (rough doubles each stroke). */
function sketchStrokes(bondStyle: BondStyle): { length: number; start: string }[] {
  const d = render(bondStyle, true)
    .filter((fragment) => fragment.attrs.class === "native-molecule-sketch")
    .map((fragment) => String(fragment.attrs.d))
    .join(" ");
  const seen = new Map<string, number>();
  for (const sub of d.split("M").filter((part) => part.trim())) {
    const numbers = sub.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const [x1, y1] = numbers;
    const x2 = numbers[numbers.length - 2]!;
    const y2 = numbers[numbers.length - 1]!;
    seen.set(`${x1} ${y1}`, Math.hypot(x2 - x1!, y2 - y1!));
  }
  return [...seen].map(([start, length]) => ({ start, length }));
}

describe("sketch effect on stereo bonds", () => {
  it("traces each hash of a hashed bond, with no full-length stroke through them", () => {
    const strokes = sketchStrokes("hashed");
    const normalHashes = render("hashed", true).filter((fragment) =>
      fragment.tag === "line" && fragment.attrs.class === "native-bond-hash"
    );
    expect(normalHashes.length).toBeGreaterThan(1);
    expect(strokes.some((stroke) => stroke.length >= BOND_LENGTH * 0.9)).toBe(false);
    // One stroke per hash line, plus one outline for the terminal join polygon when drawn.
    const joins = render("hashed", true).filter((fragment) =>
      fragment.tag === "polygon" && fragment.attrs.class === "native-bond-hash"
    ).length;
    expect(strokes.length).toBe(normalHashes.length + joins);
    for (const stroke of strokes) {
      expect(stroke.length).toBeLessThan(BOND_LENGTH / 4);
    }
  });

  it("traces each dash of a dashed bond, with no full-length stroke", () => {
    const strokes = sketchStrokes("dashed");
    expect(strokes.some((stroke) => stroke.length >= BOND_LENGTH * 0.9)).toBe(false);
    expect(strokes.length).toBeGreaterThan(3);
    // dash 4.4 + gap 3.6 on a 60 px bond: ceil(60 / 8) dashes.
    expect(strokes.length).toBe(Math.ceil(BOND_LENGTH / 8));
  });

  it("traces a wedge by its outline, not its centre line", () => {
    const d = render("wedge", true)
      .filter((fragment) => fragment.attrs.class === "native-molecule-sketch")
      .map((fragment) => String(fragment.attrs.d))
      .join(" ");
    const polygon = render("wedge", true).find((fragment) => fragment.tag === "polygon")!;
    const wideEnd = String(polygon.attrs.points).split(" ").slice(1).map((point) => point.split(","));
    // The sketch visits the wide-end corners, which a centre line never does.
    for (const [x, y] of wideEnd) {
      expect(d).toContain(`${Number(x)} ${Number(y)}`);
    }
  });

  it("leaves plain and bold bonds as one centre-line stroke", () => {
    for (const style of [undefined, "bold"] as const) {
      const strokes = sketchStrokes(style);
      expect(strokes).toHaveLength(1);
      expect(strokes[0]!.start).toBe("40 60");
      expect(strokes[0]!.length).toBeCloseTo(BOND_LENGTH, 1);
    }
  });

  it("does not change the normal bond layer when the sketch effect is off", () => {
    for (const style of ["hashed", "dashed", "wedge", "bold", undefined] as const) {
      const off = render(style, false);
      expect(off.some((fragment) => fragment.attrs.class === "native-molecule-sketch")).toBe(false);
      const bondLayer = (fragments: ReturnType<typeof render>) =>
        fragments
          .filter((fragment) => String(fragment.attrs.class ?? "").includes("native-bond"))
          .map((fragment) => JSON.stringify(fragment.attrs));
      expect(bondLayer(render(style, true))).toEqual(bondLayer(off));
    }
    const dashed = render("dashed", false).find((fragment) => fragment.attrs["data-bond-style"] === "dashed");
    expect(dashed?.attrs["stroke-dasharray"]).toBe("4.4 3.6");
  });
});
