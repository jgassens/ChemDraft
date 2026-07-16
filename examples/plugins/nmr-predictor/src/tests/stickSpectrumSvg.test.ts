import { describe, expect, it } from "vitest";

import type { NmrPredictionResult, NmrResonance } from "../domain/contracts";
import { renderStickSpectrumSvg } from "../report/stickSpectrumSvg";

function resonance(deltaPpm: number, equivalentNuclei = 1): NmrResonance {
  return { id: `c-${deltaPpm}`, nucleus: "13C", deltaPpm, atomRefs: [], equivalentNuclei, flags: [] };
}

function result(resonances: NmrResonance[]): NmrPredictionResult {
  return {
    schemaVersion: "1",
    sourceFingerprint: "fp",
    backend: { id: "x", version: "1", method: "fixture-fragment" },
    resonances,
    warnings: [],
    generatedAt: "t"
  };
}

function stickXs(svg: string): number[] {
  return [...svg.matchAll(/<line x1="([\d.]+)"[^>]*stroke="#2563eb"/g)].map((match) => Number(match[1]));
}

describe("renderStickSpectrumSvg", () => {
  it("produces a self-contained, script-inert SVG string", () => {
    const svg = renderStickSpectrumSvg(result([resonance(128.5), resonance(21.3)]));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain("<script");
    expect(svg).toContain("#ffffff"); // its own background — does not depend on page theme
  });

  it("draws one stick per resonance", () => {
    expect(stickXs(renderStickSpectrumSvg(result([resonance(128.5), resonance(21.3), resonance(7.2)])))).toHaveLength(3);
  });

  it("reverses the axis: higher ppm sits to the left of lower ppm", () => {
    const svg = renderStickSpectrumSvg(result([resonance(200), resonance(10)]));
    const [highPpmX, lowPpmX] = stickXs(svg); // resonances are drawn in input order (200 then 10)
    expect(highPpmX).toBeLessThan(lowPpmX);
  });

  it("does not throw for an empty spectrum", () => {
    expect(() => renderStickSpectrumSvg(result([]))).not.toThrow();
    expect(stickXs(renderStickSpectrumSvg(result([])))).toHaveLength(0);
  });
});
