import type { ChemDraftDocument, DocumentPage } from "@chemdraft/chem-core";
import {
  PluginRequestLimits, PluginReadRequestResultSchema, type PluginRequestArguments
} from "@chemdraft/plugin-api";
import {
  RequestRevisions, RequestWriteError, type RequestDocument, type RequestHistory, type RequestObjectRef, type RequestPageChoice,
  type RequestViewport
} from "./requestWrites";

export interface RequestPageAnswer {
  requestId: string;
  key: string;
  pages: readonly { pageId: string; revision: string }[];
  outcome: RequestPageChoice;
}

export interface RequestState {
  id: string;
  pluginId: string;
  owner: symbol;
  label: string;
  document: RequestDocument;
  selection: RequestObjectRef[];
  inserted: Map<string, RequestObjectRef>;
  touched: Map<string, RequestObjectRef>;
  revisions: RequestRevisions;
  stop: AbortController;
  history?: RequestHistory;
  writing: boolean;
  pageChoice?: { key: string; answer: Promise<RequestPageAnswer> };
  /** Latest answer per page, shared by overlapping requests on this document instance. */
  pageAnswers: Map<string, RequestPageAnswer>;
  pageDecisions: Map<string, { pageId: string; revision: string; requiredBounds: RequestViewport; outcome: "fits" | "keep" | "enlarge"; answer?: RequestPageAnswer }>;
  cursors: Map<string, { pageId: string; revision: string; filter: string; offset: number }>;
}

/** Resolve the command's grant while capturing Send, before the plugin can yield or switch tabs. */
export function captureRequestSelection(snapshot: ChemDraftDocument | undefined, explicitIds?: readonly string[]): RequestObjectRef[] {
  if (!snapshot) return [];
  const selected = new Set(explicitIds ?? snapshot.selection.objectIds);
  if (!selected.size) return [];
  const pageId = explicitIds ? undefined : snapshot.selection.pageId;
  return snapshot.pages.filter(page => !pageId || page.id === pageId)
    .flatMap(page => page.objects.filter(object => selected.has(object.id)).map(object => ({ pageId: page.id, objectId: object.id })));
}

export function createRequestState(pluginId: string, owner: symbol, document: RequestDocument,
  selection: RequestObjectRef[], id: string, label: string, pageAnswers = new Map<string, RequestPageAnswer>()): RequestState {
  const snapshot = document.read();
  if (!snapshot) throw new RequestWriteError("stale", "The document was closed or replaced.");
  if (new Set(selection.map(ref => ref.objectId)).size !== selection.length) {
    throw new RequestWriteError("scope", "The initiating selection contains an ambiguous object ID.");
  }
  if (selection.length > PluginRequestLimits.objects || snapshot.pages.length > PluginRequestLimits.pages) {
    throw new RequestWriteError("limit", "The document exceeds the request page or selection limit.");
  }
  return { id, pluginId, owner, label, document, selection, inserted: new Map(), touched: new Map(),
    revisions: new RequestRevisions(), stop: new AbortController(), writing: false,
    pageAnswers, pageDecisions: new Map(), cursors: new Map() };
}

export function requestContext(state: RequestState) {
  const document = state.document.read()!;
  const refs = document.pages.flatMap(page => page.objects.filter(object =>
    state.inserted.get(object.id)?.pageId === page.id || state.selection.some(ref => ref.objectId === object.id && ref.pageId === page.id)
  ).map(object => ({ pageId: page.id, objectId: object.id, revision: state.revisions.object(object) })));
  const viewport = state.document.viewport?.();
  const viewportPage = document.pages[0];
  return { requestId: state.id, documentKey: state.document.key,
    pages: document.pages.map(page => ({ pageId: page.id, width: page.width, height: page.height, revision: state.revisions.page(page) })),
    ...(viewport && viewportPage ? { viewport: { ...viewport, pageId: viewportPage.id } } : {}),
    selection: state.selection, insertions: [...state.inserted.values()],
    objectRevisions: refs };
}

export function readRequestPage(state: RequestState, input: PluginRequestArguments<"documents", "readRequest">) {
  const page = state.document.read()!.pages.find(page => page.id === input.pageId);
  if (!page) throw new RequestWriteError("stale", `Page "${input.pageId}" is unavailable in this request.`);
  const revision = state.revisions.page(page);
  const ids = input.objectIds && new Set(input.objectIds);
  const objects = ids ? page.objects.filter(object => ids.has(object.id)) : page.objects;
  const filter = JSON.stringify(input.objectIds ?? []);
  const cursor = input.cursor ? state.cursors.get(input.cursor) : undefined;
  if (input.cursor && (!cursor || cursor.pageId !== page.id || cursor.revision !== revision || cursor.filter !== filter)) {
    throw new RequestWriteError("stale", "The document read cursor no longer applies to this page and filter.");
  }
  return boundedPage(state, page, revision, objects, cursor?.offset ?? 0, filter);
}

function boundedPage(state: RequestState, page: DocumentPage, revision: string,
  objects: DocumentPage["objects"], offset: number, filter: string) {
  let result = objects.slice(offset, offset + PluginRequestLimits.readObjects)
    .map(object => ({ object, revision: state.revisions.object(object) }));
  const nextCursor = crypto.randomUUID();
  while (true) {
    const next = offset + result.length;
    const more = next < objects.length;
    const value = { pageId: page.id, revision, objects: result, ...(more ? { nextCursor } : {}) };
    const parsed = PluginReadRequestResultSchema.safeParse({ ok: true, value });
    if (parsed.success) {
      if (more) {
        if (state.cursors.size >= PluginRequestLimits.objects) state.cursors.delete(state.cursors.keys().next().value!);
        state.cursors.set(nextCursor, { pageId: page.id, revision, filter, offset: next });
      }
      return parsed.data;
    }
    if (result.length < 2) throw new RequestWriteError("limit", "The requested object exceeds the document read limits.");
    result = result.slice(0, Math.ceil(result.length / 2));
  }
}
