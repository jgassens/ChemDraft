import type { ExportFormatId } from "@chemdraft/export-engine";
export type ExportDialogFormat = ExportFormatId;
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
};

export type ExportOptions = Omit<ExportDialogState, "busy">;
