import type { DocumentObject, DocumentPage } from "@chemdraft/chem-core";
import type { ChemDraftDocument } from "@chemdraft/plugin-api";

/**
 * Page-aware object resolution for every legacy and plugin write path (AGENTS.md section 7).
 *
 * Object ids are unique within a page but NOT across pages: an imported or pasted document can hold
 * a molecule "X" on page A and a different object "X" on page B. A lookup by bare id silently picks
 * the first occurrence in page order, so it can read, anchor beside, or change the wrong object.
 * Write code resolves objects only through these helpers, with the Send-time selection's page.
 */

/** Host-only legacy scope: object id -> the page the command's selection named it on at Send. A pin
 * resolves only on that page; it never follows an id to another page (see {@link scopedObjectPage}). */
export type PluginWriteScopePages = ReadonlyMap<string, string>;

export interface PageObjectLocation<Object extends DocumentObject = DocumentObject> {
  page: DocumentPage;
  object: Object;
}

/** A selected or anchoring object named by page and id. */
export interface PageObjectRef { pageId: string; objectId: string }

/** Every occurrence of `objectId`, in page order. */
export function objectLocations(document: ChemDraftDocument, objectId: string): PageObjectLocation[] {
  const found: PageObjectLocation[] = [];
  for (const page of document.pages) {
    const object = page.objects.find(candidate => candidate.id === objectId);
    if (object) found.push({ page, object });
  }
  return found;
}

/** A page as the user sees it: its 1-based position in the document. Pages carry no display name. */
export function pageNumberLabel(document: ChemDraftDocument, pageId: string): string {
  const index = document.pages.findIndex(page => page.id === pageId);
  return index < 0 ? "another page" : `page ${index + 1}`;
}

function joinLabels(labels: string[]): string {
  return labels.length < 3 ? labels.join(" and ") : `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * The user-facing refusal for a write whose selected object shares its id with an object on another page.
 * Pages are named by number; the internal ids go to console.warn only. `others` are the page ids holding
 * the same-id objects the write would have reached. `selectedPageId` is where the selection named the object.
 */
export function duplicateIdRefusalMessage(document: ChemDraftDocument, objectId: string, selectedPageId: string,
  others: readonly string[]): string {
  console.warn(`Plugin write refused: object "${objectId}" selected on page id "${selectedPageId}"; same id on page ids ${others.map(id => `"${id}"`).join(", ")}.`);
  const where = joinLabels(others.map(id => pageNumberLabel(document, id)));
  return `Plugin write refused: the change was not applied. The object you selected on ${pageNumberLabel(document, selectedPageId)} shares its internal ID with an object on ${where}, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`;
}

/** The user-facing reason a pinned id no longer resolves: the selected object is gone from the page it
 * was selected on (deleted, or moved to another page). Reads and writes both refuse with it. */
export function pinnedObjectMissingMessage(document: ChemDraftDocument, selectedPageId: string): string {
  return `The object you selected on ${pageNumberLabel(document, selectedPageId)} is no longer there; reselect it and try again.`;
}

/** The object named `objectId` on page `pageId`, or undefined. */
export function resolveObjectOnPage(document: ChemDraftDocument, pageId: string, objectId: string): PageObjectLocation | undefined {
  const page = document.pages.find(candidate => candidate.id === pageId);
  const object = page?.objects.find(candidate => candidate.id === objectId);
  return page && object ? { page, object } : undefined;
}

/** The page a chem-core patch op that names `objectId` will act on: chem-core resolves a bare id to
 * its FIRST occurrence in page order. Compare it with {@link scopedObjectPage} before writing. */
export function bareIdTargetPage(document: ChemDraftDocument, objectId: string): string | undefined {
  return document.pages.find(page => page.objects.some(object => object.id === objectId))?.id;
}

/**
 * The page `objectId` resolves to in `document`:
 * - a pinned id: its Send-time page while the object is still there, even when the id also exists
 *   elsewhere; otherwise nothing. A pin never follows its id to another page: an object found there
 *   under the same id may be an unrelated object inserted after Send, so it is never in scope;
 * - an unpinned id: its only page;
 * - undefined when the id is gone, or unpinned and on several pages.
 */
export function scopedObjectPage(document: ChemDraftDocument, objectId: string,
  scopePages?: PluginWriteScopePages): string | undefined {
  const pinned = scopePages?.get(objectId);
  // TODO(plugin-host): same-page id reuse needs host-owned object identity (1.2.3)
  if (pinned !== undefined) return resolveObjectOnPage(document, pinned, objectId) ? pinned : undefined;
  const locations = objectLocations(document, objectId);
  return locations.length === 1 ? locations[0]!.page.id : undefined;
}

function pageList(locations: readonly PageObjectLocation[]): string {
  return locations.map(location => `"${location.page.id}"`).join(", ");
}

/** Resolve a write-scoped or anchoring id by {@link scopedObjectPage}, or throw a specific error. */
export function resolveScopedObject(document: ChemDraftDocument, objectId: string,
  scopePages?: PluginWriteScopePages, where = "the document"): PageObjectLocation {
  const pageId = scopedObjectPage(document, objectId, scopePages);
  const resolved = pageId === undefined ? undefined : resolveObjectOnPage(document, pageId, objectId);
  if (resolved) return resolved;
  const pinned = scopePages?.get(objectId);
  if (pinned !== undefined) throw new Error(pinnedObjectMissingMessage(document, pinned));
  const locations = objectLocations(document, objectId);
  if (!locations.length) throw new Error(`Object "${objectId}" does not exist in ${where}.`);
  throw new Error(`Object id "${objectId}" names objects on pages ${pageList(locations)}; select the one you mean and retry.`);
}

/** True when the object `objectId` on page `pageId` is in write scope: a pinned id only on its
 * Send-time page (the same rule as {@link scopedObjectPage}). Unpinned ids (insertions, request-bound
 * refs checked elsewhere) keep bare-id scope. */
export function objectInWriteScope(scope: ReadonlySet<string>, scopePages: PluginWriteScopePages | undefined,
  pageId: string, objectId: string): boolean {
  if (!scope.has(objectId)) return false;
  const pinned = scopePages?.get(objectId);
  // TODO(plugin-host): same-page id reuse needs host-owned object identity (1.2.3)
  return pinned === undefined || pinned === pageId;
}

/**
 * Bind selected ids to a page at Send. Ids on `pageId` bind to it. Ids elsewhere bind to their only
 * page; an id found on several other pages cannot be bound and is returned in `ambiguous` (or bound
 * to `pageId`, when one is given, so that nothing on another page is in scope).
 * With `explicitPage` (a Send-time override that names its page), every id binds to `pageId`, even
 * one missing from it: that pin is then refused ("reselect it"), never moved to the id's other page.
 */
export function pinSelectionPages(document: ChemDraftDocument | undefined, objectIds: readonly string[],
  pageId: string | undefined, explicitPage = false): { pages: Map<string, string>; ambiguous: string[] } {
  const pages = new Map<string, string>();
  const ambiguous: string[] = [];
  if (!document) return { pages, ambiguous };
  for (const objectId of new Set(objectIds)) {
    if (pageId !== undefined && (explicitPage || resolveObjectOnPage(document, pageId, objectId))) {
      pages.set(objectId, pageId);
      continue;
    }
    const locations = objectLocations(document, objectId);
    if (locations.length === 1) pages.set(objectId, locations[0]!.page.id);
    else if (locations.length > 1) {
      if (pageId !== undefined && document.pages.some(page => page.id === pageId)) pages.set(objectId, pageId);
      else ambiguous.push(objectId);
    }
  }
  return { pages, ambiguous };
}

/** Each scoped id as a page reference, for placement beside the selection. Unresolvable ids are omitted. */
export function scopedObjectRefs(document: ChemDraftDocument, objectIds: Iterable<string>,
  scopePages?: PluginWriteScopePages): PageObjectRef[] {
  const refs: PageObjectRef[] = [];
  for (const objectId of new Set(objectIds)) {
    const pageId = scopedObjectPage(document, objectId, scopePages);
    if (pageId !== undefined) refs.push({ pageId, objectId });
  }
  return refs;
}
