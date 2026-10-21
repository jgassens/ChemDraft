// @vitest-environment jsdom
import { saveExportPreviewEnabled } from "../exportPreviewSettings";
import { MemoryStorage } from "../testSupport/memoryStorage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundExportNotice, createDefaultExportDialogState, createDialogExportResult, formatExportStatus } from "../MainWindow";
import { applyNativeChainTool, createPhase4Document, exportPhase4Cdxml, exportPhase4Pdf, exportPhase4Svg, insertNativeBracket } from "../documentWorkflow";
import { parseDialogMessage } from "./dialogProtocol";
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

it.each(["a", "\\\"\n", "🧪", "\u0001"])("bounds the full warning receipt including its suffix (%s)", character => {
  const notice = boundExportNotice(character.repeat(1500));
  expect(notice).toContain("Additional warning details omitted.");
  expect(notice.length).toBeLessThanOrEqual(1024);
  expect(new TextEncoder().encode(JSON.stringify(notice)).length).toBeLessThanOrEqual(1000);
  const message = { protocolVersion: 1, ownerWindowId: "main", documentTabId: "t".repeat(128), dialogKind: "export", sessionId: "s".repeat(128), requestId: "r".repeat(128), snapshotRevision: Number.MAX_SAFE_INTEGER, type: "result", data: { status: "exported", notice } };
  expect(parseDialogMessage(message)).toBeDefined();
  const delivery = { senderWindowId: "main", windowLabel: `dialog-main-export-${"h".repeat(128)}`, message };
  expect(new TextEncoder().encode(JSON.stringify(delivery)).length).toBeLessThanOrEqual(4096);
});

it("retains an accepted, abbreviated success notice for six curly brackets exported to CDXML", async () => {
  let document = createPhase4Document("Warning receipt");
  for (let i = 0; i < 6; i++) document = insertNativeBracket(document, { x: 100 + i * 50, y: 100 }, "curly");
  const result = await createDialogExportResult(document, { ...exportFixture(), format: "cdxml", busy: false });
  expect(result.warnings.length).toBeGreaterThanOrEqual(6);
  const details = [formatExportStatus("CDXML", result.format, result.warnings), ...result.warnings.map(warning => warning.message)].join("\n");
  const notice = boundExportNotice(details);
  expect(notice).toContain("Additional warning details omitted.");
  expect(notice.length).toBeLessThanOrEqual(1024);
  expect(parseDialogMessage({ protocolVersion: 1, ownerWindowId: "main", documentTabId: "tab", dialogKind: "export", sessionId: "session", requestId: "request", snapshotRevision: 1, type: "result", data: { status: "exported", notice } })).toBeDefined();
});

it.each(["svg", "cdxml", "pdf", "png", "jpeg", "bmp", "gif", "tiff"] as const)("keeps %s file bytes identical across preference modes for equal options", async format => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.42);
  native.raster.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), warnings: [] });
  const document = createPhase4Document("Preference parity");
  const state = { ...exportFixture(), format, busy: false };
  saveExportPreviewEnabled(false);
  const legacy = await createDialogExportResult(document, state);
  saveExportPreviewEnabled(true);
  const enabled = await createDialogExportResult(document, state);
  expect(enabled).toEqual(legacy);
});
