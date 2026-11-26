import {
  applyPatches, createImageGraphicObject, nextObjectId, type ChemDraftDocument, type DocumentPatch, type GraphicObject
} from "@chemdraft/chem-core";
import { firstPage, phase4Timestamp } from "@chemdraft/document-workflow-core";
import type { PreparedDroppedImage } from "./prepareDroppedImage";

/** Each further picture of one drop moves down and right by this much, in page units. */
export const DROP_CASCADE_OFFSET = 24;

export interface PagePointLike { x: number; y: number }
export interface DropFrame { x: number; y: number; width: number; height: number; scaled: boolean }

/**
 * Top-left coordinates along one axis. Centre the first picture on the drop point if it fits,
 * then step from its corner. Prefer down/right, use up/left when there is more room there, and
 * shorten the step to fit. A page-spanning picture sits at zero on that axis without limiting
 * the step for other pictures.
 */
function cascadeCorners(point: number, extents: readonly number[], pageExtent: number, cascade: number): number[] {
  if (!extents.length) return [];
  const room = extents.map(extent => Math.max(0, pageExtent - extent));
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const anchor = clamp(point - extents[0]! / 2, room[0]!);
  let forward = cascade;
  let backward = cascade;
  for (let index = 1; index < room.length; index++) {
    const max = room[index]!;
    if (max === 0) continue;
    forward = Math.min(forward, Math.max(0, max - anchor) / index);
    backward = Math.min(backward, anchor / index);
  }
  if (forward >= backward) return room.map((max, index) => clamp(anchor + index * forward, max));
  if (room.every((max, index) => max === 0 || anchor - index * backward <= max)) {
    return room.map((max, index) => clamp(anchor - index * backward, max));
  }
  // A larger picture can start outside its bounds even at the full reverse step. Pull such
  // anchors onto the page before stepping so equally large pictures still get distinct corners.
  const anchors = room.map(max => clamp(anchor, max));
  for (let index = 1; index < anchors.length; index++) {
    if (room[index]! > 0) backward = Math.min(backward, anchors[index]! / index);
  }
  return anchors.map((start, index) => Math.max(0, start - index * backward));
}

/**
 * Frames for the pictures of one drop. The first is centred on `point` where it fits, the rest
 * cascade from its top-left corner. Each keeps its natural size unless larger than the page,
 * when it shrinks uniformly to fit (never grows), and lies wholly on the page.
 */
export function placeDroppedImages(
  page: { width: number; height: number },
  point: PagePointLike,
  sizes: readonly { width: number; height: number }[],
  cascade = DROP_CASCADE_OFFSET
): DropFrame[] {
  const fitted = sizes.map(size => {
    const fit = Math.min(1, page.width / size.width, page.height / size.height);
    return { width: size.width * fit, height: size.height * fit, scaled: fit < 1 };
  });
  const xs = cascadeCorners(point.x, fitted.map(size => size.width), page.width, cascade);
  const ys = cascadeCorners(point.y, fitted.map(size => size.height), page.height, cascade);
  return fitted.map(({ width, height, scaled }, index) => ({
    x: xs[index]!,
    y: ys[index]!,
    width, height, scaled
  }));
}

export interface InsertDroppedImagesResult {
  document: ChemDraftDocument;
  objectIds: string[];
  /** Names of pictures shrunk to fit the page. */
  scaledToPage: string[];
}

/**
 * Add every picture of one drop and select them, in a single patch batch: the caller commits it as
 * one undo entry. Object ids are allocated against the document being committed.
 */
export function insertDroppedImages(
  document: ChemDraftDocument,
  images: readonly PreparedDroppedImage[],
  point: PagePointLike
): InsertDroppedImagesResult {
  const page = firstPage(document);
  const reserved = new Set<string>();
  const objects: GraphicObject[] = images.map(image => {
    const id = nextObjectId(document, "image", reserved);
    reserved.add(id);
    const object = createImageGraphicObject({ mimeType: image.mimeType, dataBase64: image.dataBase64, center: { x: 0, y: 0 }, id });
    return image.naturalSize ? { ...object, width: image.naturalSize.width, height: image.naturalSize.height } : object;
  });
  const frames = placeDroppedImages(page, point, objects);
  const placed = objects.map((object, index) => {
    const { x, y, width, height } = frames[index]!;
    return { ...object, x, y, width, height };
  });
  // A reversed cascade or a page-spanning picture can put a whole smaller frame inside a
  // larger one. Paint the larger one behind it. Identical frames have no edge to expose.
  const stacked: GraphicObject[] = [];
  for (const picture of placed) {
    const covered = stacked.findIndex(other =>
      (picture.width > other.width || picture.height > other.height) &&
      picture.x <= other.x && picture.y <= other.y &&
      picture.x + picture.width >= other.x + other.width &&
      picture.y + picture.height >= other.y + other.height);
    stacked.splice(covered < 0 ? stacked.length : covered, 0, picture);
  }
  const patches: DocumentPatch[] = [
    ...stacked.map(object => ({ op: "addObject" as const, pageId: page.id, object })),
    { op: "setSelection", pageId: page.id, objectIds: placed.map(object => object.id) }
  ];
  return {
    document: placed.length ? applyPatches(document, patches, { now: phase4Timestamp }) : document,
    objectIds: placed.map(object => object.id),
    scaledToPage: images.filter((_, index) => frames[index]!.scaled).map(image => image.name)
  };
}
