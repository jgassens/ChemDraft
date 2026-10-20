import type { ExportOptions } from "./exportOptions";

export function exportFixture(): ExportOptions {
  return { format: "pdf", filename: "Drawing.pdf", svg: { includeWarnings: true, includePageGuides: false },
    pdf: { compress: true, includePageGuides: false, page: "current", pdfType: "vector", background: "white" },
    raster: { scale: 1, background: "white", jpegQuality: 90, maxDimensionPx: 8192 }, cdxml: { creationProgram: "ChemDraft" } };
}
