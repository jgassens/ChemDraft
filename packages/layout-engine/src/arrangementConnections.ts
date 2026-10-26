import { trimQuadraticRoute, type NativeArtObstacle } from "@chemdraft/art-engine";
import type { ArrangementLayout, ArrangementPlan, ArrangementPlacement, ArrangementGridAlignment } from "./arrangement";
import type { LayoutPoint } from "./index";

export interface ArrangementDraft {
  layout: ArrangementLayout;
  gridAlignment: ArrangementGridAlignment;
  arrows: boolean;
  reverse: boolean;
  closeCycle: boolean;
  gridOrder: "rows" | "snake";
  arrowLength?: number;
}
export const defaultArrangementDraft: ArrangementDraft = {
  layout: "circle", gridAlignment: "center", arrows: false, reverse: false, closeCycle: false, gridOrder: "rows", arrowLength:100
};
export function validArrangementDraft(value: unknown): value is ArrangementDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return Object.keys(d).every(key=>['layout','gridAlignment','arrows','reverse','closeCycle','gridOrder','arrowLength'].includes(key)) &&
    (d.arrowLength===undefined || typeof d.arrowLength==='number' && Number.isFinite(d.arrowLength) && d.arrowLength>=30 && d.arrowLength<=100) &&
    ["circle", "oval", "grid", "row", "column"].includes(String(d.layout)) &&
    ["left", "center", "right"].includes(String(d.gridAlignment)) && typeof d.arrows === "boolean" &&
    typeof d.reverse === "boolean" && typeof d.closeCycle === "boolean" && ["rows", "snake"].includes(String(d.gridOrder));
}
export interface ArrangementConnection { start: LayoutPoint; end: LayoutPoint; middle: LayoutPoint;
  arrangementConnection: { fromObjectId: string; toObjectId: string; bend: LayoutPoint;
    settings?:ArrangementDraft; itemObjectIds?:string[] } }
const shapes = (p: ArrangementPlacement): NativeArtObstacle[] => p.outlines?.length ? p.outlines.map(outline=>({outline})) : [p.bounds];
const center = (p: ArrangementPlacement): LayoutPoint => p.anchor ?? ({ x: p.bounds.x + p.bounds.width / 2, y: p.bounds.y + p.bounds.height / 2 });

/** Neighbor topology, before direction reversal, shared by routing and edit validation. */
export function arrangementConnectionPairs<T>(items: readonly T[], draft: ArrangementDraft): [T,T][] {
  const pairs:[T,T][]=[];
  if(items.length<2)return pairs;
  const cycle = draft.layout === "circle" || draft.layout === "oval";
  let ordered = [...items];
  if (draft.layout === "grid") {
    const columns = Math.ceil(Math.sqrt(ordered.length));
    const rows = Array.from({ length: Math.ceil(ordered.length / columns) }, (_, i) => ordered.slice(i * columns, (i + 1) * columns));
    if (draft.gridOrder === "snake") ordered = rows.flatMap((row, i) => i % 2 ? row.reverse() : row);
    else {
      rows.forEach(row => row.slice(1).forEach((item, i) => pairs.push([row[i], item])));
      ordered = [];
    }
  }
  ordered.slice(1).forEach((item, i) => pairs.push([ordered[i], item]));
  if (cycle && draft.closeCycle) pairs.push([ordered[ordered.length - 1], ordered[0]]);
  return pairs;
}

/** Layout routes only: arrow path construction and marker geometry remain in art-engine.
 * Trim against visible frames, including captions. Refuse a crowded route rather than hiding it. */
export function planArrangementConnections(plan: Extract<ArrangementPlan, { ok: true }>, draft: ArrangementDraft,
  obstacles: readonly NativeArtObstacle[] = []): { ok: true; connections: ArrangementConnection[] } | { ok: false; reason: string } {
  if (!validArrangementDraft(draft)) return { ok: false, reason: "Invalid arrangement options." };
  if (!draft.arrows) return { ok: true, connections: [] };
  const pairs=arrangementConnectionPairs(plan.placements,draft);
  const cycle = draft.layout === "circle" || draft.layout === "oval";
  const connections: ArrangementConnection[] = [];
  for (const [from, to] of pairs) {
    const a = center(from), b = center(to);
    let m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (cycle && plan.cycle) {
      const { center: c, radiusX, radiusY } = plan.cycle;
      const angle = Math.atan2((a.y - c.y) / radiusY, (a.x - c.x) / radiusX) + Math.PI / plan.placements.length;
      m = { x: c.x + radiusX * Math.cos(angle), y: c.y + radiusY * Math.sin(angle) };
    }
    const route = trimQuadraticRoute(a, b, m, shapes(from), shapes(to),
      [...plan.placements.filter(p => p !== from && p !== to).flatMap(shapes), ...obstacles],draft.arrowLength??100);
    if (!route) return { ok: false, reason: "There is too little clear space for connecting arrows. Try another layout, a larger page, or move nearby objects." };
    const { start, end, middle } = route;
    const arrangementConnection = { fromObjectId: draft.reverse ? to.id : from.id,
      toObjectId: draft.reverse ? from.id : to.id, bend: { x: m.x-(a.x+b.x)/2, y: m.y-(a.y+b.y)/2 },
      settings:{...draft,arrowLength:draft.arrowLength??100},
      ...(connections.length===0?{itemObjectIds:plan.placements.map(p=>p.id)}:{}) };
    connections.push(draft.reverse ? { start: end, end: start, middle, arrangementConnection } : { start, end, middle, arrangementConnection });
  }
  return { ok: true, connections };
}
