import { describe, expect, it } from "vitest";
import type { TextObject } from "@chemdraft/chem-core";
import {
  nativeTextObjectBoxHeight, nativeTextObjectLineMetrics, nativeTextSpanMetrics, planNativeTextEditorLayout, planTextObjectSvg
} from "./index";

type Fragment = { tag?: string; attrs?: Record<string, unknown>; children?: Fragment[]; text?: string };

function textObject(spans: TextObject["spans"], extra: Partial<TextObject> = {}): TextObject {
  return {
    id: "c1", type: "text", x: 100, y: 50, width: 200, height: 120, rotation: 0,
    style: { fontFamily: "Arial", fontSizePx: 40, lineHeight: 1.2 },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    text: spans.map(span => span.text).join(""), spans, ...extra
  } as TextObject;
}

// A scripted conditions label: a sized and an unsized subscript, an unsized and a sized superscript.
const conditionsSpans: TextObject["spans"] = [
  { text: "H", script: "normal", style: {} }, { text: "2", script: "subscript", style: { fontSizePx: 12 } },
  { text: "O, CH", script: "normal", style: {} }, { text: "4", script: "subscript", style: {} },
  { text: "\nx", script: "normal", style: {} }, { text: "3", script: "superscript", style: {} },
  { text: "y", script: "normal", style: { fontSizePx: 20 } }, { text: "+", script: "superscript", style: { fontSizePx: 12 } }
];
const conditions = textObject(conditionsSpans, {
  arrowAttachment: { kind: "conditions", parentObjectId: "arrow", side: "above", offset: { x: 0, y: 0 } }
} as Partial<TextObject>);

/** Every tspan with text, in document order, with the absolute baseline it is drawn at. */
function drawnRuns(svg: Fragment): Array<{ text: string; y: number; fontSize: number }> {
  const result: Array<{ text: string; y: number; fontSize: number }> = [];
  const parentFont = Number(svg.attrs!["font-size"]);
  let y = Number(svg.attrs!.y);
  const visit = (run: Fragment) => {
    if (run.attrs!.y !== undefined) y = Number(run.attrs!.y);
    y += Number(run.attrs!.dy ?? 0);
    const nested = run.children?.filter(child => child.tag === "tspan") ?? [];
    if (nested.length) { nested.forEach(visit); return; }
    const size = run.attrs!["font-size"];
    result.push({ text: run.children!.map(child => child.text ?? "").join(""), y,
      fontSize: size === undefined ? parentFont : parseFloat(String(size)) });
  };
  (svg.children ?? []).forEach(visit);
  return result;
}

describe("script run metrics", () => {
  it("draws reaction conditions with scripts exactly as in 1.2.3 (pinned)", () => {
    // Pinned before the editor's metrics were aligned with the text box renderer. The
    // conditions renderer keeps its own script sizes and offsets in this release.
    expect(JSON.parse(JSON.stringify({
      svg: planTextObjectSvg(conditions, 0), metrics: nativeTextObjectLineMetrics(conditions),
      spans: conditionsSpans.map(span => nativeTextSpanMetrics(span, conditions.style))
    }))).toEqual({"svg":{"kind":"element","key":"object-c1","tag":"text","attrs":{"data-object-id":"c1","data-layer-index":0,"data-object-type":"text","x":100,"y":90,"font-family":"Arial","font-size":40,"font-weight":400,"font-style":"normal","text-decoration":"none","letter-spacing":0,"text-anchor":"start","fill":"#111111"},"children":[{"kind":"element","key":"text-line-0","tag":"tspan","attrs":{"x":100,"y":90},"children":[{"kind":"element","key":"text-run-0-0","tag":"tspan","attrs":{"font-size":40},"children":[{"kind":"text","key":"text-run-content-0-0","text":"H"}]},{"kind":"element","key":"text-run-0-1","tag":"tspan","attrs":{"dy":2.64,"font-size":8.64},"children":[{"kind":"text","key":"text-run-content-0-1","text":"2"}]},{"kind":"element","key":"text-run-0-2","tag":"tspan","attrs":{"dy":-2.64,"font-size":40},"children":[{"kind":"text","key":"text-run-content-0-2","text":"O, CH"}]},{"kind":"element","key":"text-run-0-3","tag":"tspan","attrs":{"dy":8.8,"font-size":28.8},"children":[{"kind":"text","key":"text-run-content-0-3","text":"4"}]}]},{"kind":"element","key":"text-line-1","tag":"tspan","attrs":{"x":100,"y":150.8},"children":[{"kind":"element","key":"text-run-1-0","tag":"tspan","attrs":{"font-size":40},"children":[{"kind":"text","key":"text-run-content-1-0","text":"x"}]},{"kind":"element","key":"text-run-1-1","tag":"tspan","attrs":{"dy":-16,"font-size":28.8},"children":[{"kind":"text","key":"text-run-content-1-1","text":"3"}]},{"kind":"element","key":"text-run-1-2","tag":"tspan","attrs":{"dy":16,"font-size":20},"children":[{"kind":"text","key":"text-run-content-1-2","text":"y"}]},{"kind":"element","key":"text-run-1-3","tag":"tspan","attrs":{"dy":-4.8,"font-size":8.64},"children":[{"kind":"text","key":"text-run-content-1-3","text":"+"}]}]}]},"metrics":{"lines":[{"spans":[{"text":"H","script":"normal","style":{}},{"text":"2","script":"subscript","style":{"fontSizePx":12}},{"text":"O, CH","script":"normal","style":{}},{"text":"4","script":"subscript","style":{}}],"baseline":40,"ascent":32,"descent":14.560000000000002},{"spans":[{"text":"x","script":"normal","style":{}},{"text":"3","script":"superscript","style":{}},{"text":"y","script":"normal","style":{"fontSizePx":20}},{"text":"+","script":"superscript","style":{"fontSizePx":12}}],"baseline":100.80000000000001,"ascent":39.040000000000006,"descent":8}],"height":110.80000000000001},"spans":[{"fontSize":40,"offset":0,"ascent":32,"descent":8},{"fontSize":8.64,"offset":2.64,"ascent":4.272,"descent":4.368},{"fontSize":40,"offset":0,"ascent":32,"descent":8},{"fontSize":28.8,"offset":8.8,"ascent":14.240000000000002,"descent":14.560000000000002},{"fontSize":40,"offset":0,"ascent":32,"descent":8},{"fontSize":28.8,"offset":-16,"ascent":39.040000000000006,"descent":-10.239999999999998},{"fontSize":20,"offset":0,"ascent":16,"descent":4},{"fontSize":8.64,"offset":-4.8,"ascent":11.712,"descent":-3.0719999999999996}]});
  });

  it("gives the editor a subscript band that reaches the drawn subscript (40 px base, 12 px subscript)", () => {
    for (const mode of ["fixed-width", "auto"] as const) {
      const object = textObject([{ text: "H", script: "normal", style: {} }, { text: "2", script: "subscript", style: { fontSizePx: 12 } },
        { text: "O", script: "normal", style: {} }], { width: 400, style: { fontFamily: "Arial", fontSizePx: 40, lineHeight: 1.2, textBoxSizingMode: mode } });
      const runs = drawnRuns(planTextObjectSvg(object, 0) as unknown as Fragment);
      const subscript = runs.find(run => run.text === "2")!;
      const normal = runs.find(run => run.text === "H")!;
      // The renderer draws the subscript at the parent's script scale, one parent offset down.
      expect(subscript.fontSize).toBeCloseTo(28.8, 6);
      expect(subscript.y - normal.y).toBeCloseTo(16, 6);
      const [line] = planNativeTextEditorLayout(object).lines;
      expect(line!.baseline + object.y).toBeCloseTo(normal.y, 6);
      // The caret and highlight band, and the box, reach the bottom of the drawn subscript.
      const subscriptBottom = subscript.y - object.y + subscript.fontSize * 0.2;
      expect(line!.bottom, mode).toBeGreaterThanOrEqual(subscriptBottom - 1e-9);
      expect(nativeTextObjectBoxHeight(object), mode).toBeGreaterThanOrEqual(subscriptBottom);
    }
  });

  it("gives the editor a superscript band that reaches the drawn superscript top", () => {
    const object = textObject([{ text: "x", script: "normal", style: {} }, { text: "2", script: "superscript", style: { fontSizePx: 12 } }],
      { style: { fontFamily: "Arial", fontSizePx: 40, lineHeight: 1.2, textBoxSizingMode: "auto" } });
    const runs = drawnRuns(planTextObjectSvg(object, 0) as unknown as Fragment);
    const superscript = runs.find(run => run.text === "2")!;
    const [line] = planNativeTextEditorLayout(object).lines;
    expect(line!.top).toBeLessThanOrEqual(superscript.y - object.y - superscript.fontSize * 0.8 + 1e-9);
  });
});
