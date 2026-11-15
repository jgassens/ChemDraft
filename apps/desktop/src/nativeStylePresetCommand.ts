import type { ChemDraftDocument, CompatibilityWarning } from "@chemdraft/chem-core";
import { applyNativeStylePreset } from "@chemdraft/document-workflow-core";

/** Adapt the desktop's fragment selection to the shared molecule/text style scope. */
export function nativeStylePresetPatchForSelection(
  document: ChemDraftDocument, presetId: string, fragmentObjectIds: readonly string[],
  warnings: CompatibilityWarning[] = []
) {
  const objectIds = [...new Set([...document.selection.objectIds, ...fragmentObjectIds])];
  const scoped = fragmentObjectIds.length
    ? { ...document, selection: { ...document.selection, objectIds } } : document;
  const patch = applyNativeStylePreset(scoped, presetId, objectIds.length ? "selection" : "document", warnings);
  // The planner sees fragment hosts as selected. If all hosts changed it need not emit selection,
  // but the original document may have an empty object-ID selection (a lassoed fragment).
  if (scoped !== document && patch.patches.length && !patch.patches.some(leaf => leaf.op === "setSelection")) {
    patch.patches.push({ op: "setSelection", pageId: document.selection.pageId, objectIds });
  }
  return patch;
}
