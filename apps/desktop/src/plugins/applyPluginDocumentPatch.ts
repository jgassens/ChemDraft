import { applyPatch, type ApplyPatchOptions, type ChemDraftDocument } from "@chemdraft/chem-core";
import {
  AppliedPatchReceiptSchema,
  type AppliedPatchReceipt,
  type NormalizedProposedDocumentPatch
} from "@chemdraft/plugin-api";

export interface AppliedPluginDocumentPatch {
  document: ChemDraftDocument;
  receipt: AppliedPatchReceipt;
}

/**
 * Apply a validated plugin patch through chem-core, then select every object that the patch inserted.
 * Both patch operations are assembled before the caller commits the returned document, so the desktop
 * records exactly one history entry for the command.
 */
export function applyPluginDocumentPatch(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  options: ApplyPatchOptions = {}
): AppliedPluginDocumentPatch {
  const now = options.now ?? new Date();
  const beforeIds = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  const patched = applyPatch(document, proposed.patch, { ...options, now });
  const objectIds = patched.pages.flatMap((page) =>
    page.objects.filter((object) => !beforeIds.has(object.id)).map((object) => object.id)
  );

  let selected = patched;
  if (objectIds.length > 0) {
    const page = patched.pages.find((candidate) =>
      objectIds.every((objectId) => candidate.objects.some((object) => object.id === objectId))
    );
    if (page) {
      selected = applyPatch(
        patched,
        { op: "setSelection", pageId: page.id, objectIds },
        { ...options, now }
      );
    }
  }

  return {
    document: selected,
    receipt: AppliedPatchReceiptSchema.parse({ applied: true, objectIds })
  };
}
