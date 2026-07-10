// @vitest-environment jsdom

import type { PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import { spectrumToJcampDx, standaloneSpectrumSvg } from "./spectrumExport";

const spectrum: PluginLinkedFigureSpectrum = {
  nucleus: "1H",
  domain: { min: 0, max: 8 },
  reversed: true,
  peaks: [
    { id: "a", ppm: 1.2, intensity: 3, atomIndices: [1] },
    { id: "b", ppm: 7.26, intensity: 5, atomIndices: [0] }
  ]
};

describe("spectrumToJcampDx", () => {
  it("emits a JCAMP-DX peak table with nucleus + frequency, peaks ppm-descending", () => {
    const jdx = spectrumToJcampDx(spectrum, { title: "Predicted 1H NMR", freqMHz: 400 });
    expect(jdx).toContain("##JCAMP-DX=5.01");
    expect(jdx).toContain("##DATA TYPE=NMR PEAK TABLE");
    expect(jdx).toContain("##.OBSERVE NUCLEUS=^1H");
    expect(jdx).toContain("##.OBSERVE FREQUENCY=400");
    expect(jdx).toContain("##PEAK TABLE=(XY..XY)");
    expect(jdx.trimEnd().endsWith("##END=")).toBe(true);

    const body = jdx.split("##PEAK TABLE=(XY..XY)\n")[1];
    expect(body.startsWith("7.2600, 5.000")).toBe(true); // highest ppm first
    expect(body).toContain("1.2000, 3.000");
  });

  it("maps ¹³C to the ^13C token", () => {
    expect(spectrumToJcampDx({ ...spectrum, nucleus: "13C" })).toContain("##.OBSERVE NUCLEUS=^13C");
  });
});

describe("standaloneSpectrumSvg", () => {
  it("wraps the live svg into a self-contained, styled SVG document", () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", "0 0 680 240");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("class", "lf-curve");
    path.setAttribute("d", "M0 0 L10 10");
    svg.appendChild(path);

    const out = standaloneSpectrumSvg(svg);
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('width="680"');
    expect(out).toContain('height="240"');
    expect(out).toContain(".lf-curve{fill:none;stroke:#2f7d6f"); // inlined style travels with the copy
    expect(out).toContain('class="lf-curve"'); // original content preserved
  });
});
