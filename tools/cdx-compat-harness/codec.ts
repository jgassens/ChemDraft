import { openChemDraftPayload } from "../../packages/cdx-compat/src/index";
import { exportDocumentToCdxml } from "../../packages/export-engine/src/cdxml";
import { withNativeDocumentLabelBondSides } from "../../packages/document-workflow-core/src/atoms";
import type { ChemDraftDocument } from "../../packages/chem-core/src/index";
import { warning, type Format } from "./model";

export const noCdxSupport = "no CDX support in this build";
type BinaryCodec = {
  importCdx: (bytes: Uint8Array) => ReturnType<typeof openChemDraftPayload>;
  exportDocumentToCdx: (document: ChemDraftDocument, options: { embedNativePayload: false }) => { bytes: Uint8Array; warnings: Parameters<typeof warning>[0][] };
};
export async function loadCdxSupport(): Promise<BinaryCodec | undefined> {
  try {
    const module = await import("../../packages/cdx-compat/src/index") as unknown as Partial<BinaryCodec>;
    if (typeof module.importCdx === "function" && typeof module.exportDocumentToCdx === "function") return module as BinaryCodec;
  } catch { /* Binary support is optional; CDXML remains available. */ }
}

export async function open(bytes: Uint8Array) {
  const binary = Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "VjCD";
  const codec = binary ? await loadCdxSupport() : undefined;
  if (binary && !codec) throw new Error(noCdxSupport);
  const result = binary ? codec!.importCdx(bytes) : openChemDraftPayload(Buffer.from(bytes).toString("utf8"));
  const notXml = result.warnings.some(w => ["cdxml.not_cdxml_xml", "cdxml.unrecognized_payload", "cdxml.empty_payload"].includes(w.code)) || result.source === "legacy-json";
  const format: Format | "unknown" = binary ? "cdx" : notXml ? "unknown" : "cdxml";
  // Same decoder and label-side normalisation as the app's openNativeDocument.
  // Conflicting native payloads require UI review; never choose one silently in a test tool.
  return { format, document: result.conflict || format === "unknown" ? undefined : result.document && withNativeDocumentLabelBondSides(result.document), warnings: [
    ...result.warnings.map(warning),
    ...(result.document && format === "unknown" ? [warning({ code: "harness.unsupported_format", message: "The compatibility harness accepts CDX and CDXML inputs." })] : [])
  ] };
}

export async function interchange(document: ChemDraftDocument, format: Format) {
  if (format === "cdx") {
    const codec = await loadCdxSupport();
    if (!codec) throw new Error(noCdxSupport);
    const result = codec.exportDocumentToCdx(document, { embedNativePayload: false });
    return { bytes: result.bytes, warnings: result.warnings.map(warning) };
  }
  const result = exportDocumentToCdxml(document);
  // The app's CDXML export embeds a lossless native payload. Strip only its objecttags
  // to test the standard visible representation that independent readers actually consume.
  const visible = result.contents.replace(/<objecttag\b[^>]*\bName="org\.chemdraft\/[^"]*"[^>]*(?:\/>|>[\s\S]*?<\/objecttag>)/g, "");
  return { bytes: Buffer.from(visible, "utf8"), warnings: result.warnings.map(warning) };
}
