import type { LayoutBounds } from "./index";

export type ObjectAlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type ObjectDistributeAxis = "horizontal" | "vertical";
export type ObjectDistributeMode = "centers" | "spacing";
export interface ObjectLayoutItem { id: string; bounds: LayoutBounds }
export interface ObjectLayoutMove { id: string; dx: number; dy: number }

/** Bounds of a layout unit, including separately drawn annotations carried with it. */
export function combinedLayoutBounds(boxes: readonly LayoutBounds[]): LayoutBounds | undefined {
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

/** Plan one translation per unit without changing any member's size or internal offset. */
export function planObjectAlignment(items: readonly ObjectLayoutItem[], mode: ObjectAlignMode): ObjectLayoutMove[] {
  if (items.length < 2) return [];
  const bounds = combinedLayoutBounds(items.map(item => item.bounds))!;
  return items.map(({ id, bounds: item }) => ({ id,
    dx: mode === "left" ? bounds.x - item.x :
      mode === "center" ? bounds.x + bounds.width / 2 - (item.x + item.width / 2) :
      mode === "right" ? bounds.x + bounds.width - (item.x + item.width) : 0,
    dy: mode === "top" ? bounds.y - item.y :
      mode === "middle" ? bounds.y + bounds.height / 2 - (item.y + item.height / 2) :
      mode === "bottom" ? bounds.y + bounds.height - (item.y + item.height) : 0
  }));
}

/** Distribute unit centers or visible gaps, retaining the two outer units. */
export function planObjectDistribution(
  items: readonly ObjectLayoutItem[], axis: ObjectDistributeAxis, mode: ObjectDistributeMode = "centers"
): ObjectLayoutMove[] {
  if (items.length < 3) return [];
  const start = ({ bounds }: ObjectLayoutItem) => axis === "horizontal" ? bounds.x : bounds.y;
  const size = ({ bounds }: ObjectLayoutItem) => axis === "horizontal" ? bounds.width : bounds.height;
  const position = (item: ObjectLayoutItem) => start(item) + (mode === "centers" ? size(item) / 2 : 0);
  const sorted = [...items].sort((a, b) => position(a) - position(b));
  const first = position(sorted[0]), last = sorted[sorted.length - 1];
  const spacing = mode === "centers" ? (position(last) - first) / (sorted.length - 1) :
    (start(last) + size(last) - first - sorted.reduce((sum, item) => sum + size(item), 0)) / (sorted.length - 1);
  if (mode === "centers" && Math.abs(spacing) < 1e-6) return [];
  let target = first;
  return sorted.map((item, index) => {
    const delta = index === 0 || index === sorted.length - 1 ? 0 : target - position(item);
    target += spacing + (mode === "spacing" ? size(item) : 0);
    return { id: item.id, dx: axis === "horizontal" ? delta : 0, dy: axis === "vertical" ? delta : 0 };
  });
}
