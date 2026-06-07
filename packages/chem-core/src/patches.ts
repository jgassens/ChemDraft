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
import { pageMarginFromLayout } from "./page-layout";

export type ObjectReorderPlacement = "front" | "back" | "forward" | "backward";

export type DocumentPatch =
  | { op: "addObject"; pageId: string; object: DocumentObject }
  | { op: "removeObject"; objectId: string }
  | { op: "updateObject"; objectId: string; changes: Partial<DocumentObject> }
  | { op: "updatePageLayout"; pageId: string; layout: PageLayout }
  | { op: "moveObject"; objectId: string; x: number; y: number }
  | { op: "reorderObject"; objectId: string; placement: ObjectReorderPlacement }
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
  pruneCrossings(location.page, (crossing) => !crossing.bonds.some((ref) => ref.objectId === objectId));
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

  if (previous.structure !== updated.structure || previous.structureFormat !== updated.structureFormat) {
    pruneCrossings(page, (crossing) => !crossing.bonds.some((ref) => ref.objectId === updated.id));
    return;
  }

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
