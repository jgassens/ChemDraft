import {
  applyPatches, createImageGraphicObject, nextObjectId, type ChemDraftDocument, type DocumentPatch, type GraphicObject
} from "@chemdraft/chem-core";
import { firstPage, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { visiblePaintOrder } from "./dropStacking";
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

export interface DropArrangement {
  /** In drop order. */
  frames: DropFrame[];
  /** Indices into `frames`, bottom to top. */
  paintOrder: number[];
}

/**
 * Frames and a paint order for one drop in which every picture keeps some area no picture above it
 * covers, so a click can reach it; pictures with the same frame are the exception (`dropStacking.ts`).
 * The cascade of `placeDroppedImages` is kept whenever some paint order of it works, and painted in
 * drop order whenever that does. Mixed sizes can defeat every order of the cascade: pictures that
 * between them tile a larger one, each covered by the larger one. Every picture then takes the same
 * top-left corner, the first picture's moved only as far as every picture needs to stay on the page.
 * Frames that share a corner and are painted largest first always work: a frame above covers the
 * far corner of one below only if it is at least as wide and as tall, which a frame no larger in area
 * is only when the two are the same.
 */
export function arrangeDroppedImages(
  page: { width: number; height: number },
  point: PagePointLike,
  sizes: readonly { width: number; height: number }[],
  cascade = DROP_CASCADE_OFFSET
): DropArrangement {
  const frames = placeDroppedImages(page, point, sizes, cascade);
  const paintOrder = visiblePaintOrder(frames);
  if (paintOrder || !frames.length) return { frames, paintOrder: paintOrder ?? [] };
  const x = Math.max(0, Math.min(frames[0]!.x, ...frames.map(frame => page.width - frame.width)));
  const y = Math.max(0, Math.min(frames[0]!.y, ...frames.map(frame => page.height - frame.height)));
  const shared = frames.map(frame => ({ ...frame, x, y }));
  const largestFirst = shared.map((_, index) => index)
    .sort((a, b) => shared[b]!.width * shared[b]!.height - shared[a]!.width * shared[a]!.height || a - b);
  return { frames: shared, paintOrder: visiblePaintOrder(shared) ?? largestFirst };
}

export interface InsertDroppedImagesResult {
  document: ChemDraftDocument;
  objectIds: string[];
  /** Names of pictures shrunk to fit the page. */
  scaledToPage: string[];
}

/**
 * Add every picture of one drop and select them, in a single patch batch: the caller commits it as
 * one undo entry. Object ids are allocated against the document being committed. Pictures are
 * painted in the order `arrangeDroppedImages` gives and selected in drop order.
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
  const { frames, paintOrder } = arrangeDroppedImages(page, point, objects);
  const placed = objects.map((object, index) => {
    const { x, y, width, height } = frames[index]!;
    return { ...object, x, y, width, height };
  });
  const patches: DocumentPatch[] = [
    ...paintOrder.map(index => ({ op: "addObject" as const, pageId: page.id, object: placed[index]! })),
    { op: "setSelection", pageId: page.id, objectIds: placed.map(object => object.id) }
  ];
  return {
    document: placed.length ? applyPatches(document, patches, { now: phase4Timestamp }) : document,
    objectIds: placed.map(object => object.id),
    scaledToPage: images.filter((_, index) => frames[index]!.scaled).map(image => image.name)
  };
}
