// @vitest-environment jsdom
import { Resvg } from "@resvg/resvg-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectClipboardPayload } from "@chemdraft/clipboard-adapter";
import { createDefaultExportDialogState, createDialogExportResult } from "./MainWindow";
import { applyClipboardPastePayload, createPhase4Document, insertNativeTemplateMolecule } from "./documentWorkflow";
import { picturePngBase64, pictureSvg } from "./testSupport/imageFixture";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => true
}));
afterEach(() => { vi.clearAllMocks(); });

function pageWithPicture(mimeType: "image/png" | "image/svg+xml") {
  const document = insertNativeTemplateMolecule(createPhase4Document("Raster pictures"), { x: 500, y: 300 }, "benzene");
  return applyClipboardPastePayload(document, inspectClipboardPayload({
    types: [mimeType], textItems: [],
    imageItems: [{ type: mimeType, bytesBase64: mimeType === "image/png" ? picturePngBase64 : btoa(pictureSvg) }]
  }), { x: 200, y: 200 }).document;
}

describe("picture page raster requests", () => {
  it.each(["image/png", "image/svg+xml"] as const)("sends a nonblank benzene + %s page at 1x and 3x", async mimeType => {
    const document = pageWithPicture(mimeType);
    native.invoke.mockResolvedValue({ bytes: [1, 2, 3], width: 1, height: 1, warnings: [] });
    let previousSvg: string | undefined;
    for (const scale of [1, 3]) {
      const state = createDefaultExportDialogState(document);
      await createDialogExportResult(document, { ...state, format: "png", presentation: undefined, raster: { ...state.raster, scale } });
      const [command, { request }] = native.invoke.mock.calls.at(-1)!;
      expect(command).toBe("rasterize_svg");
      expect(request).toMatchObject({ format: "png", scale, cssPxPerInch: 96, background: "#ffffff" });
      const svg = new DOMParser().parseFromString(request.svg, "image/svg+xml");
      expect(svg.querySelector("parsererror")).toBeNull();
      expect(svg.documentElement.getAttribute("viewBox")).toBe(`0 0 ${document.pages[0].width} ${document.pages[0].height}`);
      expect(svg.querySelector("image")?.getAttribute("href")).toMatch(new RegExp(`^data:${mimeType.replace("+", "\\+")};base64,`));
      if (previousSvg) expect(request.svg).toBe(previousSvg);
      previousSvg = request.svg;

      // Exercise the exact app-produced markup with the JS resvg build. Native 0.47
      // pixel coverage is in export.rs; this also catches app sizing/layering regressions.
      const rendered = new Resvg(request.svg, { font: { loadSystemFonts: false }, fitTo: { mode: "zoom", value: scale } }).render();
      const blueOffset = (200 * scale * rendered.width + 200 * scale) * 4;
      expect([...rendered.pixels.subarray(blueOffset, blueOffset + 4)]).toEqual([0, 0, 255, 255]);

      // Disabling raster image decoding skips the image; it cannot hide the ring.
      // Verify that a missing picture alone cannot account for an entirely white 1x page.
      const withoutPicture = request.svg.replace(/<image\b[^>]*\/>/g, "");
      const ring = new Resvg(withoutPicture, { font: { loadSystemFonts: false }, fitTo: { mode: "zoom", value: scale } }).render();
      let darkPixels = 0;
      const pixels = ring.pixels;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 128 && pixels[i + 1] < 128 && pixels[i + 2] < 128 && pixels[i + 3] === 255) darkPixels++;
      }
      expect(darkPixels).toBeGreaterThan(100 * scale);
    }
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
