// Small pure helpers shared by the document-building modules: ids, page access, numeric utilities.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { LayoutPoint } from "@chemdraft/layout-engine";

export const phase4Timestamp = "2026-05-29T00:00:00.000Z";

export type PagePoint = LayoutPoint;

export function nextObjectId(document: ChemDraftDocument, prefix: string, reserved?: ReadonlySet<string>): string {
  const existingIds = new Set(document.pages.flatMap((page) => page.objects.map((object) => object.id)));
  let index = existingIds.size + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;

  // `reserved` covers ids issued but not yet applied — see SmilesMoleculeSource.reservedObjectIds.
  while (existingIds.has(id) || reserved?.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }

  return id;
}

export function firstPage(document: ChemDraftDocument): ChemDraftDocument["pages"][number] {
  const page = document.pages[0];
  if (!page) {
    throw new Error("Cannot update page layout: document has no pages.");
  }

  return page;
}

// The same numeric helpers layout-engine uses, re-exported rather than copied (AGENTS.md §5.26).
export { clamp, distance } from "@chemdraft/layout-engine";
