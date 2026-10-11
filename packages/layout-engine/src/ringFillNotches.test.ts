import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as artEngine from "@chemdraft/art-engine";
import { createEmptyDocument } from "@chemdraft/chem-core";
import {
  atomLabelHaloWidthPx, averageDefinedDepthWeights, depthCuedLabelScale, nativeMoleculeRings, planMoleculeAtomLabels, planPageSvgRender,
  type AtomLabelPlan, type LayoutBounds
} from "./index";
import {
  filledRingFixture, fillAreaInsideBox, naturalProductLikeFixture, polygonPathFaces,
  renderRingFixture, ringFixtureFills, ringFixtureFragments
} from "./ringFillNotches.fixture";
import { sketchRegressionMolecule } from "./sketchRegression.fixture";
import { atomLabelRingClearance, notchedRingPath, ringOverlappingClearances } from "./ringFillNotches";
import { elementFragments } from "./testing";

function labelBox(plan: AtomLabelPlan, scale = 1): LayoutBounds {
  return {
    x: plan.anchor.x + plan.layout.bounds.x * scale, y: plan.anchor.y + plan.layout.bounds.y * scale,
    width: plan.layout.bounds.width * scale, height: plan.layout.bounds.height * scale
  };
}

describe("ring fill label notches", () => {
  it.each([
    ["bowtie", [[100, 100], [180, 180], [180, 100], [100, 180]]],
    ["collinear", [[100, 100], [120, 120], [140, 140], [160, 160]]],
    ["all coincident", [[100, 100], [100, 100], [100, 100], [100, 100]]],
    // Screen coordinates of a planar hexagon viewed edge-on. Projection helpers
    // live in the desktop app; layout-engine tests construct the projected points.
    ["edge-on Spin 3D projection", [[100, 140], [120, 140], [160, 140], [180, 140], [160, 140], [120, 140]]],
    ["mid-drag coincident vertex", [[100, 100], [100, 100], [180, 180], [100, 180]]]
  ] as const)("renders a %s ring un-notched while still notching other rings", (_name, coordinates) => {
    const bad = filledRingFixture();
    bad.id = "degenerate-ring";
    bad.atoms = coordinates.map(([x, y], index) => ({
      id: `a${index}`, element: index === 0 ? "O" : "C", x, y, formalCharge: 0
    }));
    bad.bonds = bad.atoms.map((atom, index) => ({
      id: `b${index}`, fromAtomId: atom.id, toAtomId: bad.atoms[(index + 1) % bad.atoms.length]!.id, order: "single"
    }));
    const good = filledRingFixture();
    good.atoms[0]!.element = "O";
    good.atoms.forEach((atom) => { atom.x += 200; });
    const page = { ...createEmptyDocument().pages[0]!, objects: [bad, good] };
    let plan: ReturnType<typeof planPageSvgRender> | undefined;
    expect(() => { plan = planPageSvgRender(page); }).not.toThrow();
    const fills = plan!.fragments.flatMap(elementFragments)
      .filter((fragment) => fragment.attrs["data-molecule-fill-ring"] === "true");
    expect(fills).toHaveLength(2);
    expect(fills[0]!.attrs.d).toBe(nativeMoleculeRings(bad)[0]!.pathD);
    expect(fills[0]!.attrs["fill-rule"]).toBeUndefined();
    expect(fills[1]!.attrs.d).not.toBe(nativeMoleculeRings(good)[0]!.pathD);
    expect(fills[1]!.attrs["fill-rule"]).toBe("evenodd");
    expect(fillAreaInsideBox(String(fills[1]!.attrs.d), labelBox(planMoleculeAtomLabels(good)[0]!))).toBeLessThan(0.001);
    // The same molecule and ring IDs become valid after projection/drag ends.
    const restored = filledRingFixture();
    bad.atoms = restored.atoms;
    bad.bonds = restored.bonds;
    bad.atoms[0]!.element = "O";
    const recovered = planPageSvgRender(structuredClone(page)).fragments.flatMap(elementFragments)
      .find((fragment) => fragment.key.startsWith("molecule-fill-underlay-degenerate-ring-"))!;
    expect(recovered.attrs.d).not.toBe(nativeMoleculeRings(bad)[0]!.pathD);
    expect(recovered.attrs["fill-rule"]).toBe("evenodd");
  });

  it("retries the same full geometry after a transient boolean failure", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    object.atoms.forEach((atom) => { atom.x += 0.123; });
    const ring = nativeMoleculeRings(object)[0]!;
    const clearances = planMoleculeAtomLabels(object).map((plan) => atomLabelRingClearance(plan, 1));
    const subtract = vi.spyOn(artEngine, "subtractPolygonPaths")
      .mockReturnValueOnce({ failed: true, pathD: "", overlappingCutoutIndices: [] });
    try {
      expect(notchedRingPath(ring.points, clearances).failed).toBe(true);
      const retried = notchedRingPath(ring.points, clearances);
      expect(subtract).toHaveBeenCalledTimes(2);
      expect(retried.failed).toBeUndefined();
      expect(retried.overlappingCutoutIndices).toEqual([0]);
      expect(retried.pathD).not.toBe(ring.pathD);
    } finally {
      subtract.mockRestore();
    }
  });

  it("reuses a geometry-keyed result across fresh copies, missing on label or ring movement", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    const ring = nativeMoleculeRings(object)[0]!;
    const clearances = planMoleculeAtomLabels(object).map((plan) => atomLabelRingClearance(plan, 1));
    const result = notchedRingPath(ring.points, clearances);
    expect(notchedRingPath(structuredClone(ring.points), structuredClone(clearances))).toBe(result);
    const movedLabel = structuredClone(clearances);
    movedLabel[0]!.bounds.x += 0.5;
    expect(notchedRingPath(ring.points, movedLabel)).not.toBe(result);
    const movedRing = ring.points.map((point) => ({ x: point.x + 0.5, y: point.y }));
    expect(notchedRingPath(movedRing, clearances)).not.toBe(result);
    const roundedDifferently = structuredClone(clearances);
    roundedDifferently[0]!.radius /= 2;
    expect(notchedRingPath(ring.points, roundedDifferently)).not.toBe(result);
    const label = planMoleculeAtomLabels(object)[0]!;
    const withHalo = atomLabelRingClearance({ ...label, backgroundVisible: true }, 1);
    expect(notchedRingPath(ring.points, [withHalo])).not.toBe(result);
    const widerHalo = atomLabelRingClearance({
      ...label, backgroundVisible: true,
      drawingStyle: { ...label.drawingStyle, atomLabelFontSizePx: label.fontSizePx + 4 }
    }, 1);
    expect(notchedRingPath(ring.points, [widerHalo])).not.toBe(notchedRingPath(ring.points, [withHalo]));
  });

  it("rejects distant clearances and keeps cache indices independent of atom IDs", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    object.atoms.push({ id: "outside", element: "O", x: 240, y: 140, formalCharge: 0 });
    const ring = nativeMoleculeRings(object)[0]!;
    const clearances = planMoleculeAtomLabels(object).map((plan) => atomLabelRingClearance(plan, 1));
    expect(ringOverlappingClearances(ring.points, clearances)).toEqual([0]);
    ringFixtureFills(object);
    object.style.atomLabelBackgroundColor = "#ffffff";
    object.atoms[0]!.id = "renamed";
    object.bonds.forEach((bond) => {
      if (bond.fromAtomId === "a0") bond.fromAtomId = "renamed";
      if (bond.toAtomId === "a0") bond.toAtomId = "renamed";
    });
    expect(ringFixtureFragments(object).some((fragment) => fragment.key.startsWith("label-run-halo-notched-ring-renamed"))).toBe(true);
  });

  it("evicts the least recently used geometry after 256 entries", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    const clearances = planMoleculeAtomLabels(object).map((plan) => atomLabelRingClearance(plan, 1));
    const points = nativeMoleculeRings(object)[0]!.points;
    const first = notchedRingPath(points, clearances);
    const secondPoints = points.map((point) => ({ ...point, x: point.x + 0.25 }));
    const second = notchedRingPath(secondPoints, clearances);
    for (let i = 1; i <= 254; i++) {
      notchedRingPath(points.map((point) => ({ ...point, x: point.x + i })), clearances);
    }
    expect(notchedRingPath(structuredClone(points), structuredClone(clearances))).toBe(first);
    notchedRingPath(points.map((point) => ({ ...point, x: point.x + 255 })), clearances);
    expect(notchedRingPath(points, clearances)).toBe(first);
    expect(notchedRingPath(secondPoints, clearances)).not.toBe(second);
  });

  for (const element of ["O", "N", "S", "Me", "H", "OH"]) {
    it(`clears a ${element} label at a ring corner with a rounded bite`, () => {
      const object = filledRingFixture();
      Object.assign(object.atoms[0]!, { element, labelLiteral: true });
      const label = planMoleculeAtomLabels(object)[0]!;
      const fill = ringFixtureFills(object)[0]!;
      expect(fill.attrs.d).not.toBe(nativeMoleculeRings(object)[0]!.pathD);
      expect(fill.attrs["fill-rule"]).toBe("evenodd");
      expect(fillAreaInsideBox(String(fill.attrs.d), labelBox(label))).toBeLessThan(0.001);
      // The 0.1 px approximation uses fewer chords than the old 0.015 px one,
      // while still distinguishing the rounded bite from a rectangular cutout.
      expect(polygonPathFaces(String(fill.attrs.d))[0]!.length).toBeGreaterThan(8);
      expect(fillAreaInsideBox(String(fill.attrs.d), { x: 120, y: 120, width: 30, height: 30 })).toBeCloseTo(900, 3);
    });
  }

  it.each(["transparent", "#ffffff"])("keeps fill beneath a non-ring methyl label and its %s background", (background) => {
    const object = filledRingFixture();
    object.atoms.push({ id: "inside", element: "Me", x: 140, y: 140, formalCharge: 0 });
    object.style.atomLabelBackgroundColor = background;
    const label = planMoleculeAtomLabels(object).find((plan) => plan.atom.id === "inside")!;
    const fill = ringFixtureFills(object)[0]!;
    expect(fill.attrs.d).toBe(nativeMoleculeRings(object)[0]!.pathD);
    const box = labelBox(label);
    expect(fillAreaInsideBox(String(fill.attrs.d), box)).toBeCloseTo(box.width * box.height, 3);
    const unfilled = structuredClone(object);
    unfilled.style.fillColor = "transparent";
    const labelFragments = (molecule: typeof object) => ringFixtureFragments(molecule)
      .filter((fragment) => fragment.key.startsWith("label-run-") || fragment.attrs.class === "native-atom-label");
    expect(labelFragments(object)).toEqual(labelFragments(unfilled));
    expect(labelFragments(object).some((fragment) => fragment.attrs.class === "native-atom-label-halo"))
      .toBe(background !== "transparent");
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
    Object.assign(object.atoms[0]!, { element: "Me", labelOffset: { x: 40, y: 40 } });
    Object.assign(object.atoms[1]!, { element: "H", labelOffset: { x: -35, y: 40 } });
    const pathD = String(ringFixtureFills(object)[0]!.attrs.d);
    expect(polygonPathFaces(pathD)).toHaveLength(2);
    for (const label of planMoleculeAtomLabels(object)) {
      expect(fillAreaInsideBox(pathD, labelBox(label))).toBeLessThan(0.001);
    }
  });

  it("omits an empty fill and its effects when a label covers the entire ring", () => {
    const object = filledRingFixture();
    Object.assign(object.atoms[0]!, { element: "O", labelOffset: { x: 40, y: 40 }, labelLiteral: true });
    object.style.atomLabelFontSizes = { a0: 400 };
    object.style.atomLabelBackgroundColor = "#ffffff";
    const key = nativeMoleculeRings(object)[0]!.ringKey;
    object.style.ringStyles = { [key]: { visualEffects: [{ kind: "sketch" }, { kind: "shadow" }] } };
    const fragments = ringFixtureFragments(object);
    expect(ringFixtureFills(object)).toHaveLength(0);
    expect(fragments.some((fragment) => fragment.attrs.class === "native-molecule-ring-sketch")).toBe(false);
    expect(fragments.some((fragment) => fragment.key.startsWith("label-run-halo-notched-ring-a0"))).toBe(true);
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
    const effects = vi.spyOn(artEngine, "visualEffectPlansForStyle");
    try {
      const fragments = ringFixtureFragments(object);
      const fill = fragments.find((fragment) => fragment.attrs["data-molecule-fill-ring"] === "true")!;
      expect(fill.attrs.filter).toBe(`url(#molecule-ring-effects-notched-ring-${key.replaceAll("|", "_")})`);
      const objectId = `notched-ring-${key.replaceAll("|", "_")}`;
      const callIndex = effects.mock.calls.findIndex(([input]) => input.objectId === objectId);
      const input = effects.mock.calls[callIndex]![0];
      expect(input.style.visualEffects).toEqual(style.visualEffects);
      expect(input.sketchBasePathD).toBe(fill.attrs.d);
      expect(input.sketchBasePathD).not.toBe(nativeMoleculeRings(object)[0]!.pathD);
      // Independent geometry assertion: the source has extra notch vertices and
      // clears the label box, unlike the four-vertex un-notched ring outline.
      expect(polygonPathFaces(input.sketchBasePathD!)[0]!.length).toBeGreaterThan(4);
      const box = labelBox(planMoleculeAtomLabels(object)[0]!);
      expect(fillAreaInsideBox(input.sketchBasePathD!, box)).toBeLessThan(0.001);
      expect(fillAreaInsideBox(nativeMoleculeRings(object)[0]!.pathD, box)).toBeGreaterThan(1);
      expect(effects.mock.results[callIndex]!.value.find((effect: artEngine.NativeArtEffectPlan) => effect.kind === "sketch"))
        .toMatchObject({ seed: 73, roughness: 1.7, bowing: 0.9, strokeWidth: 2.3 });
      expect(fragments.some((fragment) => fragment.attrs.class === "native-molecule-ring-sketch")).toBe(true);
      expect(fragments.some((fragment) => fragment.tag === "feGaussianBlur")).toBe(true);

      effects.mockClear();
      object.atoms[0]!.element = "C";
      ringFixtureFragments(object);
      const unlabelledInput = effects.mock.calls.find(([input]) => input.objectId === objectId)![0];
      expect(unlabelledInput.sketchBasePathD).toBe(nativeMoleculeRings(object)[0]!.pathD);
      expect(unlabelledInput.style.visualEffects).toEqual(style.visualEffects);
    } finally {
      effects.mockRestore();
    }
  });

  for (const kind of ["paclitaxel-like", "cholesterol-like"] as const) {
    it(`${kind}: emitted fill has zero intersection with its own ring-atom label boxes`, () => {
      const object = naturalProductLikeFixture(kind);
      const before = JSON.stringify(object);
      const fills = ringFixtureFills(object);
      expect(fills.length).toBeGreaterThanOrEqual(4);
      expect(planMoleculeAtomLabels(object).some((plan) => plan.label === "Me")).toBe(true);
      for (const fill of fills) {
        const ring = nativeMoleculeRings(object).find((ring) => ring.ringKey === fill.attrs["data-ring-key"])!;
        for (const label of planMoleculeAtomLabels(object).filter((plan) => ring.atomIds.includes(plan.atom.id))) {
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

  it("emits the usual glyph halo for notched labels, retaining other backgrounds", () => {
    const object = filledRingFixture();
    object.atoms[0]!.element = "O";
    object.atoms.push({ id: "outside", element: "O", x: 240, y: 140, formalCharge: 0 });
    object.style.atomLabelBackgroundColor = "#ffffff";
    const fragments = ringFixtureFragments(object);
    expect(ringFixtureFills(object)[0]!.attrs.d).not.toBe(nativeMoleculeRings(object)[0]!.pathD);
    const halo = fragments.find((fragment) => fragment.key === "label-run-halo-notched-ring-a0-0")!;
    expect(halo.attrs).toMatchObject({
      fill: "#ffffff", stroke: "#ffffff", "stroke-linejoin": "round", "stroke-linecap": "round"
    });
    expect(Number(halo.attrs["stroke-width"])).toBeCloseTo(atomLabelHaloWidthPx(planMoleculeAtomLabels(object)[0]!.drawingStyle), 3);
    expect(fragments.some((fragment) => fragment.key.startsWith("label-run-halo-notched-ring-outside"))).toBe(true);
    expect(fragments.some((fragment) => fragment.tag === "rect")).toBe(false);
  });

  for (const scale of [0.936, 1, 1.08]) {
    it(`contains the complete halo extent including scripts at depth scale ${scale}`, () => {
      const object = filledRingFixture();
      Object.assign(object.atoms[0]!, { element: "N", formalCharge: 1, labelOffset: { x: 40, y: 40 } });
      object.style.atomLabelFontSizes = { a0: 23 };
      object.style.atomLabelBackgroundColor = "#ffffff";
      const plan = planMoleculeAtomLabels(object)[0]!;
      expect(plan.layout.runs.some((run) => run.script === "superscript")).toBe(true);
      const haloExtent = atomLabelHaloWidthPx(plan.drawingStyle) * scale / 2;
      const box = labelBox(plan, scale);
      const haloBox = {
        x: box.x - haloExtent, y: box.y - haloExtent,
        width: box.width + 2 * haloExtent, height: box.height + 2 * haloExtent
      };
      const path = notchedRingPath(nativeMoleculeRings(object)[0]!.points, [atomLabelRingClearance(plan, scale)]);
      expect(fillAreaInsideBox(path.pathD, haloBox)).toBeLessThan(0.001);
    });

    it(`bounds a single-letter clearance to the layout height plus halo and air at scale ${scale}`, () => {
      const object = filledRingFixture();
      object.atoms[0]!.element = "O";
      object.style.atomLabelBackgroundColor = "#ffffff";
      const plan = planMoleculeAtomLabels(object)[0]!;
      const clearance = atomLabelRingClearance(plan, scale);
      // Layout has no measured ink box; its height is the conservative text-height fallback.
      const haloExtent = atomLabelHaloWidthPx(plan.drawingStyle) * scale / 2;
      const limit = plan.layout.bounds.height * scale + 2 * (haloExtent + 1.5 * scale);
      expect(clearance.bounds.width).toBeLessThanOrEqual(limit);
      expect(clearance.bounds.height).toBeLessThanOrEqual(limit);
      expect(clearance.bounds.height).toBeCloseTo(plan.layout.bounds.height * scale + 2 * (haloExtent + scale), 5);
      expect(clearance.radius).toBeGreaterThan(0);
    });
  }

  it("keeps an unfilled molecule byte-identical to its pre-change renderer digest", () => {
    // Existing pre-change fixture/digest, also guarded by sketchTicks.test.ts; never refreshed.
    const digest = createHash("sha256").update(JSON.stringify(renderRingFixture(sketchRegressionMolecule(false)))).digest("hex");
    expect(digest).toBe("dee8f9e869c7490ada2efce7ae5ae3fec5d374da30ac8662b5c0d67a9ee8311a");
  });
});
