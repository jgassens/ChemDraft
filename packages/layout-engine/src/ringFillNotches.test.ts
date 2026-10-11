import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { visualEffectPlansForStyle } from "@chemdraft/art-engine";
import {
  averageDefinedDepthWeights, depthCuedLabelScale, nativeMoleculeRings, planMoleculeAtomLabels,
  type AtomLabelPlan, type LayoutBounds
} from "./index";
import {
  filledRingFixture, fillAreaInsideBox, naturalProductLikeFixture, polygonPathFaces,
  renderRingFixture, ringFixtureFills, ringFixtureFragments
} from "./ringFillNotches.fixture";
import { sketchRegressionMolecule } from "./sketchRegression.fixture";

function labelBox(plan: AtomLabelPlan, scale = 1): LayoutBounds {
  return {
    x: plan.anchor.x + plan.layout.bounds.x * scale, y: plan.anchor.y + plan.layout.bounds.y * scale,
    width: plan.layout.bounds.width * scale, height: plan.layout.bounds.height * scale
  };
}

describe("ring fill label notches", () => {
  for (const element of ["O", "N", "S", "Me", "H", "OH"]) {
    it(`clears a ${element} label at a ring corner with a rounded bite`, () => {
      const object = filledRingFixture();
      Object.assign(object.atoms[0]!, { element, labelLiteral: true });
      const label = planMoleculeAtomLabels(object)[0]!;
      const fill = ringFixtureFills(object)[0]!;
      expect(fill.attrs.d).not.toBe(nativeMoleculeRings(object)[0]!.pathD);
      expect(fill.attrs["fill-rule"]).toBe("evenodd");
      expect(fillAreaInsideBox(String(fill.attrs.d), labelBox(label))).toBeLessThan(0.001);
      // Rounded boundary has many distinct short chords, not four straight box edges.
      expect(polygonPathFaces(String(fill.attrs.d))[0]!.length).toBeGreaterThan(15);
      expect(fillAreaInsideBox(String(fill.attrs.d), { x: 120, y: 120, width: 30, height: 30 })).toBeCloseTo(900, 3);
    });
  }

  it("cuts a true interior hole for a non-ring atom's methyl label", () => {
    const object = filledRingFixture();
    object.atoms.push({ id: "inside", element: "Me", x: 140, y: 140, formalCharge: 0 });
    const label = planMoleculeAtomLabels(object).find((plan) => plan.atom.id === "inside")!;
    const fill = ringFixtureFills(object)[0]!;
    expect(polygonPathFaces(String(fill.attrs.d))).toHaveLength(2);
    expect(fillAreaInsideBox(String(fill.attrs.d), labelBox(label))).toBeLessThan(0.001);
  });

  it("preserves the exact path and background behavior of an outside label", () => {
    const object = filledRingFixture();
    object.atoms.push({ id: "outside", element: "O", x: 240, y: 140, formalCharge: 0 });
    object.style.atomLabelBackgroundColor = "#ffffff";
    expect(ringFixtureFills(object)[0]!.attrs.d).toBe(nativeMoleculeRings(object)[0]!.pathD);
    expect(ringFixtureFragments(object).some((fragment) => fragment.key.startsWith("label-run-halo-notched-ring-outside"))).toBe(true);
  });

  it("unions two overlapping clearances without restoring fill in their overlap", () => {
    const object = filledRingFixture();
    object.atoms.push(
      { id: "inside1", element: "Me", x: 140, y: 140, formalCharge: 0 },
      { id: "inside2", element: "H", x: 145, y: 140, formalCharge: 0 }
    );
    const pathD = String(ringFixtureFills(object)[0]!.attrs.d);
    expect(polygonPathFaces(pathD)).toHaveLength(2);
    for (const label of planMoleculeAtomLabels(object)) {
      expect(fillAreaInsideBox(pathD, labelBox(label))).toBeLessThan(0.001);
    }
  });

  it("omits an empty fill and its effects when a label covers the entire ring", () => {
    const object = filledRingFixture();
    object.atoms.push({ id: "huge", element: "O", x: 140, y: 140, formalCharge: 0, labelLiteral: true });
    object.style.atomLabelFontSizes = { huge: 400 };
    object.style.atomLabelBackgroundColor = "#ffffff";
    const key = nativeMoleculeRings(object)[0]!.ringKey;
    object.style.ringStyles = { [key]: { visualEffects: [{ kind: "sketch" }, { kind: "shadow" }] } };
    const fragments = ringFixtureFragments(object);
    expect(ringFixtureFills(object)).toHaveLength(0);
    expect(fragments.some((fragment) => fragment.attrs.class === "native-molecule-ring-sketch")).toBe(false);
    expect(fragments.some((fragment) => fragment.key.startsWith("label-run-halo-notched-ring-huge"))).toBe(false);
  });

  it("keeps gradient coordinates exactly the same after a notch", () => {
    const object = filledRingFixture();
    const key = nativeMoleculeRings(object)[0]!.ringKey;
    object.style.ringStyles = { [key]: { fillPaint: {
      kind: "linear-gradient", units: "object", x1: 0.1, y1: 0.2, x2: 0.8, y2: 1,
      stops: [{ offset: 0, color: "#f00000" }, { offset: 1, color: "#0000ff" }]
    } } };
    const before = ringFixtureFragments(object).find((fragment) => fragment.tag === "linearGradient")!;
    object.atoms[0]!.element = "O";
    const after = ringFixtureFragments(object).find((fragment) => fragment.tag === "linearGradient")!;
    expect(after).toEqual(before);
    expect(after.attrs).toMatchObject({ x1: 100, y1: 110, x2: 170, y2: 190, gradientUnits: "userSpaceOnUse" });
    expect(ringFixtureFills(object)[0]!.attrs.d).not.toBe(nativeMoleculeRings(object)[0]!.pathD);
  });

  it("uses the notched path for ring sketch, shadow and glow without changing sketch parameters", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    const key = nativeMoleculeRings(object)[0]!.ringKey;
    const style = { visualEffects: [
      { kind: "sketch" as const, seed: 73, roughness: 1.7, bowing: 0.9, strokeWidth: 2.3 },
      { kind: "shadow" as const }, { kind: "glow" as const }
    ] };
    object.style.ringStyles = { [key]: style };
    const fragments = ringFixtureFragments(object);
    const fill = ringFixtureFills(object)[0]!;
    expect(fill.attrs.filter).toBe(`url(#molecule-ring-effects-notched-ring-${key.replaceAll("|", "_")})`);
    const expectedSketch = visualEffectPlansForStyle({
      objectId: `notched-ring-${key.replaceAll("|", "_")}`, style,
      sketchBasePathD: String(fill.attrs.d), sketchStrokeWidthPx: 1.5
    }).find((effect) => effect.kind === "sketch")!;
    expect(expectedSketch).toMatchObject({ seed: 73, roughness: 1.7, bowing: 0.9, strokeWidth: 2.3 });
    const sketch = fragments.filter((fragment) => fragment.attrs.class === "native-molecule-ring-sketch");
    expect(sketch.map((fragment) => fragment.attrs.d)).toEqual(expectedSketch.paths.map((path) => path.d));
    expect(fragments.some((fragment) => fragment.tag === "feGaussianBlur")).toBe(true);
  });

  for (const kind of ["paclitaxel-like", "cholesterol-like"] as const) {
    it(`${kind}: emitted fill has zero intersection with every atom label box`, () => {
      const object = naturalProductLikeFixture(kind);
      const before = JSON.stringify(object);
      const fills = ringFixtureFills(object);
      expect(fills.length).toBeGreaterThanOrEqual(4);
      expect(planMoleculeAtomLabels(object).some((plan) => plan.label === "Me")).toBe(true);
      for (const label of planMoleculeAtomLabels(object)) {
        for (const fill of fills) {
          // Exact polygon/rectangle intersection; 0.001 square px is well below 0.5 px tolerance.
          expect(fillAreaInsideBox(String(fill.attrs.d), labelBox(label)), `${kind} ${label.label}`).toBeLessThan(0.001);
        }
      }
      expect(JSON.stringify(object)).toBe(before);
    });
  }

  it("uses existing offsets, per-atom sizes, scripts and depth scaling", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "N";
    object.atoms[0]!.formalCharge = 1;
    object.atoms[0]!.labelOffset = { x: 25, y: 30 };
    object.style.atomLabelFontSizes = { a0: 23 };
    object.bonds.forEach((bond) => { bond.display = { depthWeight: 0.1 }; });
    const label = planMoleculeAtomLabels(object)[0]!;
    const scale = depthCuedLabelScale(averageDefinedDepthWeights([0.1, 0.1]));
    expect(fillAreaInsideBox(String(ringFixtureFills(object)[0]!.attrs.d), labelBox(label, scale))).toBeLessThan(0.001);
  });

  it("emits no rectangle or glyph background for notched labels, retaining other backgrounds", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    object.atoms.push({ id: "outside", element: "O", x: 240, y: 140, formalCharge: 0 });
    object.style.atomLabelBackgroundColor = "#ffffff";
    const fragments = ringFixtureFragments(object);
    expect(fragments.some((fragment) => fragment.key.startsWith("label-run-halo-notched-ring-a0"))).toBe(false);
    expect(fragments.some((fragment) => fragment.key.startsWith("label-run-halo-notched-ring-outside"))).toBe(true);
    expect(fragments.some((fragment) => fragment.tag === "rect")).toBe(false);
  });

  it("keeps an unfilled molecule byte-identical to its pre-change renderer digest", () => {
    // Existing pre-change fixture/digest, also guarded by sketchTicks.test.ts; never refreshed.
    const digest = createHash("sha256").update(JSON.stringify(renderRingFixture(sketchRegressionMolecule(false)))).digest("hex");
    expect(digest).toBe("dee8f9e869c7490ada2efce7ae5ae3fec5d374da30ac8662b5c0d67a9ee8311a");
  });
});
