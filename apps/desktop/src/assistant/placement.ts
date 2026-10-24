import type { DocumentObject } from "@chemdraft/chem-core";
import { moleculeVisualBoundsForArrangement, textVisualBoundsForArrangement } from "@chemdraft/layout-engine";
import { smilesPasteBondLengthPx } from "@chemdraft/document-workflow-core";
import type { AssistantRect } from "./AssistantToolContext";

export const ASSISTANT_MARGIN = 36;
export const ASSISTANT_GAP = 2 * smilesPasteBondLengthPx;
export const RELATIVE_GAP = 12;
export type RelativeSide = "above" | "below" | "left" | "right";
export interface PlacementResult { rect: AssistantRect; warnings: string[] }
type PlacementPage = { width: number; height: number; margin?: { top: number; right: number; bottom: number; left: number } };

export function pageContentRect(page: PlacementPage): AssistantRect {
  const margin = page.margin ?? { top: ASSISTANT_MARGIN, right: ASSISTANT_MARGIN, bottom: ASSISTANT_MARGIN, left: ASSISTANT_MARGIN };
  return { x: margin.left, y: margin.top, width: Math.max(0, page.width - margin.left - margin.right),
    height: Math.max(0, page.height - margin.top - margin.bottom) };
}

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
  page: PlacementPage; size: { width: number; height: number };
  occupied: readonly AssistantRect[]; viewport?: AssistantRect; preferred?: AssistantRect; gap?: number;
}): PlacementResult {
  const { page, occupied, viewport, preferred, gap = ASSISTANT_GAP } = options;
  const content = pageContentRect(page);
  const size = { width: options.size.width, height: options.size.height };
  const fits = (rect: AssistantRect) => rect.x >= content.x && rect.y >= content.y &&
    rect.x + rect.width <= content.x + content.width &&
    rect.y + rect.height <= content.y + content.height &&
    occupied.every(other => !overlaps(rect, other, gap));
  if (preferred && fits(preferred)) return { rect: preferred, warnings: [] };
  const lowest = Math.max(content.y - gap, ...occupied.map(rect => rect.y + rect.height));
  const anchor = preferred ?? (viewport
    ? { x: viewport.x + (viewport.width - size.width) / 2, y: viewport.y + (viewport.height - size.height) / 2, ...size }
    : { x: content.x, y: lowest + gap, ...size });
  const minX = content.x, maxX = content.x + content.width - size.width;
  const ys = new Set([content.y, anchor.y, lowest + gap, content.y + content.height - size.height]);
  occupied.forEach(rect => {
    ys.add(rect.y + rect.height + gap); ys.add(rect.y - size.height - gap);
  });
  const yValues = [...ys].filter(y => y >= content.y && y <= content.y + content.height - size.height)
    .sort((a, b) => (a - anchor.y) ** 2 - (b - anchor.y) ** 2 || a - b);
  let best: AssistantRect | undefined;
  let distance = Infinity;
  // At each vertical edge, subtract the occupied horizontal intervals. This searches the
  // whole page without a pixel scan, quadratic candidate heap, or false search-budget overflow.
  for (const y of yValues) {
    const dy = (y - anchor.y) ** 2;
    if (dy > distance || maxX < minX) break;
    const blocked = occupied.filter(rect => y < rect.y + rect.height + gap && y + size.height + gap > rect.y)
      .map(rect => ({ start: rect.x - size.width - gap, end: rect.x + rect.width + gap }))
      .sort((a, b) => a.start - b.start);
    const consider = (left: number, right: number) => {
      if (left > right) return;
      const x = Math.max(left, Math.min(anchor.x, right));
      const d = (x - anchor.x) ** 2 + dy;
      const rect = { x, y, ...size };
      if (d < distance && fits(rect)) { best = rect; distance = d; }
    };
    let left = minX;
    for (const interval of blocked) {
      if (interval.end < left) continue;
      consider(left, Math.min(maxX, interval.start));
      left = Math.max(left, interval.end);
      if (left > maxX) break;
    }
    consider(left, maxX);
  }
  if (best) return { rect: best, warnings: [] };
  return { rect: { x: Math.max(0, (page.width - size.width) / 2),
    y: Math.max(0, (page.height - size.height) / 2), ...size }, warnings: ["assistant.placement_overlaps"] };
}

/** Pack complete cells (molecule plus caption) using actual widths, wrapping at the content edge.
 * Every cell searches the remaining page, including holes above the current row, before overflow.
 * Overflow stays beside the page below it, never collides with existing content, and is disclosed.
 */
interface PagePlacementsOptions {
  page: PlacementPage; sizes: readonly { width: number; height: number }[];
  occupied: readonly AssistantRect[]; columns?: number; viewport?: AssistantRect; preferred?: AssistantRect; gap?: number;
}

export function choosePagePlacements(options: PagePlacementsOptions): { rects: AssistantRect[]; warnings: string[] } {
  let best = packPagePlacements(options, options.gap ?? ASSISTANT_GAP);
  // Try readable compact spacing before claiming that the available page is full.
  for (const gap of [ASSISTANT_GAP / 2, RELATIVE_GAP]) {
    if (!best.overflow) break;
    if (gap >= (options.gap ?? ASSISTANT_GAP)) continue;
    const candidate = packPagePlacements(options, gap);
    if (candidate.overflow < best.overflow) best = candidate;
  }
  return { rects: best.rects, warnings: best.warnings };
}

function packPagePlacements(options: PagePlacementsOptions, gap: number) {
  const content = pageContentRect(options.page);
  const occupied = [...options.occupied];
  let x = content.x, y = content.y, rowBottom = y, column = 0, overflow = 0;
  let overflowX = content.x;
  let overflowY = Math.max(options.page.height, ...occupied.map(rect => rect.y + rect.height)) + gap;
  let overflowBottom = overflowY;
  const rects = options.sizes.map(size => {
    if (column >= (options.columns ?? Infinity) || x + size.width > content.x + content.width) {
      x = content.x; y = rowBottom + gap; column = 0;
    }
    const placed = choosePlacement({ ...options, occupied, size, gap,
      preferred: options.sizes.length === 1 ? options.preferred : { x, y, width: size.width, height: size.height } });
    if (placed.warnings.length) {
      overflow++;
      if (overflowX > content.x && overflowX + size.width > content.x + content.width) {
        overflowX = content.x; overflowY = overflowBottom + gap;
      }
      const rect = { x: overflowX, y: overflowY, width: size.width, height: size.height };
      overflowX += size.width + gap;
      overflowBottom = Math.max(overflowBottom, overflowY + size.height);
      occupied.push(rect);
      return rect;
    }
    const rect = placed.rect;
    if (rect.y !== y) { column = 0; rowBottom = rect.y; }
    x = rect.x + rect.width + gap; y = rect.y;
    rowBottom = Math.max(rowBottom, rect.y + rect.height); column++;
    occupied.push(rect);
    return rect;
  });
  return { rects, overflow, warnings: overflow ? [`assistant.placement_overflow: ${overflow} ${overflow === 1 ? "item" : "items"} could not fit in the page's available area; placed below the page without rescaling.`] : [] };
}
export function relativeRect(size: { width: number; height: number }, target: AssistantRect, side: RelativeSide): AssistantRect {
  size = { width: size.width, height: size.height };
  const x = side === "left" ? target.x - size.width - RELATIVE_GAP : side === "right"
    ? target.x + target.width + RELATIVE_GAP : target.x + (target.width - size.width) / 2;
  const y = side === "above" ? target.y - size.height - RELATIVE_GAP : side === "below"
    ? target.y + target.height + RELATIVE_GAP : target.y + (target.height - size.height) / 2;
  return { x, y, ...size };
}
