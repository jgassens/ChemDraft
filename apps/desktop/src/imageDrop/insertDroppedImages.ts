import {
  applyPatches, createImageGraphicObject, nextObjectId, type ChemDraftDocument, type DocumentPatch, type GraphicObject
} from "@chemdraft/chem-core";
import { firstPage, phase4Timestamp } from "@chemdraft/document-workflow-core";
import { sameFrame, STACK_TOLERANCE, visiblePaintOrder, type StackFrame } from "./dropStacking";
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
  /**
   * Pictures left with exactly the same frame, because no place on the page gives them an edge of
   * their own (pictures as large as the page): each group as indices into `frames`, in drop order.
   */
  stacked: number[][];
}

/** How many places a coincident picture tries before it stays stacked: a bound on a drop's work. */
const SEPARATION_TRIES = 256;

/** Directions a coincident picture steps in, in order: down and right first, as the cascade does. */
const SEPARATION_DIRECTIONS = [[1, 1], [1, 0], [0, 1], [-1, -1], [-1, 0], [0, -1], [1, -1], [-1, 1]] as const;

/**
 * Places where `frame` could go instead, each wholly on the page. First a step of the cascade's size
 * in every direction, then of a half, a quarter and an eighth of it, so the edge it shows is as wide
 * as the page allows; then, nearest first, every other place that can change what shows: the page's
 * edges, each position where an edge of `frame` meets an edge of another frame, and the middle of
 * each stretch between two such positions.
 */
function separationCandidates(frame: StackFrame, others: readonly StackFrame[], page: { width: number; height: number }, cascade: number) {
  const roomX = Math.max(0, page.width - frame.width);
  const roomY = Math.max(0, page.height - frame.height);
  const clamp = (value: number, room: number) => Math.min(Math.max(value, 0), room);
  const steps = [1, 1 / 2, 1 / 4, 1 / 8].flatMap(fraction => SEPARATION_DIRECTIONS.map(([dx, dy]) => ({
    x: clamp(frame.x + dx * fraction * cascade, roomX), y: clamp(frame.y + dy * fraction * cascade, roomY)
  })));
  const axis = (size: number, room: number, starts: readonly number[], sizes: readonly number[]) => {
    const edges = [...new Set([0, room, ...starts.flatMap((other, index) => {
      const end = other + sizes[index]!;
      return [other, end, other - size, end - size];
    })].map(value => clamp(value, room)))].sort((a, b) => a - b);
    return [...edges, ...edges.slice(1).map((edge, index) => (edge + edges[index]!) / 2)];
  };
  const xs = axis(frame.width, roomX, others.map(other => other.x), others.map(other => other.width));
  const ys = axis(frame.height, roomY, others.map(other => other.y), others.map(other => other.height));
  const distance = ({ x, y }: { x: number; y: number }) => Math.hypot(x - frame.x, y - frame.y);
  const places = xs.flatMap(x => ys.map(y => ({ x, y }))).sort((a, b) => distance(a) - distance(b));
  const seen = new Set<string>();
  return [...steps, ...places].filter(({ x, y }) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Math.abs(x - frame.x) > STACK_TOLERANCE || Math.abs(y - frame.y) > STACK_TOLERANCE;
  });
}

/**
 * Moves each picture whose frame is the same as an earlier picture's to the nearest place on the
 * page where every picture still keeps visible area (the first of them stays where it was put).
 * A picture no place frees, such as a second copy of one as large as the page, stays stacked.
 */
function separateCoincidentFrames(
  page: { width: number; height: number }, arrangement: Omit<DropArrangement, "stacked">, cascade: number
): DropArrangement {
  const frames = [...arrangement.frames];
  let paintOrder = arrangement.paintOrder;
  for (let index = 1; index < frames.length; index++) {
    const frame = frames[index]!;
    if (!frames.slice(0, index).some(other => sameFrame(other, frame))) continue;
    const others = frames.filter((_, other) => other !== index);
    for (const { x, y } of separationCandidates(frame, others, page, cascade).slice(0, SEPARATION_TRIES)) {
      const moved = { ...frame, x, y };
      if (others.some(other => sameFrame(other, moved))) continue;
      const trial = frames.map((other, at) => at === index ? moved : other);
      const order = visiblePaintOrder(trial);
      if (!order) continue;
      frames[index] = moved;
      paintOrder = order;
      break;
    }
  }
  const stacked: number[][] = [];
  const grouped = new Set<number>();
  for (let index = 0; index < frames.length; index++) {
    if (grouped.has(index)) continue;
    const group = frames.flatMap((other, at) => at >= index && sameFrame(other, frames[index]!) ? [at] : []);
    if (group.length < 2) continue;
    for (const at of group) grouped.add(at);
    stacked.push(group);
  }
  return { frames, paintOrder, stacked };
}

/**
 * Frames and a paint order for one drop in which every picture keeps some area no picture above it
 * covers, so a click can reach it. Pictures with the same frame are the exception (`dropStacking.ts`):
 * the later one moves to the nearest place that gives it an edge of its own, keeping the rest of this
 * guarantee and every picture on the page, and only where none exists (pictures as large as the page)
 * do they stay stacked, listed in `stacked`. Otherwise the cascade of `placeDroppedImages` is kept
 * whenever some paint order of it works, and painted in drop order whenever that does. Mixed sizes can defeat every order of the cascade: pictures that
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
  if (paintOrder || !frames.length) return separateCoincidentFrames(page, { frames, paintOrder: paintOrder ?? [] }, cascade);
  const x = Math.max(0, Math.min(frames[0]!.x, ...frames.map(frame => page.width - frame.width)));
  const y = Math.max(0, Math.min(frames[0]!.y, ...frames.map(frame => page.height - frame.height)));
  const shared = frames.map(frame => ({ ...frame, x, y }));
  const largestFirst = shared.map((_, index) => index)
    .sort((a, b) => shared[b]!.width * shared[b]!.height - shared[a]!.width * shared[a]!.height || a - b);
  return separateCoincidentFrames(page, { frames: shared, paintOrder: visiblePaintOrder(shared) ?? largestFirst }, cascade);
}

export interface InsertDroppedImagesResult {
  document: ChemDraftDocument;
  objectIds: string[];
  /** Names of pictures shrunk to fit the page. */
  scaledToPage: string[];
  /** Names of pictures left exactly on top of each other, one list per stack, in drop order. */
  stackedExactly: string[][];
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
  const { frames, paintOrder, stacked } = arrangeDroppedImages(page, point, objects);
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
    scaledToPage: images.filter((_, index) => frames[index]!.scaled).map(image => image.name),
    stackedExactly: stacked.map(group => group.map(index => images[index]!.name))
  };
}
