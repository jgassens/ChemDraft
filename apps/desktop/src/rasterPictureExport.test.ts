// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import { createDefaultExportDialogState, createDialogExportResult } from "./MainWindow";
import { applyClipboardPastePayload, createPhase4Document, insertNativeTemplateMolecule } from "./documentWorkflow";
import { rasterizeSvgNative } from "./nativeRasterExport";
import { rasterPicturePlaceholderHref } from "./rasterPictureDecode";
import { picturePngBase64, pictureSvg } from "./testSupport/imageFixture";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: native.invoke }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

function pageWithPicture(mimeType: "image/png" | "image/svg+xml") {
  const document = insertNativeTemplateMolecule(createPhase4Document("Raster pictures"), { x: 500, y: 300 }, "benzene");
  return applyClipboardPastePayload(document, inspectClipboardPayload({
    types: [mimeType], textItems: [],
    imageItems: [{ type: mimeType, bytesBase64: mimeType === "image/png" ? picturePngBase64 : btoa(pictureSvg) }]
  }), { x: 200, y: 200 }).document;
}

/** The webview decoder as WKWebView and WebView2 provide it: an ImageBitmap read back from a canvas. */
function stubWebviewDecoder(width: number, height: number, rgba: number[]) {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => ({ width, height, close, type: blob.type })));
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return {
        drawImage: vi.fn(),
        getImageData: (_x: number, _y: number, w: number, h: number) =>
          ({ data: new Uint8ClampedArray(w * h * 4).map((_, index) => rgba[index % 4]) })
      };
    }
  });
  return close;
}

describe("picture page raster requests", () => {
  it.each(["image/png", "image/svg+xml"] as const)("sends a %s page at 1x and 3x with source density and preserves native warnings", async mimeType => {
    const document = pageWithPicture(mimeType);
    const close = stubWebviewDecoder(144, 72, [0, 0, 255, 255]);
    const warning = { code: "raster_dimension_clamped", severity: "warning", message: "Raster export was clamped to 8192px on its longest side." };
    native.invoke.mockResolvedValue({ bytes: [1, 2, 3], width: 1, height: 1, warnings: [warning] });
    let previousSvg: string | undefined;
    for (const scale of [1, 3]) {
      const state = createDefaultExportDialogState(document);
      const result = await createDialogExportResult(document, { ...state, format: "png", presentation: undefined, raster: { ...state.raster, scale } });
      expect(result.warnings).toContainEqual(warning);
      const [command, { request }] = native.invoke.mock.calls.at(-1)!;
      expect(command).toBe("rasterize_svg");
      expect(request).toMatchObject({ format: "png", scale, cssPxPerInch: 96, background: "#ffffff" });
      const svg = new DOMParser().parseFromString(request.svg, "image/svg+xml");
      expect(svg.querySelector("parsererror")).toBeNull();
      expect(svg.documentElement.getAttribute("viewBox")).toBe(`0 0 ${document.pages[0].width} ${document.pages[0].height}`);
      const image = svg.querySelector("image")!;
      expect(image.getAttribute("data-chemdraft-picture-frame")).toMatch(/^[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/);
      expect(image.getAttribute("preserveAspectRatio")).toBe("none");
      if (mimeType === "image/png") {
        // Decoded in the webview: native code gets RGBA pixels and an empty stand-in, never the PNG.
        expect(request.svg).not.toContain(picturePngBase64);
        expect(image.getAttribute("href")).toBe(rasterPicturePlaceholderHref(144, 72, image.getAttribute("id") ?? ""));
        expect(request.pictures).toHaveLength(1);
        const [picture] = request.pictures;
        expect(picture).toMatchObject({ id: image.getAttribute("id"), width: 144, height: 72 });
        const pixels = Uint8Array.from(atob(picture.rgbaBase64), char => char.charCodeAt(0));
        expect(pixels).toHaveLength(144 * 72 * 4);
        expect([...pixels.subarray(0, 8)]).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
      } else {
        expect(image.getAttribute("href")).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(image.hasAttribute("id")).toBe(false);
        expect(request).not.toHaveProperty("pictures");
      }
      if (previousSvg) expect(request.svg).toBe(previousSvg);
      previousSvg = request.svg;

      expect(svg.querySelectorAll("path, line").length).toBeGreaterThan(0);
    }
    expect(close).toHaveBeenCalledTimes(mimeType === "image/png" ? 2 : 0);
  });

  it("reports a PNG picture the webview cannot decode instead of sending its bytes", async () => {
    // jsdom has neither createImageBitmap nor a working image decoder.
    const document = pageWithPicture("image/png");
    native.invoke.mockResolvedValue({ bytes: [1], width: 1, height: 1, warnings: [] });
    const state = createDefaultExportDialogState(document);
    await createDialogExportResult(document, { ...state, format: "jpeg", presentation: undefined });
    const { request } = native.invoke.mock.calls.at(-1)![1];
    const image = new DOMParser().parseFromString(request.svg, "image/svg+xml").querySelector("image")!;
    expect(request.pictures).toEqual([{ id: image.getAttribute("id"), refused: "decodeFailed" }]);
    expect(image.getAttribute("href")).toBe(rasterPicturePlaceholderHref(1, 1, image.getAttribute("id") ?? ""));
    expect(request.svg).not.toContain(picturePngBase64);
  });

  it("decodes pictures for every caller of the native rasterizer, including Copy as PNG and plugin renders", async () => {
    stubWebviewDecoder(144, 72, [255, 0, 0, 128]);
    native.invoke.mockResolvedValue({ bytes: [1], width: 1, height: 1, warnings: [] });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image width="10" height="10" href="data:image/png;base64,${picturePngBase64}"/></svg>`;
    await rasterizeSvgNative(svg, "png", { scale: 4, background: "#ffffff", maxDimensionPx: 8192, cssPxPerInch: 96 });
    const { request } = native.invoke.mock.calls.at(-1)![1];
    expect(request).toMatchObject({ format: "png", scale: 4, maxDimensionPx: 8192, cssPxPerInch: 96 });
    expect(request.pictures).toEqual([expect.objectContaining({ id: "chemdraft-raster-picture-0", width: 144, height: 72 })]);
  });

  it("keeps the chosen DPI for explicit pixel sizing instead of multiplying it again", async () => {
    const document = pageWithPicture("image/png");
    const state = createDefaultExportDialogState(document);
    native.invoke.mockResolvedValue({ bytes: [1], width: 1200, height: 1600, warnings: [] });
    await createDialogExportResult(document, { ...state, format: "png", raster: { ...state.raster, scale: 3 },
      presentation: { width: 1200, dpi: 300, crop: "page", background: "white" } });
    const { request } = native.invoke.mock.calls.at(-1)![1];
    expect(request).toMatchObject({ scale: 1, cssPxPerInch: 300 });
    expect(new DOMParser().parseFromString(request.svg, "image/svg+xml").documentElement.getAttribute("width")).toBe("1200");
  });
});
