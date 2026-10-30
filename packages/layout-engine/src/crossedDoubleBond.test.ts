import { describe, expect, it } from "vitest";
import {
  createEmptyDocument,
  nativeDrawingStyleFromObjectStyle,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { nativeMultipleBondGapPx, planPageSvgRender } from "./index";
import { elementFragments } from "./testing";

function molecule(): MoleculeObject {
  return {
    id: "crossed", type: "molecule", x: 0, y: 0, width: 240, height: 160, rotation: 0,
    style: { source: "chemdraft-native-drawing" },
    structureFormat: "smiles", structure: "CC=CC", superatoms: [], rGroups: [],
    atoms: [
      { id: "a", element: "C", x: 30, y: 130, formalCharge: 0 },
      { id: "b", element: "C", x: 60, y: 80, formalCharge: 0 },
      { id: "c", element: "C", x: 120, y: 80, formalCharge: 0 },
      { id: "d", element: "C", x: 150, y: 30, formalCharge: 0 }
    ],
    bonds: [
      { id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" },
      { id: "bc", fromAtomId: "b", toAtomId: "c", order: "double", stereo: "either" },
      { id: "cd", fromAtomId: "c", toAtomId: "d", order: "single" }
    ]
  };
}

function fragments(object: MoleculeObject) {
  const page = createEmptyDocument().pages[0]!;
  page.objects = [object];
  return planPageSvgRender(page).fragments.flatMap(elementFragments);
}

function lines(object: MoleculeObject, bondId = "bc") {
  return fragments(object).filter((fragment) => fragment.tag === "line" &&
    String(fragment.attrs.class).startsWith("native-bond-line") &&
    fragment.attrs["data-bond-id"] === bondId);
}

function normal(object: MoleculeObject): MoleculeObject {
  return { ...object, bonds: object.bonds.map(({ stereo: _stereo, ...bond }) => bond) };
}

describe("explicitly unspecified E/Z crossed double bonds", () => {
  it.each([0, 37, 90, 180])("crosses two symmetric segments at the bond midpoint at %s degrees", (degrees) => {
    const object = molecule();
    const angle = degrees * Math.PI / 180;
    object.atoms = object.atoms.map((atom) => ({ ...atom,
      x: atom.x * Math.cos(angle) - atom.y * Math.sin(angle),
      y: atom.x * Math.sin(angle) + atom.y * Math.cos(angle)
    }));
    const before = JSON.stringify(object);
    const rendered = lines(object);
    expect(rendered).toHaveLength(2);
    const from = object.atoms[1]!;
    const to = object.atoms[2]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const unit = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
    const halfGap = nativeMultipleBondGapPx(nativeDrawingStyleFromObjectStyle(object.style)) / 2;
    for (const [index, { attrs }] of rendered.entries()) {
      // Each line passes through the midpoint halfway along its finite length.
      expect((Number(attrs.x1) + Number(attrs.x2)) / 2).toBeCloseTo((from.x + to.x) / 2, 8);
      expect((Number(attrs.y1) + Number(attrs.y2)) / 2).toBeCloseTo((from.y + to.y) / 2, 8);
      for (const [x, y, atom, sign] of [
        [Number(attrs.x1), Number(attrs.y1), from, 1],
        [Number(attrs.x2), Number(attrs.y2), to, -1]
      ] as const) {
        const dx = x - atom.x, dy = y - atom.y;
        expect(dx * unit.x + dy * unit.y).toBeCloseTo(0, 8);
        expect(-dx * unit.y + dy * unit.x).toBeCloseTo(sign * (index === 0 ? halfGap : -halfGap), 8);
      }
      expect(attrs["data-bond-stereo"]).toBe("either");
      expect(attrs["data-double-bond-side"]).toBe("center");
    }
    expect(JSON.stringify(object)).toBe(before);
  });

  it.each(["left", "right", "center", "automatic"] as const)("ignores doubleBondSide=%s and leaves neighbouring bonds untouched", (side) => {
    const object = molecule();
    const baseline = normal(object);
    object.bonds[1]!.display = { doubleBondSide: side };
    expect(lines(object)).toEqual(lines(molecule()));
    for (const id of ["ab", "cd"]) expect(lines(object, id)).toEqual(lines(baseline, id));
  });

  it.each(["from", "to", "both"])("keeps normal double-bond end clearance with labels at %s ends", (ends) => {
    const object = molecule();
    if (ends !== "to") object.atoms[1]!.element = "N";
    if (ends !== "from") object.atoms[2]!.element = "N";
    const baseline = normal(object);
    baseline.bonds[1]!.display = { doubleBondSide: "left" };
    const primary = lines(baseline)[0]!.attrs;
    const halfGap = nativeMultipleBondGapPx(nativeDrawingStyleFromObjectStyle(object.style)) / 2;
    const crossed = lines(object);
    expect(crossed).toHaveLength(2);
    for (const [index, { attrs }] of crossed.entries()) {
      expect([attrs.x1, attrs.x2]).toEqual([primary.x1, primary.x2]);
      const offset = index === 0 ? halfGap : -halfGap;
      expect([attrs.y1, attrs.y2]).toEqual([80 + offset, 80 - offset]);
      if (ends !== "to") expect(Number(attrs.x1)).toBeGreaterThan(60);
      if (ends !== "from") expect(Number(attrs.x2)).toBeLessThan(120);
      // With unequal clearance, the X meets at the midpoint of the visible bond span.
      expect((Number(attrs.y1) + Number(attrs.y2)) / 2).toBe(80);
    }
  });

  it("changes only the flagged double in a molecule containing other doubles", () => {
    const object = molecule();
    object.structure = "CC=CC=CC";
    object.atoms.push(
      { id: "e", element: "C", x: 210, y: 30, formalCharge: 0 },
      { id: "f", element: "C", x: 240, y: 80, formalCharge: 0 }
    );
    object.bonds.push(
      { id: "de", fromAtomId: "d", toAtomId: "e", order: "double" },
      { id: "ef", fromAtomId: "e", toAtomId: "f", order: "single" }
    );
    const baseline = normal(object);
    expect(lines(object)).not.toEqual(lines(baseline));
    const unrelated = (m: MoleculeObject) => fragments(m).filter((f) =>
      f.attrs["data-bond-id"] !== "bc" && f.attrs["data-bond-id"] !== undefined);
    expect(JSON.stringify(unrelated(object))).toBe(JSON.stringify(unrelated(baseline)));
  });

  it("does not miter a crossed bond against an adjacent centred double", () => {
    const object = molecule();
    object.bonds[2] = { ...object.bonds[2]!, order: "double", display: { doubleBondSide: "center" } };
    expect(lines(object)).toEqual(lines(molecule()));
    const isolated = { ...object, atoms: object.atoms.slice(2), bonds: [object.bonds[2]!] };
    expect(lines(object, "cd")).toEqual(lines(isolated, "cd"));
  });

  it("retains double-bond stroke, colour, depth weight and configurable separation", () => {
    const object = molecule();
    object.style = { ...object.style, bondColor: "#123456", bondStrokeWidthPx: 3, multipleBondGapPx: 8 };
    object.bonds[1]!.display = { depthWeight: 0.2 };
    const parallel = lines(normal(object));
    for (const { attrs } of lines(object)) {
      expect(attrs.stroke).toBe(parallel[0]!.attrs.stroke);
      expect(attrs.stroke).not.toBe("#123456");
      expect(attrs["stroke-width"]).toBe(parallel[0]!.attrs["stroke-width"]);
      expect(attrs["stroke-width"]).not.toBe(3);
      expect(Math.abs(Number(attrs.y1) - 80)).toBe(4);
      expect(Math.abs(Number(attrs.y2) - 80)).toBe(4);
    }
  });

  it("traces both crossed segments through the existing sketch effect", () => {
    const object = molecule();
    object.atoms = object.atoms.slice(1, 3);
    object.bonds = [object.bonds[1]!];
    object.style.visualEffects = [{ kind: "sketch", seed: 7, roughness: 0, bowing: 0 }];
    const rendered = fragments(object);
    const paths = rendered.filter((f) => f.attrs.class === "native-molecule-sketch");
    expect(paths.length).toBeGreaterThan(0);
    const ends = paths.flatMap((f) => String(f.attrs.d).split("M").filter((s) => s.trim()).map((s) => {
      const values = s.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      return [values[0], values[1], values.at(-2), values.at(-1)];
    }));
    const expected = lines(object).map(({ attrs }) => [attrs.x1, attrs.y1, attrs.x2, attrs.y2]);
    for (const segment of expected) expect(ends).toContainEqual(segment);
    for (const segment of ends) expect(expected).toContainEqual(segment);
  });
});
