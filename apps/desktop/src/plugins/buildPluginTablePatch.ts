import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { buildTableObject, nextObjectId } from "@chemdraft/document-workflow-core";
import type { PluginTableSpec, ProposedDocumentPatch } from "@chemdraft/plugin-api";
import { resolveObjectOnPage, type PageObjectRef } from "@chemdraft/plugin-host";
import { selectionBounds } from "../documentWorkflow";
import { RESERVED_PLUGIN_OBJECT_IDS } from "./reservedObjectIds";

/** Prepare only: the plugin host sends this through its ordinary command-scoped patch path.
 * `selection` names each anchor by page and id; a same-id object on another page is never an anchor. */
export function buildPluginTablePatch(spec: PluginTableSpec, document: ChemDraftDocument,
  selection: readonly PageObjectRef[], viewport?: { x: number; y: number; width: number; height: number }): ProposedDocumentPatch {
  const anchors = selection.filter(ref => resolveObjectOnPage(document, ref.pageId, ref.objectId));
  // The first anchored page in document order, as before, but resolved by page rather than by bare id.
  const page = document.pages.find(page => anchors.some(ref => ref.pageId === page.id))
    ?? document.pages.find(page => page.id === document.selection.pageId) ?? document.pages[0]!;
  const anchorIds = anchors.filter(ref => ref.pageId === page.id).map(ref => ref.objectId);
  const newId = (prefix: string) => {
    const id = nextObjectId(document, prefix, RESERVED_PLUGIN_OBJECT_IDS);
    RESERVED_PLUGIN_OBJECT_IDS.add(id);
    return id;
  };
  const id = newId("table");
  let row = 0;
  let column = 0;
  const localId = (prefix: string) => prefix === "row" ? `${id}-r${++row}` : `${id}-c${++column}`;
  const { object } = buildTableObject(spec, { id, x: 0, y: 0, newId: localId });
  const selected = selectionBounds(page.objects, anchorIds);
  const visible = viewport ?? { x: 0, y: 0, width: page.width, height: page.height };
  const placed = { ...object,
    x: selected ? selected.x + selected.width + 12 : visible.x + (visible.width - object.width) / 2,
    y: selected ? selected.y + (selected.height - object.height) / 2 : visible.y + (visible.height - object.height) / 2
  };
  return { reason: "Insert table", patch: { op: "addObject", pageId: page.id, object: placed } };
}
