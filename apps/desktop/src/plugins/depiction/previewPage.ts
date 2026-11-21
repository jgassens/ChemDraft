import { applyPatch, type ChemDraftDocument, type DocumentPage } from "@chemdraft/chem-core";
import { PluginRequestLimits, type PluginRequestPatch } from "@chemdraft/plugin-api";
import { assertAuthoredBracketReferences, assertPreviewReferences, RequestWriteError } from "@chemdraft/plugin-host";

export function checkPageBudget(page: DocumentPage): void {
  const limits = PluginRequestLimits;
  if (page.objects.length > limits.objects) {
    throw new RequestWriteError("limit", `Depiction supports up to ${limits.objects} objects per page.`);
  }
  let atoms = 0, bonds = 0;
  const ids = new Set<string>();
  for (const object of page.objects) {
    if (ids.has(object.id)) throw new RequestWriteError("invalid", `Object ID "${object.id}" is ambiguous on this page.`);
    ids.add(object.id);
    if (object.type !== "molecule") continue;
    atoms += object.atoms.length;
    bonds += object.bonds.length;
    if (atoms > limits.atomsPerMolecule || bonds > limits.bondsPerMolecule) {
      throw new RequestWriteError("limit", `Depiction supports up to ${limits.atomsPerMolecule} atoms and ${limits.bondsPerMolecule} bonds per page.`);
    }
  }
}

/** A detached page draft for depiction and planning. Preserves authored preview IDs, which
 * callers use to measure proposed additions. The request write pipeline still assigns final IDs. */
export function prepareDepictionPage(document: ChemDraftDocument, pageId: string, preview?: PluginRequestPatch) {
  const page = document.pages.find(candidate => candidate.id === pageId);
  if (!page) throw new RequestWriteError("invalid", `Page "${pageId}" does not exist in the request document.`);
  checkPageBudget(page);
  const scoped = { ...document, pages: [page], selection: { objectIds: [] } };
  if (!preview) return { document: scoped, page };
  const ops = preview.op === "batch" ? preview.patches : [preview];
  const ids = new Set(page.objects.map(object => object.id));
  const edited = new Set<string>();
  for (const op of ops) {
    if ("pageId" in op && op.pageId !== pageId) throw new RequestWriteError("invalid", "Preview operations must target the requested page.");
    if (op.op === "addObject" || op.op === "addAnnotation") {
      const id = (op.op === "addObject" ? op.object : op.annotation).id;
      if (ids.has(id)) throw new RequestWriteError("invalid", `Preview object ID "${id}" already exists.`);
      ids.add(id);
      edited.add(id);
    } else if ("objectId" in op) {
      if (op.op === "updateObject" && ("id" in op.changes || "type" in op.changes)) {
        throw new RequestWriteError("invalid", "Preview updates cannot change an object's ID or type.");
      }
      edited.add(op.objectId);
      if (op.op === "removeObject") ids.delete(op.objectId);
    }
  }
  try {
    const draft = applyPatch(scoped, preview);
    const draftPage = draft.pages[0]!;
    checkPageBudget(draftPage);
    assertPreviewReferences(page.objects, draftPage.objects, edited);
    assertAuthoredBracketReferences(ops, new Map(draftPage.objects.map(object => [object.id, { object }])));
    return { document: draft, page: draftPage };
  } catch (error) {
    if (error instanceof RequestWriteError) throw error;
    throw new RequestWriteError("invalid", `Invalid depiction preview. ${(error as Error).message}`);
  }
}
