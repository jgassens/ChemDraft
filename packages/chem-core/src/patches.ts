import {
  ChemDraftDocumentSchema,
  DocumentObjectSchema,
  PageLayoutSchema,
  type AnnotationObject,
  type BondRef,
  type ChemDraftDocument,
  type CrossingOverride,
  type DocumentObject,
  type DocumentPage,
  type MoleculeBond,
  type MoleculeObject,
  type PageLayout
} from "./schemas";
import { cloneDocument, toIsoTimestamp } from "./document";
import { engineDocuments } from "./engineDocuments";
import { pageMarginFromLayout } from "./page-layout";

export type ObjectReorderPlacement = "front" | "back" | "forward" | "backward";

export type DocumentPatch =
  | { op: "addObject"; pageId: string; object: DocumentObject }
  | { op: "removeObject"; objectId: string }
  | { op: "updateObject"; objectId: string; changes: Partial<DocumentObject> }
  | { op: "updatePageLayout"; pageId: string; layout: PageLayout }
  | { op: "moveObject"; objectId: string; x: number; y: number }
  | { op: "reorderObject"; objectId: string; placement: ObjectReorderPlacement }
  | { op: "setObjectOrder"; pageId: string; objectIds: string[] }
  | { op: "setCrossingOverride"; pageId: string; crossing: CrossingOverride }
  | { op: "clearCrossingOverride"; pageId: string; bonds: [BondRef, BondRef] }
  | { op: "setSelection"; pageId?: string; objectIds: string[] }
  | { op: "addAnnotation"; pageId: string; annotation: AnnotationObject }
  | { op: "removeAnnotation"; annotationId: string };

export interface ApplyPatchOptions {
  now?: Date | string;
}

export class DocumentPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentPatchError";
  }
}

export function applyPatch(
  document: ChemDraftDocument,
  patch: DocumentPatch,
  options: ApplyPatchOptions = {}
): ChemDraftDocument {
  return applyPatches(document, [patch], options);
}


/**
 * Apply `patches` in order; each sees the result of the ones before it, and any that fails throws
 * with nothing applied.
 *
 * The result shares every object, page field, and array the patches did not touch with `document`
 * (structural sharing). Each patch used to start from a full deep copy — a JSON round trip plus a
 * schema parse of the whole document — and end with another full parse, so an edit to one object
 * of a 5,000-molecule page cost about a second, and every undo snapshot was an independent
 * multi-megabyte copy. Now an edit costs roughly the size of what it changes, and snapshots share
 * their unchanged objects. What changes is still validated: added and updated objects through
 * `DocumentObjectSchema` as before, and every page's shell (layout, margins, crossings) and the
 * document's own fields through the full schemas.
 *
 * Sharing makes in-place mutation of a returned document unsafe: it would reach every snapshot that
 * shares the object. Under test, results are therefore deep-frozen, so any such mutation throws.
 */
export function applyPatches(
  document: ChemDraftDocument,
  patches: DocumentPatch[],
  options: ApplyPatchOptions = {}
): ChemDraftDocument {
  if (patches.length === 0) {
    return document;
  }
  const base = engineDocuments.has(document) ? document : cloneDocument(document);
  const draft = createDraft(base);
  for (let index = 0; index < patches.length; ) {
    const patch = patches[index]!;
    if (patch.op === "removeObject") {
      // A run of removals (deleting a selection) is one pass over the page. One at a time, each
      // splice left the id index stale and each re-filtered the selection: deleting 5,000 selected
      // objects did 25 million steps. The result is the same as removing them in order.
      let end = index + 1;
      while (end < patches.length && patches[end]!.op === "removeObject") {
        end += 1;
      }
      if (end - index > 1) {
        removeObjects(draft, patches.slice(index, end).map((entry) => (entry as { objectId: string }).objectId));
        index = end;
        continue;
      }
    }
    applyPatchInPlace(draft, patch);
    index += 1;
  }
  draft.updatedAt = toIsoTimestamp(options.now ?? new Date());
  const next = validateDraft(draft);
  engineDocuments.add(next);
  if (freezeResults) {
    deepFreezeNew(next);
  }
  return next;
}

/**
 * Whether the patch engine produced `document` (as a patch result or through
 * `adoptDerivedDocument`). Such a document is already validated and normalized, so a consumer that
 * would otherwise re-parse it — a save, run after every pause in editing — can use it as it is.
 */
export function isEngineDocument(document: ChemDraftDocument): boolean {
  return engineDocuments.has(document);
}

/**
 * `document` as an engine document: validated and normalized once, now, as a patch would on its
 * first edit. For a document that enters from outside — opened, restored, created — so that saves
 * before the first edit skip re-validation and the first edit shares its unchanged objects rather
 * than deep-copying the whole page. The result is an independent copy; the input is never adopted,
 * since its caller may still hold and mutate it.
 */
export function toEngineDocument(document: ChemDraftDocument): ChemDraftDocument {
  if (engineDocuments.has(document)) {
    return document;
  }
  const admitted = cloneDocument(document);
  engineDocuments.add(admitted);
  if (freezeResults) {
    deepFreezeNew(admitted);
  }
  return admitted;
}

/**
 * `document` admitted to the engine as it is, without the copy `toEngineDocument` makes. For a
 * document the caller has just produced by a full schema parse (`parseDocument`,
 * `deserializeDocument`, `createEmptyDocument`, an importer's `ChemDraftDocumentSchema.parse`)
 * and hands over outright: opening a 5,000-molecule file spent 150–200 ms copying and re-parsing
 * a result that had been parsed moments before and that nothing else held.
 *
 * The contract is the caller's to keep, because it cannot be checked here. The document must be a
 * schema-parse result — validated and normalized, not merely shaped like one — and the caller must
 * not retain, mutate, or share it afterwards: the engine will share its objects with every later
 * patch result and undo snapshot, so a later mutation would reach all of them. Under test it is
 * deep-frozen, like every engine document, so such a mutation throws. When in doubt, use
 * `toEngineDocument`.
 */
export function admitParsedDocument(document: ChemDraftDocument): ChemDraftDocument {
  if (engineDocuments.has(document)) {
    return document;
  }
  engineDocuments.add(document);
  if (freezeResults) {
    deepFreezeNew(document);
  }
  return document;
}

/**
 * `next`, re-admitted to the engine's structural sharing. For a document the app derived from an
 * engine result by replacing whole objects — a normalization pass such as charge-mark reconciliation
 * — without going through a patch. A derived document is otherwise unknown to the engine, so the
 * next patch deep-copied and re-parsed all of it and gave every object a new identity: the undo
 * history stopped sharing, and every per-object render cache missed at once.
 *
 * Objects `next` shares with `base` were validated when `base` was produced; only the others are
 * parsed, and the document and page shells are validated as a patch result's are — including any
 * compatibility, styles, or plugin data `next` replaced, which a patch never writes. Throws, like a
 * patch, when a replaced object is invalid. A `base` the engine did not produce gains nothing, and
 * `next` comes back unchanged.
 */
export function adoptDerivedDocument(base: ChemDraftDocument, next: ChemDraftDocument): ChemDraftDocument {
  if (next === base || !engineDocuments.has(base) || engineDocuments.has(next)) {
    return next;
  }
  const validated = new Set<DocumentObject>();
  for (const page of base.pages) {
    for (const object of page.objects) {
      validated.add(object);
    }
  }
  const adopted = validateDraft({
    ...next,
    selection: { ...next.selection, objectIds: [...next.selection.objectIds] },
    pages: next.pages.map((page) => ({
      ...page,
      objects: page.objects.map((object) => (validated.has(object) ? object : DocumentObjectSchema.parse(object))),
      crossings: [...page.crossings]
    }))
  }, {
    // Shell fields `next` still shares with `base` were validated with it; replaced ones were not.
    compatibility: next.compatibility !== base.compatibility,
    styles: next.styles !== base.styles,
    plugins: next.plugins !== base.plugins
  });
  engineDocuments.add(adopted);
  if (freezeResults) {
    deepFreezeNew(adopted);
  }
  return adopted;
}

/** Fresh containers for everything a patch can write: the document, its selection, each page, and
 *  each page's objects and crossings arrays. Objects and every other field are shared. */
function createDraft(document: ChemDraftDocument): ChemDraftDocument {
  return {
    ...document,
    selection: { ...document.selection, objectIds: [...document.selection.objectIds] },
    pages: document.pages.map((page) => ({ ...page, objects: [...page.objects], crossings: [...page.crossings] }))
  };
}

/**
 * Validate a draft without re-parsing its objects: they were either validated when the base was
 * produced, or on entry through addObject/updateObject. The document and page schemas (strictness,
 * defaults, the page-layout and crossing refinements) run on the draft with object arrays emptied,
 * and the real arrays go back afterwards.
 */
function validateDraft(
  draft: ChemDraftDocument,
  unvalidated: { compatibility?: boolean; styles?: boolean; plugins?: boolean } = {}
): ChemDraftDocument {
  // No patch writes the compatibility warnings, styles, or plugin data, and the base had them
  // validated, so they pass through by reference. Re-parsing them re-created every warning object
  // on every edit — an imported page can carry thousands — and each undo step kept its own copy.
  // A derived document may have replaced them, though (`unvalidated`), and those are parsed like
  // any other shell field: a save no longer re-parses an engine document, so an invalid field
  // admitted here would be written to a file that then refuses to open.
  const shell = ChemDraftDocumentSchema.parse({
    ...draft,
    compatibility: unvalidated.compatibility ? draft.compatibility : { warnings: [] },
    styles: unvalidated.styles ? draft.styles : {},
    plugins: unvalidated.plugins ? draft.plugins : {},
    pages: draft.pages.map((page) => ({ ...page, objects: [] }))
  });
  return {
    ...shell,
    compatibility: unvalidated.compatibility ? shell.compatibility : draft.compatibility,
    styles: unvalidated.styles ? shell.styles : draft.styles,
    plugins: unvalidated.plugins ? shell.plugins : draft.plugins,
    pages: shell.pages.map((page, index) => ({ ...page, objects: draft.pages[index]!.objects }))
  };
}

const freezeResults =
  typeof process !== "undefined" && typeof process.env === "object" && process.env.VITEST !== undefined;

/** Freeze everything reachable that is not frozen yet. Shared subtrees are already frozen, so the
 *  cost is proportional to what the batch created. */
function deepFreezeNew(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeNew(child);
  }
}

function applyPatchInPlace(next: ChemDraftDocument, patch: DocumentPatch): void {
  switch (patch.op) {
    case "addObject":
      addObject(next, patch.pageId, patch.object);
      break;
    case "removeObject":
      removeObject(next, patch.objectId);
      break;
    case "updateObject":
      updateObject(next, patch.objectId, patch.changes);
      break;
    case "updatePageLayout":
      updatePageLayout(next, patch.pageId, patch.layout);
      break;
    case "moveObject":
      updateObject(next, patch.objectId, { x: patch.x, y: patch.y });
      break;
    case "reorderObject":
      reorderObject(next, patch.objectId, patch.placement);
      break;
    case "setObjectOrder":
      setObjectOrder(next, patch.pageId, patch.objectIds);
      break;
    case "setCrossingOverride":
      setCrossingOverride(next, patch.pageId, patch.crossing);
      break;
    case "clearCrossingOverride":
      clearCrossingOverride(next, patch.pageId, patch.bonds);
      break;
    case "setSelection":
      setSelection(next, patch.pageId, patch.objectIds);
      break;
    case "addAnnotation":
      addObject(next, patch.pageId, patch.annotation);
      break;
    case "removeAnnotation":
      removeAnnotation(next, patch.annotationId);
      break;
    default:
      assertNever(patch);
  }
}

function addObject(document: ChemDraftDocument, pageId: string, object: DocumentObject): void {
  const pageIndex = document.pages.findIndex((candidate) => candidate.id === pageId);
  const page = document.pages[pageIndex];
  if (!page) {
    throw new DocumentPatchError(`Cannot add object: page "${pageId}" does not exist.`);
  }

  if (findObject(document, object.id)) {
    throw new DocumentPatchError(`Cannot add object: object "${object.id}" already exists.`);
  }

  page.objects.push(DocumentObjectSchema.parse(object));
  recordAppendedObject(document, pageIndex, object.id);
}

function removeObject(document: ChemDraftDocument, objectId: string): void {
  const location = findObject(document, objectId);
  if (!location) {
    throw new DocumentPatchError(`Cannot remove object: object "${objectId}" does not exist.`);
  }

  location.page.objects.splice(location.objectIndex, 1);
  forgetShiftedDuplicateLocations(document);
  document.selection.objectIds = document.selection.objectIds.filter((id) => id !== objectId);
  pruneCrossings(location.page, (crossing) => !crossing.bonds.some((ref) => ref.objectId === objectId));
}

/**
 * Remove `objectIds` as successive `removeObject` patches would: each removal takes the first
 * remaining object with that id, searching pages in order; every selection entry naming a removed id
 * goes; and each page drops the crossings that name an object removed from it.
 */
function removeObjects(document: ChemDraftDocument, objectIds: readonly string[]): void {
  // Fail before touching anything, and on the patch that would fail sequentially: walk the requests
  // in order against what each id has left, so the error names the first removal that finds nothing
  // (with one "a" and one "b", [b, a, a, b] fails on the second "a", not the second "b"). A request
  // whose id is missing altogether (undefined from a malformed plugin patch) finds nothing too.
  const available = new Map<string, number>();
  for (const id of objectIds) {
    available.set(id, 0);
  }
  for (const page of document.pages) {
    for (const object of page.objects) {
      const count = available.get(object.id);
      if (count !== undefined) {
        available.set(object.id, count + 1);
      }
    }
  }
  for (const id of objectIds) {
    const count = available.get(id)!;
    if (count === 0) {
      throw new DocumentPatchError(`Cannot remove object: object "${id}" does not exist.`);
    }
    available.set(id, count - 1);
  }

  const remaining = new Map<string, number>();
  for (const id of objectIds) {
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  const removed = new Set<string>();
  for (const page of document.pages) {
    const removedHere = new Set<string>();
    const kept = page.objects.filter((object) => {
      const count = remaining.get(object.id);
      if (!count) {
        return true;
      }
      remaining.set(object.id, count - 1);
      removedHere.add(object.id);
      return false;
    });
    if (removedHere.size === 0) {
      continue;
    }
    // The draft page owns a fresh objects array (createDraft), so it can simply be replaced; a spread
    // into splice would overflow the argument stack on a page of 100,000 objects.
    page.objects = kept;
    pruneCrossings(page, (crossing) => !crossing.bonds.some((ref) => removedHere.has(ref.objectId)));
    removedHere.forEach((id) => removed.add(id));
  }
  forgetShiftedDuplicateLocations(document);
  document.selection.objectIds = document.selection.objectIds.filter((id) => !removed.has(id));
}

function reorderObject(
  document: ChemDraftDocument,
  objectId: string,
  placement: ObjectReorderPlacement
): void {
  const location = findObject(document, objectId);
  if (!location) {
    throw new DocumentPatchError(`Cannot reorder object: object "${objectId}" does not exist.`);
  }

  const objects = location.page.objects;
  const [object] = objects.splice(location.objectIndex, 1);
  const targetIndex =
    placement === "front"
      ? objects.length
      : placement === "back"
        ? 0
        : placement === "forward"
          ? Math.min(location.objectIndex + 1, objects.length)
          : Math.max(location.objectIndex - 1, 0);
  objects.splice(targetIndex, 0, object);
  forgetShiftedDuplicateLocations(document);
}

/**
 * Replace a page's stacking order in one step. Bring to Front used to emit one reorderObject per
 * object on the page, and every splice left the location index stale, so reordering one object on
 * a 5,000-object page took seconds. `objectIds` must be exactly the page's current ids, rearranged
 * — the same multiset, duplicates included — so the op can only permute, never add, drop, or
 * duplicate an object. Crossings and the selection name objects, not positions, so they stand.
 */
function setObjectOrder(document: ChemDraftDocument, pageId: string, objectIds: readonly string[]): void {
  const page = findPage(document, pageId, "set object order");
  if (objectIds.length !== page.objects.length) {
    throw new DocumentPatchError(
      `Cannot set object order: page "${pageId}" has ${page.objects.length} objects, but the order names ${objectIds.length}.`
    );
  }
  // Queue each id's objects in their current order, so equal ids keep their relative order and the
  // op stays a pure permutation even on a page that carries duplicate ids.
  const objectsById = new Map<string, DocumentObject[]>();
  for (const object of page.objects) {
    const queue = objectsById.get(object.id);
    if (queue) {
      queue.push(object);
    } else {
      objectsById.set(object.id, [object]);
    }
  }
  const taken = new Map<string, number>();
  const ordered = objectIds.map((id) => {
    const used = taken.get(id) ?? 0;
    const object = objectsById.get(id)?.[used];
    if (!object) {
      throw new DocumentPatchError(
        `Cannot set object order: object "${id}" is not on page "${pageId}" as many times as the order names it.`
      );
    }
    taken.set(id, used + 1);
    return object;
  });
  // Equal lengths, and every entry drawn from a distinct slot of the page: a permutation. The draft
  // page owns its objects array (createDraft), so it can be replaced outright.
  page.objects = ordered;
  objectLocationIndexes.delete(document);
}

function setSelection(document: ChemDraftDocument, pageId: string | undefined, objectIds: string[]): void {
  const targetPageId = pageId ?? document.selection.pageId ?? document.pages[0]?.id;
  const page = document.pages.find((candidate) => candidate.id === targetPageId);

  if (!page) {
    throw new DocumentPatchError(`Cannot set selection: page "${targetPageId}" does not exist.`);
  }

  // A set, not `some` per id: selecting all of a 5,000-object page was 25 million comparisons.
  const pageObjectIds = new Set(page.objects.map((object) => object.id));
  const missingObjectId = objectIds.find((objectId) => !pageObjectIds.has(objectId));
  if (missingObjectId) {
    throw new DocumentPatchError(`Cannot set selection: object "${missingObjectId}" does not exist on page "${page.id}".`);
  }

  document.selection = {
    pageId: page.id,
    objectIds: [...objectIds]
  };
}

function updatePageLayout(document: ChemDraftDocument, pageId: string, layout: PageLayout): void {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new DocumentPatchError(`Cannot update page layout: page "${pageId}" does not exist.`);
  }

  const parsedLayout = PageLayoutSchema.parse(layout);
  page.layout = parsedLayout;
  page.width = parsedLayout.widthPx;
  page.height = parsedLayout.heightPx;
  page.margin = pageMarginFromLayout(parsedLayout);
}

function updateObject(
  document: ChemDraftDocument,
  objectId: string,
  changes: Partial<DocumentObject>
): void {
  const location = findObject(document, objectId);
  if (!location) {
    throw new DocumentPatchError(`Cannot update object: object "${objectId}" does not exist.`);
  }

  if ("id" in changes && changes.id !== objectId) {
    throw new DocumentPatchError("Cannot update object identity through an updateObject patch.");
  }

  if ("type" in changes && changes.type !== location.object.type) {
    throw new DocumentPatchError("Cannot update object type through an updateObject patch.");
  }

  const updated = mergeObjectChanges(location.object, changes, objectId);
  location.page.objects[location.objectIndex] = updated;
  pruneCrossingsAfterObjectUpdate(location.page, location.object, updated);
}

function removeAnnotation(document: ChemDraftDocument, annotationId: string): void {
  const location = findObject(document, annotationId);
  if (!location) {
    throw new DocumentPatchError(`Cannot remove annotation: annotation "${annotationId}" does not exist.`);
  }

  if (location.object.type !== "annotation") {
    throw new DocumentPatchError(`Cannot remove annotation: object "${annotationId}" is not an annotation.`);
  }

  location.page.objects.splice(location.objectIndex, 1);
  forgetShiftedDuplicateLocations(document);
}

function setCrossingOverride(
  document: ChemDraftDocument,
  pageId: string,
  crossing: CrossingOverride
): void {
  const page = findPage(document, pageId, "set crossing override");
  const canonical = canonicalCrossingOverride(crossing);
  if (!canonical.bonds.every((ref) => crossingBondExists(page, ref))) {
    throw new DocumentPatchError("Cannot set crossing override: referenced bond does not exist on the page.");
  }

  const key = crossingPairKey(canonical.bonds);
  const existingIndex = page.crossings.findIndex((candidate) => crossingPairKey(candidate.bonds) === key);
  if (existingIndex >= 0) {
    page.crossings[existingIndex] = canonical;
  } else {
    page.crossings.push(canonical);
  }
}

function clearCrossingOverride(
  document: ChemDraftDocument,
  pageId: string,
  bonds: [BondRef, BondRef]
): void {
  const page = findPage(document, pageId, "clear crossing override");
  const key = crossingPairKey(canonicalBondRefs(bonds));
  page.crossings = page.crossings.filter((crossing) => crossingPairKey(crossing.bonds) !== key);
}

function canonicalCrossingOverride(crossing: CrossingOverride): CrossingOverride {
  const bonds = canonicalBondRefs(crossing.bonds);
  const frontKey = bondRefKey(crossing.front);
  const front = bonds.find((ref) => bondRefKey(ref) === frontKey);
  if (!front) {
    throw new DocumentPatchError("Cannot set crossing override: front bond must be one of the crossing bonds.");
  }
  return {
    ...crossing,
    bonds,
    front
  };
}

function canonicalBondRefs(bonds: [BondRef, BondRef]): [BondRef, BondRef] {
  const [left, right] = bonds.map((ref) => ({ ...ref })).sort((a, b) => bondRefKey(a).localeCompare(bondRefKey(b)));
  if (!left || !right || bondRefKey(left) === bondRefKey(right)) {
    throw new DocumentPatchError("Crossing override must reference two distinct bonds.");
  }
  return [left, right];
}

function crossingPairKey(bonds: [BondRef, BondRef]): string {
  return canonicalBondRefs(bonds).map(bondRefKey).join("|");
}

function bondRefKey(ref: BondRef): string {
  return `${ref.objectId}::${ref.bondId}`;
}

function findPage(
  document: ChemDraftDocument,
  pageId: string,
  action: string
): DocumentPage {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new DocumentPatchError(`Cannot ${action}: page "${pageId}" does not exist.`);
  }
  return page;
}

function crossingBondExists(page: DocumentPage, ref: BondRef): boolean {
  const object = page.objects.find((candidate): candidate is MoleculeObject =>
    candidate.type === "molecule" && candidate.id === ref.objectId
  );
  return object?.bonds.some((bond) => bond.id === ref.bondId) === true;
}

function pruneCrossings(
  page: DocumentPage,
  keep: (crossing: CrossingOverride) => boolean
): void {
  page.crossings = page.crossings.filter(keep);
}

function pruneCrossingsAfterObjectUpdate(
  page: DocumentPage,
  previous: DocumentObject,
  updated: DocumentObject
): void {
  if (previous.type !== "molecule" && updated.type !== "molecule") {
    return;
  }
  if (previous.type !== "molecule" || updated.type !== "molecule") {
    pruneCrossings(page, (crossing) => !crossing.bonds.some((ref) => ref.objectId === updated.id));
    return;
  }

  // Keep a crossing override as long as each of its bonds still exists with the same identity
  // (endpoints + order). This is the single, granular source of truth: it preserves overrides
  // through edits that change the SMILES string but not the bond graph — e.g. changing a
  // carbon to oxygen (which previously cleared all overrides and made a rotaxane pop in front)
  // — while still pruning when a bond is genuinely deleted, re-topologised, or the molecule is
  // replaced wholesale (its bonds get new ids → not stable → pruned).
  pruneCrossings(page, (crossing) =>
    crossing.bonds.every((ref) =>
      ref.objectId !== updated.id || moleculeBondIdentityIsStable(previous, updated, ref.bondId)
    )
  );
}

function moleculeBondIdentityIsStable(
  previous: MoleculeObject,
  updated: MoleculeObject,
  bondId: string
): boolean {
  const previousBond = previous.bonds.find((bond) => bond.id === bondId);
  const updatedBond = updated.bonds.find((bond) => bond.id === bondId);
  return previousBond !== undefined &&
    updatedBond !== undefined &&
    sameBondIdentity(previousBond, updatedBond);
}

function sameBondIdentity(previous: MoleculeBond, updated: MoleculeBond): boolean {
  return previous.fromAtomId === updated.fromAtomId &&
    previous.toAtomId === updated.toAtomId &&
    previous.order === updated.order;
}

/**
 * Merge `changes` onto an object, treating an explicit `undefined` by what the schema does with it.
 *
 * A plain spread let `undefined` overwrite a real value; where the schema supplies a default
 * (`atoms` and `bonds` are `.default([])`) that hole was then filled with the default, so
 * `{ atoms: undefined }` erased a molecule's graph and reported success — reachable from a plugin,
 * whose proposal schema is `{ op: string }.passthrough()` and whose review tray shows only a name
 * and a reason. Those keys keep their existing value instead.
 *
 * Keys the schema leaves genuinely optional (`chemistry`, `transform`, …) are a different case:
 * there `undefined` means "clear this field", which callers rely on — dropping stale derived
 * chemistry after an editor save, for one — so it is honoured.
 */
function mergeObjectChanges(
  object: DocumentObject,
  changes: Partial<DocumentObject>,
  objectId: string
): DocumentObject {
  const undefinedKeys = Object.keys(changes).filter(
    (key) => (changes as Record<string, unknown>)[key] === undefined
  );
  if (undefinedKeys.length === 0) {
    return DocumentObjectSchema.parse({ ...object, ...changes, id: objectId });
  }

  // What the schema makes of each explicit undefined: still undefined means a real clear; anything
  // else means a default was substituted for data that was there.
  const withUndefined = DocumentObjectSchema.parse({ ...object, ...changes, id: objectId }) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...object, id: objectId };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) {
      merged[key] = value;
    } else if (withUndefined[key] === undefined) {
      delete merged[key];
    }
  }
  return DocumentObjectSchema.parse(merged);
}

/**
 * Where each object sits, per working document. A batch of n patches used to find each object with
 * a linear scan — O(n²) for a large selection. The index is a hint, never trusted blindly: a hit is
 * checked against the array, and a stale one (after an add, remove, or reorder shifted positions)
 * rebuilds it, so the result is always what a scan would return.
 */
const objectLocationIndexes = new WeakMap<ChemDraftDocument, Map<string, { pageIndex: number; objectIndex: number }>>();

/**
 * Working documents whose index was built over a repeated id. Validation does not forbid one (an
 * imported or hand-edited file can carry it), and there a positional hit is not self-checking: after
 * a removal or reorder shifts positions, the cached slot can hold a LATER object with the same id,
 * which passes the id check where a scan would have taken the first.
 */
const documentsWithDuplicateIds = new WeakSet<ChemDraftDocument>();

function buildObjectLocationIndex(document: ChemDraftDocument): Map<string, { pageIndex: number; objectIndex: number }> {
  const index = new Map<string, { pageIndex: number; objectIndex: number }>();
  let duplicates = false;
  document.pages.forEach((page, pageIndex) => {
    page.objects.forEach((object, objectIndex) => {
      // First occurrence wins, as the scan's findIndex did.
      if (!index.has(object.id)) {
        index.set(object.id, { pageIndex, objectIndex });
      } else {
        duplicates = true;
      }
    });
  });
  objectLocationIndexes.set(document, index);
  if (duplicates) {
    documentsWithDuplicateIds.add(document);
  } else {
    documentsWithDuplicateIds.delete(document);
  }
  return index;
}

/**
 * Called after anything that shifts positions. With unique ids a stale hit fails its id check and
 * the index rebuilds itself, so nothing needs doing; with a repeated id it might not fail, so the
 * index is dropped and the next lookup rebuilds it, resolving to the first occurrence as a scan
 * would. addObject cannot introduce a repeat, so a page that starts unique stays on the cheap path.
 */
function forgetShiftedDuplicateLocations(document: ChemDraftDocument): void {
  if (documentsWithDuplicateIds.has(document)) {
    objectLocationIndexes.delete(document);
  }
}

function findObject(
  document: ChemDraftDocument,
  objectId: string
): { page: ChemDraftDocument["pages"][number]; object: DocumentObject; objectIndex: number } | undefined {
  const resolve = (index: Map<string, { pageIndex: number; objectIndex: number }>) => {
    const location = index.get(objectId);
    const page = location ? document.pages[location.pageIndex] : undefined;
    const object = location ? page?.objects[location.objectIndex] : undefined;
    return page && object && object.id === objectId ? { page, object, objectIndex: location!.objectIndex } : undefined;
  };
  const cached = objectLocationIndexes.get(document);
  if (cached) {
    const hit = resolve(cached);
    if (hit) {
      return hit;
    }
    // Ids enter a page only through addObject, which records them, so an id the index has never
    // seen is absent — answering that without a rebuild keeps a batch of additions linear.
    if (!cached.has(objectId)) {
      return undefined;
    }
  }
  // No index yet, or a stale position: rebuild once and answer from the fresh index.
  return resolve(buildObjectLocationIndex(document));
}

/** Record an object appended to `document.pages[pageIndex]` in the location index, if one exists. */
function recordAppendedObject(document: ChemDraftDocument, pageIndex: number, objectId: string): void {
  const index = objectLocationIndexes.get(document);
  const page = document.pages[pageIndex];
  if (index && page && !index.has(objectId)) {
    index.set(objectId, { pageIndex, objectIndex: page.objects.length - 1 });
  }
}

function assertNever(value: never): never {
  throw new DocumentPatchError(`Unsupported document patch: ${JSON.stringify(value)}`);
}
