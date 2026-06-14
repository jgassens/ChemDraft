import type { ExportFormatId } from "./formats";

export type ExportWarningSeverity = "info" | "warning" | "error";

export interface ExportWarning {
  code: string;
  message: string;
  severity?: ExportWarningSeverity;
  objectId?: string;
}

export interface TextExportResult {
  format: ExportFormatId;
  kind: "text";
  contents: string;
  mimeType: string;
  extension: string;
  warnings: ExportWarning[];
}

export interface BinaryExportResult {
  format: ExportFormatId;
  kind: "binary";
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  warnings: ExportWarning[];
}

export type ExportResult = TextExportResult | BinaryExportResult;
