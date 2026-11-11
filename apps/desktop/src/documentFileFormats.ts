import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { exportDocumentToCdx } from "@chemdraft/cdx-compat";
import type { BinaryExportResult, ExportResult } from "@chemdraft/export-engine";
import { createNativeSavePayload } from "./documentWorkflow";

/** Both destinations share the codec; only a document save includes native state. */
export function exportDocumentCdx(document: ChemDraftDocument, embedNativePayload: boolean): BinaryExportResult {
  return {
    ...exportDocumentToCdx(document, { embedNativePayload }),
    format: "cdx",
    kind: "binary",
    mimeType: "chemical/x-cdx",
    extension: "cdx"
  };
}

export function createDocumentFileSave(document: ChemDraftDocument, path?: string): ExportResult & { filename: string } {
  if (path && /\.cdx$/i.test(path)) {
    return { ...exportDocumentCdx(document, true), filename: path.split(/[\\/]/).pop()! };
  }
  return { ...createNativeSavePayload(document), format: "cdxml", kind: "text", extension: "chemdraft" };
}
