// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSvgToPdf } from "@chemdraft/export-engine/pdf";

afterEach(() => vi.restoreAllMocks());

describe("exportSvgToPdf", () => {
  it("renders SVG text and paths as vectors at CSS pixel dimensions", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 80, height: 16 })
    });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="96" viewBox="0 0 192 96"><path d="M10 20 L100 20" stroke="black"/><text x="10" y="50">Spectrum</text></svg>';
    const { bytes } = await exportSvgToPdf(svg, { outputWidth: 192, outputHeight: 96, compress: false });
    const pdf = new TextDecoder("latin1").decode(bytes);
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toMatch(/\/MediaBox \[0 0 144(?:\.0*)? 72(?:\.0*)?\]/);
    expect(pdf).toContain("Spectrum");
    expect(pdf).toMatch(/10(?:\.0*)? 20(?:\.0*)? m/);
    expect(pdf).not.toContain("/Subtype /Image");
  });

  it("rejects invalid and oversized dimensions", async () => {
    await expect(exportSvgToPdf("<svg/>", { outputWidth: 0, outputHeight: 96 })).rejects.toThrow("finite positive");
    await expect(exportSvgToPdf("<svg/>", { outputWidth: 19201, outputHeight: 96 })).rejects.toThrow("14400 points");
  });
});
