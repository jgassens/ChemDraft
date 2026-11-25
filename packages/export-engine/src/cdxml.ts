import { exportDocumentToCdxml as exportCompatDocumentToCdxml, type CdxmlDocumentStyle } from "@chemdraft/cdx-compat";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { getExportFormatDescriptor } from "./formats";
import type { ExportWarning, TextExportResult } from "./results";

export interface CdxmlTextExportOptions {
  creationProgram?: string;
  /** Root-element drawing settings to declare; style the molecules to match first. */
  documentStyle?: CdxmlDocumentStyle;
}

export function exportDocumentToCdxml(
  document: ChemDraftDocument,
  options: CdxmlTextExportOptions = {}
): TextExportResult {
  const descriptor = getExportFormatDescriptor("cdxml");
  const result = exportCompatDocumentToCdxml(document, options);

  return {
    format: "cdxml",
    kind: "text",
    contents: result.contents,
    mimeType: descriptor.mimeType,
    extension: descriptor.extensions[0] ?? "cdxml",
    warnings: result.warnings.map<ExportWarning>((warning) => ({
      code: warning.code,
      message: warning.message,
      severity: "warning",
      objectId: warning.sourceObjectId
    }))
  };
}
