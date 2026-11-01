import {
  applyPatch,
  type Anchor,
  type ApplyPatchOptions,
  type ChemDraftDocument,
  type CompatibilityWarning,
  type DocumentObject,
  type DocumentPatch
} from "@chemdraft/chem-core";
import {
  AppliedPatchReceiptSchema,
  type AppliedPatchReceipt,
  type NormalizedProposedDocumentPatch
} from "@chemdraft/plugin-api";
import { writePatchOps } from "@chemdraft/plugin-host";
import { selectionBounds, translateInsertedDocumentObjects } from "../documentWorkflow";

export interface PluginPatchPlacementOptions extends ApplyPatchOptions {
  /** Page-space visible rectangle, read when the write actually commits (after gesture gating). */
  insertionTarget?: { pageId: string; bounds?: { x: number; y: number; width: number; height: number } };
}

export interface AppliedPluginDocumentPatch {
  document: ChemDraftDocument;
  receipt: AppliedPatchReceipt;
}

/**
 * Apply a validated plugin patch through chem-core, then select surviving inserted and changed objects.
 * Insertion, placement and selection are assembled before the caller commits the returned document,
 * so the desktop records exactly one history entry per plugin applyPatch call.
 */
export function applyPluginDocumentPatch(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  options: PluginPatchPlacementOptions = {}
): AppliedPluginDocumentPatch {
  const now = options.now ?? new Date();
  proposed = rebasePluginPatch(document, proposed, false);
  let patched = applyPatch(document, proposed.patch, { ...options, now });
  const inserted = new Set(writePatchOps(proposed.patch).flatMap(op => op.op === "addObject" ? [op.object.id] :
    op.op === "addAnnotation" ? [op.annotation.id] : []));
  const existingIds = new Set(document.pages.flatMap(page => page.objects.map(object => object.id)));
  // Placement, insertion and selection are all prepared before the ONE history commit.
  // Measure the surviving inserted group after all batch edits, and preserve its relative layout.
  for (const page of patched.pages) {
    const objects = page.objects.filter(object => inserted.has(object.id));
    // Moving even one member away from an existing anchor can detach a charge or warp an
    // arrow. Preserve the entire authored group, including off-page and oversized groups.
    if (objects.some(object => referencesExistingObject(object, existingIds))) continue;
    const bounds = pluginInsertionBounds(objects);
    if (!bounds) continue;
    const outside = bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > page.width || bounds.y + bounds.height > page.height;
    if (!outside) continue;
    if (bounds.width > page.width || bounds.height > page.height) {
      throw new Error("Plugin insertion is larger than the page; choose a larger page or a smaller drawing before inserting.");
    }
    const overlaps = bounds.x < page.width && bounds.y < page.height &&
      bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
    // Keep partially visible drawings as close as possible to their authored position.
    let x = Math.max(0, Math.min(page.width - bounds.width, bounds.x));
    let y = Math.max(0, Math.min(page.height - bounds.height, bounds.y));
    if (!overlaps) {
      const target = options.insertionTarget?.pageId === page.id ? options.insertionTarget : undefined;
      const visible = target?.bounds;
      const left = Math.max(0, visible?.x ?? 0);
      const top = Math.max(0, visible?.y ?? 0);
      const right = Math.min(page.width, visible ? visible.x + visible.width : page.width);
      const bottom = Math.min(page.height, visible ? visible.y + visible.height : page.height);
      const centerX = right > left ? (left + right) / 2 : page.width / 2;
      const centerY = bottom > top ? (top + bottom) / 2 : page.height / 2;
      x = Math.max(0, Math.min(page.width - bounds.width, centerX - bounds.width / 2));
      y = Math.max(0, Math.min(page.height - bounds.height, centerY - bounds.height / 2));
    }
    patched = translateInsertedDocumentObjects(patched, objects.map(object => object.id), x - bounds.x, y - bounds.y);
  }
  const touched = new Set<string>();
  for (const op of writePatchOps(proposed.patch)) {
    switch (op.op) {
      case "addObject": touched.add(op.object.id); break;
      case "addAnnotation": touched.add(op.annotation.id); break;
      case "updateObject":
      case "moveObject":
      case "reorderObject": touched.add(op.objectId); break;
      case "setObjectOrder": op.objectIds.forEach((id) => touched.add(id)); break;
    }
  }
  const objectIds = patched.pages.flatMap((page) =>
    page.objects.filter((object) => touched.has(object.id)).map((object) => object.id)
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
  } else {
    selected = applyPatch(patched, { op: "setSelection", objectIds: [] }, { ...options, now });
  }

  return {
    document: selected,
    receipt: AppliedPatchReceiptSchema.parse({ applied: true, objectIds })
  };
}

/** Keep existing object bounds, but never trust a molecule frame to enclose its atoms. */
function pluginInsertionBounds(objects: readonly DocumentObject[]) {
  const bounds = selectionBounds(objects, objects.map(object => object.id));
  if (!bounds) return undefined;
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  for (const object of objects) {
    if (object.type !== "molecule") continue;
    for (const atom of object.atoms) {
      left = Math.min(left, atom.x);
      top = Math.min(top, atom.y);
      right = Math.max(right, atom.x);
      bottom = Math.max(bottom, atom.y);
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Native placement references only; opaque chemistry, text and plugin metadata are not anchors. */
function referencesExistingObject(object: DocumentObject, existingIds: ReadonlySet<string>): boolean {
  const references: Array<string | undefined> = [];
  switch (object.type) {
    case "reaction-arrow":
      references.push(object.start.objectId, object.end.objectId, ...object.labels);
      break;
    case "mechanism-arrow":
      references.push(object.source.objectId, object.target.objectId);
      break;
    case "electron-mark": references.push(object.anchor.objectId); break;
    case "reaction":
      references.push(...object.components.map(component => component.objectId), ...object.conditionsTextObjectIds);
      break;
    case "bracket": references.push(...object.containedObjectIds); break;
    case "group": references.push(...object.childObjectIds); break;
    case "annotation": references.push(...object.targetObjectIds); break;
    case "superatom": references.push(...object.metadata.attachmentPoints.map(anchor => anchor.objectId)); break;
    case "r-group-label": references.push(...object.display.attachmentPoints.map(anchor => anchor.objectId)); break;
    case "molecule":
      references.push(...[...object.superatoms, ...object.rGroups].flatMap(group => group.attachmentPoints.map(anchor => anchor.objectId)));
      break;
  }
  return references.some(id => id !== undefined && existingIds.has(id));
}

/**
 * One plain sentence for why a plugin patch could not be applied. A schema failure arrives as a Zod
 * error whose message is its whole issue list in JSON — unreadable in a one-line status — so name the
 * first issue by its path instead.
 */
export function describePatchFailure(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const [first] = issues as { path?: unknown; message?: unknown }[];
    const path = Array.isArray(first?.path) ? first.path.join(".") : "";
    const detail = typeof first?.message === "string" ? first.message : "invalid value";
    return `the proposed structure is not valid (${path ? `${path}: ` : ""}${detail})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.replace(/\.$/, "") || "unknown error";
}

/**
 * A USER-accepted proposal, laid onto the document it is accepted into. A proposal is laid out against
 * the document that was active when it was made — its page id, its object id, a position centred on that
 * page — and the user may accept it later, in another document. Applied verbatim, it then fails forever
 * ("object mol_ocsr_004 already exists") or names a page that does not exist here.
 *
 * So an insertion whose object id is taken gets a fresh one, and an insertion onto a page this document
 * does not have goes onto its first page, a molecule re-centred there. Nothing else changes: atoms,
 * bonds, charges, stereo and every other chemical field are carried over exactly (AGENTS.md §7).
 * Direct writes also rebase colliding ids, but must target an existing page.
 */
export function applyAcceptedPluginProposal(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  options: ApplyPatchOptions = {}
): AppliedPluginDocumentPatch {
  return applyPluginDocumentPatch(document, rebaseProposedInsertion(document, proposed), options);
}

/** The proposal with its insertion re-targeted at `document` (see `applyAcceptedPluginProposal`). */
export function rebaseProposedInsertion(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch
): NormalizedProposedDocumentPatch {
  return rebasePluginPatch(document, proposed, true);
}

function rebasePluginPatch(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  retargetMissingPages: boolean
): NormalizedProposedDocumentPatch {
  const patch = proposed.patch as DocumentPatch;
  const ops = writePatchOps(patch);
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
  const remappedIds = new Map<string, string>();
  const rebasedOps = allocatedOps.map((op, index): DocumentPatch => {
    const remap = (id: string): string => remappedIds.get(id) ?? id;
    if (op.op !== "addObject" && op.op !== "addAnnotation") {
      if ("objectId" in op) {
        if (op.op !== "updateObject") return { ...op, objectId: remap(op.objectId) };
        const changes = remapObjectReferences(op.changes, remap);
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
    const insertion = !needsReferenceRemap ? op : op.op === "addObject"
      ? { ...op, object: remapObjectReferences(op.object, referenceId) as DocumentObject }
      : { ...op, annotation: remapObjectReferences(op.annotation, referenceId) as typeof op.annotation };
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
  if (next.compatibility) next.compatibility = { ...next.compatibility, warnings: warnings(next.compatibility.warnings) };
  if ("warnings" in next && next.warnings) next.warnings = warnings(next.warnings);
  if ("chemistry" in next && next.chemistry) next.chemistry = { ...next.chemistry, warnings: warnings(next.chemistry.warnings) };
  if ("metadata" in next && next.metadata) next.metadata = attachments(next.metadata);
  if ("display" in next && next.display) next.display = attachments(next.display);
  if ("superatoms" in next && next.superatoms) next.superatoms = next.superatoms.map(attachments);
  if ("rGroups" in next && next.rGroups) next.rGroups = next.rGroups.map(attachments);
  if ("components" in next && next.components) next.components = next.components.map((c) => ({ ...c, objectId: remap(c.objectId) }));
  if ("conditionsTextObjectIds" in next && next.conditionsTextObjectIds) next.conditionsTextObjectIds = next.conditionsTextObjectIds.map(remap);
  if ("containedObjectIds" in next && next.containedObjectIds) next.containedObjectIds = next.containedObjectIds.map(remap);
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

/**
 * Plugin document writes that must wait for a canvas gesture to finish. A drag (and every gesture like
 * it) previews from a snapshot taken when it started and commits `snapshot → result` as one undo entry;
 * a write committed in the middle is overwritten by the next preview frame and dropped from the history
 * by the commit, while the plugin was told it was applied. Deferring the write until the gesture has
 * committed or cancelled keeps both: the gesture's entry, then the write's own entry on top of it.
 *
 * The gate asks `isGestureActive` rather than being told when each of the many gestures ends, so a new
 * gesture needs no wiring here. It re-checks after every `flush()` (the host calls it on pointer and key
 * release) and on a short timer while anything is waiting, and runs nothing when idle.
 */
export interface PluginWriteGate {
  /** Runs `apply` now when no gesture is active; otherwise queues it, in order, until one is not. The
   *  promise settles with `apply`'s result (or its error) only once it has actually run. */
  run<T>(apply: () => T): Promise<T>;
  /** Runs what is queued if no gesture is active any more. */
  flush(): void;
  /** How many writes are waiting. */
  pending(): number;
  /** Stops the timer; queued writes are rejected (the window is going away). */
  dispose(): void;
}

/** How long a write waits for the canvas before it is refused rather than left hanging. A typed rotate or
 *  resize entry can stay open as long as the user likes, and a session whose end was never delivered
 *  would otherwise hold the plugin's command open for good. */
export const PLUGIN_WRITE_MAX_WAIT_MS = 60_000;

export class PluginWriteGateTimeoutError extends Error {}

export function createPluginWriteGate({
  isGestureActive,
  pollMs = 50,
  maxWaitMs = PLUGIN_WRITE_MAX_WAIT_MS,
  now = Date.now,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}: {
  isGestureActive: () => boolean;
  pollMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): PluginWriteGate {
  const queue: Array<{ write: () => void; abandon: (error: Error) => void; queuedAt: number }> = [];
  let timer: unknown;
  let disposed = false;

  const schedule = (): void => {
    if (timer !== undefined || queue.length === 0 || disposed) return;
    timer = setTimer(() => {
      timer = undefined;
      flush();
    }, pollMs);
  };

  const flush = (): void => {
    // In order, and each against the document the one before it left.
    while (queue.length > 0 && !isGestureActive()) queue.shift()!.write();
    // Still busy: refuse what has waited too long, plainly, rather than apply it into the session.
    while (queue.length > 0 && now() - queue[0]!.queuedAt >= maxWaitMs) {
      queue.shift()!.abandon(new PluginWriteGateTimeoutError("The canvas stayed busy with another edit; nothing was inserted. Try again."));
    }
    schedule();
  };

  return {
    run<T>(apply: () => T): Promise<T> {
      if (disposed) return Promise.reject(new Error("The document window closed; nothing was inserted."));
      return new Promise<T>((resolve, reject) => {
        queue.push({
          write: () => {
            try {
              resolve(apply());
            } catch (error) {
              reject(error);
            }
          },
          abandon: reject,
          queuedAt: now()
        });
        flush();
      });
    },
    flush,
    pending: () => queue.length,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      for (const entry of queue.splice(0)) {
        entry.abandon(new Error("The document window closed; nothing was inserted."));
      }
    }
  };
}
