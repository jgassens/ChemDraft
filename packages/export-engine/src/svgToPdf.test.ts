// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageGraphicObject } from "@chemdraft/chem-core";
import { exportSvgToPdf } from "@chemdraft/export-engine/pdf";
import { Resvg } from "@resvg/resvg-js";
import { largePicturePng } from "./pdf.testUtils";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 80, height: 16 })
  });
});

afterEach(() => vi.restoreAllMocks());

let syntheticLargePng: string | undefined;

describe("exportSvgToPdf", () => {
  it.each(["ASCII", "UTF-8"])("rejects more than 256 MB of %s markup without pictures", async (encoding) => {
    const text = encoding === "ASCII" ? "a".repeat(256 * 1024 * 1024) : "é".repeat(129 * 1024 * 1024);
    await expect(exportSvgToPdf(`<svg><text>${text}</text></svg>`, { outputWidth: 192, outputHeight: 96 }))
      .rejects.toThrow("Cannot export PDF: SVG exceeds 256 MB.");
  }, 20_000);

  it.each(["no mapping", "unmatched object", "nested image", "text"])("admits a large picture URI unchanged as markup with %s", async (placement) => {
    const picture = createImageGraphicObject({ id: "picture", mimeType: "image/png",
      dataBase64: syntheticLargePng ??= largePicturePng().toString("base64"), center: { x: 40, y: 40 } });
    const href = `data:image/png;base64,${picture.data.image!.dataBase64}`;
    const image = `<g data-object-id="${placement === "unmatched object" ? "other" : "picture"}"><image href="${href}"/></g>`;
    const contents = placement === "text" ? `<text>${href}</text>` : placement === "nested image" ? `<g>${image}</g>` : image;
    const markup = '<svg>' + contents + '</svg>';
    const parseFromString = vi.fn(() => { throw new Error("accepted at parser boundary"); });
    await expect(exportSvgToPdf(markup, { outputWidth: 192, outputHeight: 96,
      domParser: { parseFromString } as unknown as DOMParser,
      ...(placement === "no mapping" ? {} : { pictures: new Map([[picture.id, picture]]), pageSize: { width: 192, height: 96 } }) }))
      .rejects.toThrow("accepted at parser boundary");
    expect(parseFromString).toHaveBeenCalledWith(markup, "image/svg+xml");
  }, 20_000);

  it("admits 25 MiB SVG markup unchanged, including realistic nesting and element counts", async () => {
    const body = "<g>".repeat(24) + "<path d=\"M0 0L1 1\"/>".repeat(10_000) + "</g>".repeat(24);
    const markup = '<svg xmlns="http://www.w3.org/2000/svg">' + body + " ".repeat(25 * 1024 * 1024 - body.length - 46) + '</svg>';
    const parseFromString = vi.fn(() => { throw new Error("accepted at parser boundary"); });
    await expect(exportSvgToPdf(markup, { outputWidth: 192, outputHeight: 96,
      domParser: { parseFromString } as unknown as DOMParser })).rejects.toThrow("accepted at parser boundary");
    expect(parseFromString).toHaveBeenCalledWith(markup, "image/svg+xml");
  }, 10_000);

  it("renders SVG text and paths as vectors at CSS pixel dimensions", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="96" viewBox="0 0 192 96"><path d="M10 20 L100 20" stroke="black"/><text x="10" y="50">Spectrum</text></svg>';
    const { bytes, warnings } = await exportSvgToPdf(svg, { outputWidth: 192, outputHeight: 96, compress: false });
    const pdf = new TextDecoder("latin1").decode(bytes);
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toMatch(/\/MediaBox \[0 0 144(?:\.0*)? 72(?:\.0*)?\]/);
    expect(pdf).toContain("Spectrum");
    expect(pdf).toMatch(/10(?:\.0*)? 20(?:\.0*)? m/);
    expect(pdf).not.toContain("/Subtype /Image");
    expect(warnings).toEqual([]);
  });

  it("renders pictures between vector runs and returns SVG-picture warnings", async () => {
    const png = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>').render().asPng()).toString("base64");
    const picture = createImageGraphicObject({ id: "picture", mimeType: "image/png", dataBase64: png, center: { x: 40, y: 40 } });
    const svgData = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svgPicture = createImageGraphicObject({ id: "svg-picture", mimeType: "image/svg+xml", dataBase64: svgData, center: { x: 40, y: 40 } });
    const pictures = new Map([[picture.id, picture], [svgPicture.id, svgPicture]]);
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 96">
      <text x="10" y="10">Before</text>
      <g data-object-id="picture"><image href="data:image/png;base64,${png}"/></g>
      <text x="10" y="20">Between</text>
      <g data-object-id="svg-picture"><image href="data:image/svg+xml;base64,${svgData}"/></g>
      <text x="10" y="30">After</text>
    </svg>`;
    const result = await exportSvgToPdf(markup, { outputWidth: 192, outputHeight: 96,
      compress: false, pictures, pageSize: { width: 192, height: 96 } });
    const pdf = new TextDecoder("latin1").decode(result.bytes);
    const imagePosition = pdf.search(/\/I\d+ Do/);
    expect(imagePosition).toBeGreaterThan(pdf.indexOf("(Before)"));
    expect(pdf.indexOf("(Between)")).toBeGreaterThan(imagePosition);
    expect(pdf.indexOf("(After)")).toBeGreaterThan(pdf.indexOf("(Between)"));
    expect(result.warnings).toEqual([{ code: "export.pdf.svg_picture_not_drawn", severity: "warning",
      objectId: "svg-picture", message: "PDF export: SVG picture svg-picture was not drawn; paste it as PNG or export SVG" }]);
    await expect(exportSvgToPdf(markup, { outputWidth: 192, outputHeight: 96, pictures }))
      .rejects.toThrow("source page dimensions");
    await expect(exportSvgToPdf(markup, { outputWidth: 192, outputHeight: 96, pictures,
      pageSize: { width: Number.NaN, height: 96 } })).rejects.toThrow("source page dimensions");
  });

  it("keeps standalone SVG security checks when document pictures are optional", async () => {
    const dataBase64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const picture = createImageGraphicObject({ id: "svg-picture", mimeType: "image/svg+xml", dataBase64, center: { x: 40, y: 40 } });
    const image = `<g data-object-id="svg-picture"><image href="data:image/svg+xml;base64,${dataBase64}"/></g>`;
    const options = { outputWidth: 192, outputHeight: 96 };
    await expect(exportSvgToPdf(`<svg>${image}</svg>`, options)).rejects.toThrow("external SVG references");
    await expect(exportSvgToPdf(`<svg><g>${image}</g></svg>`, { ...options,
      pictures: new Map([[picture.id, picture]]), pageSize: { width: 192, height: 96 } }))
      .rejects.toThrow("external SVG references");
    await expect(exportSvgToPdf('<svg><script>alert(1)</script></svg>', options)).rejects.toThrow("active SVG content");
    await expect(exportSvgToPdf('<!DOCTYPE svg [<!ENTITY x "text">]><svg/>', options)).rejects.toThrow("declarations");
  });

  it("rejects invalid and oversized dimensions", async () => {
    await expect(exportSvgToPdf("<svg/>", { outputWidth: 0, outputHeight: 96 })).rejects.toThrow("finite positive");
    await expect(exportSvgToPdf("<svg/>", { outputWidth: 19201, outputHeight: 96 })).rejects.toThrow("14400 points");
  });
});
