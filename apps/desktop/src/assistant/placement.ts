import type { DocumentObject } from "@chemdraft/chem-core";
import { moleculeVisualBoundsForArrangement, textVisualBoundsForArrangement } from "@chemdraft/layout-engine";
import { smilesPasteBondLengthPx } from "@chemdraft/document-workflow-core";
import type { AssistantRect } from "./AssistantToolContext";

export const ASSISTANT_MARGIN = 36;
export const ASSISTANT_GAP = 2 * smilesPasteBondLengthPx;
export const RELATIVE_GAP = 12;
export type RelativeSide = "above" | "below" | "left" | "right";
export interface PlacementResult { rect: AssistantRect; warnings: string[] }

export function objectRect(object: DocumentObject): AssistantRect {
  if (object.type === "molecule") return moleculeVisualBoundsForArrangement(object);
  if (object.type === "text") return textVisualBoundsForArrangement(object);
  // A circumscribed frame conservatively covers any rotation of other native objects.
  if (object.rotation !== 0) {
    const extent = Math.hypot(object.width, object.height);
    return { x: object.x + (object.width - extent) / 2, y: object.y + (object.height - extent) / 2,
      width: extent, height: extent };
  }
  return { x: object.x, y: object.y, width: object.width, height: object.height };
}
export function overlaps(a: AssistantRect, b: AssistantRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
export function unionRects(rects: readonly AssistantRect[]): AssistantRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

/** Finite edge candidates find free rectangles without scanning each page pixel. */
export function choosePlacement(options: {
  page: { width: number; height: number }; size: { width: number; height: number };
  occupied: readonly AssistantRect[]; viewport?: AssistantRect; preferred?: AssistantRect;
}): PlacementResult {
  const { page, occupied, viewport, preferred } = options;
  const size = { width: options.size.width, height: options.size.height };
  const fits = (rect: AssistantRect) => rect.x >= ASSISTANT_MARGIN && rect.y >= ASSISTANT_MARGIN &&
    rect.x + rect.width <= page.width - ASSISTANT_MARGIN &&
    rect.y + rect.height <= page.height - ASSISTANT_MARGIN &&
    occupied.every(other => !overlaps(rect, other, ASSISTANT_GAP));
  if (preferred && fits(preferred)) return { rect: preferred, warnings: [] };
  const lowest = Math.max(ASSISTANT_MARGIN - ASSISTANT_GAP, ...occupied.map(rect => rect.y + rect.height));
  const anchor = preferred ?? (viewport
    ? { x: viewport.x + (viewport.width - size.width) / 2, y: viewport.y + (viewport.height - size.height) / 2, ...size }
    : { x: ASSISTANT_MARGIN, y: lowest + ASSISTANT_GAP, ...size });
  const xs = new Set([ASSISTANT_MARGIN, anchor.x, page.width - ASSISTANT_MARGIN - size.width]);
  const ys = new Set([ASSISTANT_MARGIN, anchor.y, lowest + ASSISTANT_GAP, page.height - ASSISTANT_MARGIN - size.height]);
  occupied.forEach(rect => {
    xs.add(rect.x + rect.width + ASSISTANT_GAP); xs.add(rect.x - size.width - ASSISTANT_GAP);
    ys.add(rect.y + rect.height + ASSISTANT_GAP); ys.add(rect.y - size.height - ASSISTANT_GAP);
  });
  const axis = (values: Set<number>, anchorValue: number, maximum: number) => [...values]
    .filter(value => value >= ASSISTANT_MARGIN && value <= maximum)
    .sort((a, b) => (a - anchorValue) ** 2 - (b - anchorValue) ** 2 || a - b);
  const xValues = axis(xs, anchor.x, page.width - ASSISTANT_MARGIN - size.width);
  const yValues = axis(ys, anchor.y, page.height - ASSISTANT_MARGIN - size.height);
  // Best-first traversal of the Cartesian product avoids allocating O(objects²) rectangles.
  type Candidate = { ix: number; iy: number; distance: number };
  const heap: Candidate[] = [];
  const visited = new Set<string>();
  const push = (ix: number, iy: number) => {
    if (ix >= xValues.length || iy >= yValues.length || visited.has(`${ix},${iy}`)) return;
    visited.add(`${ix},${iy}`);
    const candidate = { ix, iy, distance: (xValues[ix]! - anchor.x) ** 2 + (yValues[iy]! - anchor.y) ** 2 };
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent]!.distance <= candidate.distance) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = candidate;
  };
  const pop = () => {
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1]!.distance < heap[child]!.distance) child++;
        if (heap[child]!.distance >= last.distance) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  push(0, 0);
  // Imported pages can contain thousands of objects. Bound the search, then disclose fallback.
  for (let attempts = 0; heap.length && attempts < 4096; attempts++) {
    const { ix, iy } = pop();
    const rect = { x: xValues[ix]!, y: yValues[iy]!, ...size };
    if (fits(rect)) return { rect, warnings: [] };
    push(ix + 1, iy); push(ix, iy + 1);
  }
  return { rect: { x: Math.max(0, (page.width - size.width) / 2),
    y: Math.max(0, (page.height - size.height) / 2), ...size }, warnings: ["assistant.placement_overlaps"] };
}
export function relativeRect(size: { width: number; height: number }, target: AssistantRect, side: RelativeSide): AssistantRect {
  size = { width: size.width, height: size.height };
  const x = side === "left" ? target.x - size.width - RELATIVE_GAP : side === "right"
    ? target.x + target.width + RELATIVE_GAP : target.x + (target.width - size.width) / 2;
  const y = side === "above" ? target.y - size.height - RELATIVE_GAP : side === "below"
    ? target.y + target.height + RELATIVE_GAP : target.y + (target.height - size.height) / 2;
  return { x, y, ...size };
}
