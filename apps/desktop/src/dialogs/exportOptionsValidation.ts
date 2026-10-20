import { exportFormatDescriptors } from "@chemdraft/export-engine";
import type { ExportDialogState, ExportOptions } from "./exportOptions";

export const exportOptions = ({ busy: _busy, ...options }: ExportDialogState): ExportOptions => options;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fields = (v: unknown, names: string[]): v is Record<string, unknown> => record(v) &&
  names.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => names.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !v.includes("\0");
const number = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
/** Keep this strict shape in step with Rust. Paths are hints, never file-access grants. */
export function validExportOptions(v: unknown): v is ExportOptions {
  if (!record(v)) return false;
  const required = ["format", "filename", "svg", "pdf", "raster", "cdxml"];
  if (!required.every(k => Object.hasOwn(v, k)) || Object.keys(v).some(k => ![...required, "destinationPath", "presentation"].includes(k))) return false;
  return exportFormatDescriptors.some(d => d.id === v.format) && text(v.filename, 256) && v.filename.trim().length > 0 &&
    !/[\\/]/.test(v.filename) && (v.destinationPath === undefined || text(v.destinationPath, 1024)) &&
    fields(v.svg, ["includeWarnings", "includePageGuides"]) && typeof v.svg.includeWarnings === "boolean" && typeof v.svg.includePageGuides === "boolean" &&
    fields(v.pdf, ["compress", "includePageGuides", "page", "pdfType", "background"]) && typeof v.pdf.compress === "boolean" &&
    typeof v.pdf.includePageGuides === "boolean" && v.pdf.page === "current" && v.pdf.pdfType === "vector" && v.pdf.background === "white" &&
    fields(v.raster, ["scale", "background", "jpegQuality", "maxDimensionPx"]) && number(v.raster.scale, 1, 4) &&
    typeof v.raster.background === "string" && ["white", "transparent"].includes(v.raster.background) && number(v.raster.jpegQuality, 1, 100) && number(v.raster.maxDimensionPx, 1, 8192) &&
    (v.presentation === undefined || validPresentation(v.presentation)) &&
    fields(v.cdxml, ["creationProgram"]) && text(v.cdxml.creationProgram, 256);
}

export function validPresentation(v: unknown): boolean {
  if (!record(v)) return false;
  const required = ["width", "dpi", "crop", "background"];
  return required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, "height", "linked", "preset"].includes(k)) &&
    Number.isInteger(v.width) && number(v.width, 1, 8192) && (v.height === undefined || (Number.isInteger(v.height) && number(v.height, 1, 8192))) &&
    (v.linked === undefined || typeof v.linked === "boolean") &&
    (v.preset === undefined || (typeof v.preset === "string" && ["custom", "slide", "poster", "publication"].includes(v.preset))) &&
    number(v.dpi, 36, 1200) && typeof v.crop === "string" && ["page", "content"].includes(v.crop) && typeof v.background === "string" && ["white", "transparent"].includes(v.background);
}
