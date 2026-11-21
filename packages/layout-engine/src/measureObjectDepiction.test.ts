import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import {
  createEmptyDocument, GraphicObjectSchema, MoleculeObjectSchema, TextObjectSchema,
  nativeTextStyleFromObjectStyle, type DocumentObject
} from "@chemdraft/chem-core";
import { measureNativeTextSpanLineWidth, measureObjectDepiction, planPageSvgRender, planTextObjectSvg,
  type PageSvgElementFragment } from "./index";
import { elementFragments } from "./testing";

function scene(object: DocumentObject) {
  const page = { ...createEmptyDocument().pages[0]!, objects: [object] };
  const bounds = measureObjectDepiction(page, object)?.bounds;
  if (!bounds) throw new Error("Expected measured ink.");
  const { fragments } = planPageSvgRender(page);
  return { bounds, fragments, elements: fragments.flatMap(elementFragments) };
}

function rasterInk(fragments: readonly PageSvgElementFragment[]) {
  const markup = ({ tag, attrs, children }: PageSvgElementFragment): string => {
    const attributes = Object.entries(attrs).filter(([, value]) => value !== undefined)
      .map(([key, value]) => ` ${key}="${value}"`).join("");
    return `<${tag}${attributes}>${children.map(child => child.kind === "element" ? markup(child) : "").join("")}</${tag}>`;
  };
  const scale = 8;
  const size = 180;
  const { pixels, width, height } = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scale * size}" height="${scale * size}" viewBox="0 0 ${size} ${size}">${fragments.map(markup).join("")}</svg>`
  ).render();
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
  }
  expect(right).toBeGreaterThan(left);
  expect(bottom).toBeGreaterThan(top);
  return { edges: [left, top, right, bottom].map(edge => edge / scale), tolerance: 1 / scale };
}

describe("measured ink matches canvas geometry", () => {
  it("includes the centred atom-number glyphs outside the bond frame", () => {
    const molecule = MoleculeObjectSchema.parse({ id: "mol", type: "molecule", x: 0, y: 20, width: 20, height: 1,
      structure: "", structureFormat: "unknown", style: { atomIndicatorShowAtomNumbers: true },
      atoms: [{ id: "a", element: "C", x: 0, y: 20 }, { id: "b", element: "C", x: 20, y: 20 }],
      bonds: [{ id: "ab", fromAtomId: "a", toAtomId: "b", order: "single" }] });
    const { bounds, elements } = scene(molecule);
    const numbers = elements.filter(el => el.attrs["data-atom-indicator"] === "number");
    expect(numbers).toHaveLength(2);
    for (const { attrs } of numbers) {
      expect(attrs["dominant-baseline"]).toBe("central");
      expect(bounds.y).toBeLessThanOrEqual(Number(attrs.y) - Number(attrs["font-size"]) / 2);
      expect(bounds.x + bounds.width).toBeGreaterThan(Number(attrs.x));
    }
  });

  it("measures attached scripted conditions at the font size emitted on each run", () => {
    const text = TextObjectSchema.parse({ id: "conditions", type: "text", text: "TMMMMMMMM",
      x: 10, y: 10, width: 50, height: 20, style: { fontSizePx: 12, textAlign: "center" },
      spans: [{ text: "T", script: "normal", style: {} }, { text: "MMMMMMMM", script: "superscript", style: { fontSizePx: 48 } }],
      arrowAttachment: { kind: "conditions", parentObjectId: "arrow", side: "above",
        frame: { origin: { x: 0, y: 0 }, tangent: { x: 1, y: 0 }, normal: { x: 0, y: -1 } }, offset: { x: 0, y: 0 } } });
    const { bounds } = scene(text);
    const rendered = planTextObjectSvg(text, 0);
    const runs = elementFragments(rendered).filter(el => el.tag === "tspan" && el.children[0]?.kind === "text");
    expect(runs).toHaveLength(2);
    const emittedSpans = runs.map((run, index) => ({
      ...text.spans[index]!, script: "normal" as const, style: { fontSizePx: Number(run.attrs["font-size"]) }
    }));
    expect(bounds.width).toBeCloseTo(measureNativeTextSpanLineWidth(emittedSpans, nativeTextStyleFromObjectStyle(text.style)));
    expect(bounds.x + bounds.width / 2).toBeCloseTo(Number(rendered.attrs.x));
  });

  it.each(["path", "line"])("contains the rendered shafts and head of a retrosynthetic %s graphic", graphicKind => {
    const arrow = GraphicObjectSchema.parse({ id: "retro", type: "graphic", graphicKind, x: 0, y: 0, width: 100, height: 40,
      style: { strokeWidth: 2 }, data: { artPathKind: "line", dualShaft: true, dualShaftParallel: true,
        dualShaftGapPx: 5, lineStart: { x: 0, y: 20 }, lineEnd: { x: 100, y: 20 } } });
    const { bounds, elements } = scene(arrow);
    const path = elements.find(el => el.tag === "path" && el.attrs.class === "graphic-glyph-stroke graphic-glyph-path");
    expect(path).toBeDefined();
    const vertices = [...String(path!.attrs.d).matchAll(/[ML] ([-.\d]+) ([-.\d]+)/g)];
    expect(vertices.length).toBeGreaterThan(4);
    const ys = vertices.map(match => Number(match[2]));
    const radius = Number(path!.attrs["stroke-width"]) / 2;
    expect(bounds.y).toBeCloseTo(Math.min(...ys) - radius);
    expect(bounds.y + bounds.height).toBeCloseTo(Math.max(...ys) + radius);
  });

  it.each([
    ["square", "round"], ["round", "round"], ["butt", "round"], ["butt", "miter"], ["butt", "bevel"]
  ])("matches raster ink for a rotated arrow with %s caps and %s joins", (strokeLineCap, strokeLineJoin) => {
    const arrow = GraphicObjectSchema.parse({ id: "rotated", type: "graphic", graphicKind: "path", rotation: 45,
      x: 30, y: 60, width: 100, height: 20, style: { strokeWidth: 10, strokeLineCap, strokeLineJoin },
      data: { artPathKind: "line", dualShaft: true, dualShaftParallel: true, dualShaftGapPx: 5,
        lineStart: { x: 30, y: 70 }, lineEnd: { x: 130, y: 70 } } });
    const { bounds, fragments } = scene(arrow);
    const { edges, tolerance } = rasterInk(fragments);
    const measured = [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height];
    measured.forEach((edge, i) => expect(Math.abs(edge - edges[i]!)).toBeLessThanOrEqual(tolerance));
  });
});
