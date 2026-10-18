// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultExportDialogState, createDialogExportResult } from "../MainWindow";
import { applyNativeChainTool, createPhase4Document, exportPhase4Cdxml, exportPhase4Pdf, exportPhase4Svg } from "../documentWorkflow";
import { exportFixture } from "./exportTestFixtures";
import { rasterizeSvgNative } from "../nativeRasterExport";
const native = vi.hoisted(() => ({ raster: vi.fn() }));
vi.mock("../nativeRasterExport", () => ({ rasterizeSvgNative: native.raster }));
vi.mock("../window-manager", async original => ({ ...await original<typeof import("../window-manager")>(), isDesktopRuntime: () => true }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("Export form preserves the existing export pipeline", () => {
  it("keeps every default option unchanged", () => {
    const state = createDefaultExportDialogState(createPhase4Document("Drawing"));
    expect(state).toEqual({ ...exportFixture(), filename: "Drawing.pdf", destinationPath: undefined, busy: false });
  });
  it.each([false, true])("returns identical SVG and CDXML bytes with page guides=%s", async guides => {
    const document = applyNativeChainTool(createPhase4Document("Parity"), { x: 100, y: 100 }, { x: 200, y: 130 });
    const svg = { includeWarnings: !guides, includePageGuides: guides };
    const state = { ...exportFixture(), format: "svg" as const, busy: false, svg };
    const result = await createDialogExportResult(document, state);
    expect(result.kind === "text" && result.contents).toBe(exportPhase4Svg(document, svg).contents);
    const cdxml = { creationProgram: "  ChemDraft parity  " };
    const xml = await createDialogExportResult(document, { ...state, format: "cdxml", cdxml });
    expect(xml).toEqual(exportPhase4Cdxml(document, { creationProgram: "ChemDraft parity" }));
  });
  it.each([false, true])("returns identical PDF bytes with compression=%s (fixed date and PDF ID)", async compress => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
    await import("@chemdraft/export-engine/pdf");
    let seed = 42;
    vi.spyOn(Math, "random").mockImplementation(() => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; });
    // The existing PDF writer requires DOM globals even for a blank page.
    vi.stubGlobal("getComputedStyle", window.getComputedStyle.bind(window));
    const document = createPhase4Document("PDF parity");
    const pdf = { ...exportFixture().pdf, compress, includePageGuides: !compress };
    const result = await createDialogExportResult(document, { ...exportFixture(), format: "pdf", busy: false, pdf });
    seed = 42;
    const expected = await exportPhase4Pdf(document, { compress, includePageGuides: !compress });
    expect(result).toEqual(expected);
  });
  it.each(["png", "jpeg", "bmp", "gif", "tiff"] as const)("keeps %s raster input, options, bytes and warnings unchanged", async format => {
    const document = createPhase4Document("Raster parity");
    native.raster.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3]), warnings: [{ message: "Raster warning" }] });
    const raster = { scale: 3, background: "transparent" as const, jpegQuality: 83, maxDimensionPx: 4096 };
    const result = await createDialogExportResult(document, { ...exportFixture(), format, busy: false, raster });
    const transparent = format === "png";
    const svg = exportPhase4Svg(document, { includeWarnings: true, background: transparent ? "transparent" : "#ffffff" });
    expect(rasterizeSvgNative).toHaveBeenLastCalledWith(svg.contents, format, { scale: 3, background: transparent ? "transparent" : "#ffffff", jpegQuality: 83, maxDimensionPx: 4096 });
    expect(result.kind === "binary" && result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.warnings).toEqual([...svg.warnings, { message: "Raster warning" }]);
  });
});
