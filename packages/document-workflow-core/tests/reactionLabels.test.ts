import { describe, expect, it } from "vitest";
import {
  createEmptyDocument, nativeTextStyleFromObjectStyle, type TextObject, type TextSpan
} from "@chemdraft/chem-core";
import {
  planPageSvgRender, planReactionArrowGeometry, reactionArrowVerticalExtent,
  type PageSvgElementFragment, type PageSvgFragment
} from "@chemdraft/layout-engine";
import {
  estimateNativeTextLineWidth, estimateNativeTextSpanLineWidth,
  layoutReactionLabels, layoutReactionScheme, planReactionLabels, type ReactionLabelsOptions
} from "../src/index";

const above = ["Ti(OiPr)4 (5 mol%)", "(+)-DET (6 mol%)", "t-BuOOH"];
const below = ["CH2Cl2, −20 °C, 4 h"];
const caption = "DET enantiomer chosen for the drawn product.";
const defaults: ReactionLabelsOptions = {
  above, below, caption, bondLength: 22, textStyle: { fontSizePx: 15 }, arrowKind: "forward"
};

function labels(options: Partial<ReactionLabelsOptions> = {}) {
  const plan = planReactionLabels({ ...defaults, ...options });
  return {
    plan,
    ...layoutReactionLabels(plan, {
      arrowMidpoint: { x: 200, y: 120 },
      schemeBounds: { minX: 20, minY: 90, maxX: 380, maxY: 150 }, idPrefix: "label"
    })
  };
}

function scripts(object: TextObject): Array<{ text: string; script: TextSpan["script"]; offset: number }> {
  let offset = 0;
  return object.spans.map((span) => {
    const result = { text: span.text, script: span.script, offset };
    offset += span.text.length;
    return result;
  }).filter((span) => span.script !== "normal");
}

function elements(fragment: PageSvgFragment): PageSvgElementFragment[] {
  return fragment.kind === "text" ? [] : [fragment, ...fragment.children.flatMap(elements)];
}

function content(fragment: PageSvgFragment): string {
  return fragment.kind === "text" ? fragment.text : fragment.children.map(content).join("");
}

describe("reaction label policy", () => {
  it("subscripts counts in agent formulas while retaining Unicode charges", () => {
    const result = labels({ above: ["HSO4⁻, NH4⁺, SO4²⁻"], below: [], caption: undefined });
    expect(result.above!.text).toBe("HSO4⁻, NH4⁺, SO4²⁻");
    expect(scripts(result.above!).map(span => span.text)).toEqual(["4", "4", "4"]);
  });
  it("stacks the Sharpless lines with exactly the formula subscripts and a text-sized arrow", () => {
    const result = labels();
    expect(result.above!.text.split("\n")).toEqual(above);
    expect(result.below!.text.split("\n")).toEqual(below);
    expect(result.caption!.text).toBe(caption);
    expect(scripts(result.above!)).toEqual([{ text: "4", script: "subscript", offset: 8 }]);
    expect(scripts(result.below!)).toEqual([
      { text: "2", script: "subscript", offset: 2 }, { text: "2", script: "subscript", offset: 5 }
    ]);
    for (const object of [result.above!, result.below!, result.caption!]) {
      expect(object.spans.map((span) => span.text).join("")).toBe(object.text);
      expect(nativeTextStyleFromObjectStyle(object.style).textAlign).toBe("center");
      expect(object.x + object.width / 2).toBeCloseTo(200);
    }
    expect(result.plan.arrowLength).toBeCloseTo(Math.max(55, Math.max(result.above!.width, result.below!.width) + 11));
    const extent = reactionArrowVerticalExtent("forward", result.plan.arrowLength);
    expect(result.above!.y + 3 * 1.2 * 15).toBeCloseTo(120 + extent.top - 0.35 * 15);
    expect(result.below!.y).toBeCloseTo(120 + extent.bottom + 0.35 * 15);
    expect(result.caption!.y).toBeCloseTo(Math.max(150, result.below!.y + result.below!.height) + 0.8 * 15);
  });

  it.each([{ lines: [] }, { lines: ["heat"] }])("keeps the 2.5-bond arrow minimum for $lines", ({ lines }) => {
    const result = labels({ above: lines, below: [], caption: undefined });
    expect(result.plan.arrowLength).toBe(55);
    expect(result.below).toBeUndefined();
    expect(result.caption).toBeUndefined();
    if (!lines.length) expect(result.above).toBeUndefined();
  });

  it("preserves numbered steps and centres the left-aligned visible block", () => {
    const result = labels({ above: ["1. NaBH4, MeOH", "2. H3O+"], below: [] });
    expect(result.above!.text).toBe("1. NaBH4, MeOH\n2. H3O+");
    expect(nativeTextStyleFromObjectStyle(result.above!.style).textAlign).toBe("left");
    expect(result.above!.x + result.plan.above!.size.contentWidth / 2).toBeCloseTo(200);
    expect(scripts(result.above!)).toEqual([
      { text: "4", script: "subscript", offset: 7 },
      { text: "3", script: "subscript", offset: 19 },
      { text: "+", script: "superscript", offset: 21 }
    ]);
    expect(labels({ above: ["1. heat", "then stir"], below: [] }).above!.style.textAlign).toBe("center");
  });

  it("keeps numbered authored steps left-aligned after wrapping", () => {
    const result = labels({ above: ["1. NaBH4, MeOH, then a long enough instruction to wrap", "2. H3O+"], below: [] });
    expect(result.above!.text.split("\n").length).toBeGreaterThan(2);
    expect(result.above!.style.textAlign).toBe("left");
    expect(labels({ above: ["1. heat\n2. stir"], below: [] }).above!.style.textAlign).toBe("left");
    expect(labels({ above: ["1. heat\nthen stir"], below: [] }).above!.style.textAlign).toBe("center");
  });

  it.each(["\u00a0", "\u202f"])("never wraps at the non-breaking space %j", (space) => {
    const temperature = `−20${space}°C`;
    // The token is wider than the wrapping width; a break inside it would be tempting.
    const result = labels({ above: [`heat\t${temperature} stir`], below: [], bondLength: 2 });
    expect(result.above!.text.split("\n")).toEqual(["heat", temperature, "stir"]);
  });

  it.each([
    ["1. NaBH4, MeOH", "2. H3O+"], ["1. I"], ["NaBH4, MeOH", "H3O+"], ["I"]
  ])("centres the visible block using the renderer's text x: %j", (...above) => {
    const result = labels({ above, below: [], caption: undefined });
    const object = result.above!;
    const fragments = planPageSvgRender({ ...createEmptyDocument().pages[0]!, objects: [object] }).fragments.flatMap(elements);
    const rendered = fragments.find((fragment) => fragment.key === `object-${object.id}`)!;
    const x = Number(rendered.attrs.x);
    const style = nativeTextStyleFromObjectStyle(object.style);
    const widest = result.plan.above!.size.contentWidth;
    expect(rendered.attrs["text-anchor"]).toBe(style.textAlign === "left" ? "start" : "middle");
    const visibleCenter = style.textAlign === "left" ? x + widest / 2 : x;
    expect(Math.abs(visibleCenter - 200)).toBeLessThanOrEqual(0.5);
  });

  it("splits explicit newlines, drops blanks, and supports a below-only scheme", () => {
    const result = labels({ above: ["", " \n\t"], below: ["CH2Cl2\n−78 °C", "", "2 h\r\n "] });
    expect(result.above).toBeUndefined();
    expect(result.below!.text).toBe("CH2Cl2\n−78 °C\n2 h");
    expect(result.below!.spans.map((span) => span.text).join("")).toBe(result.below!.text);
    expect(scripts(result.below!).map((span) => span.text)).toEqual(["2", "2"]);
  });

  it("wraps at whitespace using span widths and leaves an oversized formula token whole", () => {
    const token = "CH2".repeat(40);
    const result = labels({ above: [`CH2Cl2 CH2Cl2 CH2Cl2 CH2Cl2 CH2Cl2 CH2Cl2 ${token} heat`], below: [] });
    const lines = result.above!.text.split("\n");
    expect(lines).toEqual(["CH2Cl2 CH2Cl2 CH2Cl2 CH2Cl2", "CH2Cl2 CH2Cl2", token, "heat"]);
    const style = nativeTextStyleFromObjectStyle(result.above!.style);
    for (const line of lines.filter((line) => line !== token)) {
      const spans = planReactionLabels({ ...defaults, above: [line], below: [] }).above!.spans;
      expect(estimateNativeTextSpanLineWidth(spans, style)).toBeLessThanOrEqual(220);
    }
    expect(result.above!.width).toBeGreaterThan(240);
    expect(result.plan.arrowLength).toBeCloseTo(result.above!.width + 11);
  });

  it.each(["forward", "equilibrium", "resonance", "retrosynthesis"] as const)("clears the visible %s arrow geometry", (arrowKind) => {
    const result = labels({ arrowKind });
    const geometry = planReactionArrowGeometry(arrowKind, { x: 0, y: 0 }, { x: result.plan.arrowLength, y: 0 });
    const ys = [...geometry.lines.flatMap((line) => [line.start.y, line.end.y]),
      ...geometry.heads.flatMap((head) => head.points.map((point) => point.y))];
    const extent = reactionArrowVerticalExtent(arrowKind, result.plan.arrowLength);
    expect(extent.top).toBeLessThanOrEqual(Math.min(...ys));
    expect(extent.bottom).toBeGreaterThanOrEqual(Math.max(...ys));
    expect(result.above!.y + 54).toBeCloseTo(120 + extent.top - 5.25);
    expect(result.below!.y).toBeCloseTo(120 + extent.bottom + 5.25);
  });

  it("uses 72% script sizes with continuous letter spacing and explicit-line height", () => {
    const style = nativeTextStyleFromObjectStyle({ fontSizePx: 15, letterSpacingPx: 2 });
    const spans: TextSpan[] = [
      { text: "H", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} }
    ];
    expect(estimateNativeTextSpanLineWidth(spans, style)).toBeCloseTo(15 * 0.62 * 2 + 15 * 0.72 * 0.62 + 4);
    expect(estimateNativeTextSpanLineWidth(spans, style)).toBeLessThan(estimateNativeTextLineWidth("H2O", style));
    const result = labels({ above: ["H2O\nCH2Cl2"], textStyle: { fontSizePx: 15, lineHeight: 1.5, paragraphSpacingPx: 3 } });
    expect(result.above!.height).toBe(2 * 15 * 1.5 + 3 + 4);
    expect(result.above!.y + 48).toBeCloseTo(120 - 4.5 - 5.25);
  });

  it("wraps a caption to at least eight bonds even under a narrow scheme", () => {
    const plan = planReactionLabels({ ...defaults, above: [], below: [], caption: "CH2Cl2 ".repeat(8) });
    const result = layoutReactionLabels(plan, {
      arrowMidpoint: { x: 100, y: 120 },
      schemeBounds: { minX: 70, minY: 110, maxX: 130, maxY: 130 }, idPrefix: "narrow"
    });
    expect(result.caption!.text.split("\n")).toEqual([
      "CH2Cl2 CH2Cl2 CH2Cl2", "CH2Cl2 CH2Cl2 CH2Cl2", "CH2Cl2 CH2Cl2"
    ]);
    expect(result.caption!.x + result.caption!.width / 2).toBe(100);
    expect(scripts(result.caption!).every((span) => span.text === "2" && span.script === "subscript")).toBe(true);
  });

  it("renders the planned lines and script spans through the canvas/export page renderer", () => {
    const molecule = {
      id: "mol", type: "molecule" as const, x: 0, y: 0, width: 40, height: 20,
      rotation: 0, style: {}, structureFormat: "smiles" as const, structure: "C",
      atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0 }], bonds: [], superatoms: [], rGroups: []
    };
    const result = layoutReactionScheme({
      ...defaults, reactants: [{ molecule, bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 } }], products: [],
      anchor: { x: 24, y: 120 }, gutter: 24, pagePadding: 24
    });
    const numbered = labels({ above: ["1. NaBH4, MeOH", "2. H3O+"], below: [] }).above!;
    const wrapped = labels({ above: ["CH2Cl2 ".repeat(30)], below: [], caption: "CH2Cl2 ".repeat(60) });
    // Include an overlong token to pin the old renderer/measurement disagreement above 240 px.
    const oversized = labels({ above: ["CH2".repeat(40)], below: [] }).above!;
    const objects = [result.above!, result.below!, result.caption!,
      { ...numbered, id: "numbered" }, { ...wrapped.above!, id: "wrapped" },
      { ...wrapped.caption!, id: "wrapped_caption" }, { ...oversized, id: "oversized" }];
    const page = { ...result.document.pages[0]!, objects: [...result.document.pages[0]!.objects, ...objects.slice(3)] };
    const fragments = planPageSvgRender(page).fragments.flatMap(elements);
    for (const object of objects) {
      const rendered = fragments.find((fragment) => fragment.key === `object-${object.id}`)!;
      expect(rendered.tag).toBe("text");
      const runs = rendered.children.filter((child): child is PageSvgElementFragment => child.kind === "element");
      const lines: PageSvgElementFragment[][] = [];
      for (const run of runs) {
        if (run.attrs.x !== undefined) lines.push([]);
        lines.at(-1)!.push(run);
      }
      expect(lines.map((line) => line.map(content).join(""))).toEqual(object.text.split("\n"));
      expect(runs.filter((run) => run.attrs["baseline-shift"] !== undefined).map((run) => ({
        text: content(run), shift: run.attrs["baseline-shift"], size: run.attrs["font-size"]
      }))).toEqual(object.spans.filter((span) => span.script !== "normal").map((span) => ({
        text: span.text, shift: span.script === "subscript" ? "sub" : "super", size: "72%"
      })));
      const style = nativeTextStyleFromObjectStyle(object.style);
      for (const [index, line] of lines.entries()) {
        const spans: TextSpan[] = line.map((run) => ({
          text: content(run), script: run.attrs["baseline-shift"] === "sub" ? "subscript"
            : run.attrs["baseline-shift"] === "super" ? "superscript" : "normal", style: {}
        }));
        expect(estimateNativeTextSpanLineWidth(spans, style)).toBeLessThanOrEqual(object.width + 2);
        expect(line[0].attrs.x).toBeCloseTo(style.textAlign === "left" ? object.x : object.x + object.width / 2);
        if (index > 0) expect(line[0].attrs.dy).toBe(style.fontSizePx * style.lineHeight + style.paragraphSpacingPx);
      }
    }
  });
});
