import { BatchDocumentPatchSchema, type Anchor, type CompatibilityWarning,
  type DocumentObject, type DocumentPatch } from "@chemdraft/chem-core";
import type { ChemDraftDocument, NormalizedProposedDocumentPatch } from "@chemdraft/plugin-api";

/** Rebase insertions and native references before either scope preflight or application. */
export function rebasePluginPatch(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  retargetMissingPages = false
): NormalizedProposedDocumentPatch {
  const patch = proposed.patch as DocumentPatch;
  if (patch.op === "batch") BatchDocumentPatchSchema.parse(patch);
  const ops = (patch.op === "batch" ? patch.patches : [patch]) as Exclude<DocumentPatch, { op: "batch" }>[];
  const existingIds = new Set(document.pages.flatMap((page) => page.objects.map((candidate) => candidate.id)));
  // Reserve future insertion ids as well, so an allocated id cannot steal a later insertion's name.
  const reservedIds = new Set(existingIds);
  for (const op of ops) {
    if (op.op === "addObject") reservedIds.add(op.object.id);
    if (op.op === "addAnnotation") reservedIds.add(op.annotation.id);
  }
  // Allocate every insertion first: native references can point to the insertion itself or to a
  // later batch member. Operation targets still follow batch order (an earlier edit targets the
  // original object, while an edit after its colliding insertion targets the new object).
  const insertionIds = new Map<string, string>();
  let needsReferenceRemap = false;
  const allocatedOps = ops.map(op => {
    if (op.op !== "addObject" && op.op !== "addAnnotation") return op;
    const insertion = rebaseInsertion(op);
    const originalId = op.op === "addObject" ? op.object.id : op.annotation.id;
    const id = insertion.op === "addObject" ? insertion.object.id : insertion.annotation.id;
    needsReferenceRemap ||= originalId !== id;
    if (!insertionIds.has(originalId)) insertionIds.set(originalId, id);
    existingIds.add(id);
    reservedIds.add(id);
    return insertion;
  });
  // Pair ids occupy their own namespace. Reserve incoming names before allocating, including
  // pairs whose object ids do not collide, so no insertion can merge with an existing SRU.
  const existingPairIds = new Set(document.pages.flatMap(page => page.objects.flatMap(object =>
    object.type === "bracket" && object.pairId ? [object.pairId] : [])));
  const reservedPairIds = new Set(existingPairIds);
  for (const op of ops) {
    if (op.op === "addObject" && op.object.type === "bracket" && op.object.pairId) reservedPairIds.add(op.object.pairId);
  }
  const pairIds = new Map<string, string>();
  for (const op of ops) {
    if (op.op !== "addObject" || op.object.type !== "bracket" || !op.object.pairId) continue;
    const pairId = op.object.pairId;
    if (pairIds.has(pairId)) continue;
    const id = existingPairIds.has(pairId) ? freshObjectId(reservedPairIds, pairId) : pairId;
    pairIds.set(pairId, id);
    reservedPairIds.add(id);
  }
  const remappedIds = new Map<string, string>();
  const rebasedOps = allocatedOps.map((op, index): DocumentPatch => {
    const remap = (id: string): string => remappedIds.get(id) ?? id;
    if (op.op !== "addObject" && op.op !== "addAnnotation") {
      if ("objectId" in op) {
        if (op.op !== "updateObject") return { ...op, objectId: remap(op.objectId) };
        const changes = remapObjectReferences(op.changes, remap);
        if (remappedIds.has(op.objectId) && "pairId" in changes && changes.pairId) {
          changes.pairId = pairIds.get(changes.pairId) ?? changes.pairId;
        }
        return { ...op, objectId: remap(op.objectId), changes: {
          ...changes, ...(changes.id === undefined ? {} : { id: remap(changes.id) })
        } };
      }
      if ("objectIds" in op) return { ...op, objectIds: op.objectIds.map(remap) };
      if (op.op === "removeAnnotation") return { ...op, annotationId: remap(op.annotationId) };
      const bondRef = (ref: { objectId: string; bondId: string }) => ({ ...ref, objectId: remap(ref.objectId) });
      if (op.op === "setCrossingOverride") return { ...op, crossing: {
        ...op.crossing, bonds: [bondRef(op.crossing.bonds[0]), bondRef(op.crossing.bonds[1])], front: bondRef(op.crossing.front)
      } };
      if (op.op === "clearCrossingOverride") return { ...op, bonds: [bondRef(op.bonds[0]), bondRef(op.bonds[1])] };
      return op;
    }
    const original = ops[index]!;
    if (original.op !== "addObject" && original.op !== "addAnnotation") throw new Error("Expected an allocated insertion.");
    const originalId = original.op === "addObject" ? original.object.id : original.annotation.id;
    const id = op.op === "addObject" ? op.object.id : op.annotation.id;
    const referenceId = (reference: string) => reference === originalId ? id :
      remappedIds.get(reference) ?? insertionIds.get(reference) ?? reference;
    let insertion = !needsReferenceRemap ? op : op.op === "addObject"
      ? { ...op, object: remapObjectReferences(op.object, referenceId) as DocumentObject }
      : { ...op, annotation: remapObjectReferences(op.annotation, referenceId) as typeof op.annotation };
    if (insertion.op === "addObject" && insertion.object.type === "bracket" && insertion.object.pairId) {
      insertion = { ...insertion, object: { ...insertion.object, pairId: pairIds.get(insertion.object.pairId)! } };
    }
    remappedIds.set(originalId, id);
    return insertion;
  });
  if (patch.op === "batch") return { ...proposed, patch: { op: "batch", patches: rebasedOps } };
  if (rebasedOps[0] === patch) return proposed;
  return { ...proposed, patch: rebasedOps[0]! };

  function rebaseInsertion(patch: Extract<DocumentPatch, { op: "addObject" | "addAnnotation" }>) {
    const object: DocumentObject = patch.op === "addObject" ? patch.object : patch.annotation;
    const fallbackPage = document.pages[0];
    const pageExists = document.pages.some((page) => page.id === patch.pageId);
    // Missing pages on a direct write remain an error for chem-core to report.
    const retarget = retargetMissingPages && !pageExists && fallbackPage;
    let rebased: DocumentObject = object;
    if (existingIds.has(object.id)) rebased = { ...rebased, id: freshObjectId(reservedIds, object.id) };
    const pageId = retarget ? fallbackPage.id : patch.pageId;
    if (retarget) rebased = centredOnPage(rebased, fallbackPage);
    if (rebased === object && pageId === patch.pageId) return patch;

    return patch.op === "addObject"
      ? { ...patch, pageId, object: rebased }
      : { ...patch, pageId, annotation: rebased as typeof patch.annotation };
  }
}

/**
 * All native object references in chem-core/schemas.ts, including structured warning references.
 * Atom/bond ids (anchors, bond endpoints, labelBondSide) are molecule-local and never rebased here;
 * their owning objectId changes. Provenance originalId, chemistry strings and opaque data stay intact.
 * Inspect fields rather than `type`: updateObject changes may omit the discriminant.
 */
function remapObjectReferences(object: Partial<DocumentObject>, remap: (id: string) => string): Partial<DocumentObject> {
  const anchor = (value: Anchor): Anchor => ({ ...value,
    ...(value.objectId === undefined ? {} : { objectId: remap(value.objectId) })
  });
  const warnings = (values: CompatibilityWarning[] = []) => values.map(value => ({ ...value,
    ...(value.objectId === undefined ? {} : { objectId: remap(value.objectId) })
  }));
  const attachments = <T extends { attachmentPoints: Anchor[]; warnings: CompatibilityWarning[] }>(value: T): T =>
    ({ ...value, attachmentPoints: (value.attachmentPoints ?? []).map(anchor), warnings: warnings(value.warnings) });
  const next = { ...object };
  if (next.compatibility) next.compatibility = { ...next.compatibility,
    unknown: remapPreservedReferences(next.compatibility.unknown, remap),
    warnings: warnings(next.compatibility.warnings) };
  if ("warnings" in next && next.warnings) next.warnings = warnings(next.warnings);
  if ("chemistry" in next && next.chemistry) next.chemistry = { ...next.chemistry, warnings: warnings(next.chemistry.warnings) };
  if ("metadata" in next && next.metadata) next.metadata = attachments(next.metadata);
  if ("display" in next && next.display) next.display = attachments(next.display);
  if ("superatoms" in next && next.superatoms) next.superatoms = next.superatoms.map(attachments);
  if ("rGroups" in next && next.rGroups) next.rGroups = next.rGroups.map(attachments);
  if ("components" in next && next.components) next.components = next.components.map((c) => ({ ...c, objectId: remap(c.objectId) }));
  if ("conditionsTextObjectIds" in next && next.conditionsTextObjectIds) next.conditionsTextObjectIds = next.conditionsTextObjectIds.map(remap);
  if ("arrowObjectIds" in next && next.arrowObjectIds) next.arrowObjectIds = next.arrowObjectIds.map(remap);
  if ("plusObjectIds" in next && next.plusObjectIds) next.plusObjectIds = next.plusObjectIds.map(remap);
  if ("containedObjectIds" in next && next.containedObjectIds) next.containedObjectIds = next.containedObjectIds.map(remap);
  if ("crossingBondIds" in next && next.crossingBondIds) next.crossingBondIds = next.crossingBondIds.map(ref => ({ ...ref, objectId: remap(ref.objectId) }));
  if ("arrowAttachment" in next && next.arrowAttachment) next.arrowAttachment = {
    ...next.arrowAttachment, parentObjectId: remap(next.arrowAttachment.parentObjectId)
  };
  if ("childObjectIds" in next && next.childObjectIds) next.childObjectIds = next.childObjectIds.map(remap);
  if ("targetObjectIds" in next && next.targetObjectIds) next.targetObjectIds = next.targetObjectIds.map(remap);
  if ("labels" in next && next.labels) next.labels = next.labels.map(remap);
  for (const key of ["start", "end", "source", "target", "anchor"] as const) {
    if (key in next) {
      const value = (next as Partial<Record<typeof key, Anchor>>)[key];
      if (value) Object.assign(next, { [key]: anchor(value) });
    }
  }
  return next;
}

/** These compatibility records contain live native references used by export and removal.
 * Remap only their known fields; CDXML source ids, atom snapshots and opaque metadata are provenance. */
function remapPreservedReferences(unknown: Record<string, unknown>, remap: (id: string) => string): Record<string, unknown> {
  const next = { ...unknown };
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const ids = (value: unknown) => Array.isArray(value) ? value.map(id => typeof id === "string" ? remap(id) : id) : value;
  if (record(next.cdxmlStepReferences)) next.cdxmlStepReferences = Object.fromEntries(
    Object.entries(next.cdxmlStepReferences).map(([key, value]) => [key, ids(value)]));
  if (Array.isArray(next.cdxmlBracketMembers)) next.cdxmlBracketMembers = next.cdxmlBracketMembers.map(member =>
    record(member) && typeof member.objectId === "string" ? { ...member, objectId: remap(member.objectId) } : member);
  if (Array.isArray(next.cdxmlBracketCrossings)) next.cdxmlBracketCrossings = next.cdxmlBracketCrossings.map(crossing =>
    record(crossing) && record(crossing.ref) && typeof crossing.ref.objectId === "string"
      ? { ...crossing, ref: { ...crossing.ref, objectId: remap(crossing.ref.objectId) } } : crossing);
  if ("cdxmlBracketMemberObjectIds" in next) next.cdxmlBracketMemberObjectIds = ids(next.cdxmlBracketMemberObjectIds);
  if (typeof next.cdxmlBracketMembership === "string") {
    try {
      const membership: unknown = JSON.parse(next.cdxmlBracketMembership);
      if (Array.isArray(membership)) next.cdxmlBracketMembership = JSON.stringify(ids(membership));
    } catch { /* Preserve malformed provenance for the existing import/export warning path. */ }
  }
  return next;
}

/**
 * The first free `<prefix>_NNN` id, counting up from the document's object count — the same scheme the
 * document workflow's object-id allocator uses (`nextObjectId` in documentWorkflow.ts, not exported), so
 * an accepted structure reads like every other object in the file.
 */
function freshObjectId(existingIds: ReadonlySet<string>, collidingId: string): string {
  const prefix = collidingId.replace(/_\d+$/, "") || "object";
  let index = existingIds.size + 1;
  let id = `${prefix}_${String(index).padStart(3, "0")}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(3, "0")}`;
  }
  return id;
}

/**
 * A molecule moved, as a whole, so its box is centred on `page` — the placement it was given on the page
 * it was proposed for. A molecule's atoms carry page coordinates, so they move with its box; only
 * positions change. Other objects keep their coordinates (a recognition proposal is always a molecule).
 */
function centredOnPage(object: DocumentObject, page: ChemDraftDocument["pages"][number]): DocumentObject {
  if (object.type !== "molecule") return object;
  const dx = page.width / 2 - (object.x + object.width / 2);
  const dy = page.height / 2 - (object.y + object.height / 2);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return object;
  return {
    ...object,
    x: object.x + dx,
    y: object.y + dy,
    atoms: object.atoms.map((atom) => ({ ...atom, x: atom.x + dx, y: atom.y + dy }))
  };
}

