import {
  applyPatches, createImageGraphicObject, nextObjectId, type ChemDraftDocument, type DocumentPatch, type GraphicObject
} from "@chemdraft/chem-core";
import { firstPage, phase4Timestamp } from "@chemdraft/document-workflow-core";
import type { PreparedDroppedImage } from "./prepareDroppedImage";

/** Each further picture of one drop moves down and right by this much, in page units. */
export const DROP_CASCADE_OFFSET = 24;
/**
 * The share of the page, in each direction, that a dropped picture may fill. A larger picture is
 * shrunk to fit this centred box, so the margin around it keeps its selection handles on the canvas
 * (owner rule, 2026-11-27): a page-sized picture once landed edge to edge with its handles hidden.
 */
export const DROP_FIT_PAGE_FRACTION = 0.8;

export interface PagePointLike { x: number; y: number }
export interface DropFrame { x: number; y: number; width: number; height: number; scaled: boolean }

/** Where along one axis a picture may lie: `start` to `start + length`. */
interface AxisRoom { start: number; length: number }

/**
 * Centres along one axis for a cascade of `extents`, each no longer than its own `rooms` entry. The
 * first picture is centred on `point` whenever it fits there, and otherwise moved only as far as it
 * must to lie in its room. Picture `i` sits `i` steps from that same anchor (its own extent's anchor),
 * down/right by preference, up/left when only that side has room for the whole cascade, and
 * otherwise towards the roomier side with the step shrunk to the room there. Each picture is sized
 * against its own room, not the batch's, so a picture that fills its room does not pin the small
 * pictures beside it to one spot; every picture keeps a position of its own whenever it has room.
 */
function cascadeCentres(point: number, extents: readonly number[], rooms: readonly AxisRoom[], cascade: number): number[] {
  const steps = Math.max(1, extents.length - 1);
  return extents.map((extent, index) => {
    const room = rooms[index]!;
    const low = room.start + extent / 2;
    const high = Math.max(low, room.start + room.length - extent / 2);
    const anchor = Math.min(Math.max(point, low), high);
    if (index === 0) return anchor;
    const forward = high - anchor;
    const backward = anchor - low;
    const span = steps * cascade;
    const direction = forward >= span || forward >= backward ? 1 : -1;
    const step = Math.min(cascade, (direction === 1 ? forward : backward) / steps);
    return anchor + direction * index * step;
  });
}

/**
 * Frames for the pictures of one drop. The first is centred on `point` where it fits, the rest
 * cascade from it (see `cascadeCentres`). Each keeps its natural size unless it is larger than
 * `DROP_FIT_PAGE_FRACTION` of the page in either direction; then it shrinks uniformly (never grows)
 * to fit that share of the page and lies within the centred box of that size, leaving a margin on
 * every side. Every picture lies wholly on the page.
 */
export function placeDroppedImages(
  page: { width: number; height: number },
  point: PagePointLike,
  sizes: readonly { width: number; height: number }[],
  cascade = DROP_CASCADE_OFFSET
): DropFrame[] {
  const box = { width: page.width * DROP_FIT_PAGE_FRACTION, height: page.height * DROP_FIT_PAGE_FRACTION };
  const fitted = sizes.map(size => {
    const fit = Math.min(1, box.width / size.width, box.height / size.height);
    return { width: size.width * fit, height: size.height * fit, scaled: fit < 1 };
  });
  const room = (pageLength: number, boxLength: number, scaled: boolean): AxisRoom =>
    scaled ? { start: (pageLength - boxLength) / 2, length: boxLength } : { start: 0, length: pageLength };
  const xs = cascadeCentres(point.x, fitted.map(size => size.width), fitted.map(size => room(page.width, box.width, size.scaled)), cascade);
  const ys = cascadeCentres(point.y, fitted.map(size => size.height), fitted.map(size => room(page.height, box.height, size.scaled)), cascade);
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(0, max));
  return fitted.map(({ width, height, scaled }, index) => ({
    x: clamp(xs[index]! - width / 2, page.width - width),
    y: clamp(ys[index]! - height / 2, page.height - height),
    width, height, scaled
  }));
}

export interface InsertDroppedImagesResult {
  document: ChemDraftDocument;
  objectIds: string[];
  /** Names of pictures shrunk to fit the page (with its margin, `DROP_FIT_PAGE_FRACTION`). */
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
  const patches: DocumentPatch[] = [
    ...placed.map(object => ({ op: "addObject" as const, pageId: page.id, object })),
    { op: "setSelection", pageId: page.id, objectIds: placed.map(object => object.id) }
  ];
  return {
    document: placed.length ? applyPatches(document, patches, { now: phase4Timestamp }) : document,
    objectIds: placed.map(object => object.id),
    scaledToPage: images.filter((_, index) => frames[index]!.scaled).map(image => image.name)
  };
}
