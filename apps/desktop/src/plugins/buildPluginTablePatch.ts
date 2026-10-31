import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { buildTableObject, nextObjectId } from "@chemdraft/document-workflow-core";
import type { PluginTableSpec, ProposedDocumentPatch } from "@chemdraft/plugin-api";
import { selectionBounds } from "../documentWorkflow";
import { RESERVED_PLUGIN_OBJECT_IDS } from "./reservedObjectIds";

/** Prepare only: the plugin host sends this through its ordinary command-scoped patch path. */
export function buildPluginTablePatch(spec: PluginTableSpec, document: ChemDraftDocument,
  selection: readonly string[], viewport?: { x: number; y: number; width: number; height: number }): ProposedDocumentPatch {
  const page = document.pages.find(page => page.objects.some(object => selection.includes(object.id)))
    ?? document.pages.find(page => page.id === document.selection.pageId) ?? document.pages[0]!;
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
  const selected = selectionBounds(page.objects, selection);
  const visible = viewport ?? { x: 0, y: 0, width: page.width, height: page.height };
  const placed = { ...object,
    x: selected ? selected.x + selected.width + 12 : visible.x + (visible.width - object.width) / 2,
    y: selected ? selected.y + (selected.height - object.height) / 2 : visible.y + (visible.height - object.height) / 2
  };
  return { reason: "Insert table", patch: { op: "addObject", pageId: page.id, object: placed } };
}
