import { describe, expect, it } from "vitest";
import {
  createEmptyDocument, nativeTextStyleFromObjectStyle, type TextObject, type TextSpan
} from "@chemdraft/chem-core";
import {
  nativeTextMetrics, planPageSvgRender, planReactionArrowGeometry, reactionArrowHeadLengthPx, reactionArrowVerticalExtent,
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

function renderedLines(object: TextObject) {
  const rendered = planPageSvgRender({ ...createEmptyDocument().pages[0]!, objects: [object] })
    .fragments.flatMap(elements).find(fragment => fragment.key === `object-${object.id}`)!;
  let baseline = Number(rendered.attrs.y);
  const lines: Array<{ x: number; baseline: number; runs: PageSvgElementFragment[] }> = [];
  for (const run of rendered.children) {
    if (run.kind !== "element") continue;
    if (run.attrs.x !== undefined) {
      baseline += Number(run.attrs.dy ?? 0);
      lines.push({ x: Number(run.attrs.x), baseline, runs: [] });
    }
    lines.at(-1)!.runs.push(run);
  }
  return { rendered, lines };
}

function renderedInkEnvelope(line: ReturnType<typeof renderedLines>["lines"][number], fontSize: number) {
  const bounds = line.runs.map(run => {
    const shift = run.attrs["baseline-shift"];
    const size = typeof run.attrs["font-size"] === "string" && run.attrs["font-size"].endsWith("%")
      ? fontSize * parseFloat(run.attrs["font-size"]) / 100 : Number(run.attrs["font-size"] ?? fontSize);
    // The renderer uses font-dependent SVG sub/super offsets; bound each by 0.6 script em.
    const baseline = line.baseline + (shift === "sub" ? 0.6 * size : shift === "super" ? -0.6 * size : 0);
    return { top: baseline - 0.716 * size, bottom: baseline + 0.21 * size };
  });
  return { top: Math.min(...bounds.map(bound => bound.top)), bottom: Math.max(...bounds.map(bound => bound.bottom)) };
}

describe("reaction label policy", () => {
  it("places Sharpless ink against the shaft and reserves both arrowheads at 14 px", () => {
    const result = labels({ textStyle: { fontSizePx: 14 }, bondLength: 28 });
    const lastAbove = renderedLines(result.above!).lines.at(-1)!.baseline;
    const firstBelow = renderedLines(result.below!).lines[0]!.baseline;
    expect(Math.abs((120 - lastAbove) - (0.75 + 0.3 * 14 + 0.21 * 14))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((firstBelow - 0.716 * 14 - 120) - (0.75 + 0.3 * 14))).toBeLessThanOrEqual(0.5);
    expect(result.plan.arrowLength).toBeCloseTo(Math.max(70,
      Math.max(result.plan.above!.size.contentWidth, result.plan.below!.size.contentWidth) + 2 * (9 + 0.25 * 14)));
  });

  it.each(["2. H3O+", "2. heat"])("centres numbered script content and clears the next line %s", (next) => {
    const result = labels({ above: ["1. NaBH4, MeOH", next], below: [], textStyle: { fontSizePx: 14 } });
    const plain = labels({ above: ["1. heat", "2. stir"], below: [], textStyle: { fontSizePx: 14 } });
    const { lines } = renderedLines(result.above!);
    expect(Math.abs(lines[0]!.x + result.plan.above!.size.contentWidth / 2 - 200)).toBeLessThanOrEqual(0.5);
    expect(result.above!.style.lineHeight).toBeGreaterThan(plain.above!.style.lineHeight as number);
    const firstInk = renderedInkEnvelope(lines[0]!, 14);
    const nextInk = renderedInkEnvelope(lines[1]!, 14);
    expect(nextInk.top - firstInk.bottom).toBeGreaterThanOrEqual(0.12 * 14 - 0.001);
    const style = nativeTextStyleFromObjectStyle(result.above!.style);
    expect(result.plan.above!.size.lineBoxHeight).toBeCloseTo(2 * 14 * style.lineHeight);
    expect(result.above!.height).toBeCloseTo(Math.round((2 * 14 * style.lineHeight + 4) * 100) / 100);
  });

  it("merges adjacent runs without changing formula scripts or authored spaces", () => {
    const result = labels();
    expect(result.below!.spans).toEqual([
      { text: "CH", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: "Cl", script: "normal", style: {} },
      { text: "2", script: "subscript", style: {} },
      { text: ", −20 °C, 4 h", script: "normal", style: {} }
    ]);
    expect(result.below!.spans.map(span => span.text).join("")).toBe(below[0]);
    expect(labels({ above: ["1. NaBH4", "2. H3O+"], below: [] }).above!.spans).toEqual([
      { text: "1. NaBH", script: "normal", style: {} },
      { text: "4", script: "subscript", style: {} },
      { text: "\n", script: "normal", style: {} },
      { text: "2. H", script: "normal", style: {} },
      { text: "3", script: "subscript", style: {} },
      { text: "O", script: "normal", style: {} },
      { text: "+", script: "superscript", style: {} }
    ]);
  });
  it("keeps captions plain while formatting above-arrow formulas", () => {
    const captionText = "SN2 pathway; H2 uptake; C2-symmetric ligand; CH2Cl2 used";
    const result = labels({ above: ["CH2Cl2"], below: [], caption: captionText, bondLength: 100 });
    expect(result.caption!.text).toBe(captionText);
    expect(result.caption!.spans.map(span => span.text).join("")).toBe(captionText);
    expect(result.caption!.spans.every(span => span.script === "normal")).toBe(true);
    expect(scripts(result.above!).map(span => span.text)).toEqual(["2", "2"]);
  });
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
    expect(result.plan.arrowLength).toBeCloseTo(Math.max(55,
      Math.max(result.plan.above!.size.contentWidth, result.plan.below!.size.contentWidth)
        + 2 * (reactionArrowHeadLengthPx + 0.25 * 15)));
    expect(renderedLines(result.above!).lines.at(-1)!.baseline).toBeCloseTo(120 - 0.75 - (0.3 + 0.21) * 15);
    expect(renderedLines(result.below!).lines[0]!.baseline - 0.716 * 15).toBeCloseTo(120 + 0.75 + 0.3 * 15);
    expect(result.caption!.y).toBeCloseTo(Math.max(150, result.below!.y + result.below!.height) + 0.8 * 15);
  });

  it.each([{ lines: [], length: 55 }, { lines: ["heat"], length: 57.9 }])("uses the minimum or head-padded arrow for $lines", ({ lines, length }) => {
    const result = labels({ above: lines, below: [], caption: undefined });
    expect(result.plan.arrowLength).toBeCloseTo(length);
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
    expect(result.plan.arrowLength).toBeCloseTo(result.plan.above!.size.contentWidth + 2 * (reactionArrowHeadLengthPx + 0.25 * 15));
  });

  it.each(["forward", "equilibrium", "resonance", "retrosynthesis", "unknown"] as const)("clears the visible %s arrow geometry", (arrowKind) => {
    const result = labels({ arrowKind });
    const geometry = planReactionArrowGeometry(arrowKind, { x: 0, y: 0 }, { x: result.plan.arrowLength, y: 0 });
    const ys = [...geometry.lines.flatMap((line) => [line.start.y, line.end.y]),
      ...geometry.heads.flatMap((head) => head.points.map((point) => point.y))];
    const extent = reactionArrowVerticalExtent(arrowKind, result.plan.arrowLength);
    expect(extent.top).toBeLessThanOrEqual(Math.min(...ys));
    expect(extent.bottom).toBeGreaterThanOrEqual(Math.max(...ys));
    const shaftYs = geometry.lines.filter(line => line.start.y === line.end.y)
      .flatMap(line => [line.start.y, line.end.y]);
    const lastBaseline = renderedLines(result.above!).lines.at(-1)!.baseline;
    const firstCapTop = renderedLines(result.below!).lines[0]!.baseline - 0.716 * 15;
    expect(lastBaseline + 0.21 * 15).toBeCloseTo(120 + Math.min(...shaftYs) - 0.75 - 0.3 * 15);
    expect(firstCapTop).toBeCloseTo(120 + Math.max(...shaftYs) + 0.75 + 0.3 * 15);
    // All text lies inside the head-free horizontal interval, even for the retro chevron.
    const headXs = [...geometry.heads.flatMap(head => head.points.map(point => point.x)),
      ...geometry.lines.filter(line => line.start.y !== line.end.y).flatMap(line => [line.start.x, line.end.x])];
    const widest = Math.max(result.plan.above!.size.contentWidth, result.plan.below!.size.contentWidth);
    const left = (result.plan.arrowLength - widest) / 2;
    expect(left).toBeGreaterThanOrEqual(reactionArrowHeadLengthPx + 0.25 * 15);
    expect(headXs.every(x => x < left || x > left + widest)).toBe(true);
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
    expect(renderedLines(result.above!).lines.at(-1)!.baseline).toBeCloseTo(120 - 0.75 - (0.3 + nativeTextMetrics.descentEm) * 15);
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
    expect(scripts(result.caption!)).toEqual([]);
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
