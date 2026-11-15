// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeTextStyleFromObjectStyle } from "@chemdraft/chem-core";
import { cssTextFirstBaseline } from "@chemdraft/layout-engine";
import { measureTextEditorMetrics, measureTextEditorViewport } from "./textEditorMetrics";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("browser text layout measurements", () => {
  it.each([1, 2])("reads the CSS baseline at scale %s without using glyph ink", scale => {
    const style = nativeTextStyleFromObjectStyle({ fontFamily: "Arial", fontSizePx: 18.667 });
    const lineHeight = style.fontSizePx * style.lineHeight * scale;
    // Deliberately different from offline Arial metrics: the production helper must
    // preserve the browser's measured baseline, including its font rounding.
    const baseline = 17.5 * scale;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      expect(this.isConnected).toBe(true);
      expect(this.style.borderWidth).toBe("0px");
      expect(this.style.padding).toBe("0px");
      if (this.style.verticalAlign === "baseline") {
        expect(this.style.height).toBe("0px");
        return { top: baseline, bottom: baseline, height: 0 } as DOMRect;
      }
      expect(this.style.fontFamily).toBe("Arial");
      expect(this.style.fontSize).toBe(`${18.667 * scale}px`);
      expect(this.style.lineHeight).toBe(`${lineHeight}px`);
      return { top: 0, bottom: lineHeight, height: lineHeight } as DOMRect;
    });
    const metrics = measureTextEditorMetrics(style, scale, lineHeight)!;
    expect(cssTextFirstBaseline(lineHeight, metrics)).toBeCloseTo(baseline, 10);
    expect(document.body.childElementCount).toBe(0);
  });

  it("cleans up when the host cannot lay out text", () => {
    expect(measureTextEditorMetrics(nativeTextStyleFromObjectStyle(), 1, 21.6)).toBeUndefined();
    expect(document.body.childElementCount).toBe(0);
  });

  it("uses SVG's CTM relative to the interaction layer, including fractional offsets", () => {
    document.body.innerHTML = '<div class="page"><svg class="page-svg-visual-layer"></svg><div class="page-interaction-layer"></div></div>';
    const svg = document.querySelector<SVGSVGElement>("svg")!;
    const layer = document.querySelector<HTMLElement>(".page-interaction-layer")!;
    svg.getScreenCTM = () => ({ a: 1.9975, d: 1.9975, e: 140.25, f: 93.75 }) as DOMMatrix;
    layer.getBoundingClientRect = () => ({ left: 140, top: 93 }) as DOMRect;
    expect(measureTextEditorViewport(layer)).toEqual({ scale: 1.9975, offset: { x: 0.25, y: 0.75 } });
  });
});
