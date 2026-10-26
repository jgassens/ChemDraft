import type { LayoutBounds, LayoutPoint } from "./index";

export const ArrangementLayouts = ["circle", "oval", "grid", "row", "column"] as const;
export type ArrangementLayout = typeof ArrangementLayouts[number];
export const ArrangementGridAlignments = ["left", "center", "right"] as const;
export type ArrangementGridAlignment = typeof ArrangementGridAlignments[number];
export interface ArrangementItem { id: string; bounds: LayoutBounds; anchor?: LayoutPoint; outlines?: LayoutPoint[][] }
export interface ArrangementPlacement extends ArrangementItem { dx: number; dy: number }
export interface ArrangementOptions {
  /** Empty space between visible item bounds, in document CSS pixels. Explicit values are fixed.
   * Defaults to 48; Row/Column may reduce that to 12 when needed to fit pageBounds. */
  gap?: number;
  /** Grid defaults to a roughly square number of columns. */
  columns?: number;
  /** Alignment of an incomplete final grid row. */
  gridAlignment?: ArrangementGridAlignment;
  /** When supplied, refuse a layout that cannot fit without scaling its items. */
  pageBounds?: LayoutBounds;
}
export type ArrangementPlan =
  | { ok: true; placements: ArrangementPlacement[]; bounds: LayoutBounds;
      cycle?: { center: LayoutPoint; radiusX: number; radiusY: number } }
  | { ok: false; reason: "selection" | "invalid" | "page" };

/** Pure translation-only layout: sizes and internal geometry never change. */
export function planObjectArrangement(
  items: readonly ArrangementItem[],
  layout: ArrangementLayout,
  options: ArrangementOptions = {}
): ArrangementPlan {
  if (items.length < 2) return { ok: false, reason: "selection" };
  const gap = options.gap ?? 48;
  if (!ArrangementLayouts.includes(layout) || !Number.isFinite(gap) || gap < 0 ||
      new Set(items.map((item) => item.id)).size !== items.length ||
      items.some((item) => !validBounds(item.bounds)) ||
      items.some(item => item.anchor && (!Number.isFinite(item.anchor.x) || !Number.isFinite(item.anchor.y))) ||
      (options.gridAlignment !== undefined && !ArrangementGridAlignments.includes(options.gridAlignment)) ||
      (options.pageBounds && !validBounds(options.pageBounds)) ||
      (options.columns !== undefined && (!Number.isInteger(options.columns) || options.columns < 1))) {
    return { ok: false, reason: "invalid" };
  }
  const originalBounds = unionBounds(items.map((item) => item.bounds));
  const center = boundsCenter(originalBounds);
  // Keep an existing cycle's clockwise order. Equal-position ties retain input order.
  // Linear layouts keep their spatial order; the grid reads top-to-bottom, then left-to-right.
  const angleCenter = {
    x: items.reduce((sum, item) => sum + itemCenter(item).x, 0) / items.length,
    y: items.reduce((sum, item) => sum + itemCenter(item).y, 0) / items.length
  };
  const angle = (item: ArrangementItem) => {
    const p = itemCenter(item);
    const result = (Math.atan2(p.y - angleCenter.y, p.x - angleCenter.x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    return Math.PI * 2 - result < 1e-10 ? 0 : result;
  };
  const ordered = [...items].sort((a, b) =>
    layout === "circle" || layout === "oval" ? angle(a) - angle(b) :
    layout === "row" ? itemCenter(a).x - itemCenter(b).x :
    layout === "column" ? itemCenter(a).y - itemCenter(b).y :
    Math.abs(itemCenter(a).y - itemCenter(b).y) > 1e-9
      ? itemCenter(a).y - itemCenter(b).y
      : itemCenter(a).x - itemCenter(b).x
  );
  let targets: LayoutBounds[];
  let cycle: { center: LayoutPoint; radiusX: number; radiusY: number } | undefined;
  if (layout === "circle" || layout === "oval") {
    const aspect = layout === "oval" ? 1.5 : 1;
    const directions = ordered.map((_, i) => {
      const theta = -Math.PI / 2 + Math.PI * 2 * i / ordered.length;
      return { x: aspect * Math.cos(theta), y: Math.sin(theta) };
    });
    // Leave an open center, and solve every pair's axis-aligned clearance analytically.
    // Neighbour-only checks miss collisions between large non-neighbouring compounds.
    const offsets = ordered.map(item => ({x:item.bounds.x-itemCenter(item).x,y:item.bounds.y-itemCenter(item).y}));
    let radius = Math.max(...ordered.map((item,i) => Math.hypot(
      Math.max(Math.abs(offsets[i].x),Math.abs(offsets[i].x+item.bounds.width)),
      Math.max(Math.abs(offsets[i].y),Math.abs(offsets[i].y+item.bounds.height))))) + gap;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const signedX = directions[j].x - directions[i].x, signedY = directions[j].y - directions[i].y;
        const deltaX = Math.abs(signedX), deltaY = Math.abs(signedY);
        const requiredX = deltaX < 1e-12 ? Infinity :
          Math.max(0,(signedX>0 ? offsets[i].x+ordered[i].bounds.width-offsets[j].x : offsets[j].x+ordered[j].bounds.width-offsets[i].x)+gap) / deltaX;
        const requiredY = deltaY < 1e-12 ? Infinity :
          Math.max(0,(signedY>0 ? offsets[i].y+ordered[i].bounds.height-offsets[j].y : offsets[j].y+ordered[j].bounds.height-offsets[i].y)+gap) / deltaY;
        radius = Math.max(radius, Math.min(requiredX, requiredY));
      }
    }
    cycle = { center: { x: 0, y: 0 }, radiusX: radius * aspect, radiusY: radius };
    targets = ordered.map((item, i) => ({
      x: radius * directions[i].x + offsets[i].x,
      y: radius * directions[i].y + offsets[i].y,
      width: item.bounds.width, height: item.bounds.height
    }));
  } else if (layout === "row" || layout === "column") {
    let linearGap = gap;
    if (options.pageBounds && options.gap === undefined) {
      const available = layout === "row" ? options.pageBounds.width : options.pageBounds.height;
      const occupied = ordered.reduce((sum, item) => sum + (layout === "row" ? item.bounds.width : item.bounds.height), 0);
      // Tighten only the default spacing. Preserve a visible clearance, and round down so
      // floating-point accumulation cannot push a fitted endpoint beyond the page edge.
      const fittingGap = Math.floor((available - occupied) / (ordered.length - 1) * 1e6) / 1e6;
      linearGap = Math.min(gap, Math.max(12, fittingGap));
    }
    let cursor = 0;
    targets = ordered.map((item) => {
      const { width, height } = item.bounds;
      const bounds = layout === "row"
        ? { x: cursor, y: item.bounds.y-itemCenter(item).y, width, height }
        : { x: item.bounds.x-itemCenter(item).x, y: cursor, width, height };
      cursor += (layout === "row" ? width : height) + linearGap;
      return bounds;
    });
  } else {
    const columns = Math.min(ordered.length, options.columns ?? Math.ceil(Math.sqrt(ordered.length)));
    const rows = Math.ceil(ordered.length / columns);
    const widths = Array<number>(columns).fill(0);
    const heights = Array<number>(rows).fill(0);
    const lefts=Array<number>(columns).fill(0),rights=Array<number>(columns).fill(0);
    const tops=Array<number>(rows).fill(0),bottoms=Array<number>(rows).fill(0);
    ordered.forEach((item, i) => {
      const col=i%columns,row=Math.floor(i/columns),p=itemCenter(item);
      lefts[col]=Math.max(lefts[col],p.x-item.bounds.x);rights[col]=Math.max(rights[col],item.bounds.x+item.bounds.width-p.x);
      tops[row]=Math.max(tops[row],p.y-item.bounds.y);bottoms[row]=Math.max(bottoms[row],item.bounds.y+item.bounds.height-p.y);
      widths[col]=lefts[col]+rights[col];heights[row]=tops[row]+bottoms[row];
    });
    const starts = (sizes: number[]) => {
      let cursor = 0;
      return sizes.map((size) => { const start = cursor; cursor += size + gap; return start; });
    };
    const xs = starts(widths), ys = starts(heights);
    targets = ordered.map((item, i) => {
      const col = i % columns, row = Math.floor(i / columns);
      return {
        x: xs[col] + lefts[col] + item.bounds.x-itemCenter(item).x,
        y: ys[row] + tops[row] + item.bounds.y-itemCenter(item).y,
        width: item.bounds.width, height: item.bounds.height
      };
    });
    const remainder = ordered.length % columns;
    if (remainder) {
      const rowStart = ordered.length - remainder;
      const fullRows = unionBounds(targets.slice(0, rowStart));
      const rowWidth = ordered.slice(rowStart).reduce((sum, item) => sum + item.bounds.width, 0) + gap * (remainder - 1);
      const alignment = options.gridAlignment ?? "center";
      let cursor = fullRows.x + (alignment === "left" ? 0 : alignment === "right" ? fullRows.width - rowWidth : (fullRows.width - rowWidth) / 2);
      for (let i = rowStart; i < ordered.length; i++) {
        targets[i].x = cursor;
        cursor += ordered[i].bounds.width + gap;
      }
    }
  }
  const itemBounds = unionBounds(targets);
  const localBounds = itemBounds;
  if (!validBounds(localBounds)) return { ok: false, reason: "invalid" };
  const page = options.pageBounds;
  if (page && (localBounds.width > page.width || localBounds.height > page.height)) {
    return { ok: false, reason: "page" };
  }
  // Center the compounds' visible frame, keeping unequal-sized cycles stable on reapplication.
  let x = center.x - itemBounds.width / 2 + localBounds.x - itemBounds.x;
  let y = center.y - itemBounds.height / 2 + localBounds.y - itemBounds.y;
  if (page) {
    x = Math.max(page.x, Math.min(x, page.x + page.width - localBounds.width));
    y = Math.max(page.y, Math.min(y, page.y + page.height - localBounds.height));
  }
  const offset = { x: x - localBounds.x, y: y - localBounds.y };
  return {
    ok: true, bounds: { ...localBounds, x, y },
    ...(cycle ? { cycle: { ...cycle, center: { x: offset.x, y: offset.y } } } : {}),
    placements: ordered.map((item, i) => {
      const bounds = { ...targets[i], x: targets[i].x + offset.x, y: targets[i].y + offset.y };
      const dx=bounds.x-item.bounds.x,dy=bounds.y-item.bounds.y;
      return { id: item.id, bounds, dx, dy,
        ...(item.outlines ? {outlines:item.outlines.map(outline=>outline.map(p=>({x:p.x+dx,y:p.y+dy})))} : {}),
        ...(item.anchor ? {anchor:{x:item.anchor.x+dx,y:item.anchor.y+dy}} : {}) };
    })
  };
}

function validBounds(bounds: LayoutBounds): boolean {
  return Object.values(bounds).every(Number.isFinite) && bounds.width >= 0 && bounds.height >= 0;
}
function boundsCenter(bounds: LayoutBounds): LayoutPoint {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
function itemCenter(item:ArrangementItem):LayoutPoint { return item.anchor ?? boundsCenter(item.bounds); }
function unionBounds(bounds: readonly LayoutBounds[]): LayoutBounds {
  const x = Math.min(...bounds.map((b) => b.x)), y = Math.min(...bounds.map((b) => b.y));
  return {
    x, y,
    width: Math.max(...bounds.map((b) => b.x + b.width)) - x,
    height: Math.max(...bounds.map((b) => b.y + b.height)) - y
  };
}
