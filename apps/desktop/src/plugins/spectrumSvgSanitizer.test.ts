// @vitest-environment jsdom

import type { PluginLinkedFigureSpectrum } from "@chemdraft/plugin-api";
import { exportSvgToPdf } from "@chemdraft/export-engine/pdf";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkedFigureView } from "./LinkedFigureView";
import { spectrumToPdf, standaloneSpectrumSvg } from "./spectrumExport";
import {
  MAX_SPECTRUM_SVG_BYTES,
  MAX_SPECTRUM_SVG_DEPTH,
  MAX_SPECTRUM_SVG_NODES,
  sanitizeSpectrumSvg
} from "./spectrumSvgSanitizer";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

describe("spectrum SVG sanitizer", () => {
  it.each([
    { nucleus: "13C", max: 200, shifts: [140.85, 137.56, 127.34, 126.89, 45.12, 45.01] },
    { nucleus: "1H", max: 8, shifts: [7.30, 7.30, 7.25, 2.61, 1.21] }
  ])("preserves the real $nucleus DOM figure byte for byte, including comparison and active traces", ({ nucleus, max, shifts }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const spectrum: PluginLinkedFigureSpectrum = {
      nucleus, domain: { min: 0, max }, reversed: true,
      comparison: { primaryLabel: "HOSE", alternativeLabel: "increment", alternativeMarker: "ᵢ" },
      peaks: shifts.map((ppm, index) => ({
        id: `p${index}`, ppm, intensity: index + 1, label: ppm.toFixed(2), atomIndices: [index],
        estimated: index === 0, alternativePpm: index === 1 ? ppm + 0.2 : undefined,
        couplings: [{ jHz: 7, partnerCount: 1 }]
      }))
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(LinkedFigureView, { spectrum })));
      const figure = container.querySelector<SVGSVGElement>(".lf-spectrum")!;
      const primary = standaloneSpectrumSvg(figure, "increment", "HOSE");
      expect(new DOMParser().parseFromString(primary, "image/svg+xml").querySelector("parsererror")?.textContent).toBeUndefined();
      expect(sanitizeSpectrumSvg(primary)).toBe(primary);
      const comparison = [...container.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "both"))!;
      act(() => { comparison.value = "both"; comparison.dispatchEvent(new Event("change", { bubbles: true })); });
      act(() => container.querySelector("[data-peak-id]")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      const both = standaloneSpectrumSvg(figure, "increment", "HOSE");
      expect(both).toContain("is-alternative");
      expect(both).toContain('class="lf-curve is-active"');
      expect(both).toContain("lf-label-leader");
      expect(both).toContain("font-size: 13px");
      expect(sanitizeSpectrumSvg(both)).toBe(both);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("preserves escaped literal labels without interpreting them as markup", () => {
    const markup = svg('<text x="1" y="2">A &amp; B &lt;script&gt; &#956;</text>');
    expect(sanitizeSpectrumSvg(markup)).toBe(markup);
  });

  it.each([
    '<script>alert(1)</script>', '<foreignObject><div/></foreignObject>',
    '<image href="https://attacker.invalid/x"/>', '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
    '<a href="https://attacker.invalid"><text>link</text></a>', '<a href="#local"/>',
    '<use href="#local"/>', '<path onload="alert(1)" d="M0 0L1 1"/>',
    '<path href="https://attacker.invalid"/>', '<path xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#x"/>',
    '<rect fill="url(https://attacker.invalid/x)"/>', '<rect fill="url(#local)"/>',
    '<text style="font-size: 13px; background:url(https://attacker.invalid/x)">x</text>',
    '<style>@import "https://attacker.invalid/x";</style>',
    '<style>@\\69mport "https://attacker.invalid/x";</style>',
    '<style>.lf-curve{fill:u\\72l(https://attacker.invalid/x)}</style>',
    '<svg/>', '<text xmlns="http://www.w3.org/1999/xhtml">x</text>',
    '<path d="M0 0L1e999 1"/>', '<rect width="Infinity"/>',
    '<path unknown="x"/>', '<constructor/>', '<g xml:base="https://attacker.invalid"/>',
    '<!-- hidden -->', '<![CDATA[<script/>]]>'
  ])("refuses active, foreign or unrecognized figure markup (%#)", (body) => {
    expect(() => sanitizeSpectrumSvg(svg(body))).toThrow("Invalid spectrum SVG");
  });

  it.each([
    '<!DOCTYPE svg [<!ENTITY payload SYSTEM "https://attacker.invalid/x">]><svg>&payload;</svg>',
    '<?xml-stylesheet href="https://attacker.invalid/x"?><svg/>',
    '<svg><text>&payload;</text></svg>', '<svg><g></svg>', '<html/>'
  ])("refuses entity declarations, processing instructions and malformed XML (%#)", (markup) => {
    expect(() => sanitizeSpectrumSvg(markup)).toThrow("Invalid spectrum SVG");
  });

  it.each([
    () => svg("界".repeat(Math.floor(MAX_SPECTRUM_SVG_BYTES / 3))),
    () => svg("<g/>".repeat(MAX_SPECTRUM_SVG_NODES)),
    () => svg("<g>".repeat(MAX_SPECTRUM_SVG_DEPTH) + "</g>".repeat(MAX_SPECTRUM_SVG_DEPTH))
  ])("applies byte, node and depth budgets before parsing (%#)", (markup) => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    expect(() => sanitizeSpectrumSvg(markup())).toThrow("Invalid spectrum SVG");
    expect(parse).not.toHaveBeenCalled();
  });

  it("bounds path data independently of the document size", () => {
    expect(() => sanitizeSpectrumSvg(svg(`<path d="${"M0 0L1 1".repeat(150000)}"/>`))).toThrow("Invalid spectrum SVG");
  });
});

describe("shared SVG-to-PDF boundary", () => {
  it.each([
    '<image href="https://attacker.invalid/x"/>',
    '<image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="//attacker.invalid/x"/>',
    '<a href="https://attacker.invalid"><text>link</text></a>',
    '<rect fill="url(https://attacker.invalid/x)"/>',
    '<style>@import "https://attacker.invalid/x";</style>',
    '<style>@\\69mport "https://attacker.invalid/x";</style>',
    '<rect style="fill:u\\72l(https://attacker.invalid/x)"/>',
    '<script/>', '<foreignObject/>', '<g onload="alert(1)"/>',
    '<g xml:base="https://attacker.invalid"/>', '<use href="#loop" id="loop"/>'
  ])("refuses external fetches and active content before conversion (%#)", async (body) => {
    const request = vi.spyOn(XMLHttpRequest.prototype, "open");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(exportSvgToPdf(svg(body), { outputWidth: 680, outputHeight: 240 })).rejects.toThrow("Cannot export PDF");
    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    () => svg("界".repeat(7 * 1024 * 1024)),
    () => svg("<g/>".repeat(100001)),
    () => svg("<g>".repeat(65) + "</g>".repeat(65)),
    () => '<!DOCTYPE svg [<!ENTITY x SYSTEM "https://attacker.invalid">]><svg/>',
    () => svg('<![CDATA[</g></g></g>]]>' + "<g>".repeat(65) + "</g>".repeat(65))
  ])("bounds arbitrary SVG and rejects entities before parsing (%#)", async (markup) => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    await expect(exportSvgToPdf(markup(), { outputWidth: 680, outputHeight: 240 })).rejects.toThrow("Cannot export PDF");
    expect(parse).not.toHaveBeenCalled();
  });

  it("keeps self-contained vector PDF output and fragment paints", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const markup = svg('<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs><rect width="10" height="10" fill="url(#paint)" style="font-family: &quot;@MS Gothic&quot;"/><path d="M10 20 L100 20" stroke="black"/>');
    const { bytes } = await exportSvgToPdf(markup, { outputWidth: 192, outputHeight: 96, compress: false });
    const pdf = new TextDecoder("latin1").decode(bytes);
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toMatch(/\/MediaBox \[0 0 144(?:\.0*)? 72(?:\.0*)?\]/);
    expect(pdf).not.toContain("/URI");
    expect(pdf).not.toContain("/Subtype /Image");
  });

  it("converts the real standalone spectrum to a host-generated PDF", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const originalBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 16 })
    });
    const spectrum: PluginLinkedFigureSpectrum = {
      nucleus: "13C", domain: { min: 0, max: 200 }, reversed: true,
      peaks: [{ id: "p1", ppm: 127.34, intensity: 2, atomIndices: [0] }]
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(LinkedFigureView, { spectrum })));
      const markup = standaloneSpectrumSvg(container.querySelector<SVGSVGElement>(".lf-spectrum")!);
      const pdf = new TextDecoder("latin1").decode(await spectrumToPdf(markup));
      expect(pdf.startsWith("%PDF-")).toBe(true);
      expect(pdf).not.toContain("/URI");
      expect(pdf).not.toContain("/JavaScript");
      expect(pdf).not.toContain("/Subtype /Image");
    } finally {
      act(() => root.unmount());
      if (originalBBox) Object.defineProperty(SVGElement.prototype, "getBBox", originalBBox);
      else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
    }
  });
});
