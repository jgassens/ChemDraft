import {
  ChemDraftDocumentSchema,
  DocumentObjectSchema,
  PageLayoutSchema,
  type AnnotationObject,
  type ChemDraftDocument,
  type DocumentObject,
  type PageLayout
} from "./schemas";
import { cloneDocument, toIsoTimestamp } from "./document";
import { pageMarginFromLayout } from "./page-layout";

export type ObjectReorderPlacement = "front" | "back" | "forward" | "backward";

export type DocumentPatch =
  | { op: "addObject"; pageId: string; object: DocumentObject }
  | { op: "removeObject"; objectId: string }
  | { op: "updateObject"; objectId: string; changes: Partial<DocumentObject> }
  | { op: "updatePageLayout"; pageId: string; layout: PageLayout }
  | { op: "moveObject"; objectId: string; x: number; y: number }
  | { op: "reorderObject"; objectId: string; placement: ObjectReorderPlacement }
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
  const next = cloneDocument(document);

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

  next.updatedAt = toIsoTimestamp(options.now ?? new Date());
  return ChemDraftDocumentSchema.parse(next);
}

export function applyPatches(
  document: ChemDraftDocument,
  patches: DocumentPatch[],
  options: ApplyPatchOptions = {}
): ChemDraftDocument {
  return patches.reduce((current, patch) => applyPatch(current, patch, options), document);
}

function addObject(document: ChemDraftDocument, pageId: string, object: DocumentObject): void {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new DocumentPatchError(`Cannot add object: page "${pageId}" does not exist.`);
  }

  if (findObject(document, object.id)) {
    throw new DocumentPatchError(`Cannot add object: object "${object.id}" already exists.`);
  }

  page.objects.push(DocumentObjectSchema.parse(object));
}

function removeObject(document: ChemDraftDocument, objectId: string): void {
  const location = findObject(document, objectId);
  if (!location) {
    throw new DocumentPatchError(`Cannot remove object: object "${objectId}" does not exist.`);
  }

  location.page.objects.splice(location.objectIndex, 1);
  document.selection.objectIds = document.selection.objectIds.filter((id) => id !== objectId);
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
}

function setSelection(document: ChemDraftDocument, pageId: string | undefined, objectIds: string[]): void {
  const targetPageId = pageId ?? document.selection.pageId ?? document.pages[0]?.id;
  const page = document.pages.find((candidate) => candidate.id === targetPageId);

  if (!page) {
    throw new DocumentPatchError(`Cannot set selection: page "${targetPageId}" does not exist.`);
  }

  const missingObjectId = objectIds.find((objectId) => !page.objects.some((object) => object.id === objectId));
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

  const updated = DocumentObjectSchema.parse({ ...location.object, ...changes, id: objectId });
  location.page.objects[location.objectIndex] = updated;
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
}

function findObject(
  document: ChemDraftDocument,
  objectId: string
): { page: ChemDraftDocument["pages"][number]; object: DocumentObject; objectIndex: number } | undefined {
  for (const page of document.pages) {
    const objectIndex = page.objects.findIndex((object) => object.id === objectId);
    if (objectIndex >= 0) {
      return { page, object: page.objects[objectIndex], objectIndex };
    }
  }

  return undefined;
}

function assertNever(value: never): never {
  throw new DocumentPatchError(`Unsupported document patch: ${JSON.stringify(value)}`);
}
