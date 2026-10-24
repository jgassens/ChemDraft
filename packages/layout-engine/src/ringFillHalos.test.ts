import { createHash } from "node:crypto";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import { nativeMoleculeRings, planMoleculeAtomLabels, planPageSvgRender } from "./index";
import { elementFragments } from "./testing";
import { ringHaloDocument, ringHaloStyles } from "./ringFillHalos.fixture";
import { sketchRegressionMolecule } from "./sketchRegression.fixture";

describe("ring fills and glyph halos", () => {
  for (const name of ["pyridinium", "blue-box", "oxathiazinane"] as const) {
    for (const style of ["light", "solid", "vivid"] as const) {
      it(`${name} ${style}: plain polygons and clipped fill-matched halos without chemistry changes`, () => {
        const { document, object } = ringHaloDocument(name, style);
        const before = JSON.stringify(object);
        const fragments = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
        const rings = nativeMoleculeRings(object);
        const fills = fragments.filter((f) => f.attrs["data-molecule-fill-ring"] === "true");
        expect(fills).toHaveLength(rings.length);
        for (const fill of fills) {
          expect(fill.attrs.d).toBe(rings.find((r) => r.ringKey === fill.attrs["data-ring-key"])!.pathD);
          expect(fill.attrs["fill-rule"]).toBeUndefined();
          expect(String(fill.attrs.d).match(/M/g)).toHaveLength(1);
        }
        for (const label of planMoleculeAtomLabels(object)) {
          const group = fragments.find((f) => f.key === `label-${object.id}-${label.atom.id}`)!;
          const halos = group.children.flatMap(elementFragments).filter((f) => f.attrs["data-label-halo-ring"]);
          expect(halos.length).toBeGreaterThan(0);
          for (const ring of rings.filter((r) => r.atomIds.includes(label.atom.id))) {
            expect(halos.some((halo) => halo.attrs["data-label-halo-ring"] === ring.ringKey)).toBe(true);
          }
          const strokes = group.children.flatMap(elementFragments).filter((f) => f.attrs.class === "native-atom-label-halo");
          expect(strokes).toHaveLength(label.layout.runs.length);
          expect(strokes.every((stroke) => String(stroke.attrs.stroke).startsWith("url(#label-halo-"))).toBe(true);
          // The paint server composites paper and clipped fills before glyph antialiasing.
          expect(group.children.flatMap(elementFragments).some((f) => f.tag === "rect" && f.attrs.fill === "#ffffff")).toBe(true);
          for (const halo of halos) {
            const fill = fills.find((f) => f.attrs["data-ring-key"] === halo.attrs["data-label-halo-ring"])!;
            expect(halo.children.flatMap(elementFragments)[0]!.attrs["fill-opacity"] ?? 1).toBe(ringHaloStyles[style].opacity);
            const clipId = String(halo.attrs["clip-path"]).slice(5, -1);
            const clip = fragments.find((f) => f.attrs.id === clipId)!;
            expect(clip.children.flatMap(elementFragments).find((f) => f.tag === "path")!.attrs.d).toBe(fill.attrs.d);
            for (const run of halo.children.flatMap(elementFragments)) {
              expect(run.attrs.fill).toBe(fill.attrs.fill);
              expect(run.attrs.filter).toBeUndefined();
              expect(run.attrs.stroke).toBe("none");
            }
          }
        }
        expect(JSON.stringify(object)).toBe(before);
      });
    }
  }
  it("preserves transparent and explicitly coloured label backgrounds", () => {
    const { document, object } = ringHaloDocument("oxathiazinane", "solid");
    object.style.atomLabelBackgroundColors = { a1: "transparent", a3: "#fff0c2" };
    const fragments = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
    const oxygen = fragments.find((f) => f.key === `label-${object.id}-a1`)!;
    expect(oxygen.children.flatMap(elementFragments).some((f) => f.attrs.class === "native-atom-label-halo")).toBe(false);
    const sulfur = fragments.find((f) => f.key === `label-${object.id}-a3`)!;
    expect(sulfur.children.flatMap(elementFragments).filter((f) => f.attrs.class === "native-atom-label-halo")
      .every((f) => f.attrs.stroke === "#fff0c2")).toBe(true);
    expect(sulfur.children.flatMap(elementFragments).some((f) => f.attrs["data-label-halo-ring"])).toBe(false);
  });
  it("keeps an explicitly white ring-atom halo while default halos match the fill", () => {
    const { document, object } = ringHaloDocument("oxathiazinane", "solid"); // C1OCSCN1
    object.style.atomLabelBackgroundColors = { a1: "#ffffff" };
    const fragments = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
    const labels = planMoleculeAtomLabels(object);
    expect(labels.map((label) => label.atom.element)).toEqual(["O", "S", "N"]);
    for (const label of labels) {
      const group = fragments.find((f) => f.key === `label-${object.id}-${label.atom.id}`)!;
      const children = group.children.flatMap(elementFragments);
      const strokes = children.filter((f) => f.attrs.class === "native-atom-label-halo");
      expect(strokes).toHaveLength(label.layout.runs.length);
      if (label.atom.id === "a1") {
        expect(strokes.every((f) => f.attrs.stroke === "#ffffff")).toBe(true);
        expect(children.some((f) => f.attrs["data-label-halo-ring"])).toBe(false);
      } else {
        expect(strokes.every((f) => String(f.attrs.stroke).startsWith("url(#label-halo-"))).toBe(true);
        expect(children.some((f) => f.attrs["data-label-halo-ring"])).toBe(true);
      }
    }
  });
  it.each(["linear-gradient", "radial-gradient"] as const)("keeps %s paint coordinates and ring effects off halos", (kind) => {
    const { document, object } = ringHaloDocument("pyridinium", "solid");
    const ring = nativeMoleculeRings(object)[0]!;
    object.style.ringStyles = { [ring.ringKey]: {
      fillPaint: { kind, units: "object", x1: 0, y1: 0, x2: 1, y2: 1, cx: 0.5, cy: 0.5, r: 0.5,
        stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] },
      visualEffects: [{ kind: "sketch" }, { kind: "shadow" }, { kind: "glow" }]
    } };
    const fragments = planPageSvgRender(document.pages[0]!).fragments.flatMap(elementFragments);
    const gradients = fragments.filter((f) => f.tag === (kind === "linear-gradient" ? "linearGradient" : "radialGradient"));
    expect(gradients).toHaveLength(1); // The pattern reuses the original page-space gradient.
    expect(gradients[0]!.attrs.gradientUnits).toBe("userSpaceOnUse");
    const pattern = fragments.find((f) => f.tag === "pattern")!;
    expect(pattern.children.flatMap(elementFragments).find((f) => f.attrs.transform)!.attrs.transform).toContain("translate(");
    const paint = pattern.children.flatMap(elementFragments).find((f) => f.tag === "path")!;
    expect(paint.attrs.fill).toBe(`url(#${gradients[0]!.attrs.id})`);
    const fills = fragments.filter((f) => f.attrs["data-molecule-fill-ring"] === "true");
    expect(fills[0]!.attrs.d).toBe(ring.pathD);
    for (const group of fragments.filter((f) => f.attrs["data-label-halo-ring"])) {
      expect(group.attrs.filter).toBeUndefined();
      expect(group.children.flatMap(elementFragments).every((f) => f.attrs.filter === undefined)).toBe(true);
    }
  });
  it("leaves a carbon-only toluene ring byte-identical to the previous renderer", () => {
    const { document } = ringHaloDocument("toluene", "solid");
    expect(createHash("sha256").update(JSON.stringify(planPageSvgRender(document.pages[0]!))).digest("hex"))
      .toBe("9639b8f78f402df25723215602f3343e9d6a333067c19d1e8287adcda25f9d7e");
  });
  it("leaves the unfilled renderer byte-identical", () => {
    const plan = planPageSvgRender({ ...createEmptyDocument({ now: "2026-01-01T00:00:00.000Z" }).pages[0]!,
      objects: [sketchRegressionMolecule(false)] });
    expect(createHash("sha256").update(JSON.stringify(plan)).digest("hex"))
      .toBe("dee8f9e869c7490ada2efce7ae5ae3fec5d374da30ac8662b5c0d67a9ee8311a");
  });
});
