import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument, createImageGraphicObject, readPngInfo, serializeDocument } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { BLUE, pngChunk, RED, separateFirstFrameApng, solidTestPng, u32 } from "../../chem-core/src/apng.fixture";
import { runCli } from "./cli";
import { svgToPng } from "./document";
import type { CliIo } from "./output";
import { fitRasterPictures, RASTER_PICTURE_MAX_PIXELS, rasterPictureBudget } from "./rasterPictures";
import { FLATTEN_MAX_PIXELS } from "./svgPictureRaster";

const SVG = "http://www.w3.org/2000/svg";
const href = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;
/** An exported-document-like SVG: one `<g data-object-id>` per picture, side by side, each `drawn` units square. */
const pictureSvg = (pictures: { id: string; png: Buffer }[], drawn = 20) =>
  `<svg xmlns="${SVG}" width="${drawn * pictures.length}" height="${drawn}" viewBox="0 0 ${drawn * pictures.length} ${drawn}">` +
  pictures.map(({ id, png }, index) => `<g data-object-id="${id}"><image x="${index * drawn}" y="0" width="${drawn}" height="${drawn}" ` +
    `preserveAspectRatio="none" href="${href(png)}"/></g>`).join("") + "</svg>";
/** The RGBA pixel at (x, y) of PNG bytes. */
const pixel = (png: Uint8Array, x: number, y: number) => {
  const { pixelWidth: width, pixelHeight: height } = readPngInfo(png)!;
  const image = new Resvg(`<svg xmlns="${SVG}" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`).render();
  const at = (y * width + x) * 4;
  return [...image.pixels.subarray(at, at + 4)];
};
const hrefSizes = (svg: string) => [...svg.matchAll(/href="data:image\/png;base64,([^"]+)"/g)]
  .map((match) => readPngInfo(new Uint8Array(Buffer.from(match[1]!, "base64"))))
  .map((info) => `${info!.pixelWidth}x${info!.pixelHeight}`);

describe("rasterPictureBudget", () => {
  const picture = (side: number, drawn = 10) => ({ pixelWidth: side, pixelHeight: side, drawnWidth: drawn, drawnHeight: drawn });

  it("is the same 64 Mi-pixel budget as SVG picture flattening", () => {
    expect(RASTER_PICTURE_MAX_PIXELS).toBe(FLATTEN_MAX_PIXELS);
    expect(RASTER_PICTURE_MAX_PIXELS).toBe(64 * 1024 * 1024);
  });

  it("keeps every picture's own size under budget", () => {
    expect(rasterPictureBudget([picture(100), picture(50)], 100 * 100 + 50 * 50))
      .toEqual([{ pixelWidth: 100, pixelHeight: 100 }, { pixelWidth: 50, pixelHeight: 50 }]);
  });

  it("shrinks the largest pictures first, keeping aspect, until all fit", () => {
    const sizes = rasterPictureBudget([picture(100), { pixelWidth: 200, pixelHeight: 100, drawnWidth: 10, drawnHeight: 5 }, picture(20)], 10_000);
    expect(sizes[2]).toEqual({ pixelWidth: 20, pixelHeight: 20 });
    expect(sizes[1]!.pixelWidth).toBeCloseTo(2 * sizes[1]!.pixelHeight, -1);
    expect(sizes.reduce((total, size) => total + size.pixelWidth * size.pixelHeight, 0)).toBeLessThanOrEqual(10_000);
    expect(sizes[0]!.pixelWidth * sizes[0]!.pixelHeight).toBeGreaterThan(20 * 20);
  });

  it("never goes below a picture's drawn size while those sizes fit", () => {
    // The big picture is drawn at 90 pixels; the small one could give pixels too, but only the big one is over its drawn size.
    const sizes = rasterPictureBudget([picture(400, 90), picture(60, 60)], 100 * 100 + 60 * 60);
    expect(sizes[1]).toEqual({ pixelWidth: 60, pixelHeight: 60 });
    expect(sizes[0]!.pixelWidth).toBeGreaterThanOrEqual(90);
    expect(sizes[0]!.pixelWidth).toBeLessThanOrEqual(100);
  });

  it("shrinks below the drawn sizes when even they don't fit", () => {
    const sizes = rasterPictureBudget([picture(400, 400), picture(400, 400)], 200 * 200);
    expect(sizes.reduce((total, size) => total + size.pixelWidth * size.pixelHeight, 0)).toBeLessThanOrEqual(200 * 200);
    expect(sizes[0]).toEqual(sizes[1]);
    expect(sizes[0]!.pixelWidth).toBeGreaterThan(130);
  });
});

describe("fitRasterPictures", { timeout: 60_000 }, () => {
  it("returns the very same SVG, with no warning, for still pictures under budget", async () => {
    const svg = pictureSvg([{ id: "a", png: solidTestPng(8, 8, RED) }, { id: "b", png: solidTestPng(4, 4, BLUE) }]);
    const warnings: ExportWarning[] = [];
    expect(await fitRasterPictures(svg, 1, warnings)).toBe(svg);
    expect(warnings).toEqual([]);
  });

  it("draws an animated PNG at its first frame, not its default image", async () => {
    const svg = pictureSvg([{ id: "animated", png: separateFirstFrameApng(8, 8, RED, BLUE) }]);
    const warnings: ExportWarning[] = [];
    const fitted = await fitRasterPictures(svg, 1, warnings);
    expect(warnings).toEqual([]);
    expect(pixel(svgToPng(svg, 40), 20, 20)).toEqual([255, 0, 0, 255]); // resvg alone draws the default image
    expect(pixel(svgToPng(fitted, 40), 20, 20)).toEqual([0, 0, 255, 255]);
  });

  it("draws the default image of a malformed animated PNG, with a warning naming the picture", async () => {
    const png = separateFirstFrameApng(8, 8, RED, BLUE, { actl: pngChunk("acTL", u32(2)) });
    const svg = pictureSvg([{ id: "broken", png }]);
    const warnings: ExportWarning[] = [];
    const fitted = await fitRasterPictures(svg, 1, warnings);
    expect(warnings).toEqual([expect.objectContaining({ code: "export.png.apng_default_image", objectId: "broken",
      message: expect.stringMatching(/^PNG export: picture broken: the animated PNG's first frame can't be read \(its animation control chunk is malformed\)/) })]);
    // resvg refuses the malformed animation outright; its default image alone draws.
    expect(pixel(svgToPng(svg, 20), 10, 10)).toEqual([0, 0, 0, 0]);
    expect(pixel(svgToPng(fitted, 20), 10, 10)).toEqual([255, 0, 0, 255]);
  });

  it("downsamples the largest pictures over budget, names each one, and still renders", async () => {
    const svg = pictureSvg([{ id: "large", png: solidTestPng(200, 200, RED) }, { id: "medium", png: solidTestPng(100, 100, BLUE) },
      { id: "small", png: solidTestPng(20, 20, RED) }]);
    const warnings: ExportWarning[] = [];
    const fitted = await fitRasterPictures(svg, 1, warnings, 20_000);
    const sizes = hrefSizes(fitted);
    expect(sizes[2]).toBe("20x20");
    const pixels = sizes.map((size) => size.split("x").map(Number)).reduce((total, [w, h]) => total + w! * h!, 0);
    expect(pixels).toBeLessThanOrEqual(20_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "export.png.pictures_downsampled", severity: "warning" });
    expect(warnings[0]!.objectId).toBeUndefined();
    const [large, medium] = sizes.slice(0, 2).map((size) => size.replace("x", " x "));
    expect(warnings[0]!.message).toBe(`PNG export: 2 pictures were downsampled so all pictures fit the ${20_000 / (1024 * 1024)} Mi-pixel picture budget: ` +
      `picture large from 200 x 200 to ${large} pixels; picture medium from 100 x 100 to ${medium} pixels.`);
    const png = svgToPng(fitted, 300);
    expect(pixel(png, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(png, 150, 50)).toEqual([0, 0, 255, 255]);
  });
});

describe("render-document with PNG pictures", { timeout: 60_000 }, () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "chemdraft-raster-pictures-")); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  async function render(name: string, png: Buffer, format: "png" | "pdf", mimeType: "image/png" | "image/svg+xml" = "image/png") {
    const document = createEmptyDocument();
    document.pages[0]!.objects = [createImageGraphicObject({ id: "picture", mimeType, center: { x: 400, y: 300 },
      dataBase64: png.toString("base64") })];
    const input = join(directory, `${name}.chemdraft`), output = join(directory, `${name}.${format}`);
    await writeFile(input, serializeDocument(document));
    const stdout: string[] = [];
    const io: CliIo = { stdout: (line) => stdout.push(line), stderr: () => {} };
    const code = await runCli(["render-document", "--document", input, "--out", output, "--width", "200"], io);
    const result = JSON.parse(stdout[0]!);
    expect(code, JSON.stringify(result)).toBe(0);
    return { result, bytes: new Uint8Array(await readFile(output)) };
  }

  it("draws an animated PNG picture's first frame in a PNG export", async () => {
    const { result, bytes } = await render("animated", separateFirstFrameApng(32, 32, RED, BLUE), "png");
    expect(result.exportWarnings).toEqual([]);
    const { pixelWidth, pixelHeight } = readPngInfo(bytes)!;
    expect(pixel(bytes, Math.floor(pixelWidth / 2), Math.floor(pixelHeight / 2))).toEqual([0, 0, 255, 255]);
  });

  it("warns, and draws the default image, for a malformed animated PNG picture", async () => {
    const { result, bytes } = await render("malformed", separateFirstFrameApng(32, 32, RED, BLUE, { actl: pngChunk("acTL", u32(2)) }), "png");
    expect(result.exportWarnings).toEqual([expect.objectContaining({ code: "export.png.apng_default_image", objectId: "picture" })]);
    const { pixelWidth, pixelHeight } = readPngInfo(bytes)!;
    expect(pixel(bytes, Math.floor(pixelWidth / 2), Math.floor(pixelHeight / 2))).toEqual([255, 0, 0, 255]);
  });

  it.each(["png", "pdf"] as const)("draws the first frame of an animated PNG an SVG picture embeds, in a %s export", async (format) => {
    const svg = `<svg xmlns="${SVG}" width="40" height="40"><image width="40" height="40" preserveAspectRatio="none" ` +
      `href="${href(separateFirstFrameApng(8, 8, RED, BLUE))}"/></svg>`;
    const { result, bytes } = await render(`svg-animated-${format}`, Buffer.from(svg), format, "image/svg+xml");
    expect(result.exportWarnings).toEqual([]);
    if (format === "pdf") return;
    const { pixelWidth, pixelHeight } = readPngInfo(bytes)!;
    expect(pixel(bytes, Math.floor(pixelWidth / 2), Math.floor(pixelHeight / 2))).toEqual([0, 0, 255, 255]);
  });

  it("warns by SVG picture when an animated PNG it embeds is malformed", async () => {
    const png = separateFirstFrameApng(8, 8, RED, BLUE, { actl: pngChunk("acTL", u32(2)) });
    const svg = `<svg xmlns="${SVG}" width="40" height="40"><image width="40" height="40" preserveAspectRatio="none" href="${href(png)}"/></svg>`;
    const { result, bytes } = await render("svg-malformed", Buffer.from(svg), "png", "image/svg+xml");
    expect(result.exportWarnings).toEqual([expect.objectContaining({ code: "export.png.svg_picture_apng_default_image", objectId: "picture" })]);
    const { pixelWidth, pixelHeight } = readPngInfo(bytes)!;
    expect(pixel(bytes, Math.floor(pixelWidth / 2), Math.floor(pixelHeight / 2))).toEqual([255, 0, 0, 255]);
  });

  it("draws an animated PNG picture's first frame in a PDF export", async () => {
    const { result, bytes } = await render("animated-pdf", separateFirstFrameApng(32, 32, RED, BLUE, { channels: 3 }), "pdf");
    expect(result.exportWarnings).toEqual([]);
    expect(Buffer.from(bytes).toString("latin1")).toMatch(/\/Subtype \/Image/);
  });
});
