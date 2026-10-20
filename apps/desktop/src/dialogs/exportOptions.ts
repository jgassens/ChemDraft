import type { ExportFormatId } from "@chemdraft/export-engine";
export type ExportDialogFormat = ExportFormatId;
export interface ExportPresentationOptions {
  width: number;
  height?: number;
  linked?: boolean;
  preset?: "custom" | "slide" | "poster" | "publication";
  dpi: number;
  crop: "page" | "content";
  background: "white" | "transparent";
}
export interface ExportFrame { revision?: number; page: { width: number; height: number }; content: { width: number; height: number } }
export interface ExportPreviewResult { url: string; kind: "image" | "pdf"; width: number; height: number; warnings: string[] }
export type SvgDialogExportOptions = {
  includeWarnings: boolean;
  includePageGuides: boolean;
};
export type PdfDialogExportOptions = {
  compress: boolean;
  includePageGuides: boolean;
  page: "current";
  pdfType: "vector";
  background: "white";
};
export type RasterDialogExportOptions = {
  scale: number;
  background: "white" | "transparent";
  jpegQuality: number;
  maxDimensionPx: number;
};
export type CdxmlDialogExportOptions = {
  creationProgram: string;
};
export type ExportDialogState = {
  format: ExportDialogFormat;
  filename: string;
  destinationPath?: string;
  svg: SvgDialogExportOptions;
  pdf: PdfDialogExportOptions;
  raster: RasterDialogExportOptions;
  cdxml: CdxmlDialogExportOptions;
  busy: boolean;
  presentation?: ExportPresentationOptions;
};

export type ExportOptions = Omit<ExportDialogState, "busy">;
