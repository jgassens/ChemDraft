import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { withNativeDocumentLabelBondSides } from "./atoms";

interface NativeDocumentPayload {
  document?: ChemDraftDocument;
  conflict?: { embeddedDocument: ChemDraftDocument; visibleDocument?: ChemDraftDocument };
}

/** Shared app/agent open path. The caller injects the container decoder (native JSON or CDXML
 * envelope), which uses chem-core's tolerant reader and retains its warnings/version envelope.
 * Keeping decoding injected avoids coupling pure document workflows to a file-format package. */
export function readNativeDocumentContents<T extends NativeDocumentPayload>(
  contents: string,
  readPayload: (contents: string) => T
): T {
  const result = readPayload(contents);
  const { conflict } = result;
  return {
    ...result,
    ...(result.document ? { document: withNativeDocumentLabelBondSides(result.document) } : {}),
    ...(conflict ? { conflict: {
      ...conflict,
      embeddedDocument: withNativeDocumentLabelBondSides(conflict.embeddedDocument),
      ...(conflict.visibleDocument ? { visibleDocument: withNativeDocumentLabelBondSides(conflict.visibleDocument) } : {})
    } } : {})
  };
}
